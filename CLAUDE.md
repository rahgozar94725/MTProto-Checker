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

Frontend tests (Node ≥ 22, `npm install` first — nothing in production runs on Node):

```bash
npm test                          # alias for test:unit
npm run test:unit                 # node:test + jsdom over tests/unit/**/*.test.js
npm run test:watch                # same, in watch mode
npm run test:coverage             # adds --experimental-test-coverage over public/js/**
npm run test:coverage:ci          # same, minus app.js, gated at 100% lines and branches
npm run test:e2e                  # Playwright, boots `go run .` itself
npm run test:all                  # unit then e2e
npx playwright install chromium   # one-time, before the first e2e run
E2E_LIVE=1 npm run test:e2e       # also runs the live smoke test against real Telegram
```

`node --test` is given a **quoted glob**, not a directory — Node resolves a bare directory as a module and dies with `MODULE_NOT_FOUND`. Coverage is still behind `--experimental-test-coverage` as of Node 26.5.0.

`test:coverage:ci` is the enforcement behind the 100% claims below; `test:coverage` stays ungated for local reading. The gate excludes `public/js/app.js` (its ~29% is the cache-busted-mount artifact described under **Frontend tests**, not a real gap) and does not gate *functions* — `render.js` reports 85.71% because `showToast()`'s own `setTimeout` callback never runs in a unit test. `--test-coverage-lines`/`-branches` need Node ≥ 22.8.

A host build (`go1.26.4 windows/amd64`) produces a 21,828,608-byte (~20.8 MiB) binary with `public/` baked in. Only `public/` is embedded — `package.json`, `node_modules/` and `tests/` sit outside it and never reach the binary; `tests/unit/harness.test.js` is the permanent guard on that.

**Formatting:** `.gitattributes` pins `*.go` (and all text files) to LF in the repository *and* the working copy, so `gofmt -l .` is meaningful on every platform and is expected to be clean. Caveat: a checkout that predates `.gitattributes` may still hold stale CRLF working copies (`git ls-files --eol` shows `w/crlf`), which makes `gofmt -l` flag every Go file on line endings alone — fix with `rm <files> && git checkout -- <files>`, not by re-formatting.

No linter, no formatter config. Two workflows:

- `.github/workflows/test.yml` — on every `push` and `pull_request`, three jobs: `js` (Node 22, `npm ci`, `npm test`, then `npm run test:coverage:ci` as the coverage gate), `go` (`go vet`, `go test ./... -short`, and a `gofmt -l .` gate that has to test the file list itself because `gofmt -l` exits 0 even with offenders), `e2e` (both toolchains, `~/.cache/ms-playwright` cached on `package-lock.json`, report uploaded on failure). `E2E_LIVE` is never set in CI.
- `.github/workflows/release.yml` — triggered by `push` of a `v*` tag: cross-compiles 5 platforms (windows/linux/darwin × amd64/arm64, `CGO_ENABLED=0`), injects `-X main.version=<tag>`, uploads to GitHub Releases with a changelog generated from `git log <prev-tag>..<tag>`.

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

**Frontend** — seven ES modules under `public/js/`, no bundler and still no build step. `public/index.html` loads exactly one of them, `<script type="module" src="/js/app.js">`; the browser fetches the rest. Module scripts are deferred, so a small inline script in `<head>` applies the persisted `data-theme`, `dir` and `lang` before CSS paints — without it a light-theme or LTR user gets a dark/RTL flash. It carries its own copy of the locale list (`fa`/`en`/`ru`/`zh`) because it runs before the module graph exists and cannot import `i18n.js`, so **adding a locale means editing `index.html` too** — otherwise an unknown stored `lang` paints LTR and `resolveLang()` flips it to RTL a moment later. `tests/unit/boot.test.js` runs that script against stub globals.

| Module | Lines | Owns |
|---|---|---|
| `app.js` | 637 | Entry point: boot order, all event wiring, scan orchestration (`startCheck`/`runCheckStream`/`finish`), theme/language/settings persistence, drag-and-drop, copy and export |
| `i18n.js` | 193 | `translations` (all four locales), `t(lang, key)`, `interpolate(str, vars)` |
| `parse.js` | 80 | `parseLink`, `parseProxyList`, `proxyKey`, `isAcceptedFilename`, `ACCEPTED_EXTENSIONS` — pure, no module-level mutable state |
| `render.js` | 69 | `resultCell`, `renderResultsTable`, `renderStats`, `setResultsView`, `showToast` — all document-first (`renderResultsTable(doc, proxies, rowCopyLabel)`), reading no module state |
| `sse.js` | 43 | `createSSEParser()` → `{push(chunk)}`, yielding `{event, data}` frames and buffering a trailing partial |
| `state.js` | 27 | `createScanState()` — a **factory, not a singleton**, so two mounts in one Node process cannot share state |
| `format.js` | 17 | `proxyLine`, `pingClass` |

