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
	"net/netip"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"runtime"
	"runtime/debug"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/go-faster/errors"
	"github.com/gotd/td/session"
	"github.com/gotd/td/telegram"
	"github.com/gotd/td/telegram/dcs"
	"golang.org/x/net/proxy"
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
	// ~233 KB. 1 MiB per source is far above anything plausible and is
	// enforced while reading, so an endless response is cut off, not buffered.
	//
	// maxSourceBytes alone bounds nothing useful: /fetch-sources buffers every
	// source whole until the last one lands, so the per-request ceiling is what
	// actually caps resident memory. maxSources sources at maxSourceBytes each
	// would be 20 MiB per request with nothing limiting how many requests run at
	// once, so the two limits are enforced together — maxRequestSourceBytes is a
	// budget the sources of one request share, and maxFetchSourcesInFlight caps
	// the number of requests holding one.
	maxSourceBytes        = 1024 * 1024
	maxRequestSourceBytes = 4 * 1024 * 1024
	// Every cap above is enforced on the response body. Headers are read and
	// parsed into the header map before the body is touched, so they escape all
	// of them: at the stdlib default of 10 MiB a source whose body is 2 bytes
	// still costs ~11.6 MiB resident, measured — 20 sources across 4 requests
	// in flight is ~880 MiB against the 16 MiB this design intends. A proxy
	// list's headers are a few hundred bytes; 64 KiB is far above any of them.
	maxSourceHeaderBytes    = 64 * 1024
	maxFetchSourcesInFlight = 4
	maxSources              = 20
	maxConcurrency          = 50
	defaultTimeout          = 5
	minTimeout              = 3
	maxTimeout              = 30
	tcpTimeout              = 1500 * time.Millisecond
	minTimeoutDuration      = time.Duration(minTimeout) * time.Second
	shutdownTimeout         = 5 * time.Second
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

// fetchSourcesSlots caps how many /fetch-sources requests hold source bodies in
// memory at once. Package-level and buffered, the same shape as the check
// endpoints' concurrency semaphore.
var fetchSourcesSlots = make(chan struct{}, maxFetchSourcesInFlight)

// The SSRF policy for /fetch-sources. The server fetches arbitrary URLs on
// request and HOST=0.0.0.0 is a supported deployment with no auth, so an
// unchecked source URL is a request-forgery primitive pointed at whatever the
// server can reach and the client cannot. sameOriginOnly keeps a page the user
// merely visited from driving this, but it is a browser control and stops
// nothing that sets its own headers — the policy below is what actually bounds
// where a fetch may go.
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

// blockedSourceNets is the destination denylist, written as CIDRs because the
// net.IP predicates alone leave real holes. IsPrivate covers 10/8, 172.16/12,
// 192.168/16 and fc00::/7 and nothing else, so without this list a source URL
// could reach:
//
//   - 100.64.0.0/10, the shared-address range. Tailscale gives every peer a
//     100.x address and puts MagicDNS on 100.100.100.100, and a user who needs
//     a proxy checker is exactly the user likely to be on a tailnet.
//   - ::/96, IPv4-compatible IPv6. ::127.0.0.1 is 16 bytes, so To4 returns nil
//     and IsLoopback is false. The whole range is deprecated; block it outright.
//   - 64:ff9b::/96 and 64:ff9b:1::/48, the NAT64 prefixes. On a NAT64 network
//     64:ff9b::7f00:1 is translated to 127.0.0.1 at the gateway, past every
//     check this process can make.
//   - 2002::/16 (6to4) and 2001::/32 (Teredo), which tunnel an embedded IPv4
//     address the check would otherwise never see.
//   - 198.18.0.0/15, 192.0.0.0/24, 240.0.0.0/4 and 255.255.255.255, none of
//     which a public proxy list is ever served from.
//
// v4-mapped addresses (::ffff:a.b.c.d) are normalized by Unmap before the match,
// so they are judged against the v4 rows rather than needing rows of their own —
// which is also why ::ffff:0:0/96 is deliberately absent: a row for it would
// block every mapped address, including legitimate public ones.
var blockedSourceNets = func() []netip.Prefix {
	raw := []string{
		"0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8",
		"169.254.0.0/16", "172.16.0.0/12", "192.0.0.0/24", "192.168.0.0/16",
		"198.18.0.0/15", "224.0.0.0/4", "240.0.0.0/4",
		"::/96", "64:ff9b::/96", "64:ff9b:1::/48", "100::/64",
		"2001::/32", "2002::/16", "fc00::/7", "fe80::/10", "fec0::/10",
		"ff00::/8",
	}
	nets := make([]netip.Prefix, 0, len(raw))
	for _, s := range raw {
		nets = append(nets, netip.MustParsePrefix(s))
	}
	return nets
}()

