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
bun run server   # API + boards (binds 127.0.0.1; use a tunnel to share boards)
bun run gabbar   # needs SLACK_BOT_TOKEN + SLACK_APP_TOKEN (Socket Mode)
bun run mcp      # stdio MCP server, no extra env needed
```
Mongo: reuses the saturn-v2 docker container (db `mission_control`, override via DB_NAME).

## MCP registration (orchestrator sessions)
```json
{ "mcpServers": { "houston": { "command": "bun", "args": ["--env-file=/Users/rajvarsani/fafo/houston/.env", "/Users/rajvarsani/fafo/houston/mcp/server.ts"] } } }
```
