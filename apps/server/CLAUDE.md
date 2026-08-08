# @houston/server

Hono API + SSE + boards. The ONLY process that touches Mongo or posts Slack replies.

- `src/server.ts` — Bun.serve on `config.bindHost:config.port` (loopback). Serves
  `web/board.html` at `/p/:capId` (read per request, no restart for UI edits) and
  Slack-pulled files at `/files/:name` (non-image forced to download: XSS guard).
- `src/api.ts` — all routes. Body parsing via `readBody` + `str/strOrNull/strArr`
  guards; NEVER pass raw body values into Mongo operators. Feedback PATCH sends the
  in-thread Slack reply and logs failures as events.
- `src/sse.ts` — subscriber registry; `emit(capId, …)` after every mutation.
- `web/board.html` — single-file cypherpunk board (lime/ink/beige, JetBrains Mono).
  Every interpolation goes through `esc()`; attachment URLs through `safeUrl()`.

Statuses and types come from `@houston/core`; add new ones there first.
