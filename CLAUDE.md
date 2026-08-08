# Darbar — Claude instructions

Mission control for agent-orchestrated projects: live boards + human feedback pipe
(Slack via Gabbar) + MCP tools for orchestrator/builder sessions.

## Monorepo map (Bun workspaces)

| Workspace | What | Entry |
|---|---|---|
| `apps/server` | Hono API + SSE + capability-URL boards on `127.0.0.1:4899` | `src/server.ts` |
| `apps/gabbar` | Slack Socket Mode intake bot (writes pending feedback, nothing else) | `src/bot.ts` |
| `apps/proxy` | Dynamic front door on `127.0.0.1:4800`; ngrok fronts ONLY this | `src/server.ts` |
| `apps/mcp` | stdio MCP tools wrapping the API (spawned by Claude sessions) | `src/server.ts` |
| `packages/core` | Shared config + Mongo collections + types (`@darbar/core`) | `src/index.ts` |

Each workspace has its own CLAUDE.md with specifics. Read the one for whatever you touch.
Runtime is Bun everywhere: `bun install`, `bun run`, `bunx`, `Bun.file`, `bun test`.

## Run

```bash
bun dev              # EVERYTHING: mongo check -> server + gabbar + proxy + ngrok tunnel
bun run server|gabbar|proxy|tunnel   # individual pieces
bun run mcp          # stdio; normally spawned via MCP registration (README)
bun run typecheck    # tsc --noEmit; run before committing
```

## Config doctrine

Root `.env` (gitignored) drives every value through `packages/core/src/config.ts`.
No default lives anywhere else; `.env.example` documents all vars. Never hardcode a
port, URL, db name, or token in an app. `data/` holds runtime state (files, logs,
routes.json) and is gitignored.

## Invariants (do not break)

- **Gabbar is intake-only.** It creates feedback rows at `pending` and confirms in
  thread. It never creates tasks, never changes statuses, never executes anything.
- **Only the orchestrator promotes feedback to tasks** (via MCP tools). Lanes and
  humans file feedback; one promoter keeps the board coherent.
- **Only the server touches Mongo and posts Slack replies.** Resolution replies live
  in the server's feedback PATCH, not in the bot.
- **Nothing binds beyond loopback.** Outside traffic comes through ngrok -> proxy,
  and the proxy's per-route `public` regex list defines the exposed surface
  (boards `/p/`, board API `/api/p/`, files `/files/` by default). Tunneled requests
  carry `x-forwarded-host`; that header is the public/local switch.
- **API bodies are string-typed** (guards in `apps/server/src/api.ts`). Keep them:
  they block Mongo operator injection and untyped garbage reaching the board.
- **Every feedback state change that matters replies in the original Slack thread**;
  reply failures are logged as board events, never swallowed.

## Task statuses (Jira-style)

`backlog → todo → in_progress → in_review → qa → done`, plus `blocked` (with the
free-text `blocker` field carrying why) and `cancelled`. Feedback lifecycle:
`pending → triaged → accepted → in_progress → resolved | rejected | needs_clarification`
(replies in-thread on resolved/rejected/needs_clarification; thread replies reopen
rows to `pending`, never duplicate).

## Test fixtures

Project TST ("Gabbar Test Project"), board `/p/PUNbf9U9VS4b7RBgiTtGg`,
Raj↔Gabbar DM channel `D0AH8292D7Y`. Slack app "Gabbar Singh" `A0AHP0UKQMP`,
Socket Mode on, bot user `U0AGUK6D207`.

## Conventions

- `bun run typecheck` clean before any commit.
- Commits: conventional-ish (`feat:`, `fix:`, `refactor:`); no session URLs in bodies.
- Git pushes use the repo-local credential helper (reads `~/fafo/.envrc`); remotes
  stay token-free.
- The Claude skills for this system (`gabbar` persona, `darbar-project-init`)
  live in the separate public repo `RajVarsani/skills`, NOT here.
