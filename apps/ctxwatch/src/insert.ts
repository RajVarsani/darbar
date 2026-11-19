// The one write that touches a user's queue: put ONE run at the front of it, then prove nothing
// of the user's moved, changed or vanished. Anything else fails closed.
import { createHash } from 'node:crypto';
import { callTool, T3ToolError } from './t3mcp';
import { checkQueue, type QItem } from './pure';
import { runStatus } from './usage';

export class QueueViolation extends Error {}

const STARTED = new Set(['preparing', 'starting', 'running', 'waiting', 'completed']);
const settled = (id: string) => STARTED.has(runStatus(id) ?? '');

export async function listQueue(threadId: string): Promise<QItem[]> {
  const out: QItem[] = [];
  let cursor: number | null = 0;
  while (cursor !== null) {
    const page: { items: QItem[]; nextCursor: number | null } = await callTool('t3_queue', { action: 'list', threadId, cursor, limit: 100 });
    out.push(...page.items.map((i) => ({ queuedRunId: i.queuedRunId, text: i.text })));
    cursor = page.nextCursor;
  }
  return out;
}

export const requestKey = (threadId: string, session: string, kind: string) =>
  createHash('sha256').update(`${threadId}|${session}|${kind}`).digest('hex').slice(0, 32);

/** send `message` (mode queue, never steer) and move it ahead of every user run; returns our run id */
export async function insertAtFront(threadId: string, message: string, key: string, freshContext: boolean): Promise<string> {
  const before = (await listQueue(threadId)).filter((q) => q.text !== message); // a re-send after a crash may already be queued
  const sent = await callTool<{ runId: string }>('t3_thread_send', { threadId, message, mode: 'queue', clientRequestId: key, ...(freshContext ? { freshContext: true } : {}) });
  const ours = sent.runId;
  const userIds = new Set(before.map((b) => b.queuedRunId));
  for (let attempt = 0; attempt < 6; attempt++) {
    const now = await listQueue(threadId);
    const mine = now.findIndex((q) => q.queuedRunId === ours);
    if (mine < 0) break; // started already: nothing queued behind it to reorder
    const firstUser = now.findIndex((q) => userIds.has(q.queuedRunId));
    if (firstUser < 0 || mine < firstUser) break;
    try {
      await callTool('t3_queue', { action: 'reorder', threadId, queuedRunId: ours, beforeRunId: now[firstUser]!.queuedRunId });
    } catch (e) {
      if (!(e instanceof T3ToolError)) throw e; // run left the queue between list and reorder: re-list
    }
  }
  const after = await listQueue(threadId);
  const bad = checkQueue(before, after, ours, settled);
  if (bad) throw new QueueViolation(`${bad}; queue before=[${before.map((b) => b.queuedRunId).join(',')}] after=[${after.map((a) => a.queuedRunId).join(',')}]`);
  return ours;
}
