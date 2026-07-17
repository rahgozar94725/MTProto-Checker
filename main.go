package main

import (
	"context"
	"embed"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io/fs"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"runtime/debug"
	"strconv"
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
	defaultPort        = 3000
	testAppID          = 6
	testAppHash        = "eb06d4abfb49dc3eeb1aeb98ae0f581e"
	maxBodySize        = 50 * 1024 * 1024
	maxConcurrency     = 50
	defaultTimeout     = 10
	minTimeout         = 3
	maxTimeout         = 30
	tcpTimeout         = 1500 * time.Millisecond
	minTimeoutDuration = time.Duration(minTimeout) * time.Second
	shutdownTimeout    = 5 * time.Second

	// DNS cache tuning. Successful answers are cached for a while; failures are
	// cached briefly so a dead domain isn't re-resolved on every proxy in a
	// batch. The entry cap bounds memory on long-running servers.
	dnsPositiveTTL     = 5 * time.Minute
	dnsNegativeTTL     = 30 * time.Second
	maxDNSCacheEntries = 4096
)

type dnsCacheEntry struct {
	ips  []net.IP
	err  error // non-nil for a cached failure (negative entry)
	next time.Time
}

var (
	dnsCacheMu sync.RWMutex
	dnsCache   = make(map[string]*dnsCacheEntry)
)

// dohEndpoints are DNS-over-HTTPS resolvers used INSTEAD of the system resolver.
// Many ISPs (notably in Iran) poison DNS for proxy domains, returning a bogus
// private IP like 10.10.34.34 — connecting there always fails, which is why the
// checker used to reject healthy proxies that Telegram connects to fine. DoH
// bypasses the tampered local resolver and returns the real public IPs.
var dohEndpoints = []string{
	"https://1.1.1.1/dns-query",
	"https://8.8.8.8/resolve",
	"https://1.0.0.1/dns-query",
	"https://8.8.4.4/resolve",
}

var dohClient = &http.Client{Timeout: 6 * time.Second}

// isUsableIP rejects private / loopback / link-local answers. A public domain
// resolving to 10.10.34.34 (or similar) is a hijacked answer, not a real one.
func isUsableIP(ip net.IP) bool {
	if ip == nil || ip.IsLoopback() || ip.IsPrivate() ||
		ip.IsUnspecified() || ip.IsLinkLocalUnicast() {
		return false
	}
	return true
}

// dnsTypeA / dnsTypeAAAA are the DNS record type numbers returned in the JSON
// "Answer[].type" field.
const (
	dnsTypeA    = 1
	dnsTypeAAAA = 28
)

