// /fetch-sources handler tests. Hermetic like handlers_test.go and
// checkproxy_test.go: every upstream in this file is an httptest server bound
// to 127.0.0.1:0 that the test owns, so nothing dials off-box and the file
// carries no -short guard.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// allowLoopbackSources relaxes the SSRF policy for one test: plain HTTP, and
// loopback destinations only. That is exactly what an httptest server on
// 127.0.0.1 is, and nothing more — a test that calls this still proves
// 10.0.0.1 is rejected, which is what makes the redirect test meaningful.
func allowLoopbackSources(t *testing.T) {
	t.Helper()
	origScheme, origIP := allowPlainHTTPSources, allowedSourceIP
	allowPlainHTTPSources = true
	allowedSourceIP = func(ip net.IP) bool { return ip.IsLoopback() }
	t.Cleanup(func() {
		allowPlainHTTPSources, allowedSourceIP = origScheme, origIP
	})
}

// fetchSources posts a {"urls": …} body built from urls and returns the
// recorded response.
func fetchSources(t *testing.T, urls ...string) *httptest.ResponseRecorder {
	t.Helper()
	body, err := json.Marshal(map[string][]string{"urls": urls})
	if err != nil {
		t.Fatalf("marshal request: %v", err)
	}
	return post(t, "/fetch-sources", string(body))
}

// textSource serves body once, over 127.0.0.1.
func textSource(t *testing.T, body string) string {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, body)
	}))
	t.Cleanup(srv.Close)
	return srv.URL
}

func TestFetchSourcesRejectsNonPost(t *testing.T) {
	rec := httptest.NewRecorder()
	newMux().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/fetch-sources", nil))

	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("GET /fetch-sources = %d, want 405", rec.Code)
	}
}

func TestFetchSourcesRejectsMalformedJSON(t *testing.T) {
	rec := post(t, "/fetch-sources", "{not json")

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
	var body map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("body is not JSON: %v (%q)", err, rec.Body.String())
	}
	if body["error"] == "" {
		t.Errorf("body = %q, want an {\"error\": …} shape", rec.Body.String())
	}
}

func TestFetchSourcesRejectsOversizedBody(t *testing.T) {
	huge := strings.Repeat("A", maxBodySize+1)
	rec := post(t, "/fetch-sources", `{"urls":["`+huge+`"]}`)

	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want 413", rec.Code)
	}
	var body map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("body is not JSON: %v (%q)", err, rec.Body.String())
	}
	if !strings.Contains(body["error"], "exceeds") {
		t.Errorf("error = %q, want it to mention the limit", body["error"])
	}
}

func TestFetchSourcesRejectsTooManySources(t *testing.T) {
	urls := make([]string, maxSources+1)
	for i := range urls {
		urls[i] = fmt.Sprintf("https://example.com/%d.txt", i)
	}
	rec := fetchSources(t, urls...)

	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d with %d sources, want 413", rec.Code, len(urls))
	}
	var body map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("body is not JSON: %v (%q)", err, rec.Body.String())
	}
	if !strings.Contains(body["error"], fmt.Sprintf("%d", maxSources)) {
		t.Errorf("error = %q, want it to mention the %d-source cap", body["error"], maxSources)
	}
}

// The sources are fetched concurrently but concatenated in request order, so a
// slow first source cannot reorder the output.
func TestFetchSourcesConcatenatesInRequestOrder(t *testing.T) {
	allowLoopbackSources(t)

	slow := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(50 * time.Millisecond)
		fmt.Fprint(w, "tg://proxy?server=192.0.2.1")
	}))
	t.Cleanup(slow.Close)
	fast := textSource(t, "tg://proxy?server=192.0.2.2\n")

	rec := fetchSources(t, slow.URL, fast)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (%q)", rec.Code, rec.Body.String())
	}
	want := "tg://proxy?server=192.0.2.1\ntg://proxy?server=192.0.2.2\n"
	if got := rec.Body.String(); got != want {
		t.Errorf("body = %q, want %q", got, want)
	}
}

// One failure does not abort the rest — the working sources still come back.
func TestFetchSourcesSkipsAFailingSource(t *testing.T) {
	allowLoopbackSources(t)

	notFound := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "nope", http.StatusNotFound)
	}))
	t.Cleanup(notFound.Close)
	ok := textSource(t, "tg://proxy?server=192.0.2.3\n")

	rec := fetchSources(t, notFound.URL, ok)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if got, want := rec.Body.String(), "tg://proxy?server=192.0.2.3\n"; got != want {
		t.Errorf("body = %q, want %q — the 404 must contribute nothing and abort nothing", got, want)
	}
}