- `i18n.js` holds all four locales (fa RTL default, en, ru, zh); DOM text is bound via `[data-i18n]` attributes and applied in `setLanguage()`. Adding UI text means adding the key to **all four** locales. The old `status` key is gone — there is no single status line anymore.
- Layout is a single-column flow, not the old two-textarea grid: settings bar → four stat tiles (`#tileChecked`/`#tileTotal`, `#tileWorking`, `#tileBest`, `#tileFailed`/`#tileSkipped`, all written by `renderStats()`) → progress bar → input section → results panel → console drawer.
- The input section's `.io-pane` holds `#inputProxies` plus an absolutely-positioned `.empty-hint` overlay (icon, localized copy, an example `tg://` link) shown only while the textarea is empty (`:placeholder-shown`). During a scan, `body.scanning` (toggled by `setScanUI()`) hides the pane entirely and shows `#inputSummary` instead — a localized "N links loaded · M skipped" line written by `updateScanSummary()`. Stop restores the pane (`setScanUI(false)`); pause deliberately does not — `togglePause()` never calls `setScanUI()`, so the input stays collapsed through a pause since `scanState` remains `'scanning'`. The server has no notion of this collapse.
- Results panel: `workingProxies` (`{link, ping, server, port}`) is the sole source of truth, populated from SSE `progress` events in `runCheckStream()`. `renderResultsTable()` — always rebuilt with `createElement`/`textContent`, never `innerHTML`, since server/port are attacker-controlled strings from pasted URLs — is the default view; `#resultsPanel[data-view]` toggles between it and a plain-text `#outputProxies` textarea via the `.view-toggle` Table/Plain-text buttons (`setResultsView()`). Rendering is coalesced through `scheduleResultsRender()` (one `requestAnimationFrame` per burst) rather than re-rendering per SSE event. Per-row copy is wired as **one delegated `click` listener on `#resultsBody`** (`btn.dataset.index` → `workingProxies[i]`), justified by rows being rebuilt wholesale on every render. All copy/export paths read `workingProxies`, never the DOM, and every artifact preserves the secret-bearing `p.link`; `proxyLine(p)` (`link + ' # Ping: Nms'`) formats the text artifacts — `exportResults('json')` builds `{link, ping}` objects directly instead.
- Scan lifecycle is two independent flags: `scanState` (`'idle'`/`'scanning'`, drives the start button flipping to a red Stop via `updateStartBtn()`) and `isPaused`. Both pause and stop call `controller.abort()` on the in-flight SSE fetch — pause differs only in that resume re-POSTs `/check-stream` with the proxies missing from the `checkedKeys` Set (keys are `server:port:secret`). The server has no pause concept.
- `parseLink()` sanitizes client-side before anything is sent: fixes `.&` typos, requires a scheme, rejects ports outside 1–65535, drops spam secrets (>170 chars or containing a long `AAAA…` run). Dedup by `server:port:secret` happens in `startCheck()`.
- The console (`#console`) now lives inside `<details id="consoleDrawer">` — collapsed by default, auto-opened by `log()` whenever a line is logged with `kind === true || 'error'` (`drawer.open = true`), so scan/parse errors surface without the user having to expand it manually.
- Every handler is wired with `addEventListener` inside `app.js`; `index.html` carries zero `onclick`/`onchange` attributes and `app.js` leaks no function to `window`. The wiring is by ID, so **renaming or removing an ID in `index.html` silently unwires that control** — `tests/e2e/controls.spec.js` exists to catch exactly that.
- **Load-bearing rule: in `app.js`, every `addEventListener` runs before the first paint call.** The file ends with the wiring block and then `setLanguage`/`setTheme`/`updateStartBtn`/`loadSettings`/`syncSoundUI` — that order, not the reverse. `app.js` is an ES module, so a top-level throw aborts evaluation and everything after it is skipped; with painting first, one bad value left the page rendered normally with all eleven controls dead and nothing in the console. (The classic `script.js` this replaced was immune: its function declarations landed on `window`, so the inline `onclick` attributes kept working through the same throw.) For the same reason the prelude's only outside input is total — `readStored`/`writeStored`/`removeStored` swallow a denied `localStorage`, and `resolveLang()` falls back to `fa`, which is what keeps all sixteen `translations[currentLang]` lookups in the file safe. `localStorage` is origin-keyed and this app lives on `127.0.0.1:3000`, so a foreign `lang` value written by another local dev server is the realistic trigger. `tests/unit/boot.test.js` guards both halves, including a source-order assertion.
- CSS is split by concern and must stay that way: `tokens.css` (custom properties) → `base.css` (reset/typography) → `components.css`. Theme is `[data-theme]` on `<html>` (default `'dark'`), persisted in `localStorage` alongside language and the finish-sound toggle. The `localStorage` entry only persists the preference — the completion beep fires in `finish()`, and only when the checkbox is currently checked.
- Two deliberate button systems in `components.css` — do not "unify" them: action buttons (start/pause/stop/copy/export/file) are 48px glassmorphism (`backdrop-filter: blur(8px)`, glass borders/inset shadows) with gradient fills — start blue→indigo, copy/export emerald, pause amber, stop red; header controls (theme/sound/language/help) are a separate flat 34px system. `.rowcopy` and `.view-toggle` are a third thing, table chrome deliberately outside both systems — flat, bordered, no backdrop-filter, sized to sit inside table rows and the results-head toolbar.
- The `<h1>` title wraps an `<a>` linking to the GitHub repo.
- Zero CDN at runtime: Vazirmatn (Persian) + Inter (Latin) woff2 are self-hosted under `public/fonts/`.