// dohQuery asks a single DoH endpoint for one record type and returns the
// usable (public) IPs it reports.
func dohQuery(base, host string, qtype int) ([]net.IP, error) {
	typeName := "A"
	if qtype == dnsTypeAAAA {
		typeName = "AAAA"
	}
	req, err := http.NewRequest("GET", base+"?name="+url.QueryEscape(host)+"&type="+typeName, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/dns-json")
	resp, err := dohClient.Do(req)
	if err != nil {
		return nil, err
	}
	var body struct {
		Answer []struct {
			Type int    `json:"type"`
			Data string `json:"data"`
		} `json:"Answer"`
	}
	err = json.NewDecoder(resp.Body).Decode(&body)
	resp.Body.Close()
	if err != nil {
		return nil, err
	}
	var ips []net.IP
	for _, a := range body.Answer {
		if a.Type != qtype {
			continue
		}
		if ip := net.ParseIP(a.Data); isUsableIP(ip) {
			ips = append(ips, ip)
		}
	}
	return ips, nil
}

// dohLookup resolves host over DNS-over-HTTPS, trying each endpoint and
// preferring IPv4 (A) but falling back to IPv6 (AAAA) so v6-only proxies are
// not wrongly reported dead. The first endpoint that yields any usable IP wins.
func dohLookup(host string) ([]net.IP, error) {
	var lastErr error
	for _, base := range dohEndpoints {
		for _, qtype := range []int{dnsTypeA, dnsTypeAAAA} {
			ips, err := dohQuery(base, host, qtype)
			if err != nil {
				lastErr = err
				continue
			}
			if len(ips) > 0 {
				return ips, nil
			}
		}
	}
	if lastErr == nil {
		lastErr = errors.Errorf("no usable A/AAAA records for %q", host)
	}
	return nil, lastErr
}

// storeDNS caches a lookup result (positive or negative) and bounds the cache
// size. Caller must NOT hold dnsCacheMu.
func storeDNS(host string, ips []net.IP, lookupErr error) {
	ttl := dnsPositiveTTL
	if lookupErr != nil {
		ttl = dnsNegativeTTL
	}
	dnsCacheMu.Lock()
	defer dnsCacheMu.Unlock()
	// Bound memory: once the cache is full, drop expired entries; if that isn't
	// enough (all still fresh), clear it wholesale. Cheap and correct for a
	// local tool — the map simply repopulates on demand.
	if len(dnsCache) >= maxDNSCacheEntries {
		now := time.Now()
		for k, e := range dnsCache {
			if now.After(e.next) {
				delete(dnsCache, k)
			}
		}
		if len(dnsCache) >= maxDNSCacheEntries {
			dnsCache = make(map[string]*dnsCacheEntry, maxDNSCacheEntries)
		}
	}
	dnsCache[host] = &dnsCacheEntry{ips: ips, err: lookupErr, next: time.Now().Add(ttl)}
}

func cachedLookupHost(host string) ([]net.IP, error) {
	// Already an IP literal — nothing to resolve.
	if ip := net.ParseIP(host); ip != nil {
		return []net.IP{ip}, nil
	}

	dnsCacheMu.RLock()
	entry, ok := dnsCache[host]
	dnsCacheMu.RUnlock()
	if ok && time.Now().Before(entry.next) {
		return entry.ips, entry.err
	}

	ips, err := dohLookup(host)
	if err != nil {
		// Fall back to the system resolver, but drop hijacked private answers so
		// we never hand back a bogus 10.x address.
		var resolver net.Resolver
		dnsCtx, dnsCancel := context.WithTimeout(context.Background(), 5*time.Second)
		ipAddrs, sysErr := resolver.LookupIPAddr(dnsCtx, host)
		dnsCancel()
		if sysErr != nil {
			storeDNS(host, nil, err)
			return nil, err
		}
		for _, a := range ipAddrs {
			if isUsableIP(a.IP) {
				ips = append(ips, a.IP)
			}
		}
		if len(ips) == 0 {
			finalErr := errors.Errorf("no usable IP for %q (DNS may be hijacked)", host)
			storeDNS(host, nil, finalErr)
			return nil, finalErr
		}
	}

	storeDNS(host, ips, nil)
	return ips, nil
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
	s = strings.TrimSpace(s)
	// Some channels append a label or flag after the secret: "<secret>#name" or
	// "<secret>**". Cut those off before decoding.
	if i := strings.Index(s, "**"); i >= 0 {
		s = s[:i]
	}
	if i := strings.IndexByte(s, '#'); i >= 0 {
		s = s[:i]
	}
	// Strip trailing wrapper punctuation (a stray ")", quote, bracket, etc.) but
	// deliberately keep +, /, _, -, = — those are valid base64 payload/padding
	// characters, and stripping them corrupts an otherwise-healthy secret. The old
	// trim set included _, + and /, which silently mangled base64 secrets.
	s = strings.TrimRight(s, "!@#$%^&*()`~[]{}|;:',.<>? \t\n\r")

	if b, err := hex.DecodeString(s); err == nil {
		return b, nil
	}
	// base64 in every common variant — URL and standard alphabets, raw and padded.
	// Standard base64 (with + and /) is widely used in proxy channels; the old
	// code only tried the URL alphabet, so it rejected those healthy proxies
	// outright with a "decode" error.
	for _, enc := range []*base64.Encoding{
		base64.RawURLEncoding, base64.URLEncoding,
		base64.RawStdEncoding, base64.StdEncoding,
	} {
		if b, err := enc.DecodeString(s); err == nil {
			return b, nil
		}
	}
	return nil, errors.Errorf("unable to decode secret %q as hex or base64", s)
}

// tcpCheck is the fast pre-check: it only needs to know whether *some* IP for
// the proxy accepts a TCP connection. It delegates to reachableAddr and
// discards the address. The old 1.5s fixed dial timeout wrongly rejected
// working proxies on distant servers that simply need >1.5s to handshake, so
// the pre-check gets a real share of the user's budget (with a sane floor).
func tcpCheck(server string, port int, timeoutSec int) error {
	dial := time.Duration(timeoutSec) * time.Second / 2
	if dial < tcpTimeout {
		dial = tcpTimeout
	}
	_, err := reachableAddr(server, port, dial)
	return err
}

// reachableAddr resolves server via DoH and returns the first IP:port that
// accepts a TCP connection, so the MTProto check runs against a real, live IP
// rather than a poisoned DNS answer or a dead address in the rotation. A domain
// often resolves to many IPs; it tries them in turn so a single dead IP doesn't
// sink an otherwise-healthy proxy.
func reachableAddr(server string, port int, dial time.Duration) (string, error) {
	ips, err := cachedLookupHost(server)
	if err != nil {
		return "", err
	}
	portStr := strconv.Itoa(port)
	for _, ip := range ips {
		addr := net.JoinHostPort(ip.String(), portStr)
		conn, dialErr := net.DialTimeout("tcp", addr, dial)
		if dialErr == nil {
			conn.Close()
			return addr, nil
		}
		err = dialErr
	}
	if err == nil {
		err = errors.Errorf("no reachable IP for %s:%d", server, port)
	}
	return "", err
}

func checkProxy(ctx context.Context, server string, port int, secret string, timeoutSec int) (ping int64, err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("panic: %v", r)
			log.Printf("PANIC in checkProxy %s:%d: %v\n%s", server, port, r, debug.Stack())
		}
	}()

	decodedSecret, err := decodeSecret(secret)
	if err != nil {
		return 0, errors.Wrap(err, "decode secret")
	}

	// Resolve via DoH and pick a live IP ourselves. If we passed the hostname to
	// gotd it would re-resolve through the (possibly hijacked) system DNS. For
	// fake-TLS the SNI comes from the secret's embedded domain, not this address,
	// so connecting straight to the real IP is correct.
	dial := time.Duration(timeoutSec) * time.Second / 3
	if dial < tcpTimeout {
		dial = tcpTimeout
	}
	addr, err := reachableAddr(server, port, dial)
	if err != nil {
		return 0, errors.Wrap(err, "resolve/connect")
	}

	resolver, err := dcs.MTProxy(addr, decodedSecret, dcs.MTProxyOptions{})
	if err != nil {
		return 0, errors.Wrap(err, "create MTProxy resolver")
	}

	// Each proxy must get its own fresh session storage. The auth key and target
	// DC that gotd caches here are negotiated with one specific proxy/server — a
	// shared storage would make every subsequent proxy reuse a key that is invalid
	// for it (decryption / AUTH_KEY errors), and concurrent checks would corrupt it.
	// A per-call store forces a clean handshake from scratch, which is the point.
	localSession := &session.StorageMemory{}

	// Give the TCP dial and the MTProto key exchange a fair share of the overall
	// budget instead of the old fixed 3s/2s. A 2s exchange window in particular
	// wrongly failed plenty of proxies that Telegram itself connects to fine —
	// their handshake just needs more than 2s over a slow/high-latency link.
	total := time.Duration(timeoutSec) * time.Second
	// TCP connect is quick when it works; cap the dial so it can't eat the whole
	// budget, but keep at least the old 3s floor.
	dialTimeout := total / 3
	if dialTimeout < minTimeoutDuration {
		dialTimeout = minTimeoutDuration
	}
	// Let the handshake use whatever is left of the budget — the overall context
	// below is the real bound. This is the value that matters for false rejects.
	exchangeTimeout := total

	client := telegram.NewClient(testAppID, testAppHash, telegram.Options{
		Resolver:        resolver,
		SessionStorage:  localSession,
		DialTimeout:     dialTimeout,
		ExchangeTimeout: exchangeTimeout,
		NoUpdates:       true,
		Device:          telegram.DeviceTDesktopWindows(),
	})

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
	return pingResult, nil
}

