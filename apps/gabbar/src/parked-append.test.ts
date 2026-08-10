// DAR-219: a refused APPEND is held, and a held addition goes back onto the row it named.
//
// DAR-182 made adding evidence mutate the existing feedback row instead of spawning a follow-up, and
// left a hole: the gate refusing an append held nothing, so a non-stakeholder adding a screenshot to
// an existing finding still lost it. Parking it was blocked on one thing, that a held item was
// promoted by FILING A NEW ROW, which is the duplicate DAR-182 removed. What is pinned here is the
// three properties that make holding one safe:
//
//  1. a refused append is HELD, as an addition that knows which row it belongs on, while a refused
//     reopen still holds nothing (its words are somebody else's).
//  2. promotion goes through the APPEND ROUTE. No POST /feedback ever leaves this process for a held
//     addition, which is the property that keeps one finding on one row.
//  3. the two states the target row can be in are DECIDED. Closed: appended anyway, with the route's
//     warning carried back so nobody is told it landed in a queue. Gone: nothing created, the words
//     stay held, and it is never converted into a report.
//
// SAFETY, in the order it is established, all of it before the agent is imported (same rig as
// agent-budget.test.ts, for the same reason):
//  · every directory agent.ts's imports resolve at load time is moved into a temp rig, so this
//    machine's data/parked and data/memory are neither read nor created.
//  · slack is a stub token and a loopback base url, and the owner id is synthetic.
//  · config is overwritten after import as well, because if another test file imported @darbar/core
//    first then config was already built from the real .env and the env vars above would be a no-op.
//  · the import is REFUSED unless slack and darbar are both on loopback at that point.
//  · and then global fetch is replaced entirely, so nothing leaves this process even if all of the
//    above were wrong. An unexpected host throws rather than being requested.
//  · bot.ts is never imported, so no socket is ever opened.
import { afterAll, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const RIG = mkdtempSync(path.join(tmpdir(), 'darbar-append-'));
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
Object.assign(config, {
  slackApiBase: STUB_SLACK,
  slackBotToken: 'xoxb-stub-not-a-real-token',
  slackAppToken: 'xapp-stub-not-a-real-token',
  gabbarOwnerId: 'U000000STUBOWNER',
  apiUrl: STUB_API,
});
const loopback = (u: string) => /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])([:/]|$)/.test(u);
if (!loopback(config.slackApiBase) || !loopback(config.apiUrl)) {
  throw new Error(`refusing to import the agent: slack=${config.slackApiBase} darbar=${config.apiUrl} are not both loopback`);
}

