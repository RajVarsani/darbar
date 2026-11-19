# @darbar/ctxwatch (DAR-419)

Per-thread context meter and auto handoff for T3 Code, for every agent and model.

- Usage and window: T3's own projection (`statev2.sqlite`, readonly), `provider_turns.payload.tokenUsage`
  `{usedTokens,maxTokens}`. Same shape for Claude and Codex, so there are no log parsers. Thread id IS the T3
  thread id; the "session" key is the latest turn's `provider_thread_id` (changes on a fresh context).
  `CTXWATCH_WINDOWS` is only a fallback when T3 reports no window.
- Writes: T3's `/mcp` endpoint as a full-access client (`t3mcp.ts`): rename, send, queue list/reorder. The t3 CLI has
  none of these. Sign-in is the pairing-code OAuth flow T3's peer link uses; token cached in `data/ctxwatch-token.json`.
- `insert.ts` is the only code that touches a user's queue: one send (mode `queue`, never steer), reorder ahead of the
  user's runs, then `checkQueue` (pure.ts) against the snapshot taken before. Any difference halts the thread + event.
- State per thread in Mongo `ctxwatch` (phase, firedSession). Send idempotency: `clientRequestId` hashed from
  (thread, session, kind), so a restart mid-insert cannot double-send. `CTXWATCH_MIN_GAP_MS` stops a clear loop.
- Gate: the handoff message tells the agent its LAST step is `curl -X POST <api>/ctx/handoff-done` (route in
  apps/server/src/ctx-gate.ts, MCP tool `ctx_handoff_done`). The route flags the Mongo state doc and waits; the
  watcher (500ms poll) queues the fresh-context resume ahead of the user's runs while the handoff run is still active, so
  T3 starts it next and all user messages run fresh. No gate (failed, stopped, completed without it) = no resume, no clear,
  re-armed for the next newer turn behind the loop guard. If the handoff dies after the gate, the queued resume is cancelled.
- Title prefix states: `NN% ·` normal, `NN% handoff ·` queued/running, `NN% safe ·` gate called until the resume starts,
  `NN% no-handoff ·` failed/stopped/no gate until the next attempt.
- Off switches: `CTXWATCH=off`, `DARBAR_T3=off`, `CTXWATCH_SKIP_THREADS`, `bun run ctxwatch:optout <thread>`.
  `CTXWATCH_ONLY_THREADS` limits it to listed threads (use it for any low-threshold test).
- Events go straight into Mongo `events` on the `CTXWATCH_EVENT_PROJECT` board (no SSE push; refresh the board).
- Supervision: `scripts/svc.sh ctxwatch`, `deploy/launchd/darbar-ctxwatch.plist.template`, heartbeat
  `data/ctxwatch-heartbeat.json` checked by `scripts/watchdog.sh`.
