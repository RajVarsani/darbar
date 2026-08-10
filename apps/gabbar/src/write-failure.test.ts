// DAR-229: a write that fails AFTER the gate passed must not lose the report, and retrying it must
// not file it twice.
//
// Every parking fix before this one covered a REFUSAL. Raj sent Gabbar a bug with a screenshot while
// the api was restarting: he is the owner, so the gate passed instantly, the POST hit a closed port,
// and nothing was held. Two more of his reports went the same way. The trigger is not an outage
// anybody would call one, it is shipping — the orchestrator restarts the api several times a day and
// each restart is a few seconds where every write fails.
//
// The reason this sat in the backlog is the reason the tests below are shaped the way they are: A
// FAILED WRITE MAY HAVE SUCCEEDED. A POST whose answer never came back can have created the row, so
// holding it is only safe if promoting the held copy cannot create a second one. That is an
// idempotency answer, not a parking answer, and both halves are asserted here:
//
//  1. a write that could not be confirmed HOLDS the sender's words, with a target on it, so the
//     sweep can promote it later. The owner path is tested first because that is the path the
//     reports were actually lost on, and it is the one where the gate resolves nothing.
//  2. the words are held with the right SHAPE: a filing holds a report, an append holds an addition
//     keyed to its row, so a retry can never turn evidence for one finding into a second row.
//  3. darbar ANSWERING with a refusal is not a failure and holds nothing. Only unreachable holds.
//  4. every write carries an idempotency key derived from the verified slack message, and the RETRY
//     presents the same key as the attempt that failed. That is the whole safety argument, so it is
//     asserted on the bytes that go on the wire rather than on the helper in isolation.
//  5. when darbar says the write had already been applied, the sender is told it landed at the time,
//     not that it was just filed.
//
// SAFETY, established in this order and all of it before the agent is imported (same rig as
// agent-budget.test.ts, for the same reasons):
//  · every directory agent.ts resolves at load time is moved into a temp rig, so this machine's
//    data/parked is neither read nor written. The one real held report in data/parked is untouched.
//  · slack is a stub token on a loopback base, and the owner id is synthetic.
//  · config is overwritten after import too, in case another test file built it from the real .env.
//  · the import is REFUSED unless slack and darbar are both loopback at that point.
//  · global fetch is then replaced outright: an unexpected host throws instead of being requested.
//  · bot.ts is never imported, so no socket is opened and nothing can reach the real workspace.
import { afterAll, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const RIG = mkdtempSync(path.join(tmpdir(), 'darbar-writefail-'));
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

// Every request is answered by a per-test router. A url outside the two stub bases is a thrown test
// failure, never a request, so nothing can reach a real host even if everything above were wrong.
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
  if (url.startsWith(STUB_SLACK)) return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
  const r = router(url, method, body);
  // a darbar that is not listening at all, which is what an api restart looks like from here
  if (r === 'refused') throw new Error('connection refused');
  return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
}) as typeof globalThis.fetch;

const {
  addToFeedback, fileFeedback, promoteAddition, promoteParked, sweepParked, writeKey,
} = await import('./agent');
const { listParked, parkedTarget, readParked, summarize, withFilingNotice } = await import('./parked');

afterAll(() => {
  globalThis.fetch = realFetch;
  rmSync(RIG, { recursive: true, force: true });
});
beforeEach(() => {
  sent.length = 0;
  rmSync(path.join(RIG, 'parked'), { recursive: true, force: true });
  router = () => ({ body: {} });
});

const ctxFor = (senderId: string, ts: string, over: Record<string, unknown> = {}) => ({
  senderId,
  senderName: senderId === OWNER ? 'Raj' : 'Someone',
  isOwner: senderId === OWNER,
  channel: 'D000STUB',
  channelType: 'im',
  messageTs: ts,
  threadTs: null,
  attachments: [`${config.baseUrl}/files/F1-loader.png`],
  attach: { items: [], blocks: [], inventory: 'one image' },
  messageText: 'remove gradient from this loader',
  existingFeedback: null,
  ...over,
}) as unknown as Parameters<typeof fileFeedback>[0];

