// DAR-210: one budget for the whole message, not one per request.
// DAR-233: and it is time spent WAITING ON DARBAR, not time elapsed during the turn.
//
// The per-request AbortSignal bounded a single call. A turn makes three or four, and a turn from
// somebody with held reports makes up to ten more in the sweep before it starts, so a darbar that
// accepts connections and never answers cost 28 seconds on a plain question and minutes on a bad
// one, with a person watching an "is thinking..." that never resolves.
//
// The first fix measured the wrong quantity. It was a wall-clock deadline set when the scope opened,
// and the scope wraps the model loop, so Opus's thinking time was charged to darbar. Darbar answered
// in 30ms all day and the budget still ran out, and it ran out LATE in the turn, which is exactly
// where filing happens: pending_feedback and file_feedback were the tools reported as never
// attempted, and three of Raj's reports were lost. The tests below did not catch it because they
// forced the spent branch with ms:0, which is true under either meaning. The gap test at the top of
// the DAR-233 block is the one that would have.
//
// What is pinned here is the four things that have to be true and are easy to get wrong:
//
//  1. spend ACCUMULATES PER CALL. Only the duration of a fetch is charged; a gap between two calls,
//     however long, costs nothing.
//  2. the budget covers the MESSAGE. Three hung calls cost one budget, not three timeouts, and the
//     calls after it is spent are not made at all.
//  3. it still FAILS CLOSED. A spent budget is unreachable, and unreachable is a refusal at the
//     stakeholder gate. A budget that let somebody through because the check timed out would be
//     worse than the hang it replaces.
//  4. a turn that ran out SAYS SO. Answering from whatever was fetched before the budget went is
//     the defect class this project keeps finding, so the admission is written in code on the way
//     out rather than left to the model, and it appears ONLY on budget exhaustion.
//
// SAFETY, in the order it is established, all of it before the agent is imported:
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

const RIG = mkdtempSync(path.join(tmpdir(), 'darbar-budget-'));
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

// Nothing reaches the network. `mode` decides what the stub does with a request; every test says
// which one it wants, and a url outside the two stub bases is a thrown test failure, not a request.
type Mode = 'ok' | 'hang' | 'boom' | 'slow';
let mode: Mode = 'ok';
let slowMs = 80;
let bodyOut = '{}';
const asked: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: unknown, init?: { signal?: AbortSignal }) => {
  const url = String(input);
  if (!url.startsWith(STUB_API) && !url.startsWith(STUB_SLACK)) {
    throw new Error(`test tried to reach ${url}; every call in this file must be stubbed`);
  }
  asked.push(url);
  if (mode === 'boom') throw new Error('connection refused');
  if (mode === 'hang' || mode === 'slow') {
    // hang is a darbar that accepts the connection and never answers, so it resolves only when the
    // caller's own AbortSignal fires, which is exactly the shape DAR-210 is about. slow is a darbar
    // that does answer, eventually, which is how spend accumulates across calls that all succeed.
    return new Promise((resolve, reject) => {
      const t = mode === 'slow'
        ? setTimeout(() => resolve(new Response(bodyOut, { status: 200, headers: { 'content-type': 'application/json' } })), slowMs)
        : null;
      init?.signal?.addEventListener('abort', () => {
        if (t) clearTimeout(t);
        reject(init.signal!.reason);
      });
    });
  }
  return new Response(bodyOut, { status: 200, headers: { 'content-type': 'application/json' } });
}) as typeof globalThis.fetch;

const {
  fetchDarbar, runWithMessageBudget, withBudgetNotice, verifyStakeholder,
  MESSAGE_BUDGET_MS, DARBAR_TIMEOUT_MS,
} = await import('./agent');

afterAll(() => {
  globalThis.fetch = realFetch;
  rmSync(RIG, { recursive: true, force: true });
});
beforeEach(() => {
  mode = 'ok';
  slowMs = 80;
  bodyOut = '{}';
  asked.length = 0;
});

const ctx = {
  senderId: 'U000000SOMEONE', // NOT the owner: the gate has to actually run
  senderName: 'Someone',
  isOwner: false,
  channel: 'D000STUB',
  channelType: 'im',
  messageTs: '1.1',
  threadTs: null,
  attachments: [],
  attach: { items: [], blocks: [], inventory: 'none' },
  messageText: 'hi',
  existingFeedback: null,
} as unknown as Parameters<typeof verifyStakeholder>[0];

test('a call with no message scope behaves exactly as before', async () => {
  bodyOut = JSON.stringify({ name: 'Stub Project' });
  const f = await fetchDarbar('/projects/STUB/context');
  expect(f.reachable).toBe(true);
  expect(asked.length).toBe(1);
});

// ---------- DAR-233: what the budget MEASURES ----------

