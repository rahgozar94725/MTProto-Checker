package main

import (
	"bytes"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"net/url"
	"os"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestDecodeSecret(t *testing.T) {
	// dd-prefixed 17-byte secret whose base64 forms contain '+' and '/'
	secret, err := hex.DecodeString("dd00fbef3ec8a03bff84f0ff0fefff3f01")
	if err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name  string
		input string
		want  []byte
	}{
		{"hex", "ee", []byte{0xee}},
		{"empty", "", []byte{}},
		{"hex with junk suffix", "ee)", []byte{0xee}},
		{"base64 std padded", base64.StdEncoding.EncodeToString(secret), secret},
		{"base64 std unpadded", base64.RawStdEncoding.EncodeToString(secret), secret},
		{"base64 urlsafe", base64.RawURLEncoding.EncodeToString(secret), secret},
		// trailing '/' and '_' are in the junk-trim set; the raw input must
		// be decoded before trimming or these decode to the wrong bytes
		{"base64 std trailing slash", "AAP/", []byte{0x00, 0x03, 0xff}},
		{"base64 urlsafe trailing underscore", "AAP_", []byte{0x00, 0x03, 0xff}},
	}
	for _, tt := range tests {
		got, err := decodeSecret(tt.input)
		if err != nil {
			t.Errorf("%s: decodeSecret(%q) err=%v", tt.name, tt.input, err)
			continue
		}
		if !bytes.Equal(got, tt.want) {
			t.Errorf("%s: decodeSecret(%q) = %x, want %x", tt.name, tt.input, got, tt.want)
		}
	}

	if _, err := decodeSecret("eeRigzNJvxrFGRMCIMJdEKuVuRueWVrdGFuZXQuY29tZmFyYXqhdi5jb212YW4ubmFqdmEuY29tAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA)"); err != nil {
		t.Errorf("decodeSecret with trailing junk: %v", err)
	}
}

func parseProxyLink(raw string) (server string, port int, secret string, ok bool) {
	raw = strings.TrimSpace(raw)
	if !strings.Contains(raw, "tg://proxy?") {
		return "", 0, "", false
	}
	u, err := url.Parse(raw)
	if err != nil {
		return "", 0, "", false
	}
	q := u.Query()
	s := q.Get("server")
	p, _ := strconv.Atoi(q.Get("port"))
	sec := q.Get("secret")
	if s == "" || p == 0 || sec == "" {
		return "", 0, "", false
	}
	sec = strings.Split(sec, "**")[0]
	sec = strings.Split(sec, "#")[0]
	sec = strings.TrimRight(sec, ")!@#$%^&*()_+`~[]{}|;:',.<>?/ \t\n\r")
	return s, p, sec, true
}

func TestParseProxyLinks(t *testing.T) {
	links := []string{
		"tg://proxy?server=test.example.com&port=8888&secret=ee",
		"tg://proxy?server=10.0.0.1&port=443&secret=7gAA8A8Pd1VV",
		"invalid",
	}
	got := 0
	for _, l := range links {
		_, _, _, ok := parseProxyLink(l)
		if ok {
			got++
		}
	}
	if got != 2 {
		t.Errorf("parsed %d valid links, want 2", got)
	}
}

func TestTcpCheckLocalhost(t *testing.T) {
	if err := tcpCheck("localhost", 3000); err == nil {
		t.Log("port 3000 open (server may be running)")
	} else {
		t.Logf("port 3000 closed (%v)", err)
	}
}

func TestNewCheckOptionsFreshSession(t *testing.T) {
	a := newCheckOptions(nil)
	b := newCheckOptions(nil)
	if a.SessionStorage == nil || b.SessionStorage == nil {
		t.Fatal("newCheckOptions returned nil SessionStorage")
	}
	if a.SessionStorage == b.SessionStorage {
		t.Error("SessionStorage shared between checks; each check must get a fresh session")
	}
}

func TestResolveAddr(t *testing.T) {
	tests := []struct {
		host, port, want string
	}{
		{"", "", "127.0.0.1:3000"},      // loopback by default
		{"", "8080", "127.0.0.1:8080"},  // PORT honored
		{"0.0.0.0", "", "0.0.0.0:3000"}, // explicit opt-in to all interfaces
		{"192.168.1.5", "8080", "192.168.1.5:8080"},
		{"::1", "", "[::1]:3000"},     // IPv6 host bracketed
		{"", "abc", "127.0.0.1:3000"}, // lenient PORT parsing preserved:
		{"", "80abc", "127.0.0.1:80"}, // Sscanf error ignored, partial parse kept
	}
	for _, tt := range tests {
		if got := resolveAddr(tt.host, tt.port); got != tt.want {
			t.Errorf("resolveAddr(%q, %q) = %q, want %q", tt.host, tt.port, got, tt.want)
		}
	}
}

