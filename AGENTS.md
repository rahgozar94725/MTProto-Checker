# AGENTS.md — MTProto Deep Checker

## Quick start
```bash
go run main.go   # localhost:3000, opens browser automatically
```

## Architecture
- **Go backend** (`main.go`) — 3 endpoints: `POST /check`, `/check-batch`, `/check-stream` (SSE)
- **Uses** `github.com/gotd/td` (MTProto lib), DNS cache, TCP pre-check, panic recovery
- **No linting, no formatting config, no CI/CD**
- **Bilingual** — Persian (fa, default, RTL) + English (en, LTR) + Russian (ru, LTR) + Chinese (zh, LTR), stored in `localStorage`
- **Frontend** — Vanilla JS, split CSS (`tokens.css`+`base.css`+`components.css`), `helpers.js` DOM utilities
- **Fonts** — Self-hosted Vazirmatn (Persian, 46KB) + Inter (English, 48KB) as woff2, zero CDN
- **Theme** — Dark/light toggle, persisted in localStorage, glassmorphism buttons with `backdrop-filter`

## Key technical facts
| Fact | Detail |
|------|--------|
| Entrypoint | `main.go` — Go server with `net/http`, `gotd/td` |
| Port | `3000` (configurable via `PORT` env) |
| API credentials | Hardcoded public test keys (`API_ID=6`, `API_HASH=eb06d4...`) |
| Proxy check | Real MTProto handshake via `help.getNearestDC` |
| Timeout | Configurable 3-30s from UI, default 5s; hard limit +10s |
| Concurrency | Configurable 10-50 from UI, default 50 |
| Endpoints | `POST /check` (single), `/check-batch` (batch JSON), `/check-stream` (SSE streaming) |
| Test files | `main_test.go`, `proxytest_test.go` |
| Build | `go build -o mtproto-checker.exe .` |
| Start btn | Idle → blue `btn-start`. Scanning → red `btn-stop` (`scanState` global `'idle'`/`'scanning'`, `handleStartStop()` routes to `startCheck`/`stopScan`) |
| Pause/Resume | Aborts SSE controller, reconnects with unchecked proxies only (`checkedKeys` Set) |

## Gotchas
- No TypeScript, no linting, no formatting config
- No `.env` — secrets are public test keys hardcoded in source
- Node.js backend (`app.js`, `sea-entry.mjs`, SEA build) — DELETED, Go-only now
