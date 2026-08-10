// DAR-232: the gate must not pick a winner between two ways of naming a project, plus three smaller
// things from the same notes that are all about a held item being described wrongly.
//
//  1. verifyStakeholder given feedbackRef AND taskRef let taskRef silently win. Unreachable today,
//     and it is the identical latent class the file_feedback fix closed the day before, now living
//     inside the gate itself. A caller that sends both does not know which it means, and the gate is
//     the last place in the system that should guess, so the combination is REFUSED.
//  2. the "held:" copy told every sender their report waits for the owner. An outage hold is
//     released by the sweep on their next message with no human involved at all, so the commonest
//     case was being described as the rarest one.
//  3. a typo'd feedbackRef from a non-owner parks FOREVER: the sweep re-asks the same unresolvable
//     row on every message and is refused every time, and registering the sender does not touch it.
//     The digest has to name the one thing that clears it.
//  4. a group target kept the first item's raw casing while the server uppercases short ids, so two
//     spellings of one row could read as two targets in a log.
//
// SAFETY: the same rig as agent-budget.test.ts, in the same order, all of it before the import.
// Temp dirs for parked/memory/files, stub slack token on a loopback base, synthetic owner id, config
// overwritten after import too, the import refused unless both bases are loopback, and then global
// fetch replaced so an unexpected host throws instead of being requested. bot.ts is never imported,
// so no socket is opened and nothing can reach the real workspace.
import { afterAll, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const RIG = mkdtempSync(path.join(tmpdir(), 'darbar-gate-'));
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
const OWNER = 'U000000STUBOWNER';
const OTHER = 'U000000SOMEONE';
const { config } = await import('@darbar/core');
Object.assign(config, {
  slackApiBase: STUB_SLACK,
  slackBotToken: 'xoxb-stub-not-a-real-token',
  slackAppToken: 'xapp-stub-not-a-real-token',
  gabbarOwnerId: OWNER,
  apiUrl: STUB_API,
});
const loopback = (u: string) => /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])([:/]|$)/.test(u);
if (!loopback(config.slackApiBase) || !loopback(config.apiUrl)) {
  throw new Error(`refusing to import the agent: slack=${config.slackApiBase} darbar=${config.apiUrl} are not both loopback`);
}

type Reply = 'refused' | { status?: number; body?: unknown };
const asked: string[] = [];
let router: (url: string) => Reply = () => ({ body: {} });
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: unknown) => {
  const url = String(input);
  if (!url.startsWith(STUB_API) && !url.startsWith(STUB_SLACK)) {
    throw new Error(`test tried to reach ${url}; every call in this file must be stubbed`);
  }
  asked.push(url);
  if (url.startsWith(STUB_SLACK)) return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
  const r = router(url);
  if (r === 'refused') throw new Error('connection refused');
  return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
}) as typeof globalThis.fetch;

const { stakeholderGate, verifyStakeholder } = await import('./agent');
const { buildEscalationDigest, listParked, planSweep } = await import('./parked');
type ParkedItem = import('./parked').ParkedItem;

afterAll(() => {
  globalThis.fetch = realFetch;
  rmSync(RIG, { recursive: true, force: true });
});
beforeEach(() => {
  asked.length = 0;
  rmSync(path.join(RIG, 'parked'), { recursive: true, force: true });
  router = () => ({ body: {} });
});

const ctx = {
  senderId: OTHER, // NOT the owner: the gate has to actually run
  senderName: 'Someone',
  isOwner: false,
  channel: 'D000STUB',
  channelType: 'im',
  messageTs: '1.1',
  threadTs: null,
  attachments: [],
  attach: { items: [], blocks: [], inventory: 'none' },
  messageText: 'the button is misaligned',
  existingFeedback: null,
} as unknown as Parameters<typeof verifyStakeholder>[0];

// ---------- 1. two ways of naming a project is not a question with an answer ----------

