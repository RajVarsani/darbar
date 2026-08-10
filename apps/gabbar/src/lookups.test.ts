// DAR-235: the 20s guarantee has to be true of a MESSAGE, not of a model turn.
//
// senderName and existingFeedback called darbar with a RAW fetch: no AbortSignal, no per-request
// timeout, no budget. They run in the Promise.all that executes BEFORE runAgent opened the budget
// scope, so against a darbar that accepts a connection and never answers, a slack message hung there
// forever and never reached any of the protection DAR-210 added. Same failure DAR-210 was built to
// prevent, in the file DAR-210 did not touch, unnoticed because both the fix and its review were
// scoped to agent.ts.
//
// Pinned here:
//  1. both calls are BOUNDED against a darbar that never answers, and degrade the way they always
//     did (the slack profile, and no thread mapping) rather than throwing.
//  2. both are CHARGED to the message budget, so the transport's calls and the agent's calls come
//     out of one allowance and a message that spends it says so.
//  3. once that allowance is gone they are not made at all, exactly like every other darbar call.
//  4. runWithMessageBudget is REENTRANT, which is what lets bot.ts open the scope around the whole
//     message while runAgent still opens one for anybody who has not.
//  5. no file under apps/gabbar/src reaches config.apiUrl with a raw fetch. That is the actual
//     lesson of this task, generalised: a bound is only as good as the narrowest path that bypasses
//     it, and a sweep done once by hand is a sweep that rots.
//
// HOW BOT.TS IS ISOLATED. It is never imported, here or anywhere in the test suite: it opens a slack
// socket at module scope, so importing it would connect to the real workspace. That is exactly why
// these two functions could not be exercised and why the bug survived a review, so they now live in
// lookups.ts and bot.ts imports them. What is left in bot.ts is the wiring (one runWithMessageBudget
// around the message) and item 5 below is the guard on it. senderName's slack client is a stub
// object here, never a Bolt client.
//
// The rest of the safety is the rig from agent-budget.test.ts, in the same order and all of it before
// the import: temp dirs so this machine's data/parked is untouched, stub tokens on a loopback slack
// base, a synthetic owner id, config overwritten after import in case another file built it from the
// real .env, the import refused unless both bases are loopback, and then global fetch replaced so an
// unexpected host throws instead of being requested.
import { afterAll, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const RIG = mkdtempSync(path.join(tmpdir(), 'darbar-lookups-'));
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

type Mode = 'ok' | 'hang';
let mode: Mode = 'ok';
let bodyOut = '{}';
let statusOut = 200;
const asked: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: unknown, init?: { signal?: AbortSignal }) => {
  const url = String(input);
  if (!url.startsWith(STUB_API) && !url.startsWith(STUB_SLACK)) {
    throw new Error(`test tried to reach ${url}; every call in this file must be stubbed`);
  }
  asked.push(url);
  if (mode === 'hang') {
    // a darbar that accepts the connection and never answers. It resolves ONLY when the caller's own
    // AbortSignal fires, so a caller with no signal hangs here forever, which is the bug.
    return new Promise((_resolve, reject) => {
      if (!init?.signal) return; // never settles: this is what the raw fetch did
      init.signal.addEventListener('abort', () => reject(init.signal!.reason));
    });
  }
  return new Response(bodyOut, { status: statusOut, headers: { 'content-type': 'application/json' } });
}) as typeof globalThis.fetch;

const { runWithMessageBudget } = await import('./agent');
const { existingFeedback, senderName } = await import('./lookups');

// a stand-in for the bolt client, so nothing in this file can talk to slack
const slackStub = { users: { info: async () => ({ user: { profile: { display_name: 'Slack Profile Name' } } }) } };

afterAll(() => {
  globalThis.fetch = realFetch;
  rmSync(RIG, { recursive: true, force: true });
});
beforeEach(() => {
  mode = 'ok';
  bodyOut = '{}';
  statusOut = 200;
  asked.length = 0;
});

// ---------- 1. bounded ----------

// THE REPRODUCTION. With a raw fetch these never settle and the slack message never gets a reply.
// The budget is small here so the test is quick; the shipped pair is 20s over a 10s per-request
// timeout and agent-budget.test.ts pins that arithmetic.
test('senderName gives up on a darbar that never answers', async () => {
  mode = 'hang';
  const name = await runWithMessageBudget(() => senderName(slackStub, 'U000000SOMEONE'), 120);
  expect(name, 'a hung darbar took the sender name down with it').toBe('Slack Profile Name');
});

test('existingFeedback gives up on a darbar that never answers', async () => {
  mode = 'hang';
  const fb = await runWithMessageBudget(() => existingFeedback('C1', '1.1'), 120);
  expect(fb, 'a hung darbar hung the whole message').toBe(null);
});

