// Handler tests. Everything here drives the real mux through httptest, and
// nothing in this file touches the network: each request either fails before
// checkProxy is reached (wrong method, bad JSON, oversized body, too many
// entries) or carries an empty proxy list, which runs zero checks.
//
// checkProxy's own failure paths live in checkproxy_test.go, which is hermetic
// for the same reason; only its success path still needs the live test in
// proxytest_test.go, since a fake MTProto server is a much larger piece of
// work than the handlers are.
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

// postWithHeaders is post with extra request headers, for the origin guard
// below. Malformed JSON is the body throughout those tests: every endpoint
// answers it 400, so a 400 says the guard let the request through and a 403
// says it did not, without any of them running a check.
func postWithHeaders(t *testing.T, path, body string, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	newMux().ServeHTTP(rec, req)
	return rec
}

// postPaths is every endpoint that acts on a request body. httptest.NewRequest
// sets Host to example.com, so http://example.com is this server's own origin
// for the duration of these tests.
var postPaths = []string{"/check", "/check-batch", "/check-stream", "/fetch-sources"}

// Content-Type: text/plain is CORS-safelisted, so a plain HTML form on any page
// the user visits reaches these endpoints with no preflight and no JavaScript —
// and the bytes an enctype=text/plain form emits are valid JSON, because the =
// separator lands inside a string value. That drives /fetch-sources with an
// attacker's socks5.addr, whose destination is unchecked by design on the
// reasoning that the address comes from the user. Browsers label the request;
// this is the label.
func TestEndpointsRejectCrossOriginPosts(t *testing.T) {
	for _, path := range postPaths {
		for _, site := range []string{"cross-site", "same-site"} {
			rec := postWithHeaders(t, path, "{", map[string]string{"Sec-Fetch-Site": site})

			if rec.Code != http.StatusForbidden {
				t.Errorf("POST %s with Sec-Fetch-Site: %s = %d, want 403", path, site, rec.Code)
			}
			var body map[string]string
			if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
				t.Errorf("POST %s: body is not JSON: %v (%q)", path, err, rec.Body.String())
			} else if body["error"] == "" {
				t.Errorf("POST %s: body = %q, want an error field", path, rec.Body.String())
			}
		}
	}
}

func TestEndpointsRejectAForeignOriginHeader(t *testing.T) {
	for _, path := range postPaths {
		rec := postWithHeaders(t, path, "{", map[string]string{"Origin": "https://evil.test"})

		if rec.Code != http.StatusForbidden {
			t.Errorf("POST %s with a foreign Origin = %d, want 403", path, rec.Code)
		}
	}
}

// The guard is a browser control, not authentication. curl and every script
// against the documented HTTP API send neither header, and must keep working —
// which is also why it can never be described as auth: anything that sets its
// own headers walks straight past it.
func TestEndpointsAllowSameOriginAndHeaderlessPosts(t *testing.T) {
	for _, path := range postPaths {
		for name, headers := range map[string]map[string]string{
			"no headers":                  {},
			"Sec-Fetch-Site: same-origin": {"Sec-Fetch-Site": "same-origin"},
			"Sec-Fetch-Site: none":        {"Sec-Fetch-Site": "none"},
			"its own Origin":              {"Origin": "http://example.com"},
			"its own Origin, over TLS":    {"Origin": "https://example.com"},
			"same-origin with the Origin": {"Sec-Fetch-Site": "same-origin", "Origin": "http://example.com"},
		} {
			rec := postWithHeaders(t, path, "{", headers)

			if rec.Code != http.StatusBadRequest {
				t.Errorf("POST %s with %s = %d, want 400 — the guard rejected its own page",
					path, name, rec.Code)
			}
		}
	}
}

// The guard runs before the body is touched, so a cross-origin request costs
// nothing to refuse. Malformed JSON would be a 400 and an oversized body a 413;
// both answer 403 instead.
func TestOriginGuardRunsBeforeTheBodyIsRead(t *testing.T) {
	oversized := strings.Repeat("a", maxBodySize+1)

	for _, body := range []string{"{", oversized} {
		rec := postWithHeaders(t, "/fetch-sources", body, map[string]string{"Sec-Fetch-Site": "cross-site"})

		if rec.Code != http.StatusForbidden {
			t.Errorf("status = %d, want 403", rec.Code)
		}
	}
}