// The cap is enforced while reading, not after: a source that keeps sending is
// cut off, and the server on the other end never gets to write the whole body.
func TestFetchSourcesRejectsAnOversizedSourceWithoutBufferingIt(t *testing.T) {
	allowLoopbackSources(t)

	const chunk = 256 * 1024
	const total = 4 * maxSourceBytes

	var mu sync.Mutex
	written := 0
	done := make(chan struct{})

	huge := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer close(done)
		payload := strings.Repeat("A", chunk)
		flusher, _ := w.(http.Flusher)
		for sent := 0; sent < total; sent += chunk {
			n, err := fmt.Fprint(w, payload)
			mu.Lock()
			written += n
			mu.Unlock()
			if err != nil {
				return
			}
			if flusher != nil {
				flusher.Flush()
			}
		}
	}))
	t.Cleanup(huge.Close)
	ok := textSource(t, "tg://proxy?server=192.0.2.4\n")

	rec := fetchSources(t, huge.URL, ok)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if got, want := rec.Body.String(), "tg://proxy?server=192.0.2.4\n"; got != want {
		t.Errorf("body = %q, want %q — the oversized source must contribute nothing", got, want)
	}

	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("upstream handler never returned — the read was not cut off")
	}
	mu.Lock()
	sent := written
	mu.Unlock()
	if sent >= total {
		t.Errorf("upstream wrote %d of %d bytes — the whole body was buffered", sent, total)
	}
}

// https only. http stays rejected until Task 13 routes it through SOCKS5.
func TestFetchSourceRejectsPlainHTTP(t *testing.T) {
	orig := allowedSourceIP
	allowedSourceIP = func(ip net.IP) bool { return ip.IsLoopback() }
	t.Cleanup(func() { allowedSourceIP = orig })

	_, err := fetchSource(context.Background(), "http://127.0.0.1:9/list.txt")

	if err == nil {
		t.Fatal("fetchSource accepted an http:// source, want it rejected")
	}
	if !strings.Contains(err.Error(), "scheme") {
		t.Errorf("error = %v, want it to name the scheme", err)
	}
}

func TestFetchSourceRejectsANonHTTPScheme(t *testing.T) {
	allowLoopbackSources(t)

	for _, raw := range []string{
		"file:///etc/passwd",
		"ftp://example.com/list.txt",
		"gopher://example.com/",
		"tg://proxy?server=192.0.2.1",
	} {
		if _, err := fetchSource(context.Background(), raw); err == nil {
			t.Errorf("fetchSource(%q) = nil error, want it rejected", raw)
		}
	}
}

// Resolve-then-check, enforced at dial time: the address is judged after
// resolution, so a hostname pointing into RFC 1918 is caught the same way a
// literal is, and there is no window between the check and the connect.
func TestFetchSourceRejectsAPrivateDestination(t *testing.T) {
	allowLoopbackSources(t)

	for _, raw := range []string{
		"https://10.0.0.1/list.txt",
		"https://192.168.1.1/list.txt",
		"https://172.16.0.1/list.txt",
		"https://169.254.169.254/latest/meta-data/",
	} {
		_, err := fetchSource(context.Background(), raw)
		if err == nil {
			t.Errorf("fetchSource(%q) = nil error, want it rejected", raw)
			continue
		}
		if !strings.Contains(err.Error(), "blocked") {
			t.Errorf("fetchSource(%q) error = %v, want it to say the destination is blocked", raw, err)
		}
	}
}

// Loopback is blocked by the same check — the hermetic tests reach 127.0.0.1
// only because they exempt it explicitly.
func TestFetchSourceRejectsALoopbackDestination(t *testing.T) {
	_, err := fetchSource(context.Background(), "https://127.0.0.1:9/list.txt")

	if err == nil {
		t.Fatal("fetchSource accepted a loopback source, want it rejected")
	}
	if !strings.Contains(err.Error(), "blocked") {
		t.Errorf("error = %v, want it to say the destination is blocked", err)
	}
}

// A redirect is a fresh destination and gets the same checks. The first hop is
// an exempted loopback server; the target is not exempted, so following it
// would be the bug.
func TestFetchSourceDoesNotFollowARedirectToAPrivateDestination(t *testing.T) {
	allowLoopbackSources(t)

	redirect := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "http://10.0.0.1/list.txt", http.StatusFound)
	}))
	t.Cleanup(redirect.Close)

	text, err := fetchSource(context.Background(), redirect.URL+"/list.txt")

	if err == nil {
		t.Fatalf("followed the redirect and returned %q, want an error", text)
	}
	if !strings.Contains(err.Error(), "blocked") {
		t.Errorf("error = %v, want it to say the destination is blocked", err)
	}
}

// Each source gets its own deadline, so one hanging upstream cannot hold the
// request open.
func TestFetchSourcesBoundsEachSourceWithATimeout(t *testing.T) {
	allowLoopbackSources(t)
	original := sourceTimeout
	sourceTimeout = 100 * time.Millisecond
	t.Cleanup(func() { sourceTimeout = original })

	hang := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-r.Context().Done():
		case <-time.After(30 * time.Second):
		}
	}))
	t.Cleanup(hang.Close)

	start := time.Now()
	rec := fetchSources(t, hang.URL)
	elapsed := time.Since(start)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if rec.Body.Len() != 0 {
		t.Errorf("body = %q, want empty — the hanging source contributes nothing", rec.Body.String())
	}
	if elapsed > 5*time.Second {
		t.Errorf("took %v — the per-source timeout did not bound the fetch", elapsed)
	}
}
