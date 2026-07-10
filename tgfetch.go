package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"html"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/go-faster/errors"
	"github.com/gotd/td/session"
	"github.com/gotd/td/telegram"
	"github.com/gotd/td/telegram/auth"
	"github.com/gotd/td/telegram/dcs"
	"github.com/gotd/td/telegram/downloader"
	"github.com/gotd/td/tg"
	"github.com/gotd/td/tgerr"
)

// ----------------------------------------------------------------------------
// Secure local storage for Telegram user credentials.
//
// The session (auth keys that grant access to the user account) and the
// api_id/api_hash are stored ONLY under the OS user-config directory
// (e.g. ~/.config/mtproto-checker on Linux), which lives entirely outside the
// project tree — it can never be committed to git. Files are created with 0600
// and the directory with 0700 so only the owning user can read them.
// ----------------------------------------------------------------------------

const (
	perChannelMax     = 1000    // hard cap on proxies taken per channel
	historyPageSize   = 100     // Telegram's max messages per getHistory call
	maxScanMessages   = 15000   // safety cap on messages paged through per channel
	maxDocsPerChannel = 30      // text attachments downloaded+parsed per channel
	maxDocBytes       = 4 << 20 // skip attachments larger than 4 MiB
	tgFetchTimeout    = 280 * time.Second
)

// tgConfigDir returns the per-user directory holding the session and app
// credentials, creating it with owner-only permissions if needed.
func tgConfigDir() (string, error) {
	base, err := os.UserConfigDir()
	if err != nil {
		// Fall back to the home directory if UserConfigDir is unavailable.
		home, herr := os.UserHomeDir()
		if herr != nil {
			return "", errors.Wrap(err, "locate user config dir")
		}
		base = filepath.Join(home, ".config")
	}
	dir := filepath.Join(base, "mtproto-checker")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", errors.Wrap(err, "create config dir")
	}
	// Tighten perms in case the dir already existed with looser bits.
	_ = os.Chmod(dir, 0o700)
	return dir, nil
}

func sessionFilePath() (string, error) {
	dir, err := tgConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "session.json"), nil
}

func appConfigPath() (string, error) {
	dir, err := tgConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "app.json"), nil
}

type tgAppConfig struct {
	AppID   int    `json:"app_id"`
	AppHash string `json:"app_hash"`
}

// loadAppCreds resolves the api_id/api_hash to use. Priority:
//  1. TG_APP_ID + TG_APP_HASH environment variables
//  2. the locally saved app.json
//  3. the built-in public test credentials (fallback)
func loadAppCreds() (int, string) {
	if idStr := os.Getenv("TG_APP_ID"); idStr != "" {
		if hash := os.Getenv("TG_APP_HASH"); hash != "" {
			if id, err := strconv.Atoi(idStr); err == nil {
				return id, hash
			}
		}
	}
	if path, err := appConfigPath(); err == nil {
		if data, err := os.ReadFile(path); err == nil {
			var cfg tgAppConfig
			if json.Unmarshal(data, &cfg) == nil && cfg.AppID != 0 && cfg.AppHash != "" {
				return cfg.AppID, cfg.AppHash
			}
		}
	}
	return testAppID, testAppHash
}

func saveAppCreds(id int, hash string) error {
	path, err := appConfigPath()
	if err != nil {
		return err
	}
	data, err := json.Marshal(tgAppConfig{AppID: id, AppHash: hash})
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o600)
}

// ----------------------------------------------------------------------------
// MTProxy transport shared by check / login / fetch.
// ----------------------------------------------------------------------------

// buildMTProxyResolver creates a gotd DC resolver that tunnels through an
// MTProto proxy. When no proxy is supplied (all three fields empty) it returns
// a nil resolver, which makes gotd connect to Telegram directly — useful when
// the user already has unfiltered access (VPN, no censorship) and just wants to
// pull proxies from channels without first having a working proxy in hand.
func buildMTProxyResolver(server string, port int, secret string) (dcs.Resolver, error) {
	if server == "" && port == 0 && secret == "" {
		return nil, nil // direct connection
	}
	if server == "" || port == 0 || secret == "" {
		return nil, errors.New("incomplete MTProto proxy: server, port and secret are all required")
	}
	addr := net.JoinHostPort(server, fmt.Sprintf("%d", port))
	decodedSecret, err := decodeSecret(secret)
	if err != nil {
		return nil, errors.Wrap(err, "decode secret")
	}
	resolver, err := dcs.MTProxy(addr, decodedSecret, dcs.MTProxyOptions{})
	if err != nil {
		return nil, errors.Wrap(err, "create MTProxy resolver")
	}
	return resolver, nil
}

