// DAR-411: replies under a Gabbar-posted root in a project-bound channel are filed as feedback.
import { afterAll, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const RIG = mkdtempSync(path.join(tmpdir(), 'darbar-loop-'));
process.env.PARKED_DIR = path.join(RIG, 'parked');
process.env.MEMORY_DIR = path.join(RIG, 'memory');
process.env.FILES_DIR = path.join(RIG, 'files');

process.env.SLACK_API_BASE = 'http://127.0.0.1:9/slack-stub';
process.env.SLACK_BOT_TOKEN = 'xoxb-stub-not-a-real-token';
process.env.SLACK_APP_TOKEN = 'xapp-stub-not-a-real-token';
process.env.GABBAR_OWNER_ID = 'U000000STUBOWNER';
process.env.ANTHROPIC_API_KEY = 'sk-ant-stub-not-a-real-key';
process.env.MC_API = 'http://127.0.0.1:9/api';
const STUB_API = 'http://127.0.0.1:9/api';
const { config } = await import('@darbar/core');
Object.assign(config, { apiUrl: STUB_API, slackApiBase: 'http://127.0.0.1:9/slack-stub' });

const STUB_SLACK = 'http://127.0.0.1:9/slack-stub';
const slackCalls: Array<{ method: string; body: any }> = [];
let feedbackRes: () => Response = () => new Response(JSON.stringify({ shortId: 'FFERR-FB-1' }), { status: 200 });
const calls: Array<{ url: string; method: string; body: any }> = [];
let projects: unknown = [{ prefix: 'FFERR', slackChannel: 'C1', stakeholders: [{ name: 'Tanisha', slackUserId: 'U1' }] }];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: unknown, init?: { method?: string; body?: string }) => {
  const url = String(input);
  if (url.startsWith(STUB_SLACK)) {
    slackCalls.push({ method: url.slice(STUB_SLACK.length + 1), body: init?.body ? JSON.parse(init.body) : null });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }
  if (!url.startsWith(STUB_API)) throw new Error(`unstubbed ${url}`);
  calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body) : null });
  if (url.includes('/projects')) return new Response(JSON.stringify(projects), { status: 200 });
  if (url.endsWith('/feedback')) return feedbackRes();
  return new Response('{}', { status: 404 });
}) as typeof globalThis.fetch;
afterAll(() => { globalThis.fetch = realFetch; rmSync(RIG, { recursive: true, force: true }); });
beforeEach(() => {
  calls.length = 0; slackCalls.length = 0; rmSync(process.env.PARKED_DIR!, { recursive: true, force: true });
  projects = [{ prefix: 'FFERR', name: 'FF Errors', slackChannel: 'C1', stakeholders: [{ name: 'Tanisha', slackUserId: 'U1' }] }];
  feedbackRes = () => new Response(JSON.stringify({ shortId: 'FFERR-FB-1' }), { status: 200 });
});

const { fileLoopThreadReply } = await import('./lookups');
const { listParked } = await import('./parked');
Object.assign(config, { gabbarOwnerId: 'U000000STUBOWNER', slackBotToken: 'xoxb-stub' });
const SELF = 'UGABBAR';
const mkClient = (rootUser: string, isBot = false) => ({
  conversations: { replies: async () => ({ messages: [{ ts: '100.1', user: rootUser }] }) },
  chat: { getPermalink: async () => ({ permalink: 'https://x.slack.com/archives/C1/p1000002' }) },
  users: { info: async () => ({ user: { is_bot: isBot, profile: { display_name: 'Tanisha' } } }) },
});
const reply = { channel: 'C1', ts: '100.2', thread_ts: '100.1', user: 'U1', text: 'added a comment on 1361' };
const posts = () => calls.filter((c) => c.method === 'POST');

