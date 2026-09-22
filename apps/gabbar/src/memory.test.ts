// DAR-282 (gabbar half of DAR-276): memory.ts no longer reads/writes a markdown directory, it
// calls darbar's memory graph (POST /memory/remember, GET /memory/recall, POST /memory/supersede)
// through fetchDarbar. Pinned here:
//  1. path -> (type, name, project) mapping: people/ -> person, projects/<ref> -> project AND
//     scopes the call to that project, preferences/ -> preference, anything else -> gotcha.
//  2. view() recalls; an exact type+name match returns the node's observations, a fuzzy miss lists
//     what recall found, no hits at all says the path does not exist.
//  3. create()/insert() call remember(); an UNREACHABLE darbar holds the write to disk instead of
//     losing it (same invariant DAR-229 established for feedback, write-failure.test.ts) and says so
     // rather than claiming it landed.
//  4. str_replace() appends the correction as a new node and supersedes the old one, never mutates,
//     and a not-found path is reported rather than silently creating one.
//  5. delete()/rename() always refuse: nothing in the graph API deletes or moves anything.
//  6. memoryTree() is static guidance with NO network call; readPersonFile() recalls a person node
//     read-only and returns null (not a throw) when darbar is unreachable.
//  7. every request goes through fetchDarbar, not a raw fetch — lookups.test.ts already guards that
//     config.apiUrl appears nowhere else in apps/gabbar/src, so this file just exercises the calls.
import { afterAll, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const RIG = mkdtempSync(path.join(tmpdir(), 'darbar-memory-'));
process.env.PARKED_DIR = path.join(RIG, 'parked');
process.env.MEMORY_DIR = path.join(RIG, 'memory-dir-unused'); // tolerated, never read
process.env.MEMORY_HOLD_DIR = path.join(RIG, 'memory-hold');
process.env.FILES_DIR = path.join(RIG, 'files');
process.env.SLACK_API_BASE = 'http://127.0.0.1:9/slack-stub';
process.env.SLACK_BOT_TOKEN = 'xoxb-stub-not-a-real-token';
process.env.SLACK_APP_TOKEN = 'xapp-stub-not-a-real-token';
process.env.GABBAR_OWNER_ID = 'U000000STUBOWNER';
process.env.ANTHROPIC_API_KEY = 'sk-ant-stub-not-a-real-key';
process.env.MC_API = 'http://127.0.0.1:9/api';

const STUB_SLACK = 'http://127.0.0.1:9/slack-stub';
const STUB_API = 'http://127.0.0.1:9/api';
const { config } = await import('@darbar/core');
Object.assign(config, {
  slackApiBase: STUB_SLACK,
  slackBotToken: 'xoxb-stub-not-a-real-token',
  slackAppToken: 'xapp-stub-not-a-real-token',
  gabbarOwnerId: 'U000000STUBOWNER',
  apiUrl: STUB_API,
});
const loopback = (u: string) => /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])([:/]|$)/.test(u);
if (!loopback(config.slackApiBase) || !loopback(config.apiUrl)) {
  throw new Error(`refusing to import memory.ts: slack=${config.slackApiBase} darbar=${config.apiUrl} are not both loopback`);
}

type Reply = 'refused' | { status?: number; body?: unknown };
type Sent = { url: string; method: string; body: Record<string, unknown> };
const sent: Sent[] = [];
let router: (url: string, method: string, body: Record<string, unknown>) => Reply = () => ({ body: {} });
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: unknown, init?: { method?: string; body?: string }) => {
  const url = String(input);
  if (!url.startsWith(STUB_API) && !url.startsWith(STUB_SLACK)) {
    throw new Error(`test tried to reach ${url}; every call in this file must be stubbed`);
  }
  const method = init?.method ?? 'GET';
  let body: Record<string, unknown> = {};
  try { body = init?.body ? JSON.parse(init.body) : {}; } catch { body = {}; }
  sent.push({ url, method, body });
  const r = router(url, method, body);
  if (r === 'refused') throw new Error('connection refused');
  return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
}) as typeof globalThis.fetch;

// memory.ts imports fetchDarbar from agent.ts (circular, same pattern as lookups.ts), so importing
// memory.ts pulls in the whole agent module. That is fine here: no slack socket opens (bot.ts is
// never imported) and every darbar/slack call is already stubbed above.
const { memoryTool, memoryTree, readPersonFile, drainMemoryHoldForTest } = await import('./memory');

