# Darbar

Mission control for agent-orchestrated projects.

Self-hosted tracker + human feedback pipe: live boards, Gabbar Slack intake, MCP tools for agents.
Plan: https://claude.ai/code/artifact/6be911e7-772f-4c96-baf3-5994fe48207f

## Layout (Bun workspaces)
- `apps/server` — Hono API + SSE + capability-URL boards (`/p/:capId`) on :4899
- `apps/gabbar` — Slack Socket Mode intake scribe: DMs/mentions → feedback rows (pending). Executes nothing.
- `apps/proxy` — dynamic front door (:4800) that ngrok tunnels to; per-route public-path policy
- `apps/mcp` — stdio MCP tools for orchestrator/builders/lanes
- `packages/core` — shared config + db + types (`@darbar/core`)

One command: `bun dev` (mongo check → server + gabbar + proxy + tunnel).

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
list; everything else 403s. Default route -> darbar with boards, board API and
files public. Add more services at runtime:
```
curl -X POST localhost:4800/-/route -H "Authorization: Bearer $PROXY_ADMIN_TOKEN"   -d '{"prefix":"fe","target":"http://127.0.0.1:5173","public":["^/"]}'
```
`/-/` admin endpoints require the token and are invisible through the tunnel.
Set BASE_URL to the tunnel domain so board links in Gabbar replies work for
stakeholders. Free-plan ngrok shows visitors a one-click interstitial.
Mongo: reuses the saturn-v2 docker container (db `mission_control`, override via DB_NAME).

### Exposing a Vite dev server (HMR works through the tunnel)
The proxy bridges WebSocket upgrades, so Vite's HMR socket survives the tunnel —
the same route + `public` policy applies to the upgrade as to plain HTTP, on the
prefix-stripped path. The upstream socket is connected before the client handshake is
answered, so a 101 means the tunnel really works (a dead or wedged dev server gets a 502
instead), and buffering is capped in both directions: an end that stops reading has its
socket closed rather than growing the proxy's memory. Two Vite-side requirements:

1. **`base` must match the prefix** (`base: '/fe/'` for prefix `fe`) — otherwise the
   HTML points at `/assets/...` and `/@vite/client` at the tunnel root, which lands
   on the default route instead of your app. The HMR socket URL follows `base` too.
2. **Put the same path on the route target** (`http://127.0.0.1:5173/fe`). The proxy
   strips the prefix, so without it Vite receives `/` and 302-redirects to `base` —
   an infinite redirect loop in the viewer's browser.

```
curl -X POST localhost:4800/-/route -H "Authorization: Bearer $PROXY_ADMIN_TOKEN" \
  -d '{"prefix":"fe","target":"http://127.0.0.1:5173/fe","public":["^/"]}'
```
**`Origin` is forwarded, deliberately.** An upstream that runs a cross-site-WebSocket-hijacking
check has to see the viewer's real origin. Rewrite it and every tunneled upgrade looks
same-origin to that check, which is strictly worse; Vite's own proxy docs say rewriting origin
for proxied websockets "can expose the proxy to CSRF attacks". Vite validates `Origin` on the
HMR socket from 6.0.9 / 5.4.12 / 4.5.6 (the CVE-2025-24010 fix). The proxy forwards `Origin`
and passes the query string through unchanged, which is what lets Vite's own client, whose HMR
URL carries a `?token=`, complete the handshake.

**Do not read that as protection.** The token is embedded in the page the tunnel serves
publicly, so on a route that exposes the whole app, any visitor who can load the page can read
the token and drive the HMR socket, which per that advisory means reading and writing arbitrary
HMR messages. That is inherent to sharing a dev server and is a fine deliberate trade. It is
not a defence, and Vite's `Origin` check is not standing between a link-holder and your HMR
socket.

**`Host` is dropped on purpose, and that disables `allowedHosts`.** Not because it is
hop-by-hop (it isn't, per RFC 7230) but because we choose to: the upstream sees
`127.0.0.1:<port>`, so its `allowedHosts` check passes with no config. That is the right call
for a front door that is the intended entry point, but name it for what it is. `allowedHosts`
is disabled for anything behind this proxy, not satisfied. Don't trust it as a defence, and
don't "fix" the hop-by-hop list to restore it.

## MCP registration (orchestrator sessions)
```json
{ "mcpServers": { "darbar": { "command": "bun", "args": ["--env-file=/Users/rajvarsani/fafo/darbar/.env", "/Users/rajvarsani/fafo/darbar/apps/mcp/src/server.ts"] } } }
```
