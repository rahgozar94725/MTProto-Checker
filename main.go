package main

import (
	"context"
	"embed"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"runtime"
	"runtime/debug"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/go-faster/errors"
	"github.com/gotd/td/session"
	"github.com/gotd/td/telegram"
	"github.com/gotd/td/telegram/dcs"
)

//go:embed public
var publicFS embed.FS

var version = "dev"

const (
	defaultHost = "127.0.0.1"
	defaultPort = 3000
	testAppID   = 6
	testAppHash = "eb06d4abfb49dc3eeb1aeb98ae0f581e"
	// maxBatchSize entries at ~500 B of worst-case JSON each is ~5 MiB;
	// maxBodySize leaves headroom above that. Exceeding either → 413.
	maxBodySize  = 8 * 1024 * 1024
	maxBatchSize = 10_000
	// A public proxy list is tens of KiB; the whole 17-source corpus is
	// ~233 KB. 5 MiB per source is far above anything plausible and is
	// enforced while reading, so an endless response is cut off, not buffered.
	maxSourceBytes     = 5 * 1024 * 1024
	maxSources         = 20
	maxConcurrency     = 50
	defaultTimeout     = 5
	minTimeout         = 3
	maxTimeout         = 30
	tcpTimeout         = 1500 * time.Millisecond
	minTimeoutDuration = time.Duration(minTimeout) * time.Second
	shutdownTimeout    = 5 * time.Second
)

type dnsCacheEntry struct {
	ips  []net.IP
	next time.Time
}

var (
	dnsCacheMu sync.RWMutex
	dnsCache   = make(map[string]*dnsCacheEntry)
)

func cachedLookupHost(host string) ([]net.IP, error) {
	dnsCacheMu.RLock()
	entry, ok := dnsCache[host]
	dnsCacheMu.RUnlock()
	if ok && time.Now().Before(entry.next) {
		return entry.ips, nil
	}

	dnsCtx, dnsCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer dnsCancel()
	var resolver net.Resolver
	ipAddrs, err := resolver.LookupIPAddr(dnsCtx, host)
	if err != nil {
		return nil, err
	}
	ips := make([]net.IP, len(ipAddrs))
	for i, a := range ipAddrs {
		ips[i] = a.IP
	}

	dnsCacheMu.Lock()
	dnsCache[host] = &dnsCacheEntry{ips: ips, next: time.Now().Add(5 * time.Minute)}
	dnsCacheMu.Unlock()
	return ips, nil
}

// sourceTimeout bounds one upstream source fetch. It is a var rather than a
// const only so fetchsources_test.go can shorten it; nothing in production
// writes it.
var sourceTimeout = 30 * time.Second

// The SSRF policy for /fetch-sources. The server fetches arbitrary URLs on
// request and HOST=0.0.0.0 is a supported deployment with no auth and no
// origin check, so an unchecked source URL is a request-forgery primitive
// pointed at whatever the server can reach and the client cannot.
//
// allowPlainHTTPSources and allowedSourceIP are the two test seams and nothing
// else — false and nil in production, written only by fetchsources_test.go,
// because every hermetic upstream is plain HTTP on 127.0.0.1, which is exactly
// what the policy exists to reject. allowedSourceIP exempts individual
// addresses rather than switching the destination check off, so a test that
// exempts loopback still proves 10.0.0.1 is blocked.
var (
	allowPlainHTTPSources bool
	allowedSourceIP       func(net.IP) bool
)

// blockedSourceIP reports whether ip is a destination no source fetch may
// reach: the machine itself, the link-local range that carries cloud metadata
// services, and the private networks behind it.
func blockedSourceIP(ip net.IP) bool {
	if allowedSourceIP != nil && allowedSourceIP(ip) {
		return false
	}
	return ip.IsLoopback() || ip.IsPrivate() || ip.IsUnspecified() ||
		ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() ||
		ip.IsInterfaceLocalMulticast() || ip.IsMulticast()
}