// /check-stream commits to an event stream as soon as it writes, so its
// rejections have to land before that — the same rule its 405 and 413 follow.
func TestCheckStreamRejectsCrossOriginWithPlainJSON(t *testing.T) {
	rec := postWithHeaders(t, "/check-stream", "[]", map[string]string{"Sec-Fetch-Site": "cross-site"})

	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); !strings.Contains(ct, "application/json") {
		t.Errorf("Content-Type = %q, want JSON", ct)
	}
	if strings.Contains(rec.Body.String(), "event:") {
		t.Errorf("body carries SSE frames: %q", rec.Body.String())
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

// postFromHost is postWithHeaders with control over r.Host. Setting a Host
// header does nothing in Go — net/http reads the request's Host field — so a
// rebinding request has to be built rather than configured.
func postFromHost(t *testing.T, path, host string, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader("{"))
	req.Host = host
	req.Header.Set("Content-Type", "application/json")
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	newMux().ServeHTTP(rec, req)
	return rec
}

// A rebinding attack makes the browser's own headers internally consistent:
// the page really is served from evil.test:3000, so Sec-Fetch-Site is
// same-origin and Origin matches r.Host. Both arms of the guard pass, and the
// response comes back readable — which is what turns /check into an accurate
// port scanner of the victim's loopback. The Host allowlist is the only thing
// that separates that request from the real page's.
func TestEndpointsRejectARebindingHost(t *testing.T) {
	defer withAllowedHosts(t, "127.0.0.1:3000")()

	rebound := map[string]string{
		"Sec-Fetch-Site": "same-origin",
		"Origin":         "http://evil.test:3000",
	}

	for _, path := range postPaths {
		rec := postFromHost(t, path, "evil.test:3000", rebound)

		if rec.Code != http.StatusForbidden {
			t.Errorf("POST %s with Host: evil.test:3000 = %d, want 403", path, rec.Code)
		}
		var body map[string]string
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Errorf("POST %s: body is not JSON: %v (%q)", path, err, rec.Body.String())
		} else if body["error"] == "" {
			t.Errorf("POST %s: body = %q, want an error field", path, rec.Body.String())
		}
	}
}

// The other half: every spelling the real page can arrive as still gets in,
// including the headerless scripting path, which sends no Origin at all.
func TestEndpointsAllowEveryBoundHostSpelling(t *testing.T) {
	defer withAllowedHosts(t, "127.0.0.1:3000")()

	for _, host := range []string{"127.0.0.1:3000", "localhost:3000", "[::1]:3000", "LOCALHOST:3000"} {
		for name, headers := range map[string]map[string]string{
			"no headers":  {},
			"same-origin": {"Sec-Fetch-Site": "same-origin", "Origin": "http://" + host},
		} {
			rec := postFromHost(t, "/fetch-sources", host, headers)

			if rec.Code != http.StatusBadRequest {
				t.Errorf("POST from Host %q with %s = %d, want 400 — the guard rejected its own page",
					host, name, rec.Code)
			}
		}
	}
}

// The port in Host is the port the browser was told to connect to, and that is
// not the bound port whenever anything forwards: `ssh -L 8080:127.0.0.1:3000`
// on a remote box is the obvious deployment for a censorship-circumvention
// tool, and PORT=80 makes the browser omit the port from Host entirely. GETs
// are unguarded, so pinning the port left the page loading normally with every
// control dead and nothing in either log naming the cause.
func TestEndpointsAllowAHostWhosePortIsNotTheBoundOne(t *testing.T) {
	defer withAllowedHosts(t, "127.0.0.1:3000")()

	for _, host := range []string{"127.0.0.1", "localhost", "[::1]", "localhost:8080", "127.0.0.1:80"} {
		rec := postFromHost(t, "/fetch-sources", host, map[string]string{
			"Sec-Fetch-Site": "same-origin",
			"Origin":         "http://" + host,
		})

		if rec.Code != http.StatusBadRequest {
			t.Errorf("POST from Host %q = %d, want 400 — the guard rejected its own page", host, rec.Code)
		}
	}
}

// A non-loopback bind has no name to pin, so the allowlist is empty and the
// Host check is off. Pinned in this direction because the alternative — an
// empty map read as "allow nothing" — would 403 every request on a
// HOST=0.0.0.0 deployment, which is supported.
func TestOriginGuardSkipsTheHostCheckWithoutAnAllowlist(t *testing.T) {
	defer withAllowedHosts(t, "0.0.0.0:3000")()

	rec := postFromHost(t, "/fetch-sources", "anything.test:3000", nil)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400 — the Host check should be off", rec.Code)
	}
}

// withAllowedHosts installs the allowlist main() would have built and returns
// the restore. allowedHosts is nil in every other test, which is what keeps
// the rest of this file's requests (Host: example.com) unaffected.
func withAllowedHosts(t *testing.T, addr string) func() {
	t.Helper()
	prev := allowedHosts
	allowedHosts = hostAllowlist(addr)
	return func() { allowedHosts = prev }
}
