// DAR-411: replies under a Gabbar-posted root in a project-bound channel are filed as feedback.
import { afterAll, beforeEach, expect, test } from 'bun:test';

process.env.SLACK_API_BASE = 'http://127.0.0.1:9/slack-stub';
process.env.SLACK_BOT_TOKEN = 'xoxb-stub-not-a-real-token';
process.env.SLACK_APP_TOKEN = 'xapp-stub-not-a-real-token';
process.env.GABBAR_OWNER_ID = 'U000000STUBOWNER';
process.env.ANTHROPIC_API_KEY = 'sk-ant-stub-not-a-real-key';
process.env.MC_API = 'http://127.0.0.1:9/api';
const STUB_API = 'http://127.0.0.1:9/api';
const { config } = await import('@darbar/core');
Object.assign(config, { apiUrl: STUB_API, slackApiBase: 'http://127.0.0.1:9/slack-stub' });

const calls: Array<{ url: string; method: string; body: any }> = [];
let projects: unknown = [{ prefix: 'FFERR', slackChannel: 'C1', stakeholders: [{ name: 'Tanisha', slackUserId: 'U1' }] }];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: unknown, init?: { method?: string; body?: string }) => {
  const url = String(input);
  if (!url.startsWith(STUB_API)) throw new Error(`unstubbed ${url}`);
  calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body) : null });
  if (url.includes('/projects')) return new Response(JSON.stringify(projects), { status: 200 });
  if (url.endsWith('/feedback')) return new Response(JSON.stringify({ shortId: 'FFERR-FB-1' }), { status: 200 });
  return new Response('{}', { status: 404 });
}) as typeof globalThis.fetch;
afterAll(() => { globalThis.fetch = realFetch; });
beforeEach(() => { calls.length = 0; });

const { fileLoopThreadReply } = await import('./lookups');
const SELF = 'UGABBAR';
const mkClient = (rootUser: string, isBot = false) => ({
  conversations: { replies: async () => ({ messages: [{ ts: '100.1', user: rootUser }] }) },
  chat: { getPermalink: async () => ({ permalink: 'https://x.slack.com/archives/C1/p1000002' }) },
  users: { info: async () => ({ user: { is_bot: isBot, profile: { display_name: 'T' } } }) },
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