// checkSourceURL enforces the scheme allowlist. Destinations are not checked
// here — a hostname says nothing about where it resolves — but at dial time,
// in sourceClient.
func checkSourceURL(raw string) error {
	u, err := url.Parse(raw)
	if err != nil {
		return err
	}
	if u.Scheme == "https" || (u.Scheme == "http" && allowPlainHTTPSources) {
		return nil
	}
	return errors.Errorf("scheme %q is not allowed; https only", u.Scheme)
}

// sourceClient is the only client /fetch-sources uses. Its Control hook runs
// after DNS resolution and before the connection, which is both the
// resolve-then-check the policy calls for — no window between deciding and
// connecting, so a rebinding answer cannot slip through — and the redirect
// check: every hop dials again, so a redirect into a blocked range never
// connects. CheckRedirect covers the other half of a hop, its scheme.
var sourceClient = &http.Client{
	CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) >= 10 {
			return errors.New("stopped after 10 redirects")
		}
		return checkSourceURL(req.URL.String())
	},
	Transport: &http.Transport{
		DialContext: (&net.Dialer{
			Timeout:   10 * time.Second,
			KeepAlive: 30 * time.Second,
			Control: func(network, address string, _ syscall.RawConn) error {
				host, _, err := net.SplitHostPort(address)
				if err != nil {
					return err
				}
				ip := net.ParseIP(host)
				if ip == nil {
					return errors.Errorf("blocked unresolved destination %q", address)
				}
				if blockedSourceIP(ip) {
					return errors.Errorf("blocked destination %s", ip)
				}
				return nil
			},
		}).DialContext,
	},
}

type FetchSourcesRequest struct {
	URLs []string `json:"urls"`
}

type CheckRequest struct {
	Server  string `json:"server"`
	Port    int    `json:"port"`
	Secret  string `json:"secret"`
	Timeout int    `json:"timeout,omitempty"`
}

type CheckResponse struct {
	OK   bool  `json:"ok"`
	Ping int64 `json:"ping,omitempty"`
}

func decodeSecret(s string) ([]byte, error) {
	// The trim set overlaps the base64 alphabets ('+', '/', '_'), so the raw
	// input must be tried before the trimmed one or a secret ending in those
	// characters decodes to the wrong bytes. Hex is tried on both forms first
	// so a hex secret with junk appended can't be misread as base64.
	candidates := []string{s, strings.TrimRight(s, "!@#$%^&*()_+`~[]{}|;:',.<>?/ \t\n\r")}
	for _, c := range candidates {
		if b, err := hex.DecodeString(c); err == nil {
			return b, nil
		}
	}
	for _, c := range candidates {
		for _, enc := range []*base64.Encoding{
			base64.RawURLEncoding, base64.URLEncoding,
			base64.RawStdEncoding, base64.StdEncoding,
		} {
			if b, err := enc.DecodeString(c); err == nil {
				return b, nil
			}
		}
	}
	return nil, errors.Errorf("unable to decode secret %q as hex or base64", s)
}

// sharedSession is package-level and shared across all checks on purpose: the
// auth key negotiated by the first successful check is reused by every later
// one, so they skip the DH exchange that otherwise must complete inside the 2s
// ExchangeTimeout. This looks like a bug (mutable state shared across
// goroutines) and was "fixed" once — which took detection from 99/1022 to
// 0/1022. Do not make this per-check again; see the load-bearing rule in
// CLAUDE.md for the measurements.
var sharedSession = &session.StorageMemory{}

// checkOptionsHook is applied to every check's options just before the client
// is built. It is nil in production and exists for checkproxy_test.go, which
// needs two things no real check may do: trust the fake server's RSA key
// instead of Telegram's, and allow a slower key exchange than the 2s a real
// proxy gets, because the fake server's DH work runs on the same CPU as the
// test. Do not reach for it to change SessionStorage — see the load-bearing
// rule on sharedSession.
var checkOptionsHook func(*telegram.Options)

