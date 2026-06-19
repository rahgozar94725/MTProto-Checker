package main

import (
	"context"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"runtime/debug"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/go-faster/errors"
	"github.com/gotd/td/telegram"
	"github.com/gotd/td/telegram/dcs"
	"github.com/gotd/td/session"
)

var version = "dev"

const (
	defaultPort     = 3000
	testAppID       = 6
	testAppHash     = "eb06d4abfb49dc3eeb1aeb98ae0f581e"
	maxBodySize     = 50 * 1024 * 1024
	maxConcurrency  = 50
	defaultTimeout  = 5
	minTimeout      = 3
	maxTimeout      = 30
	tcpTimeout      = 1500 * time.Millisecond
	minTimeoutDuration = time.Duration(minTimeout) * time.Second
	shutdownTimeout = 5 * time.Second
)

var sharedSession = &session.StorageMemory{}

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
	s = strings.TrimRight(s, "!@#$%^&*()_+`~[]{}|;:',.<>?/ \t\n\r")
	if b, err := hex.DecodeString(s); err == nil {
		return b, nil
	}
	if b, err := base64.RawURLEncoding.DecodeString(s); err == nil {
		return b, nil
	}
	if b, err := base64.URLEncoding.DecodeString(s); err == nil {
		return b, nil
	}
	return nil, errors.Errorf("unable to decode secret %q as hex or base64url", s)
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

	client := telegram.NewClient(testAppID, testAppHash, telegram.Options{
		Resolver:        resolver,
		SessionStorage:  sharedSession,
		DialTimeout:     minTimeoutDuration,
		ExchangeTimeout: 2 * time.Second,
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

		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Connection", "keep-alive")

		flusher, ok := w.(http.Flusher)
		if !ok {
			jsonResponse(w, http.StatusInternalServerError, map[string]string{"error": "streaming not supported"})
			return
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

	publicDir := filepath.Join(".", "public")
	fs := http.FileServer(http.Dir(publicDir))
	mux.Handle("/", fs)

	addr := fmt.Sprintf(":%d", port)
	log.Printf("Server running at http://localhost:%d", port)

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
