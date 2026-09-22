# Darbar

Mission control for agent-orchestrated projects. A self-hosted tracker with a human feedback
pipe: live boards you can share by link, Slack intake, and MCP tools so agents read and write
the same board you do.

It runs entirely on one machine. There is no login and no cloud account: what you share, you
share by handing someone an unguessable URL.

## How it fits together

| part | what it is |
|---|---|
| `apps/server` | the API, the boards, and the engine (review lanes, done-gates, feedback). Hono + SSE on `:4899`, bound to loopback |
| `apps/proxy` | the only thing the tunnel can reach (`:4800`). Decides per route which paths a public request may touch |
| `apps/gabbar` | Slack intake. Turns DMs and mentions into feedback rows. Files things; executes nothing |
| `apps/mcp` | stdio MCP tools, the write path for orchestrators, builders and review lanes |
| `apps/buddy` | a macOS desktop pet that hangs the board off its head |
| `packages/core` | shared config, db and types (`@darbar/core`) |

A board is reachable at `/p/:capId`; the capability id IS the access control. Agents talk to
the API and the MCP tools. Stakeholders talk to Gabbar in Slack, and the SERVER (not the bot)
replies into their thread when their feedback is resolved.

## Setup

Needs [Bun](https://bun.sh), Docker, and — for the tunnel — a free [zrok](https://zrok.io)
account. Slack tokens are only needed if you want Gabbar.

```bash
bun install
cp .env.example .env          # fill in MONGO_URI, tokens; every default lives in packages/core/src/config.ts
docker run -d --name darbar-mongo --restart unless-stopped -p 27018:27017 mongo:7
bun run dev                   # server + proxy + gabbar + tunnel, in the foreground
```

Open http://localhost:4899 — that is the console, and it is local-only by design. Create a
project with the `darbar-project-init` skill, or `POST /api/projects`.

Mongo gets its **own** container on **27018** (db `mission_control`). Deliberately not shared
with another stack's mongo on 27017.

### Keep it running

`bun run dev` lives and dies with your terminal, which is fine for development and wrong for
anything you rely on. To supervise it:

```bash
./deploy/launchd/install.sh    # six launchd agents, started now and at every login
```

They exec `scripts/svc.sh`, which sources `.env`, so no secret is ever written into a plist.
See [docs/operations.md](docs/operations.md) for restarting one, reading logs, the watchdog
and backups.

### Share a board

```bash
zrok create name darbar        # once, reserves https://<name>.shares.zrok.io
bun run tunnel
```

Set `BASE_URL` to that domain so the links Gabbar hands out resolve for other people. The
tunnel reaches only the proxy, and the proxy serves only the paths a route marks public —
the API and the console 403 through it. See [docs/front-door.md](docs/front-door.md).

### Give an agent the tools

```json
{ "mcpServers": { "darbar": {
  "command": "bun",
  "args": ["--env-file=/ABSOLUTE/PATH/darbar/.env", "/ABSOLUTE/PATH/darbar/apps/mcp/src/server.ts"]
} } }
```

### Give the orchestrator its workers

```bash
./deploy/agents/install.py            # darbar-builder / -reviewer / -researcher, for Claude Code and Codex
./deploy/agents/install.py --project . # plus a project's own .darbar/roles.toml overrides
```

Roles name a tier, tiers map to a model per harness (`deploy/agents/roles.toml`). An
orchestrator dispatches by role and never chooses a model, so a worker cannot inherit the
most expensive one by accident, and each role carries only the tools it needs.

## Docs

| | |
|---|---|
| [docs/operations.md](docs/operations.md) | supervision, logs, tunnel gotchas, watchdog, backups, what each script does |
| [docs/front-door.md](docs/front-door.md) | routes, the `public` path language, exposing a Vite dev server, and why `Origin` is forwarded |
| [docs/orchestrator-loop.md](docs/orchestrator-loop.md) | the wire-level reference an agent uses: routes, bodies, field allowlists, cold start |
| [CLAUDE.md](CLAUDE.md) | conventions for agents working on this repo |

The operating doctrine for RUNNING a project on a board (lifecycles, review lanes, token
economics) lives in the `darbar-project-init` skill, not here.