const postFeedback = () => sent.filter((s) => s.method === 'POST' && s.url === `${STUB_API}/feedback`);
const postAppend = () => sent.filter((s) => s.method === 'POST' && s.url.endsWith('/append'));

// ---------- 1. the report that was lost ----------

// THE INCIDENT, reproduced. Owner, so the gate passes with no darbar call at all; the api is
// restarting, so the POST finds nothing listening. Before this change the tool returned a bare
// error, data/parked stayed empty, and the words and the screenshot were gone.
test('a filing that could not be confirmed holds the report instead of dropping it', async () => {
  router = () => 'refused';
  const ctx = ctxFor(OWNER, '1.1');
  const out = JSON.parse(await fileFeedback(ctx, { project: 'DAR', type: 'bug', body: 'the loader has a gradient on it' }));

  expect(out.filed, 'a write nobody confirmed was reported as filed').toBe(false);
  expect(out.parked, 'the report was not held anywhere').toBe(true);
  const held = listParked({ status: 'parked', authorId: OWNER });
  expect(held.length, 'nothing reached the parking lot').toBe(1);
  expect(held[0]!.kind).toBe('report');
  expect(held[0]!.rawMessage, 'their own words were not kept').toBe('remove gradient from this loader');
  expect(held[0]!.attachments, 'the screenshot was not kept').toEqual([`${config.baseUrl}/files/F1-loader.png`]);
  expect(held[0]!.body).toBe('the loader has a gradient on it');
  expect(held[0]!.feedbackType).toBe('bug');
});

// A hold that cannot be promoted is a slower way of losing it: only the escalation clock would ever
// mention it again. The owner path resolves NO project (the gate short-circuits), so without the
// fallback to what the model named, the exact report this task is about parks with no target.
test('the hold carries a target, so the sweep can actually file it later', async () => {
  router = () => 'refused';
  await fileFeedback(ctxFor(OWNER, '2.1'), { project: 'DAR', body: 'x' });
  const item = listParked({ status: 'parked' })[0]!;
  expect(parkedTarget(item), 'held with no target: only the clock would ever mention it again').toEqual({ project: 'DAR' });
});

test('a taskRef filing holds the task it named', async () => {
  router = (url) => (url.includes('/tasks/') ? { body: { projectId: 'p1' } } : 'refused');
  // a real stakeholder, so the gate genuinely runs and passes before the write fails
  router = (url) => {
    if (url.includes('/tasks/')) return { body: { projectId: 'p1' } };
    if (url.includes('/context')) return { body: { name: 'Darbar', stakeholders: [{ slackUserId: OTHER }] } };
    return 'refused';
  };
  await fileFeedback(ctxFor(OTHER, '3.1'), { taskRef: 'DAR-9', body: 'x' });
  const item = listParked({ status: 'parked' })[0]!;
  expect(item.target.taskRef).toBe('DAR-9');
  expect(item.target.projectRef, 'the project the gate resolved was thrown away').toBe('p1');
  expect(parkedTarget(item)).toEqual({ taskRef: 'DAR-9' });
});

// ---------- 2. held with the right shape ----------

// An append that is held as a REPORT would be promoted by filing a new row, which is the duplicate
// DAR-182 removed. The kind is what keeps promotion on the append route.
test('an append that could not be confirmed is held as an addition, never as a report', async () => {
  router = (url) => {
    if (url.includes('/feedback/DAR-FB-7') && !url.endsWith('/append')) return { body: { projectId: 'p1' } };
    if (url.includes('/context')) return { body: { name: 'Darbar', stakeholders: [{ slackUserId: OTHER }] } };
    return 'refused'; // the append itself
  };
  const out = JSON.parse(await addToFeedback(ctxFor(OTHER, '4.1'), 'dar-fb-7', 'it also happens on the dashboard'));
  expect(out.added).toBe(false);
  expect(out.filed, 'an unconfirmed append reported a filing').toBe(false);
  expect(out.parked).toBe(true);
  const item = listParked({ status: 'parked' })[0]!;
  expect(item.kind).toBe('addition');
  expect(item.appendTo, 'a held addition that does not name its row can only become a second row').toBe('DAR-FB-7');
  expect(summarize(item).addedToRow, 'held means the row does not have it').toBe(false);
});

