// The two batch endpoints' fan-out, driven through the real mux. Every proxy
// here is a loopback port this test owns — either one nothing is listening on,
// which fails tcpCheck instantly and issues no DNS query, or a listener that
// hangs up on first contact — so the file is hermetic like the rest and carries
// no -short guard. That is the point: CI's race step runs -short, and until
// this file existed the only endpoint the UI actually calls was executed by no
// Go test at all, under -race or otherwise.
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"
)

// sseFrame is one `event: …\ndata: …` block off a /check-stream response.
type sseFrame struct {
	event string
	data  string
}

// parseSSE splits a recorded stream into its frames. Deliberately strict: a
// frame that does not carry both lines is a protocol break, not something to
// skip past.
func parseSSE(t *testing.T, body string) []sseFrame {
	t.Helper()

	var frames []sseFrame
	for _, block := range strings.Split(strings.TrimSuffix(body, "\n\n"), "\n\n") {
		if block == "" {
			continue
		}
		lines := strings.SplitN(block, "\n", 2)
		if len(lines) != 2 || !strings.HasPrefix(lines[0], "event: ") || !strings.HasPrefix(lines[1], "data: ") {
			t.Fatalf("malformed SSE frame %q in %q", block, body)
		}
		frames = append(frames, sseFrame{
			event: strings.TrimPrefix(lines[0], "event: "),
			data:  strings.TrimPrefix(lines[1], "data: "),
		})
	}
	return frames
}

type streamProgress struct {
	Completed int    `json:"completed"`
	Total     int    `json:"total"`
	Working   int    `json:"working"`
	Server    string `json:"server"`
	Port      int    `json:"port"`
	Secret    string `json:"secret"`
	OK        bool   `json:"ok"`
	Ping      int64  `json:"ping,omitempty"`
}

// checkBody marshals a proxy list for either batch endpoint.
func checkBody(t *testing.T, reqs []CheckRequest) string {
	t.Helper()
	body, err := json.Marshal(reqs)
	if err != nil {
		t.Fatalf("marshal request: %v", err)
	}
	return string(body)
}

// deadProxies returns n proxies pointing at loopback ports nothing is listening
// on. tcpCheck fails on each without a DNS query and without leaving the
// machine, which is what makes a fan-out test of any size cost nothing.
func deadProxies(t *testing.T, n int) []CheckRequest {
	t.Helper()

	reqs := make([]CheckRequest, n)
	for i := range reqs {
		host, port := closedLoopbackPort(t)
		reqs[i] = CheckRequest{Server: host, Port: port, Secret: validSecret, Timeout: minTimeout}
	}
	return reqs
}

// TestCheckStreamStreamsEveryProxyAndTerminates is the endpoint the UI actually
// calls, end to end for the first time: every proxy in the body produces
// exactly one progress event, the stream terminates with `done`, and the
// counters are consistent throughout.
//
// The `completed` sequence is the assertion that covers the mu-serialized
// writes. Each goroutine increments the counter and writes its frame under the
// same lock, so the numbers a reader sees must be 1, 2, … n in order however
// the checks interleave — a write that escaped the lock would show up here as a
// repeat or a gap.
func TestCheckStreamStreamsEveryProxyAndTerminates(t *testing.T) {
	const n = 8
	reqs := deadProxies(t, n)

	rec := post(t, "/check-stream", checkBody(t, reqs))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "text/event-stream" {
		t.Errorf("Content-Type = %q, want text/event-stream", ct)
	}

	frames := parseSSE(t, rec.Body.String())
	if len(frames) != n+2 {
		t.Fatalf("got %d frames, want %d — one opening progress, %d results and one done", len(frames), n+2, n)
	}
	if last := frames[len(frames)-1]; last.event != "done" {
		t.Fatalf("last frame is %q, want the terminating done", last.event)
	}

	var opening streamProgress
	if err := json.Unmarshal([]byte(frames[0].data), &opening); err != nil {
		t.Fatalf("opening frame: %v", err)
	}
	if opening.Completed != 0 || opening.Total != n {
		t.Errorf("opening progress = %+v, want completed 0 of %d", opening, n)
	}

	seen := map[string]bool{}
	for i, frame := range frames[1 : len(frames)-1] {
		if frame.event != "progress" {
			t.Fatalf("frame %d is %q, want progress", i+1, frame.event)
		}
		var p streamProgress
		if err := json.Unmarshal([]byte(frame.data), &p); err != nil {
			t.Fatalf("frame %d: %v", i+1, err)
		}
		if p.Completed != i+1 {
			t.Errorf("frame %d reports completed=%d, want %d — the counter and the write share one lock", i+1, p.Completed, i+1)
		}
		if p.Total != n || p.Working != 0 {
			t.Errorf("frame %d = %+v, want total %d and no working proxy", i+1, p, n)
		}
		if p.OK {
			t.Errorf("frame %d says a closed port answered", i+1)
		}
		seen[fmt.Sprintf("%s:%d:%s", p.Server, p.Port, p.Secret)] = true
	}

	for _, req := range reqs {
		if key := fmt.Sprintf("%s:%d:%s", req.Server, req.Port, req.Secret); !seen[key] {
			t.Errorf("no result for %s — every proxy in the body must be reported", key)
		}
	}

	var done map[string]int
	if err := json.Unmarshal([]byte(frames[len(frames)-1].data), &done); err != nil {
		t.Fatalf("done frame: %v", err)
	}
	if done["total"] != n || done["working"] != 0 {
		t.Errorf("done = %v, want total %d and 0 working", done, n)
	}
}