func newSessionStorage() (session.Storage, error) {
	path, err := sessionFilePath()
	if err != nil {
		return nil, err
	}
	return &session.FileStorage{Path: path}, nil
}

// ----------------------------------------------------------------------------
// Login manager: bridges the blocking gotd auth flow to stateless HTTP calls.
// ----------------------------------------------------------------------------

type ProxyCreds struct {
	Server string `json:"server"`
	Port   int    `json:"port"`
	Secret string `json:"secret"`
}

type loginManager struct {
	mu        sync.Mutex
	state     string // idle, starting, awaiting_captcha, awaiting_code, awaiting_password, authorized, failed
	errMsg    string
	phone     string
	sitekey   string // reCAPTCHA site key, set when state == awaiting_captcha
	codeCh    chan string
	pwdCh     chan string
	captchaCh chan string
	cancel    context.CancelFunc
}

var loginMgr = &loginManager{state: "idle"}

func (m *loginManager) snapshot() (state, errMsg, phone, sitekey string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.state, m.errMsg, m.phone, m.sitekey
}

func (m *loginManager) setState(state string) {
	m.mu.Lock()
	m.state = state
	m.mu.Unlock()
}

func (m *loginManager) fail(err error) {
	m.mu.Lock()
	m.state = "failed"
	m.errMsg = err.Error()
	m.mu.Unlock()
}

// recaptchaSitekey extracts the reCAPTCHA site key from a Telegram
// RECAPTCHA_CHECK error. Telegram returns these as
// "RECAPTCHA_CHECK_<purpose>__<sitekey>" (e.g. the purpose is "signup" or
// "login"); the site key is everything after the final "__".
func recaptchaSitekey(err error) (string, bool) {
	rpcErr, ok := tgerr.As(err)
	if !ok {
		return "", false
	}
	idx := strings.Index(rpcErr.Message, "RECAPTCHA_CHECK")
	if idx < 0 {
		return "", false
	}
	parts := strings.SplitN(rpcErr.Message[idx:], "__", 2)
	if len(parts) != 2 || parts[1] == "" {
		return "", false
	}
	return parts[1], true
}

// start kicks off a login. It returns immediately; progress is observed via
// snapshot() / the /tg/login/status endpoint.
func (m *loginManager) start(creds ProxyCreds, phone string, appID int, appHash string) error {
	m.mu.Lock()
	switch m.state {
	case "starting", "awaiting_captcha", "awaiting_code", "awaiting_password":
		m.mu.Unlock()
		return errors.New("a login is already in progress")
	}
	m.state = "starting"
	m.errMsg = ""
	m.phone = phone
	m.sitekey = ""
	m.codeCh = make(chan string, 1)
	m.pwdCh = make(chan string, 1)
	m.captchaCh = make(chan string, 1)
	ctx, cancel := context.WithCancel(context.Background())
	m.cancel = cancel
	m.mu.Unlock()

	resolver, err := buildMTProxyResolver(creds.Server, creds.Port, creds.Secret)
	if err != nil {
		cancel()
		m.fail(err)
		return err
	}
	storage, err := newSessionStorage()
	if err != nil {
		cancel()
		m.fail(err)
		return err
	}

	client := telegram.NewClient(appID, appHash, telegram.Options{
		Resolver:       resolver,
		SessionStorage: storage,
		Device:         telegram.DeviceTDesktopWindows(),
		NoUpdates:      true,
	})

	go func() {
		defer cancel()
		runErr := client.Run(ctx, func(ctx context.Context) error {
			return m.runAuth(ctx, client, phone, appID, appHash)
		})
		if runErr != nil {
			m.fail(runErr)
			return
		}
		m.setState("authorized")
	}()
	return nil
}