// ---------- 3. an answer is not a failure ----------

test('darbar refusing the filing is an answer, and answers are not held', async () => {
  router = () => ({ status: 404, body: { error: 'need taskRef or project' } });
  const out = JSON.parse(await fileFeedback(ctxFor(OWNER, '5.1'), { body: 'x' }));
  expect(out.error).toBe('need taskRef or project');
  expect(out.parked, 'a fixable mistake was held as if it were a loss').toBeUndefined();
  expect(listParked({ status: 'parked' }).length, 'darbar answered and something was still held').toBe(0);
});

// ---------- 4. the retry presents the same key ----------

// This is the whole safety argument, so it is asserted on the bytes rather than on writeKey alone.
// If these two ever differ, promoting a hold whose first write actually landed files it twice.
test('a filing and the retry that promotes it carry the same idempotency key', async () => {
  router = () => 'refused';
  const ctx = ctxFor(OWNER, '6.1');
  await fileFeedback(ctx, { project: 'DAR', body: 'the loader has a gradient' });
  const firstAttempt = postFeedback().at(-1)!;
  expect(firstAttempt.body.idempotencyKey, 'the write that can fail went out unkeyed').toBeTruthy();

  const item = listParked({ status: 'parked' })[0]!;
  sent.length = 0;
  router = () => ({ body: { shortId: 'DAR-FB-53', boardUrl: 'http://127.0.0.1:9/p/x' } });
  const r = await promoteParked(item, 'gabbar', { project: 'DAR' });
  expect(r.ok).toBe(true);
  const retry = postFeedback().at(-1)!;
  expect(retry.body.idempotencyKey, 'the retry asked darbar for a SECOND row').toBe(firstAttempt.body.idempotencyKey);
  expect(retry.body.idempotencyKey).toBe(writeKey({ channel: 'D000STUB', ts: '6.1' }, 'file'));
});

test('an append and the retry that promotes it carry the same idempotency key', async () => {
  router = (url) => {
    if (url.includes('/feedback/DAR-FB-7') && !url.endsWith('/append')) return { body: { projectId: 'p1' } };
    if (url.includes('/context')) return { body: { name: 'Darbar', stakeholders: [{ slackUserId: OTHER }] } };
    return 'refused';
  };
  await addToFeedback(ctxFor(OTHER, '7.1'), 'DAR-FB-7', 'also on the dashboard');
  const firstAttempt = postAppend().at(-1)!;
  expect(firstAttempt.body.idempotencyKey, 'the silent-duplicate write went out unkeyed').toBeTruthy();

  const item = listParked({ status: 'parked' })[0]!;
  sent.length = 0;
  router = () => ({ body: { appended: true, warnings: [] } });
  const a = await promoteAddition(item, 'gabbar');
  expect(a.ok).toBe(true);
  const retry = postAppend().at(-1)!;
  expect(retry.body.idempotencyKey, 'the retry would add the same words a second time').toBe(firstAttempt.body.idempotencyKey);
  expect(retry.body.idempotencyKey).toBe(writeKey({ channel: 'D000STUB', ts: '7.1' }, 'append'));
});

// The key names the write, not the target, because the server scopes it. Retargeting a held addition
// onto a different row has to still land, and that only works if the key is not the row.
test('the same held addition retargeted at another row still carries one key and lands', async () => {
  router = (url) => {
    if (url.includes('/feedback/DAR-FB-7') && !url.endsWith('/append')) return { body: { projectId: 'p1' } };
    if (url.includes('/context')) return { body: { name: 'Darbar', stakeholders: [{ slackUserId: OTHER }] } };
    return 'refused';
  };
  await addToFeedback(ctxFor(OTHER, '8.1'), 'DAR-FB-7', 'also on the dashboard');
  const item = listParked({ status: 'parked' })[0]!;
  sent.length = 0;
  router = () => ({ body: { appended: true, warnings: [] } });
  const a = await promoteAddition(item, 'gabbar', 'DAR-FB-99');
  expect(a.ok && a.appendedTo).toBe('DAR-FB-99');
  expect(postAppend().at(-1)!.url).toContain('DAR-FB-99');
});

