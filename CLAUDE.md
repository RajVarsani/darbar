# Darbar — Claude instructions

Mission control for agent-orchestrated projects: live boards + human feedback pipe
(Slack via Gabbar) + MCP tools for orchestrator/builder sessions.

## Monorepo map (Bun workspaces)

| Workspace | What | Entry |
|---|---|---|
| `apps/server` | Hono API + SSE + capability-URL boards on `127.0.0.1:4899` | `src/server.ts` |
| `apps/gabbar` | Slack Socket Mode intake bot (writes pending feedback, nothing else) | `src/bot.ts` |
| `apps/proxy` | Dynamic front door on `127.0.0.1:4800`; the tunnel fronts ONLY this | `src/server.ts` |
| `apps/mcp` | stdio MCP tools wrapping the API (spawned by Claude sessions) | `src/server.ts` |
| `packages/core` | Shared config + Mongo collections + types (`@darbar/core`) | `src/index.ts` |

Each workspace has its own CLAUDE.md with specifics. Read the one for whatever you touch.
Runtime is Bun everywhere: `bun install`, `bun run`, `bunx`, `Bun.file`, `bun test`.

## Run

```bash
bun dev              # EVERYTHING: mongo check -> server + gabbar + proxy + zrok tunnel
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
- **Nothing binds beyond loopback.** Outside traffic comes through the tunnel -> proxy,
  and the proxy's per-route `public` regex list defines the exposed surface
  (boards `/p/`, board API `/api/p/`, files `/files/` by default). The public/local
  switch is LOOPBACK, not a vendor header: public unless the request proves it came
  from loopback. The proxy then sets `x-forwarded-host` itself on public requests, so
  the server's local-only routes can tell. Keying this off one tunnel's header is what
  broke in DAR-252 — ngrok set it, zrok does not, and the API went world-readable.
- **API bodies are string-typed** (guards in `apps/server/src/api.ts`). Keep them:
  they block Mongo operator injection and untyped garbage reaching the board.
- **Every feedback state change that matters replies in the original Slack thread**;
  reply failures are logged as board events, never swallowed.
- **The review pipeline is server-side** (`spawnReviews`/`maybeAdvanceParent`/done-gate
  in `apps/server/src/api.ts`), so the rules hold for every writer (UI drag, MCP, curl):
  a dev task entering `in_review` spawns one `type=review` subtask per configured lane
  (`project.pipeline.reviews`, each assigned to its lane manager); `done` is rejected
  (409) while review children are open; closing the last review child auto-advances the
  parent to done unless `pipeline.autoAdvance` is false (then it waits for an explicit
  push). Never hand-create `type=review` tasks. Review tasks render as pips on the
  parent's kanban card, not as columns cards.
- **Orchestrator sessions run the standing drain loop** — triage verbs, dispatch,
  board audit, resume contract: `docs/orchestrator-loop.md`.

## Task statuses (Jira-style)

`backlog → todo → in_progress → in_review → qa → done`, plus `blocked` (with the
free-text `blocker` field carrying why) and `cancelled`. Task `type`:
`feature|bug|chore|review|regression`. Feedback lifecycle:
`pending → triaged → accepted → in_progress → resolved | rejected | needs_clarification`
(replies in-thread on resolved/rejected/needs_clarification; thread replies reopen
rows to `pending`, never duplicate).

## Test fixtures

Raj↔Gabbar DM channel `D0AH8292D7Y`. Slack app "Gabbar Singh" `A0AHP0UKQMP`,
Socket Mode on, bot user `U0AGUK6D207`. (Old TST/TODO test projects were wiped
2026-08-08; the live dogfood project is DAR "Darbar Platform".)

## Conventions

- `bun run typecheck` clean before any commit.
- Commits: conventional-ish (`feat:`, `fix:`, `refactor:`); no session URLs in bodies.
- Git pushes use the repo-local credential helper (reads `~/fafo/.envrc`); remotes
  stay token-free.
- The Claude skills for this system (`gabbar` persona, `darbar-project-init`)
  live in the separate public repo `RajVarsani/skills`, NOT here.

## Compact instructions

Run `/darbar-handoff` BEFORE compacting: it moves conversation-only facts onto the board,
which is the only thing compaction cannot reach. After compaction the `SessionStart` hook
reprints live board state automatically.

When compacting this project, keep, in this order of priority:

1. **Anything not yet on the board** — work discussed but unfiled, decisions and the
   options rejected, what a blocked thing waits on. Say the shortId if it has one.
2. **Gotchas bought with time**: a command whose obvious form is wrong, env that must be
   sourced rather than passed, a flag that does not mean what it reads, a check that
   passes for the wrong reason. These cost the same hour twice when they are dropped.
3. **State that no file records**: what is running, migrated, deployed, killed, exposed.
4. **Exact identifiers**: shortIds, ports, container names, branch names, commit shas.

Drop freely: tool output already acted on, superseded plans, file contents still on disk,
narration of work whose result is committed, and any status the board can be re-asked for.
