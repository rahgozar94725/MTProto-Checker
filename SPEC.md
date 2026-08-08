# Spec: JavaScript test suite for the frontend

Status: **delivered** — merged to `main` 2026-08-08 as PR #20, tip `3b33b76`
Created: 2026-08-08

The body below is the contract as written *before* the work, kept unedited so the
success criteria can still be replayed. Read it as history, not as a description of the
tree: `public/js/script.js` no longer exists (it became `app.js` plus six modules), and
the `CLAUDE.md` quotes it cites were corrected by the same series. Two things the plan
did not anticipate are recorded in `CLAUDE.md` rather than here — the boot-order rule
that the ESM migration made load-bearing, and the coverage gate that turned the 100%
claims into an enforced threshold.

## Objective

`public/js/script.js` (863 lines) carries the entire client: link parsing, SSE stream
decoding, four-locale i18n, results rendering, scan lifecycle, clipboard/export. It has
**zero automated tests**. `CLAUDE.md` already records this as a known defect:

> **The production link parser has zero test coverage.** `main_test.go` defines and tests
> its own local `parseProxyLink` helper; the parser that actually runs is `parseLink` in
> `public/js/script.js`, and there is no JS test harness in the repo.

Goal: a real JS test harness plus tests that cover the logic most likely to break silently.

### Who this serves

The maintainer and any agent editing `public/js/`. Today a change to `parseLink` or to the
SSE frame loop can only be validated by pasting a list into a live browser and eyeballing
the result. After this, `npm test` answers in under a second.

### What success looks like

- Four suites green: link parsing, i18n parity, SSE stream decoding, DOM render/XSS.
- One end-to-end test drives the real embedded UI against the real Go server.
- CI runs both on every push and pull request.
- No user-visible behavior change. The UI works exactly as it does today.

### Non-goals

- Testing Go code beyond what `main_test.go` already does.
- CSS/visual-regression or screenshot-diff tests.
- Testing against live Telegram infrastructure. E2E intercepts `/check-stream`.
- Any bundler, transpiler, minifier, or TypeScript. The zero-build-step rule stands.

## Tech Stack

| Concern | Choice | Why |
|---|---|---|
| Unit runner | `node:test` + `node:assert/strict` (Node ≥ 22; local is v26.5.0) | Built in. Zero runtime dependency. |
| DOM for unit tests | `jsdom` (devDependency) | Renders the real `public/index.html`, so tests bind to real IDs. |
| E2E | `@playwright/test` (devDependency, Chromium only) | Drives the real Go binary serving the real embedded assets. |
| Module system | Native ES modules, no bundler | Browsers and Node both load the same files unchanged. |

Total production dependencies added: **zero**. Total devDependencies: **two**.

## Prerequisite refactor: `script.js` → ES modules

Tests can't reach `parseLink` today: it is a bare function in a classic script that also
performs top-level DOM mutation on load. The agreed approach is a full ESM split.

### Target module layout

```
public/js/
  i18n.js       translations (all four locales) + t(lang, key) + interpolate(str, vars)
  parse.js      parseLink, parseProxyList, proxyKey, isAcceptedFilename, ACCEPTED_EXTENSIONS
  sse.js        createSSEParser() — pure incremental frame decoder
  format.js     proxyLine, pingClass, formatBytes-free helpers
  render.js     resultCell, renderResultsTable, renderStats, setResultsView, showToast
  state.js      scan state container (workingProxies, checkedKeys, scanState, isPaused, …)
  app.js        entry point: boot, event wiring, startCheck/stopScan/togglePause/runCheckStream/finish
```

`public/index.html` line 163 becomes:

```html
<script type="module" src="/js/app.js"></script>
```

### Two behavior-preserving changes the split forces

**1. Inline handlers must go.** A module's top-level scope is not `window`, so every inline
handler in `index.html` breaks the moment `type="module"` is added. All eleven must migrate
to `addEventListener` in `app.js`:

| Element | Current attribute |
|---|---|
| `#themeToggle` | `onclick="toggleTheme()"` |
| `#langSelect` | `onchange="changeLanguage(this.value)"` |
| `#helpBtn` | `onclick="openHelp()"` |
| `#startBtn` | `onclick="handleStartStop()"` |
| `#pauseBtn` | `onclick="togglePause()"` |
| `#fileInput` | `onchange="handleFileUpload(event)"` |
| `#viewTableBtn` | `onclick="setResultsView('table')"` |
| `#viewTextBtn` | `onclick="setResultsView('text')"` |
| `.btn-copy` | `onclick="copyResults()"` |
| `.btn-export` (TXT) | `onclick="exportResults('txt')"` |
| `.btn-export` (JSON) | `onclick="exportResults('json')"` |