// The row and the task belong to DIFFERENT projects here, and only one of them has this sender on
// its roster. Before the refusal, taskRef overwrote the row's project and the answer came back from
// whichever one happened to be resolved last, which is the definition of a silent winner.
test('a target naming both a feedback row and a task is refused, not resolved', async () => {
  router = (url) => {
    if (url.includes('/feedback/DAR-FB-1')) return { body: { projectId: 'p-row' } };
    if (url.includes('/tasks/MRF-3')) return { body: { projectId: 'p-task' } };
    return { body: { name: 'Whichever', stakeholders: [{ slackUserId: OTHER }] } };
  };
  const v = await verifyStakeholder(ctx, { feedbackRef: 'DAR-FB-1', taskRef: 'MRF-3' });
  expect(v.ok, 'the gate picked one of two projects the caller named').toBe(false);
  expect(!v.ok && v.kind).toBe('bad_ref');
  expect(!v.ok && v.detail).toContain('DAR-FB-1');
  expect(!v.ok && v.detail).toContain('MRF-3');
  expect(asked.length, 'the gate resolved something before deciding it could not').toBe(0);
});

test('a target naming both a feedback row and a project is refused the same way', async () => {
  router = () => ({ body: { name: 'Darbar', stakeholders: [{ slackUserId: OTHER }] } });
  const v = await verifyStakeholder(ctx, { feedbackRef: 'DAR-FB-1', project: 'MRF' });
  expect(v.ok).toBe(false);
  expect(!v.ok && v.kind).toBe('bad_ref');
  expect(asked.length).toBe(0);
});

// NOT refused, and the difference is not squeamishness: POST /feedback resolves a taskRef in
// preference to a project, so the gate checking the task's project is checking the project the write
// will land on. One target described twice, and the two descriptions agree.
test('a taskRef alongside a project still resolves, because the write resolves it the same way', async () => {
  router = (url) => {
    if (url.includes('/tasks/DAR-9')) return { body: { projectId: 'p-task' } };
    return { body: { name: 'Darbar', stakeholders: [{ slackUserId: OTHER }] } };
  };
  const v = await verifyStakeholder(ctx, { taskRef: 'DAR-9', project: 'MRF' });
  expect(v.ok).toBe(true);
  expect(v.ok && v.projectRef, 'the project the WRITE will use is not the one the gate checked').toBe('p-task');
});

test('each way of naming a project on its own is untouched', async () => {
  router = (url) => {
    if (url.includes('/feedback/DAR-FB-1')) return { body: { projectId: 'p-row' } };
    return { body: { name: 'Darbar', stakeholders: [{ slackUserId: OTHER }] } };
  };
  expect((await verifyStakeholder(ctx, { feedbackRef: 'DAR-FB-1' })).ok).toBe(true);
  expect((await verifyStakeholder(ctx, { project: 'DAR' })).ok).toBe(true);
});

// ---------- 2. what the held copy promises ----------

test('an outage hold says the sweep releases it, not that it waits for the owner', async () => {
  router = () => 'refused';
  const g = await stakeholderGate(ctx, { project: 'DAR' }, { kind: 'file', body: 'the button is misaligned' });
  expect(g.ok).toBe(false);
  const out = JSON.parse(!g.ok ? g.result : '{}');
  expect(out.parked).toBe(true);
  expect(out.held, 'an outage hold still told them it waits for the owner').not.toContain('waits until the owner');
  expect(String(out.held)).toContain('next message');
  expect(String(out.held).toLowerCase()).toContain('darbar could not be reached');
});

test('a stakeholder gap still says the owner, because for that one it is true', async () => {
  router = (url) => (url.includes('/context') ? { body: { name: 'Darbar', stakeholders: [{ slackUserId: 'U000OTHERPERSON' }] } } : { body: {} });
  const g = await stakeholderGate(ctx, { project: 'DAR' }, { kind: 'file', body: 'x' });
  const out = JSON.parse(!g.ok ? g.result : '{}');
  expect(out.gated).toBe(true);
  expect(String(out.held)).toContain('owner promotes it');
});

test('a bad reference says nothing automatic will release it', async () => {
  router = (url) => (url.includes('/tasks/') ? { status: 404, body: { error: 'task not found' } } : { body: {} });
  const g = await stakeholderGate(ctx, { taskRef: 'DAR-999' }, { kind: 'file', body: 'x' });
  const out = JSON.parse(!g.ok ? g.result : '{}');
  expect(String(out.held)).toContain('somebody has to say where it belongs');
});