// ---------- 5. what the sender is told ----------

test('an idempotent answer is not reported as a fresh filing', async () => {
  router = () => 'refused';
  await fileFeedback(ctxFor(OWNER, '9.1'), { project: 'DAR', body: 'x' });
  const item = listParked({ status: 'parked' })[0]!;
  router = () => ({ body: { shortId: 'DAR-FB-53', idempotent: true } });
  const r = await promoteParked(item, 'gabbar', { project: 'DAR' });
  expect(r.ok && r.alreadyThere, 'a row that already existed was reported as newly created').toBe(true);
  expect(readParked(item.parkId)!.status, 'the hold stayed in the queue after it resolved').toBe('promoted');
});

// DAR-241. TWO SENTENCES FROM ONE TURN MUST NOT CONTRADICT EACH OTHER, which is B1's defect one layer
// out. The sweep notice goes into the model's prompt and withFilingNotice is written onto the reply
// in code, and with the id identical in both cases the tail used to assert "is now filed as" over a
// row the notice had just said already existed. Whichever the model repeated, half of what the sender
// heard was false.
//
// The narrowing that makes it right is worth stating: idempotent:true means darbar HAD A ROW UNDER
// THIS KEY. It does not mean the sender's original attempt made it, because eight concurrent sweeps
// of one held item all present the same key, so seven of them would be dating a row created
// milliseconds ago. Neither sentence may say WHEN.
test('a turn that found the row already there never also says it was just filed', async () => {
  router = () => 'refused';
  await fileFeedback(ctxFor(OWNER, '17.1'), { project: 'DAR', body: 'x' });
  router = () => ({ body: { shortId: 'DAR-FB-53', idempotent: true } });
  const sweep = await sweepParked(ctxFor(OWNER, '18.1'));

  const done = sweep.find((r) => r.filed === 'DAR-FB-53')!;
  expect(done.alreadyThere, 'the sweep did not carry the distinction out to the reply').toBe(true);
  expect(done.notice).toContain('did NOT need filing again');
  expect(done.notice, 'the notice dated a landing it cannot know the time of').not.toContain('at the time');
  expect(done.notice).not.toContain('has NOW been filed');
  expect(done.notice).toContain('do NOT say when it landed');

  // the reply tail, split exactly as runAgent splits it
  const filedNow = sweep.flatMap((r) => (r.filed && !r.alreadyThere ? [r.filed] : []));
  const confirmedNow = sweep.flatMap((r) => (r.alreadyThere ? [r.filed ?? r.added ?? ''] : [])).filter(Boolean);
  expect(filedNow, 'a row that already existed was counted as filed by this turn').toEqual([]);
  expect(confirmedNow).toEqual(['DAR-FB-53']);
  const tail = withFilingNotice('theek hai.', filedNow, [], confirmedNow);
  expect(tail).toContain('is on the board as DAR-FB-53');
  expect(tail, 'the reply contradicted the notice about the same id').not.toContain('now filed as');
  // the whole turn read as one thing, which is how the sender reads it
  const turn = `${done.notice}\n${tail}`;
  expect(turn).not.toContain('now filed as DAR-FB-53');
  expect(turn).not.toContain('was never filed at the time');
});

// the opposite case must keep saying NOW, or the fix has just moved the dishonesty
test('a hold this turn really did file is still announced as filed', async () => {
  router = () => 'refused';
  await fileFeedback(ctxFor(OWNER, '19.1'), { project: 'DAR', body: 'x' });
  router = () => ({ body: { shortId: 'DAR-FB-54' } }); // no idempotent flag: this call created it
  const sweep = await sweepParked(ctxFor(OWNER, '20.1'));
  const done = sweep.find((r) => r.filed === 'DAR-FB-54')!;
  expect(done.alreadyThere).toBe(false);
  expect(done.notice).toContain('it has NOW been filed as DAR-FB-54');
  const filedNow = sweep.flatMap((r) => (r.filed && !r.alreadyThere ? [r.filed] : []));
  expect(withFilingNotice('theek hai.', filedNow, [], [])).toContain('now filed as DAR-FB-54');
});

