// checkProxy tests. The success path needs a real MTProxy and stays covered
// only by proxytest_test.go; everything here exercises the failure paths, and
// none of it leaves the machine — the network tests bind 127.0.0.1:0 and talk
// to their own listener, so the file needs no -short guard.
package main

import (
	"context"
	"net"
	"strings"
	"sync"
	"testing"
	"time"
)

// validSecret is 16 bytes of hex: mtproxy.ParseSecret reads that as a Simple
// secret and skips the codec-tag check, so a failure downstream of it is a
// transport failure and not an argument-validation one.
const validSecret = "000102030405060708090a0b0c0d0e0f"

// TestCheckProxyRejectsBadSecret covers the two errors checkProxy returns
// before it dials anything: the secret does not decode at all, or it decodes
// to bytes mtproxy.ParseSecret refuses.
func TestCheckProxyRejectsBadSecret(t *testing.T) {
	tests := []struct {
		name   string
		secret string
		want   string // substring of the wrap checkProxy adds
	}{
		// Neither hex nor base64 ('@' is outside both alphabets), and 'z' is
		// not in decodeSecret's trim set, so the trimmed candidate fails too.
		{"undecodable", "@@zz", "decode secret"},
		// Decodes to one byte: not 16, not more, so ParseSecret bails out.
		{"too short", "00", "create MTProxy resolver"},
		// 17 bytes makes it a Secured secret, whose first byte must be a known
		// codec tag; 0x01 is not one.
		{"unknown codec tag", "01" + validSecret, "create MTProxy resolver"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ping, err := checkProxy(context.Background(), "127.0.0.1", 443, tt.secret, 1)
			if err == nil {
				t.Fatalf("checkProxy(secret=%q) = %d, nil; want an error", tt.secret, ping)
			}
			if ping != 0 {
				t.Errorf("ping = %d, want 0 on failure", ping)
			}
			if !strings.Contains(err.Error(), tt.want) {
				t.Errorf("error = %q, want it to mention %q", err, tt.want)
			}
		})
	}
}

// listenLoopback binds an ephemeral loopback port and hands each accepted
// connection to onConn until the listener is closed. Connections onConn leaves
// open are closed when the test ends, so a handler that deliberately stalls
// does not leak. It returns the host and port to point checkProxy at.
func listenLoopback(t *testing.T, onConn func(net.Conn)) (string, int) {
	t.Helper()

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}

	var (
		mu    sync.Mutex
		conns []net.Conn
	)
	t.Cleanup(func() {
		_ = ln.Close()
		mu.Lock()
		defer mu.Unlock()
		for _, conn := range conns {
			_ = conn.Close()
		}
	})

	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return // listener closed by the cleanup above
			}
			mu.Lock()
			conns = append(conns, conn)
			mu.Unlock()
			onConn(conn)
		}
	}()

	addr := ln.Addr().(*net.TCPAddr)
	return addr.IP.String(), addr.Port
}

// closedLoopbackPort returns a loopback port that nothing is listening on: it
// binds one and closes it again, so the port was free at the moment of the
// call.
func closedLoopbackPort(t *testing.T) (string, int) {
	t.Helper()

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	addr := ln.Addr().(*net.TCPAddr)
	if err := ln.Close(); err != nil {
		t.Fatalf("close listener: %v", err)
	}
	return addr.IP.String(), addr.Port
}

// TestCheckProxyReportsConnectionFailures covers the paths where the secret is
// valid and the failure happens on the wire. In every case checkProxy must
// report an error and a zero ping rather than panicking or inventing a
// round-trip time.
func TestCheckProxyReportsConnectionFailures(t *testing.T) {
	t.Run("nothing listening", func(t *testing.T) {
		host, port := closedLoopbackPort(t)

		ping, err := checkProxy(context.Background(), host, port, validSecret, 1)
		if err == nil {
			t.Fatalf("checkProxy against a closed port = %d, nil; want an error", ping)
		}
		if ping != 0 {
			t.Errorf("ping = %d, want 0 on failure", ping)
		}
	})

	t.Run("connection closed before handshake", func(t *testing.T) {
		host, port := listenLoopback(t, func(conn net.Conn) { _ = conn.Close() })

		ping, err := checkProxy(context.Background(), host, port, validSecret, 1)
		if err == nil {
			t.Fatalf("checkProxy against a hang-up listener = %d, nil; want an error", ping)
		}
		if ping != 0 {
			t.Errorf("ping = %d, want 0 on failure", ping)
		}
	})
}

// TestCheckProxyTimesOutOnStalledProxy is the reason for the timeoutSec
// argument: a proxy that completes the TCP connect and then goes silent must
// not hold the goroutine open. This is the innermost of the four timeout
// layers described in CLAUDE.md — the /check-stream hard context and the
// client-side abort sit outside it and are not exercised here.
func TestCheckProxyTimesOutOnStalledProxy(t *testing.T) {
	// Accept the connection and do nothing at all with it: no read, no write,
	// no close.
	host, port := listenLoopback(t, func(net.Conn) {})

	const timeoutSec = 1

	start := time.Now()
	ping, err := checkProxy(context.Background(), host, port, validSecret, timeoutSec)
	elapsed := time.Since(start)

	if err == nil {
		t.Fatalf("checkProxy against a stalled proxy = %d, nil; want an error", ping)
	}
	if ping != 0 {
		t.Errorf("ping = %d, want 0 on failure", ping)
	}
	// Below the lower bound the connection failed for some other reason and
	// the test is not measuring the timeout at all. Above the upper bound the
	// timeout is not the thing ending the call — note DialTimeout is 3s, so
	// this also catches the context being dropped somewhere.
	if elapsed < timeoutSec*time.Second {
		t.Errorf("returned after %v, before the %ds timeout could fire; "+
			"the failure is not the timeout", elapsed, timeoutSec)
	}
	if elapsed > 3*time.Second {
		t.Errorf("took %v to give up on a %ds timeout; the context is not bounding the call",
			elapsed, timeoutSec)
	}
}
