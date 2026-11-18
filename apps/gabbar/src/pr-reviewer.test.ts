// DAR-413: a non-stakeholder replying in a thread where GABBAR posted a PR link joins as pr-reviewer and passes the gate.
import { afterAll, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const RIG = mkdtempSync(path.join(tmpdir(), 'darbar-prrev-'));
process.env.PARKED_DIR = path.join(RIG, 'parked');
process.env.MEMORY_DIR = path.join(RIG, 'memory');
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
Object.assign(config, { slackApiBase: STUB_SLACK, apiUrl: STUB_API, gabbarOwnerId: 'U000000STUBOWNER' });

const calls: Array<{ method: string; path: string; body: any }> = [];
let roster: Array<{ name: string; slackUserId?: string }> = [];
let stakeholderPost = 200;
let projects: unknown = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: unknown, init?: { method?: string; body?: string }) => {
  const url = String(input);
  if (url.startsWith(STUB_SLACK)) return new Response(JSON.stringify({ ok: true, channel: { id: 'D1' } }), { status: 200 });
  if (!url.startsWith(STUB_API)) throw new Error(`unstubbed ${url}`);
  const method = init?.method ?? 'GET';
  const p = url.slice(STUB_API.length);
  calls.push({ method, path: p, body: init?.body ? JSON.parse(init.body) : null });
  const ok = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
  if (method === 'GET' && p === '/projects') return ok(projects);
  if (method === 'GET' && p === '/feedback/ONCALL-FB-1') return ok({ projectId: 'ONCALL' });
  if (method === 'PATCH' && p === '/feedback/ONCALL-FB-1') return ok({ status: 'pending' });
  if (method === 'GET' && p === '/projects/ONCALL/context') return ok({ name: 'On-call', stakeholders: roster });
  if (method === 'POST' && p === '/projects/ONCALL/stakeholders') {
    if (stakeholderPost < 300) roster.push({ name: calls.at(-1)!.body.name, slackUserId: calls.at(-1)!.body.slackUserId });
    return ok({ added: true }, stakeholderPost);
  }
  if (method === 'POST' && p === '/events') return ok({ ok: true });
  return ok({ error: 'not found' }, 404);
}) as typeof globalThis.fetch;

const { stakeholderGate, reopenFeedback } = await import('./agent');
const { prThreadFor } = await import('./lookups');
afterAll(() => { globalThis.fetch = realFetch; rmSync(RIG, { recursive: true, force: true }); });
beforeEach(() => { calls.length = 0; roster = []; stakeholderPost = 200; projects = []; });

const PR = { url: 'https://github.com/Saturn-Fintech/chat/pull/181' };
const mkCtx = (ts: string, over: Record<string, unknown>) => ({
  senderId: 'U0BHARAT', senderName: 'Bharat', isOwner: false, channel: 'C1', channelType: 'channel',
  messageTs: ts, threadTs: '100.1', attachments: [], attach: { items: [], blocks: [], inventory: '' },
  messageText: 'added one small comment', existingFeedback: null, prThread: PR, ...over,
} as unknown as Parameters<typeof stakeholderGate>[0]);
const file = (ctx: Parameters<typeof stakeholderGate>[0]) => stakeholderGate(ctx, { project: 'ONCALL' }, { kind: 'file', body: 'x' });

test('non-stakeholder in a Gabbar PR thread is added as pr-reviewer and passes', async () => {
  const g = await file(mkCtx('100.2', {}));
  expect(g.ok).toBe(true);
  expect(g.ok && g.joinedAs).toBe('pr-reviewer');
  const post = calls.find((c) => c.path === '/projects/ONCALL/stakeholders')!;
  expect(post.body).toEqual({ name: 'Bharat', slackUserId: 'U0BHARAT', role: 'pr-reviewer' });
  expect(calls.find((c) => c.path === '/events')!.body.text).toContain('Bharat joined as pr-reviewer via PR thread');
});