// newCheckOptions returns client options for one proxy check. All checks share
// sharedSession deliberately — a real Telegram client also reuses its auth key
// rather than running a fresh key exchange per connection.
func newCheckOptions(resolver dcs.Resolver) telegram.Options {
	opts := telegram.Options{
		Resolver:        resolver,
		SessionStorage:  sharedSession,
		DialTimeout:     minTimeoutDuration,
		ExchangeTimeout: 2 * time.Second,
		NoUpdates:       true,
		Device:          telegram.DeviceTDesktopWindows(),
	}
	if checkOptionsHook != nil {
		checkOptionsHook(&opts)
	}
	return opts
}

func tcpCheck(server string, port int) error {
	_, err := cachedLookupHost(server)
	if err != nil {
		return err
	}
	addr := net.JoinHostPort(server, fmt.Sprintf("%d", port))
	conn, err := net.DialTimeout("tcp", addr, tcpTimeout)
	if err != nil {
		return err
	}
	conn.Close()
	return nil
}

func checkProxy(ctx context.Context, server string, port int, secret string, timeoutSec int) (ping int64, err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("panic: %v", r)
			log.Printf("PANIC in checkProxy %s:%d: %v\n%s", server, port, r, debug.Stack())
		}
	}()

	addr := net.JoinHostPort(server, fmt.Sprintf("%d", port))

	decodedSecret, err := decodeSecret(secret)
	if err != nil {
		return 0, errors.Wrap(err, "decode secret")
	}

	resolver, err := dcs.MTProxy(addr, decodedSecret, dcs.MTProxyOptions{})
	if err != nil {
		return 0, errors.Wrap(err, "create MTProxy resolver")
	}

	client := telegram.NewClient(testAppID, testAppHash, newCheckOptions(resolver))

	checkCtx, cancel := context.WithTimeout(ctx, time.Duration(timeoutSec)*time.Second)
	defer cancel()

	var pingResult int64
	err = client.Run(checkCtx, func(ctx context.Context) error {
		start := time.Now()
		_, apiErr := client.API().HelpGetNearestDC(ctx)
		if apiErr != nil {
			return errors.Wrap(apiErr, "help.getNearestDC")
		}
		pingResult = time.Since(start).Milliseconds()
		return nil
	})
	if err != nil {
		return 0, err
	}
	// client.Run reports a cancelled context as success: it ends with
	// `if err := g.Wait(); !errors.Is(err, context.Canceled) { return err }`,
	// because context.Canceled is how it signals a normal shutdown once the
	// callback has returned. Without this check a cancelled check would be
	// reported as a working proxy with a 0 ms ping. checkCtx is the right
	// thing to test: on the success path gotd cancels its own derived group
	// context, not this one, so a real ping still gets through.
	if err := checkCtx.Err(); err != nil {
		return 0, err
	}
	return pingResult, nil
}

// resolveAddr builds the listen address from the HOST and PORT env values.
// Loopback by default; exposing the server (e.g. HOST=0.0.0.0) is an explicit
// opt-in. PORT parsing is deliberately as lenient as it always was: the
// Sscanf error is ignored, so garbage keeps the default and a numeric prefix
// is used as-is.
func resolveAddr(hostEnv, portEnv string) string {
	host := hostEnv
	if host == "" {
		host = defaultHost
	}
	port := defaultPort
	if portEnv != "" {
		fmt.Sscanf(portEnv, "%d", &port)
	}
	return net.JoinHostPort(host, fmt.Sprintf("%d", port))
}