// blockedSourceIP reports whether ip is a destination no source fetch may
// reach: the machine itself, the ranges that carry cloud metadata services, and
// the private, shared and tunnelling networks behind it. The predicates are kept
// alongside the CIDR list rather than replaced by it — they cost nothing and
// they cover anything the list forgets.
func blockedSourceIP(ip net.IP) bool {
	if allowedSourceIP != nil && allowedSourceIP(ip) {
		return false
	}
	if ip.IsLoopback() || ip.IsPrivate() || ip.IsUnspecified() ||
		ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() ||
		ip.IsInterfaceLocalMulticast() || ip.IsMulticast() {
		return true
	}
	addr, ok := netip.AddrFromSlice(ip)
	if !ok {
		// Not 4 or 16 bytes: not an address this process can reason about.
		return true
	}
	addr = addr.Unmap()
	for _, prefix := range blockedSourceNets {
		if prefix.Contains(addr) {
			return true
		}
	}
	return false
}

// checkSourceURL enforces the scheme allowlist. Destinations are not checked
// here — a hostname says nothing about where it resolves — but at dial time,
// in sourceClient. Plain HTTP is allowed only when the fetch is routed through
// a SOCKS5 proxy, which is the one case where the bytes do not cross the
// server's own network in the clear.
func checkSourceURL(raw string, viaSOCKS5 bool) error {
	u, err := url.Parse(raw)
	if err != nil {
		return err
	}
	if u.Scheme == "https" || (u.Scheme == "http" && (viaSOCKS5 || allowPlainHTTPSources)) {
		return nil
	}
	return errors.Errorf("scheme %q is not allowed; https only, or http through SOCKS5", u.Scheme)
}

// checkSOCKS5Destination applies the destination policy to a fetch that will be
// routed through a proxy. There is no dial hook to hang it on there — the proxy
// resolves the name and makes the connection — so it runs before the proxy is
// dialled: a literal address is judged directly, and a name is judged whenever
// this machine can resolve it. A name only the proxy can resolve is left to the
// proxy, which is the case the feature exists for.
func checkSOCKS5Destination(address string) error {
	host, _, err := net.SplitHostPort(address)
	if err != nil {
		return err
	}
	if ip := net.ParseIP(host); ip != nil {
		if blockedSourceIP(ip) {
			return errors.Errorf("blocked destination %s", ip)
		}
		return nil
	}
	// Deliberately not cachedLookupHost: that cache is written by tcpCheck from a
	// hostname any /check caller supplies and holds it for five minutes whatever
	// the record's own TTL says, so reading it here would let a caller seed an
	// allowed answer and then repoint the name. The direct path has no such
	// window — its check is the dialer's Control hook, which sees the address
	// actually being dialled. This one has to buy the same freshness by
	// resolving now, which costs at most maxSources lookups per request.
	dnsCtx, dnsCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer dnsCancel()
	var resolver net.Resolver
	ipAddrs, err := resolver.LookupIPAddr(dnsCtx, host)
	if err != nil {
		return nil
	}
	for _, addr := range ipAddrs {
		if blockedSourceIP(addr.IP) {
			return errors.Errorf("blocked destination %s", addr.IP)
		}
	}
	return nil
}