// the held copy reaches slack through the model, and the charter bans em dashes and AI-tell phrasing
test('every held copy is plain prose', async () => {
  router = () => 'refused';
  for (const intent of [
    { kind: 'file' as const, body: 'x' },
    { kind: 'append' as const, feedbackShortId: 'DAR-FB-1', note: 'x' },
  ]) {
    const g = await stakeholderGate(ctx, { project: 'DAR' }, intent);
    const all = (!g.ok ? g.result : '').toLowerCase();
    expect(all).not.toContain('—');
    for (const banned of ['delve', 'seamless', 'comprehensive', 'robust', 'leverage', 'apologi']) {
      expect(all).not.toContain(banned);
    }
  }
});

// ---------- 3. the hold that never clears ----------

const heldAddition = (over: Partial<ParkedItem> = {}): ParkedItem => ({
  parkId: 'PARK-D1_1_1_ON_DAR_FB_404',
  status: 'parked',
  kind: 'addition',
  appendTo: 'DAR-FB-404',
  createdAt: new Date(Date.now() - 4 * 3_600_000).toISOString(),
  updatedAt: new Date().toISOString(),
  author: { slackUserId: OTHER, name: 'Someone' },
  target: { projectRef: null, projectName: null, taskRef: null },
  feedbackType: 'addition',
  body: 'here is the screenshot',
  rawMessage: 'here is the screenshot',
  attachments: [],
  mediaNotes: [],
  slack: { channel: 'D000STUB', ts: '1.1', threadTs: null },
  gate: { kind: 'bad_ref', detail: 'feedback DAR-FB-404 could not be resolved' },
  cause: 'bad_reference',
  lastAttemptAt: null,
  escalatedAt: null,
  escalations: 0,
  promotion: null,
  supersededBy: null,
  ...over,
} as ParkedItem);

test('the digest names the only thing that clears a typod row id', () => {
  const { text } = buildEscalationDigest([heldAddition()]);
  expect(text, 'the owner is not told the remedy is theirs alone').toContain('promote_parked');
  expect(text).toContain('feedbackRef');
  expect(text.toLowerCase(), 'the owner is left thinking a sweep will get to it').toContain('never clears on its own');
  expect(text).not.toContain('—');
});

const writeFailure = (over: Partial<ParkedItem> = {}) => heldAddition({
  cause: 'outage',
  gate: { kind: 'write_failed', detail: 'the stakeholder check passed and the write itself failed: darbar unreachable' },
  ...over,
});

test('the digest says which of a mixed backlog is definitely not filed', () => {
  const { text } = buildEscalationDigest([heldAddition(), writeFailure({ parkId: 'PARK-D1_2_2', kind: 'report', appendTo: null })]);
  expect(text, 'a write that may have landed was described as definitely not filed').not.toContain('nothing here is filed.');
  expect(text).toContain('may already have landed');
  expect(text).toContain('same key as the attempt that failed');
  expect(text).toContain('1 of these is definitely not filed');
});

// DAR-239/B1. Gating only the CLOSING sentence left three assertions of certainty upstream of it,
// one of them in the same sentence as the hedge that contradicts it. This is the whole message read
// as one thing, which is how the owner reads it, so every certainty in it is checked at once.
test('a digest of write failures asserts nothing about whether they landed', () => {
  const { text } = buildEscalationDigest([writeFailure()]);
  // the head
  expect(text, 'the head still said an addition was never added').not.toContain('NEVER added to the row it names');
  expect(text).toContain('whether it landed is not known');
  // the per-item line, which is where the contradiction sat inside one sentence
  expect(text, 'the item line still said NEVER added to it').not.toContain('NEVER added to it');
  expect(text).toContain('MAY OR MAY NOT have reached it');
  // the trailing addition sentence
  expect(text, 'the trailing sentence still said the row shows no sign anything was sent').not.toContain('shows no sign anything was sent');
  expect(text).not.toContain('never reached the row');
  // and nothing anywhere in it claims it was not filed
  expect(text).not.toContain('NOT filed');
  expect(text).not.toContain('never filed');
});

