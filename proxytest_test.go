package main

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestTelegramCheckWorkingProxies(t *testing.T) {
	if testing.Short() {
		t.Skip("skip Telegram check in short mode")
	}
	data, err := os.ReadFile("testdata/proxies.txt")
	if err != nil {
		t.Skipf("proxy file not found: %v", err)
	}
	lines := strings.Split(strings.TrimSpace(string(data)), "\n")

	type proxyInfo struct {
		server string
		port   int
		secret string
	}
	var reachable []proxyInfo

	seen := make(map[string]bool)
	for _, l := range lines {
		l = strings.TrimSpace(l)
		if !strings.Contains(l, "tg://proxy?") {
			continue
		}
		u, err := url.Parse(l)
		if err != nil {
			continue
		}
		q := u.Query()
		s := q.Get("server")
		p, _ := strconv.Atoi(q.Get("port"))
		sec := q.Get("secret")
		if s == "" || p == 0 || sec == "" {
			continue
		}
		sec = strings.Split(sec, "**")[0]
		sec = strings.Split(sec, "#")[0]
		key := fmt.Sprintf("%s:%d:%s", s, p, sec)
		if seen[key] {
			continue
		}
		seen[key] = true

		if err := tcpCheck(s, p); err == nil {
			reachable = append(reachable, proxyInfo{s, p, sec})
			if len(reachable) >= 2 {
				break
			}
		}
	}

	t.Logf("Found %d TCP-reachable proxies", len(reachable))
	if len(reachable) == 0 {
		t.Skip("no reachable proxies to test Telegram check")
	}

	ctx := context.Background()
	for i, p := range reachable {
		t.Run(fmt.Sprintf("proxy-%d", i), func(t *testing.T) {
			start := time.Now()
			ping, err := checkProxy(ctx, p.server, p.port, p.secret, 8)
			elapsed := time.Since(start)
			if err != nil {
				t.Logf("FAIL %s:%d — %v (%v)", p.server, p.port, err, elapsed)
			} else {
				t.Logf("OK   %s:%d — ping=%dms (%v)", p.server, p.port, ping, elapsed)
			}
		})
	}
}