// socks5Client builds the client for one request's SOCKS5 retries. The dialer
// that reaches the proxy itself carries no destination check: a proxy on
// 127.0.0.1 is the ordinary case (Tor, a local tunnel), so blocking loopback
// there would block the feature. What the proxy is asked to reach is checked
// instead, and before the proxy is dialled — including on every redirect hop,
// since each one dials again.
func socks5Client(cfg *SOCKS5Config) (*http.Client, error) {
	var auth *proxy.Auth
	if cfg.User != "" || cfg.Pass != "" {
		auth = &proxy.Auth{User: cfg.User, Password: cfg.Pass}
	}
	dialer, err := proxy.SOCKS5("tcp", cfg.Addr, auth, &net.Dialer{
		Timeout:   10 * time.Second,
		KeepAlive: 30 * time.Second,
	})
	if err != nil {
		return nil, err
	}
	ctxDialer, ok := dialer.(proxy.ContextDialer)
	if !ok {
		return nil, errors.New("socks5 dialer does not honour contexts")
	}

	return &http.Client{
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 10 {
				return errors.New("stopped after 10 redirects")
			}
			// A hop may not change the scheme. Without this an https source can
			// answer 302 Location: http://…, and because this leg accepts plain
			// HTTP the body then crosses everything past the proxy in the clear
			// — for Tor, the exit node — which is a list-rewriting position over
			// a URL the user believes is TLS-protected. http is allowed here
			// only for a URL the user typed that way.
			if req.URL.Scheme != via[0].URL.Scheme {
				return errors.Errorf("redirect changed scheme %q -> %q",
					via[0].URL.Scheme, req.URL.Scheme)
			}
			return checkSourceURL(req.URL.String(), true)
		},
		Transport: &http.Transport{
			// Headers are read whole into the header map before the body is
			// touched, so they are outside every byte cap below — see
			// maxSourceHeaderBytes.
			MaxResponseHeaderBytes: maxSourceHeaderBytes,
			DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
				if err := checkSOCKS5Destination(address); err != nil {
					return nil, err
				}
				return ctxDialer.DialContext(ctx, network, address)
			},
		},
	}, nil
}

