// DAR-419 context watcher. Per live T3 thread: show context % in the title; at the threshold put
// "run /darbar-handoff now" at the front of the queue, then a fresh-context /darbar-resume once it
// finishes. Usage and the window come from T3's projection, writes go through T3's MCP endpoint.
import fs from 'node:fs';
import { config, initDb, CtxWatch, Events, Projects } from '@darbar/core';
import type { ObjectId } from '@darbar/core';
import type { CtxWatchState } from '@darbar/core';
import { callTool } from './t3mcp';
import { bucketOf, labelFor, titleFor } from './pure';
import { insertAtFront, QueueViolation, requestKey } from './insert';
import { currentTitle, latestUsage, liveThreads, runStatus, type Usage } from './usage';

const HEARTBEAT = new URL('../../../data/ctxwatch-heartbeat.json', import.meta.url).pathname;
const TERMINAL_BAD = new Set(['failed', 'cancelled', 'interrupted', 'rolled_back']);

let eventProject: ObjectId | null = null;
async function board(threadId: string, text: string) {
  console.log(`ctxwatch ${threadId}: ${text}`);
  try {
    eventProject ??= (await Projects.findOne({ prefix: config.ctxwatchEventProject }))?._id ?? null;
    if (eventProject) await Events.insertOne({ projectId: eventProject, taskId: null, text: `ctxwatch ${threadId}: ${text}`, at: new Date() });
  } catch (e) { console.error('ctxwatch: board event failed', e); }
}

async function load(threadId: string): Promise<CtxWatchState> {
  return (await CtxWatch.findOne({ threadId })) ?? { threadId, phase: 'idle', updatedAt: new Date() };
}
async function save(st: CtxWatchState, set: Partial<CtxWatchState>) {
  Object.assign(st, set, { updatedAt: new Date() });
  const { _id, ...rest } = st;
  await CtxWatch.updateOne({ threadId: st.threadId }, { $set: rest }, { upsert: true });
}
// a failure is a board event, but the same failure repeating every poll is one event
async function fail(st: CtxWatchState, what: string, e: unknown) {
  const msg = `${what}: ${e instanceof Error ? e.message : String(e)}`.slice(0, 400);
  if (st.lastError !== msg) { await save(st, { lastError: msg }); await board(st.threadId, msg); }
}

async function syncTitle(st: CtxWatchState, pct: number) {
  const title = currentTitle(st.threadId);
  if (!title) return;
  const fresh = bucketOf(pct, config.ctxwatchBucketStep);
  const bucket = st.lastBucket != null && st.lastBucket === fresh ? st.lastBucket : fresh;
  const want = titleFor(title, bucket, labelFor(st, runStatus(st.resumeRunId ?? '')));
  if (want !== title) await callTool('t3_thread_update', { threadId: st.threadId, action: 'rename', title: want });
  if (st.lastBucket !== bucket || st.lastPct !== pct) await save(st, { lastBucket: bucket, lastPct: pct });
}

const handoffMessage = (threadId: string) =>
  `${config.ctxwatchHandoffMsg}\n\n` +
  'Your LAST step, and only after /darbar-handoff has FULLY succeeded, is to call the darbar gate. Run exactly this shell command:\n' +
  `curl -fsS -X POST ${config.apiUrl}/ctx/handoff-done -H 'content-type: application/json' -d '${JSON.stringify({ threadId })}'\n` +
  'Do nothing after that call. If the handoff failed or was incomplete, do NOT call it.';

async function startHandoff(st: CtxWatchState, u: Usage) {
  const run = await insertAtFront(st.threadId, handoffMessage(st.threadId), requestKey(st.threadId, u.session, `handoff${st.firedAt?.getTime()}`), false);
  await save(st, { phase: 'handoff_sent', handoffRunId: run, lastError: null });
  await board(st.threadId, `context ${u.pct.toFixed(1)}% >= ${config.ctxwatchThreshold}%: queued handoff run ${run} ahead of the user's queue`);
}
// the gate was called while the handoff run is still active: the resume goes in now, so T3 starts it next
async function startResume(st: CtxWatchState) {
  await save(st, { phase: 'resume_pending' });
  const run = await insertAtFront(st.threadId, config.ctxwatchResumeMsg, requestKey(st.threadId, st.firedSession ?? '', `resume${st.firedAt?.getTime()}`), true);
  await save(st, { phase: 'resume_sent', resumeRunId: run, lastError: null });
  await board(st.threadId, `handoff gate called: queued fresh-context resume run ${run} ahead of the user's queue`);
}
// no clear happened (or none will): allow another try on the next turn, still behind the loop guard
async function rearm(st: CtxWatchState, u: Usage, why: string) {
  await save(st, { phase: 'idle', firedSession: null, gateAt: null, retryAfter: u.at, lastError: why });
  await board(st.threadId, `${why}; no clear, will retry after the next turn`);
}

const ACTIVE = new Set(['preparing', 'starting', 'running', 'waiting']);

