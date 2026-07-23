# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Single source of truth for this repo. `AGENTS.md` is a pointer to this file.

## Commands

```bash
go run .                          # dev server on 127.0.0.1:3000 (PORT/HOST env override)
go build -o mtproto-checker .     # single self-contained binary
go test ./... -short              # unit tests only — skips network/proxy-file tests
go test ./... -v                  # full run, incl. live Telegram handshake tests
go test -run TestDecodeSecret -v  # single test
go test -bench BenchmarkBatchPipeline -benchtime=1x
go vet ./...                      # clean as of last run

# reproduce a release build locally
GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build -ldflags="-X main.version=v0.0.0-local" -o /tmp/mtc .
```

A host build (`go1.26.4 windows/amd64`) produces a 21,616,640-byte (~20.6 MiB) binary with `public/` baked in.

**Formatting:** `.gitattributes` pins `*.go` (and all text files) to LF in the repository *and* the working copy, so `gofmt -l .` is meaningful on every platform and is expected to be clean. Caveat: a checkout that predates `.gitattributes` may still hold stale CRLF working copies (`git ls-files --eol` shows `w/crlf`), which makes `gofmt -l` flag every Go file on line endings alone — fix with `rm <files> && git checkout -- <files>`, not by re-formatting.

No linter, no formatter config, no test CI. Only CI is `.github/workflows/release.yml`, triggered by `push` of a `v*` tag: cross-compiles 5 platforms (windows/linux/darwin × amd64/arm64, `CGO_ENABLED=0`), injects `-X main.version=<tag>`, uploads to GitHub Releases with a changelog generated from `git log <prev-tag>..<tag>`.

## Architecture

Single-process Go server (`main.go`, ~600 lines) + vanilla-JS frontend embedded into the binary. No build step for the frontend, no framework, no TypeScript.

**Backend — three endpoints, all wrapped in `recoverMiddleware` (panic → 500 JSON):**
- `POST /check` — one proxy, returns `{ok, ping?}`. The supported scripting endpoint, documented in the READMEs' HTTP API section.
- `POST /check-batch` — **deprecated, removal planned for a future release**: answers with `Deprecation: true` + `Link` headers and logs a warning per hit. JSON array in, array out. Two strict phases with a barrier between them: all TCP pre-checks finish (`tcpWg.Wait()`), *then* MTProto checks run on survivors.
- `POST /check-stream` — SSE, the only endpoint the UI actually calls. Per-proxy goroutine does TCP check then MTProto check inline (no barrier), emitting `event: progress` per result and `event: done` at the end. Writes are serialized by `mu` because `http.ResponseWriter` is not concurrency-safe.

**Request limits:** every handler caps the body at `maxBodySize` (8 MiB) via `http.MaxBytesReader`; the two batch endpoints additionally reject more than `maxBatchSize` (10 000) entries. Either violation answers `413` with `{"error": …}` — shared logic in `readCheckRequests`, which `/check-stream` runs *before* committing to SSE so a rejected request gets plain JSON, not an empty event stream. Note the UI posts the whole pasted list in one request, so a pasted list over 10 000 entries now fails with the generic error toast.

`public/` is baked in with `//go:embed public` + `fs.Sub` and served by `http.FileServer` at `/`. Nothing is read from disk at runtime — editing `public/` requires a rebuild (or `go run .`) to take effect.

**Startup** logs the version (`-ldflags -X main.version=<tag>` in releases, `"dev"` otherwise), binds explicitly with `net.Listen` (bind failure dies before any browser launch), then opens the local browser at the bound address — only when the bound host is loopback (`shouldOpenBrowser`); `NO_BROWSER` set to any non-empty value suppresses it, and a non-loopback `HOST` suppresses it automatically. The launcher (`browserCommand`: `rundll32`/`open`/`xdg-open`) is fire-and-forget; a failed launch logs one line and never affects the server.

**Proxy verification** (`checkProxy`) is a real MTProto handshake, not a TCP ping: `dcs.MTProxy(addr, secret)` resolver → `telegram.NewClient` with public test creds (`testAppID = 6`, `testAppHash = "eb06d4…"`, hardcoded in `main.go`, intentionally public — no login required) → `help.getNearestDC`. Round-trip time of that call is the reported ping. It carries its own `recover()` in addition to the middleware's; the reason is not recorded anywhere in the repo.

`decodeSecret` tries the raw input and then a junk-right-trimmed copy (the trim set overlaps the base64 alphabets, so raw must come first); per candidate it tries hex first (both candidates), then base64 RawURL → URL → RawStd → Std. Known limitation: a base64 secret whose last character is `+`, `/` or `_` *and* is followed by junk still decodes to the wrong bytes — the raw pass fails on the junk, and the trim pass strips that final alphabet character along with it.

