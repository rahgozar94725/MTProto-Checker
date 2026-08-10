// /fetch-sources handler tests. Hermetic like handlers_test.go and
// checkproxy_test.go: every upstream in this file is an httptest server bound
// to 127.0.0.1:0 that the test owns, so nothing dials off-box and the file
// carries no -short guard.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// allowLoopbackDestinations exempts loopback from the destination check for one
// test, and nothing else — the scheme allowlist still applies, so a plain-HTTP
// source is still rejected on the direct path. That is what lets the SOCKS5
// tests below prove the fallback was taken rather than the direct attempt.
func allowLoopbackDestinations(t *testing.T) {
	t.Helper()
	orig := allowedSourceIP
	allowedSourceIP = func(ip net.IP) bool { return ip.IsLoopback() }
	t.Cleanup(func() { allowedSourceIP = orig })
}

// allowLoopbackSources relaxes the SSRF policy for one test: plain HTTP, and
// loopback destinations only. That is exactly what an httptest server on
// 127.0.0.1 is, and nothing more — a test that calls this still proves
// 10.0.0.1 is rejected, which is what makes the redirect test meaningful.
func allowLoopbackSources(t *testing.T) {
	t.Helper()
	allowLoopbackDestinations(t)
	orig := allowPlainHTTPSources
	allowPlainHTTPSources = true
	t.Cleanup(func() { allowPlainHTTPSources = orig })
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

// https only on the direct path. Plain HTTP is allowed only through SOCKS5,
// which is a separate client — see the SOCKS5 tests below.
func TestFetchSourceRejectsPlainHTTP(t *testing.T) {
	allowLoopbackDestinations(t)

	_, err := fetchSource(context.Background(), nil, "http://127.0.0.1:9/list.txt")

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
		if _, err := fetchSource(context.Background(), nil, raw); err == nil {
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
		_, err := fetchSource(context.Background(), nil, raw)
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
	_, err := fetchSource(context.Background(), nil, "https://127.0.0.1:9/list.txt")

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

	text, err := fetchSource(context.Background(), nil, redirect.URL+"/list.txt")

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

// socks5Server is a minimal RFC 1928 CONNECT proxy on 127.0.0.1: enough to
// prove which path a fetch took and where it asked to go, and nothing more. It
// counts accepted connections and records every requested destination, so a
// test can assert the proxy was reached — or that it never was.
type socks5Server struct {
	addr string

	mu    sync.Mutex
	conns int
	dests []string
}

func (s *socks5Server) connections() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.conns
}

func (s *socks5Server) destinations() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.dests...)
}

// startSOCKS5 runs the proxy until the test ends. An empty user means the
// no-authentication method; otherwise the username/password method of RFC 1929
// is demanded and the credentials are checked.
func startSOCKS5(t *testing.T, user, pass string) *socks5Server {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	t.Cleanup(func() { ln.Close() })

	s := &socks5Server{addr: ln.Addr().String()}
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go s.serve(conn, user, pass)
		}
	}()
	return s
}

func (s *socks5Server) serve(conn net.Conn, user, pass string) {
	defer conn.Close()
	s.mu.Lock()
	s.conns++
	s.mu.Unlock()

	buf := make([]byte, 260)
	read := func(n int) bool {
		_, err := io.ReadFull(conn, buf[:n])
		return err == nil
	}

	// Greeting: version, method count, then that many method bytes.
	if !read(2) {
		return
	}
	if !read(int(buf[1])) {
		return
	}
	if user == "" {
		if _, err := conn.Write([]byte{0x05, 0x00}); err != nil {
			return
		}
	} else {
		if _, err := conn.Write([]byte{0x05, 0x02}); err != nil {
			return
		}
		if !read(2) {
			return
		}
		ulen := int(buf[1])
		if !read(ulen) {
			return
		}
		gotUser := string(buf[:ulen])
		if !read(1) {
			return
		}
		plen := int(buf[0])
		if !read(plen) {
			return
		}
		if gotUser != user || string(buf[:plen]) != pass {
			conn.Write([]byte{0x01, 0x01})
			return
		}
		if _, err := conn.Write([]byte{0x01, 0x00}); err != nil {
			return
		}
	}

	// Request: version, command, reserved, address type.
	if !read(4) {
		return
	}
	var host string
	switch buf[3] {
	case 0x01:
		if !read(4) {
			return
		}
		host = net.IP(buf[:4]).String()
	case 0x03:
		if !read(1) {
			return
		}
		n := int(buf[0])
		if !read(n) {
			return
		}
		host = string(buf[:n])
	case 0x04:
		if !read(16) {
			return
		}
		host = net.IP(buf[:16]).String()
	default:
		return
	}
	if !read(2) {
		return
	}
	dest := net.JoinHostPort(host, strconv.Itoa(int(buf[0])<<8|int(buf[1])))
	s.mu.Lock()
	s.dests = append(s.dests, dest)
	s.mu.Unlock()

	upstream, err := net.DialTimeout("tcp", dest, 5*time.Second)
	if err != nil {
		conn.Write([]byte{0x05, 0x01, 0x00, 0x01, 0, 0, 0, 0, 0, 0})
		return
	}
	defer upstream.Close()
	if _, err := conn.Write([]byte{0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0}); err != nil {
		return
	}
	go io.Copy(upstream, conn)
	io.Copy(conn, upstream)
}

// fetchSourcesVia posts a {"urls": …, "socks5": …} body. A nil socks5 is
// omitted entirely, which is the direct-only request shape.
func fetchSourcesVia(t *testing.T, socks5 map[string]string, urls ...string) *httptest.ResponseRecorder {
	t.Helper()
	req := map[string]any{"urls": urls}
	if socks5 != nil {
		req["socks5"] = socks5
	}
	body, err := json.Marshal(req)
	if err != nil {
		t.Fatalf("marshal request: %v", err)
	}
	return post(t, "/fetch-sources", string(body))
}

