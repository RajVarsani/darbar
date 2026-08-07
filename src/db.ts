import { MongoClient, ObjectId } from 'mongodb';

const client = new MongoClient(process.env.MONGO_URI || 'mongodb://localhost:27017');
export const db = client.db('mission_control');

export const Projects = db.collection('projects');
export const Tasks = db.collection('tasks');
export const Feedback = db.collection('feedback');
export const Events = db.collection('events');

export { ObjectId };

export async function initDb() {
  await client.connect();
  await Projects.createIndex({ capId: 1 }, { unique: true });
  await Projects.createIndex({ prefix: 1 }, { unique: true });
  await Tasks.createIndex({ projectId: 1 });
  await Tasks.createIndex({ shortId: 1 }, { unique: true });
  await Feedback.createIndex({ projectId: 1, status: 1 });
  await Feedback.createIndex({ shortId: 1 }, { unique: true });
  await Events.createIndex({ projectId: 1, at: -1 });
}

const ALPHA = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
export function capId(len = 21): string {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let out = '';
  for (const b of bytes) out += ALPHA[b % ALPHA.length];
  return out;
}

// atomic per-project counters -> TST-1, TST-2 / FB-1, FB-2
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
