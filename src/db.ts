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
  await Tasks.createIndex({ projectId: 1 });
  await Tasks.createIndex({ shortId: 1 }, { unique: true });
  await Feedback.createIndex({ projectId: 1, status: 1 });
  await Feedback.createIndex({ status: 1, createdAt: 1 });
  await Feedback.createIndex({ shortId: 1 }, { unique: true });
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
