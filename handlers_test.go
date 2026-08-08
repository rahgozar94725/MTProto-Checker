// Handler tests. Everything here drives the real mux through httptest, and
// nothing in this file touches the network: each request either fails before
// checkProxy is reached (wrong method, bad JSON, oversized body, too many
// entries) or carries an empty proxy list, which runs zero checks.
//
// checkProxy itself stays covered only by the live test in proxytest_test.go —
// a fake MTProto server is a much larger piece of work than the handlers are.
package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// post builds a POST against the real mux and returns the recorded response.
func post(t *testing.T, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	newMux().ServeHTTP(rec, req)
	return rec
}

func TestRecoverMiddlewareTurnsPanicInto500(t *testing.T) {
	handler := recoverMiddleware(func(w http.ResponseWriter, r *http.Request) {
		panic("boom")
	})

	rec := httptest.NewRecorder()
	handler(rec, httptest.NewRequest(http.MethodPost, "/check", nil))

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", rec.Code)
	}
	var body map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("body is not JSON: %v (%q)", err, rec.Body.String())
	}
	if body["error"] != "internal error" {
		t.Errorf(`error = %q, want "internal error"`, body["error"])
	}
	// The panicking handler must not leak its message to the caller.
	if strings.Contains(rec.Body.String(), "boom") {
		t.Errorf("panic value leaked into the response: %q", rec.Body.String())
	}
}

func TestEndpointsRejectNonPost(t *testing.T) {
	for _, path := range []string{"/check", "/check-batch", "/check-stream"} {
		rec := httptest.NewRecorder()
		newMux().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))

		if rec.Code != http.StatusMethodNotAllowed {
			t.Errorf("GET %s = %d, want 405", path, rec.Code)
		}
	}
}

func TestCheckRejectsMalformedJSON(t *testing.T) {
	rec := post(t, "/check", "{not json")

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
	var body CheckResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("body is not JSON: %v (%q)", err, rec.Body.String())
	}
	if body.OK {
		t.Error("ok = true, want false")
	}
}

// One test per endpoint rather than a loop: /check decodes a single object and
// the other two decode an array, so the oversized bodies are not the same shape
// and the 413 has to come from MaxBytesReader either way.
func TestEndpointsRejectOversizedBody(t *testing.T) {
	huge := strings.Repeat("A", maxBodySize+1)

	cases := []struct{ path, body string }{
		{"/check", `{"server":"` + huge + `","port":443,"secret":"ee"}`},
		{"/check-batch", `[{"server":"` + huge + `","port":443,"secret":"ee"}]`},
		{"/check-stream", `[{"server":"` + huge + `","port":443,"secret":"ee"}]`},
	}

	for _, c := range cases {
		rec := post(t, c.path, c.body)

		if rec.Code != http.StatusRequestEntityTooLarge {
			t.Errorf("POST %s = %d, want 413", c.path, rec.Code)
			continue
		}
		var body map[string]string
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Errorf("POST %s body is not JSON: %v (%q)", c.path, err, rec.Body.String())
			continue
		}
		if !strings.Contains(body["error"], "exceeds") {
			t.Errorf("POST %s error = %q, want it to mention the limit", c.path, body["error"])
		}
	}
}

func TestBatchEndpointsRejectTooManyEntries(t *testing.T) {
	entry := `{"server":"192.0.2.1","port":443,"secret":"ee"}`
	body := "[" + strings.Repeat(entry+",", maxBatchSize) + entry + "]"

	for _, path := range []string{"/check-batch", "/check-stream"} {
		rec := post(t, path, body)

		if rec.Code != http.StatusRequestEntityTooLarge {
			t.Errorf("POST %s with %d entries = %d, want 413", path, maxBatchSize+1, rec.Code)
		}
	}
}

// The rejection has to happen before the stream is committed: once the SSE
// headers are out, a client sees an empty event stream instead of the error.
func TestCheckStreamRejectsWithPlainJSONNotSSE(t *testing.T) {
	rec := post(t, "/check-stream", "[")

	if got := rec.Header().Get("Content-Type"); strings.Contains(got, "event-stream") {
		t.Errorf("Content-Type = %q, want the JSON error, not a committed stream", got)
	}
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", rec.Code)
	}
}

func TestCheckBatchAnswersDeprecated(t *testing.T) {
	rec := post(t, "/check-batch", "[]")

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if got := rec.Header().Get("Deprecation"); got != "true" {
		t.Errorf("Deprecation = %q, want \"true\"", got)
	}
	link := rec.Header().Get("Link")
	for _, want := range []string{"/check", "/check-stream", "successor-version"} {
		if !strings.Contains(link, want) {
			t.Errorf("Link = %q, want it to mention %q", link, want)
		}
	}
}

// An empty list runs no checks, so this exercises the whole stream path --
// headers, event framing, terminator -- without a single dial.
func TestCheckStreamEmptyListStillFinishes(t *testing.T) {
	rec := post(t, "/check-stream", "[]")

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if got := rec.Header().Get("Content-Type"); !strings.Contains(got, "text/event-stream") {
		t.Errorf("Content-Type = %q, want text/event-stream", got)
	}
	body := rec.Body.String()
	if !strings.Contains(body, "event: done") {
		t.Fatalf("no done event in %q", body)
	}
	if !strings.HasSuffix(body, "\n\n") {
		t.Errorf("last frame is not terminated: %q", body)
	}
}

// The binary serves public/ from the embed, not from disk. A broken //go:embed
// or fs.Sub would still compile and would only show up here.
func TestRootServesTheEmbeddedPage(t *testing.T) {
	rec := httptest.NewRecorder()
	newMux().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	body := rec.Body.String()
	for _, want := range []string{"MTProto Checker", `src="/js/app.js"`} {
		if !strings.Contains(body, want) {
			t.Errorf("index.html does not contain %q", want)
		}
	}
}

func TestEmbeddedModulesAreServed(t *testing.T) {
	rec := httptest.NewRecorder()
	newMux().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/js/parse.js", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "export function parseLink") {
		t.Error("the served module is not parse.js")
	}
}
