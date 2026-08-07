# Mission Control

Self-hosted tracker + human feedback pipe for agent-orchestrated projects.
Plan: https://claude.ai/code/artifact/6be911e7-772f-4c96-baf3-5994fe48207f

## Pieces
- `src/server.ts` — Hono API + SSE + capability-URL boards (`/p/:capId`) on :4899
- `gabbar/bot.ts` — Slack Socket Mode intake scribe: DMs/mentions → feedback rows (pending). Executes nothing.
- `mcp/server.ts` — stdio MCP tools for orchestrator/builders/lanes (create_task, update_task, file_feedback, next_pending_feedback, resolve_feedback, …)
- `web/board.html` — v1 live board (static shell over the JSON API; React app can replace later)

Resolution replies to Slack threads are sent by the SERVER on feedback PATCH
(resolved / rejected / needs_clarification) — the bot is intake-only.

## Run
```
bun run server   # API + boards
bun run gabbar   # needs SLACK_APP_TOKEN (Socket Mode) in .env
```
Mongo: reuses the saturn-v2 docker container (db `mission_control`).

## MCP registration (orchestrator sessions)
```json
{ "mcpServers": { "mission-control": { "command": "bun", "args": ["--env-file=/Users/rajvarsani/all-things-saturn/mission-control/.env", "/Users/rajvarsani/all-things-saturn/mission-control/mcp/server.ts"] } } }
```