**Frontend tests** — `node:test` + jsdom for units, Playwright for e2e. No bundler, no transpiler. `SPEC.md` is the contract this suite was built to; the ESM refactor that made it possible is documented there.

- `tests/unit/` — `parse`, `sse`, `format`, `i18n`, `render`/`state` (all at 100% line and branch), plus `lifecycle.test.js` (full scan against a stubbed `fetch`), `boot.test.js` (the boot-order rule above) and `harness.test.js` (asserts nothing test-related sits under `public/`). `app.js` reads ~29% and stays misattributed: `tests/helpers/dom.js` cache-busts each mount with a `?mount=N` specifier, so every mount is a separate module URL to the coverage reporter.
- `mountApp({ beforeBoot })` runs its callback *before* the jsdom globals are installed, which is the only window in which boot-time conditions can be staged. Denying `localStorage` there means **replacing `window.localStorage` wholesale** — jsdom implements `Storage` as a Proxy whose `defineProperty` trap drops the definition and returns success, so patching a single method reads as working and denies nothing.
- `tests/helpers/dom.js` — mounts the **real** `public/index.html` in jsdom, so a renamed ID fails a test. jsdom cannot run `<script type="module">`, so `app.js` is imported by Node with the jsdom window installed on `globalThis` first. **jsdom has no `innerText`** — the helper defines it in terms of `textContent` before importing `app.js`; without that shim every `log()`/`setLanguage()`/`showToast()` write silently vanishes. `requestAnimationFrame` is replaced with a controllable version so coalesced rendering can be flushed deterministically.
- `tests/fixtures/golden/parse-baseline.json` — the pre-refactor parser's output over `proxies-dirty.txt`, recorded before any edit and replayed by `parse.test.js`. It is **Node-flavoured**: Node's `URL` accepts `file://localhost?server=…` and Chrome does not, so the same fixture is 227 proxies under `npm test` and 226 in a real browser. `tests/helpers/record-baseline.js` is kept for provenance only — it injects the frontend as a classic script and stopped working the moment `app.js` gained its first `import`.
- `tests/e2e/` — `scan.spec.js` (stubbed `/check-stream` via `page.route()`), `controls.spec.js` (all eleven migrated controls, zero console errors), `live.spec.js` (skipped unless `E2E_LIVE=1`; the only test that would catch a real server-contract break). Playwright boots the server itself with `NO_BROWSER=1`; the `webServer` timeout is 180s because `go run .` compiles first.

## Repo conventions

