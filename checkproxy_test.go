// checkProxy tests, failure paths and success path both. None of this leaves
// the machine: every network test binds 127.0.0.1:0 and talks to a listener it
// owns, so the file needs no -short guard. The success path runs against a
// fake MTProxy standing in front of gotd's own fake MTProto server — see
// startFakeProxy. proxytest_test.go still exists for a handshake with real
// Telegram, which is a different question from "does the code work".
package main

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/hex"
	"io"
	"net"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-faster/errors"

	"github.com/gotd/td/crypto"
	"github.com/gotd/td/mtproxy/obfuscated2"
	"github.com/gotd/td/proto/codec"
	"github.com/gotd/td/session"
	"github.com/gotd/td/telegram"
	"github.com/gotd/td/tg"
	"github.com/gotd/td/tgtest"
	"github.com/gotd/td/tgtest/services/config"
	"github.com/gotd/td/transport"
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

	// gotd's Client.Run swallows context.Canceled on purpose — it is how the
	// client signals a normal shutdown once the callback returns — so without
	// the explicit checkCtx.Err() check in checkProxy this reports a working
	// proxy with a 0 ms ping. DeadlineExceeded is not affected, which is why
	// the stall test below passes either way.
	t.Run("context already cancelled", func(t *testing.T) {
		host, port := closedLoopbackPort(t)

		ctx, cancel := context.WithCancel(context.Background())
		cancel()

		start := time.Now()
		ping, err := checkProxy(ctx, host, port, validSecret, 1)
		elapsed := time.Since(start)

		if err == nil {
			t.Fatalf("checkProxy with a cancelled context = %d, nil; want an error", ping)
		}
		if ping != 0 {
			t.Errorf("ping = %d, want 0 on failure", ping)
		}
		// The caller's context has to reach the client: without it the call
		// would run to its own 1s timeout instead of returning immediately.
		if elapsed > 500*raceTimeoutFactor*time.Millisecond {
			t.Errorf("took %v to honour an already-cancelled context; want it to return at once", elapsed)
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
	if ceiling := 3 * raceTimeoutFactor * time.Second; elapsed > ceiling {
		t.Errorf("took %v to give up on a %ds timeout; the context is not bounding the call",
			elapsed, timeoutSec)
	}
}

// deobfuscatedConn is the connection the fake server reads MTProto off: the
// bytes are still framed by the underlying TCP conn, but they pass through the
// obfuscated2 stream cipher on the way in and out.
type deobfuscatedConn struct {
	net.Conn
	rw io.ReadWriter
}

func (c deobfuscatedConn) Read(b []byte) (int, error)  { return c.rw.Read(b) }
func (c deobfuscatedConn) Write(b []byte) (int, error) { return c.rw.Write(b) }

// mtproxyListener is the MTProxy half of the fake proxy: it strips the
// obfuscated2 layer the client's dcs.MTProxy resolver added, and hands the
// plain MTProto stream on to the transport listener behind it. Note the
// handshake read happens inside Accept, so connections are de-obfuscated one
// at a time — fine for a test that makes one or two.
type mtproxyListener struct {
	net.Listener
	secret []byte
}

func (l mtproxyListener) Accept() (net.Conn, error) {
	conn, err := l.Listener.Accept()
	if err != nil {
		return nil, err
	}
	rw, _, err := obfuscated2.Accept(conn, l.secret)
	if err != nil {
		return nil, errors.Wrap(err, "deobfuscate")
	}
	return deobfuscatedConn{Conn: conn, rw: rw}, nil
}

// startFakeProxy stands up an MTProxy that a real gotd client can complete a
// handshake with: gotd's own tgtest MTProto server, fronted by the obfuscated2
// layer an MTProxy adds. It returns the host and port to point checkProxy at.
//
// Two pieces of package state have to be borrowed for this, and both are put
// back by t.Cleanup:
//
//   - checkOptionsHook, to trust this server's RSA key instead of Telegram's
//     production key list, and to widen ExchangeTimeout. The production 2s is
//     a budget for a remote proxy; here the server's DH work competes with the
//     client for the same CPU, and the measured exchange already takes about a
//     second on a developer machine, which leaves no room on a CI runner. The
//     call is still bounded — by checkProxy's own timeoutSec context.
//   - sharedSession, because a successful check stores an auth key in it and
//     that key is meaningless to any other server. Leaving it behind would
//     hand a bogus key to the live test in proxytest_test.go.
//
// The client uses codec.PaddedIntermediate wrapped in codec.NoHeader, because
// that is what dcs.MTProxy picks for a Simple (16-byte) secret: the codec tag
// travels inside the obfuscated2 header instead of leading the stream.
func startFakeProxy(t *testing.T, secret []byte) (string, int) {
	t.Helper()

	key, err := rsa.GenerateKey(rand.Reader, crypto.RSAKeyBits)
	if err != nil {
		t.Fatalf("generate server key: %v", err)
	}

	// help.getConfig is not optional: gotd sends it as part of connection
	// setup, before the caller's own request, and an unanswered one kills the
	// connection before help.getNearestDC is ever sent.
	dispatcher := tgtest.NewDispatcher()
	cfg, cdnCfg := tg.Config{}, tg.CDNConfig{}
	config.NewService(&cfg, &cdnCfg).Register(dispatcher)
	dispatcher.Result(tg.HelpGetNearestDCRequestTypeID, &tg.NearestDC{
		Country:   "XX",
		ThisDC:    2,
		NearestDC: 2,
	})
	srv := tgtest.NewServer(tgtest.NewPrivateKey(key), tgtest.UnpackInvoke(dispatcher), tgtest.ServerOptions{})

	raw, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	addr := raw.Addr().(*net.TCPAddr)

	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		_ = srv.Serve(ctx, transport.ListenCodec(
			func() transport.Codec { return codec.NoHeader{Codec: codec.PaddedIntermediate{}} },
			mtproxyListener{Listener: raw, secret: secret},
		))
	}()

	prevHook, prevSession := checkOptionsHook, sharedSession
	checkOptionsHook = func(opts *telegram.Options) {
		opts.PublicKeys = []telegram.PublicKey{srv.Key()}
		opts.ExchangeTimeout = time.Minute
	}
	sharedSession = &session.StorageMemory{}

	t.Cleanup(func() {
		cancel()
		_ = raw.Close()
		checkOptionsHook, sharedSession = prevHook, prevSession
	})

	return addr.IP.String(), addr.Port
}

// TestCheckProxySucceedsAgainstAWorkingProxy is the one test that runs
// checkProxy all the way through a completed MTProto handshake without a live
// proxy. It is also the regression guard for the checkCtx.Err() check: get
// that wrong and a successful check starts reporting a context error.
func TestCheckProxySucceedsAgainstAWorkingProxy(t *testing.T) {
	secret, err := hex.DecodeString(validSecret)
	if err != nil {
		t.Fatalf("decode test secret: %v", err)
	}
	host, port := startFakeProxy(t, secret)

	// Generous on purpose: the fake server does its RSA and DH on the same CPU
	// as the client, and raceTimeoutFactor stretches it further because the
	// instrumented build ran past 20s on a loaded runner without ever reporting
	// a race — see race_test.go.
	const timeoutSec = 20 * raceTimeoutFactor

	ping, err := checkProxy(context.Background(), host, port, validSecret, timeoutSec)
	if err != nil {
		t.Fatalf("checkProxy against a working proxy: %v", err)
	}
	if ping < 0 || ping > timeoutSec*1000 {
		t.Errorf("ping = %dms, want a plausible round-trip inside the %ds timeout", ping, timeoutSec)
	}
	// Over loopback the ping is 0-3ms, so it cannot carry the assertion on its
	// own. The auth key can: a session only lands in storage after a completed
	// DH exchange, which is what says the handshake really ran rather than the
	// call returning nil for some other reason.
	if data, err := sharedSession.Bytes(nil); err != nil || len(data) == 0 {
		t.Errorf("shared session is empty after a successful check (%v); "+
			"no auth key was negotiated, so nothing here proves a handshake happened", err)
	}
}
