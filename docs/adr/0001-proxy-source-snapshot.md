# 1. Ship a nightly proxy-source snapshot inside the binary

- **Status:** accepted
- **Date:** 2026-08-10
- **Supersedes:** nothing
- **Implemented by:** `feat/snapshot-builder` (tasks 1–14)

## Context

Until now the tool did nothing until the user pasted a list. Finding one is the hard part
of the job, and the people who need the tool are the people whose network is most likely to
block the places the lists live: `raw.githubusercontent.com` serves the seventeen public
lists this project draws on, and it is not reliably reachable from inside a filtered region.
It also serves no CORS headers, so a page cannot fetch it directly even where the network
allows it.

So the question was not "which list should the page fetch" but "how does a list reach a
machine that cannot fetch lists".

## Decision

Aggregate in CI, ship the result in the binary, and refresh it at runtime through the
server rather than the page.

```
nightly (GitHub Actions, unfiltered)
    17 sources → parse with public/js/parse.js → dedupe → snapshot.txt
    → force-push to the orphan branch `snapshot`

release (v* tag)
    release.yml curls that branch into public/data/ before `go build`
    → //go:embed public bakes it in

runtime ("Load list")
    1. POST /fetch-sources with the one snapshot-branch URL   (server-side, optional SOCKS5)
    2. on failure, GET /data/snapshot.txt                     (the baked copy)
    3. plus any sources the user added themselves
    → the textarea is filled; the user presses Start
```

The load-bearing property is that **the client fetches one URL, not seventeen**. Aggregation
is CI's job, and CI is not filtered. The second load-bearing property is that the fetch
happens in the Go process, which is subject to neither CORS nor the browser's network
policy, and which can be pointed at a SOCKS5 proxy the user already runs.

### What this pulled in

- `scripts/build-snapshot.mjs` — the nightly builder. It imports `parseLink`/`proxyKey`
  from `public/js/parse.js` and `DEFAULT_SOURCES`/`shortUrl` from `public/js/sources.js`;
  it never reimplements either. `main_test.go` already carries a duplicate Go parser that
  `CLAUDE.md` flags as drift-prone, and a third copy was not acceptable.
- `.github/workflows/snapshot.yml` — schedule + `workflow_dispatch`, `contents: write`, no
  `push` trigger. It builds in a throwaway repository under `$RUNNER_TEMP` and force-pushes
  a single-commit history, so the published branch cannot pick up a stray working-tree file.
- `public/data/snapshot.txt` — a **synthetic** placeholder using RFC 5737 documentation
  addresses, so a fresh clone runs and no live proxy is ever committed. `release.yml`
  overwrites it in the runner's checkout before the compiler reads it.
- `public/js/snapshot.js` — parses the snapshot grammar. Total by contract: a missing
  header, an unparseable body or an undeclared `src=` id yields empty structures, never a
  throw.
- `public/js/sources.js` — the source model (`{url, enabled, addedByUser}`, plus `score`
  after a scan), keyed by **url**, not by index: the nightly rebuild is free to reorder
  sources and an index-keyed model would silently repoint a score.
- `POST /fetch-sources` in `main.go` — `{urls, socks5?}` in, concatenated text out, with a
  scheme allowlist, a resolve-then-check destination policy, per-source caps and a SOCKS5
  retry.

## Measurements

Everything below was measured, not estimated. The scripts lived in a session scratchpad and
are gone; the numbers are the durable part.

### Phase 0 — the corpus (2026-08-09)

All 17 sources returned `200`, 233 KB total, ~2.3 s wall-clock fetched in parallel.

| metric | value |
|---|---|
| sum of per-source uniques | 1866 |
| **globally unique after dedupe** | **784** |
| snapshot size incl. `#seen=…;src=…` metadata | **0.10 MiB** |
| full scan, concurrency 50, timeout 5 s | 78.2 s |

The pre-measurement estimate was 20 000–60 000 links and 2–11 MiB. It was wrong by roughly
50×, and every size-driven decision below died with it.

### Staleness — measured at one day, and only one day

Re-scanned at **t+23.2 h** against the same 784-proxy universe, same server, concurrency 50,
timeout 5 s:

| scan | input | session | working | rate |
|---|---|---|---|---|
| `fresh-control` | snapshot built that minute | warm | 310/790 | 39.2 % |
| `t24b` | the 23-hour-old universe | warm | 303/785 | 38.6 % |
| `t24c` | the same, again | warm | 278/785 | 35.4 % |

One day of age costs approximately nothing. That is why the baked snapshot is presented as a
headline feature rather than a fallback, why `.btn-load` is styled at full strength instead
of as a peer of `.btn-file`, and why the generation date is shown as provenance rather than
as a warning.

The planned t+72 h leg was **dropped by decision on 2026-08-10 and never run**. There is no
decay curve. Nothing here says how a snapshot ages past 24 hours.

### The redundancy signal — measured twice, in opposite directions

This is the finding most likely to be "fixed" back to the wrong answer, so it is recorded in
full.

Phase 0 found redundancy **anti**-predicting liveness: `seen=1` at 24.3 % (86/354), `seen=2`
at 7.4 % (14/190), `seen=3–9` at **0.0 %** (0/240). It survived the obvious objection —
excluding the ten small `V2RAYCONFIGSPOOL` sources entirely, `seen=1` still scored 20.0 %
against `seen>=2` at 1.9 %. `snapshotLines()` was written to sort **ascending** by `seen`
because of it, and file order is scan order.

The 2026-08-10 re-scan did not reproduce it. Two warm runs over the same universe both show
a clean monotonic gradient the other way:

| seen in N sources | n | `t24b` rate | `t24c` rate |
|---|---|---|---|
| 1 | 354 | 24.0 % | 24.3 % |
| 2 | 190 | 18.4 % | 14.7 % |
| 3 | 54 | 51.9 % | 42.6 % |
| 4 | 55 | 74.5 % | 47.3 % |
| 5 | 69 | 82.6 % | 81.2 % |
| 6 | 37 | 91.9 % | 94.6 % |
| 7 | 19 | 94.7 % | 94.7 % |
| 8 | 4 | 100.0 % | 100.0 % |
| 9 | 2 | 50.0 % | 100.0 % |

`seen>=5` runs 81–100 %; `seen<=2` runs 15–24 %. Reproduced across two independent runs, and
not a scan-order artifact — `universe.json` was not sorted by `seen` (its first entries are
`seen` 0, 6, 8, 7), so the gradient is not tracking warm-up position.

**Redundancy predicts life.** `snapshotLines()` was flipped to descending `seen` (`11a12a6`),
tie-break still ascending by key so the nightly diff stays readable, and Task 10's
`orderForScan()` sorts most-redundant first. Both directions now point the same way.

#### Why the two measurements disagreed

The deciding variable was **session warmth, not the data**. Both Phase 0 runs started from a
freshly-launched server with an empty `sharedSession`; the first re-scan, also cold, returned
**1/785 = 0.1 %** on input that scored 38.6 % minutes later in the same slot. Two cold runs
on comparable input disagreeing by two orders of magnitude is the whole story: the mechanism
is not established, but the regime that produced the inversion is the same regime that
produced the outlier.

Consequence: **12.8 % is a floor, not the rate** — the warm rate on the same corpus is
35–39 %. And, generally: **a single scan's absolute working rate is not a measurement.** Any
future comparison must run both arms back to back inside one warm session, or it is
worthless. This compounds with the `sharedSession` rule already in `CLAUDE.md`.

### Caveats that travel with every number above

- **The scans ran through a VPN.** Both the source fetches and the MTProto handshakes went
  out through a foreign exit. The relative findings (source ranking, the redundancy
  gradient) are probably robust; the absolutes are foreign-vantage numbers, and the rate for
  a user connecting from inside a filtered region is **unmeasured**. This is the same
  objection that rules out CI-side liveness filtering below.
- One machine, one network, one moment, in a codebase that already documents a
  throttle-poisoned-slot effect on scan outcomes.

### Liveness by source, and why the toggle exists

Per-source working rates spanned 0 % to 64.3 %. Two sources contributed 421 links and **zero**
working proxies. The ten small `V2RAYCONFIGSPOOL` sources contributed 145 links (8 % of the
corpus) and 31 working proxies (31 % of the result). `FLAT447/…/blacklist.txt` behaves as an
ordinary source, above the median — it is a normal source, not a deny-list, and the name is
misleading.