// sourceClient is the direct client, tried first for every source. Its Control
// hook runs after DNS resolution and before the connection, which is both the
// resolve-then-check the policy calls for — no window between deciding and
// connecting, so a rebinding answer cannot slip through — and the redirect
// check: every hop dials again, so a redirect into a blocked range never
// connects. CheckRedirect covers the other half of a hop, its scheme.
var sourceClient = &http.Client{
	CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) >= 10 {
			return errors.New("stopped after 10 redirects")
		}
		return checkSourceURL(req.URL.String(), false)
	},
	Transport: &http.Transport{
		MaxResponseHeaderBytes: maxSourceHeaderBytes,
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

// SOCKS5Config is the optional proxy a /fetch-sources request may carry. An
// absent config — or an empty address — means direct-only.
type SOCKS5Config struct {
	Addr string `json:"addr"`
	User string `json:"user,omitempty"`
	Pass string `json:"pass,omitempty"`
}

type FetchSourcesRequest struct {
	URLs   []string      `json:"urls"`
	SOCKS5 *SOCKS5Config `json:"socks5,omitempty"`
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

// allowedHosts is the set of Host values sameOriginOnly accepts, built in main()
// from the address actually bound. Empty turns the check off — which is both the
// HOST=0.0.0.0 case and the state every test that does not install one runs in.
var allowedHosts map[string]struct{}

// hostAllowlist returns the Host values a browser can legitimately carry for a
// server bound to addr, or nil when there is nothing to pin.
//
// Only a loopback bind yields a list. A server on 0.0.0.0 or a LAN address is
// reached by names this process cannot know, so any set it invented would refuse
// the real page; that deployment is already the documented no-auth opt-in, where
// anyone routable can drive the endpoints headerless and rebinding buys an
// attacker nothing they could not do directly. Narrowing it further would need
// the operator to name the hosts, which is a config surface nobody has asked for.
//
// All three loopback spellings are listed regardless of which one addr used: the
// browser is opened at the bound address, but a user typing localhost into the
// bar reaches the same server and must not be refused.
//
// The bound address is listed too, and that is not covered by the three: 127/8 is
// loopback in its entirety, so HOST=127.0.0.2 binds, passes shouldOpenBrowser and
// has a browser opened at it -- and without its own entry every POST from that
// page 403s, with the map non-empty so the WARNING line stays silent as well.
// Lowercased because sameOriginOnly lowercases the Host it compares.
//
// The entries carry no port, and the bound one is deliberately not pinned. The
// port in Host is the one the browser was told to connect to, which is not the
// bound one behind `ssh -L 8080:127.0.0.1:3000`, `docker run -p` or any other
// forward, and is absent entirely when the bound port is the scheme default
// (PORT=80). Pinning it refused the real page in all three cases while buying
// nothing: what the check has to refuse is a rebound *name*, and evil.test is
// not a loopback name at any port. The port is still load-bearing in the Origin
// arm below, which compares against the whole of r.Host.
func hostAllowlist(addr string) map[string]struct{} {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return nil
	}
	if ip := net.ParseIP(host); host != "localhost" && (ip == nil || !ip.IsLoopback()) {
		return nil
	}
	allowed := make(map[string]struct{}, 4)
	allowed[strings.ToLower(host)] = struct{}{}
	for _, h := range []string{"127.0.0.1", "localhost", "::1"} {
		allowed[h] = struct{}{}
	}
	return allowed
}

// hostWithoutPort reduces an HTTP Host to the name hostAllowlist holds: the
// port dropped when there is one, the brackets dropped from an IPv6 literal
// whether or not a port followed it. SplitHostPort is the only thing that can
// tell `[::1]:3000` from `::1`, and it fails on both bracketless and portless
// spellings, so its error is the signal to trim rather than a problem.
func hostWithoutPort(host string) string {
	if h, _, err := net.SplitHostPort(host); err == nil {
		return h
	}
	return strings.TrimSuffix(strings.TrimPrefix(host, "["), "]")
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

// fetchSource retrieves one source's raw text. The direct client is tried
// first; when it fails and the request configured a proxy, the same URL is
// retried through it — which is also the only way a plain-HTTP source is ever
// fetched. Each attempt carries its own deadline, so one source can cost up to
// two sourceTimeouts.
//
// The retry re-applies the whole policy rather than inheriting the direct
// attempt's verdict: checkSourceURL runs again with viaSOCKS5 set, which is what
// admits http://, and checkSOCKS5Destination re-checks the destination before
// the proxy is dialled. A retry is cheap when it cannot succeed — a scheme the
// SOCKS5 leg also rejects fails inside fetchVia before anything is dialled — so
// no attempt is made to predict which failures are worth retrying.
func fetchSource(ctx context.Context, socks *http.Client, url string, budget *byteBudget) (string, error) {
	text, err := fetchVia(ctx, sourceClient, url, false, budget)
	if err == nil || socks == nil {
		return text, err
	}
	log.Printf("SOURCE DIRECT FAIL %q: %v — retrying through SOCKS5", url, err)
	return fetchVia(ctx, socks, url, true, budget)
}

// byteBudget is the total a request's sources may read between them, spent as
// the bodies arrive rather than reserved up front — reserving would hand the
// whole budget to whichever sources started first and starve the rest.
//
// take never spends more than is left, so the budget cannot go negative and a
// request cannot hold more than its ceiling. Overshoot is one Read buffer per
// concurrent source, since a source learns it is out of budget only after the
// copy that exhausted it.
type byteBudget struct{ left atomic.Int64 }

func newByteBudget(n int64) *byteBudget {
	b := &byteBudget{}
	b.left.Store(n)
	return b
}

func (b *byteBudget) take(n int64) bool {
	for {
		left := b.left.Load()
		if left < n {
			return false
		}
		if b.left.CompareAndSwap(left, left-n) {
			return true
		}
	}
}

// budgetReader charges every byte read to the shared budget and fails the read
// once it is gone, so an oversized set of sources is cut off mid-body the same
// way a single oversized source is.
type budgetReader struct {
	r io.Reader
	b *byteBudget
}

func (br *budgetReader) Read(p []byte) (int, error) {
	n, err := br.r.Read(p)
	if n > 0 && !br.b.take(int64(n)) {
		return 0, errors.Errorf("request exceeds its %d byte source budget", maxRequestSourceBytes)
	}
	return n, err
}

// fetchVia performs one attempt under its own deadline. The body is read
// through a LimitReader one byte past the per-source cap and through the
// request's shared budget, so neither one oversized source nor twenty ordinary
// ones can be buffered past the ceiling — an endless response is cut off
// mid-read rather than held whole.
//
// The URL clears the scheme allowlist before anything is dialled, and the
// client rejects the destination itself: after resolution for sourceClient, and
// before the proxy is dialled for a SOCKS5 client.
func fetchVia(ctx context.Context, client *http.Client, url string, viaSOCKS5 bool, budget *byteBudget) (string, error) {
	if err := checkSourceURL(url, viaSOCKS5); err != nil {
		return "", err
	}

	reqCtx, cancel := context.WithTimeout(ctx, sourceTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, url, nil)
	if err != nil {
		return "", err
	}
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return "", errors.Errorf("HTTP %d", resp.StatusCode)
	}

	body, err := io.ReadAll(&budgetReader{
		r: io.LimitReader(resp.Body, maxSourceBytes+1),
		b: budget,
	})
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

// sameOriginOnly refuses a POST that a browser labelled as coming from another
// site. It is a browser control and not authentication — anything that sets its
// own headers walks straight past it, and it must never be counted as a reason
// this server does not need auth.
//
// It exists because every endpoint here acts on its body, and Content-Type:
// text/plain is CORS-safelisted: a plain HTML form on any page the user visits
// reaches them with no preflight and no JavaScript, and the bytes an
// enctype=text/plain form emits are valid JSON, because the = separator lands
// inside a string value. The response stays unreadable cross-origin, but the
// side effect fires and its timing is readable — which turns /fetch-sources'
// caller-supplied socks5.addr into a three-state port-scan oracle over the
// victim's loopback and LAN. That address is left unchecked on the reasoning
// that it is the user's own Tor or tunnel; this is what keeps that true.
//
// Both headers are optional and an absent pair is allowed, deliberately: curl
// and every script against the documented POST /check API send neither, while
// browsers send Sec-Fetch-Site on every request. same-site is rejected along
// with cross-site — a sibling subdomain is not this origin.
//
// The Host check comes first and is not decoration. The Origin comparison below
// reads r.Host, which is whatever the browser was told to ask for, so on its own
// it is satisfiable by DNS rebinding: a page served from evil.test:3000 whose
// name is then repointed at 127.0.0.1 sends Host: evil.test:3000, a matching
// Origin and Sec-Fetch-Site: same-origin. Both arms would pass, and the browser
// would treat the responses as same-origin and let the attacker read them —
// turning /check into an accurate port scanner of the victim's loopback and LAN
// and handing /fetch-sources' bodies back. Pinning Host to the address actually
// bound is what makes the Origin comparison mean anything.
func sameOriginOnly(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if len(allowedHosts) > 0 {
			if _, ok := allowedHosts[strings.ToLower(hostWithoutPort(r.Host))]; !ok {
				jsonResponse(w, http.StatusForbidden, map[string]string{"error": "unexpected Host"})
				return
			}
		}
		switch r.Header.Get("Sec-Fetch-Site") {
		case "", "same-origin", "none":
		default:
			jsonResponse(w, http.StatusForbidden, map[string]string{"error": "cross-origin request rejected"})
			return
		}
		if origin := r.Header.Get("Origin"); origin != "" &&
			origin != "http://"+r.Host && origin != "https://"+r.Host {
			jsonResponse(w, http.StatusForbidden, map[string]string{"error": "cross-origin request rejected"})
			return
		}
		next(w, r)
	}
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

// staticHeaders stamps the embedded page with the headers a browser needs to
// refuse the two things sameOriginOnly cannot.
//
// Framing is the load-bearing one. The guard refuses a POST the browser labelled
// cross-origin, but a page framed in an attacker's site keeps *this* origin: its
// fetches carry Sec-Fetch-Site: same-origin, a matching Origin and a matching
// Host, so every arm of the guard passes them. An overlay over the real page
// therefore reaches Load-list, Start and restore-defaults — routing around the
// guard by borrowing the page it protects rather than by defeating it.
// X-Frame-Options is there for browsers predating frame-ancestors.
//
// The policy deliberately carries no script-src: the paint bootstrap in <head>
// is inline, so a script policy needs a nonce or a hash, which is a change to
// index.html and its boot test — worth doing, separately.
func staticHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Security-Policy", "frame-ancestors 'none'")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		next.ServeHTTP(w, r)
	})
}