The three unnamed buttons gain IDs: `#copyBtn`, `#exportTxtBtn`, `#exportJsonBtn`.
This retires the fragility `CLAUDE.md` warns about ("renaming a top-level function in
`script.js` silently breaks the button"), and the e2e test clicks all eleven.

**2. `parseLink` stops mutating a global.** It currently does `skippedCount++` for spam
secrets, which makes it untestable in isolation. New contract:

```js
// parse.js — pure, no module-level mutable state
export function parseLink(line) {
  // → { ok: true, proxy: { server, port, secret, original } }
  // → { ok: false, reason: 'no-scheme' | 'malformed' | 'bad-port' | 'spam' }
}

export function parseProxyList(text) {
  // → { proxies: [...], skipped: number, duplicates: number }
  // `skipped` counts ONLY reason === 'spam', matching today's #tileSkipped semantics.
}
```

Exact behavior to preserve — these are the current rules and the tests assert them:

- `.&` is rewritten to `&` before parsing (typo fix).
- A line without `://` is rejected outright.
- `server`, `port`, `secret` are all required; `port` must parse as an integer in 1–65535.
- A secret longer than 170 chars, or containing `AAAAAAAAAAAAAAAAAAAA`, is *spam* — it
  counts toward `skipped`. A merely malformed line does **not**.
- Dedup key is `` `${server}:${port}:${secret}` ``, first occurrence wins.
- `original` is the trimmed, `.&`-fixed line — it carries the secret and must survive to
  every copy/export path.

### The SSE parser gets pulled out

The frame loop currently lives inside `runCheckStream` (lines 441–483) and cannot be
reached without mocking `fetch` and a `ReadableStream`. Extract it:

```js
// sse.js
export function createSSEParser() {
  let buffer = '';
  return {
    // Feed a decoded chunk; get back zero or more complete { event, data } frames.
    // Holds a partial trailing frame across calls.
    push(chunk) { /* … */ },
  };
}
```

`data` stays a raw string — `JSON.parse` remains the caller's job, so a malformed payload
throws where it throws today.

## Commands

```bash
npm install                   # installs jsdom + @playwright/test
npx playwright install chromium

npm test                      # unit suites only (fast, no browser, no network)
npm run test:unit             # same as npm test
npm run test:watch            # node --test --watch tests/unit
npm run test:coverage         # unit suites with coverage report
npm run test:e2e              # Playwright; boots `go run .` itself
npm run test:all              # unit + e2e

go test ./... -short          # unchanged; Go tests stay independent
gofmt -l .                    # expected clean
go vet ./...                  # expected clean
```

Underlying invocations, for reference:

```
test:unit      node --test tests/unit/
test:coverage  node --test --experimental-test-coverage tests/unit/
test:e2e       playwright test
```

The coverage flag name must be verified against `node --help` during implementation — it
has moved between Node releases.

## Project Structure

```
package.json              devDependencies + scripts + "type": "module"
playwright.config.js       webServer: `go run .`, NO_BROWSER=1, Chromium only
tests/
  unit/
    parse.test.js          parseLink / parseProxyList / dedup / isAcceptedFilename
    i18n.test.js           four-locale key parity + placeholder parity
    sse.test.js            createSSEParser frame decoding
    format.test.js         proxyLine, pingClass thresholds
    render.test.js         renderResultsTable / renderStats / setResultsView (jsdom)
    lifecycle.test.js      startCheck → progress → finish, pause/resume/stop (jsdom + stub fetch)
  e2e/
    scan.spec.js           full happy path against the real server, /check-stream intercepted
    controls.spec.js       every one of the eleven migrated handlers fires
  fixtures/
    proxies-dirty.txt      realistic messy paste: valid, malformed, spam, duplicates
    sse-progress.txt       a recorded /check-stream response body
  helpers/
    dom.js                 loads public/index.html into jsdom, imports app.js, returns handles
    sse.js                 builds SSE response bodies and chunk-splits them arbitrarily
```

**Hard constraint: nothing test-related may live under `public/`.** `main.go:30` is
`//go:embed public`, so any file placed there is baked into the ~20 MiB release binary.
`package.json`, `node_modules/`, and `tests/` all sit at the repo root.

`.gitignore` gains: `node_modules/`, `coverage/`, `test-results/`, `playwright-report/`,
`.playwright/`.

## Code Style

Match the existing frontend: 4-space indent, single quotes, semicolons, `const`/`let`, no
semicolon-free style, comments that explain *why* rather than *what*.

Production module — pure, explicit, no hidden state:

```js
// parse.js
const SPAM_SECRET_RUN = 'AAAAAAAAAAAAAAAAAAAA';
const MAX_SECRET_LEN = 170;

export function parseLink(line) {
    const cleanLink = line.trim().replace('.&', '&');
    if (!cleanLink.includes('://')) return { ok: false, reason: 'no-scheme' };

    let params;
    try {
        params = new URLSearchParams(new URL(cleanLink).search);
    } catch {
        return { ok: false, reason: 'malformed' };
    }

    const server = params.get('server');
    const secret = params.get('secret');
    const port = parseInt(params.get('port'), 10);

    if (!server || !secret || !port || Number.isNaN(port)) return { ok: false, reason: 'malformed' };
    if (port <= 0 || port > 65535) return { ok: false, reason: 'bad-port' };

    // Public spam lists pad secrets with a long AAAA… run; those hosts never answer.
    if (secret.length > MAX_SECRET_LEN || secret.includes(SPAM_SECRET_RUN)) {
        return { ok: false, reason: 'spam' };
    }

    return { ok: true, proxy: { server, port, secret, original: cleanLink } };
}
```

Test — one behavior per `test()`, name states the rule, no shared mutable fixture:

```js
// tests/unit/parse.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLink, parseProxyList } from '../../public/js/parse.js';

test('rejects a port above 65535', () => {
    const r = parseLink('tg://proxy?server=1.2.3.4&port=70000&secret=ee00');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'bad-port');
});

test('spam secrets count as skipped, malformed lines do not', () => {
    const { proxies, skipped } = parseProxyList([
        'tg://proxy?server=1.2.3.4&port=443&secret=ee' + 'A'.repeat(200),
        'not a link at all',
        'tg://proxy?server=5.6.7.8&port=443&secret=ee11',
    ].join('\n'));

    assert.equal(proxies.length, 1);
    assert.equal(skipped, 1);
});
```

Assertion style: `node:assert/strict` only — `assert.equal`, `assert.deepEqual`,
`assert.throws`. No custom matcher library.

## Testing Strategy

### Level 1 — pure unit (no DOM, no network)

`parse.test.js`, `sse.test.js`, `format.test.js`, `i18n.test.js`. Import the module,
call the function, assert. These must stay millisecond-fast.

**Link parsing** — the highest-value suite, since this code has never been tested:
- valid `tg://` and `https://t.me/proxy?...` forms
- `.&` typo repair
- missing scheme, missing each of the three params, non-numeric port
- port boundaries: `0`, `1`, `65535`, `65536`, `70000`, `-1`
- spam secret by length (>170) and by `AAAA…` run; `skipped` counts these and only these
- dedup by `server:port:secret`, first occurrence wins, `duplicates` counted
- `original` round-trips the secret intact
- CRLF input, blank lines, trailing whitespace, a 1000-line list
- hostile input: `javascript:` scheme, unicode host, `server` containing `<script>`

**i18n parity** — cheap and catches a recurring class of bug (`CLAUDE.md`: "Adding UI text
means adding the key to **all four** locales"):
- `fa`, `en`, `ru`, `zh` have byte-identical key sets; the failure message names the
  missing keys per locale
- every key present in `index.html` as `data-i18n="…"` exists in all four locales
- `toastFound` contains `{n}` in all four; `summaryLoaded` contains both `{n}` and `{m}`
- no value is an empty string

**SSE parsing** — where the subtle bugs hide:
- one complete frame in one chunk
- two frames in one chunk
- a frame split across two chunks, and split mid-`data:` line
- `\n\n` arriving as the sole content of a chunk
- `event: progress` and `event: done` both recognized
- a frame with no `data:` line yields nothing
- blank/whitespace-only frames ignored
- the trailing partial frame stays buffered and is not emitted early

**Formatting**:
- `proxyLine` is exactly `` `${link} # Ping: ${ping}ms` ``
- `pingClass` thresholds: `179 → p-fast`, `180 → p-mid`, `299 → p-mid`, `300 → p-slow`, `0 → p-fast`

### Level 2 — DOM unit (jsdom)

`tests/helpers/dom.js` loads the real `public/index.html`, so a renamed ID fails a test
instead of failing silently in production.

`render.test.js`:
- `renderResultsTable` produces one `<tr>` per proxy, cells in order rank/server/port/ping/copy
- **XSS: a server value of `<img src=x onerror=alert(1)>` appears as text, creates no
  element.** This is the load-bearing safety property — server/port come from pasted URLs.
- `data-index` on each `.rowcopy` matches array position
- ping badge class comes from `pingClass`
- `renderStats` writes all six tiles; `tileBest` is `—` at zero results
- `setResultsView` flips `data-view` and both `aria-pressed` values
- rendering 500 rows replaces children wholesale, leaving no stale rows

`lifecycle.test.js` (stubbed `fetch` returning a scripted `ReadableStream`):
- `startCheck` on empty input shows the empty toast and posts nothing
- an all-invalid paste shows the no-valid toast and posts nothing
- a scan posts `X-Concurrency` and per-proxy `timeout` matching the selects
- `ok: true` events land in `workingProxies`, sorted ascending by ping
- results survive `stopScan`; the input pane is restored
- pause aborts in flight and keeps the input collapsed; resume re-posts **only** the
  proxies absent from `checkedKeys`
- `finish` with zero working results shows the no-working toast and does not beep
- coalesced rendering: N progress events in one tick cause one `renderResultsTable`

### Level 3 — E2E (Playwright, real Go server)

`playwright.config.js` starts the server itself:

```js
webServer: {
    command: 'go run .',
    url: 'http://127.0.0.1:3000',
    env: { NO_BROWSER: '1' },
    reuseExistingServer: !process.env.CI,
}
```

`NO_BROWSER=1` is required or the server opens a real browser window on every run
(`shouldOpenBrowser` in `main.go`).

`/check-stream` is intercepted with `page.route()` and answered from a fixture, so e2e is
deterministic and touches no Telegram server. Covered:
- paste a dirty list → start → progress bar advances → tiles update → table fills
- table/plain-text toggle shows the same data both ways
- TXT and JSON downloads contain the secret-bearing links
- language switch to each of the four locales re-labels the UI and the table headers
- theme toggle persists across reload
- all eleven migrated handlers fire (guards the inline-handler migration)

Optionally, a `@live` smoke test hits the real `/check-stream` with a bogus proxy and
asserts a clean all-failed run. Skipped unless `E2E_LIVE=1`.

### Coverage expectations

| Module | Target |
|---|---|
| `parse.js`, `sse.js`, `format.js`, `i18n.js` | 100% line and branch |
| `render.js` | ≥ 90% line |
| `state.js` | ≥ 90% line |
| `app.js` | excluded from unit coverage; covered by e2e |

Coverage is reported, not gated in CI initially. Gating is a follow-up decision.

## CI

New `.github/workflows/test.yml`, on `push` and `pull_request`:

```
job: js      — actions/setup-node (Node 22 LTS), npm ci, npm test
job: go      — actions/setup-go (go-version-file: go.mod), go vet ./..., go test ./... -short, gofmt -l .
job: e2e     — both toolchains, cached Playwright browsers, npm run test:e2e; uploads the report on failure
```

`release.yml` is untouched. `gofmt -l .` must print nothing — `.gitattributes` pins LF, so
this is meaningful cross-platform.

Note: the Go job runs `-short`, which skips the live Telegram handshake tests. Those also
skip anyway on CI because `testdata/proxies.txt` is not in the repo.

## Boundaries

### Always

- Run `npm test` and `go test ./... -short` before every commit.
- Keep the refactor behavior-preserving. If a test documents current behavior that looks
  wrong, keep the behavior, write the test, and note the smell — don't fix it here.
- Add a new UI string to **all four** locales; `i18n.test.js` enforces it.
- Use `textContent`, never `innerHTML`, anywhere attacker-controlled strings reach the DOM.
- Keep tests and `node_modules/` outside `public/` — `//go:embed public` bakes that tree
  into the release binary.
- Conventional Commits with the existing scopes: `refactor(frontend):`, `test(frontend):`,
  `build(ci):`, `chore(deps):`.

### Ask first

- Any npm dependency beyond `jsdom` and `@playwright/test`.
- Any user-visible change discovered to be necessary during the refactor.
- Splitting differently from the seven modules above.
- Turning coverage into a hard CI gate.
- Updating the four READMEs (they are already out of sync by design; `CLAUDE.md` is the
  single source of truth and *does* need editing here).

### Never

- Touch `sharedSession` in `main.go`. `CLAUDE.md` documents measured evidence that
  per-check session storage drops detection from 99/1022 to 0/1022.
- Change the `/check-stream` wire format. Tests adapt to the server, not the reverse.
- Commit `node_modules/`, `coverage/`, `test-results/`, or `playwright-report/`.
- Introduce a bundler, transpiler, minifier, or TypeScript. Browsers load `public/js/*.js`
  verbatim; that property is the point.
- Delete or `skip` a failing test to make CI green.
- Hit live Telegram infrastructure from a default test run.
- Retroactively add or strip commit trailers on existing history.

## Documentation updates this requires

Two `CLAUDE.md` statements become false and must be corrected in the same series:

1. "Handlers are wired as inline `onclick`/`onchange` attributes in `index.html`, not
   `addEventListener`" — inverted by the ESM migration.
2. "The production link parser has zero test coverage" and "there is no JS test harness in
   the repo" — both resolved.

`CLAUDE.md` also needs a new Commands entry for the npm scripts, an Architecture note on
the module layout and load order, and a note that `.github/workflows/release.yml` is no
longer the only CI.

## Success Criteria

1. `npm test` passes and finishes in under 5 seconds on a cold run.
2. `npm run test:e2e` passes against `go run .` with no network access to Telegram.
3. `parse.js`, `sse.js`, `format.js`, `i18n.js` each report 100% line and branch coverage.
4. `go build -o mtproto-checker .` succeeds and the binary contains no test artifacts —
   verified by grepping the binary for `node_modules` and `playwright` (zero hits) and by
   checking the size stays near the ~20.6 MiB baseline.
5. Manual parity check in a real browser: paste a dirty list, scan, pause, resume, stop,
   toggle both views, copy a row, export TXT and JSON, switch all four languages, toggle
   the theme — behavior identical to `main` at `ce02714`.
6. Deliberately breaking `pingClass`'s 180 ms threshold fails a test; deliberately dropping
   one `zh` translation key fails a test; deliberately switching a result cell to
   `innerHTML` fails the XSS test.
7. CI is green on a pull request from a branch.
8. `CLAUDE.md` reflects the new reality; no README claims are left contradicted.

## Risks

| Risk | Mitigation |
|---|---|
| `type="module"` silently kills all eleven inline handlers | Migrate them in the same commit; `controls.spec.js` clicks every one |
| Module scripts are deferred; theme now applies later, possibly flashing | Verify in a real browser; if it flashes, set `data-theme` from an inline `<head>` script before CSS paints |
| A seven-module split changes evaluation order and breaks boot-time side effects (`setLanguage`, `loadSettings`, `wireDropZone`) | `app.js` owns all boot ordering explicitly; `lifecycle.test.js` asserts post-boot DOM state |
| The `parseLink` purity change alters `skippedCount` semantics | `parse.test.js` pins spam-vs-malformed counting before the refactor lands |
| Eleven HTTP requests instead of one on page load | Localhost only, no build step; measure, and only reconsider if it is visible |
| Playwright browser download slows CI | Cache `~/.cache/ms-playwright`; Chromium only |
| Refactor is large enough to hide a regression | Land it as a separate reviewable commit before any test commit, then verify by hand against `ce02714` |

## Open Questions

1. **Refactor and tests: one commit series or two branches?** Recommendation: one branch,
   commit 1 = ESM refactor + handler migration (no test files), commits 2–6 = one suite
   each. That keeps the risky commit reviewable in isolation.
2. **Tests before or after the refactor?** The pure-parser tests can be written against
   today's `script.js` via a text-eval shim, then re-pointed at `parse.js` — which proves
   the refactor preserved behavior. Costs one throwaway shim. Worth it?
3. **Node version in CI** — 22 LTS, or 24? Local is 26.5.0. Recommendation: 22 LTS for the
   widest floor, since the code targets no Node runtime in production.
4. **`node --test` coverage flag** — needs confirming against the CI Node version.
5. **Should `tests/fixtures/proxies-dirty.txt` contain real proxy links?** Recommendation:
   synthetic, RFC 5737 documentation addresses (`192.0.2.0/24`), never a real host.
6. **Is a `@live` e2e smoke test wanted at all,** or does no test ever touch the network?