**Load-bearing rule: `sharedSession` is one `session.StorageMemory` shared across all checks — do not change it to per-check storage.** It reads like a bug (package-level mutable state shared across concurrent goroutines) and was "fixed" once on exactly that theory (d0288be); the fix destroyed detection. Measured 2026-07-23, same 1022-proxy input, concurrency 50, timeout 10s: per-check sessions → **0/1022 working in 98s**; reverting only the storage line → **99/1022 in 74s** (pings from 133ms). A same-binary control later scored 0/1022 in a throttle-poisoned slot, confirming the slot effect and that the delta is the storage line, not network luck — and run order worked *against* the shared variant (it ran in the dirtier slot and still won). Those numbers are the fact; the mechanism is inferred, not instrumented: with a shared session the first successful check negotiates the auth key and every later check reuses it, skipping the DH exchange that otherwise must fit inside the 2s `ExchangeTimeout` — which is also how a real Telegram client behaves — and each fresh key creation counts against the source IP, so per-check sessions make every scan degrade the next (self-poisoning; the "N found on first run, zero after" signature). If the real mechanism turns out different, the rule stands on the numbers. Never measured in a clean slot: per-request sharing (logically identical within one scan; **the variant worth revisiting** — if it matches, it restores isolation between scans as a small commit) and a longer `ExchangeTimeout` (1/1022 in a moderately poisoned slot — suggestive of insufficient, not proven). `TestNewCheckOptionsSharedSession` guards the sharing.

**Shared mutable state to be careful with:**
- `dnsCache` — `map[string]*dnsCacheEntry` behind `dnsCacheMu`, 5-min TTL, consulted by `tcpCheck` before dialing.