async function advance(st: CtxWatchState, u: Usage) {
  switch (st.phase) {
    case 'halted':
      if (st.firedSession !== u.session) await save(st, { phase: 'idle' });
      return;
    case 'idle': {
      if (u.pct < config.ctxwatchThreshold || st.firedSession === u.session) return;
      if (st.retryAfter && u.at <= st.retryAfter) return;
      const gap = st.firedAt ? Date.now() - st.firedAt.getTime() : Infinity;
      if (gap < config.ctxwatchMinGapMs) { // a fresh context that starts above the threshold would loop forever
        const msg = `loop guard: above the threshold within ${Math.round(config.ctxwatchMinGapMs / 1000)}s of the last handoff, not firing`;
        if (st.lastError !== msg) { await save(st, { lastError: msg }); await board(st.threadId, msg); }
        return;
      }
      await save(st, { phase: 'handoff_pending', firedSession: u.session, firedAt: new Date(), gateAt: null, retryAfter: null, handoffRunId: null, resumeRunId: null });
      return startHandoff(st, u);
    }
    case 'handoff_pending': return startHandoff(st, u);
    case 'handoff_sent': {
      const s = runStatus(st.handoffRunId ?? '');
      if (st.gateAt && s && ACTIVE.has(s)) return startResume(st);
      if (s === 'completed') return rearm(st, u, st.gateAt ? 'handoff completed before the gate was honoured' : `handoff run ${st.handoffRunId} completed without calling the gate`);
      if (s && TERMINAL_BAD.has(s)) return rearm(st, u, `handoff run ${st.handoffRunId} ended ${s}`);
      return;
    }
    case 'resume_pending': {
      const s = runStatus(st.handoffRunId ?? '');
      if (s && ACTIVE.has(s)) return startResume(st);
      return rearm(st, u, `handoff run ${st.handoffRunId} is ${s ?? 'gone'} before the resume could be queued`);
    }
    case 'resume_sent': {
      const h = runStatus(st.handoffRunId ?? '');
      const r = runStatus(st.resumeRunId ?? '');
      if (h && TERMINAL_BAD.has(h) && r === 'queued') { // handoff died after the gate: take our own resume back
        await callTool('t3_queue', { action: 'cancel', threadId: st.threadId, queuedRunId: st.resumeRunId });
        return rearm(st, u, `handoff run ${st.handoffRunId} ended ${h} after the gate; cancelled the queued resume`);
      }
      if (r === 'completed') { await save(st, { phase: 'idle' }); await board(st.threadId, `fresh context running (resume run ${st.resumeRunId} completed)`); }
      else if (r && TERMINAL_BAD.has(r)) { await save(st, { phase: 'halted' }); await board(st.threadId, `resume run ${st.resumeRunId} ended ${r}`); }
      return;
    }
  }
}

let busy = Promise.resolve();
const serial = <T>(fn: () => Promise<T>) => { const p = busy.then(fn, fn); busy = p.then(() => {}, () => {}); return p; };

async function visit(threadId: string, titleToo: boolean) {
  const st = await load(threadId);
  if (st.optOut || config.ctxwatchSkipThreads.includes(threadId)) return;
  const u = latestUsage(threadId);
  if (!u) return;
  try {
    if (titleToo) await syncTitle(st, u.pct);
  } catch (e) { await fail(st, 'title update failed, will retry', e); }
  try {
    await advance(st, u);
  } catch (e) {
    if (e instanceof QueueViolation) {
      await save(st, { phase: 'halted' });
      await board(threadId, `STOPPED, queue check failed after insert: ${e.message}`);
    } else await fail(st, `${st.phase} step failed, will retry`, e);
  }
}

async function tick() {
  const since = new Date(Date.now() - config.ctxwatchActiveHours * 3_600_000).toISOString();
  const only = config.ctxwatchOnlyThreads;
  for (const t of liveThreads(since)) {
    if (t.relationship || t.id.startsWith('thread:')) continue; // subagent / delegated children
    if (only.length && !only.includes(t.id)) continue;
    await visit(t.id, true);
  }
  fs.writeFileSync(HEARTBEAT, JSON.stringify({ at: new Date().toISOString() }));
}

// while a handoff or resume run is pending the next step must land within seconds, or the user's
// first queued message would start in the old context
async function fastTick() {
  for (const st of await CtxWatch.find({ phase: { $in: ['handoff_pending', 'handoff_sent', 'resume_pending', 'resume_sent'] } }).toArray()) await visit(st.threadId, true);
}

if (!config.ctxwatchEnabled) { console.log('ctxwatch off: CTXWATCH=off or DARBAR_T3=off'); process.exit(0); }
await initDb();
await CtxWatch.createIndex({ threadId: 1 }, { unique: true });
console.log(`ctxwatch on: threshold ${config.ctxwatchThreshold}%, poll ${config.ctxwatchPollMs}ms${config.ctxwatchOnlyThreads.length ? `, only ${config.ctxwatchOnlyThreads.join(',')}` : ''}`);
const guard = (fn: () => Promise<void>) => () => { void serial(fn).catch((e) => console.error('ctxwatch tick', e)); };
setInterval(guard(tick), config.ctxwatchPollMs);
setInterval(guard(fastTick), config.ctxwatchPhasePollMs);
guard(tick)();