// the gates must not fire on ordinary holds: those genuinely were never filed and never added, and
// hedging them would be the opposite dishonesty
test('an ordinary backlog still says NEVER, byte for byte', () => {
  const one = buildEscalationDigest([heldAddition()]).text;
  expect(one).toContain('an addition is still held and was NEVER added to the row it names:');
  expect(one).toContain('that was NEVER added to it');
  expect(one).toContain('shows no sign anything was sent');
  expect(one).toContain('nothing here is filed.');
  const report = buildEscalationDigest([heldAddition({ kind: 'report', appendTo: null, cause: 'stakeholder_gap' })]).text;
  expect(report).toContain('a report is still held and NOT filed:');
});

// a mixed digest must not describe the certain ones as uncertain either, so the counts have to split
test('a mixed digest counts each kind of certainty separately', () => {
  const { text } = buildEscalationDigest([
    heldAddition({ parkId: 'PARK-1' }),
    heldAddition({ parkId: 'PARK-2' }),
    writeFailure({ parkId: 'PARK-3' }),
  ]);
  expect(text).toContain('2 additions are still held and were NEVER added to the rows they name');
  expect(text).toContain('one more is held whose write never came back');
  expect(text).toContain('2 of these are definitely not filed');
  // with a write-failure addition listed too, "the additions above" would sweep it in
  expect(text).toContain('the 2 additions above marked NEVER added never reached the rows named');
});

test('the unlisted-count noun still says item when an addition is held', () => {
  const many = Array.from({ length: 40 }, (_, n) => writeFailure({ parkId: `PARK-N${n}`, createdAt: `2026-01-${String(n + 1).padStart(2, '0')}T00:00:00.000Z` }));
  const { text, omitted } = buildEscalationDigest(many);
  expect(omitted).toBe(10);
  expect(text, 'a backlog of held ADDITIONS was counted as held reports').toContain('10 more held items not listed here');
});

test('a backlog with no write failures keeps the sentence it always closed on', () => {
  const { text } = buildEscalationDigest([heldAddition({ cause: 'stakeholder_gap' })]);
  expect(text).toContain('nothing here is filed.');
});

// ---------- 4. one row, one spelling ----------

test('a sweep group addresses the row in the casing the server uses', () => {
  const lower = heldAddition({ parkId: 'PARK-A', appendTo: 'dar-fb-7', createdAt: '2026-01-01T00:00:00.000Z' });
  const upper = heldAddition({ parkId: 'PARK-B', appendTo: 'DAR-FB-7', createdAt: '2026-01-02T00:00:00.000Z' });
  const plan = planSweep([lower, upper], 5);
  expect(plan.length, 'two spellings of one row were verified twice').toBe(1);
  expect(plan[0]!.target.feedbackRef, 'the group kept whichever casing arrived first').toBe('DAR-FB-7');
  expect(plan[0]!.items.length).toBe(2);
});

test('a sweep group addresses a task in the casing the server uses', () => {
  const t = (id: string, parkId: string, createdAt: string) =>
    heldAddition({ parkId, kind: 'report', appendTo: null, createdAt, target: { projectRef: null, projectName: null, taskRef: id } });
  const plan = planSweep([t('dar-9', 'PARK-C', '2026-01-01T00:00:00.000Z'), t('DAR-9', 'PARK-D', '2026-01-02T00:00:00.000Z')], 5);
  expect(plan.length).toBe(1);
  expect(plan[0]!.target.taskRef).toBe('DAR-9');
});

// a project ref can be a mongo id, where case is not decoration, so it is deliberately left alone
test('a project target is not uppercased', () => {
  const p = heldAddition({
    parkId: 'PARK-E', kind: 'report', appendTo: null,
    target: { projectRef: '6a777ca5273258841c030731', projectName: null, taskRef: null },
  });
  const plan = planSweep([p], 5);
  expect(plan[0]!.target.project).toBe('6a777ca5273258841c030731');
});

// the refusal has to actually park, or the fix traded one loss for another
test('the refused combination still holds what the sender wrote', async () => {
  const g = await stakeholderGate(
    ctx,
    { feedbackRef: 'DAR-FB-1', taskRef: 'MRF-3' },
    { kind: 'append', feedbackShortId: 'DAR-FB-1', note: 'here is the screenshot' },
  );
  expect(g.ok).toBe(false);
  const held = listParked({ status: 'parked' });
  expect(held.length, 'a refusal that holds nothing is the bug this project keeps finding').toBe(1);
  expect(held[0]!.cause).toBe('bad_reference');
  expect(held[0]!.kind).toBe('addition');
});
