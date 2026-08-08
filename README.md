# Houston

Mission control for agent-orchestrated projects.

Self-hosted tracker + human feedback pipe: live boards, Gabbar Slack intake, MCP tools for agents.
Plan: https://claude.ai/code/artifact/6be911e7-772f-4c96-baf3-5994fe48207f

## Pieces
- `src/server.ts` — Hono API + SSE + capability-URL boards (`/p/:capId`) on :4899
- `gabbar/bot.ts` — Slack Socket Mode intake scribe: DMs/mentions → feedback rows (pending). Executes nothing.
- `mcp/server.ts` — stdio MCP tools for orchestrator/builders/lanes (create_task, update_task, file_feedback, next_pending_feedback, resolve_feedback, …)
- `web/board.html` — v1 live board (static shell over the JSON API; React app can replace later)

Resolution replies to Slack threads are sent by the SERVER on feedback PATCH
(resolved / rejected / needs_clarification) — the bot is intake-only.

## Config
Everything is driven by `.env` (gitignored, never pushed). Copy `.env.example`,
fill in the Slack tokens, done. All defaults live in `src/config.ts` and nowhere else.

## Run
```
bun run server   # API + boards (binds 127.0.0.1)
bun run gabbar   # needs SLACK_BOT_TOKEN + SLACK_APP_TOKEN (Socket Mode)
bun run mcp      # stdio MCP server, no extra env needed
bun run proxy    # dynamic front door on :4800 (routes in data/routes.json)
bun run tunnel   # ngrok -> proxy, uses NGROK_DOMAIN from .env when set
```

## Sharing / the front door
ngrok fronts ONLY the proxy. The proxy enforces the public surface per route:
tunneled requests (x-forwarded-host present) must match a route's `public` regex
list; everything else 403s. Default route -> houston with boards, board API and
files public. Add more services at runtime:
```
curl -X POST localhost:4800/-/route -H "Authorization: Bearer $PROXY_ADMIN_TOKEN"   -d '{"prefix":"fe","target":"http://127.0.0.1:5173","public":["^/"]}'
```
`/-/` admin endpoints require the token and are invisible through the tunnel.
Set BASE_URL to the tunnel domain so board links in Gabbar replies work for
stakeholders. Free-plan ngrok shows visitors a one-click interstitial.
Mongo: reuses the saturn-v2 docker container (db `mission_control`, override via DB_NAME).

## MCP registration (orchestrator sessions)
```json
{ "mcpServers": { "houston": { "command": "bun", "args": ["--env-file=/Users/rajvarsani/fafo/houston/.env", "/Users/rajvarsani/fafo/houston/mcp/server.ts"] } } }
```