That spread is what the per-source score and the enable/disable toggle are for.

## Rejected alternatives

- **A nightly full release.** Rebuilding and publishing the five platform binaries every
  night so the embed is always fresh. Rejected: it burns the release channel for a data file
  that measurably costs nothing over a day, buries real releases in noise, and makes every
  version number meaningless. The orphan branch carries the same freshness at no release
  cost.
- **Committing the snapshot to `main`.** Rejected: a real snapshot is a list of live proxy
  links, and committing it puts them into the repository history, into every screenshot
  session, and into search results permanently. The orphan branch is force-pushed as a
  single commit precisely so no history accumulates. `public/data/snapshot.txt` on `main`
  is synthetic for the same reason.
- **Gzipping the embed.** Rejected by the numbers: 0.10 MiB against a ~21.6 MiB binary. The
  decompression code would be larger than the saving.
- **Raising `maxBatchSize`.** The 10 000-entry cap was expected to be the binding constraint
  on a 20k–60k-link corpus. The corpus is 784 links. Nothing to raise.
- **Filtering the snapshot for liveness in CI.** Rejected on the VPN caveat above: CI checks
  from a GitHub runner in a clean network, and a proxy that answers there says nothing about
  whether it answers from inside a filtered region. Filtering would encode the runner's
  vantage point as truth and silently discard exactly the proxies most likely to matter.
  Redundancy metadata is shipped instead, and liveness is decided on the user's machine —
  which is what this tool is.
- **Rewriting source URLs to a mirror.** Sending the seventeen sources through a proxying
  mirror (`ghproxy` and friends) so the page could fetch them directly. Rejected: it makes
  the tool depend on a third party nobody here controls, one that can log every user, and it
  does not remove the CORS problem. The user's own SOCKS5 proxy solves the same problem with
  no new trusted party.
- **Auto-starting a scan after the fetch.** Rejected: pressing Start is the user's decision,
  a scan is minutes of their bandwidth, and the button that fills a textarea should fill a
  textarea. The textarea is also deliberately left untouched when a load fails, so a failed
  load cannot cost the user a paste they had already made.
- **A server-side `sources.json`.** Keeping the source list in Go, served to the page.
  Rejected: `scripts/build-snapshot.mjs` needs the same list, and the `src=` ids in the
  snapshot are positions in that list — two copies that drifted apart would misattribute
  every line. `public/js/sources.js` is the single copy, and the builder imports it.
- **MTProto as the transport for the list itself.** Fetching the snapshot through a working
  proxy once one is found. Rejected as circular: the case that needs it is the case where no
  working proxy is known yet.

## Consequences

### Good

- The tool is useful with an empty clipboard, including on a machine that cannot reach
  GitHub — the embed covers it, and the e2e suite covers the embed path deterministically.
- The user's own SOCKS5 proxy is now enough to refresh the list, which is a thing many
  people in the target audience already have running.
- Sources are visible, scored by what they actually deliver, and can be disabled or added.
- Attribution rides through to the results, so "which list is worth keeping" is answerable
  from the UI rather than from a spreadsheet.

### Bad, or at least owed

- The server now fetches URLs on request. `HOST=0.0.0.0` remains a supported deployment with
  no auth and no origin check, so `/fetch-sources` is hardened rather than trusted (see
  `CLAUDE.md` for the rules). One residual is accepted deliberately: the **SOCKS5 proxy
  address itself** is caller-supplied and dialled without a destination check, which is a
  bounded forgery primitive — SOCKS5 handshake bytes at an arbitrary `host:port`. Blocking
  loopback there would block the local Tor/tunnel case the feature exists for.
- The SOCKS5 password lives in `localStorage` in plaintext. There is nowhere better — the
  page has no backend session — so the UI states it plainly in all four locales instead of
  hiding it.
- A release built without the `curl` step in `release.yml` silently ships the placeholder.
  `--fail` is what turns a deleted branch or a renamed file into a red job; without it curl
  writes the 404 body and exits 0.
- The snapshot's `src=` ids are positional. **Appending to `DEFAULT_SOURCES` is safe;
  reordering it is not.**
- The offline path has never been verified on a genuinely offline machine — only through
  `page.route()` stubs. That is the one Checkpoint D criterion that was signed off unmet.