**Timeout layering** (four levels, don't collapse them): UI-selected `timeout` clamped to 3–30s (`defaultTimeout = 5`) bounds the gotd context; `/check-stream` wraps that in a hard `t+10s` context so a stuck proxy can never wedge a goroutine; `tcpTimeout` is a fixed 1.5s dial; the client also arms its own `(timeout+30)*1000 + 120000` ms abort on the whole stream. Server `WriteTimeout` is 300s to keep long SSE streams alive; shutdown is `SIGINT`/`SIGTERM` → `srv.Shutdown` with a 5s context.

**Concurrency** comes from the `X-Concurrency` request header, clamped to `[1, maxConcurrency = 50]`, enforced by a buffered-channel semaphore. Note the server's own fallback when the header is absent is `10`, while the UI's default selection is `50`.

**Frontend** (`public/js/script.js`, ~775 lines):
- `translations` object at the top holds all four locales (fa RTL default, en, ru, zh); DOM text is bound via `[data-i18n]` attributes and applied in `setLanguage()`. Adding UI text means adding the key to **all four** locales. The old `status` key is gone — there is no single status line anymore.
- Layout is a single-column flow, not the old two-textarea grid: settings bar → four stat tiles (`#tileChecked`/`#tileTotal`, `#tileWorking`, `#tileBest`, `#tileFailed`/`#tileSkipped`, all written by `renderStats()`) → progress bar → input section → results panel → console drawer.
- The input section's `.io-pane` holds `#inputProxies` plus an absolutely-positioned `.empty-hint` overlay (icon, localized copy, an example `tg://` link) shown only while the textarea is empty (`:placeholder-shown`). During a scan, `body.scanning` (toggled by `setScanUI()`) hides the pane entirely and shows `#inputSummary` instead — a localized "N links loaded · M skipped" line written by `updateScanSummary()`. Both pause and stop restore the pane (`setScanUI(false)`); the server has no notion of this collapse.
- Results panel: `workingProxies` (`{link, ping, server, port}`) is the sole source of truth, populated from SSE `progress` events in `runCheckStream()`. `renderResultsTable()` — always rebuilt with `createElement`/`textContent`, never `innerHTML`, since server/port are attacker-controlled strings from pasted URLs — is the default view; `#resultsPanel[data-view]` toggles between it and a plain-text `#outputProxies` textarea via the `.view-toggle` Table/Plain-text buttons (`setResultsView()`). Rendering is coalesced through `scheduleResultsRender()` (one `requestAnimationFrame` per burst) rather than re-rendering per SSE event. Per-row copy is wired as **one delegated `click` listener on `#resultsBody`** (`btn.dataset.index` → `workingProxies[i]`) — the single sanctioned exception to the inline-onclick convention below, justified by rows being rebuilt wholesale on every render. `copyResults()`/`exportResults()` and the per-row copy all read `workingProxies` through the shared `proxyLine(p)` helper (`link + ' # Ping: Nms'`), so every copy/export artifact carries the full original link including the secret — the table is just a view, never the data source.
- Scan lifecycle is two independent flags: `scanState` (`'idle'`/`'scanning'`, drives the start button flipping to a red Stop via `updateStartBtn()`) and `isPaused`. Both pause and stop call `controller.abort()` on the in-flight SSE fetch — pause differs only in that resume re-POSTs `/check-stream` with the proxies missing from the `checkedKeys` Set (keys are `server:port:secret`). The server has no pause concept.
- `parseLink()` sanitizes client-side before anything is sent: fixes `.&` typos, requires a scheme, rejects ports outside 1–65535, drops spam secrets (>170 chars or containing a long `AAAA…` run). Dedup by `server:port:secret` happens in `startCheck()`.
- The console (`#console`) now lives inside `<details id="consoleDrawer">` — collapsed by default, auto-opened by `log()` whenever a line is logged with `kind === true || 'error'` (`drawer.open = true`), so scan/parse errors surface without the user having to expand it manually.
- Handlers are wired as inline `onclick`/`onchange` attributes in `index.html`, not `addEventListener` — renaming a top-level function in `script.js` silently breaks the button unless the HTML is updated too.
- CSS is split by concern and must stay that way: `tokens.css` (custom properties) → `base.css` (reset/typography) → `components.css`. Theme is `[data-theme]` on `<html>` (default `'dark'`), persisted in `localStorage` alongside language and the finish-sound toggle. The `localStorage` entry only persists the preference — the completion beep fires in `finish()`, and only when the checkbox is currently checked.
- Two deliberate button systems in `components.css` — do not "unify" them: action buttons (start/pause/stop/copy/export/file) are 48px glassmorphism (`backdrop-filter: blur(8px)`, glass borders/inset shadows) with gradient fills — start blue→indigo, copy/export emerald, pause amber, stop red; header controls (theme/sound/language/help) are a separate flat 34px system. `.rowcopy` and `.view-toggle` are a third thing, table chrome deliberately outside both systems — flat, bordered, no backdrop-filter, sized to sit inside table rows and the results-head toolbar.
- The `<h1>` title wraps an `<a>` linking to the GitHub repo.
- Zero CDN at runtime: Vazirmatn (Persian) + Inter (Latin) woff2 are self-hosted under `public/fonts/`.

## Repo conventions

- Commits follow Conventional Commits: `feat`/`fix`/`chore`/`build`/`refactor`, optional scope — `feat(i18n):`, `fix(release):`, `refactor(frontend):`.
- Trailer convention: Claude-assisted commits carry `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` (plus a human co-author trailer when someone else's work is being landed); hand-made commits carry none. The mixed history is deliberate attribution, not drift — don't add or strip trailers retroactively.
- Contributions from forks must be rebased onto current `main` or cherry-picked — never merged with the GitHub merge button. Older forks carry a divergent history.
- Key files: `main.go` (server, all handlers) · `public/index.html` (markup + inline handlers) · `public/js/script.js` (all frontend logic + i18n) · `public/css/{tokens,base,components}.css` (load order matters) · `main_test.go` + `proxytest_test.go` (Go tests) · `.github/workflows/release.yml` (only CI).
- Four READMEs (`README.md`, `_FA`, `_RU`, `_ZH`) are intended to be kept in sync — not verified, and they already differ in length (`README_FA.md` is 77 lines against 85 for the other three). The in-app Help button opens the one matching the current UI language.

## Known drift and defects (current state — do not "fix" as a side effect)

The READMEs describe intent, and parts have drifted from the code. Verify against source before trusting them. Confirmed by reading the code:

- **No auth, no CORS policy, no origin check.** The server binds `127.0.0.1:3000` by default (`resolveAddr`); setting `HOST=0.0.0.0` (or a specific address) is the explicit opt-in to wider exposure, and anyone routable can then drive the checker. `PORT` parsing is deliberately lenient (Sscanf error ignored) — preserved behavior, not endorsed design.
- **The production link parser has zero test coverage.** `main_test.go` defines and tests its own local `parseProxyLink` helper; the parser that actually runs is `parseLink` in `public/js/script.js`, and there is no JS test harness in the repo.
- **Tests depend on a proxy list that is not in the repo.** `main_test.go` and `proxytest_test.go` read `testdata/proxies.txt` and `t.Skip` when it is absent, so `go test ./...` is largely a no-op on a fresh clone.
- **No HTTP handler tests.** No test uses `httptest`; `/check`, `/check-batch`, `/check-stream` and `recoverMiddleware` have zero coverage. `checkProxy` is exercised only by a live-network test that skips when the local proxy list is absent.
- **`images/screenshot*.png` are stale again** after the results-workbench restructure (stat tiles, collapsing input zone, table/plain-text results panel, console drawer) — they still show the old status-line/two-textarea layout.

Every item above is documentation of current state. Fixes go through brainstorming → plan first, not opportunistic edits.
