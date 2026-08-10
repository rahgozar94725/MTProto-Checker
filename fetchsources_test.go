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

// testBudget is the byte budget a direct fetchSource call runs under. Full
// size, so no test is bounded by it accidentally — the budget itself is tested
// by giving it a deliberately small one.
func testBudget() *byteBudget {
	return newByteBudget(maxRequestSourceBytes)
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
	case <-time.After(10 * raceTimeoutFactor * time.Second):
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

	_, err := fetchSource(context.Background(), nil, "http://127.0.0.1:9/list.txt", testBudget())

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
		if _, err := fetchSource(context.Background(), nil, raw, testBudget()); err == nil {
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
		_, err := fetchSource(context.Background(), nil, raw, testBudget())
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
	_, err := fetchSource(context.Background(), nil, "https://127.0.0.1:9/list.txt", testBudget())

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

	text, err := fetchSource(context.Background(), nil, redirect.URL+"/list.txt", testBudget())

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
	if elapsed > 5*raceTimeoutFactor*time.Second {
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

// The SOCKS5 leg has no dial hook to hang its destination check on, so it
// resolves the name itself — and it must do so freshly. dnsCache is written by
// tcpCheck from a fully caller-supplied hostname, so a caller who can reach
// /check can seed an allowed answer for a name they control and spend the next
// five minutes pointing it wherever they like: this check would read the stale
// allowed address while the proxy resolves the name again at connect time.
func TestCheckSOCKS5DestinationDoesNotTrustTheDNSCache(t *testing.T) {
	const host = "localhost"

	dnsCacheMu.Lock()
	orig, had := dnsCache[host]
	dnsCache[host] = &dnsCacheEntry{
		ips:  []net.IP{net.IPv4(93, 184, 216, 34)},
		next: time.Now().Add(5 * time.Minute),
	}
	dnsCacheMu.Unlock()
	t.Cleanup(func() {
		dnsCacheMu.Lock()
		if had {
			dnsCache[host] = orig
		} else {
			delete(dnsCache, host)
		}
		dnsCacheMu.Unlock()
	})

	if err := checkSOCKS5Destination(host + ":1080"); err == nil {
		t.Fatal("checkSOCKS5Destination = nil, want an error — it read the primed cache entry " +
			"instead of resolving localhost itself")
	}
}

// The other direction, and it is load-bearing rather than lenient: a name only
// the proxy can resolve is the case the whole SOCKS5 path exists for, so a
// resolution failure here must let the fetch through. Hermetic — the empty host
// fails inside net before any query leaves the machine. Mutation-checked by
// returning the lookup error instead of nil, which fails this test.
func TestCheckSOCKS5DestinationAllowsANameItCannotResolve(t *testing.T) {
	if err := checkSOCKS5Destination(":1080"); err != nil {
		t.Fatalf("checkSOCKS5Destination = %v, want nil — an unresolvable name is left to the proxy", err)
	}
}

// The destination policy is a denylist, and the predicates it is built on cover
// less than they look like they do: net.IP.IsPrivate knows 10/8, 172.16/12,
// 192.168/16 and fc00::/7 and nothing else. This is the table that pins the
// rest — every row is a range something real lives in, and the want=false rows
// are what stops the list from being widened into blocking public addresses.
func TestBlockedSourceIPCoversTheReservedRanges(t *testing.T) {
	for _, tc := range []struct {
		ip   string
		want bool
		why  string
	}{
		// Covered by the predicates.
		{"127.0.0.1", true, "loopback"},
		{"::1", true, "loopback v6"},
		{"10.0.0.1", true, "private"},
		{"172.16.0.1", true, "private"},
		{"192.168.1.1", true, "private"},
		{"169.254.169.254", true, "link-local, the cloud metadata address"},
		{"::ffff:169.254.169.254", true, "v4-mapped link-local"},
		{"0.0.0.0", true, "unspecified"},
		{"::", true, "unspecified v6"},
		{"fd00::1", true, "unique local"},
		{"fe80::1", true, "link-local v6"},
		{"224.0.0.1", true, "multicast"},
		{"ff02::1", true, "multicast v6"},

		// Covered only by blockedSourceNets.
		{"100.64.0.1", true, "shared address space (CGNAT)"},
		{"100.100.100.100", true, "Tailscale MagicDNS"},
		{"100.101.102.103", true, "a tailnet peer"},
		{"::127.0.0.1", true, "v4-compatible v6 loopback — To4 is nil, so IsLoopback is false"},
		{"64:ff9b::7f00:1", true, "NAT64 of 127.0.0.1"},
		{"64:ff9b::a9fe:a9fe", true, "NAT64 of 169.254.169.254"},
		{"64:ff9b:1::1", true, "local-use NAT64"},
		{"100::1", true, "discard-only"},
		{"2001::1", true, "Teredo"},
		{"2002:7f00:1::", true, "6to4 wrapping 127.0.0.1"},
		{"fec0::1", true, "deprecated site-local"},
		{"198.18.0.1", true, "benchmarking"},
		{"192.0.0.1", true, "IETF protocol assignments"},
		{"240.0.0.1", true, "reserved"},
		{"255.255.255.255", true, "broadcast"},

		// Public. A row that flips to true here is a source the tool can no
		// longer fetch, which is the cost of widening the list carelessly.
		{"1.1.1.1", false, "public"},
		{"8.8.8.8", false, "public"},
		{"185.199.108.133", false, "raw.githubusercontent.com"},
		{"::ffff:8.8.8.8", false, "v4-mapped public — unmapped before the match"},
		{"2606:4700::1111", false, "public v6"},
		{"99.255.255.255", false, "just below the shared range"},
		{"100.128.0.1", false, "just above the shared range"},
	} {
		ip := net.ParseIP(tc.ip)
		if ip == nil {
			t.Fatalf("test bug: %q is not an IP", tc.ip)
		}
		if got := blockedSourceIP(ip); got != tc.want {
			t.Errorf("blockedSourceIP(%s) = %v, want %v — %s", tc.ip, got, tc.want, tc.why)
		}
	}
}

// The SOCKS5 leg accepts plain HTTP, which is what makes a scheme-changing
// redirect a downgrade: an https source answers 302 Location: http://…, and the
// body then crosses everything past the proxy — for Tor, the exit node — in the
// clear, in a position to rewrite the proxy list. Checked on the client's own
// CheckRedirect because reaching it end to end would need a real TLS upstream.
func TestSOCKS5RedirectMayNotChangeScheme(t *testing.T) {
	client, err := socks5Client(&SOCKS5Config{Addr: "127.0.0.1:9"})
	if err != nil {
		t.Fatalf("socks5Client: %v", err)
	}

	hop := func(from, to string) error {
		via := httptest.NewRequest(http.MethodGet, from, nil)
		return client.CheckRedirect(httptest.NewRequest(http.MethodGet, to, nil), []*http.Request{via})
	}

	if err := hop("https://example.com/list.txt", "http://example.com/list.txt"); err == nil {
		t.Error("https -> http redirect accepted, want it rejected as a downgrade")
	} else if !strings.Contains(err.Error(), "scheme") {
		t.Errorf("error = %v, want it to name the scheme", err)
	}
	if err := hop("http://example.com/a.txt", "http://example.com/b.txt"); err != nil {
		t.Errorf("http -> http redirect = %v, want it allowed — plain HTTP is why this leg exists", err)
	}
	if err := hop("https://example.com/a.txt", "https://example.com/b.txt"); err != nil {
		t.Errorf("https -> https redirect = %v, want it allowed", err)
	}
}

// A scheme the SOCKS5 leg rejects too is rejected on both attempts, and neither
// one dials: checkSourceURL is the first thing fetchVia does, before the proxy
// is reached. This is what makes predicting which failures are worth retrying
// unnecessary rather than merely unimplemented.
func TestFetchSourcesNeverDialsTheProxyForARejectedScheme(t *testing.T) {
	socks := startSOCKS5(t, "", "")

	for _, raw := range []string{"ftp://example.com/list.txt", "file:///etc/passwd"} {
		rec := fetchSourcesVia(t, map[string]string{"addr": socks.addr}, raw)
		if body := rec.Body.String(); body != "" {
			t.Errorf("%s: body = %q, want empty", raw, body)
		}
	}
	if n := socks.connections(); n != 0 {
		t.Errorf("proxy saw %d connections, want 0 — a rejected scheme must not reach the proxy", n)
	}
}

// Every source of a request is buffered until the last one lands, so the
// per-source cap bounds nothing on its own: maxSources sources at maxSourceBytes
// each would be twenty times the ceiling. The budget is what the sources share.
func TestFetchSourcesBoundsTheWholeRequestByASharedBudget(t *testing.T) {
	allowLoopbackSources(t)

	sources := func(t *testing.T, n int) []string {
		urls := make([]string, n)
		for i := range urls {
			urls[i] = bigSource(t, maxSourceBytes)
		}
		return urls
	}

	// A request that fits arrives whole: the budget must not cost a legitimate
	// caller anything. The real corpus is ~233 KB across 17 sources, so this is
	// already an order of magnitude past anything that happens in practice.
	t.Run("within budget", func(t *testing.T) {
		const n = 3
		rec := fetchSources(t, sources(t, n)...)

		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200", rec.Code)
		}
		if got, want := rec.Body.Len(), n*maxSourceBytes+n; got != want {
			t.Errorf("body = %d bytes, want %d — a request inside the budget must arrive whole", got, want)
		}
	})

	// Past it, the ceiling holds. Which sources survive is deliberately not
	// asserted: the budget is spent as bodies arrive, so under full contention
	// every source can be cut mid-body and the answer is empty. That is the
	// correct outcome for a request that is already past its ceiling — the
	// guarantee is the bound, not a fair share.
	t.Run("past budget", func(t *testing.T) {
		const n = 5
		rec := fetchSources(t, sources(t, n)...)

		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200", rec.Code)
		}
		if got := rec.Body.Len(); got > maxRequestSourceBytes+n {
			t.Errorf("body = %d bytes, want at most the %d byte budget (plus one newline per source)",
				got, maxRequestSourceBytes)
		}
	})
}

// bigSource serves exactly n bytes over 127.0.0.1.
func bigSource(t *testing.T, n int) string {
	t.Helper()
	body := strings.Repeat("A", n)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, body)
	}))
	t.Cleanup(srv.Close)
	return srv.URL
}

