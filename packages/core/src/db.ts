import { MongoClient, ObjectId } from 'mongodb';
import { config } from './config';
import type { Project, Task, FeedbackDoc, EventDoc } from './types';

const client = new MongoClient(config.mongoUri);
export const db = client.db(config.dbName);

export const Projects = db.collection<Project>('projects');
export const Tasks = db.collection<Task>('tasks');
export const Feedback = db.collection<FeedbackDoc>('feedback');
export const Events = db.collection<EventDoc>('events');

export { ObjectId };

export async function initDb() {
  await client.connect();
  await Projects.createIndex({ capId: 1 }, { unique: true });
  await Projects.createIndex({ prefix: 1 }, { unique: true });
  // proxy.prefix is the routing key. The API's read-then-write collision check is advisory (two
  // concurrent PATCHes both pass it), so uniqueness is backed here. Partial so the vast majority of
  // projects — which have no proxy at all — are not all colliding on a missing field.
  // A pre-existing duplicate must not brick boot: log it, the advisory check still applies.
  try {
    await Projects.createIndex({ 'proxy.prefix': 1 }, { unique: true, partialFilterExpression: { 'proxy.prefix': { $type: 'string' } } });
  } catch (e) {
    console.error(`unique index on proxy.prefix NOT created (${String(e)}) — prefix uniqueness is advisory only until this is resolved`);
  }
  await Tasks.createIndex({ projectId: 1 });
  await Tasks.createIndex({ shortId: 1 }, { unique: true });
  await Feedback.createIndex({ projectId: 1, status: 1 });
  await Feedback.createIndex({ status: 1, createdAt: 1 });
  await Feedback.createIndex({ shortId: 1 }, { unique: true });
  // DAR-241. POST /feedback's idempotency check is read-then-insert, so two callers presenting one
  // key can both miss it and both file. Reachable, not theoretical: the sweep builds the key from
  // the HELD item's original message, so two messages from the same sender in flight at once sweep
  // the same held item and present the identical key. Uniqueness is backed here; the route's read
  // stays as the fast path that answers without an error.
  // Partial for the same reason as proxy.prefix above: almost every row has no key at all, and a
  // plain unique index would collide them all on a missing value.
  // A pre-existing duplicate must not brick boot: log it, the read-then-insert check still applies.
  try {
    await Feedback.createIndex({ projectId: 1, idempotencyKey: 1 }, { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } });
  } catch (e) {
    console.error(`unique index on {projectId, idempotencyKey} NOT created (${String(e)}) — feedback idempotency is advisory only until this is resolved`);
  }
  await Feedback.createIndex({ 'slack.channel': 1, 'slack.ts': 1 });
  await Events.createIndex({ projectId: 1, at: -1 });
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