afterAll(() => {
  globalThis.fetch = realFetch;
  rmSync(RIG, { recursive: true, force: true });
});
beforeEach(() => {
  sent.length = 0;
  router = () => ({ body: {} });
  rmSync(process.env.MEMORY_HOLD_DIR!, { recursive: true, force: true });
});

// betaMemoryTool() returns a BetaRunnableTool whose `run(args)` dispatches to the handler named by
// args.command — that is the one call surface it exposes (see the SDK's helpers/beta/memory.js),
// and it is what toolRunner() itself calls, so exercising it here is exercising the real path.
type Cmd = { command: string; path?: string; file_text?: string; old_str?: string; new_str?: string; insert_line?: number; insert_text?: string; old_path?: string; new_path?: string };
async function call(cmd: Cmd): Promise<string> {
  const out = await (memoryTool as unknown as { run: (c: Cmd) => Promise<string> }).run(cmd);
  return typeof out === 'string' ? out : JSON.stringify(out);
}

const recallGet = () => sent.filter((s) => s.method === 'GET' && s.url.includes('/memory/recall'));
const rememberPost = () => sent.filter((s) => s.method === 'POST' && s.url.endsWith('/memory/remember'));
const supersedePost = () => sent.filter((s) => s.method === 'POST' && s.url.endsWith('/memory/supersede'));

// ---------- memoryTree / readPersonFile ----------

test('memoryTree is static guidance and makes no network call', async () => {
  const tree = await memoryTree();
  expect(tree).toContain('memory graph');
  expect(sent.length).toBe(0);
});

test('readPersonFile recalls a person node read-only', async () => {
  router = (url) => {
    expect(url).toContain('type=person');
    return { body: { nodes: [{ name: 'Raj', type: 'person', project: null, observations: [{ text: 'owns darbar', at: '2026-01-01', source: 'gabbar' }] }], edges: [] } };
  };
  const out = await readPersonFile('Raj');
  expect(out).toBe('1: owns darbar');
});

test('readPersonFile returns null, not a throw, when darbar is unreachable', async () => {
  router = () => 'refused';
  expect(await readPersonFile('Raj')).toBeNull();
});

test('readPersonFile returns null when no person node matches', async () => {
  router = () => ({ body: { nodes: [], edges: [] } });
  expect(await readPersonFile('Nobody')).toBeNull();
});

// ---------- path mapping ----------

test('a people/ path recalls type=person, no project scope', async () => {
  router = () => ({ body: { nodes: [], edges: [] } });
  await call({ command: 'view', path: '/memories/people/raj.md' });
  const q = new URL(recallGet()[0]!.url).searchParams;
  expect(q.get('type')).toBe('person');
  expect(q.get('q')).toBe('raj');
  expect(q.has('project')).toBe(false);
});

test('a projects/<ref> path recalls type=project AND scopes to that project', async () => {
  router = () => ({ body: { nodes: [], edges: [] } });
  await call({ command: 'view', path: '/memories/projects/DAR.md' });
  const q = new URL(recallGet()[0]!.url).searchParams;
  expect(q.get('type')).toBe('project');
  expect(q.get('project')).toBe('DAR');
});

test('anything else falls back to type=gotcha, global scope', async () => {
  router = () => ({ body: { nodes: [], edges: [] } });
  await call({ command: 'view', path: '/memories/workspace.md' });
  const q = new URL(recallGet()[0]!.url).searchParams;
  expect(q.get('type')).toBe('gotcha');
  expect(q.has('project')).toBe(false);
});

// ---------- view ----------

test('view returns the exact node\'s observations as numbered lines', async () => {
  router = () => ({
    body: {
      nodes: [{ name: 'raj', type: 'person', project: null, observations: [{ text: 'owns darbar', at: '', source: 'x' }, { text: 'likes chai', at: '', source: 'x' }] }],
      edges: [],
    },
  });
  const out = await call({ command: 'view', path: '/memories/people/raj.md' });
  expect(out).toBe('1: owns darbar\n2: likes chai');
});