- Commits follow Conventional Commits: `feat`/`fix`/`chore`/`build`/`refactor`, optional scope — `feat(i18n):`, `fix(release):`, `refactor(frontend):`.
- Trailer convention: Claude-assisted commits carry `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` (plus a human co-author trailer when someone else's work is being landed); hand-made commits carry none. The mixed history is deliberate attribution, not drift — don't add or strip trailers retroactively.
- Contributions from forks must be rebased onto current `main` or cherry-picked — never merged with the GitHub merge button. Older forks carry a divergent history.
- Key files: `main.go` (server, all handlers) · `public/index.html` (markup, `<head>` paint bootstrap, no inline handlers) · `public/js/app.js` (entry point) + `{i18n,parse,render,sse,state,format}.js` · `public/css/{tokens,base,components}.css` (load order matters) · `main_test.go` + `proxytest_test.go` (Go tests) · `package.json` + `tests/` + `playwright.config.js` (JS tests) · `SPEC.md` (the frontend-test contract) · `scripts/screenshots.mjs` (README images) · `.github/workflows/{test,release}.yml`.
- `images/screenshot{,_fa,_ru,_zh}.png` are taken from the real page at 1836 CSS px, 2× DPR, one per locale, showing a **finished scan**: filled tiles, three sorted rows, all three ping colour bands. `/check-stream` is answered from `tests/fixtures/sse-progress.txt`, so every address is from the RFC 5737 documentation range and the pings match what `scan.spec.js` asserts — no live proxy has ever appeared in them, and retaking must keep it that way. `scripts/screenshots.mjs` retakes all four: start the server yourself (`go run .`), then `node scripts/screenshots.mjs`. It deliberately does *not* boot the server the way the e2e suite does — retaking is meant to be looked at, not run unattended.
- Four READMEs (`README.md`, `_FA`, `_RU`, `_ZH`) are intended to be kept in sync — not verified, and they already differ in length (`README_FA.md` is 77 lines against 85 for the other three). The in-app Help button opens the one matching the current UI language.

## Known drift and defects (current state — do not "fix" as a side effect)

The READMEs describe intent, and parts have drifted from the code. Verify against source before trusting them. Confirmed by reading the code:

- **No auth, no CORS policy, no origin check.** The server binds `127.0.0.1:3000` by default (`resolveAddr`); setting `HOST=0.0.0.0` (or a specific address) is the explicit opt-in to wider exposure, and anyone routable can then drive the checker. `PORT` parsing is deliberately lenient (Sscanf error ignored) — preserved behavior, not endorsed design.
- **`main_test.go` still tests a parser nobody runs.** It defines and tests its own local `parseProxyLink` helper. The parser that actually runs is `parseLink` in `public/js/parse.js` — now covered at 100% line and branch by `tests/unit/parse.test.js` plus the golden replay, so the coverage gap is closed, but the duplicated Go helper remains and can drift from the JS one without any test noticing.
- **The Go tests depend on a proxy list that is not in the repo.** `main_test.go` and `proxytest_test.go` read `testdata/proxies.txt` and `t.Skip` when it is absent, so `go test ./...` is largely a no-op on a fresh clone. The JS suites have no such dependency — they run from a synthetic fixture.
- **No Go HTTP handler tests.** No Go test uses `httptest`; `/check`, `/check-batch` and `recoverMiddleware` have zero coverage. `checkProxy` is exercised only by a live-network test that skips when the local proxy list is absent. `/check-stream` is the exception, and only from the outside: the Playwright specs drive the real server, though `scan.spec.js` intercepts the endpoint and only the `E2E_LIVE` smoke test lets a request through to it.
- **The activity-log drawer opens by itself during a scan**, even with nothing logged as an error. Chrome auto-expands a closed `<details>` when script scrolls a descendant, and `log()` has always ended with `c.scrollTop = c.scrollHeight`. Predates the ESM refactor — present on `main` too.
Screenshots were listed here as stale until 2026-08-09; they are not, and the entry had been wrong since `abe2990`. See Repo conventions for how they are taken now.

Every item above is documentation of current state. Fixes go through brainstorming → plan first, not opportunistic edits.

## Agent skills

### Issue tracker

GitHub Issues on `rahgozar94725/MTProto-Checker`, driven by the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical roles, each label string equal to its name. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context — `CONTEXT.md` + `docs/adr/` at the repo root, created lazily by `/domain-modeling`. See `docs/agents/domain.md`.