// shouldOpenBrowser reports whether startup should try to launch a browser:
// only when NO_BROWSER is unset (any non-empty value suppresses) and the bound
// host is loopback. Binding a non-loopback address — HOST=0.0.0.0 on a
// headless server — suppresses the launch automatically.
func shouldOpenBrowser(addr, noBrowserEnv string) bool {
	if noBrowserEnv != "" {
		return false
	}
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return false
	}
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// browserCommand returns the platform launcher invocation for url.
func browserCommand(goos, url string) (string, []string) {
	switch goos {
	case "windows":
		return "rundll32", []string{"url.dll,FileProtocolHandler", url}
	case "darwin":
		return "open", []string{url}
	default:
		return "xdg-open", []string{url}
	}
}

// openBrowser fires the platform launcher without ever blocking the server: a
// missing launcher (minimal Linux without xdg-open) logs one line and moves on.
func openBrowser(url string) {
	name, args := browserCommand(runtime.GOOS, url)
	cmd := exec.Command(name, args...)
	if err := cmd.Start(); err != nil {
		log.Printf("Could not open browser: %v — open %s manually", err, url)
		return
	}
	go func() { _ = cmd.Wait() }()
}

// fetchSource retrieves one source's raw text under its own deadline. The body
// is read through a LimitReader one byte past the cap, so an oversized source
// is cut off mid-read and rejected instead of being buffered whole.
//
// The URL clears the scheme allowlist before anything is dialled, and
// sourceClient rejects the destination itself after resolution.
func fetchSource(ctx context.Context, url string) (string, error) {
	if err := checkSourceURL(url); err != nil {
		return "", err
	}

	reqCtx, cancel := context.WithTimeout(ctx, sourceTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, url, nil)
	if err != nil {
		return "", err
	}
	resp, err := sourceClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return "", errors.Errorf("HTTP %d", resp.StatusCode)
	}

	body, err := io.ReadAll(io.LimitReader(resp.Body, maxSourceBytes+1))
	if err != nil {
		return "", err
	}
	if len(body) > maxSourceBytes {
		return "", errors.Errorf("source exceeds %d bytes", maxSourceBytes)
	}
	return string(body), nil
}

// readCheckRequests decodes a batch request body, enforcing maxBodySize and
// maxBatchSize. On failure it returns a non-zero HTTP status and a message the
// caller should send as {"error": msg}; on success status is 0.
func readCheckRequests(w http.ResponseWriter, r *http.Request) ([]CheckRequest, int, string) {
	r.Body = http.MaxBytesReader(w, r.Body, maxBodySize)
	var reqs []CheckRequest
	if err := json.NewDecoder(r.Body).Decode(&reqs); err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			return nil, http.StatusRequestEntityTooLarge,
				fmt.Sprintf("request body exceeds %d bytes", maxBodySize)
		}
		return nil, http.StatusBadRequest, "invalid JSON"
	}
	if len(reqs) > maxBatchSize {
		return nil, http.StatusRequestEntityTooLarge,
			fmt.Sprintf("too many proxies: %d, max %d per request", len(reqs), maxBatchSize)
	}
	return reqs, 0, ""
}

func jsonResponse(w http.ResponseWriter, status int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

// recoverMiddleware turns a panic in a handler into a 500 with a JSON body,
// so one bad request cannot take the process down mid-scan.
func recoverMiddleware(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if rec := recover(); rec != nil {
				log.Printf("PANIC HTTP %s %s: %v\n%s", r.Method, r.URL.Path, rec, debug.Stack())
				jsonResponse(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
			}
		}()
		next(w, r)
	}
}