test('files one keyed row with text, author, slack ref and permalink', async () => {
  expect(await fileLoopThreadReply(mkClient(SELF), reply, SELF)).toBe('FFERR-FB-1');
  const p = posts()[0]!;
  expect(p.body.project).toBe('FFERR');
  expect(p.body.author).toBe('Tanisha');
  expect(p.body.body).toContain('added a comment on 1361');
  expect(p.body.body).toContain('thread_ts 100.1');
  expect(p.body.body).toContain('https://x.slack.com/archives/C1/p1000002');
  expect(p.body.slack).toEqual({ channel: 'C1', ts: '100.2', user: 'U1' });
  expect(p.body.idempotencyKey).toBe('gabbar:C1:100.2:loop-reply');
});

test('root not authored by Gabbar files nothing', async () => {
  expect(await fileLoopThreadReply(mkClient('USOMEONE'), reply, SELF)).toBe(null);
  expect(posts()).toHaveLength(0);
});

test('channel not bound to a project files nothing', async () => {
  expect(await fileLoopThreadReply(mkClient(SELF), { ...reply, channel: 'C9' }, SELF)).toBe(null);
  expect(posts()).toHaveLength(0);
});

test('bot author of the reply files nothing', async () => {
  expect(await fileLoopThreadReply(mkClient(SELF, true), reply, SELF)).toBe(null);
  expect(posts()).toHaveLength(0);
});

test('roster-refused reply (400) is parked as a stakeholder gap and the owner is told once', async () => {
  feedbackRes = () => new Response(JSON.stringify({ error: 'author "Tanisha" is not on FFERR' }), { status: 400 });
  const id = await fileLoopThreadReply(mkClient(SELF), reply, SELF);
  expect(id).toMatch(/^PARK-/);
  const held = listParked();
  expect(held).toHaveLength(1);
  expect(held[0]!.parkId).toBe(id!);
  expect(held[0]!.cause).toBe('stakeholder_gap');
  expect(held[0]!.author).toEqual({ slackUserId: 'U1', name: 'Tanisha' });
  expect(held[0]!.target).toEqual({ projectRef: 'FFERR', projectName: 'FF Errors', taskRef: null });
  expect(held[0]!.slack).toEqual({ channel: 'C1', ts: '100.2', threadTs: '100.1' });
  expect(held[0]!.body).toContain('added a comment on 1361');
  await fileLoopThreadReply(mkClient(SELF), reply, SELF); // redelivery
  const pings = slackCalls.filter((c) => c.method === 'chat.postMessage');
  expect(pings).toHaveLength(1);
  expect(pings[0]!.body.text).toContain(id!);
});

test('author name is the sender own slack name, not a roster lookup', async () => {
  const client = mkClient(SELF);
  client.users.info = async () => ({ user: { is_bot: false, profile: { display_name: '' }, real_name: 'Tanisha Real' } } as any);
  await fileLoopThreadReply(client, reply, SELF);
  expect(posts()[0]!.body.author).toBe('Tanisha Real');
});

test('unreachable darbar on the POST parks as outage with no owner ping', async () => {
  feedbackRes = () => { throw new Error('connection refused'); };
  const id = await fileLoopThreadReply(mkClient(SELF), reply, SELF);
  expect(id).toMatch(/^PARK-/);
  expect(listParked()[0]!.cause).toBe('outage');
  expect(slackCalls).toHaveLength(0);
});

test('unreachable /projects parks the reply (project unknown)', async () => {
  projects = null;
  const orig = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: any) => {
    if (String(input).endsWith('/projects')) throw new Error('connection refused');
    return orig(input as string, init);
  }) as typeof globalThis.fetch;
  try {
    const id = await fileLoopThreadReply(mkClient(SELF), reply, SELF);
    expect(id).toMatch(/^PARK-/);
    expect(listParked()[0]!.cause).toBe('outage');
    expect(listParked()[0]!.target.projectRef).toBe(null);
  } finally { globalThis.fetch = orig; }
});

test('a slack read failure parks instead of dropping, and is logged', async () => {
  const client = mkClient(SELF);
  client.conversations.replies = async () => { throw new Error('ratelimited'); };
  const id = await fileLoopThreadReply(client, reply, SELF);
  expect(id).toMatch(/^PARK-/);
  expect(listParked()[0]!.gate.kind).toBe('slack_read_failed');
  expect(posts()).toHaveLength(0);
});