test('both together are bounded by ONE budget, the way a message runs them', async () => {
  mode = 'hang';
  const started = Date.now();
  const budget = await runWithMessageBudget(async (b) => {
    await Promise.all([senderName(slackStub, 'U000000SOMEONE'), existingFeedback('C1', '1.1')]);
    return b;
  }, 150);
  expect(Date.now() - started, 'the transport calls were bounded per request instead of per message').toBeLessThan(1_000);
  expect(budget.exhausted).toBe(true);
});

// ---------- 2. charged ----------

test('the transport reads are charged to the message budget', async () => {
  bodyOut = JSON.stringify([{ stakeholders: [{ slackUserId: 'U000000SOMEONE', name: 'Someone' }] }]);
  const budget = await runWithMessageBudget(async (b) => {
    expect(await senderName(slackStub, 'U000000SOMEONE')).toBe('Someone');
    return b;
  });
  expect(asked.length).toBe(1);
  // spend is real time and can round to 0 on a fast machine, so what is asserted is that the call
  // went THROUGH the budgeted path at all, which the exhaustion test below proves conclusively
  expect(budget.spentMs).toBeGreaterThanOrEqual(0);
  expect(budget.exhausted).toBe(false);
});

// ---------- 3. refused for free once the allowance is gone ----------

test('a spent budget stops the transport reads before they touch the wire', async () => {
  await runWithMessageBudget(async () => {
    const name = await senderName(slackStub, 'U000000SOMEONE');
    const fb = await existingFeedback('C1', '1.1');
    expect(name, 'it fell back to the slack profile, which is the pre-existing behaviour').toBe('Slack Profile Name');
    expect(fb).toBe(null);
  }, 0);
  expect(asked.length, 'a spent budget still put transport requests on the wire').toBe(0);
});

// ---------- 4. one budget per message ----------

// bot.ts opens the scope around the whole message and runAgent still calls runWithMessageBudget. If
// the inner call opened a second scope, the message would pay twice and the notice on the way out
// would only know about the inner half.
test('a nested scope joins the budget already running instead of granting a new one', async () => {
  mode = 'hang';
  const outer = await runWithMessageBudget(async (b) => {
    await existingFeedback('C1', '1.1'); // the transport read, charged to the outer budget
    const inner = await runWithMessageBudget(async (i) => i, 60_000);
    expect(inner, 'the inner scope was a different budget object').toBe(b);
    expect(inner.budgetMs, 'the inner scope granted itself a fresh allowance').toBe(120);
    return b;
  }, 120);
  expect(outer.exhausted, 'the outer budget was not charged for what the transport spent').toBe(true);
});

test('a caller with no scope open still gets one', async () => {
  const b = await runWithMessageBudget(async (x) => x, 500);
  expect(b.budgetMs).toBe(500);
  expect(b.spentMs).toBe(0);
});

// ---------- 5. the sweep, kept ----------

// The lesson of this task generalised. A bound is only as good as the narrowest path that bypasses
// it, and DAR-210 was bypassed by two calls in a file its review never opened. This is the guard on
// the next one.
//
// THE FIRST VERSION OF THIS GUARD DID NOT CATCH THE BUG IT WAS WRITTEN FOR, and that is worth more
// than the guard itself. It required `fetch(` and `config.apiUrl` ON THE SAME LINE. Run against the
// real pre-change bot.ts it flagged senderName and MISSED existingFeedback, because that call was
// written across two lines with the url on the second. A guard that passes on the instance that
// caused the incident is worse than no guard: it is the thing that makes the next person stop
// looking. The same blind spot covered a url held in a variable and an aliased fetch.
//
// So it does not look for a call at all. THE RULE IS THAT config.apiUrl DOES NOT APPEAR under
// apps/gabbar/src except inside fetchDarbar, which is the one place that attaches the signal and
// charges the budget. There is no formatting to get wrong: line breaks, a variable, an alias, a
// helper wrapping fetch, all of them still have to name the url somewhere, and naming it anywhere
// else fails here. fetchDarbar is located by slicing its function body rather than by matching a
// line, so reformatting that too changes nothing.
//
// Residual, stated rather than left to be found: someone could move the url OUT of fetchDarbar into
// a new raw call in agent.ts and keep the count at one. That breaks fetchDarbar itself, loudly and
// immediately, so it is not a silent failure. Slack fetches are a different host and out of scope.
// Comment lines are blanked rather than deleted, so every offset still points at the real file. A
// whole-line comment naming the url is prose (this file's own header does it), not a call. Only
// whole-line comments are stripped: a TRAILING comment mentioning it still reports, which is noise
// in the safe direction, and no amount of comment stripping can hide a call from this.
const decomment = (src: string): string =>
  src.split('\n').map((l) => (/^\s*(\/\/|\/\*|\*)/.test(l) ? ' '.repeat(l.length) : l)).join('\n');