// newMux wires the three endpoints and the embedded static files. Split out of
// main() so handlers_test.go can drive them with httptest instead of a live
// listener; main() adds nothing but the server, signals and browser launch.
func newMux() *http.ServeMux {
	mux := http.NewServeMux()

	mux.HandleFunc("/check", recoverMiddleware(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}

		r.Body = http.MaxBytesReader(w, r.Body, maxBodySize)

		var req CheckRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			var maxErr *http.MaxBytesError
			if errors.As(err, &maxErr) {
				jsonResponse(w, http.StatusRequestEntityTooLarge,
					map[string]string{"error": fmt.Sprintf("request body exceeds %d bytes", maxBodySize)})
				return
			}
			jsonResponse(w, http.StatusBadRequest, CheckResponse{OK: false})
			return
		}

		timeout := req.Timeout
		if timeout < minTimeout || timeout > maxTimeout {
			timeout = defaultTimeout
		}

		start := time.Now()
		ping, err := checkProxy(r.Context(), req.Server, req.Port, req.Secret, timeout)
		elapsed := time.Since(start)

		if err != nil {
			log.Printf("CHECK FAIL %s:%d timeout=%ds (%v)", req.Server, req.Port, timeout, elapsed)
			jsonResponse(w, http.StatusOK, CheckResponse{OK: false})
		} else {
			log.Printf("CHECK OK   %s:%d %dms timeout=%ds (%v)", req.Server, req.Port, ping, timeout, elapsed)
			jsonResponse(w, http.StatusOK, CheckResponse{OK: true, Ping: ping})
		}
	}))

	mux.HandleFunc("/check-batch", recoverMiddleware(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}

		// Deprecated: removal planned for a future release. Scripts should
		// use /check; streaming consumers /check-stream.
		w.Header().Set("Deprecation", "true")
		w.Header().Set("Link", `</check>; rel="alternate", </check-stream>; rel="successor-version"`)
		log.Printf("DEPRECATED /check-batch hit from %s — use /check for scripting or /check-stream for streaming; removal planned in a future release", r.RemoteAddr)

		reqs, status, msg := readCheckRequests(w, r)
		if status != 0 {
			jsonResponse(w, status, map[string]string{"error": msg})
			return
		}

		limit := 10
		if l := r.Header.Get("X-Concurrency"); l != "" {
			fmt.Sscanf(l, "%d", &limit)
		}
		if limit < 1 {
			limit = 1
		}
		if limit > maxConcurrency {
			limit = maxConcurrency
		}

		timeout := defaultTimeout
		if len(reqs) > 0 && reqs[0].Timeout >= minTimeout && reqs[0].Timeout <= maxTimeout {
			timeout = reqs[0].Timeout
		}

		log.Printf("BATCH START %d proxies, concurrency=%d, timeout=%ds", len(reqs), limit, timeout)
		start := time.Now()

		results := make([]CheckResponse, len(reqs))

		type indexedReq struct {
			idx int
			req CheckRequest
		}

		// Phase 1: TCP pre-check — filter dead proxies fast (~3s max)
		tcpStart := time.Now()
		var reachable []indexedReq
		var reachableMu sync.Mutex
		var tcpWg sync.WaitGroup
		tcpSem := make(chan struct{}, limit)

		for i, p := range reqs {
			tcpWg.Add(1)
			go func(idx int, proxy CheckRequest) {
				defer tcpWg.Done()
				tcpSem <- struct{}{}
				defer func() { <-tcpSem }()

				if err := tcpCheck(proxy.Server, proxy.Port); err != nil {
					results[idx] = CheckResponse{OK: false}
				} else {
					reachableMu.Lock()
					reachable = append(reachable, indexedReq{idx: idx, req: proxy})
					reachableMu.Unlock()
				}
			}(i, p)
		}
		tcpWg.Wait()
		log.Printf("TCP phase done: %d/%d reachable (%v)", len(reachable), len(reqs), time.Since(tcpStart))

		// Phase 2: Full Telegram check — only for reachable proxies
		telegramStart := time.Now()
		telegramSem := make(chan struct{}, limit)
		var telegramWg sync.WaitGroup

		for _, ir := range reachable {
			telegramWg.Add(1)
			go func(item indexedReq) {
				defer telegramWg.Done()
				telegramSem <- struct{}{}
				defer func() { <-telegramSem }()

				t := item.req.Timeout
				if t < minTimeout || t > maxTimeout {
					t = defaultTimeout
				}
				ping, err := checkProxy(r.Context(), item.req.Server, item.req.Port, item.req.Secret, t)
				if err != nil {
					results[item.idx] = CheckResponse{OK: false}
				} else {
					results[item.idx] = CheckResponse{OK: true, Ping: ping}
				}
			}(ir)
		}
		telegramWg.Wait()

		working := 0
		for _, res := range results {
			if res.OK {
				working++
			}
		}
		log.Printf("BATCH DONE  %d/%d working | tcp=%v telegram=%v total=%v",
			working, len(reqs), time.Since(tcpStart), time.Since(telegramStart), time.Since(start))

		jsonResponse(w, http.StatusOK, results)
	}))

	mux.HandleFunc("/check-stream", recoverMiddleware(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}

		flusher, ok := w.(http.Flusher)
		if !ok {
			jsonResponse(w, http.StatusInternalServerError, map[string]string{"error": "streaming not supported"})
			return
		}

		// Decode (and reject) before committing to SSE: a limit violation
		// answers with plain 4xx JSON, not an empty event stream.
		reqs, status, msg := readCheckRequests(w, r)
		if status != 0 {
			jsonResponse(w, status, map[string]string{"error": msg})
			return
		}

		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Connection", "keep-alive")

		limit := 10
		if l := r.Header.Get("X-Concurrency"); l != "" {
			fmt.Sscanf(l, "%d", &limit)
		}
		if limit < 1 {
			limit = 1
		}
		if limit > maxConcurrency {
			limit = maxConcurrency
		}

		timeout := defaultTimeout
		if len(reqs) > 0 && reqs[0].Timeout >= minTimeout && reqs[0].Timeout <= maxTimeout {
			timeout = reqs[0].Timeout
		}

		total := len(reqs)
		log.Printf("STREAM START %d proxies, concurrency=%d, timeout=%ds", total, limit, timeout)

		type strProgress struct {
			Completed int    `json:"completed"`
			Total     int    `json:"total"`
			Working   int    `json:"working"`
			Server    string `json:"server"`
			Port      int    `json:"port"`
			Secret    string `json:"secret"`
			OK        bool   `json:"ok"`
			Ping      int64  `json:"ping,omitempty"`
		}

		sendEvent := func(event string, v interface{}) {
			data, _ := json.Marshal(v)
			fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, data)
			flusher.Flush()
		}

		// Send initial progress
		sendEvent("progress", &strProgress{Completed: 0, Total: total, Working: 0})

		sem := make(chan struct{}, limit)
		var mu sync.Mutex
		var wg sync.WaitGroup

		completed := 0
		working := 0

		for _, p := range reqs {
			wg.Add(1)
			go func(proxy CheckRequest) {
				defer wg.Done()
				sem <- struct{}{}
				defer func() { <-sem }()

				t := proxy.Timeout
				if t < minTimeout || t > maxTimeout {
					t = timeout
				}

				err := tcpCheck(proxy.Server, proxy.Port)
				if err != nil {
					mu.Lock()
					completed++
					sendEvent("progress", &strProgress{
						Completed: completed, Total: total, Working: working,
						Server: proxy.Server, Port: proxy.Port, Secret: proxy.Secret,
						OK: false,
					})
					mu.Unlock()
					return
				}

				// Hard timeout: never let a proxy hang longer than t+10s total
				hardCtx, hardCancel := context.WithTimeout(r.Context(), time.Duration(t+10)*time.Second)
				defer hardCancel()

				type tgResult struct {
					ping int64
					err  error
				}
				tgCh := make(chan tgResult, 1)
				go func() {
					ping, tgErr := checkProxy(hardCtx, proxy.Server, proxy.Port, proxy.Secret, t)
					tgCh <- tgResult{ping, tgErr}
				}()

				var ping int64
				var tgErr error
				select {
				case res := <-tgCh:
					ping = res.ping
					tgErr = res.err
				case <-hardCtx.Done():
					tgErr = hardCtx.Err()
				}

				mu.Lock()
				completed++
				if tgErr != nil {
					sendEvent("progress", &strProgress{
						Completed: completed, Total: total, Working: working,
						Server: proxy.Server, Port: proxy.Port, Secret: proxy.Secret,
						OK: false,
					})
				} else {
					working++
					sendEvent("progress", &strProgress{
						Completed: completed, Total: total, Working: working,
						Server: proxy.Server, Port: proxy.Port, Secret: proxy.Secret,
						OK: true, Ping: ping,
					})
				}
				mu.Unlock()
			}(p)
		}

		wg.Wait()
		log.Printf("STREAM DONE %d/%d working", working, total)
		sendEvent("done", map[string]int{"working": working, "total": total})
	}))

	mux.HandleFunc("/fetch-sources", recoverMiddleware(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}

		r.Body = http.MaxBytesReader(w, r.Body, maxBodySize)

		var req FetchSourcesRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			var maxErr *http.MaxBytesError
			if errors.As(err, &maxErr) {
				jsonResponse(w, http.StatusRequestEntityTooLarge,
					map[string]string{"error": fmt.Sprintf("request body exceeds %d bytes", maxBodySize)})
				return
			}
			jsonResponse(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON"})
			return
		}
		if len(req.URLs) > maxSources {
			jsonResponse(w, http.StatusRequestEntityTooLarge,
				map[string]string{"error": fmt.Sprintf("too many sources: %d, max %d per request", len(req.URLs), maxSources)})
			return
		}

		// Fetched concurrently, concatenated by index: the output order is the
		// request order regardless of which source answers first. A failed
		// source contributes nothing and aborts nothing.
		texts := make([]string, len(req.URLs))
		var wg sync.WaitGroup
		for i, u := range req.URLs {
			wg.Add(1)
			go func(idx int, url string) {
				defer wg.Done()
				text, err := fetchSource(r.Context(), url)
				if err != nil {
					log.Printf("SOURCE FAIL %s: %v", url, err)
					return
				}
				texts[idx] = text
			}(i, u)
		}
		wg.Wait()

		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		for _, text := range texts {
			if text == "" {
				continue
			}
			io.WriteString(w, text)
			if !strings.HasSuffix(text, "\n") {
				io.WriteString(w, "\n")
			}
		}
	}))

	embeddedFS, err := fs.Sub(publicFS, "public")
	if err != nil {
		log.Fatalf("Failed to embed public directory: %v", err)
	}
	mux.Handle("/", http.FileServer(http.FS(embeddedFS)))

	return mux
}