// The direct attempt fails on the scheme — plain HTTP is not allowed off a
// direct client — and the retry through SOCKS5 carries it. The proxy's own
// connection count is what proves the fallback ran, not the body alone.
func TestFetchSourcesFallsBackToSOCKS5(t *testing.T) {
	allowLoopbackDestinations(t)
	socks := startSOCKS5(t, "", "")
	upstream := textSource(t, "tg://proxy?server=192.0.2.5\n")

	rec := fetchSourcesVia(t, map[string]string{"addr": socks.addr}, upstream)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if got, want := rec.Body.String(), "tg://proxy?server=192.0.2.5\n"; got != want {
		t.Errorf("body = %q, want %q", got, want)
	}
	if n := socks.connections(); n != 1 {
		t.Fatalf("proxy saw %d connections, want 1 — the fallback did not run", n)
	}
	wantDest := strings.TrimPrefix(upstream, "http://")
	if dests := socks.destinations(); len(dests) != 1 || dests[0] != wantDest {
		t.Errorf("proxy destinations = %v, want [%s]", dests, wantDest)
	}
}

// Credentials are passed through when given, and a wrong password fails the
// handshake rather than being ignored.
func TestFetchSourcesUsesSOCKS5Credentials(t *testing.T) {
	allowLoopbackDestinations(t)
	socks := startSOCKS5(t, "user", "hunter2")
	upstream := textSource(t, "tg://proxy?server=192.0.2.6\n")

	rec := fetchSourcesVia(t, map[string]string{"addr": socks.addr, "user": "user", "pass": "hunter2"}, upstream)
	if got, want := rec.Body.String(), "tg://proxy?server=192.0.2.6\n"; got != want {
		t.Errorf("body = %q, want %q — the credentials were not accepted", got, want)
	}

	rec = fetchSourcesVia(t, map[string]string{"addr": socks.addr, "user": "user", "pass": "wrong"}, upstream)
	if body := rec.Body.String(); body != "" {
		t.Errorf("body = %q with a wrong password, want empty", body)
	}
}

// SOCKS5 is a fallback, not a route: a source the direct client can fetch never
// touches the proxy.
func TestFetchSourcesPrefersDirect(t *testing.T) {
	allowLoopbackSources(t)
	socks := startSOCKS5(t, "", "")
	upstream := textSource(t, "tg://proxy?server=192.0.2.7\n")

	rec := fetchSourcesVia(t, map[string]string{"addr": socks.addr}, upstream)

	if got, want := rec.Body.String(), "tg://proxy?server=192.0.2.7\n"; got != want {
		t.Errorf("body = %q, want %q", got, want)
	}
	if n := socks.connections(); n != 0 {
		t.Errorf("proxy saw %d connections, want 0 — the direct attempt succeeded", n)
	}
}

// No socks5 field, and an empty address, both mean direct-only: the plain-HTTP
// source stays rejected because there is no proxy to route it through.
func TestFetchSourcesWithoutSOCKS5StaysDirect(t *testing.T) {
	allowLoopbackDestinations(t)
	upstream := textSource(t, "tg://proxy?server=192.0.2.8\n")

	for _, socks5 := range []map[string]string{nil, {"addr": ""}} {
		rec := fetchSourcesVia(t, socks5, upstream)
		if rec.Code != http.StatusOK {
			t.Fatalf("socks5=%v: status = %d, want 200", socks5, rec.Code)
		}
		if body := rec.Body.String(); body != "" {
			t.Errorf("socks5=%v: body = %q, want empty — plain HTTP has no route", socks5, body)
		}
	}
}

// The destination policy is not something a proxy can be used to step around:
// it is applied before the proxy is dialled, to the literal address and to a
// name this machine can resolve alike.
func TestFetchSourcesBlocksAPrivateDestinationThroughSOCKS5(t *testing.T) {
	socks := startSOCKS5(t, "", "")

	for _, raw := range []string{
		"http://10.0.0.1/list.txt",
		"http://169.254.169.254/latest/meta-data/",
		"http://localhost:9/list.txt",
	} {
		rec := fetchSourcesVia(t, map[string]string{"addr": socks.addr}, raw)
		if body := rec.Body.String(); body != "" {
			t.Errorf("%s: body = %q, want empty", raw, body)
		}
	}
	if n := socks.connections(); n != 0 {
		t.Errorf("proxy saw %d connections, want 0 — the destination check ran too late", n)
	}
}

// A redirect on the SOCKS5 path is a fresh destination and gets the same check.
// The first hop is reached through the proxy; the second must not be.
func TestFetchSourcesChecksARedirectOnTheSOCKS5Path(t *testing.T) {
	allowLoopbackDestinations(t)
	socks := startSOCKS5(t, "", "")

	redirect := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "http://10.0.0.1/list.txt", http.StatusFound)
	}))
	t.Cleanup(redirect.Close)

	rec := fetchSourcesVia(t, map[string]string{"addr": socks.addr}, redirect.URL+"/list.txt")

	if body := rec.Body.String(); body != "" {
		t.Errorf("body = %q, want empty — the redirect must not be followed", body)
	}
	wantDest := strings.TrimPrefix(redirect.URL, "http://")
	if dests := socks.destinations(); len(dests) != 1 || dests[0] != wantDest {
		t.Errorf("proxy destinations = %v, want only the first hop [%s]", dests, wantDest)
	}
}