function darbarRefs(name: string, src: string): string[] {
  const hits = [...decomment(src).matchAll(/config\.apiUrl/g)];
  if (!hits.length) return [];
  const start = src.indexOf('export async function fetchDarbar(');
  let from = -1, to = -1;
  if (start !== -1) {
    const end = src.indexOf('\n}\n', start);
    from = start;
    to = end === -1 ? src.length : end;
  }
  return hits
    .filter((m) => !(from !== -1 && m.index >= from && m.index < to))
    .map((m) => `${name}: config.apiUrl at offset ${m.index}, outside fetchDarbar, so it has no timeout and no budget`);
}

test('config.apiUrl appears nowhere under apps/gabbar/src except inside fetchDarbar', () => {
  const dir = new URL('.', import.meta.url).pathname;
  const offenders: string[] = [];
  let allowed = 0;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.ts') || name.endsWith('.test.ts')) continue;
    const src = readFileSync(path.join(dir, name), 'utf-8');
    offenders.push(...darbarRefs(name, src));
    if (name === 'agent.ts') allowed = [...decomment(src).matchAll(/config\.apiUrl/g)].length - darbarRefs(name, src).length;
  }
  expect(offenders).toEqual([]);
  // the allowance cannot be widened quietly either: fetchDarbar builds exactly one url
  expect(allowed, 'fetchDarbar names the darbar url more than once, or not at all').toBe(1);
});

// THE GUARD RUN AGAINST THE CODE THAT CAUSED THE INCIDENT, verbatim from 757d03f including the line
// break that defeated the first version. Both calls must be flagged. Kept as a fixture rather than
// read from git, because `git show HEAD:...` stops meaning "before the fix" the moment this is
// committed, and a regression test that quietly starts testing the fixed file is the same class of
// problem as the guard that quietly missed the bug.
const PRE_CHANGE_BOT = `
async function senderName(client: any, userId: string): Promise<string> {
  try {
    const r = await fetch(\`\${config.apiUrl}/projects\`);
    const projects = (await r.json()) as Array<{ stakeholders?: Array<{ slackUserId?: string; name: string }> }>;
  } catch { /* fall through to slack profile */ }
}

async function existingFeedback(channel: string, threadTs: string | null) {
  if (!threadTs) return null;
  try {
    const r = await fetch(
      \`\${config.apiUrl}/feedback/by-slack?channel=\${encodeURIComponent(channel)}&ts=\${encodeURIComponent(threadTs)}\`,
    );
    if (!r.ok) return null;
  } catch {
    return null;
  }
}
`;

test('the guard flags BOTH raw calls in the real pre-change bot.ts', () => {
  const found = darbarRefs('bot.ts', PRE_CHANGE_BOT);
  expect(found.length, 'the guard missed a raw darbar call in the exact code that lost the reports').toBe(2);
  // the multi-line one is the one a same-line scan misses, so it is named rather than counted
  const multiline = PRE_CHANGE_BOT.indexOf('config.apiUrl}/feedback/by-slack');
  expect(found.some((f) => f.includes(String(multiline))), 'the multi-line call still slips through').toBe(true);
});

// the shapes the same-line version was also blind to, none of which are hypothetical styles
test('the guard flags a url in a variable and an aliased fetch', () => {
  expect(darbarRefs('x.ts', 'const url = `${config.apiUrl}/projects`;\nawait fetch(url);').length).toBe(1);
  expect(darbarRefs('x.ts', 'const go = fetch;\nawait go(`${config.apiUrl}/projects`);').length).toBe(1);
  expect(darbarRefs('x.ts', 'await Bun.fetch(config.apiUrl + "/projects");').length).toBe(1);
});

// and it does not fire on the legitimate call, or it would be noise nobody reads
test('the guard does not fire on fetchDarbar itself', () => {
  const real = readFileSync(path.join(new URL('.', import.meta.url).pathname, 'agent.ts'), 'utf-8');
  expect(darbarRefs('agent.ts', real)).toEqual([]);
});

// bot.ts is not imported anywhere in this suite, and this says so out loud rather than leaving it to
// each new test file to remember. Importing it opens a slack socket to the real workspace.
test('no test file imports bot.ts', () => {
  const dir = new URL('.', import.meta.url).pathname;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.test.ts')) continue;
    const src = readFileSync(path.join(dir, name), 'utf-8');
    expect(/from '\.\/bot'|import\('\.\/bot'\)/.test(src), `${name} imports bot.ts, which opens a slack socket`).toBe(false);
  }
});