test('view with no exact match lists whatever recall found', async () => {
  router = () => ({ body: { nodes: [{ name: 'raj varsani', type: 'gotcha', project: null, observations: [] }], edges: [] } });
  const out = await call({ command: 'view', path: '/memories/raj.md' });
  expect(out).toBe('gotcha/raj varsani');
});

test('view with no hits at all says the path does not exist', async () => {
  router = () => ({ body: { nodes: [], edges: [] } });
  const out = await call({ command: 'view', path: '/memories/nothing-here.md' });
  expect(out).toBe('/memories/nothing-here.md does not exist');
});

test('view on the root returns the static tree, no network call', async () => {
  const out = await call({ command: 'view', path: '/memories' });
  expect(out).toContain('memory graph');
  expect(sent.length).toBe(0);
});

// ---------- create ----------

test('create calls remember with the right node shape', async () => {
  router = () => ({ body: { node: {}, edges: [] } });
  const out = await call({ command: 'create', path: '/memories/people/raj.md', file_text: 'owns darbar' });
  expect(out).toBe('remembered /memories/people/raj.md');
  const body = rememberPost()[0]!.body;
  expect(body.node).toEqual({ name: 'raj', type: 'person', project: undefined });
  expect((body.observations as Array<{ text: string }>)[0]!.text).toBe('owns darbar');
});

test('create on an unreachable darbar holds the write instead of losing it', async () => {
  router = () => 'refused';
  const out = await call({ command: 'create', path: '/memories/people/raj.md', file_text: 'owns darbar' });
  expect(out).toContain('held locally');
  expect(out).toContain('NOT yet in memory');
  const files = readdirSync(process.env.MEMORY_HOLD_DIR!);
  expect(files.length).toBe(1);
  const held = JSON.parse(readFileSync(path.join(process.env.MEMORY_HOLD_DIR!, files[0]!), 'utf-8'));
  expect(held.kind).toBe('remember');
  expect(held.path).toBe('/memories/people/raj.md');
  expect((held.body.observations[0] as { text: string }).text).toBe('owns darbar');
});

test('create surfaces a server-side refusal as-is, and holds nothing', async () => {
  router = () => ({ body: { error: 'node.name is 1 chars' }, status: 400 });
  const out = await call({ command: 'create', path: '/memories/people/x.md', file_text: 'y' });
  expect(out).toBe('node.name is 1 chars');
  expect(existsSync(process.env.MEMORY_HOLD_DIR!), 'darbar answering with a refusal is not a loss and must not hold anything').toBe(false);
});

// ---------- insert ----------

test('insert appends via remember, same as create', async () => {
  router = () => ({ body: { node: {}, edges: [] } });
  const out = await call({ command: 'insert', path: '/memories/people/raj.md', insert_line: 0, insert_text: 'also likes chai' });
  expect(out).toBe('inserted into /memories/people/raj.md');
  expect((rememberPost()[0]!.body.observations as Array<{ text: string }>)[0]!.text).toBe('also likes chai');
});

// ---------- str_replace ----------

test('str_replace on a path that does not exist is reported, not silently created', async () => {
  router = () => ({ body: { nodes: [], edges: [] } });
  const out = await call({ command: 'str_replace', path: '/memories/people/nobody.md', old_str: 'a', new_str: 'b' });
  expect(out).toBe('/memories/people/nobody.md does not exist');
  expect(rememberPost().length).toBe(0);
});

test('str_replace appends a new revision node and supersedes the old one', async () => {
  router = (url, method) => {
    if (method === 'GET') return { body: { nodes: [{ name: 'raj', type: 'person', project: null, observations: [{ text: 'likes coffee', at: '', source: 'x' }] }], edges: [] } };
    if (url.endsWith('/memory/remember')) return { body: { node: {}, edges: [] } };
    return { body: { invalidatedNode: {}, supersedes: {} } };
  };
  const out = await call({ command: 'str_replace', path: '/memories/people/raj.md', old_str: 'likes coffee', new_str: 'likes tea now' });
  expect(out).toBe('edited /memories/people/raj.md');
  const rBody = rememberPost()[0]!.body;
  expect((rBody.node as { name: string }).name).toContain('raj (rev ');
  expect((rBody.observations as Array<{ text: string }>)[0]!.text).toBe('likes tea now');
  const sBody = supersedePost()[0]!.body;
  expect(sBody.nodeName).toBe('raj');
  expect(sBody.by).toBe((rBody.node as { name: string }).name);
});