// runAuth drives the user authentication flow manually so that a reCAPTCHA
// challenge on send-code can be surfaced to the UI and retried with the solved
// token (via invokeWithReCaptcha). The rest of the flow (code, optional 2FA
// password) does not require a captcha.
func (m *loginManager) runAuth(ctx context.Context, client *telegram.Client, phone string, appID int, appHash string) error {
	authClient := client.Auth()

	sent, err := authClient.SendCode(ctx, phone, auth.SendCodeOptions{})
	if err != nil {
		sitekey, ok := recaptchaSitekey(err)
		if !ok {
			return err
		}
		// Surface the site key and wait for the browser-solved token.
		m.mu.Lock()
		m.sitekey = sitekey
		m.state = "awaiting_captcha"
		m.mu.Unlock()

		var token string
		select {
		case token = <-m.captchaCh:
		case <-ctx.Done():
			return ctx.Err()
		}

		// Retry the exact same send-code request, wrapped with the token.
		req := &tg.AuthSendCodeRequest{
			PhoneNumber: phone,
			APIID:       appID,
			APIHash:     appHash,
			Settings:    tg.CodeSettings{},
		}
		var box tg.AuthSentCodeBox
		if err := client.Invoke(ctx, &tg.InvokeWithReCaptchaRequest{Token: token, Query: req}, &box); err != nil {
			return err
		}
		sent = box.SentCode
	}

	sc, ok := sent.(*tg.AuthSentCode)
	if !ok {
		return errors.Errorf("unexpected sent code type %T", sent)
	}
	codeHash := sc.PhoneCodeHash

	// Await the login code from the UI.
	m.setState("awaiting_code")
	var code string
	select {
	case code = <-m.codeCh:
	case <-ctx.Done():
		return ctx.Err()
	}

	_, err = authClient.SignIn(ctx, phone, code, codeHash)
	if errors.Is(err, auth.ErrPasswordAuthNeeded) {
		// 2FA: await the password from the UI.
		m.setState("awaiting_password")
		var pwd string
		select {
		case pwd = <-m.pwdCh:
		case <-ctx.Done():
			return ctx.Err()
		}
		if pwd == "" {
			return auth.ErrPasswordNotProvided
		}
		if _, err = authClient.Password(ctx, pwd); err != nil {
			return err
		}
		return nil
	}
	return err
}

func (m *loginManager) submitCaptcha(token string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.state != "awaiting_captcha" {
		return errors.Errorf("not awaiting a captcha (state: %s)", m.state)
	}
	select {
	case m.captchaCh <- token:
		return nil
	default:
		return errors.New("captcha already submitted")
	}
}

func (m *loginManager) submitCode(code string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.state != "awaiting_code" {
		return errors.Errorf("not awaiting a code (state: %s)", m.state)
	}
	select {
	case m.codeCh <- code:
		return nil
	default:
		return errors.New("code already submitted")
	}
}

func (m *loginManager) submitPassword(pwd string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.state != "awaiting_password" {
		return errors.Errorf("not awaiting a password (state: %s)", m.state)
	}
	select {
	case m.pwdCh <- pwd:
		return nil
	default:
		return errors.New("password already submitted")
	}
}

// isAuthorized opens a short-lived client to verify the stored session is
// still valid and authorized.
func isAuthorized(ctx context.Context, creds ProxyCreds) (bool, error) {
	resolver, err := buildMTProxyResolver(creds.Server, creds.Port, creds.Secret)
	if err != nil {
		return false, err
	}
	storage, err := newSessionStorage()
	if err != nil {
		return false, err
	}
	appID, appHash := loadAppCreds()
	client := telegram.NewClient(appID, appHash, telegram.Options{
		Resolver:       resolver,
		SessionStorage: storage,
		Device:         telegram.DeviceTDesktopWindows(),
		NoUpdates:      true,
	})

	var authorized bool
	runErr := client.Run(ctx, func(ctx context.Context) error {
		st, err := client.Auth().Status(ctx)
		if err != nil {
			return err
		}
		authorized = st.Authorized
		return nil
	})
	if runErr != nil {
		return false, runErr
	}
	return authorized, nil
}

