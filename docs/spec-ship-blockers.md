# Spec: close the three ship blockers on `feat/snapshot-builder`

Status: **proposed**
Created: 2026-08-10
Branch: `feat/snapshot-builder`

Written before the work, from the `/ship` fan-out over the branch (code-reviewer,
security-auditor, test-engineer). `SPEC.md` at the repo root is a different,
already-delivered contract and is not touched by this one.

## 1. Objective

Three defects block the release of `feat/snapshot-builder`. Two of them are
security controls that the branch states it enforces and does not; the third is
a control the branch never had and now needs, because this branch is what makes
its absence exploitable. Close all three without changing any behaviour the
branch was built to deliver.

Target users: anyone running the released binary on their own machine — the
default deployment, `127.0.0.1:3000`, no auth. Every blocker below is reachable
in exactly that default configuration.

Non-goals: the nine recommended fixes and the test-coverage backlog from the
same review. They are tracked separately and are not part of this spec.

### B1 — No origin check on any POST handler

`main.go:988` (and `:698`, `:736`, `:844`) decode the request body without
looking at `Origin`, `Sec-Fetch-Site` or `Content-Type`. `Content-Type:
text/plain` is CORS-safelisted, so an HTML form on any site the user visits
reaches these endpoints with no preflight and no JavaScript:

```html
<form action="http://127.0.0.1:3000/fetch-sources" method="POST" enctype="text/plain">
  <input name='{"urls":["http://example.com/"],"socks5":{"addr":"127.0.0.1:22"},"pad":"' value='"}'>
</form>
```

The `=` separator lands inside a string value, so the bytes a `text/plain` form
emits are valid JSON. The response is unreadable cross-origin, but the side
effect fires and `fetch(..., {mode:'no-cors'})` resolves on arrival, so response
timing is readable. Measured against the running server: `127.0.0.1:3000` (open)
30124 ms, `127.0.0.1:9` (closed) 222 ms, `10.255.255.1:80` (filtered) 10129 ms —
a three-state port-scan oracle over loopback and RFC1918, from the victim's
machine.

What makes this a blocker rather than a restatement of the documented "no auth,
no CORS policy, no origin check" entry: the SSRF design notes accept an unchecked
`socks5.addr` on the reasoning that blocking loopback there would block the local
Tor/tunnel proxies the feature exists for. That reasoning assumes the address
comes from the user. Without an origin check it comes from whoever can POST.

### B2 — The snapshot anti-pinning guard is bypassed by a repeated source id

`public/js/snapshot.js:99` compares `Number(meta[1]) === srcs.length` against the
raw split, not the distinct count, so a line ending `#seen=32;src=0,0,0,…,0`
is accepted with `seen: 32`. `orderForScan` sorts on `seen` before source score,
so one such line pins a chosen proxy to the head of every user's next scan —
which is verbatim what the comment above that line says must not be possible.
`FRAGMENT_RE`'s 32-id cap is the only ceiling today.

Reachable by anyone who can write the `snapshot` orphan branch, which is what the
whole drift-guard and checksum apparatus exists to bound.

### B3 — `checkSOCKS5Destination` resolves through a primeable cache

`main.go:234` calls `cachedLookupHost`, whose entries live 5 minutes regardless
of record TTL and are also written by `tcpCheck` (`main.go:418`) from a fully
caller-supplied hostname. So: POST `/check` with `{"server":"evil.test",…}` while
that name resolves to a public address; within 5 minutes POST `/fetch-sources`
with the same name and a SOCKS5 config. The destination check reads the stale
public answer and allows it, while the proxy resolves the name fresh at connect
time and reaches wherever it now points.

The direct path is immune because its check is the dialer's `Control` hook, which
sees the address actually being dialled. This leg has no dial hook, which is why
its resolution has to be fresh instead.

## 2. Commands

No new commands. The existing gates are the acceptance evidence:

```bash
go vet ./...
gofmt -l .                        # must print nothing
go test ./... -short              # 55 pass on the branch today
go test ./... -short -race
npm run test:unit                 # 307 pass on the branch today
npm run test:coverage:ci          # 100% lines and branches, gate must hold
npm run test:e2e                  # 21 pass, 1 skipped
```

`npm run test:e2e` is load-bearing for B1 specifically: it is the only gate that
drives the endpoints from a real browser, so it is what proves the guard does not
reject the app's own requests.

## 3. Project structure

Files this spec may change, and nothing else:

| File | Change |
|---|---|
| `main.go` | New `sameOriginOnly` middleware; applied to all four POST handlers in `newMux`. `checkSOCKS5Destination` resolves directly instead of through `dnsCache`. |
| `public/js/snapshot.js` | Dedupe `srcs` before the length comparison. |
| `handlers_test.go` | Origin-guard tests for all four endpoints. |
| `fetchsources_test.go` | Origin-guard test on `/fetch-sources`; the fresh-resolution and fail-open tests for `checkSOCKS5Destination`. |
| `tests/unit/snapshot.test.js` | Repeated-id rejection; distinct-id acceptance unchanged. |
| `CLAUDE.md` | Amend the "No auth, no CORS policy, no origin check" known-drift entry, the `/fetch-sources` SSRF rules, and the `dnsCache` shared-state note. |

The middleware goes in `newMux`, not `main()`. `newMux` is the documented test
seam; a guard applied in `main()` is a guard no test can reach.

## 4. Code style

- Match the surrounding file. `main.go` comments explain *why* a rule exists and
  what breaks without it, often at paragraph length; the new middleware carries
  the same, including why absent headers are allowed.
- Guard order is `recoverMiddleware(sameOriginOnly(handler))` — the origin check
  runs inside the panic recovery, not outside it.
- Rejections use `jsonResponse(w, http.StatusForbidden, map[string]string{"error": …})`,
  matching the 400/413 shape the same handlers already return. Not `http.Error`.
- No new dependencies. No new env vars. No new config surface.
- Conventional Commits, one commit per blocker, `fix(security):` scope for B1 and
  B3, `fix(snapshot):` for B2.

## 5. Behaviour spec and acceptance criteria

### B1 — `sameOriginOnly`

Applies to `/check`, `/check-batch`, `/check-stream`, `/fetch-sources`.

Reject with `403` when either holds:

1. `Sec-Fetch-Site` is present and is neither `same-origin` nor `none`.
2. `Origin` is present and equals neither `http://` + `r.Host` nor `https://` + `r.Host`.

Allow when both headers are absent. This is deliberate and is what keeps the
documented `POST /check` scripting API usable: `curl` and scripts send neither
header, browsers send `Sec-Fetch-Site` on every request. The guard is a browser
control, not authentication, and must not be described as one.

Acceptance:

- [ ] `Sec-Fetch-Site: cross-site` → 403 with a JSON `error` body, on all four endpoints.
- [ ] `Sec-Fetch-Site: same-site` → 403 (a subdomain is not this origin).
- [ ] `Sec-Fetch-Site: same-origin` and `Sec-Fetch-Site: none` → handled normally.
- [ ] `Origin: https://evil.test` with no `Sec-Fetch-Site` → 403.
- [ ] `Origin: http://<r.Host>` → handled normally.
- [ ] Neither header → handled normally (the scripting path).
- [ ] `/check-stream` rejects **before** any SSE byte is written — the response is
      plain JSON, same as its existing pre-commit rejections.
- [ ] The rejection precedes body decoding, so an oversized cross-origin body is
      refused without being read.
- [ ] `npm run test:e2e` stays green: the app's own requests are not rejected.

### B2 — distinct source ids

```js
const srcs = [...new Set(meta[2].split(',').map(Number))];
```

The comparison and the stored `seen` both read the deduped length, so a line
whose declared `seen` no longer matches its distinct id count is dropped, which
is the existing behaviour for a mismatched line.

