# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Single source of truth for this repo. `AGENTS.md` is a pointer to this file.

## Commands

```bash
go run .                          # dev server on :3000 (PORT env overrides)
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

**Formatting:** `gofmt -l .` lists all three Go files — `main.go`, `main_test.go`, `proxytest_test.go` — but that is mostly line endings: the sources are committed with CRLF, which `gofmt` rewrites to LF. Normalize line endings first and only `main.go` remains flagged, for genuine drift (import `github.com/gotd/td/session` sorted after `dcs`; `const` block alignment). So `gofmt -l` output is not a usable formatting signal on this repo as-is.

No linter, no formatter config, no test CI. Only CI is `.github/workflows/release.yml`, triggered by `push` of a `v*` tag: cross-compiles 5 platforms (windows/linux/darwin × amd64/arm64, `CGO_ENABLED=0`), injects `-X main.version=<tag>`, uploads to GitHub Releases with a changelog generated from `git log <prev-tag>..<tag>`.

## Architecture

Single-process Go server (`main.go`, ~515 lines) + vanilla-JS frontend embedded into the binary. No build step for the frontend, no framework, no TypeScript.

**Backend — three endpoints, all wrapped in `recoverMiddleware` (panic → 500 JSON):**
- `POST /check` — one proxy, returns `{ok, ping?}`
- `POST /check-batch` — JSON array in, array out. Two strict phases with a barrier between them: all TCP pre-checks finish (`tcpWg.Wait()`), *then* MTProto checks run on survivors.
- `POST /check-stream` — SSE, the only endpoint the UI actually calls. Per-proxy goroutine does TCP check then MTProto check inline (no barrier), emitting `event: progress` per result and `event: done` at the end. Writes are serialized by `mu` because `http.ResponseWriter` is not concurrency-safe.

`public/` is baked in with `//go:embed public` + `fs.Sub` and served by `http.FileServer` at `/`. Nothing is read from disk at runtime — editing `public/` requires a rebuild (or `go run .`) to take effect.

**Proxy verification** (`checkProxy`) is a real MTProto handshake, not a TCP ping: `dcs.MTProxy(addr, secret)` resolver → `telegram.NewClient` with public test creds (`testAppID = 6`, `testAppHash = "eb06d4…"`, hardcoded in `main.go`, intentionally public — no login required) → `help.getNearestDC`. Round-trip time of that call is the reported ping. It carries its own `recover()` on top of the middleware because gotd can panic on malformed proxy responses.

`decodeSecret` right-trims a set of punctuation/whitespace junk, then tries hex → base64 RawURL → base64 URL in order.

**Shared mutable state to be careful with:**
- `sharedSession` (`session.StorageMemory`) is a package-level singleton reused by every check so the auth key is negotiated once. Tests needing isolation reassign it (`sharedSession = &session.StorageMemory{}`).
- `dnsCache` — `map[string]*dnsCacheEntry` behind `dnsCacheMu`, 5-min TTL, consulted by `tcpCheck` before dialing.

