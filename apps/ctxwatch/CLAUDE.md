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
- Known limit: T3 starts the user's first queued run the instant the handoff run completes, so that one message runs in
  the old context; the resume lands before the rest. Nothing is lost or reordered.
- Off switches: `CTXWATCH=off`, `DARBAR_T3=off`, `CTXWATCH_SKIP_THREADS`, `bun run ctxwatch:optout <thread>`.
  `CTXWATCH_ONLY_THREADS` limits it to listed threads (use it for any low-threshold test).
- Events go straight into Mongo `events` on the `CTXWATCH_EVENT_PROJECT` board (no SSE push; refresh the board).
- Supervision: `scripts/svc.sh ctxwatch`, `deploy/launchd/darbar-ctxwatch.plist.template`, heartbeat
  `data/ctxwatch-heartbeat.json` checked by `scripts/watchdog.sh`.
