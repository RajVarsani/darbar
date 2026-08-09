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
tunneled requests (x-forwarded-host present) must match one of a route's `public`
path patterns; everything else 403s. Default route -> darbar with boards, board API
and files public. Add more services at runtime:
```
curl -X POST localhost:4800/-/route -H "Authorization: Bearer $PROXY_ADMIN_TOKEN" \
  -d '{"prefix":"fe","target":"http://127.0.0.1:5173","public":["/"]}'
```
`/-/` admin endpoints require the token and are invisible through the tunnel.
Set BASE_URL to the tunnel domain so board links in Gabbar replies work for
stakeholders. Free-plan ngrok shows visitors a one-click interstitial.
Mongo: reuses the saturn-v2 docker container (db `mission_control`, override via DB_NAME).

### `public` is a path language, not regexes
Entries are matched with string operations only — `===`, `startsWith`, `indexOf` — so
there is no engine to backtrack and no pattern anyone writes can hang the front door.
Each entry is a literal path starting with `/`:

- `/assets/` — PREFIX, the default. Any path that starts with it, `/` included:
  `/assets/deep/b.js` matches, `/assetsx` does not.
- `/$` — EXACT. A trailing `$` means the path must equal the literal: `/` and not
  `/index.html`.
- `/assets/*.js$` — GLOB. At most one `*`, and it never matches across `/`:
  `/assets/a.js` matches, `/assets/deep/a.js` does not.
- `/` — the prefix that matches every path. This is what the old `^/` was written for.

A leading `^`, a `.*`, a second `*`, or any character a URL path does not carry is
refused by name, and the error spells out the form. Write patterns in the form above and
never with a `^`: `PATCH /api/projects/:ref {proxy}` rejects an anchored entry outright,
so `"public":["^/"]` 400s there with the rewrite spelled out in the message.

Only the on-disk read path is lenient, and only so far. An `^`-anchored entry already in
routes.json is migrated when it is a pure literal path once the anchors come off
(`^/p/` -> `/p/`, `^/$` -> `/$`, `^/` -> `/`), which is why an existing routes.json keeps
serving after the language changed. Anything carrying real regex metacharacters
(`^/assets/.*\.js$`, `^/(a|b)/`) is never guessed at: it is DROPPED with a
`routes.json: ... REJECTED` line on the proxy console, and that line is the only notice
you get. `POST /-/route` itself validates nothing, so a bad pattern is accepted there and
surfaces only as that log at load. Failure never widens a route. An empty list, an
all-rejected list and an omitted `public` all mean the same thing: nothing on that route
is reachable through the tunnel.

Three more things the front door does, none of them configurable. A tunneled path
carrying an ENCODED separator (`%2f`/`%5c`) is refused outright, because our view of the
path and the upstream's would otherwise disagree — `/assets/..%2fsecret` matches an
`/assets/` prefix here and lands on `/secret` on a dev server that decodes before
resolving `..`. `proxy.target` on the project config API must be a loopback address
(`localhost`, `127.0.0.0/8`, `::1`, or an unspecified `0.0.0.0`/`::`), since the proxy is
publicly reachable and anything else is an open relay onto a host that never agreed to be
published. And the board payload at `/api/p/:capId` is itself public, so it reports
`prefix`, `public`, `enabled` and `proxyPublished` but replaces the upstream with
`targetRedacted: true` — the internal host:port is only on the local-only
`/api/projects/:ref/context`.

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
  -d '{"prefix":"fe","target":"http://127.0.0.1:5173/fe","public":["/"]}'
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