test('a name clash (409) PATCHes the slack id then passes', async () => {
  roster = [{ name: 'Bharat' }];
  stakeholderPost = 409;
  const origin = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: { method?: string; body?: string }) => {
    if (init?.method === 'PATCH') {
      calls.push({ method: 'PATCH', path: String(input).slice(STUB_API.length), body: JSON.parse(init.body!) });
      roster = [{ name: 'Bharat', slackUserId: 'U0BHARAT' }];
      return new Response('{"updated":true}', { status: 200 });
    }
    return origin(input as string, init);
  }) as typeof globalThis.fetch;
  try {
    expect((await file(mkCtx('100.3', {}))).ok).toBe(true);
    expect(calls.some((c) => c.method === 'PATCH' && c.path === '/projects/ONCALL/stakeholders/Bharat')).toBe(true);
  } finally { globalThis.fetch = origin; }
});

test('PR link not posted by Gabbar (prThread null) is still parked, nothing added', async () => {
  const g = await file(mkCtx('100.4', { prThread: null }));
  expect(g.ok).toBe(false);
  expect(calls.some((c) => c.path.endsWith('/stakeholders'))).toBe(false);
});

test('no thread is still parked', async () => {
  const g = await file(mkCtx('100.5', { threadTs: null }));
  expect(g.ok).toBe(false);
  expect(calls.some((c) => c.path.endsWith('/stakeholders'))).toBe(false);
});

test('add-stakeholder 5xx falls through to park', async () => {
  stakeholderPost = 503;
  const g = await file(mkCtx('100.6', {}));
  expect(g.ok).toBe(false);
  expect(!g.ok && JSON.parse(g.result).parked).toBe(true);
});

test('prThreadFor only counts a PR url in a message posted by Gabbar', async () => {
  const mk = (msgs: unknown[]) => ({ conversations: { replies: async () => ({ messages: msgs }) } });
  const human = [{ ts: '1', user: 'UHUMAN', text: 'see https://github.com/o/r/pull/9' }];
  const bot = [...human, { ts: '2', user: 'UGABBAR', text: 'review <https://github.com/Saturn-Fintech/chat/pull/181|chat#181>' }];
  expect(await prThreadFor(mk(human), 'C1', '1', 'UGABBAR')).toBe(null);
  expect(await prThreadFor(mk(bot), 'C1', '1', 'UGABBAR')).toEqual({ url: 'https://github.com/Saturn-Fintech/chat/pull/181' });
  expect(await prThreadFor(mk(bot), 'C1', null, 'UGABBAR')).toBe(null);
});

test('a name clash with a DIFFERENT slack id is a different person: no PATCH, parked as before', async () => {
  roster = [{ name: 'Bharat', slackUserId: 'U0SOMEONEELSE' }];
  stakeholderPost = 409;
  expect((await file(mkCtx('100.4', {}))).ok).toBe(false);
  expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
});

test('channel bound to a DIFFERENT project: parked, no stakeholder POST', async () => {
  projects = [{ prefix: 'OTHER', _id: 'o1', slackChannel: 'C1' }];
  const g = await file(mkCtx('100.7', {}));
  expect(g.ok).toBe(false);
  expect(calls.some((c) => c.path.endsWith('/stakeholders'))).toBe(false);
});

test('channel bound to the target project (by prefix) still joins', async () => {
  projects = [{ prefix: 'ONCALL', slackChannel: 'C1' }];
  expect((await file(mkCtx('100.8', {}))).ok).toBe(true);
});

test('unreadable /projects fails closed: parked, nothing added', async () => {
  projects = { error: 'x' };
  expect((await file(mkCtx('100.9', {}))).ok).toBe(false);
  expect(calls.some((c) => c.path.endsWith('/stakeholders'))).toBe(false);
});

test('reopen by a joining reviewer carries the reviewerNote', async () => {
  const out = JSON.parse(await reopenFeedback(mkCtx('100.10', { existingFeedback: { shortId: 'ONCALL-FB-1', status: 'resolved' } }), 'ONCALL-FB-1'));
  expect(out.status).toBe('pending');
  expect(out.reviewerNote).toContain('pr-reviewer');
});