type Asked = { url: string; method: string; body: Record<string, unknown> | null };
const asked: Asked[] = [];
// what the stub darbar answers, per path suffix. Anything unrouted is a 404 with a body, which is
// also the shape of the "row is gone" case the promotion has to handle.
let routes: Record<string, { status: number; body: unknown }> = {};
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: unknown, init?: { method?: string; body?: string }) => {
  const url = String(input);
  if (!url.startsWith(STUB_API) && !url.startsWith(STUB_SLACK)) {
    throw new Error(`test tried to reach ${url}; every call in this file must be stubbed`);
  }
  const method = init?.method ?? 'GET';
  let body: Record<string, unknown> | null = null;
  try { body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : null; } catch { body = null; }
  asked.push({ url, method, body });
  if (url.startsWith(STUB_SLACK)) {
    return new Response(JSON.stringify({ ok: true, channel: { id: 'D000OWNERDM' } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  const key = `${method} ${url.slice(STUB_API.length)}`;
  const hit = routes[key];
  if (!hit) return new Response(JSON.stringify({ error: 'feedback not found' }), { status: 404, headers: { 'content-type': 'application/json' } });
  return new Response(JSON.stringify(hit.body), { status: hit.status, headers: { 'content-type': 'application/json' } });
}) as typeof globalThis.fetch;

const P = await import('./parked');
const { stakeholderGate, promoteAddition } = await import('./agent');

afterAll(() => {
  globalThis.fetch = realFetch;
  rmSync(RIG, { recursive: true, force: true });
});
beforeEach(() => {
  asked.length = 0;
  routes = {
    // the row exists and belongs to a project this sender is NOT on: the refusal under test
    'GET /feedback/MRF-FB-23': { status: 200, body: { shortId: 'MRF-FB-23', projectId: 'STUBPROJECT' } },
    'GET /projects/STUBPROJECT/context': { status: 200, body: { name: 'MRF v3', stakeholders: [{ slackUserId: 'U000000RAJ' }] } },
    'POST /feedback/MRF-FB-23/append': { status: 200, body: { appended: true, warnings: [] } },
  };
});

// Each test uses its own slack ts, and every held item is addressed BY ID rather than by "the only
// one in the directory". bun runs these files in one process and parked.ts resolves its directory at
// import, so whichever test file imported it first owns that path: a test that reads the parking lot
// as a whole is really reading whatever the run happened to leave there.
const MSG = 'this is the same bug on the settings screen, screenshot attached';
const mkCtx = (ts: string) => ({
  senderId: 'U0TANISHA', // NOT the owner and NOT on the roster above: the gate has to actually refuse
  senderName: 'Tanisha',
  isOwner: false,
  channel: 'D0AH8292D7Y',
  channelType: 'im',
  messageTs: ts,
  threadTs: null,
  attachments: ['http://127.0.0.1:9/files/shot.png'],
  attach: { items: [], blocks: [], inventory: 'shot.png' },
  messageText: MSG,
  existingFeedback: null,
} as unknown as Parameters<typeof stakeholderGate>[0]);

const refuseAppend = async (ts: string, row = 'MRF-FB-23') => {
  const gate = await stakeholderGate(mkCtx(ts), { project: 'STUBPROJECT' }, {
    kind: 'append', feedbackShortId: row, note: 'it also happens on the settings screen',
  });
  return { gate, item: P.readParked(P.parkIdFor('D0AH8292D7Y', ts, row))! };
};

test('a refused append is HELD, and the row it names is reported untouched', async () => {
  const { gate, item } = await refuseAppend('1754771001.000001');
  expect(gate.ok).toBe(false);
  const r = JSON.parse(!gate.ok ? gate.result : '{}');
  expect(r.added).toBe(false);
  expect(r.filed).toBe(false);
  expect(r.parked).toBe(true);
  expect(r.parkId).toBe(item.parkId);
  expect(r.reason).toContain('MRF-FB-23 was NOT changed');
  expect(r.held).toContain('never becomes a feedback row of its own');

  expect(item.status).toBe('parked');
  expect(item.kind).toBe('addition');
  expect(item.appendTo).toBe('MRF-FB-23');
  // their own words and their own evidence, which is the thing that was being lost
  expect(item.rawMessage).toBe(MSG);
  expect(item.attachments).toEqual(['http://127.0.0.1:9/files/shot.png']);
  expect(item.body).toBe('it also happens on the settings screen');
  expect(item.cause).toBe('stakeholder_gap');
  // nothing was written to the board on the way past
  expect(asked.filter((a) => a.method === 'POST' && a.url.startsWith(`${STUB_API}/feedback`))).toHaveLength(0);
});

test('a refused reopen still holds nothing, because none of those words are theirs', async () => {
  const ts = '1754771002.000001';
  const gate = await stakeholderGate(mkCtx(ts), { project: 'STUBPROJECT' }, { kind: 'reopen', feedbackShortId: 'MRF-FB-23' });
  const r = JSON.parse(!gate.ok ? gate.result : '{}');
  expect(r.reopened).toBe(false);
  expect(r.parked).toBe(false);
  expect(r.parkId).toBeUndefined();
  // neither under the message's own key nor under the row it named
  expect(P.readParked(P.parkIdFor('D0AH8292D7Y', ts))).toBeNull();
  expect(P.readParked(P.parkIdFor('D0AH8292D7Y', ts, 'MRF-FB-23'))).toBeNull();
});

test('a held addition is promoted through the APPEND route and never as a new row', async () => {
  const { item } = await refuseAppend('1754771003.000001');
  asked.length = 0;

  const r = await promoteAddition(item, 'Raj via gabbar');
  expect(r.ok).toBe(true);
  expect(r.ok && r.appendedTo).toBe('MRF-FB-23');

  const posts = asked.filter((a) => a.method === 'POST');
  expect(posts).toHaveLength(1);
  expect(posts[0]!.url).toBe(`${STUB_API}/feedback/MRF-FB-23/append`);
  // the row-creating door was never opened. This is the assertion the whole task turns on.
  expect(asked.some((a) => a.url === `${STUB_API}/feedback`)).toBe(false);

  // attribution stays with whoever sent it, and the note says it was held rather than sent now
  expect(posts[0]!.body!.author).toBe('Tanisha');
  expect(posts[0]!.body!.authorType).toBe('human');
  expect(posts[0]!.body!.attachments).toEqual(['http://127.0.0.1:9/files/shot.png']);
  expect(String(posts[0]!.body!.note)).toContain('it also happens on the settings screen');
  expect(String(posts[0]!.body!.note)).toContain(`held as ${item.parkId}`);

  // terminal, and it leaves the queue pointing at the row that now carries the words
  const after = P.readParked(item.parkId)!;
  expect(after.status).toBe('promoted');
  expect(after.promotion?.feedbackShortId).toBe('MRF-FB-23');
  expect(P.summarize(after).filed).toBe(false); // still not a filing, at any point
  expect(P.listParked({ status: 'parked' }).some((h) => h.parkId === item.parkId)).toBe(false);
});

test('a CLOSED row is appended to, and the warning that says so is carried back', async () => {
  // the route appends to a resolved row on purpose and refuses to reopen it, so the addition lands
  // somewhere nobody is triaging. That is fine as long as it is said out loud.
  routes['POST /feedback/MRF-FB-23/append'] = {
    status: 200,
    body: { appended: true, warnings: ['MRF-FB-23 is resolved, so this addition is not in any triage queue'] },
  };
  const { item } = await refuseAppend('1754771004.000001');
  const r = await promoteAddition(item, 'Raj via gabbar');
  expect(r.ok).toBe(true);
  expect(r.ok && r.warnings[0]).toContain('not in any triage queue');
  expect(P.readParked(item.parkId)?.status).toBe('promoted');
});

test('a row that is GONE leaves the addition held, and creates nothing in its place', async () => {
  const { item } = await refuseAppend('1754771005.000001');
  delete routes['POST /feedback/MRF-FB-23/append']; // deleted between the refusal and the sweep
  asked.length = 0;

  const r = await promoteAddition(item, 'Raj via gabbar');
  expect(r.ok).toBe(false);
  expect(!r.ok && r.gone).toBe(true);
  // no fallback filing: a new row for evidence that belongs on a finding is the DAR-182 duplicate,
  // and the finding it belonged to does not exist any more
  expect(asked.some((a) => a.url === `${STUB_API}/feedback` && a.method === 'POST')).toBe(false);
  const after = P.readParked(item.parkId)!;
  expect(after.status).toBe('parked'); // still held, still theirs, still recoverable
  expect(after.kind).toBe('addition');
  expect(after.rawMessage).toBe(MSG);
});

test('the owner can point a held addition at a different row when its own is gone', async () => {
  const { item } = await refuseAppend('1754771006.000001');
  routes['POST /feedback/MRF-FB-31/append'] = { status: 200, body: { appended: true, warnings: [] } };
  const r = await promoteAddition(item, 'Raj via gabbar', 'MRF-FB-31');
  expect(r.ok).toBe(true);
  expect(r.ok && r.appendedTo).toBe('MRF-FB-31');
  expect(P.readParked(item.parkId)?.promotion?.feedbackShortId).toBe('MRF-FB-31');
});

test('a darbar that cannot be reached leaves the addition held rather than half done', async () => {
  const { item } = await refuseAppend('1754771007.000001');
  routes['POST /feedback/MRF-FB-23/append'] = { status: 503, body: { error: 'restarting' } };
  const r = await promoteAddition(item, 'Raj via gabbar');
  expect(r.ok).toBe(false);
  expect(!r.ok && r.gone).toBe(false); // 503 is not "the row is gone", and must not read as one
  expect(P.readParked(item.parkId)?.status).toBe('parked');
});

test('the same message refused twice holds the report and the addition separately', async () => {
  const ts = '1754771008.000001';
  const { item: add } = await refuseAppend(ts);
  await stakeholderGate(mkCtx(ts), { project: 'STUBPROJECT' }, { kind: 'file', body: 'and a new one entirely', type: 'bug' });
  const report = P.readParked(P.parkIdFor('D0AH8292D7Y', ts))!;
  expect(report.parkId).not.toBe(add.parkId);
  expect(report.kind).toBe('report');
  expect(report.body).toBe('and a new one entirely');
  // the append refused first is still there with its own words, which one key per message lost
  expect(P.readParked(add.parkId)!.kind).toBe('addition');
  expect(P.readParked(add.parkId)!.body).toBe('it also happens on the settings screen');
});