func TestShouldOpenBrowser(t *testing.T) {
	tests := []struct {
		addr, env string
		want      bool
	}{
		{"127.0.0.1:3000", "", true},
		{"[::1]:3000", "", true},
		{"localhost:3000", "", true},
		{"127.0.0.1:3000", "1", false},  // NO_BROWSER set
		{"0.0.0.0:3000", "", false},     // non-loopback bind suppresses automatically
		{"192.168.1.5:8080", "", false}, // ditto for a specific LAN address
		{"[::]:3000", "", false},
		{"not-an-addr", "", false},
	}
	for _, tt := range tests {
		if got := shouldOpenBrowser(tt.addr, tt.env); got != tt.want {
			t.Errorf("shouldOpenBrowser(%q, %q) = %v, want %v", tt.addr, tt.env, got, tt.want)
		}
	}
}

func TestBrowserCommand(t *testing.T) {
	const url = "http://127.0.0.1:3000"
	tests := []struct {
		goos, name string
		args       []string
	}{
		{"windows", "rundll32", []string{"url.dll,FileProtocolHandler", url}},
		{"darwin", "open", []string{url}},
		{"linux", "xdg-open", []string{url}},
		{"freebsd", "xdg-open", []string{url}}, // anything else falls back to xdg-open
	}
	for _, tt := range tests {
		name, args := browserCommand(tt.goos, url)
		if name != tt.name || !slices.Equal(args, tt.args) {
			t.Errorf("browserCommand(%q) = %q %v, want %q %v", tt.goos, name, args, tt.name, tt.args)
		}
	}
}

func TestDecodeSecretErrors(t *testing.T) {
	_, err := decodeSecret("!!!invalid!!!")
	if err == nil {
		t.Error("expected error for invalid secret")
	}
}

type proxyStats struct {
	total   int
	parsed  int
	deduped int
	tcpOK   int
	tcpFail int
	dnsFail int
}

func loadProxyFile(t *testing.T) []string {
	t.Helper()
	data, err := os.ReadFile("testdata/proxies.txt")
	if err != nil {
		t.Skipf("proxy file not found: %v", err)
	}
	return strings.Split(strings.TrimSpace(string(data)), "\n")
}

func TestBatchParseAndTcpCheck(t *testing.T) {
	if testing.Short() {
		t.Skip("skip batch test in short mode")
	}

	lines := loadProxyFile(t)
	stats := &proxyStats{total: len(lines)}

	var proxies []struct {
		server string
		port   int
		secret string
	}

	seen := make(map[string]bool)
	for _, l := range lines {
		s, p, sec, ok := parseProxyLink(l)
		if !ok {
			continue
		}
		key := fmt.Sprintf("%s:%d:%s", s, p, sec)
		if seen[key] {
			continue
		}
		seen[key] = true
		stats.parsed++
		proxies = append(proxies, struct {
			server string
			port   int
			secret string
		}{s, p, sec})
	}

	t.Logf("total=%d parsed=%d deduped=%d", stats.total, stats.parsed, len(proxies))

	const batchSize = 200
	if len(proxies) > batchSize {
		proxies = proxies[:batchSize]
	}

	limit := 50
	var mu sync.Mutex
	var wg sync.WaitGroup
	sem := make(chan struct{}, limit)

	tcpStart := time.Now()
	for _, p := range proxies {
		wg.Add(1)
		go func(s string, port int) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()

			if err := tcpCheck(s, port); err != nil {
				mu.Lock()
				if strings.Contains(err.Error(), "no such host") {
					stats.dnsFail++
				} else {
					stats.tcpFail++
				}
				mu.Unlock()
			} else {
				mu.Lock()
				stats.tcpOK++
				mu.Unlock()
			}
		}(p.server, p.port)
	}
	wg.Wait()
	tcpElapsed := time.Since(tcpStart)

	t.Logf("tcp: ok=%d fail=%d dns=%d (%v)",
		stats.tcpOK, stats.tcpFail, stats.dnsFail, tcpElapsed)

	if stats.tcpOK == 0 {
		t.Log("WARNING: no TCP-reachable proxies found, check network")
	}
}

func BenchmarkBatchPipeline(b *testing.B) {
	lines, err := func() ([]string, error) {
		data, err := os.ReadFile("testdata/proxies.txt")
		if err != nil {
			return nil, err
		}
		return strings.Split(strings.TrimSpace(string(data)), "\n"), nil
	}()
	if err != nil {
		b.Skipf("proxy file not found: %v", err)
	}
	var proxies []struct {
		server string
		port   int
		secret string
	}
	seen := make(map[string]bool)
	for _, l := range lines {
		s, p, sec, ok := parseProxyLink(l)
		if !ok {
			continue
		}
		key := fmt.Sprintf("%s:%d:%s", s, p, sec)
		if seen[key] {
			continue
		}
		seen[key] = true
		proxies = append(proxies, struct {
			server string
			port   int
			secret string
		}{s, p, sec})
	}
	if len(proxies) > 50 {
		proxies = proxies[:50]
	}

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		limit := 50
		var wg sync.WaitGroup
		sem := make(chan struct{}, limit)

		tcpStart := time.Now()
		for _, p := range proxies {
			wg.Add(1)
			go func(s string, port int) {
				defer wg.Done()
				sem <- struct{}{}
				defer func() { <-sem }()
				tcpCheck(s, port)
			}(p.server, p.port)
		}
		wg.Wait()
		b.Logf("TCP phase: %v", time.Since(tcpStart))
	}
}
