# SPEC — MTProto Checker

## §G — Goal

Go-based MTProto proxy checker: single binary, 3 endpoints, DNS cache, TCP pre-filter, SSE streaming.

## §C — Constraints

| C | Detail |
|---|--------|
| C1 | Go backend: `net/http`, `gotd/td`, 3 endpoints |
| C2 | Port 3000, auto-open browser |
| C3 | UI: bilingual (fa/en), dark mode, SSE streaming |
| C4 | Timeout: 3-30s default 5s, hard limit +10s |
| C5 | Concurrency: 10-50 default 50 |
| C6 | No JS linting/formatting/CI/CD |

## §I — Interfaces

| I | Surface | Detail |
|---|---------|--------|
| I1 | `main.go` | Go backend entrypoint, `net/http`, `gotd/td` |
| I2 | `public/` | Static assets (index.html, css/, js/) |
| I3 | `images/` | Readme assets (not needed at runtime) |
| I4 | `main_test.go` | Go unit + integration tests |
| I5 | `proxytest_test.go` | Go Telegram proxy integration tests |

## §V — Invariants

| V | Rule |
|---|------|
| V1 | Server auto-opens browser to localhost:3000 |
| V2 | Server serves `public/` assets correctly (file server on `/`) |
| V3 | `POST /check` returns `{ok:bool, ping?:number}` |
| V4 | Server exits cleanly on SIGINT/SIGTERM (`Shutdown` with 5s ctx) |
| V5 | `checkProxy` uses `dcs.MTProxy` resolver (no WebSocket native deps) |
| V6 | `POST /check-stream` SSE — each result as `event: progress` + `event: done` at end |
| V7 | `POST /check-batch` returns JSON array `[{ok:bool, ping?:number}, ...]` |
| V8 | TCP pre-filter phase before full MTProto handshake (1.5s dial timeout) |
| V9 | DNS cache with 5-min TTL for proxy server lookups |
| V10 | Panic recovery on all HTTP handlers (returns 500 JSON) |
| V11 | Concurrency from UI (`X-Concurrency` header) capped at 50 |
| V12 | ∀ proxy input → deduplicate by `server:port:secret` before dispatch (UI-side Set) |
| V13 | ∀ check completion → play notification sound if user opted in (checkbox in UI, persisted in localStorage) |

## §T — Tasks

| T | Status | Description | Cites |
|---|--------|-------------|-------|
| T1 | x | implement Go backend with 3 endpoints | C1, I1 |
| T2 | x | Go DNS cache + TCP pre-filter | V8, V9 |
| T3 | x | Go panic recovery + clean shutdown | V10, V4 |
| T4 | x | UI: SSE streaming via EventSource | V6 |
| T5 | x | UI: configurable timeout + concurrency | C4, C5 |
| T6 | x | UI: dedup + notification sound | V12, V13 |
| T7 | x | Go integration tests (main_test, proxytest_test) | I4, I5 |
| T8 | x | clean up Node.js backend files | |
| T9 | x | update README + AGENTS.md + SPEC.md | |

## §B — Bugs

| id | date | cause | fix |
|----|------|-------|-----|
| B1 | 2026-06-12 | duplicate proxy entries not eliminated before dispatch | V12 |
| B2 | 2026-06-19 | Node.js `app.js` + `sea-entry.mjs` deleted; Go-only now | T8 |