// The clamp both batch endpoints run their semaphore off. It was twelve
// duplicated lines inside two handler literals, reachable from no test, and the
// UI asserts its own side of it in tests/unit/lifecycle.test.js — which proves
// what the browser sends, not what the server does with it.
func TestConcurrencyLimitClampsTheHeader(t *testing.T) {
	for _, tc := range []struct {
		header string
		want   int
		why    string
	}{
		{"", 10, "absent: the server's own fallback, which is not the UI's default of 50"},
		{"1", 1, "the floor is usable"},
		{"25", 25, "an ordinary value passes through"},
		{fmt.Sprint(maxConcurrency), maxConcurrency, "the ceiling itself is allowed"},
		{"999", maxConcurrency, "above the ceiling clamps down"},
		{"0", 1, "zero would be a semaphore nothing can enter"},
		{"-4", 1, "negative is the same question"},
		{"abc", 10, "unparseable: Sscanf's error is ignored, so the fallback stands"},
	} {
		h := http.Header{}
		if tc.header != "" {
			h.Set("X-Concurrency", tc.header)
		}
		if got := concurrencyLimit(h); got != tc.want {
			t.Errorf("concurrencyLimit(X-Concurrency: %q) = %d, want %d — %s", tc.header, got, tc.want, tc.why)
		}
	}
}

// hangUpProxy is a loopback listener that reads at most one byte from each
// connection, records whether anything arrived, and hangs up. A tcpCheck dials
// and closes without sending, so it lands as "tcp"; checkProxy opens with the
// obfuscated2 header, so it lands as "mtproto" and then fails fast on the close.
//
// One listener serves every proxy in the test, which is what makes the recorded
// order the real order: connections are accepted and classified in a single
// loop, so nothing about it depends on how two accept goroutines interleave.
func hangUpProxy(t *testing.T) (host string, port int, kinds func() []string) {
	t.Helper()

	var (
		mu   sync.Mutex
		seen []string
	)

	host, port = listenLoopback(t, func(conn net.Conn) {
		// A backstop only: both sides of this test either send immediately or
		// close immediately.
		_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
		var buf [1]byte
		_, err := io.ReadFull(conn, buf[:])
		_ = conn.Close()

		kind := "mtproto"
		if err != nil {
			kind = "tcp"
		}
		mu.Lock()
		seen = append(seen, kind)
		mu.Unlock()
	})

	return host, port, func() []string {
		mu.Lock()
		defer mu.Unlock()
		return append([]string(nil), seen...)
	}
}

// /check-batch runs in two strict phases with a barrier between them: every TCP
// pre-check finishes before the first MTProto check starts. It is not a detail
// of how the code reads — deleting tcpWg.Wait() leaves the second loop ranging
// over a `reachable` slice still being appended to, which is both a data race
// and, in practice, an empty list: nothing is checked at all and every proxy is
// reported dead.
//
// Both proxies point at one listener, so the order it records is the order the
// connections happened in. Two byte-less connections before anything carrying a
// handshake is the barrier; at least one handshake afterwards is phase 2 having
// run at all.
func TestCheckBatchFinishesEveryTCPCheckBeforeMTProto(t *testing.T) {
	host, port, kinds := hangUpProxy(t)

	reqs := []CheckRequest{
		{Server: host, Port: port, Secret: validSecret, Timeout: minTimeout},
		{Server: host, Port: port, Secret: validSecret, Timeout: minTimeout},
	}
	rec := post(t, "/check-batch", checkBody(t, reqs))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var results []CheckResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &results); err != nil {
		t.Fatalf("body is not JSON: %v (%q)", err, rec.Body.String())
	}
	if len(results) != len(reqs) {
		t.Fatalf("got %d results, want one per proxy", len(results))
	}

	got := kinds()
	if len(got) < 3 {
		t.Fatalf("connections = %v, want two TCP pre-checks and at least one handshake", got)
	}
	if got[0] != "tcp" || got[1] != "tcp" {
		t.Errorf("connections = %v, want both TCP pre-checks before any handshake", got)
	}
	handshakes := 0
	for _, kind := range got {
		if kind == "mtproto" {
			handshakes++
		}
	}
	if handshakes == 0 {
		t.Errorf("connections = %v, want phase 2 to have run for a reachable proxy", got)
	}
}

// The same listener under /check-stream, which has no barrier by design: each
// proxy runs its TCP check and its handshake inline, in one goroutine. What
// this pins is that a reachable proxy reaches phase 2 at all, and that a
// handshake against a server that hangs up is still reported as one result and
// not as a hang.
func TestCheckStreamRunsTheHandshakeInlineForAReachableProxy(t *testing.T) {
	host, port, kinds := hangUpProxy(t)

	reqs := []CheckRequest{{Server: host, Port: port, Secret: validSecret, Timeout: minTimeout}}
	rec := post(t, "/check-stream", checkBody(t, reqs))

	frames := parseSSE(t, rec.Body.String())
	if len(frames) != 3 {
		t.Fatalf("got %d frames, want an opening progress, one result and done", len(frames))
	}

	var p streamProgress
	if err := json.Unmarshal([]byte(frames[1].data), &p); err != nil {
		t.Fatalf("result frame: %v", err)
	}
	if p.OK || p.Completed != 1 || p.Total != 1 {
		t.Errorf("result = %+v, want one completed failure", p)
	}

	got := kinds()
	if len(got) < 2 || got[0] != "tcp" {
		t.Fatalf("connections = %v, want the TCP pre-check first", got)
	}
	if got[1] != "mtproto" {
		t.Errorf("connections = %v, want the handshake to follow it on the same goroutine", got)
	}
}
