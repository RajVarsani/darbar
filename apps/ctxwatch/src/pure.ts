// Pure rules of the context watcher: title prefix, bucket, and the queue-integrity check.
export const PREFIX_RE = /^\d{1,3}% · /;
export const stripPrefix = (title: string) => title.replace(PREFIX_RE, '');
export const bucketOf = (pct: number, step: number) => Math.max(0, Math.floor(pct / step) * step);
export const titleFor = (title: string, bucket: number) => `${bucket}% · ${stripPrefix(title)}`;

export type QItem = { queuedRunId: string; text: string };
export type Settled = (runId: string) => boolean; // true when a run left the queue by actually starting

/**
 * The user's queued runs (`before`) against the queue after our insert. Ours may sit anywhere in
 * `after` only if it is ahead of every user run still queued. A user run may be missing only if it
 * started; its text must never differ; relative order must be unchanged.
 */
export function checkQueue(before: QItem[], after: QItem[], oursId: string, settled: Settled): string | null {
  const idxAfter = new Map(after.map((q, i) => [q.queuedRunId, i] as const));
  let prev = -1, firstUser = Infinity;
  for (const b of before) {
    const i = idxAfter.get(b.queuedRunId);
    if (i === undefined) {
      if (!settled(b.queuedRunId)) return `queued run ${b.queuedRunId} vanished without starting`;
      continue;
    }
    if (after[i]!.text !== b.text) return `queued run ${b.queuedRunId} text changed`;
    if (i < prev) return `queued run ${b.queuedRunId} moved out of order`;
    prev = i;
    firstUser = Math.min(firstUser, i);
  }
  const ours = idxAfter.get(oursId);
  if (ours !== undefined && ours > firstUser) return `our run sits behind user run at position ${firstUser}`;
  return null;
}
