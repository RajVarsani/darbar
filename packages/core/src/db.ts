import { MongoClient, ObjectId } from 'mongodb';
import type { Collection } from 'mongodb';
import { config } from './config';
import type { CtxWatchState, Project, Task, FeedbackDoc, EventDoc, MemoryNode, MemoryEdge, MemoryEpisode } from './types';

const client = new MongoClient(config.mongoUri);
export const db = client.db(config.dbName);

export const Projects = db.collection<Project>('projects');
export const Tasks = db.collection<Task>('tasks');
export const Feedback = db.collection<FeedbackDoc>('feedback');
export const Events = db.collection<EventDoc>('events');
export const CtxWatch = db.collection<CtxWatchState>('ctxwatch');
export const MemoryNodes = db.collection<MemoryNode>('memory_nodes');
export const MemoryEdges = db.collection<MemoryEdge>('memory_edges');
export const MemoryEpisodes = db.collection<MemoryEpisode>('memory_episodes');

export { ObjectId };

// The full index set, as one function rather than inlined in initDb: the test harness runs against
// a scratch database whose teardown() drops indexes a still-running test file needs (DAR-279 #8),
// and re-running THIS is the real fix, not a one-off recreate of whichever index a test happened to
// hit. Takes the collections as arguments so it works unchanged against either the live bindings
// above or the harness's scratch ones.
export async function ensureIndexes(colls: {
  Projects: Collection<Project>;
  Tasks: Collection<Task>;
  Feedback: Collection<FeedbackDoc>;
  Events: Collection<EventDoc>;
  MemoryNodes: Collection<MemoryNode>;
  MemoryEdges: Collection<MemoryEdge>;
}) {
  const { Projects: P, Tasks: T, Feedback: F, Events: E, MemoryNodes: MN, MemoryEdges: ME } = colls;
  await P.createIndex({ capId: 1 }, { unique: true });
  await P.createIndex({ prefix: 1 }, { unique: true });
  // proxy.prefix is the routing key. The API's read-then-write collision check is advisory (two
  // concurrent PATCHes both pass it), so uniqueness is backed here. Partial so the vast majority of
  // projects — which have no proxy at all — are not all colliding on a missing field.
  // A pre-existing duplicate must not brick boot: log it, the advisory check still applies.
  try {
    await P.createIndex({ 'proxy.prefix': 1 }, { unique: true, partialFilterExpression: { 'proxy.prefix': { $type: 'string' } } });
  } catch (e) {
    console.error(`unique index on proxy.prefix NOT created (${String(e)}) — prefix uniqueness is advisory only until this is resolved`);
  }
  await T.createIndex({ projectId: 1 });
  await T.createIndex({ shortId: 1 }, { unique: true });
  await F.createIndex({ projectId: 1, status: 1 });
  await F.createIndex({ status: 1, createdAt: 1 });
  await F.createIndex({ shortId: 1 }, { unique: true });
  // DAR-241. POST /feedback's idempotency check is read-then-insert, so two callers presenting one
  // key can both miss it and both file. Reachable, not theoretical: the sweep builds the key from
  // the HELD item's original message, so two messages from the same sender in flight at once sweep
  // the same held item and present the identical key. Uniqueness is backed here; the route's read
  // stays as the fast path that answers without an error.
  // Partial for the same reason as proxy.prefix above: almost every row has no key at all, and a
  // plain unique index would collide them all on a missing value.
  // A pre-existing duplicate must not brick boot: log it, the read-then-insert check still applies.
  try {
    await F.createIndex({ projectId: 1, idempotencyKey: 1 }, { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } });
  } catch (e) {
    console.error(`unique index on {projectId, idempotencyKey} NOT created (${String(e)}) — feedback idempotency is advisory only until this is resolved`);
  }
  await F.createIndex({ 'slack.channel': 1, 'slack.ts': 1 });
  await E.createIndex({ projectId: 1, at: -1 });
  // DAR-274. recall()'s $text match runs over both the node's name and everything ever observed
  // about it, so a search for a phrase buried in an old observation still finds the node.
  await MN.createIndex({ name: 'text', 'observations.text': 'text' });
  await MN.createIndex({ project: 1, slug: 1 }, { unique: true });
  // the two directions recall()'s $graphLookup and supersede() walk edges in
  await ME.createIndex({ from: 1, relation: 1 });
  await ME.createIndex({ to: 1, relation: 1 });
}

export async function initDb() {
  await client.connect();
  await ensureIndexes({ Projects, Tasks, Feedback, Events, MemoryNodes, MemoryEdges });
}

const ALPHA = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
export function capId(len = config.capIdLen): string {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let out = '';
  for (const b of bytes) out += ALPHA[b % ALPHA.length];
  return out;
}

// atomic per-project counters -> TST-1, TST-2 / TST-FB-1, TST-FB-2
export async function nextShortId(projectId: ObjectId, kind: 'task' | 'feedback'): Promise<string> {
  const field = `counters.${kind}`;
  const doc = await Projects.findOneAndUpdate(
    { _id: projectId },
    { $inc: { [field]: 1 } },
    { returnDocument: 'after' },
  );
  if (!doc) throw new Error('project not found');
  const n = doc.counters[kind];
  return kind === 'task' ? `${doc.prefix}-${n}` : `${doc.prefix}-FB-${n}`;
}