// logout deletes the stored session so the account can no longer be accessed.
func logout() error {
	path, err := sessionFilePath()
	if err != nil {
		return err
	}
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return err
	}
	loginMgr.mu.Lock()
	loginMgr.state = "idle"
	loginMgr.errMsg = ""
	loginMgr.phone = ""
	loginMgr.sitekey = ""
	loginMgr.mu.Unlock()
	return nil
}

// ----------------------------------------------------------------------------
// Fetching channel proxy links via the authenticated MTProto client.
// ----------------------------------------------------------------------------

// Channels post proxies in wildly different shapes. We recognise two:
//
//  1. A full link — tg://proxy?... or https://t.me/proxy?... — usually with
//     markdown/emoji/Persian text crammed right after the secret.
//  2. A label block — "Server: / Port: / Secret:" — sometimes dressed up with
//     small-capital unicode letters (sᴇʀᴠᴇʀ ›) and "Unknown" hostnames.
//
// Both are normalised to a canonical tg://proxy?server=&port=&secret= link so
// duplicates collapse regardless of the original formatting.
var (
	// proxyURLRe captures the three params of a proxy link. The secret group
	// stops at the first character that cannot belong to a hex/base64 secret,
	// which trims the trailing ")__", "**", ")پروکسی", emoji, etc.
	proxyURLRe = regexp.MustCompile(`(?i)(?:tg://|https?://t\.me/)proxy\?server=([^&\s"'<>]+)&port=(\d+)&secret=([A-Za-z0-9_+/=-]+)`)

	// proxyLabeledRe captures a "Server/Port/Secret" block (separator ":" or
	// "›", values on the same or following lines).
	proxyLabeledRe = regexp.MustCompile(`(?is)server\s*[:›]?\s*([A-Za-z0-9._-]+).*?port\s*[:›]?\s*(\d+).*?secret\s*[:›]?\s*([A-Za-z0-9_+/=-]+)`)

	// labelNormalizer maps the small-capital unicode letters channels use to
	// dress up the Server/Port/Secret labels back to ASCII, and drops
	// zero-width marks, so proxyLabeledRe can read them.
	labelNormalizer = strings.NewReplacer(
		"ᴀ", "a", "ʙ", "b", "ᴄ", "c", "ᴅ", "d", "ᴇ", "e",
		"ᴊ", "j", "ᴋ", "k", "ʟ", "l", "ᴍ", "m", "ɴ", "n",
		"ᴏ", "o", "ᴘ", "p", "ʀ", "r", "ᴛ", "t", "ᴜ", "u",
		"ᴠ", "v", "ɪ", "i",
		"\u200b", "", "\u200e", "", "\u200f", "", "\ufeff", "",
	)
)

// buildProxyLink validates the parts and renders a canonical proxy link, or
// reports false for junk (missing/"unknown" host, out-of-range port, stub
// secret).
func buildProxyLink(server, port, secret string) (string, bool) {
	server = strings.TrimRight(strings.TrimSpace(server), ".")
	if server == "" || strings.EqualFold(server, "unknown") {
		return "", false
	}
	p, err := strconv.Atoi(port)
	if err != nil || p < 1 || p > 65535 {
		return "", false
	}
	if len(secret) < 8 {
		return "", false
	}
	return fmt.Sprintf("tg://proxy?server=%s&port=%d&secret=%s", server, p, secret), true
}

// collectProxyLinks appends canonical proxy links found in text (both URL and
// labeled forms) to out, skipping anything already in seen.
func collectProxyLinks(text string, seen map[string]struct{}, out []string) []string {
	add := func(server, port, secret string) []string {
		link, ok := buildProxyLink(server, port, secret)
		if !ok {
			return out
		}
		if _, dup := seen[link]; dup {
			return out
		}
		seen[link] = struct{}{}
		return append(out, link)
	}

	text = html.UnescapeString(text)
	for _, m := range proxyURLRe.FindAllStringSubmatch(text, -1) {
		out = add(m[1], m[2], m[3])
	}
	for _, m := range proxyLabeledRe.FindAllStringSubmatch(labelNormalizer.Replace(text), -1) {
		out = add(m[1], m[2], m[3])
	}
	return out
}