test('str_replace holds the new content if darbar is unreachable for the remember half', async () => {
  router = (url, method) => (method === 'GET' ? { body: { nodes: [{ name: 'raj', type: 'person', project: null, observations: [] }], edges: [] } } : 'refused');
  const out = await call({ command: 'str_replace', path: '/memories/people/raj.md', old_str: 'a', new_str: 'b' });
  expect(out).toContain('held locally');
  expect(readdirSync(process.env.MEMORY_HOLD_DIR!).length).toBe(1);
});

test('str_replace holds the supersede half if it is the one that fails, keeping the new content saved', async () => {
  router = (url, method) => {
    if (method === 'GET') return { body: { nodes: [{ name: 'raj', type: 'person', project: null, observations: [] }], edges: [] } };
    if (url.endsWith('/memory/remember')) return { body: { node: {}, edges: [] } };
    return 'refused'; // the supersede call
  };
  const out = await call({ command: 'str_replace', path: '/memories/people/raj.md', old_str: 'a', new_str: 'b' });
  expect(out).toContain('was saved as raj (rev ');
  expect(out).toContain('held locally');
  const files = readdirSync(process.env.MEMORY_HOLD_DIR!);
  expect(files.length).toBe(1);
  const held = JSON.parse(readFileSync(path.join(process.env.MEMORY_HOLD_DIR!, files[0]!), 'utf-8'));
  expect(held.kind).toBe('supersede');
});

// ---------- delete / rename: nothing deletes, nothing moves ----------

test('delete always refuses, whatever path it is given', async () => {
  const out = await call({ command: 'delete', path: '/memories/people/raj.md' });
  expect(out).toContain('never deletes');
  expect(sent.length).toBe(0);
});

test('rename always refuses', async () => {
  const out = await call({ command: 'rename', old_path: '/memories/a.md', new_path: '/memories/b.md' });
  expect(out).toContain('no rename');
  expect(sent.length).toBe(0);
});

// ---------- drain: held payloads must reach the graph once darbar answers again (DAR-287) ----------

test('drain replays held payloads in order and removes them once darbar answers 2xx', async () => {
  router = () => 'refused';
  await call({ command: 'create', path: '/memories/people/a.md', file_text: 'alpha' });
  await call({ command: 'create', path: '/memories/people/b.md', file_text: 'beta' });
  expect(readdirSync(process.env.MEMORY_HOLD_DIR!).length).toBe(2);

  sent.length = 0;
  router = () => ({ body: { node: {}, edges: [] } });
  await drainMemoryHoldForTest();

  expect(existsSync(process.env.MEMORY_HOLD_DIR!) ? readdirSync(process.env.MEMORY_HOLD_DIR!).length : 0).toBe(0);
  const replayedTexts = rememberPost().map((s) => (s.body.observations as Array<{ text: string }>)[0]!.text);
  expect(replayedTexts).toEqual(['alpha', 'beta']); // creation order preserved
});

test('a held payload whose replay 500s stays held and is logged exactly once across two drain ticks', async () => {
  router = () => 'refused';
  await call({ command: 'create', path: '/memories/people/c.md', file_text: 'gamma' });
  expect(readdirSync(process.env.MEMORY_HOLD_DIR!).length).toBe(1);

  router = () => ({ body: { error: 'boom' }, status: 500 });
  const realError = console.error;
  const errors: unknown[][] = [];
  console.error = (...args: unknown[]) => { errors.push(args); };
  try {
    await drainMemoryHoldForTest();
    await drainMemoryHoldForTest();
  } finally {
    console.error = realError;
  }

  expect(readdirSync(process.env.MEMORY_HOLD_DIR!).length, 'a replay failure must keep the hold file').toBe(1);
  const drainErrors = errors.filter((a) => String(a[0]).includes('replaying held memory'));
  expect(drainErrors.length, 'must log exactly once across two ticks, not once per tick').toBe(1);
});

// ---------- every call goes through fetchDarbar ----------

test('nothing in this file reached the stub API through a path other than fetchDarbar\'s /memory/* routes', () => {
  for (const s of sent) {
    expect(s.url.startsWith(`${STUB_API}/memory/`), `unexpected call: ${s.method} ${s.url}`).toBe(true);
  }
});
