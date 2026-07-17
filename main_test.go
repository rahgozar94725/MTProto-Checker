package main

import (
	"bytes"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestDecodeSecret(t *testing.T) {
	tests := []struct {
		input string
		want  []byte
	}{
		{"ee", []byte{0xee}},
		{"", []byte{}},
	}
	for _, tt := range tests {
		got, err := decodeSecret(tt.input)
		if err != nil {
			t.Errorf("decodeSecret(%q) err=%v", tt.input, err)
			continue
		}
		if len(got) != len(tt.want) {
			t.Errorf("decodeSecret(%q) len=%d, want %d", tt.input, len(got), len(tt.want))
		}
	}

	if _, err := decodeSecret("eeRigzNJvxrFGRMCIMJdEKuVuRueWVrdGFuZXQuY29tZmFyYXqhdi5jb212YW4ubmFqdmEuY29tAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA)"); err != nil {
		t.Errorf("decodeSecret with trailing junk: %v", err)
	}

	// A fake-TLS secret (ee + 16 bytes + domain) encoded in STANDARD base64 — its
	// alphabet uses + and /. The old decoder only understood the URL alphabet and
	// wrongly rejected these healthy proxies. Every encoding of the SAME bytes must
	// decode to the SAME result.
	rawSecret := []byte{0xee, 0xfb, 0xef, 0xff, 0x3e, 0x3f, 0xf8, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a}
	rawSecret = append(rawSecret, []byte("cloudflare.com")...)
	for name, form := range map[string]string{
		"hex":       hex.EncodeToString(rawSecret),
		"base64std": base64.StdEncoding.EncodeToString(rawSecret),     // contains + and /
		"base64url": base64.RawURLEncoding.EncodeToString(rawSecret),  // contains - and _
	} {
		got, err := decodeSecret(form)
		if err != nil {
			t.Errorf("decodeSecret(%s=%q) err=%v", name, form, err)
			continue
		}
		if !bytes.Equal(got, rawSecret) {
			t.Errorf("decodeSecret(%s) = %x, want %x", name, got, rawSecret)
		}
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
	if err := tcpCheck("localhost", 3000, defaultTimeout); err == nil {
		t.Log("port 3000 open (server may be running)")
	} else {
		t.Logf("port 3000 closed (%v)", err)
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
	data, err := os.ReadFile("C:\\Users\\Hamed\\Downloads\\Telegram Desktop\\allinone.txt")
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

			if err := tcpCheck(s, port, defaultTimeout); err != nil {
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
		data, err := os.ReadFile("C:\\Users\\Hamed\\Downloads\\Telegram Desktop\\allinone.txt")
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
				tcpCheck(s, port, defaultTimeout)
			}(p.server, p.port)
		}
		wg.Wait()
		b.Logf("TCP phase: %v", time.Since(tcpStart))
	}
}