type FetchChannelsResponse struct {
	Links  []string `json:"links"`
	Count  int      `json:"count"`
	Errors []string `json:"errors,omitempty"`
	Notes  []string `json:"notes,omitempty"`
}

const maxChannels = 30

// normalizeChannel turns user input (URL, @name, plain name) into a bare channel username.
func normalizeChannel(raw string) string {
	s := strings.TrimSpace(raw)
	if s == "" {
		return ""
	}
	s = strings.TrimPrefix(s, "https://")
	s = strings.TrimPrefix(s, "http://")
	s = strings.TrimPrefix(s, "t.me/")
	s = strings.TrimPrefix(s, "telegram.me/")
	s = strings.TrimPrefix(s, "s/") // t.me/s/<name>
	s = strings.TrimPrefix(s, "@")
	// Drop anything after the username (e.g. ?query or /123 message id)
	if i := strings.IndexAny(s, "/?#"); i >= 0 {
		s = s[:i]
	}
	return s
}

func jsonResponse(w http.ResponseWriter, status int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func main() {
	port := defaultPort
	if p := os.Getenv("PORT"); p != "" {
		fmt.Sscanf(p, "%d", &port)
	}

	mux := http.NewServeMux()

	recoverMiddleware := func(next http.HandlerFunc) http.HandlerFunc {
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

	mux.HandleFunc("/check", recoverMiddleware(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}

		r.Body = http.MaxBytesReader(w, r.Body, maxBodySize)

		var req CheckRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
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
			log.Printf("CHECK FAIL %s:%d timeout=%ds (%v) err=%v", req.Server, req.Port, timeout, elapsed, err)
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

		r.Body = http.MaxBytesReader(w, r.Body, maxBodySize)

		var reqs []CheckRequest
		if err := json.NewDecoder(r.Body).Decode(&reqs); err != nil {
			jsonResponse(w, http.StatusBadRequest, nil)
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

				if err := tcpCheck(proxy.Server, proxy.Port, timeout); err != nil {
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
					log.Printf("BATCH FAIL %s:%d telegram (%v)", item.req.Server, item.req.Port, err)
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

		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Connection", "keep-alive")

		flusher, ok := w.(http.Flusher)
		if !ok {
			jsonResponse(w, http.StatusInternalServerError, map[string]string{"error": "streaming not supported"})
			return
		}
		// Long-lived SSE stream: clear the server's global WriteTimeout so a large
		// proxy list (which can take minutes at low concurrency) isn't cut off
		// mid-stream.
		if err := http.NewResponseController(w).SetWriteDeadline(time.Time{}); err != nil {
			log.Printf("WARN: could not clear write deadline for /check-stream: %v", err)
		}

		r.Body = http.MaxBytesReader(w, r.Body, maxBodySize)

		var reqs []CheckRequest
		if err := json.NewDecoder(r.Body).Decode(&reqs); err != nil {
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

				err := tcpCheck(proxy.Server, proxy.Port, t)
				if err != nil {
					log.Printf("STREAM FAIL %s:%d tcp (%v)", proxy.Server, proxy.Port, err)
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
					log.Printf("STREAM FAIL %s:%d telegram (%v)", proxy.Server, proxy.Port, tgErr)
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

	// ---- Telegram authenticated channel fetching ----

	// Check whether a stored session is still valid/authorized (through a proxy).
	mux.HandleFunc("/tg/status", recoverMiddleware(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}
		var req struct {
			Proxy ProxyCreds `json:"proxy"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil {
			jsonResponse(w, http.StatusBadRequest, map[string]any{"error": "invalid request"})
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
		defer cancel()
		authorized, err := isAuthorized(ctx, req.Proxy)
		if err != nil {
			jsonResponse(w, http.StatusOK, map[string]any{"authorized": false, "error": err.Error()})
			return
		}
		jsonResponse(w, http.StatusOK, map[string]any{"authorized": authorized})
	}))

	// Start a phone-number login (sends the code). Optionally accepts a custom
	// api_id/api_hash which is persisted locally (outside the repo) for reuse.
	mux.HandleFunc("/tg/login/start", recoverMiddleware(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}
		var req struct {
			Proxy   ProxyCreds `json:"proxy"`
			Phone   string     `json:"phone"`
			AppID   int        `json:"app_id,omitempty"`
			AppHash string     `json:"app_hash,omitempty"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil {
			jsonResponse(w, http.StatusBadRequest, map[string]any{"error": "invalid request"})
			return
		}
		if strings.TrimSpace(req.Phone) == "" {
			jsonResponse(w, http.StatusBadRequest, map[string]any{"error": "phone is required"})
			return
		}
		appID, appHash := loadAppCreds()
		if req.AppID != 0 && strings.TrimSpace(req.AppHash) != "" {
			appID, appHash = req.AppID, strings.TrimSpace(req.AppHash)
			if err := saveAppCreds(appID, appHash); err != nil {
				log.Printf("WARN: could not persist app creds: %v", err)
			}
		}
		if err := loginMgr.start(req.Proxy, strings.TrimSpace(req.Phone), appID, appHash); err != nil {
			jsonResponse(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
			return
		}
		jsonResponse(w, http.StatusOK, map[string]any{"ok": true})
	}))

	mux.HandleFunc("/tg/login/code", recoverMiddleware(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}
		var req struct {
			Code string `json:"code"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil {
			jsonResponse(w, http.StatusBadRequest, map[string]any{"error": "invalid request"})
			return
		}
		if err := loginMgr.submitCode(strings.TrimSpace(req.Code)); err != nil {
			jsonResponse(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
			return
		}
		jsonResponse(w, http.StatusOK, map[string]any{"ok": true})
	}))

	mux.HandleFunc("/tg/login/password", recoverMiddleware(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}
		var req struct {
			Password string `json:"password"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil {
			jsonResponse(w, http.StatusBadRequest, map[string]any{"error": "invalid request"})
			return
		}
		if err := loginMgr.submitPassword(req.Password); err != nil {
			jsonResponse(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
			return
		}
		jsonResponse(w, http.StatusOK, map[string]any{"ok": true})
	}))

	mux.HandleFunc("/tg/login/status", recoverMiddleware(func(w http.ResponseWriter, r *http.Request) {
		state, errMsg, phone, sitekey := loginMgr.snapshot()
		jsonResponse(w, http.StatusOK, map[string]any{"state": state, "error": errMsg, "phone": phone, "sitekey": sitekey})
	}))

	// Submit a solved reCAPTCHA token to satisfy a send-code challenge.
	mux.HandleFunc("/tg/login/captcha", recoverMiddleware(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}
		var req struct {
			Token string `json:"token"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil {
			jsonResponse(w, http.StatusBadRequest, map[string]any{"error": "invalid request"})
			return
		}
		if strings.TrimSpace(req.Token) == "" {
			jsonResponse(w, http.StatusBadRequest, map[string]any{"error": "token is required"})
			return
		}
		if err := loginMgr.submitCaptcha(strings.TrimSpace(req.Token)); err != nil {
			jsonResponse(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
			return
		}
		jsonResponse(w, http.StatusOK, map[string]any{"ok": true})
	}))

	// Report whether a saved session/credentials exist so the UI can resume
	// without forcing a fresh login. This only reads local files (no network),
	// so it is fast and safe to call on page load.
	mux.HandleFunc("/tg/me", recoverMiddleware(func(w http.ResponseWriter, r *http.Request) {
		resp := map[string]any{"has_session": false, "has_app_creds": false}
		if path, err := sessionFilePath(); err == nil {
			if info, serr := os.Stat(path); serr == nil && info.Size() > 0 {
				resp["has_session"] = true
			}
		}
		// Surface custom api_id/api_hash saved by the user (not the public test
		// fallback) so the advanced fields can be pre-filled.
		if path, err := appConfigPath(); err == nil {
			if data, rerr := os.ReadFile(path); rerr == nil {
				var cfg tgAppConfig
				if json.Unmarshal(data, &cfg) == nil && cfg.AppID != 0 && cfg.AppHash != "" {
					resp["has_app_creds"] = true
					resp["app_id"] = cfg.AppID
					resp["app_hash"] = cfg.AppHash
				}
			}
		}
		jsonResponse(w, http.StatusOK, resp)
	}))

	mux.HandleFunc("/tg/logout", recoverMiddleware(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}
		if err := logout(); err != nil {
			jsonResponse(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
			return
		}
		jsonResponse(w, http.StatusOK, map[string]any{"ok": true})
	}))

	// Fetch proxy links from channels using the authenticated MTProto client
	// (tunneled through a working MTProto proxy — no HTTP/SOCKS proxy needed).
	mux.HandleFunc("/fetch-channels-tg", recoverMiddleware(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, maxBodySize)
		var req FetchTGRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			jsonResponse(w, http.StatusBadRequest, FetchChannelsResponse{Errors: []string{"invalid request"}})
			return
		}

		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Connection", "keep-alive")
		flusher, ok := w.(http.Flusher)
		if !ok {
			jsonResponse(w, http.StatusInternalServerError, FetchChannelsResponse{Errors: []string{"streaming not supported"}})
			return
		}
		// Long-lived SSE stream (channel scan can run up to tgFetchTimeout); clear
		// the server's global WriteTimeout so it isn't cut off mid-stream.
		if err := http.NewResponseController(w).SetWriteDeadline(time.Time{}); err != nil {
			log.Printf("WARN: could not clear write deadline for /fetch-channels-tg: %v", err)
		}

		var mu sync.Mutex
		sendEvent := func(event string, v interface{}) {
			data, _ := json.Marshal(v)
			mu.Lock()
			fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, data)
			flusher.Flush()
			mu.Unlock()
		}

		log.Printf("FETCH-TG START %d channels via %s:%d", len(req.Channels), req.Proxy.Server, req.Proxy.Port)
		start := time.Now()
		resp, err := fetchChannelsViaTelegram(r.Context(), req, func(done, total int, note string) {
			sendEvent("progress", map[string]interface{}{"done": done, "total": total, "note": note})
		})
		if err != nil {
			sendEvent("done", FetchChannelsResponse{Errors: []string{err.Error()}})
			return
		}
		log.Printf("FETCH-TG DONE %d links (%v)", resp.Count, time.Since(start))
		sendEvent("done", resp)
	}))

	embeddedFS, err := fs.Sub(publicFS, "public")
	if err != nil {
		log.Fatalf("Failed to embed public directory: %v", err)
	}
	mux.Handle("/", http.FileServer(http.FS(embeddedFS)))

	// Bind to loopback by default: this server holds a real Telegram user session
	// (see /tg/login/*), so it must not be reachable from the LAN unless the user
	// explicitly opts in. Set HOST=0.0.0.0 to expose it.
	host := os.Getenv("HOST")
	if host == "" {
		host = "127.0.0.1"
	}
	addr := net.JoinHostPort(host, strconv.Itoa(port))
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

	go func() {
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("Server error: %v", err)
		}
	}()

	<-done
	log.Println("Shutting down...")

	ctx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
	defer cancel()

	if err := srv.Shutdown(ctx); err != nil {
		log.Fatalf("Shutdown error: %v", err)
	}
	log.Println("Server stopped")
}