// THE TEST THAT WOULD HAVE CAUGHT IT. Every darbar call here is instant and the gap between them is
// longer than the entire budget, which is a turn where Opus thought for a while between tool calls.
// Under the wall-clock deadline the late call was refused and never put on the wire; under spend
// that accumulates per call this message has used about a millisecond and the call is made.
test('a long gap between fast calls costs the budget nothing', async () => {
  bodyOut = JSON.stringify({ name: 'Stub Project' });
  const budget = await runWithMessageBudget(async (b) => {
    for (let i = 0; i < 3; i++) expect((await fetchDarbar('/projects')).reachable).toBe(true);
    await new Promise((r) => setTimeout(r, 300)); // the model thinking between tool calls
    const late = await fetchDarbar('/feedback', 'POST', { body: 'a report' });
    expect(late.reachable, 'the late call was refused for time the model spent, not darbar').toBe(true);
    return b;
  }, 200);
  expect(asked.length, 'the call that files was never attempted').toBe(4);
  expect(budget.exhausted).toBe(false);
  expect(withBudgetNotice('filed it.', budget)).toBe('filed it.');
});

// the same shape one level up, where the damage actually happened: filing runs late in a turn, so
// the gate call in front of it was the one starved, and a starved gate call is a refusal that parks
// the report instead of filing it
test('a stakeholder is still recognised late in a slow turn', async () => {
  bodyOut = JSON.stringify({ name: 'Stub Project', stakeholders: [{ slackUserId: 'U000000SOMEONE' }] });
  const v = await runWithMessageBudget(async () => {
    await fetchDarbar('/projects'); // context gathering, early in the turn
    await new Promise((r) => setTimeout(r, 300));
    return verifyStakeholder(ctx, { project: 'STUB' }); // the gate in front of file_feedback
  }, 200);
  expect(v.ok, 'a real stakeholder was refused because the turn had been going a while').toBe(true);
});

// the other half of the same property: time darbar takes IS charged, and it adds up across calls
// that each succeed, so a darbar that is merely slow still cannot run a message forever
test('spend accumulates across calls that darbar does answer', async () => {
  mode = 'slow';
  slowMs = 60; // ten of these is 600ms of waiting, against a 200ms budget
  const started = Date.now();
  const answered: boolean[] = [];
  const budget = await runWithMessageBudget(async (b) => {
    for (let i = 0; i < 10; i++) answered.push((await fetchDarbar('/projects')).reachable);
    return b;
  }, 200);
  const elapsed = Date.now() - started;
  expect(answered[0], 'the first call was refused on an untouched budget').toBe(true);
  expect(answered.filter(Boolean).length, 'a 60ms darbar answered more often than a 200ms budget pays for').toBeLessThanOrEqual(3);
  expect(answered.at(-1), 'the budget never ran out against a darbar slower than it').toBe(false);
  expect(elapsed, 'every slow call was allowed, so the budget is still per request').toBeLessThan(400);
  expect(asked.length, 'calls kept going on the wire after the budget was gone').toBeLessThanOrEqual(4);
  expect(budget.exhausted).toBe(true);
});

// the number is a claim about the worst case, so it is written down rather than left to be
// rediscovered: 20s of waiting buys exactly two attempts at the 10s per-request timeout, and every
// call after those is refused without touching the wire. 20s of WAITING is also unreachable on a
// healthy darbar, where a fourteen-call turn spends about 400ms.
test('the chosen budget says what a hanging darbar costs per message', () => {
  expect(MESSAGE_BUDGET_MS).toBe(20_000);
  expect(MESSAGE_BUDGET_MS / DARBAR_TIMEOUT_MS, 'attempts a fully hanging darbar gets per message').toBe(2);
});

test('once the budget is spent the remaining calls are not made at all', async () => {
  const budget = await runWithMessageBudget(async (b) => {
    for (let i = 0; i < 5; i++) {
      const f = await fetchDarbar('/projects');
      expect(f.reachable).toBe(false);
      expect('detail' in f && f.detail).toContain('budget');
    }
    return b;
  }, 0);
  expect(asked.length, 'a spent budget still put requests on the wire').toBe(0);
  expect(budget.exhausted).toBe(true);
});

// the original protection, unchanged by DAR-233: a darbar that accepts the connection and then
// never answers is still bounded, and the bound is the BUDGET rather than the budget per call.
// Scaled down here because the shipped pair is 20s over a 10s timeout, which is a slow test; the
// arithmetic test above pins what those two produce.
test('the budget bounds the whole message, not each call', async () => {
  mode = 'hang';
  const started = Date.now();
  const budget = await runWithMessageBudget(async (b) => {
    for (let i = 0; i < 3; i++) {
      const f = await fetchDarbar('/projects');
      expect(f.reachable).toBe(false);
    }
    return b;
  }, 150);
  const spent = Date.now() - started;
  // one budget for three calls. The old behaviour was three 10s timeouts; anything near that here
  // would mean the bound is still per request.
  expect(spent, 'a hanging darbar cost more than the whole budget').toBeLessThan(1_000);
  expect(budget.exhausted).toBe(true);
  expect(asked.length, 'calls after the budget was gone were still attempted').toBe(1);
});