**Timeout layering** (four levels, don't collapse them): UI-selected `timeout` clamped to 3–30s (`defaultTimeout = 5`) bounds the gotd context; `/check-stream` wraps that in a hard `t+10s` context so a stuck proxy can never wedge a goroutine; `tcpTimeout` is a fixed 1.5s dial; the client also arms its own `(timeout+30)*1000 + 120000` ms abort on the whole stream. Server `WriteTimeout` is 300s to keep long SSE streams alive; shutdown is `SIGINT`/`SIGTERM` → `srv.Shutdown` with a 5s context.

**Concurrency** comes from the `X-Concurrency` request header, clamped to `[1, maxConcurrency = 50]`, enforced by a buffered-channel semaphore. Note the server's own fallback when the header is absent is `10`, while the UI's default selection is `50`.

**Frontend** (`public/js/script.js`, ~635 lines):
- `translations` object at the top holds all four locales (fa RTL default, en, ru, zh); DOM text is bound via `[data-i18n]` attributes and applied in `setLanguage()`. Adding UI text means adding the key to **all four** locales.
- Scan lifecycle is two independent flags: `scanState` (`'idle'`/`'scanning'`, drives the start button flipping to a red Stop via `updateStartBtn()`) and `isPaused`. Both pause and stop call `controller.abort()` on the in-flight SSE fetch — pause differs only in that resume re-POSTs `/check-stream` with the proxies missing from the `checkedKeys` Set (keys are `server:port:secret`). The server has no pause concept.
- `parseLink()` sanitizes client-side before anything is sent: fixes `.&` typos, requires a scheme, rejects ports outside 1–65535, drops spam secrets (>170 chars or containing a long `AAAA…` run). Dedup by `server:port:secret` happens in `startCheck()`.
- Handlers are wired as inline `onclick`/`onchange` attributes in `index.html`, not `addEventListener` — renaming a top-level function in `script.js` silently breaks the button unless the HTML is updated too.
- CSS is split by concern and must stay that way: `tokens.css` (custom properties) → `base.css` (reset/typography) → `components.css`. Theme is `[data-theme]` on `<html>`, persisted in `localStorage` alongside language and the finish-sound toggle.
- Zero CDN at runtime: Vazirmatn (Persian) + Inter (Latin) woff2 are self-hosted under `public/fonts/`.

## Repo conventions

- Commits follow Conventional Commits: `feat`/`fix`/`chore`/`build`/`refactor`, optional scope — `feat(i18n):`, `fix(release):`, `refactor(frontend):`.
- Key files: `main.go` (server, all handlers) · `public/index.html` (markup + inline handlers) · `public/js/script.js` (all frontend logic + i18n) · `public/js/helpers.js` (dead, see below) · `public/css/{tokens,base,components}.css` (load order matters) · `main_test.go` + `proxytest_test.go` (Go tests) · `.github/workflows/release.yml` (only CI).
- `SPEC.md` carries the intended behavior contract: constraints (`C*`), invariants (`V*`), tasks (`T*`), bugs (`B*`). Behavior changes should update the matching invariant; new bugs get a `§B` row.
- Four READMEs (`README.md`, `_FA`, `_RU`, `_ZH`) are kept in sync; the in-app Help button opens the one matching the current UI language.

## Known drift and defects (current state — do not "fix" as a side effect)

`SPEC.md` and the READMEs describe intent, and parts have drifted from the code. Verify against source before trusting them. Confirmed by reading the code:

- **`SPEC.md` V1 is stale** — "server auto-opens browser to localhost:3000". `main.go` contains no browser-launch code.
- **`public/js/helpers.js` is dead code.** `index.html` loads it before `script.js`, but none of its 14 functions (`$`, `setText`, `show`, `hide`, `val`, `setVal`, `on`, `qs`, `qsa`, `enable`, `disable`, `addClass`, `rmClass`, `toggleClass`) is referenced anywhere in `script.js` or the inline handlers.
- **`var version` is never read.** The release workflow injects it via `-ldflags -X main.version=<tag>`, but `main.go:31` is the only occurrence in the source — no flag, no endpoint, no log line surfaces it.
- **`/check` and `/check-batch` are unused by the shipped UI.** The only `fetch()` in the frontend targets `/check-stream`.
- **The server binds `:3000` on all interfaces with no auth, no CORS policy and no origin check**, while the entire UX assumes localhost. Anyone routable to the host can drive the checker.
- **Three product names in circulation:** "MTProto Ultimate Checker" (`index.html` `<title>`), "MTProto Pro Checker" (`<h1>` + the `title` i18n key in all four locales), "MTProto Deep Checker" (READMEs, `AGENTS.md` history).
- **The production link parser has zero test coverage.** `main_test.go` defines and tests its own local `parseProxyLink` helper; the parser that actually runs is `parseLink` in `public/js/script.js`, and there is no JS test harness in the repo.
- **Tests depend on a proxy list that is not in the repo.** `main_test.go` and `proxytest_test.go` read `testdata/proxies.txt` and `t.Skip` when it is absent, so `go test ./...` is largely a no-op on a fresh clone.
- **Version declarations disagree:** `go.mod` says `go 1.26.3`; the README and the release workflow say Go 1.18+.
- **No HTTP handler tests.** Six test functions exist and none uses `httptest`; `/check`, `/check-batch`, `/check-stream` and `recoverMiddleware` have zero coverage. `checkProxy` is exercised only by a live-network test that skips when the local proxy list is absent.
- **`main.go` is not gofmt-clean** (import order, const block alignment), independent of the CRLF line endings that make `gofmt -l` flag all three files.

Every item above is documentation of current state. Fixes go through brainstorming → plan first, not opportunistic edits.