Acceptance:

- [ ] `#seen=32;src=0,0,…,0` (32 repeats) yields no attribution entry.
- [ ] `#seen=2;src=0,0` yields no attribution entry.
- [ ] `#seen=1;src=0,0` — one distinct id, declared 1 — is accepted with `seen: 1`.
      State explicitly whether this is intended; it is the one case dedupe makes
      *more* permissive than today.
- [ ] Every line `scripts/build-snapshot.mjs` emits still round-trips unchanged
      (the builder already dedupes, so this must be a no-op for real snapshots).
- [ ] `parseSnapshot` stays total — no throw on any malformed fragment.
- [ ] `snapshot.js` holds 100% line and branch coverage; the gate does not move.

### B3 — fresh resolution on the SOCKS5 leg

`checkSOCKS5Destination` resolves with `net.Resolver.LookupIPAddr` under its own
5-second context instead of `cachedLookupHost`. It runs at most `maxSources` (20)
times per request, so the cache saves nothing here.

The fail-open on resolution error (`return nil`) **stays**. It is what lets a name
only the proxy can resolve reach the proxy, which is the case the feature exists
for. It is currently untested and must not be silently flipped.

Acceptance:

- [ ] A destination name resolving to a blocked address is rejected even when
      `dnsCache` holds an allowed entry for that name — the test primes the cache
      directly, then asserts the rejection.
- [ ] A resolution failure still allows the fetch (fail-open pinned in a test, in
      both directions, with a comment saying why).
- [ ] A literal blocked address is still rejected without any resolution.
- [ ] The existing `fetchsources_test.go` SOCKS5 cases stay green unchanged.
- [ ] `go test ./... -short -race` green — this touches a path that reads shared
      state today and stops reading it.

### Cross-cutting

- [ ] All commands in §2 green, output quoted in the completion report rather
      than summarised.
- [ ] Coverage gate holds at 100% lines and branches on the gated modules.
- [ ] `CLAUDE.md` amended in the same commits, not afterwards: the known-drift
      entry now overstates the exposure, the SSRF rules gain a sixth bullet, and
      the `dnsCache` note should record that it is written by the check endpoints
      and no longer read by the SSRF check.

## 6. Boundaries

**Always**

- Verify each fix against the actual failure it closes — re-run the scenario in
  §1, do not infer from the diff.
- Keep the documented `POST /check` scripting API working without headers.
- Keep every load-bearing rule in `CLAUDE.md` intact: `sharedSession`, the
  `checkCtx.Err()` check, the no-space-before-`#` line grammar, the two button
  systems, the `app.js` wiring-before-paint order.
- Update `CLAUDE.md` in the same commit as the behaviour it describes.

**Ask first**

- Any change to the four endpoints' success-path behaviour, request shape or
  status codes beyond the new 403.
- Rejecting non-JSON `Content-Type`. It would close the form vector a second
  time, and it would also break any existing script that posts without the
  header — a real compatibility decision, not an implementation detail.
- Bounding `socks5.addr` to loopback-plus-public. It is the auditor's second
  recommendation and it narrows a documented accepted residual; worth doing,
  but it is a scope change, not one of these three.
- Touching `SPEC.md`, the delivered contract at the repo root.

**Never**

- Treat the origin guard as authentication, or let it become the reason a real
  auth story is skipped. It stops a browser the victim is driving; it stops
  nothing that can set its own headers.
- Flip `checkSOCKS5Destination`'s fail-open to fail-closed as a "hardening"
  side effect — that silently kills proxy-only source names.
- Regenerate `scripts/snapshot-baseline.json`, force-push the `snapshot` branch,
  or retake screenshots as part of this work.
- Widen `blockedSourceNets`. The `want=false` rows in
  `TestBlockedSourceIPCoversTheReservedRanges` exist to stop exactly that.
- Ship any of the three without a test that fails before the fix and passes
  after it.