// extractProxyLinksFromText is the testable core: all unique proxy links in a
// single blob of text.
func extractProxyLinksFromText(text string) []string {
	return collectProxyLinks(text, make(map[string]struct{}), nil)
}

// extractProxyLinksFromMessage scans every place a channel can stash a proxy
// link: the raw text, formatted hyperlinks (text-URL entities), inline glass
// buttons (reply markup), and the attached link/webpage preview.
func extractProxyLinksFromMessage(msg *tg.Message) []string {
	seen := make(map[string]struct{})
	out := collectProxyLinks(msg.Message, seen, nil)

	// Hyperlinks where the visible text differs from the underlying URL.
	for _, e := range msg.Entities {
		if tu, ok := e.(*tg.MessageEntityTextURL); ok {
			out = collectProxyLinks(tu.URL, seen, out)
		}
	}

	// Inline keyboard buttons — proxy channels very often hide the link behind
	// a "Connect" glass button rather than putting it in the message text.
	if rm, ok := msg.GetReplyMarkup(); ok {
		if inline, ok := rm.(*tg.ReplyInlineMarkup); ok {
			for _, row := range inline.Rows {
				for _, btn := range row.Buttons {
					switch b := btn.(type) {
					case *tg.KeyboardButtonURL:
						out = collectProxyLinks(b.URL, seen, out)
					case *tg.KeyboardButtonURLAuth:
						out = collectProxyLinks(b.URL, seen, out)
					}
				}
			}
		}
	}

	// Link/webpage preview attached to the message.
	if media, ok := msg.GetMedia(); ok {
		if wp, ok := media.(*tg.MessageMediaWebPage); ok {
			if page, ok := wp.Webpage.(*tg.WebPage); ok {
				out = collectProxyLinks(page.URL, seen, out)
				out = collectProxyLinks(page.DisplayURL, seen, out)
			}
		}
	}

	return out
}

// channelStats reports how a channel scan went, for surfacing to the user.
type channelStats struct {
	found     int
	scanned   int
	withProxy int    // messages that carried at least one proxy link
	stop      string // quota | end | scan-cap | flood | error
}