func main() {
	mux := newMux()

	addr := resolveAddr(os.Getenv("HOST"), os.Getenv("PORT"))
	log.Printf("MTProto Checker %s", version)
	log.Printf("Server running at http://%s", addr)

	srv := &http.Server{
		Addr:         addr,
		Handler:      mux,
		ReadTimeout:  30 * time.Second,
		WriteTimeout: 300 * time.Second,
		IdleTimeout:  120 * time.Second,
	}

	done := make(chan os.Signal, 1)
	signal.Notify(done, syscall.SIGINT, syscall.SIGTERM)

	// Listen explicitly so the browser only opens once the address is
	// actually bound; a bind failure dies here, before any launch attempt.
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		log.Fatalf("Listen error: %v", err)
	}

	go func() {
		if err := srv.Serve(ln); err != nil && err != http.ErrServerClosed {
			log.Fatalf("Server error: %v", err)
		}
	}()

	if shouldOpenBrowser(addr, os.Getenv("NO_BROWSER")) {
		openBrowser("http://" + addr)
	}

	<-done
	log.Println("Shutting down...")

	ctx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
	defer cancel()

	if err := srv.Shutdown(ctx); err != nil {
		log.Fatalf("Shutdown error: %v", err)
	}
	log.Println("Server stopped")
}
