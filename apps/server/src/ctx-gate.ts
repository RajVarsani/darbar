// DAR-419. The gate a handoff run calls as its LAST step. It returns only after the context watcher
// has queued the fresh-context resume ahead of the user's runs, so the resume is already in line
// when the handoff run ends. No call, no resume, no clear.
import { Hono } from 'hono';
import { CtxWatch, config } from '@darbar/core';

export const ctxGate = new Hono();

ctxGate.post('/handoff-done', async (c) => {
  const b = (await c.req.json().catch(() => null)) as { threadId?: unknown } | null;
  const threadId = b && typeof b.threadId === 'string' ? b.threadId.trim() : '';
  if (!threadId) return c.json({ error: 'threadId (string) is required' }, 400);
  const armed = await CtxWatch.updateOne({ threadId, phase: { $in: ['handoff_pending', 'handoff_sent'] } }, { $set: { gateAt: new Date() } });
  if (!armed.matchedCount) return c.json({ error: 'no handoff is pending for this thread' }, 409);
  const until = Date.now() + config.ctxwatchGateWaitMs;
  while (Date.now() < until) {
    const st = await CtxWatch.findOne({ threadId });
    if (st?.phase === 'resume_sent') return c.json({ ok: true, resumeRunId: st.resumeRunId });
    if (!st || (st.phase !== 'handoff_pending' && st.phase !== 'handoff_sent' && st.phase !== 'resume_pending')) return c.json({ error: st?.lastError ?? 'the watcher declined to queue the resume' }, 409);
    await Bun.sleep(250);
  }
  return c.json({ error: 'the watcher did not queue the resume in time (is ctxwatch running?)' }, 504);
});