// newMux wires the three endpoints and the embedded static files. Split out of
// main() so handlers_test.go can drive them with httptest instead of a live
// listener; main() adds nothing but the server, signals and browser launch.
func newMux() *http.ServeMux {
	mux := http.NewServeMux()

	mux.HandleFunc("/check", recoverMiddleware(sameOriginOnly(func(w http.ResponseWriter, r *http.Request) {
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
	})))

	mux.HandleFunc("/check-batch", recoverMiddleware(sameOriginOnly(func(w http.ResponseWriter, r *http.Request) {
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
	})))

	mux.HandleFunc("/check-stream", recoverMiddleware(sameOriginOnly(func(w http.ResponseWriter, r *http.Request) {
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
	})))

	mux.HandleFunc("/fetch-sources", recoverMiddleware(sameOriginOnly(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}

		// Every other endpoint on this server is bounded — the check handlers by
		// the X-Concurrency semaphore, the SSE writer by streaming rather than
		// buffering. This one holds its sources in memory until the last of them
		// lands, so without a cap on requests in flight the per-request budget
		// below would multiply by however many callers show up at once. Waiting
		// rather than refusing: the UI issues these one after another, and a
		// caller that gives up takes its slot request with it.
		select {
		case fetchSourcesSlots <- struct{}{}:
			defer func() { <-fetchSourcesSlots }()
		case <-r.Context().Done():
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

		// One proxy client for the whole request, shared by every source's
		// retry. An empty address is the same as no proxy at all.
		var socks *http.Client
		if req.SOCKS5 != nil && req.SOCKS5.Addr != "" {
			client, err := socks5Client(req.SOCKS5)
			if err != nil {
				jsonResponse(w, http.StatusBadRequest,
					map[string]string{"error": fmt.Sprintf("invalid socks5 proxy: %v", err)})
				return
			}
			socks = client
			defer socks.CloseIdleConnections()
		}

		// Fetched concurrently, concatenated by index: the output order is the
		// request order regardless of which source answers first. A failed
		// source contributes nothing and aborts nothing.
		texts := make([]string, len(req.URLs))
		budget := newByteBudget(maxRequestSourceBytes)
		var wg sync.WaitGroup
		for i, u := range req.URLs {
			wg.Add(1)
			go func(idx int, url string) {
				defer wg.Done()
				text, err := fetchSource(r.Context(), socks, url, budget)
				if err != nil {
					// %q, not %s: the URL is caller-supplied, and a raw newline
					// in it would forge a log line.
					log.Printf("SOURCE FAIL %q: %v", url, err)
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
	})))

	embeddedFS, err := fs.Sub(publicFS, "public")
	if err != nil {
		log.Fatalf("Failed to embed public directory: %v", err)
	}
	mux.Handle("/", staticHeaders(http.FileServer(http.FS(embeddedFS))))

	return mux
}

func main() {
	mux := newMux()

	addr := resolveAddr(os.Getenv("HOST"), os.Getenv("PORT"))
	log.Printf("MTProto Checker %s", version)
	log.Printf("Server running at http://%s", addr)

	// Said out loud rather than left to be inferred: on a non-loopback bind the
	// allowlist is empty, so sameOriginOnly's Host check is off and a rebound
	// name satisfies its Origin comparison.
	allowedHosts = hostAllowlist(addr)
	if len(allowedHosts) == 0 {
		log.Printf("WARNING: %s is not loopback — the Host check is off and there is no auth", addr)
	}

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