test('the deadline survives the async hops a real turn makes', async () => {
  // AsyncLocalStorage is the whole reason two concurrent messages cannot spend each other's budget,
  // and it is also the thing that quietly stops working if the context is lost across a hop. A turn
  // goes through timers, promise chains and the tool runner before its first darbar call.
  const budget = await runWithMessageBudget(async (b) => {
    await new Promise((r) => setTimeout(r, 5));
    await Promise.resolve().then(() => Promise.resolve());
    await Promise.all([Promise.resolve(1), new Promise((r) => setTimeout(r, 1))]);
    const f = await fetchDarbar('/projects');
    expect(f.reachable, 'the budget was lost across an async hop').toBe(false);
    return b;
  }, 0);
  expect(budget.exhausted).toBe(true);
  expect(asked.length).toBe(0);
});

test('two messages in flight do not spend each other budget', async () => {
  mode = 'ok';
  bodyOut = JSON.stringify({ name: 'Stub Project' });
  const [spent, fresh] = await Promise.all([
    runWithMessageBudget(async (b) => { await fetchDarbar('/projects'); return b; }, 0),
    runWithMessageBudget(async (b) => {
      await new Promise((r) => setTimeout(r, 10));
      const f = await fetchDarbar('/projects');
      expect(f.reachable, 'a second message inherited the first one exhausted budget').toBe(true);
      return b;
    }, 5_000),
  ]);
  expect(spent.exhausted).toBe(true);
  expect(fresh.exhausted).toBe(false);
});

test('the stakeholder gate still fails closed when the budget is what ran out', async () => {
  const v = await runWithMessageBudget(() => verifyStakeholder(ctx, { project: 'STUB' }), 0);
  expect(v.ok).toBe(false);
  expect(!v.ok && v.kind).toBe('unreachable');
  expect(!v.ok && v.detail).toContain('budget');
  expect(asked.length).toBe(0);
});

test('a gate that would have PASSED still fails closed on a spent budget', async () => {
  // the roster genuinely contains this sender, so the only thing refusing them is the deadline
  bodyOut = JSON.stringify({ name: 'Stub Project', stakeholders: [{ slackUserId: 'U000000SOMEONE' }] });
  const allowed = await runWithMessageBudget(() => verifyStakeholder(ctx, { project: 'STUB' }), 5_000);
  expect(allowed.ok).toBe(true);
  const refused = await runWithMessageBudget(() => verifyStakeholder(ctx, { project: 'STUB' }), 0);
  expect(refused.ok).toBe(false);
});

test('a turn that ran out of budget says so, in code, whatever the model wrote', async () => {
  const budget = await runWithMessageBudget(async (b) => { await fetchDarbar('/projects'); return b; }, 0);
  const out = withBudgetNotice('everything looks fine on DAR, 3 tasks in review.', budget);
  expect(out).toContain('everything looks fine');
  expect(out).toContain('ran out of time');
  expect(out).toContain('may be missing something');
});

test('the notice appears only for the budget, not for every failure', async () => {
  mode = 'boom';
  const budget = await runWithMessageBudget(async (b) => {
    const f = await fetchDarbar('/projects');
    expect(f.reachable).toBe(false);
    expect('detail' in f && f.detail).toContain('unreachable');
    return b;
  }, 5_000);
  expect(budget.exhausted, 'an ordinary network failure marked the whole turn').toBe(false);
  expect(withBudgetNotice('all good.', budget)).toBe('all good.');
});

test('a healthy message is untouched, with no notice and no extra latency', async () => {
  bodyOut = JSON.stringify({ name: 'Stub Project' });
  const budget = await runWithMessageBudget(async (b) => {
    for (let i = 0; i < 4; i++) expect((await fetchDarbar('/projects')).reachable).toBe(true);
    return b;
  });
  expect(budget.exhausted).toBe(false);
  expect(asked.length).toBe(4);
  expect(withBudgetNotice('done.', budget)).toBe('done.');
});

// the reply reaches slack, and the charter bans em dashes and AI-tell phrasing in anything that does
test('the budget notice is plain lowercase prose', () => {
  const out = withBudgetNotice('x', { exhausted: true });
  expect(out).not.toContain('—');
  expect(out.toLowerCase()).toBe(out);
  for (const banned of ['delve', 'seamless', 'comprehensive', 'robust', 'leverage', 'apologi']) {
    expect(out).not.toContain(banned);
  }
});
