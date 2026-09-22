// The rig every apps/server test runs the real routes on, in-process, against a scratch database.
//
// WHY THIS EXISTS. Every lane that needed to check an engine rule so far booted the whole server on
// a spare port against live Mongo, curled it, and threw the setup away — repeated effort producing
// no lasting net, and 42 probe rows on the live DAR board that had to be purged. This is the cheap
// alternative: `api` is the same Hono app server.ts mounts, so a request here goes through the same
// route, the same guards and the same pipeline engine, with no port, no process and no live data.
//
// WHY A MODULE MOCK RATHER THAN DB_NAME. bun runs every test file in ONE process, and
// packages/core/src/db.ts binds its collections to `client.db(config.dbName)` the first time ANY
// file imports @darbar/core — which, in a full `bun test`, is a gabbar test long before anything
// under apps/server loads. Setting process.env.DB_NAME in a test file is therefore too late and
// silently no-ops (verified: it still resolved to mission_control). mock.module updates the live
// bindings inside api.ts even though api.ts is already imported, so this works whatever order bun
// walks the files in, which is the property the old PARKED_DIR rig learned the hard way.
//
// nextShortId is re-implemented below rather than re-exported because the real one closes over
// db.ts's own `Projects` const: re-exporting it would $inc the counters on the LIVE project docs.
// It is eight lines and it is the only duplication here.
import { mock } from 'bun:test';
import * as core from '@darbar/core';

// Minimal structural types: apps/server does not depend on the mongodb package, and this needs four
// methods off it, so the driver's types are not worth pulling in.
type AnyDoc = Record<string, unknown>;
type AnyColl = {
  deleteMany(filter: AnyDoc): Promise<unknown>;
  findOneAndUpdate(filter: AnyDoc, update: AnyDoc, opts: AnyDoc): Promise<AnyDoc | null>;
  createIndex(spec: AnyDoc, opts?: AnyDoc): Promise<unknown>;
};
type AnyDb = { databaseName: string; collection(name: string): AnyColl; dropDatabase(): Promise<unknown> };
type AnyClient = { db(name: string): AnyDb; connect(): Promise<unknown>; close(): Promise<unknown> };

// pid-scoped so two agents running `bun test` on this checkout at once cannot collide. A crashed run
// can leave one empty database behind; a re-run under the same pid drops it before it writes.
const SCRATCH = `darbar_test_${process.pid}`;
if (SCRATCH === core.config.dbName) throw new Error('scratch database name collides with the live one');

const client = (core.db as unknown as { client: AnyClient }).client;
const scratch = client.db(SCRATCH);
// the guard that matters: nothing below may ever run against mission_control
if (scratch.databaseName !== SCRATCH || scratch.databaseName === core.config.dbName) {
  throw new Error(`refusing to run: scratch db resolved to ${scratch.databaseName}`);
}

const Projects = scratch.collection('projects');
const Tasks = scratch.collection('tasks');
const Feedback = scratch.collection('feedback');
const Events = scratch.collection('events');
const MemoryNodes = scratch.collection('memory_nodes');
const MemoryEdges = scratch.collection('memory_edges');
const MemoryEpisodes = scratch.collection('memory_episodes');

// verbatim copy of packages/core/src/db.ts, pointed at the scratch collection. See the note above.
async function nextShortId(projectId: unknown, kind: 'task' | 'feedback'): Promise<string> {
  const doc = await Projects.findOneAndUpdate(
    { _id: projectId } as AnyDoc,
    { $inc: { [`counters.${kind}`]: 1 } },
    { returnDocument: 'after' },
  );
  if (!doc) throw new Error('project not found');
  const n = (doc.counters as Record<string, number>)[kind];
  return kind === 'task' ? `${doc.prefix}-${n}` : `${doc.prefix}-FB-${n}`;
}

mock.module('@darbar/core', () => ({
  ...core, db: scratch, Projects, Tasks, Feedback, Events, MemoryNodes, MemoryEdges, MemoryEpisodes, nextShortId,
}));