// The budget bounds one request; this bounds how many requests hold one. Without
// it the ceiling is maxRequestSourceBytes times however many callers arrive at
// once, and /fetch-sources is reachable without auth under HOST=0.0.0.0.
func TestFetchSourcesCapsRequestsInFlight(t *testing.T) {
	allowLoopbackSources(t)
	original := sourceTimeout
	sourceTimeout = 250 * time.Millisecond
	t.Cleanup(func() { sourceTimeout = original })

	var mu sync.Mutex
	inFlight, peak := 0, 0

	hang := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		inFlight++
		if inFlight > peak {
			peak = inFlight
		}
		mu.Unlock()
		<-r.Context().Done()
		mu.Lock()
		inFlight--
		mu.Unlock()
	}))
	t.Cleanup(hang.Close)

	body, err := json.Marshal(map[string][]string{"urls": {hang.URL}})
	if err != nil {
		t.Fatalf("marshal request: %v", err)
	}
	mux := newMux()

	var wg sync.WaitGroup
	for i := 0; i < maxFetchSourcesInFlight*2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			req := httptest.NewRequest(http.MethodPost, "/fetch-sources", strings.NewReader(string(body)))
			mux.ServeHTTP(httptest.NewRecorder(), req)
		}()
	}
	wg.Wait()

	mu.Lock()
	got := peak
	mu.Unlock()
	if got > maxFetchSourcesInFlight {
		t.Errorf("peak concurrent upstream fetches = %d, want at most %d", got, maxFetchSourcesInFlight)
	}
	if got == 0 {
		t.Error("no upstream fetch was ever entered — the test proved nothing")
	}
}