test('the held copy claims neither that it was filed nor that it was lost', async () => {
  router = () => 'refused';
  const out = JSON.parse(await fileFeedback(ctxFor(OWNER, '10.1'), { project: 'DAR', body: 'x' }));
  const all = JSON.stringify(out).toLowerCase();
  expect(out.parkId).toMatch(/^PARK-/i);
  // the id is a holding id and the reply must never hand it out as a feedback id
  expect(out.filed).toBe(false);
  expect(out.feedbackShortId, 'an id was handed out for a write nobody confirmed').toBeUndefined();
  expect(all, 'the model was told it might be lost, which is not known either').toContain('do not tell them it definitely was not');
  expect(all).toContain('holding id, not a feedback id');
  // the reply reaches slack, and the charter bans em dashes and AI-tell phrasing in anything that does
  expect(all).not.toContain('—');
  for (const banned of ['delve', 'seamless', 'comprehensive', 'robust', 'leverage', 'apologi']) {
    expect(all).not.toContain(banned);
  }
});

// ---------- 6. the owner's hold is a new thing in the world ----------

// Before this change the owner could not have a held item at all: the gate answers for him before it
// resolves anything, so no refusal of his ever parked. A write failure gives him one, on the exact
// path the lost reports were on, and the sweep asks the gate's question with the gate's answer, so
// his hold is released on his next message even when he is not on that project's roster.
test('the owner\'s held report is released by the sweep, not stranded on a roster check', async () => {
  router = () => 'refused';
  const ctx = ctxFor(OWNER, '12.1');
  await fileFeedback(ctx, { project: 'DAR', body: 'the loader has a gradient' });
  expect(listParked({ status: 'parked' }).length).toBe(1);

  // darbar is back, and the roster deliberately does NOT contain the owner
  router = (url) => {
    if (url.includes('/context')) return { body: { name: 'Darbar', stakeholders: [{ slackUserId: OTHER }] } };
    return { body: { shortId: 'DAR-FB-53' } };
  };
  const results = await sweepParked(ctxFor(OWNER, '13.1'));
  expect(results.some((r) => r.filed === 'DAR-FB-53'), 'the owner held report was re-checked against a roster he is not on').toBe(true);
  expect(listParked({ status: 'parked' }).length, 'it stayed held after being filed').toBe(0);
});

test('a non-owner is still swept by the gate answer, not waved through', async () => {
  router = (url) => {
    if (url.includes('/context')) return { body: { name: 'Darbar', stakeholders: [{ slackUserId: OTHER }] } };
    return { body: { projectId: 'p1' } };
  };
  await fileFeedback(ctxFor(OTHER, '14.1'), { project: 'DAR', body: 'x' }); // gate passes, write "succeeds"
  router = () => 'refused';
  await fileFeedback(ctxFor(OTHER, '15.1'), { project: 'DAR', body: 'y' }); // held
  expect(listParked({ status: 'parked' }).length).toBe(1);

  // a stranger with a hold of their own would not be released, and neither is this sender once the
  // roster no longer has them
  router = (url) => (url.includes('/context') ? { body: { name: 'Darbar', stakeholders: [] } } : { body: {} });
  const results = await sweepParked(ctxFor(OTHER, '16.1'));
  expect(results.every((r) => !r.filed), 'a hold was filed for somebody the gate refuses').toBe(true);
  expect(listParked({ status: 'parked' }).length).toBe(1);
});

// A hold that the same turn then succeeds in writing must not be left for the sweep to write again.
test('a retry that succeeds in the same turn retires the hold it just made', async () => {
  router = () => 'refused';
  const ctx = ctxFor(OWNER, '11.1');
  await fileFeedback(ctx, { project: 'DAR', body: 'x' });
  expect(listParked({ status: 'parked' }).length).toBe(1);
  router = () => ({ body: { shortId: 'DAR-FB-60' } });
  await fileFeedback(ctx, { project: 'DAR', body: 'x' });
  expect(listParked({ status: 'parked' }).length, 'the sweep would have filed this a second time').toBe(0);
  expect(listParked()[0]!.status).toBe('superseded');
});