// getHistoryFloodWait calls MessagesGetHistory, transparently waiting out
// FLOOD_WAIT (RPC 420) responses up to a few times so deep pagination isn't
// aborted by Telegram's rate limiter.
func getHistoryFloodWait(ctx context.Context, api *tg.Client, req *tg.MessagesGetHistoryRequest) (tg.MessagesMessagesClass, error) {
	for attempt := 0; attempt < 4; attempt++ {
		hist, err := api.MessagesGetHistory(ctx, req)
		if err == nil {
			return hist, nil
		}
		rpcErr, ok := tgerr.As(err)
		if !ok || !rpcErr.IsCode(420) {
			return nil, err
		}
		wait := time.Duration(rpcErr.Argument)*time.Second + time.Second
		if wait > 45*time.Second {
			wait = 45 * time.Second
		}
		select {
		case <-time.After(wait):
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	return nil, errors.New("FLOOD_WAIT: retries exhausted")
}

// downloadTextDocument returns the text of a small text/plain (or *.txt)
// attachment on the message, if any, so proxy lists posted as files are not
// missed. Returns false for non-text, oversized, or undownloadable media.
func downloadTextDocument(ctx context.Context, api *tg.Client, msg *tg.Message) (string, bool) {
	media, ok := msg.GetMedia()
	if !ok {
		return "", false
	}
	md, ok := media.(*tg.MessageMediaDocument)
	if !ok {
		return "", false
	}
	docClass, ok := md.GetDocument()
	if !ok {
		return "", false
	}
	doc, ok := docClass.(*tg.Document)
	if !ok || doc.Size > maxDocBytes {
		return "", false
	}

	isText := strings.HasPrefix(doc.MimeType, "text/")
	if !isText {
		for _, a := range doc.Attributes {
			if fn, ok := a.(*tg.DocumentAttributeFilename); ok {
				if strings.HasSuffix(strings.ToLower(fn.FileName), ".txt") {
					isText = true
				}
			}
		}
	}
	if !isText {
		return "", false
	}

	loc := &tg.InputDocumentFileLocation{
		ID:            doc.ID,
		AccessHash:    doc.AccessHash,
		FileReference: doc.FileReference,
	}
	var buf bytes.Buffer
	if _, err := downloader.NewDownloader().Download(api, loc).Stream(ctx, &buf); err != nil {
		return "", false
	}
	return buf.String(), true
}

// fetchChannelViaTG returns up to maxProxies proxy links from a channel,
// newest first (maxProxies <= 0 means "as many as possible"). Telegram caps a
// single getHistory to 100 messages, so we page backwards with OffsetID until
// the quota is filled, the channel runs out, or the scan safety cap is hit.
func fetchChannelViaTG(ctx context.Context, api *tg.Client, channel string, maxProxies int) ([]string, channelStats, error) {
	var stats channelStats
	resolved, err := api.ContactsResolveUsername(ctx, &tg.ContactsResolveUsernameRequest{Username: channel})
	if err != nil {
		return nil, stats, errors.Wrap(err, "resolve username")
	}

	var peer tg.InputPeerClass
	for _, c := range resolved.Chats {
		if ch, ok := c.(*tg.Channel); ok {
			peer = &tg.InputPeerChannel{ChannelID: ch.ID, AccessHash: ch.AccessHash}
			break
		}
	}
	if peer == nil {
		// Could be a basic group or a user — fall back to chat if present.
		for _, c := range resolved.Chats {
			if chat, ok := c.(*tg.Chat); ok {
				peer = &tg.InputPeerChat{ChatID: chat.ID}
				break
			}
		}
	}
	if peer == nil {
		return nil, stats, errors.New("not a channel/group, or no access")
	}

	var links []string
	seen := make(map[string]struct{})
	offsetID := 0
	docsDownloaded := 0
	stats.stop = "scan-cap"

	// addLink records a unique proxy; returns true once the quota is reached.
	addLink := func(l string) bool {
		if _, dup := seen[l]; dup {
			return false
		}
		seen[l] = struct{}{}
		links = append(links, l)
		return maxProxies > 0 && len(links) >= maxProxies
	}

	for stats.scanned < maxScanMessages {
		hist, err := getHistoryFloodWait(ctx, api, &tg.MessagesGetHistoryRequest{
			Peer:     peer,
			Limit:    historyPageSize,
			OffsetID: offsetID,
		})
		if err != nil {
			if len(links) > 0 {
				stats.stop = "flood/error: " + err.Error()
				break // keep what we already gathered instead of failing the channel
			}
			return nil, stats, errors.Wrap(err, "get history")
		}
		modified, ok := hist.AsModified()
		if !ok {
			if len(links) > 0 {
				stats.stop = "non-modified history"
				break
			}
			return nil, stats, errors.New("unexpected history response")
		}

		msgs := modified.GetMessages()
		if len(msgs) == 0 {
			stats.stop = "end"
			break
		}

		minID := 0
		for _, m := range msgs { // newest first
			if id := m.GetID(); id > 0 && (minID == 0 || id < minID) {
				minID = id
			}
			stats.scanned++
			msg, ok := m.(*tg.Message)
			if !ok {
				continue
			}
			if msgLinks := extractProxyLinksFromMessage(msg); len(msgLinks) > 0 {
				stats.withProxy++
				for _, l := range msgLinks {
					if addLink(l) {
						stats.found = len(links)
						stats.stop = "quota"
						return links, stats, nil
					}
				}
			}
			// Some channels drop a .txt list as a file attachment; download and
			// parse it too (bounded per channel to keep fetches fast).
			if docsDownloaded < maxDocsPerChannel {
				if text, ok := downloadTextDocument(ctx, api, msg); ok {
					docsDownloaded++
					for _, l := range extractProxyLinksFromText(text) {
						if addLink(l) {
							stats.found = len(links)
							stats.stop = "quota"
							return links, stats, nil
						}
					}
				}
			}
		}

		if len(msgs) < historyPageSize || minID == 0 {
			stats.stop = "end"
			break // reached the start of the channel
		}
		offsetID = minID // next page: messages older than the oldest in this batch
	}
	stats.found = len(links)
	return links, stats, nil
}

type FetchTGRequest struct {
	Channels []string   `json:"channels"`
	Proxy    ProxyCreds `json:"proxy"`
	Limit    int        `json:"limit,omitempty"`
}

// fetchChannelsViaTelegram opens one authenticated client (through the given
// MTProto proxy) and pulls proxy links from each channel's recent history.
// onProgress, if non-nil, is invoked once before connecting (done=0) and once
// after every channel is processed (done=1..total). It lets the HTTP layer push
// a live percentage to the browser. note is a short human-readable status line.
func fetchChannelsViaTelegram(ctx context.Context, req FetchTGRequest, onProgress func(done, total int, note string)) (FetchChannelsResponse, error) {
	// perChannel is the max proxies taken from each channel; <= 0 means "all"
	// (bounded by the message-scan safety cap), > perChannelMax is clamped.
	perChannel := req.Limit
	if perChannel < 0 {
		perChannel = 0
	}
	if perChannel > perChannelMax {
		perChannel = perChannelMax
	}

	// Normalize + dedupe channel names (reuses the existing helper).
	seenCh := make(map[string]struct{})
	var channels []string
	for _, c := range req.Channels {
		name := normalizeChannel(c)
		if name == "" {
			continue
		}
		if _, ok := seenCh[name]; ok {
			continue
		}
		seenCh[name] = struct{}{}
		channels = append(channels, name)
		if len(channels) >= maxChannels {
			break
		}
	}
	if len(channels) == 0 {
		return FetchChannelsResponse{}, errors.New("no valid channels provided")
	}

	total := len(channels)
	progress := func(done int, note string) {
		if onProgress != nil {
			onProgress(done, total, note)
		}
	}
	progress(0, "اتصال به تلگرام...")

	resolver, err := buildMTProxyResolver(req.Proxy.Server, req.Proxy.Port, req.Proxy.Secret)
	if err != nil {
		return FetchChannelsResponse{}, err
	}
	storage, err := newSessionStorage()
	if err != nil {
		return FetchChannelsResponse{}, err
	}
	appID, appHash := loadAppCreds()
	client := telegram.NewClient(appID, appHash, telegram.Options{
		Resolver:       resolver,
		SessionStorage: storage,
		Device:         telegram.DeviceTDesktopWindows(),
		NoUpdates:      true,
	})

	runCtx, cancel := context.WithTimeout(ctx, tgFetchTimeout)
	defer cancel()

	var resp FetchChannelsResponse
	seenLink := make(map[string]struct{})

	runErr := client.Run(runCtx, func(ctx context.Context) error {
		st, err := client.Auth().Status(ctx)
		if err != nil {
			return errors.Wrap(err, "auth status")
		}
		if !st.Authorized {
			return errors.New("not logged in — complete Telegram login first")
		}

		api := client.API()
		for i, ch := range channels {
			links, stats, err := fetchChannelViaTG(ctx, api, ch, perChannel)
			if err != nil {
				resp.Errors = append(resp.Errors, fmt.Sprintf("%s: %v", ch, err))
				progress(i+1, fmt.Sprintf("@%s: خطا", ch))
				continue
			}
			added := 0
			for _, l := range links {
				if _, ok := seenLink[l]; ok {
					continue
				}
				seenLink[l] = struct{}{}
				resp.Links = append(resp.Links, l)
				added++
			}
			// Per-channel diagnostics so the user can see the real bottleneck
			// (e.g. ran out of messages vs. hit the scan cap vs. flood wait).
			resp.Notes = append(resp.Notes, fmt.Sprintf(
				"%s: %d new | %d unique found | %d/%d msgs had a proxy | stop=%s",
				ch, added, stats.found, stats.withProxy, stats.scanned, stats.stop))
			progress(i+1, fmt.Sprintf("@%s: %d پراکسی جدید (مجموع %d)", ch, added, len(resp.Links)))
		}
		return nil
	})
	if runErr != nil {
		return FetchChannelsResponse{}, runErr
	}

	resp.Count = len(resp.Links)
	return resp, nil
}