await client.connect();
await scratch.dropDatabase();

// imported AFTER the mock so a first-time import picks it up, and re-bound by it if another file
// already imported api.ts earlier in the run
const { api } = await import('./api');
export { api };

export type Res<T = AnyDoc> = { status: number; body: T; error: string };

export async function req<T = AnyDoc>(method: string, path: string, body?: unknown): Promise<Res<T>> {
  const r = await api.request(path, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const j = (await r.json()) as T & { error?: string };
  return { status: r.status, body: j, error: j.error ?? '' };
}

/** every collection emptied; call it in beforeEach so one test's rows can never explain another's */
export async function reset() {
  for (const coll of [Projects, Tasks, Feedback, Events, MemoryNodes, MemoryEdges, MemoryEpisodes]) await coll.deleteMany({});
  // SCRATCH is one pid-scoped database SHARED by every test file in this bun run, and teardown()
  // (dropDatabase) from a file that finishes before this one starts drops it out from under an
  // index created only once at module load. recall()'s $text query needs this index to exist, so
  // it is recreated here on every reset rather than once — createIndex is a no-op once it already
  // matches, so this costs nothing on the common path.
  await MemoryNodes.createIndex({ name: 'text', 'observations.text': 'text' });
}

let torn = false;
/**
 * Drop the scratch database and give api.ts its real collections back. Register as afterAll in every
 * file that uses this rig.
 *
 * The client is deliberately NOT closed: it is the one @darbar/core built, other test files reach
 * live Mongo through it after this file finishes (field-drop.test.ts queries for a project that does
 * not exist), and closing it here turned four of their passes into 500s.
 */
export async function teardown() {
  if (torn) return;
  torn = true;
  await scratch.dropDatabase();
  mock.module('@darbar/core', () => core);
}

// ---------- fixtures ----------
// Prefixes are pid-free and per-call unique because a project prefix is a lookup key and reset()
// between tests makes reuse safe, but a single test that wants two projects needs two.
let n = 0;
const LANES = [
  { lane: 'code-review', label: 'Code review', manager: 'staff-engineer' },
  { lane: 'qa', label: 'QA', manager: 'qa-lead' },
  { lane: 'design-qa', label: 'DQA', manager: 'staff-designer' },
];

type ProjectRow = { prefix: string; capId: string; _id: string };
export async function project(over: AnyDoc = {}): Promise<ProjectRow> {
  const prefix = `TS${String.fromCharCode(65 + (n++ % 26))}`;
  const r = await req<ProjectRow>('POST', '/projects', {
    name: `scratch ${prefix}`,
    prefix,
    pipeline: { autoAdvance: true, reviews: LANES },
    ...over,
  });
  if (r.status !== 200) throw new Error(`fixture project failed: ${r.status} ${r.error}`);
  return r.body;
}

type TaskRow = { shortId: string; status: string; lanes: string[] | null; dispatchedAt: string | null };
export async function task(projectRef: string, over: AnyDoc = {}): Promise<TaskRow> {
  const r = await req<TaskRow>('POST', '/tasks', { project: projectRef, title: 'scratch task', ...over });
  if (r.status !== 200) throw new Error(`fixture task failed: ${r.status} ${r.error}`);
  return r.body;
}

type FeedbackRow = { shortId: string; status: string };
export async function feedback(over: AnyDoc = {}): Promise<FeedbackRow> {
  // deliberately never carries `slack`: a row with a thread makes the server post to the real
  // workspace on resolve/reject
  const r = await req<FeedbackRow>('POST', '/feedback', { body: 'scratch finding', ...over });
  if (r.status !== 200) throw new Error(`fixture feedback failed: ${r.status} ${r.error}`);
  return r.body;
}

/** the review children the pipeline spawned under a parent, in spawn order */
export async function children(parentRef: string): Promise<TaskRow[]> {
  const r = await req<{ tasks: (TaskRow & { origin: string })[] }>('GET', '/tasks?limit=1000');
  return r.body.tasks.filter((t) => t.origin === `pipeline:${parentRef}`).reverse();
}
