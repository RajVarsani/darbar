// The two gates on `done`, and the equality that decides whether a field was edited.
//
// These are the two things that actually escaped today, which is the whole reason this file exists
// rather than a sweep for coverage.
//
// THE DONE GATES are the most-missed fact in the engine: a dev task has TWO of them, not one. Open
// review children block it, and so does feedback FILED ON it that is still pending, triaged,
// accepted or in_progress. needs_clarification does not, because that row is sitting with the
// reporter and nobody here can move it. Both gates are also enforced from the other side, inside
// maybeAdvanceParent, which is why a parent whose lane closed can still sit in in_review with
// nothing on the board saying why. Every assertion below goes through the real routes, so the rule
// holds for a UI drag, an MCP call and a curl alike.
//
// THE EQUALITY PATH is the guard inside the guard. notApplied() refuses a vocabulary field a route
// cannot apply, except when the value equals what is stored, so read-the-whole-thing / change-one-
// part / send-it-back still works. That exception is a NEW silent-drop vector: anything it calls
// equal that is not equal gets dropped under a 200, in the mechanism built to stop exactly that.
// So what is pinned here is the FALSE side — reordered, whitespace-different and empty-vs-typed
// values must all read as changes. field-drop.test.ts pins the true side.
import { afterAll, beforeEach, expect, test } from 'bun:test';
import { api, children, feedback, project, req, reset, task, teardown } from './test-harness';
// after the harness import on purpose: the harness installs the module mock, and this is the same
// config object api.ts reads (the mock spreads it by reference), so tests can stub the slack fields
import { config } from '@darbar/core';
import { echoedUnchanged } from './api';

afterAll(teardown);
beforeEach(reset);

const statusOf = async (ref: string) => (await req<{ status: string }>('GET', `/tasks/${ref}`)).body.status;

// ---------- gate one: open review children ----------

test('a dev task cannot close over the head of a review lane that is still open', async () => {
  const p = await project();
  const t = await task(p.prefix, { lanes: ['code-review'] });
  await req('PATCH', `/tasks/${t.shortId}`, { status: 'in_review' });

  const kids = await children(t.shortId);
  expect(kids).toHaveLength(1);
  expect(kids[0]!.status).toBe('todo');

  const closed = await req('PATCH', `/tasks/${t.shortId}`, { status: 'done' });
  expect(closed.status).toBe(409);
  expect(closed.error).toContain('1 open review subtask');
  expect(await statusOf(t.shortId)).toBe('in_review');
});

test('closing the last review lane advances the parent by itself', async () => {
  const p = await project();
  const t = await task(p.prefix, { lanes: ['code-review', 'qa'] });
  await req('PATCH', `/tasks/${t.shortId}`, { status: 'in_review' });
  const kids = await children(t.shortId);
  expect(kids).toHaveLength(2);

  await req('PATCH', `/tasks/${kids[0]!.shortId}`, { status: 'done' });
  expect(await statusOf(t.shortId)).toBe('in_review'); // one lane left

  await req('PATCH', `/tasks/${kids[1]!.shortId}`, { status: 'done' });
  expect(await statusOf(t.shortId)).toBe('done');
});

// ---------- DAR-272: an absent/null lanes field defaults to code-review, not every lane ----------

test('a task with no lanes field spawns only code-review when the pipeline has that lane', async () => {
  const p = await project(); // default fixture pipeline: code-review, qa, design-qa
  const t = await task(p.prefix);
  await req('PATCH', `/tasks/${t.shortId}`, { status: 'in_review' });

  const kids = await children(t.shortId);
  expect(kids).toHaveLength(1);
  expect((kids[0] as unknown as { lane: string }).lane).toBe('code-review');
});

test('a task with no lanes field spawns every lane on a pipeline with no code-review key', async () => {
  const p = await project({
    pipeline: {
      autoAdvance: true,
      reviews: [
        { lane: 'qa', label: 'QA', manager: 'qa-lead' },
        { lane: 'design-qa', label: 'DQA', manager: 'staff-designer' },
      ],
    },
  });
  const t = await task(p.prefix);
  await req('PATCH', `/tasks/${t.shortId}`, { status: 'in_review' });

  const kids = await children(t.shortId);
  expect(kids).toHaveLength(2);
  const lanes = (kids as unknown as { lane: string }[]).map((k) => k.lane).sort();
  expect(lanes).toEqual(['design-qa', 'qa']);
});

test('lanes: [] still spawns nothing, even on a pipeline with a code-review lane', async () => {
  const p = await project();
  const t = await task(p.prefix, { lanes: [] });
  await req('PATCH', `/tasks/${t.shortId}`, { status: 'in_review' });

  const kids = await children(t.shortId);
  expect(kids).toHaveLength(0);
});

// ---------- gate two: open feedback filed on the task ----------

test('every open feedback status filed on a task blocks done, and says which row', async () => {
  for (const status of ['pending', 'triaged', 'accepted', 'in_progress']) {
    await reset();
    const p = await project();
    const t = await task(p.prefix);
    const fb = await feedback({ taskRef: t.shortId });
    if (status !== 'pending') {
      const moved = await req('PATCH', `/feedback/${fb.shortId}`, { status });
      expect(moved.status, `could not move ${fb.shortId} to ${status}`).toBe(200);
    }
    const closed = await req('PATCH', `/tasks/${t.shortId}`, { status: 'done' });
    expect(closed.status, `${status} feedback did not block done`).toBe(409);
    expect(closed.error).toContain('1 open feedback row');
    expect(closed.error).toContain(fb.shortId);
    expect(await statusOf(t.shortId)).not.toBe('done');
  }
});

test('needs_clarification is with the reporter, so it does not block done', async () => {
  const p = await project();
  const t = await task(p.prefix);
  const fb = await feedback({ taskRef: t.shortId });
  await req('PATCH', `/feedback/${fb.shortId}`, {
    status: 'needs_clarification',
    resolution: 'which browser were you on when the column dropped',
  });
  const closed = await req('PATCH', `/tasks/${t.shortId}`, { status: 'done' });
  expect(closed.status).toBe(200);
  expect(await statusOf(t.shortId)).toBe('done');
});

// ---------- the same two gates, from inside maybeAdvanceParent ----------
// This is the case that keeps being missed: the lane closed, so the board looks finished, and the
// parent stays in in_review because a finding filed against it is still open.

test('a parent whose lane closed still waits on its open feedback, then ships when it resolves', async () => {
  const p = await project();
  const t = await task(p.prefix, { lanes: ['code-review'] });
  await req('PATCH', `/tasks/${t.shortId}`, { status: 'in_review' });
  const fb = await feedback({ taskRef: t.shortId });

  const kids = await children(t.shortId);
  await req('PATCH', `/tasks/${kids[0]!.shortId}`, { status: 'done' });
  expect(await statusOf(t.shortId)).toBe('in_review');

  await req('PATCH', `/feedback/${fb.shortId}`, { status: 'resolved', resolution: 'fixed in the same change' });
  expect(await statusOf(t.shortId)).toBe('done');
});

test('a rejected finding releases the parent too, since nothing is left to action', async () => {
  const p = await project();
  const t = await task(p.prefix, { lanes: ['code-review'] });
  await req('PATCH', `/tasks/${t.shortId}`, { status: 'in_review' });
  const fb = await feedback({ taskRef: t.shortId });
  const kids = await children(t.shortId);
  await req('PATCH', `/tasks/${kids[0]!.shortId}`, { status: 'cancelled' });
  expect(await statusOf(t.shortId)).toBe('in_review');

  await req('PATCH', `/feedback/${fb.shortId}`, { status: 'rejected', resolution: 'working as intended, the column is meant to fold' });
  expect(await statusOf(t.shortId)).toBe('done');
});

// ---------- DAR-247: four writes that answered 200 and should not ----------
//
// Every one of these was a 200 on a write the engine had no business accepting, and every one of
// them maps onto damage already done to a live board: a row that shipped DONE UNREVIEWED, a row
// carrying two review rounds, 43 probe rows attributed to "unknown", and a PATCH answering with a
// status the server had itself already replaced. The rules existed in a document and the document
// stopped nothing.

// ---------- 1. lanes are frozen while a builder is holding the row ----------

test('lanes cannot change while a task is in_progress, and the row does not ship unreviewed', async () => {
  const p = await project();
  const t = await task(p.prefix, { lanes: ['code-review'] });
  await req('PATCH', `/tasks/${t.shortId}`, { status: 'in_progress' });

  const cleared = await req('PATCH', `/tasks/${t.shortId}`, { lanes: [] });
  expect(cleared.status).toBe(409);
  expect(cleared.error).toBe(
    `${t.shortId} is in_progress; a builder is holding this row, so lanes cannot change here. Move it to todo or blocked in a separate patch first.`,
  );

  // the harm the 409 prevents: with lanes cleared, the builder's own in_review report found nothing
  // to spawn and self-advanced the row straight to done
  const reported = await req<{ status: string }>('PATCH', `/tasks/${t.shortId}`, { status: 'in_review' });
  expect(reported.body.status).toBe('in_review');
  expect(await children(t.shortId)).toHaveLength(1);
});

test('an echo of the stored lanes is not an edit, so a builder can send the row back whole', async () => {
  const p = await project();
  const t = await task(p.prefix, { lanes: ['code-review'] });
  await req('PATCH', `/tasks/${t.shortId}`, { status: 'in_progress' });

  const echoed = await req('PATCH', `/tasks/${t.shortId}`, { lanes: ['code-review'], notes: 'still on it' });
  expect(echoed.status).toBe(200);
  const back = await req<{ notes: string; lanes: string[] }>('GET', `/tasks/${t.shortId}`);
  expect(back.body.notes).toBe('still on it'); // the rest of the body applied, not just the echo
  expect(back.body.lanes).toEqual(['code-review']);

  // and the same for a row whose selection is the default: null echoed onto null changes nothing
  const u = await task(p.prefix);
  await req('PATCH', `/tasks/${u.shortId}`, { status: 'in_progress' });
  const echoedNull = await req('PATCH', `/tasks/${u.shortId}`, { lanes: null, notes: 'unchanged' });
  expect(echoedNull.status).toBe(200);
});

test('null and [] are opposite selections, so [] onto null is a change and the freeze catches it', async () => {
  const p = await project();
  const t = await task(p.prefix); // lanes null: every configured lane
  await req('PATCH', `/tasks/${t.shortId}`, { status: 'in_progress' });
  const cleared = await req('PATCH', `/tasks/${t.shortId}`, { lanes: [] }); // explicitly no lanes
  expect(cleared.status).toBe(409);
  expect(cleared.error).toContain('a builder is holding this row');
});

test('the freeze stops at the statuses that hold a row: lanes still move at todo', async () => {
  const p = await project();
  const t = await task(p.prefix, { lanes: ['code-review'] });
  const moved = await req('PATCH', `/tasks/${t.shortId}`, { lanes: ['qa'] });
  expect(moved.status).toBe(200);
  const back = await req<{ lanes: string[] }>('GET', `/tasks/${t.shortId}`);
  expect(back.body.lanes).toEqual(['qa']);
});

// lanesEchoed short-circuits the WHOLE freeze block, not just the in_progress branch above, so it
// also waves an echoed selection past the pre-existing in_review/qa/done/cancelled freeze and the
// "already has review children" freeze. That is almost certainly correct (read-edit-send-whole has
// to survive on a closed row too) but nothing pinned it before this: a genuinely CHANGED lanes on the
// same row still has to 409, or the echo exemption would have quietly become a way to re-pick lanes
// on a done task.
test('an echoed lanes selection also passes the review-flow freeze, but a genuine change on the same row still 409s', async () => {
  const p = await project();
  const t = await task(p.prefix, { lanes: ['code-review'] });
  await req('PATCH', `/tasks/${t.shortId}`, { status: 'in_review' });
  const kids = await children(t.shortId);
  await req('PATCH', `/tasks/${kids[0]!.shortId}`, { status: 'done' }); // round closes, parent ships
  expect(await statusOf(t.shortId)).toBe('done');

  const echoed = await req('PATCH', `/tasks/${t.shortId}`, { lanes: ['code-review'], notes: 'still echoing' });
  expect(echoed.status).toBe(200);
  const back = await req<{ notes: string; lanes: string[] }>('GET', `/tasks/${t.shortId}`);
  expect(back.body.notes).toBe('still echoing'); // the rest of the body applied, not just the echo
  expect(back.body.lanes).toEqual(['code-review']);

  const changed = await req('PATCH', `/tasks/${t.shortId}`, { lanes: ['qa'] });
  expect(changed.status).toBe(409);
  expect(changed.error).toContain('lanes are frozen once the review flow starts');
});

// ---------- 2. one entry into in_review, one review round ----------

/** parent with one closed review round behind it, sitting somewhere it can re-enter in_review from */
async function afterAClosedRound() {
  const p = await project();
  const t = await task(p.prefix, { lanes: ['code-review'] });
  await req('PATCH', `/tasks/${t.shortId}`, { status: 'in_review' });
  const kids = await children(t.shortId);
  await req('PATCH', `/tasks/${kids[0]!.shortId}`, { status: 'done' }); // round closes, parent ships
  await req('PATCH', `/tasks/${t.shortId}`, { status: 'in_progress' }); // rework
  return { t, kid: kids[0]! };
}

test('re-entering in_review after a closed round is refused, and the 409 names the round', async () => {
  const { t, kid } = await afterAClosedRound();
  const again = await req('PATCH', `/tasks/${t.shortId}`, { status: 'in_review' });
  expect(again.status).toBe(409);
  expect(again.error).toContain(kid.shortId);
  expect(again.error).toContain('code-review');
  expect(again.error).toContain('reviewAgain');
  expect(await statusOf(t.shortId)).toBe('in_progress'); // refused means nothing moved
  expect(await children(t.shortId)).toHaveLength(1);
});

// Companion assertion, not an independent pin: on its own this test is vacuous, because reverting
// the double-round guard leaves it green too (without the guard the second round spawns anyway, since
// spawnReviews's own no-double-spawn check only counts OPEN children). The test above it — "re-
// entering in_review after a closed round is refused" — is the one that actually pins the guard by
// asserting the 409 WITHOUT reviewAgain; this one only pins that the override, once a guard exists to
// override, still lets the legitimate case through.
test('reviewAgain is the override, and it spawns exactly one more round', async () => {
  const { t } = await afterAClosedRound();
  const forced = await req('PATCH', `/tasks/${t.shortId}`, { status: 'in_review', reviewAgain: true });
  expect(forced.status).toBe(200);
  expect(await statusOf(t.shortId)).toBe('in_review');
  expect(await children(t.shortId)).toHaveLength(2);
});

// ---------- 2b. reviewAgain is refused where it means nothing, not silently dropped ----------
// The route used to accept reviewAgain unconditionally and only ACT on it inside the entering-review
// branch. Anywhere else — alone, or alongside a status that is not a genuine entry into in_review —
// it was accepted and did nothing: {reviewAgain: true} alone 200'd with nothing spawned, and a
// typo'd status alongside a correctly-spelled override 200'd the same way. That is precisely the
// "answers 200 and should not" class DAR-247 exists to close.

test('reviewAgain alone, with nothing to attach it to, is refused rather than silently doing nothing', async () => {
  const { t } = await afterAClosedRound(); // sitting in_progress, one closed round behind it
  const alone = await req('PATCH', `/tasks/${t.shortId}`, { reviewAgain: true });
  expect(alone.status).toBe(400);
  expect(alone.error).toContain('reviewAgain only means something');
  expect(await statusOf(t.shortId)).toBe('in_progress'); // refused means nothing moved
});

test('reviewAgain alongside a status that is not in_review is refused, not eaten', async () => {
  const { t } = await afterAClosedRound();
  const wrongStatus = await req('PATCH', `/tasks/${t.shortId}`, { status: 'blocked', reviewAgain: true });
  expect(wrongStatus.status).toBe(400);
  expect(wrongStatus.error).toContain('reviewAgain only means something');
  expect(await statusOf(t.shortId)).toBe('in_progress');
});

test('reviewAgain: false carries no instruction, so it is exempt and an unrelated patch still applies', async () => {
  const { t } = await afterAClosedRound();
  const ok = await req('PATCH', `/tasks/${t.shortId}`, { status: 'blocked', reviewAgain: false });
  expect(ok.status).toBe(200);
  expect(await statusOf(t.shortId)).toBe('blocked');
});

test('reviewAgain is a word this API applies, so it is typed and it is refused where it means nothing', async () => {
  const p = await project();
  const t = await task(p.prefix, { lanes: ['code-review'] });

  const mistyped = await req('PATCH', `/tasks/${t.shortId}`, { status: 'in_review', reviewAgain: 'yes' });
  expect(mistyped.status).toBe(400);
  expect(mistyped.error).toContain('reviewAgain must be true');
  expect(await statusOf(t.shortId)).toBe('todo');

  // a task being created has no earlier round to duplicate, so the word is refused rather than eaten
  const created = await req('POST', '/tasks', { project: p.prefix, title: 'fresh', reviewAgain: true });
  expect(created.status).toBe(400);
  expect(created.error).toContain('reviewAgain');
});

test('a round still OPEN is not the duplicate case: re-entry is a no-op and stays a 200', async () => {
  const p = await project();
  const t = await task(p.prefix, { lanes: ['code-review', 'qa'] });
  await req('PATCH', `/tasks/${t.shortId}`, { status: 'in_review' });
  expect(await children(t.shortId)).toHaveLength(2);

  await req('PATCH', `/tasks/${t.shortId}`, { status: 'in_progress' });
  const back = await req('PATCH', `/tasks/${t.shortId}`, { status: 'in_review' });
  expect(back.status).toBe(200);
  expect(await children(t.shortId)).toHaveLength(2); // nothing spawned on top of the live round
});

// ---------- 2c. DAR-256: one entry into in_review, under real concurrency ----------
//
// A SEQUENTIAL probe proves nothing about this defect and the repo has already paid to learn that
// (DAR-229: a read-then-insert that did not reproduce under ten sequential POSTs and did reproduce
// under eight concurrent sweeps). Both requests below read the row, and read openReviewCount inside
// spawnReviews, before either of them writes — so every guard that lives in a READ sees a row that
// has not moved yet. Fired with Promise.all, against the real routes, on the real driver.
//
// Repeated rather than fired once: the interleaving is what is under test, so one green pass is one
// sample. Measured before the fix — every iteration produced a doubled round (4 children, and 3 on
// the reviewAgain shape); measured after — 100 iterations, no doubling and no serialised pair.
const RACES = 5;

test('two concurrent entries into in_review leave ONE round, and the loser is told it lost', async () => {
  for (let i = 0; i < RACES; i++) {
    await reset();
    const p = await project();
    const t = await task(p.prefix, { lanes: ['code-review', 'qa'] });
    await req('PATCH', `/tasks/${t.shortId}`, { status: 'in_progress' });

    const [a, b] = await Promise.all([
      req('PATCH', `/tasks/${t.shortId}`, { status: 'in_review' }),
      req('PATCH', `/tasks/${t.shortId}`, { status: 'in_review' }),
    ]);

    // the invariant: two lanes configured, one round, two children — never two rounds on one row
    expect(await children(t.shortId), `iteration ${i}`).toHaveLength(2);
    expect(await statusOf(t.shortId)).toBe('in_review');

    // and the loser hears about it rather than being told 200 about a write that never landed
    const codes = [a.status, b.status].sort();
    expect(codes, `iteration ${i}`).toEqual([200, 409]);
    const loser = a.status === 409 ? a : b;
    expect(loser.error).toContain('owns the review round');
    expect(loser.error).toContain('nothing in this patch was applied');
  }
});

test('two concurrent reviewAgain overrides spawn exactly one fresh round, not two', async () => {
  for (let i = 0; i < RACES; i++) {
    await reset();
    const { t } = await afterAClosedRound(); // one closed round behind it, sitting in_progress

    const [a, b] = await Promise.all([
      req('PATCH', `/tasks/${t.shortId}`, { status: 'in_review', reviewAgain: true }),
      req('PATCH', `/tasks/${t.shortId}`, { status: 'in_review', reviewAgain: true }),
    ]);

    // 1 closed child from the first round + 1 fresh one. Three is the bug.
    expect(await children(t.shortId), `iteration ${i}`).toHaveLength(2);
    expect([a.status, b.status].sort(), `iteration ${i}`).toEqual([200, 409]);
  }
});

// The loser's patch is refused WHOLE, so nothing it carried was quietly dropped either. This is why
// the loser gets a 409 and not a 200 naming the real state: the row does end up in_review, so a 200
// would be true about the status and false about everything else in the body.
test('the loser of the race applied nothing at all, not even the fields that had no conflict', async () => {
  const p = await project();
  const t = await task(p.prefix, { lanes: ['code-review'] });
  await req('PATCH', `/tasks/${t.shortId}`, { status: 'in_progress' });

  const [a, b] = await Promise.all([
    req('PATCH', `/tasks/${t.shortId}`, { status: 'in_review', notes: 'first', addCommit: 'aaaaaaa' }),
    req('PATCH', `/tasks/${t.shortId}`, { status: 'in_review', notes: 'second', addCommit: 'bbbbbbb' }),
  ]);
  expect([a.status, b.status].sort()).toEqual([200, 409]);
  const winner = a.status === 200 ? 'first' : 'second';
  const row = await req<{ notes: string; commits: string[] }>('GET', `/tasks/${t.shortId}`);
  expect(row.body.notes).toBe(winner);                       // the loser's notes never landed
  expect(row.body.commits).toEqual([winner === 'first' ? 'aaaaaaa' : 'bbbbbbb']); // nor its commit
  expect((a.status === 409 ? a : b).error).toContain(t.shortId);
});

// ---------- 3. a feedback row is attributed to somebody the project knows ----------

const ROSTERED = {
  stakeholders: [{ name: 'Raj', role: 'owner' }, { name: 'Teammate' }],
  agents: [{ name: 'staff-engineer', kind: 'lane-manager', brief: 'reviews code' }],
};

test('with a stakeholder list, a filing with no author is refused instead of becoming "unknown"', async () => {
  const p = await project(ROSTERED);
  const filed = await req('POST', '/feedback', { project: p.prefix, body: 'the column folds' });
  expect(filed.status).toBe(400);
  expect(filed.error).toContain('author (non-empty string) required');
  expect(filed.error).toContain('Raj');
});

test('an author nobody on the project has heard of is refused, and the 409 lists who it knows', async () => {
  const p = await project(ROSTERED);
  const filed = await req('POST', '/feedback', { project: p.prefix, author: 'probe', body: 'test test' });
  expect(filed.status).toBe(400);
  expect(filed.error).toContain('"probe" is not on');
  expect(filed.error).toContain('stakeholders [Raj, Teammate]');
  expect(filed.error).toContain('agents [staff-engineer]');
});

test('a name is a lookup key, so it matches trimmed and case-folded, and an agent counts', async () => {
  const p = await project(ROSTERED);
  const person = await req<{ author: string }>('POST', '/feedback', { project: p.prefix, author: '  rAj ', body: 'padded' });
  expect(person.status).toBe(200);
  expect(person.body.author).toBe('rAj'); // stored trimmed, like every other identity key

  const agent = await req('POST', '/feedback', { project: p.prefix, author: 'staff-engineer', authorType: 'agent', body: 'lane finding' });
  expect(agent.status).toBe(200);
});

test('with NEITHER list there is nothing to check a name against, so filing stays open', async () => {
  const p = await project();
  const filed = await req<{ author: string }>('POST', '/feedback', { project: p.prefix, body: 'no roster here' });
  expect(filed.status).toBe(200);
  expect(filed.body.author).toBe('unknown');
});

// ---------- 3b. DAR-257: agents alone are a roster ----------
//
// The gate matched against stakeholders ∪ agents from the day it was written, but switched ON off
// the stakeholder half alone. So the one project shape made entirely of agents — REV on the live
// board — was ungated end to end: `probe` filed as `probe`, no author filed as `unknown`, which is
// the exact litter the gate exists to stop. Raj's call is that agents file and others do not.
const AGENTS_ONLY = {
  agents: [
    { name: 'orchestrator', kind: 'lane-manager', brief: 'runs the board' },
    { name: 'review-agent', kind: 'lane-manager', brief: 'reviews' },
  ],
};

test('an agent files on a project that has agents and no stakeholders', async () => {
  const p = await project(AGENTS_ONLY);
  const filed = await req<{ author: string }>('POST', '/feedback', { project: p.prefix, author: 'review-agent', authorType: 'agent', body: 'lane finding' });
  expect(filed.status).toBe(200);
  expect(filed.body.author).toBe('review-agent');
});

test('probe litter is refused on an agent-only project, where it used to sail through', async () => {
  const p = await project(AGENTS_ONLY);
  const filed = await req('POST', '/feedback', { project: p.prefix, author: 'probe', body: 'test test' });
  expect(filed.status).toBe(400);
  expect(filed.error).toContain('"probe" is not on');

  // and the no-author door, which stored the literal "unknown"
  const anon = await req('POST', '/feedback', { project: p.prefix, body: 'test test' });
  expect(anon.status).toBe(400);
  expect(anon.error).toContain('author (non-empty string) required');
});

// the roster sentence is built from both halves; an empty stakeholder half must not leave a dangling
// conjunction or a leading blank behind ("knows  and agents [...]")
test('the roster sentence reads correctly with an empty stakeholder half', async () => {
  const p = await project(AGENTS_ONLY);
  const filed = await req('POST', '/feedback', { project: p.prefix, author: 'probe', body: 'x' });
  expect(filed.error).toContain(`${p.prefix} knows agents [orchestrator, review-agent]`);
  expect(filed.error).not.toContain('knows  ');
  expect(filed.error).not.toContain(' and agents');
  expect(filed.error).not.toContain('stakeholders []');
});

// str() alone cannot tell a WRONG type from an ABSENT field, so {author: 42} used to read as "no
// author sent": on a gated project it hit the "required" sentence about a field that was, in fact,
// sent, and on an ungated project it sailed all the way through to being stored as the literal
// "unknown" under a 200, the exact probe-litter signature this whole area exists to stop.
test('author has to be a string; a wrong type is named as a wrong type, on gated and ungated projects alike', async () => {
  const gated = await project(ROSTERED);
  const badGated = await req('POST', '/feedback', { project: gated.prefix, author: 42, body: 'x' });
  expect(badGated.status).toBe(400);
  expect(badGated.error).toContain('author must be a string');

  const ungated = await project();
  const badUngated = await req('POST', '/feedback', { project: ungated.prefix, author: 42, body: 'x' });
  expect(badUngated.status).toBe(400);
  expect(badUngated.error).toContain('author must be a string');
});

// ---------- 4. the PATCH answers with the row as it stands AFTER the hooks ----------

test('a self-advancing patch reports the status it landed on, not the one it passed through', async () => {
  const p = await project();
  const t = await task(p.prefix, { lanes: [] }); // explicitly no lanes: entering review ships it
  const moved = await req<{ status: string }>('PATCH', `/tasks/${t.shortId}`, { status: 'in_review' });
  expect(moved.status).toBe(200);
  expect(await statusOf(t.shortId)).toBe('done');
  expect(moved.body.status).toBe('done'); // was 'in_review': the reply predated the hook that shipped it
});

// ---------- an echo is not an edit, and neither is a false equal ----------

test('a reordered array is a change, not an echo', () => {
  expect(echoedUnchanged(['darbar', 'skills'], ['skills', 'darbar'])).toBe(false);
  expect(echoedUnchanged(
    [{ lane: 'qa' }, { lane: 'code-review' }],
    [{ lane: 'code-review' }, { lane: 'qa' }],
  )).toBe(false);
});

test('whitespace is content, so a value that only differs by it is still a change', () => {
  expect(echoedUnchanged('Darbar Platform ', 'Darbar Platform')).toBe(false);
  expect(echoedUnchanged(' darbar', 'darbar')).toBe(false);
  expect(echoedUnchanged('two\n\nlines', 'two\nlines')).toBe(false);
  expect(echoedUnchanged([' darbar'], ['darbar'])).toBe(false);
});

test('the emptiness rule stops at emptiness: a typed value is never an echo of nothing', () => {
  expect(echoedUnchanged(null, undefined)).toBe(true);   // absent and null say the same thing
  expect(echoedUnchanged([], null)).toBe(true);
  expect(echoedUnchanged('', null)).toBe(false);         // an empty string is something somebody typed
  expect(echoedUnchanged([''], [])).toBe(false);
  expect(echoedUnchanged({}, null)).toBe(false);         // an empty object is not the empty list
  expect(echoedUnchanged(0, null)).toBe(false);
  expect(echoedUnchanged(false, null)).toBe(false);
});

// ---------- DAR-254: the SSE tick carries the change, and the board patches itself ----------
//
// The client half of this is in board.html, which has no test rig and no DOM here — so the reducer
// is written as a self-contained block between two markers and LIFTED VERBATIM below. What runs in
// these tests is the same text the browser runs, driven by frames taken off the real SSE route
// through the real Hono app. What is NOT tested here is anything that needs a browser: that render()
// paints the patched state, that EventSource delivers, that the debounce feels right. Not observed
// in a browser.
const BOARD_HTML = await Bun.file(new URL('../web/board.html', import.meta.url)).text();
const R_BEGIN = '// ---- delta reducer: extracted by engine.test.ts, keep self-contained ----';
const R_END = '// ---- end delta reducer ----';
// a renamed marker must be a loud failure, not a quietly empty extraction that passes everything
if (!BOARD_HTML.includes(R_BEGIN) || !BOARD_HTML.includes(R_END)) {
  throw new Error('board.html no longer carries the delta-reducer markers — these tests would be testing nothing');
}
const REDUCER = BOARD_HTML.slice(BOARD_HTML.indexOf(R_BEGIN) + R_BEGIN.length, BOARD_HTML.indexOf(R_END));
type Client = { data: { tasks: unknown[]; feedback: unknown[]; events: unknown[]; projectSig: string } | null; epoch: string | null; rev: number };
const { applyDelta, rowSig } = new Function(`"use strict";${REDUCER};return { applyDelta, rowSig };`)() as {
  applyDelta: (state: Client, frame: unknown) => boolean;
  rowSig: (rows: unknown[], stamp: (r: never) => string) => string;
};

// mirrors DELTA_SKEW_MS in api.ts: the window a delta keeps open behind itself
const DELTA_SKEW_MS = 250;

type Frame = Record<string, unknown>;
/** a connected board: the real SSE route, so the server counts it as live and builds real deltas */
async function watch(capId: string) {
  const res = await api.request(`/p/${capId}/stream`);
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const frames: Frame[] = [];
  const dec = new TextDecoder();
  let buf = '';
  const pump = (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (chunk.includes('event: ping')) continue; // keepalive, not a change
          const data = chunk.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
          if (data) frames.push(JSON.parse(data) as Frame);
        }
      }
    } catch { /* cancelled at the end of the test */ }
  })();
  // the frames are written asynchronously, so settle() is how a test waits for a burst to arrive
  const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 5)); };
  await settle(); // let the subscription register before the test writes anything
  return { frames, settle, close: async () => { await reader.cancel().catch(() => {}); await pump; } };
}

const snapshot = async (capId: string) => (await req<Client['data'] & Record<string, unknown>>('GET', `/p/${capId}`)).body;
const asClient = (payload: Record<string, unknown>): Client =>
  ({ data: payload as Client['data'], epoch: payload.epoch as string, rev: payload.rev as number });

test('a board that patches every tick ends up holding exactly what a full refetch would have given it', async () => {
  const p = await project();
  const t = await task(p.prefix, { lanes: ['code-review', 'qa'] });
  const w = await watch(p.capId);
  const client = asClient(await snapshot(p.capId));

  // one of everything the board has to survive: a field edit, a status move that spawns rows,
  // a row created out of nowhere, a feedback filing, and a child closing under its parent
  await req('PATCH', `/tasks/${t.shortId}`, { notes: 'picked up', assignee: 'builder' });
  await req('PATCH', `/tasks/${t.shortId}`, { status: 'in_review' });
  await task(p.prefix, { title: 'filed while the board was watching' });
  const fb = await feedback({ taskRef: t.shortId, body: 'a finding' });
  const kids = await children(t.shortId);
  await req('PATCH', `/tasks/${kids[0]!.shortId}`, { status: 'done' });
  await req('PATCH', `/feedback/${fb.shortId}`, { status: 'rejected', resolution: 'works as intended' });
  await w.settle();

  expect(w.frames.length).toBeGreaterThan(5);
  for (const f of w.frames) expect(applyDelta(client, f), `frame rev ${f.rev}`).toBe(true);

  const fresh = await snapshot(p.capId);
  expect(client.data!.tasks).toEqual(fresh.tasks!);       // statuses, spawned children, edits, order
  expect(client.data!.feedback).toEqual(fresh.feedback!);
  // events are compared as a SET: several land in the same millisecond and their order within one
  // millisecond is not defined on either side (mongo breaks the tie by natural order, the board by
  // insertion). The digest on the frame is order-independent for the same reason.
  const ids = (rows: unknown[]) => (rows as { _id: string }[]).map((e) => e._id).sort();
  expect(ids(client.data!.events)).toEqual(ids(fresh.events as unknown[]));
  expect(client.rev).toBe(fresh.rev as number);
  await w.close();
});

test('a delta is a fraction of the refetch it replaces, and does not carry the whole project', async () => {
  const p = await project();
  for (let i = 0; i < 40; i++) await task(p.prefix, { title: `row ${i}`, description: 'x'.repeat(400) });
  const w = await watch(p.capId);
  const full = JSON.stringify(await snapshot(p.capId)).length;

  // The FIRST delta for a project this process has not ticked yet asks for a 60s window, so on a
  // board seeded seconds ago it legitimately carries everything just created; the tick after that
  // still carries whatever falls inside the overlap BEHIND it. Steady state — one row moving on a
  // board that has been sitting there — is what a board actually lives on, so the seed is left to
  // fall out of the window first and that is what is measured.
  await new Promise((r) => setTimeout(r, DELTA_SKEW_MS * 2));
  await task(p.prefix, { title: 'opens the window' });
  await w.settle();
  const t = await task(p.prefix, { title: 'the one that moved' });
  await w.settle();
  const frame = w.frames[w.frames.length - 1]!;
  const size = JSON.stringify(frame).length;

  // The row that moved, plus whatever the 250ms overlap behind the previous tick re-sends — which
  // in steady state is that previous tick's own row and nothing else. That re-send is the price of
  // not refetching every time a stamp and an emit interleave across two concurrent writers, and it
  // is a row or two rather than a project. What matters is the scaling: this number does not grow
  // with the 42 rows sitting on the board, and the refetch it replaces is all of them.
  const rows = frame.tasks as { shortId: string }[];
  expect(rows.length).toBeLessThanOrEqual(3);
  expect(rows.map((r) => r.shortId)).toContain(t.shortId);
  expect(frame.project).toBeUndefined();               // fingerprinted, never sent
  expect(size).toBeLessThan(full / 8);
  console.log(`delta ${size}B (${rows.length} row(s)) vs full refetch ${full}B on a 42-task project`);
  await w.close();
});

// Each of these is a way the delta can be wrong, and every one of them has to end at load(), which
// is the behaviour that shipped before this change. false is the only safe answer to a doubt.
test('every doubt the board can have about a frame ends in a refetch, not in a patched board', async () => {
  const p = await project();
  await task(p.prefix);
  const w = await watch(p.capId);
  const base = await snapshot(p.capId);
  await req('POST', '/tasks', { project: p.prefix, title: 'moved the board on' });
  await w.settle();
  const good = w.frames[w.frames.length - 1]!;
  const fresh = () => asClient(structuredClone(base));

  expect(applyDelta(fresh(), good)).toBe(true); // the control: this frame IS applicable

  expect(applyDelta(fresh(), null)).toBe(false);                                   // unparseable
  expect(applyDelta(fresh(), { kind: 'event', text: 'an older server' })).toBe(false); // the old bell
  expect(applyDelta(fresh(), { ...good, epoch: 'another-process' })).toBe(false);   // restarted server
  expect(applyDelta(fresh(), { ...good, prev: (good.prev as number) + 1 })).toBe(false); // a tick we missed
  expect(applyDelta(fresh(), { ...good, projectSig: 'edited' })).toBe(false);       // project changed
  expect(applyDelta(fresh(), { ...good, resync: true })).toBe(false);               // flood
  expect(applyDelta(fresh(), { ...good, tasks: [] })).toBe(false);                  // row dropped in transit
  expect(applyDelta(fresh(), { ...good, sig: { ...(good.sig as object), tasks: 'x' } })).toBe(false); // digest disagrees
  expect(applyDelta({ data: null, epoch: null, rev: 0 }, good)).toBe(false);        // no snapshot yet

  // a frame that is BEHIND the board's own snapshot is dropped rather than applied: it would
  // otherwise overwrite fresh rows with the older copies it was built from, and its digest — built
  // from those same older rows — would agree that the result was correct
  const ahead = fresh();
  ahead.rev = (good.rev as number) + 5;
  expect(applyDelta(ahead, good)).toBe(true);      // "already inside our snapshot"
  expect(ahead.rev).toBe((good.rev as number) + 5); // and it did not roll the board backwards
  await w.close();
});

// The digest is order-INDEPENDENT by design, so it cannot catch this one: a board that holds the
// right rows in the wrong order passes every check on the frame and still does not look like the
// board a refetch would have drawn — cards out of sequence inside a column, the activity feed out of
// time order. The reducer sorts the way /api/p/:capId sorts, and this is what says so. Frames here
// are hand-built, deliberately: the server sends rows in order, so only a synthetic frame can put
// the reducer in front of the case where it does not.
test('rows land in the order a refetch would have given them, whatever order they arrive in', () => {
  const stamp = (r: { updatedAt?: string }) => String(r.updatedAt ?? '');
  const task = (n: number) => ({ _id: `t${n}`, createdAt: `2026-08-1${n}T00:00:00.000Z`, updatedAt: `u${n}` });
  const fb = (n: number) => ({ _id: `f${n}`, createdAt: `2026-08-1${n}T00:00:00.000Z`, updatedAt: `u${n}` });
  const ev = (n: number) => ({ _id: `e${n}`, at: `2026-08-1${n}T00:00:00.000Z` });
  const state: Client = {
    epoch: 'e', rev: 4,
    data: { projectSig: 'p', tasks: [task(1), task(3)], feedback: [fb(3), fb(1)], events: [ev(3), ev(1)] } as Client['data'],
  };
  // newest first in the frame, oldest last: the reverse of how tasks are kept, and the wrong order
  // for events if they were merely appended
  const frame = {
    kind: 'delta', epoch: 'e', rev: 5, prev: 4, projectSig: 'p', resync: false, eventsMax: 50,
    tasks: [task(4), task(2)], feedback: [fb(2), fb(4)], events: [ev(2), ev(4)],
    sig: {
      tasks: rowSig([task(1), task(2), task(3), task(4)], stamp as never),
      feedback: rowSig([fb(1), fb(2), fb(3), fb(4)], stamp as never),
      events: rowSig([ev(1), ev(2), ev(3), ev(4)], (() => '') as never),
    },
  };
  expect(applyDelta(state, frame)).toBe(true);
  const ids = (rows: unknown[]) => (rows as { _id: string }[]).map((r) => r._id);
  expect(ids(state.data!.tasks)).toEqual(['t1', 't2', 't3', 't4']);      // createdAt ascending
  expect(ids(state.data!.feedback)).toEqual(['f4', 'f3', 'f2', 'f1']);   // createdAt descending
  expect(ids(state.data!.events)).toEqual(['e4', 'e3', 'e2', 'e1']);     // at descending
});

// and the same list, cut to the length the board payload would have carried
test('the event list is trimmed to what a refetch would carry, not grown without limit', () => {
  const stamp = (() => '') as never;
  const ev = (n: number) => ({ _id: `e${n}`, at: new Date(Date.UTC(2026, 7, 1) + n * 1000).toISOString() });
  const held = [ev(3), ev(2), ev(1)];
  const state: Client = { epoch: 'e', rev: 1, data: { projectSig: 'p', tasks: [], feedback: [], events: held } as Client['data'] };
  const frame = {
    kind: 'delta', epoch: 'e', rev: 2, prev: 1, projectSig: 'p', resync: false, eventsMax: 2,
    tasks: [], feedback: [], events: [ev(4)],
    sig: { tasks: rowSig([], stamp), feedback: rowSig([], stamp), events: rowSig([ev(4), ev(3)], stamp) },
  };
  expect(applyDelta(state, frame)).toBe(true);
  expect((state.data!.events as { _id: string }[]).map((e) => e._id)).toEqual(['e4', 'e3']);
});

// The one case where a delta would be bigger than the refetch it saves. A board connecting to a
// project that has just been seeded asks its first tick for a 60s window, and a seeded task tree is
// hundreds of rows: sending them one frame at a time is worse than the load() it is trying to avoid,
// so past DELTA_MAX_ROWS the server stops trying and says so, and the board does the plain thing.
test('a burst bigger than a delta is worth carrying is announced, not streamed row by row', async () => {
  const p = await project();
  for (let i = 0; i < 101; i++) await task(p.prefix, { title: `seeded ${i}` }); // nobody watching yet
  const w = await watch(p.capId);
  const client = asClient(await snapshot(p.capId)); // the board loads, THEN the tick arrives
  await req('POST', '/tasks', { project: p.prefix, title: 'the tick that finds them all' });
  await w.settle();

  const frame = w.frames[w.frames.length - 1]!;
  expect(frame.resync).toBe(true);
  expect(frame.tasks).toEqual([]);  // and it does not carry them anyway
  expect(applyDelta(client, frame)).toBe(false); // which the board answers with a full refetch
  await w.close();
});

test('a tick with nothing connected costs nothing: no board, no delta', async () => {
  const p = await project();
  const t = await task(p.prefix);
  // no watcher: the frame is the old bell, which a board would answer with a full refetch anyway
  await req('PATCH', `/tasks/${t.shortId}`, { status: 'in_progress' });
  const w = await watch(p.capId);
  await req('PATCH', `/tasks/${t.shortId}`, { status: 'blocked', blocker: 'waiting on review' });
  await w.settle();
  expect(w.frames.every((f) => f.kind === 'delta')).toBe(true); // everything AFTER it connected is a delta
  expect(w.frames.length).toBeGreaterThan(0);
  await w.close();
});

// ---------- archiving a finished project ----------
//
// The gate here is not really about a flag, it is about the doctrine. This board's standing rule is
// that it carries ALL pending work, and an empty todo column while work is pending is a bug. An
// archive with open rows would satisfy every check on that board by making the work invisible, which
// is the doctrine defeated in one write rather than met. So the honest answers (cancel them and say
// why, or leave them open and record how many) are what is pinned below, along with the two silent
// failures the vocabulary exists to stop: an archive word sent with the wrong TYPE, and an archive
// word MISSPELLED so it never arrives at all.

const projRow = async (ref: string) => (await req<{ archivedAt: string | null; archiveReason: string | null; archivedOpenRows: number | null }>('GET', `/projects/${ref}/context`)).body;
const listPrefixes = async (q = '') =>
  (await req<unknown>('GET', `/projects${q}`)).body as unknown as Array<{ prefix: string; archivedAt: string | null }>;

test('a project with open rows cannot be archived silently: the 409 counts them and names both ways out', async () => {
  const p = await project();
  const a = await task(p.prefix, { title: 'did not make it' });
  const b = await task(p.prefix, { title: 'also open' });
  const shipped = await task(p.prefix, { lanes: [] });
  await req('PATCH', `/tasks/${shipped.shortId}`, { status: 'done' });

  const r = await req('PATCH', `/projects/${p.prefix}`, { archived: true });
  expect(r.status).toBe(409);
  expect(r.error).toContain('2 open row(s)');
  expect(r.error).toContain(a.shortId);
  expect(r.error).toContain(b.shortId);
  expect(r.error).toContain('"cancelOpen": true');
  expect(r.error).toContain('"force": true');
  // and it did not half-archive on the way to refusing
  expect((await projRow(p.prefix)).archivedAt).toBeNull();
});

test('a project with nothing open archives on its own, and the timestamp is what it records', async () => {
  const p = await project();
  const t = await task(p.prefix, { lanes: [] });
  await req('PATCH', `/tasks/${t.shortId}`, { status: 'done' });

  const r = await req('PATCH', `/projects/${p.prefix}`, { archived: true, archiveReason: 'round 2 shipped' });
  expect(r.status).toBe(200);
  const row = await projRow(p.prefix);
  expect(typeof row.archivedAt).toBe('string');
  expect(Number.isNaN(Date.parse(row.archivedAt!))).toBe(false);
  expect(row.archiveReason).toBe('round 2 shipped');
  expect(row.archivedOpenRows).toBe(0);
});

test('cancelOpen closes the open rows AND writes onto each one why it was cancelled', async () => {
  const p = await project();
  const open = await task(p.prefix, { title: 'never staffed' });
  const withNotes = await task(p.prefix, { title: 'half done', notes: 'builder got as far as the parser' });
  const done = await task(p.prefix, { lanes: [] });
  await req('PATCH', `/tasks/${done.shortId}`, { status: 'done' });

  const r = await req('PATCH', `/projects/${p.prefix}`, { archived: true, cancelOpen: true, archiveReason: 'round 2 is over' });
  expect(r.status).toBe(200);

  for (const ref of [open.shortId, withNotes.shortId]) {
    const t = (await req<{ status: string; notes: string }>('GET', `/tasks/${ref}`)).body;
    expect(t.status).toBe('cancelled');
    // the WHY, on the row itself: which project ended it, and when
    expect(t.notes).toContain(`${p.prefix} was archived on`);
    expect(t.notes).toContain('did not ship');
    expect(t.notes).toContain('round 2 is over');
    expect(t.notes).toContain(new Date().toISOString().slice(0, 10));
  }
  // a builder's own notes are the other half of the story, so the reason is APPENDED, never over it
  const kept = (await req<{ notes: string }>('GET', `/tasks/${withNotes.shortId}`)).body;
  expect(kept.notes).toContain('builder got as far as the parser');
  // a row that was already done is not re-touched by the cascade
  expect((await req<{ status: string; notes: string }>('GET', `/tasks/${done.shortId}`)).body.status).toBe('done');
  expect((await req<{ notes: string }>('GET', `/tasks/${done.shortId}`)).body.notes).toBe('');
  // nothing was left open, so nothing was left behind
  expect((await projRow(p.prefix)).archivedOpenRows).toBe(0);
});

test('cancelOpen reaches review children too, since an open lane is open work', async () => {
  const p = await project();
  const t = await task(p.prefix, { lanes: ['code-review', 'qa'] });
  await req('PATCH', `/tasks/${t.shortId}`, { status: 'in_review' });
  const kids = await children(t.shortId);
  expect(kids).toHaveLength(2);

  const r = await req('PATCH', `/projects/${p.prefix}`, { archived: true, cancelOpen: true });
  expect(r.status).toBe(200);
  for (const k of kids) {
    expect((await req<{ status: string }>('GET', `/tasks/${k.shortId}`)).body.status).toBe('cancelled');
  }
  expect(await statusOf(t.shortId)).toBe('cancelled');
});

test('force archives and LEAVES the rows open, and the count of what was left is on the project', async () => {
  const p = await project();
  const a = await task(p.prefix);
  const b = await task(p.prefix);

  const r = await req('PATCH', `/projects/${p.prefix}`, { archived: true, force: true, archiveReason: 'work continues on MRFIII' });
  expect(r.status).toBe(200);

  // still open, untouched, still on their board
  expect(await statusOf(a.shortId)).toBe('todo');
  expect(await statusOf(b.shortId)).toBe('todo');
  expect((await req<{ notes: string }>('GET', `/tasks/${a.shortId}`)).body.notes).toBe('');

  const row = await projRow(p.prefix);
  expect(row.archivedOpenRows).toBe(2);
  // the human's sentence is stored as they wrote it and is not rewritten to carry the count
  expect(row.archiveReason).toBe('work continues on MRFIII');
});

test('cancelOpen and force are opposite answers, so sending both is refused rather than one winning', async () => {
  const p = await project();
  const t = await task(p.prefix);
  const r = await req('PATCH', `/projects/${p.prefix}`, { archived: true, cancelOpen: true, force: true });
  expect(r.status).toBe(400);
  expect(r.error).toContain('opposite answers');
  expect(await statusOf(t.shortId)).toBe('todo');
  expect((await projRow(p.prefix)).archivedAt).toBeNull();
});

test('unarchiving clears the timestamp, the reason and the count', async () => {
  const p = await project();
  await req('PATCH', `/projects/${p.prefix}`, { archived: true, force: true, archiveReason: 'shipped' });
  expect((await projRow(p.prefix)).archivedAt).not.toBeNull();

  const r = await req('PATCH', `/projects/${p.prefix}`, { archived: false });
  expect(r.status).toBe(200);
  const row = await projRow(p.prefix);
  expect(row.archivedAt).toBeNull();
  expect(row.archiveReason).toBeNull();
  expect(row.archivedOpenRows).toBeNull();
  // and it is back in the default list
  expect((await listPrefixes()).map((x) => x.prefix)).toContain(p.prefix);
});

test('rows a cancelOpen archive closed are NOT resurrected by unarchiving, because that was a decision', async () => {
  const p = await project();
  const t = await task(p.prefix);
  await req('PATCH', `/projects/${p.prefix}`, { archived: true, cancelOpen: true });
  await req('PATCH', `/projects/${p.prefix}`, { archived: false });
  expect(await statusOf(t.shortId)).toBe('cancelled');
});

test('re-archiving is refused, because re-stamping the date destroys the one fact the field is for', async () => {
  const p = await project();
  await req('PATCH', `/projects/${p.prefix}`, { archived: true, archiveReason: 'first ending' });
  const first = (await projRow(p.prefix)).archivedAt;

  const r = await req('PATCH', `/projects/${p.prefix}`, { archived: true, archiveReason: 'second ending' });
  expect(r.status).toBe(409);
  expect(r.error).toContain('already archived');
  // The STATUS alone does not pin this guard, and finding that out is the point of the assertions
  // below. The conditional write further down refuses a second archive by itself (its claim filter
  // matches only a not-archived project), so deleting the read guard still produces a 409. What it
  // produces is the RACE sentence: "another write settled that while this one was in flight", which
  // is simply false about somebody archiving the same finished project twice by hand, and it tells
  // them to re-read and retry rather than telling them the date they would have destroyed. So what
  // this guard owes is the right explanation, and that is what is pinned.
  expect(r.error).toContain('re-stamp');
  expect(r.error).toContain('{"archived": false}');
  expect(r.error).not.toContain('another write settled');
  const after = await projRow(p.prefix);
  expect(after.archivedAt).toBe(first!);
  expect(after.archiveReason).toBe('first ending');
});

test('unarchiving a project that was never archived is refused rather than answering 200 about nothing', async () => {
  const p = await project();
  const r = await req('PATCH', `/projects/${p.prefix}`, { archived: false });
  expect(r.status).toBe(400);
  expect(r.error).toContain('not archived');
});

// ---------- the silent-drop guards on the archive words ----------

test('an archive word sent with the wrong type is a 400, not a non-boolean read as "not archived"', async () => {
  const p = await project();
  const r = await req('PATCH', `/projects/${p.prefix}`, { archived: 'true' });
  expect(r.status).toBe(400);
  expect(r.error).toContain('archived must be true or false');
  expect((await projRow(p.prefix)).archivedAt).toBeNull();

  const f = await req('PATCH', `/projects/${p.prefix}`, { archived: true, force: 'yes' });
  expect(f.status).toBe(400);
  expect(f.error).toContain('force must be true or false');
  expect((await projRow(p.prefix)).archivedAt).toBeNull();
});

test('a misspelled cancelOpen does not quietly mean "no": the row survives and the gate still fires', async () => {
  const p = await project();
  const t = await task(p.prefix);
  const r = await req('PATCH', `/projects/${p.prefix}`, { archived: true, cancelOpne: true });
  expect(r.status).toBe(409);
  expect(r.error).toContain('1 open row(s)');
  // the thing that must never happen: archived anyway, with the row swallowed
  expect((await projRow(p.prefix)).archivedAt).toBeNull();
  expect(await statusOf(t.shortId)).toBe('todo');
});

test('the archive modifiers mean nothing without the act, so they are refused instead of dropped', async () => {
  const p = await project();
  for (const body of [{ archiveReason: 'over' }, { cancelOpen: true }, { force: true }, { charter: 'x', cancelOpen: true }]) {
    const r = await req('PATCH', `/projects/${p.prefix}`, body);
    expect(r.status).toBe(400);
    expect(r.error).toContain('not settable here');
  }
  // and the charter that rode along with the refused word did NOT apply
  expect((await req<{ charter: string }>('GET', `/projects/${p.prefix}`)).body.charter).toBe('');
});

test('archivedAt is server-owned, so a hand-set timestamp is refused rather than believed', async () => {
  const p = await project();
  for (const k of ['archivedAt', 'archivedOpenRows']) {
    const r = await req('PATCH', `/projects/${p.prefix}`, { [k]: k === 'archivedAt' ? new Date().toISOString() : 5 });
    expect(r.status).toBe(400);
    expect(r.error).toContain(k);
  }
});

test('archiving is not something a project can be CREATED as, and the create route says so', async () => {
  const r = await req('POST', '/projects', { name: 'born finished', prefix: 'ZZA', archived: true });
  expect(r.status).toBe(400);
  expect(r.error).toContain('archived');
  expect(r.error).toContain('PATCH /api/projects/:ref');
});

test('unarchiving is not the door for the archive modifiers either', async () => {
  const p = await project();
  await req('PATCH', `/projects/${p.prefix}`, { archived: true });
  for (const body of [{ archived: false, cancelOpen: true }, { archived: false, force: true }, { archived: false, archiveReason: 'x' }]) {
    const r = await req('PATCH', `/projects/${p.prefix}`, body);
    expect(r.status).toBe(400);
    expect(r.error).toContain('not settable here');
  }
  expect((await projRow(p.prefix)).archivedAt).not.toBeNull(); // and none of them unarchived it either
});

// ---------- what GET /projects lists by default ----------

test('the project list leaves archived projects out by default, and every row says which it is', async () => {
  const live = await project();
  const gone = await project();
  await req('PATCH', `/projects/${gone.prefix}`, { archived: true, archiveReason: 'shipped' });

  const def = await listPrefixes();
  expect(def.map((p) => p.prefix)).toEqual([live.prefix]);
  // present on every row, whichever query was sent, so a consumer never has to guess
  expect(def[0]!.archivedAt).toBeNull();

  const only = await listPrefixes('?archived=true');
  expect(only.map((p) => p.prefix)).toEqual([gone.prefix]);
  expect(typeof only[0]!.archivedAt).toBe('string');

  const both = await listPrefixes('?archived=all');
  expect(both.map((p) => p.prefix).sort()).toEqual([live.prefix, gone.prefix].sort());
  expect(await listPrefixes('?archived=false')).toEqual(def);
});

test('a query value the list does not understand is a 400, never a quiet fallback to the default', async () => {
  const gone = await project();
  await req('PATCH', `/projects/${gone.prefix}`, { archived: true });
  const r = await req('GET', '/projects?archived=1');
  expect(r.status).toBe(400);
  expect(r.error).toContain('archived must be one of false, true, all');
});

// ---------- 2d. DAR-259: the two remaining read-then-write windows of the DAR-256 class ----------
//
// Both were LOCATED by reading code while DAR-256 was being fixed, never observed. Reproduction came
// first here, and only the window that actually reproduced was fixed — window 1 below is kept as a
// PROBE, not as a guard on a fix, because hardening against something unobserved is exactly the
// blast radius this project refuses to take on. Same method as 2c: Promise.all against the real
// routes on the real driver, repeated, because the interleaving is what is under test.
const RACES_259 = 40;

const eventsOf = async (prefix: string) =>
  (await req<{ text: string }[]>('GET', `/projects/${prefix}/events?limit=50`)).body;

// ---------- window 1: spawnReviews off the CREATE path — NOT REPRODUCED, NOT FIXED ----------
//
// Filed as "POST /tasks with status in_review reaches the same spawn with its own read-then-write".
// It does reach the same spawn, but there is no second racer that can reach it for the SAME row:
// every create inserts a freshly generated _id, so concurrent creates run spawnReviews against N
// different parents, and openReviewCount is per-parent. The only other caller is the PATCH
// entering-review path, which needs the row to leave in_review and come back — and no client can
// address the row at all until the create has returned its shortId.
//
// Probed anyway rather than argued away: 8 concurrent creates × 120 iterations on each of four
// shapes (explicit lanes, all lanes, lanes:[] which routes into maybeAdvanceParent, and a create
// followed by an immediate concurrent re-entry), ~3,800 creates, zero doubled rounds. The cheap
// shape is kept here so the claim stays checked; the source is untouched.
test('DAR-259/1 probe: concurrent creates at in_review each get their own single round', async () => {
  for (let i = 0; i < RACES_259; i++) {
    await reset();
    const p = await project();
    const made = await Promise.all(
      Array.from({ length: 8 }, () =>
        req<{ shortId: string }>('POST', '/tasks', {
          project: p.prefix, title: 'retro-init at in_review', status: 'in_review', lanes: ['code-review', 'qa'],
        })),
    );
    for (const r of made) {
      expect(r.status, `iteration ${i}`).toBe(200);
      // two lanes selected => exactly two children on that row. Four is a doubled round.
      expect(await children(r.body.shortId), `iteration ${i} ${r.body.shortId}`).toHaveLength(2);
    }
  }
});

// ---------- window 2: maybeAdvanceParent — REPRODUCED on the first race, FIXED ----------
//
// Two review children closing together both read the parent as in_review and both read zero open
// children before either writes, so both advance it. The status write is idempotent, which is why
// this never showed up as a wrong status; what is NOT idempotent is everything hanging off it.
// Before the fix this failed on iteration 0 with two "auto-advanced → done" events on one row.
test('DAR-259/2: two review children closing at once advance the parent exactly ONCE', async () => {
  for (let i = 0; i < RACES_259; i++) {
    await reset();
    const p = await project();
    const t = await task(p.prefix, { lanes: ['code-review', 'qa'] });
    await req('PATCH', `/tasks/${t.shortId}`, { status: 'in_progress' });
    await req('PATCH', `/tasks/${t.shortId}`, { status: 'in_review' });
    const kids = await children(t.shortId);
    expect(kids).toHaveLength(2);

    const closes = await Promise.all(kids.map((k) => req('PATCH', `/tasks/${k.shortId}`, { status: 'done' })));

    // both closers still succeed: the loser of the advance race lost nothing of its OWN request
    for (const r of closes) expect(r.status, `iteration ${i}`).toBe(200);
    expect(await statusOf(t.shortId), `iteration ${i}`).toBe('done');
    const advanced = (await eventsOf(p.prefix)).filter((e) => e.text.includes('auto-advanced'));
    expect(advanced, `iteration ${i}: ${advanced.map((e) => e.text).join(' | ')}`).toHaveLength(1);
  }
});

// The damage the duplicate advance actually does is in the cascade, not the status: resolvePromoted-
// Feedback runs once per racer, resolving the same promoted row twice and posting the resolution
// into the real Slack thread once per racer. Pinned separately because it is the reason this window
// was worth fixing at all — the status alone would have been a genuine no-op.
test('DAR-259/2: the promoted-feedback cascade runs once, not once per closing lane', async () => {
  for (let i = 0; i < RACES_259; i++) {
    await reset();
    const p = await project();
    const t = await task(p.prefix, { lanes: ['code-review', 'qa'] });
    const fb = await feedback({ project: p.prefix });
    await req('PATCH', `/feedback/${fb.shortId}`, { status: 'accepted' });
    await req('PATCH', `/feedback/${fb.shortId}`, { resolvedTaskRef: t.shortId });
    await req('PATCH', `/tasks/${t.shortId}`, { status: 'in_progress' });
    await req('PATCH', `/tasks/${t.shortId}`, { status: 'in_review' });
    const kids = await children(t.shortId);

    await Promise.all(kids.map((k) => req('PATCH', `/tasks/${k.shortId}`, { status: 'done' })));

    expect(await statusOf(t.shortId), `iteration ${i}`).toBe('done');
    const resolved = (await eventsOf(p.prefix)).filter((e) => e.text.includes('auto-resolved'));
    expect(resolved, `iteration ${i}: ${resolved.map((e) => e.text).join(' | ')}`).toHaveLength(1);
  }
});

// ---------- 2e. DAR-262: the OTHER caller of resolvePromotedFeedback ----------
//
// The DAR-259 fix put one owner on the cascade that hangs off maybeAdvanceParent. It does not reach
// this one: PATCH /tasks/:ref with {status: 'done'} calls resolvePromotedFeedback directly, and that
// function is its own read-then-write — find the open promoted rows, then update each. Concurrent
// explicit closes on one task therefore all read the same open rows and all resolve them, so the
// board gets N "auto-resolved" events per row and the reporter gets "*FB-n resolved.*" posted into
// their Slack thread N times. That last one is the only failure mode in this system a human sees.
//
// WHAT IS DIFFERENT FROM ITS TWO SIBLINGS, and what shapes the fix: this path carries a CALLER-
// SUPPLIED BODY. DAR-256's loser is told 409 because nothing it sent landed; maybeAdvanceParent's
// loser has no body at all. Here a `notes`, an `addCommit` or an `assignee` can ride along with the
// status, so a conditional on the PATCH write would turn a legitimate edit into 200-and-applied-
// nothing, which is the silent-drop class this whole run has been closing. So the claim goes on the
// CASCADE and never on the caller's write, and every racer's own patch lands in full.
const RACES_262 = 40;

type SlackPost = { channel: string; thread_ts?: string; text: string };

// Slack replies are counted at the HTTP boundary — the actual fetch slackThreadReply would make —
// because "one event on the board" and "one message to a human" are two different claims and it is
// the second one this row is about. The fixtures below are the only ones in this file that carry a
// `slack` thread, so nothing may reach the real workspace: fetch is replaced for the duration AND
// the api base is pointed at the discard port, so a bypass of the stub fails closed rather than
// posting. Hono's api.request() builds a Request and calls the app directly, so the harness itself
// does not go through global fetch and is unaffected.
async function withSlackRecorder<T>(fn: (posts: SlackPost[]) => Promise<T>): Promise<T> {
  const posts: SlackPost[] = [];
  const realFetch = globalThis.fetch;
  const realToken = config.slackBotToken;
  const realBase = config.slackApiBase;
  config.slackBotToken = 'xoxb-scratch-never-a-real-token';
  config.slackApiBase = 'http://127.0.0.1:9/api';
  globalThis.fetch = (async (input: unknown, init?: { body?: string }) => {
    const url = String(input);
    if (!url.startsWith(config.slackApiBase)) throw new Error(`unexpected fetch while slack was stubbed: ${url}`);
    posts.push(JSON.parse(init?.body ?? '{}') as SlackPost);
    return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  try {
    return await fn(posts);
  } finally {
    globalThis.fetch = realFetch;
    config.slackBotToken = realToken;
    config.slackApiBase = realBase;
  }
}

/** a task carrying TWO accepted feedback rows promoted onto it, each with its own slack thread */
async function promotedOnto(prefix: string, iteration: number) {
  const t = await task(prefix, { title: 'ships two promoted rows' });
  const rows = [];
  for (const n of [1, 2]) {
    const fb = await feedback({
      project: prefix,
      body: `promoted finding ${n}`,
      slack: { channel: 'C-SCRATCH', ts: `17000000${iteration}.00${n}` },
    });
    await req('PATCH', `/feedback/${fb.shortId}`, { status: 'accepted' });
    await req('PATCH', `/feedback/${fb.shortId}`, { resolvedTaskRef: t.shortId });
    rows.push(fb.shortId);
  }
  return { t, rows };
}

// Reproduced on iteration 0 before the fix: 3 racers, 2 promoted rows, 6 "auto-resolved" events and
// 6 slack posts where 2 of each is the whole truth.
test('DAR-262: three explicit closes at once auto-resolve each promoted row exactly ONCE', async () => {
  await withSlackRecorder(async (posts) => {
    for (let i = 0; i < RACES_262; i++) {
      await reset();
      posts.length = 0;
      const p = await project();
      const { t, rows } = await promotedOnto(p.prefix, i);

      const closes = await Promise.all(
        ['aaa1111', 'bbb2222', 'ccc3333'].map((sha) =>
          req<{ status: string; commits: string[] }>('PATCH', `/tasks/${t.shortId}`, { status: 'done', addCommit: sha })),
      );

      for (const r of closes) expect(r.status, `iteration ${i}`).toBe(200);
      expect(await statusOf(t.shortId), `iteration ${i}`).toBe('done');

      // one auto-resolution per ROW, not per racer and not per task
      const events = (await eventsOf(p.prefix)).filter((e) => e.text.includes('auto-resolved'));
      for (const shortId of rows) {
        const mine = events.filter((e) => e.text.startsWith(`${shortId} `));
        expect(mine, `iteration ${i} ${shortId}: ${mine.map((e) => e.text).join(' | ')}`).toHaveLength(1);
      }
      expect(events, `iteration ${i}: ${events.map((e) => e.text).join(' | ')}`).toHaveLength(rows.length);

      // and one message into each reporter's thread. This is the assertion the row exists for.
      for (const shortId of rows) {
        const mine = posts.filter((m) => m.text.includes(`*${shortId} resolved.*`));
        expect(mine, `iteration ${i} ${shortId}: ${mine.map((m) => m.text).join(' | ')}`).toHaveLength(1);
      }
      expect(posts, `iteration ${i}: ${posts.map((m) => m.text).join(' | ')}`).toHaveLength(rows.length);
    }
  });
});

// The other half of the same fix, and the half a conditional on the PATCH write would have broken.
// Three closers arrive together, each carrying a different legitimate edit beside the status. Every
// one of those edits has to land and every closer has to be told the truth, because the row really
// is done for all three of them — the only thing they contend for is the cascade. The three non-
// append fields are DISJOINT on purpose (notes, assignee, description) so all three can be asserted
// at once rather than one racer's write hiding under another's; addCommit is per-racer proof on its
// own, since it pushes rather than overwrites.
test('DAR-262: every concurrent closer keeps its own body, and is answered truthfully', async () => {
  await withSlackRecorder(async (posts) => {
    for (let i = 0; i < RACES_262; i++) {
      await reset();
      posts.length = 0;
      const p = await project();
      const { t, rows } = await promotedOnto(p.prefix, i);

      const sent = [
        { status: 'done', addCommit: 'aaa1111', notes: 'builder note that must survive' },
        { status: 'done', addCommit: 'bbb2222', assignee: 'staff-engineer' },
        { status: 'done', addCommit: 'ccc3333', description: 'rewritten spec that must survive' },
      ];
      const closes = await Promise.all(
        sent.map((body) => req<{ status: string; commits: string[] }>('PATCH', `/tasks/${t.shortId}`, body)),
      );

      // truthful to each caller: 200, and the status the row actually holds
      for (const [n, r] of closes.entries()) {
        expect(r.status, `iteration ${i} racer ${n}: ${r.error}`).toBe(200);
        expect(r.body.status, `iteration ${i} racer ${n}`).toBe('done');
        expect(r.body.commits, `iteration ${i} racer ${n}`).toContain(sent[n]!.addCommit);
      }

      // and nothing any of them sent was dropped
      const row = (await req<{ notes: string; assignee: string; description: string; commits: string[] }>(
        'GET', `/tasks/${t.shortId}`)).body;
      expect(row.notes, `iteration ${i}`).toBe('builder note that must survive');
      expect(row.assignee, `iteration ${i}`).toBe('staff-engineer');
      expect(row.description, `iteration ${i}`).toBe('rewritten spec that must survive');
      expect([...row.commits].sort(), `iteration ${i}`).toEqual(['aaa1111', 'bbb2222', 'ccc3333']);

      // the cascade still ran exactly once per row while all of that landed
      const events = (await eventsOf(p.prefix)).filter((e) => e.text.includes('auto-resolved'));
      expect(events, `iteration ${i}: ${events.map((e) => e.text).join(' | ')}`).toHaveLength(rows.length);
      expect(posts, `iteration ${i}: ${posts.map((m) => m.text).join(' | ')}`).toHaveLength(rows.length);
    }
  });
});

// The cascade does not end at the feedback rows: a row that just resolved may have been the last
// hold on the task it was FILED ON, so each one hands off to maybeAdvanceParent. That hand-off is
// the second thing the losers were doing twice. DAR-259 put a claim on the ADVANCE itself, so no
// duplicate "auto-advanced" can come out of here — but the branch where the parent cannot advance
// only reads and logs, so three closers produced three "holding" lines about one row. Scoping the
// hand-off to the rows this call actually claimed is what removes them.
//
// Asserted against the SEQUENTIAL count of the identical scenario rather than a hard-coded number,
// because the claim is not "two events" (two acts legitimately re-check this parent: the review
// child closing, and the feedback row resolving) — it is that racing adds nothing to what one
// closer produces.
test('DAR-262: a contended close logs no more about the held parent than an uncontended one', async () => {
  const holdingCount = async (closers: number, i: number) => {
    await reset();
    const p = await project();
    const host = await task(p.prefix, { lanes: ['code-review'] });        // the row the feedback is FILED ON
    const fixer = await task(p.prefix, { title: 'the row that ships' });
    // one row filed on host and promoted onto fixer, one filed on host and left open so that host
    // is held rather than advanced when the first one resolves
    const fb = await feedback({ taskRef: host.shortId, body: `filed on host ${i}` });
    await feedback({ taskRef: host.shortId, body: `still open, holds host ${i}` });
    await req('PATCH', `/feedback/${fb.shortId}`, { status: 'accepted' });
    await req('PATCH', `/feedback/${fb.shortId}`, { resolvedTaskRef: fixer.shortId });
    await req('PATCH', `/tasks/${host.shortId}`, { status: 'in_progress' });
    await req('PATCH', `/tasks/${host.shortId}`, { status: 'in_review' });
    const kids = await children(host.shortId);
    await req('PATCH', `/tasks/${kids[0]!.shortId}`, { status: 'done' });

    await Promise.all(Array.from({ length: closers }, (_, n) =>
      req('PATCH', `/tasks/${fixer.shortId}`, { status: 'done', addCommit: `sha${n}` })));

    const events = await eventsOf(p.prefix);
    expect(events.filter((e) => e.text.includes('auto-resolved')), `iteration ${i}, ${closers} closer(s)`).toHaveLength(1);
    return events.filter((e) => e.text.includes('holding')).length;
  };

  const alone = await holdingCount(1, -1);
  for (let i = 0; i < RACES_262; i++) {
    expect(await holdingCount(3, i), `iteration ${i}`).toBe(alone);
  }
});

// ---------- linearUrl: the linear-native pointer is config, and junk cannot claim to be a URL ----------

test('linearUrl sets, reads back everywhere a session looks, and null clears it', async () => {
  const p = await project();
  const url = 'https://linear.app/acme/team/MEE/label/mrfiii';
  const r = await req('PATCH', `/projects/${p.prefix}`, { linearUrl: url });
  expect(r.status).toBe(200);
  // /context is the read every agent takes before working; the list feeds the console cards
  expect((await req<{ linearUrl: string | null }>('GET', `/projects/${p.prefix}/context`)).body.linearUrl).toBe(url);
  const row = (await req<unknown>('GET', '/projects')).body as unknown as Array<{ prefix: string; linearUrl?: string }>;
  expect(row.find((x) => x.prefix === p.prefix)?.linearUrl).toBe(url);

  const cleared = await req('PATCH', `/projects/${p.prefix}`, { linearUrl: null });
  expect(cleared.status).toBe(200);
  expect((await req<{ linearUrl: string | null }>('GET', `/projects/${p.prefix}/context`)).body.linearUrl).toBeNull();
});

test('a linearUrl that is not an absolute http(s) URL is a 400, not a stored string', async () => {
  const p = await project();
  for (const bad of ['linear.app/acme', 'ftp://x', 'not a url']) {
    const r = await req('PATCH', `/projects/${p.prefix}`, { linearUrl: bad });
    expect(r.status, bad).toBe(400);
  }
  expect((await req<{ linearUrl: string | null }>('GET', `/projects/${p.prefix}/context`)).body.linearUrl).toBeNull();
});

test('the round-trippable project GET carries linearUrl and its echo is a legal PATCH body', async () => {
  const p = await project();
  await req('PATCH', `/projects/${p.prefix}`, { linearUrl: 'https://linear.app/acme/view/abc' });
  const body = (await req<Record<string, unknown>>('GET', `/projects/${p.prefix}`)).body;
  expect(body.linearUrl).toBe('https://linear.app/acme/view/abc');
  const echo = await req('PATCH', `/projects/${p.prefix}`, body);
  expect(echo.status).toBe(200);
});

// ---------- memory graph (DAR-274) ----------

type MemNode = { _id: string; name: string; observations: { text: string; source: string }[] };
type MemEdge = { _id: string; relation: string; invalidAt: string | null };
type Remembered = { node: MemNode; edges: MemEdge[] };
type Recalled = { nodes: (MemNode & { depth: number })[]; edges: { relation: string; from: string | null; to: string | null }[] };

test('remember dedupes by slug within a project and appends observations rather than overwriting', async () => {
  const p = await project();
  const first = await req<Remembered>('POST', '/memory/remember', {
    node: { name: 'Mars flag precedence', type: 'gotcha', project: p.prefix },
    observations: ['employee flag beats firm flag'],
  });
  expect(first.status).toBe(200);
  const nodeId = first.body.node._id;

  // same node addressed via its already-kebab slug, different casing/spacing does not matter
  const second = await req<Remembered>('POST', '/memory/remember', {
    node: { name: 'mars-flag-precedence', type: 'gotcha', project: p.prefix },
    observations: [{ text: 'keys off meetingNote.CreatedByID', source: 'DAR-999' }],
  });
  expect(second.status).toBe(200);
  expect(second.body.node._id).toBe(nodeId); // same node, not a second one
  expect(second.body.node.observations).toHaveLength(2);
  expect(second.body.node.observations[0]!.text).toBe('employee flag beats firm flag');
  expect(second.body.node.observations[1]!.text).toBe('keys off meetingNote.CreatedByID');
  expect(second.body.node.observations[1]!.source).toBe('DAR-999');

  const found = await req<Recalled>('GET', `/memory/recall?q=${encodeURIComponent('mars flag precedence')}&project=${p.prefix}`);
  expect(found.status).toBe(200);
  const hits = found.body.nodes.filter((n) => n.name.toLowerCase().includes('mars flag'));
  expect(hits).toHaveLength(1); // deduped, not two nodes on the board
});

test('supersede stamps invalidAt and adds a SUPERSEDES edge, never deleting the old one', async () => {
  const p = await project();
  await req('POST', '/memory/remember', { node: { name: 'Old Choice', type: 'decision', project: p.prefix } });
  await req('POST', '/memory/remember', { node: { name: 'New Choice', type: 'decision', project: p.prefix } });
  await req('POST', '/memory/remember', { node: { name: 'Widget Service', type: 'service', project: p.prefix } });
  const linked = await req<Remembered>('POST', '/memory/remember', {
    node: { name: 'Widget Service', type: 'service', project: p.prefix },
    edges: [{ to: 'Old Choice', relation: 'DECIDED_FOR' }],
  });
  expect(linked.status).toBe(200);
  const edgeId = linked.body.edges[0]!._id;

  const sup = await req<{ invalidated: MemEdge; supersedes: MemEdge }>('POST', '/memory/supersede', { edgeId, by: 'New Choice', project: p.prefix });
  expect(sup.status).toBe(200);
  expect(sup.body.invalidated.invalidAt).not.toBeNull();
  expect(sup.body.supersedes.relation).toBe('SUPERSEDES');

  // an ordinary recall no longer walks the invalidated edge
  const now = await req<Recalled>('GET', `/memory/recall?q=Widget+Service&project=${p.prefix}`);
  expect(now.body.edges.map((e) => e.relation)).not.toContain('DECIDED_FOR');
  // the replacement edge IS walked, from the node that superseded it
  const supersedesView = await req<Recalled>('GET', `/memory/recall?q=New+Choice&project=${p.prefix}`);
  expect(supersedesView.body.edges.map((e) => e.relation)).toContain('SUPERSEDES');

  // the old node itself is still on the graph — nothing about superseding an edge touches it
  const oldStill = await req<Recalled>('GET', `/memory/recall?q=Old+Choice&project=${p.prefix}`);
  expect(oldStill.body.nodes.map((n) => n.name)).toContain('Old Choice');

  // superseding the same edge twice is refused, not silently repeated
  const again = await req('POST', '/memory/supersede', { edgeId, by: 'New Choice', project: p.prefix });
  expect(again.status).toBe(409);
});

test('recall walks two hops when asked and stops at one otherwise', async () => {
  const p = await project();
  for (const name of ['Alpha', 'Beta', 'Gamma']) {
    await req('POST', '/memory/remember', { node: { name, type: 'service', project: p.prefix } });
  }
  await req('POST', '/memory/remember', {
    node: { name: 'Alpha', type: 'service', project: p.prefix },
    edges: [{ to: 'Beta', relation: 'RELATES_TO' }],
  });
  await req('POST', '/memory/remember', {
    node: { name: 'Beta', type: 'service', project: p.prefix },
    edges: [{ to: 'Gamma', relation: 'RELATES_TO' }],
  });

  const oneHop = await req<Recalled>('GET', `/memory/recall?q=Alpha&project=${p.prefix}&hops=1`);
  const oneNames = oneHop.body.nodes.map((n) => n.name);
  expect(oneNames).toContain('Alpha');
  expect(oneNames).toContain('Beta');
  expect(oneNames).not.toContain('Gamma');

  const twoHop = await req<Recalled>('GET', `/memory/recall?q=Alpha&project=${p.prefix}&hops=2`);
  const twoNames = twoHop.body.nodes.map((n) => n.name);
  expect(twoNames).toContain('Alpha');
  expect(twoNames).toContain('Beta');
  expect(twoNames).toContain('Gamma');
  expect(twoHop.body.nodes.find((n) => n.name === 'Gamma')!.depth).toBe(2);
});

test('asOf recall sees a relation as it stood at a past moment, after it has since been superseded', async () => {
  const p = await project();
  await req('POST', '/memory/remember', { node: { name: 'Old Pick', type: 'decision', project: p.prefix } });
  await req('POST', '/memory/remember', { node: { name: 'New Pick', type: 'decision', project: p.prefix } });
  await req('POST', '/memory/remember', { node: { name: 'Gadget', type: 'service', project: p.prefix } });
  const linked = await req<Remembered>('POST', '/memory/remember', {
    node: { name: 'Gadget', type: 'service', project: p.prefix },
    edges: [{ to: 'Old Pick', relation: 'DECIDED_FOR' }],
  });
  const asOf = new Date().toISOString();
  await new Promise((r) => setTimeout(r, 5)); // the supersede below must land strictly after `asOf`
  await req('POST', '/memory/supersede', { edgeId: linked.body.edges[0]!._id, by: 'New Pick', project: p.prefix });

  const past = await req<Recalled>('GET', `/memory/recall?q=Gadget&project=${p.prefix}&asOf=${encodeURIComponent(asOf)}`);
  expect(past.body.edges.map((e) => e.relation)).toContain('DECIDED_FOR');

  const present = await req<Recalled>('GET', `/memory/recall?q=Gadget&project=${p.prefix}`);
  expect(present.body.edges.map((e) => e.relation)).not.toContain('DECIDED_FOR');
});

// ---------- DAR-279 rework: the ten proven findings, one test each ----------

test('DAR-279 #1: asOf excludes an edge already superseded by that moment, includes it before', async () => {
  const p = await project();
  await req('POST', '/memory/remember', { node: { name: 'Port A', type: 'decision', project: p.prefix } });
  await req('POST', '/memory/remember', { node: { name: 'Port B', type: 'decision', project: p.prefix } });
  await req('POST', '/memory/remember', { node: { name: 'Server', type: 'service', project: p.prefix } });
  const linked = await req<Remembered>('POST', '/memory/remember', {
    node: { name: 'Server', type: 'service', project: p.prefix },
    edges: [{ to: 'Port A', relation: 'DECIDED_FOR' }],
  });
  await new Promise((r) => setTimeout(r, 5));
  const midway = new Date().toISOString(); // strictly between the edge's validAt (T0) and its supersede (T1)
  await new Promise((r) => setTimeout(r, 5));
  await req('POST', '/memory/supersede', { edgeId: linked.body.edges[0]!._id, by: 'Port B', project: p.prefix });
  await new Promise((r) => setTimeout(r, 5));
  const afterSupersede = new Date().toISOString(); // T2, strictly after the supersede (T1)

  const between = await req<Recalled>('GET', `/memory/recall?q=Server&project=${p.prefix}&asOf=${encodeURIComponent(midway)}`);
  expect(between.body.edges.map((e) => e.relation)).toContain('DECIDED_FOR'); // valid at T0..T1, midway is inside that window

  const after = await req<Recalled>('GET', `/memory/recall?q=Server&project=${p.prefix}&asOf=${encodeURIComponent(afterSupersede)}`);
  expect(after.body.edges.map((e) => e.relation)).not.toContain('DECIDED_FOR'); // T2 > T1: already dead by then
});

test('DAR-279 #2: re-remembering an edge with no source/confidence never overwrites either, and confidence only ever rises', async () => {
  const p = await project();
  await req('POST', '/memory/remember', { node: { name: 'From Node', type: 'service', project: p.prefix } });
  await req('POST', '/memory/remember', { node: { name: 'To Node', type: 'service', project: p.prefix } });
  const first = await req<Remembered>('POST', '/memory/remember', {
    node: { name: 'From Node', type: 'service', project: p.prefix },
    edges: [{ to: 'To Node', relation: 'RELATES_TO', confidence: 0.9, source: { session: 's1', taskRef: 'DAR-1' } }],
  });
  expect(first.status).toBe(200);
  const edge1 = first.body.edges[0] as MemEdge & { source: Record<string, string>; confidence: number };
  expect(edge1.source).toEqual({ session: 's1', taskRef: 'DAR-1' });
  expect(edge1.confidence).toBe(0.9);

  // plain re-remember: no source, no confidence sent at all
  const second = await req<Remembered>('POST', '/memory/remember', {
    node: { name: 'From Node', type: 'service', project: p.prefix },
    edges: [{ to: 'To Node', relation: 'RELATES_TO' }],
  });
  expect(second.status).toBe(200);
  const edge2 = second.body.edges[0] as MemEdge & { source: Record<string, string>; confidence: number };
  expect(edge2.source).toEqual({ session: 's1', taskRef: 'DAR-1' }); // NOT blanked to {}
  expect(edge2.confidence).toBe(0.9); // NOT reset to 1

  // a lower confidence sent explicitly must not lower the stored value
  const third = await req<Remembered>('POST', '/memory/remember', {
    node: { name: 'From Node', type: 'service', project: p.prefix },
    edges: [{ to: 'To Node', relation: 'RELATES_TO', confidence: 0.3 }],
  });
  const edge3 = third.body.edges[0] as MemEdge & { confidence: number };
  expect(edge3.confidence).toBe(0.9);

  // a higher confidence sent explicitly does raise it
  const fourth = await req<Remembered>('POST', '/memory/remember', {
    node: { name: 'From Node', type: 'service', project: p.prefix },
    edges: [{ to: 'To Node', relation: 'RELATES_TO', confidence: 0.99 }],
  });
  const edge4 = fourth.body.edges[0] as MemEdge & { confidence: number };
  expect(edge4.confidence).toBe(0.99);
});

test('DAR-279 #3: an unrecognized/misspelled field on remember is a 400, never a 200 that dropped it', async () => {
  const p = await project();
  const r = await req('POST', '/memory/remember', {
    node: { name: 'Typo Node', type: 'decision', project: p.prefix },
    observation: ['this key is misspelled'],
    edgez: [{ to: 'nowhere', relation: 'RELATES_TO' }],
  });
  expect(r.status).toBe(400);
  expect(r.error).toContain('observation');
  expect(r.error).toContain('edgez');

  // and it must not have been created under the 200 this used to return
  const found = await req<Recalled>('GET', `/memory/recall?q=Typo+Node&project=${p.prefix}`);
  expect(found.body.nodes.map((n) => n.name)).not.toContain('Typo Node');
});

test('DAR-279 #4: recall(project=P) searches P plus global; recall with no project searches global only', async () => {
  const p = await project();
  await req('POST', '/memory/remember', { node: { name: 'Scoped Widget', type: 'service', project: p.prefix } });
  await req('POST', '/memory/remember', { node: { name: 'Global Widget', type: 'service' } }); // no project = global

  const scoped = await req<Recalled>('GET', `/memory/recall?q=Widget&project=${p.prefix}`);
  const scopedNames = scoped.body.nodes.map((n) => n.name);
  expect(scopedNames).toContain('Scoped Widget');
  expect(scopedNames).toContain('Global Widget'); // project scope PLUS global

  const globalOnly = await req<Recalled>('GET', `/memory/recall?q=Widget`);
  const globalNames = globalOnly.body.nodes.map((n) => n.name);
  expect(globalNames).toContain('Global Widget');
  expect(globalNames).not.toContain('Scoped Widget'); // omitting project searches GLOBAL only
});

test('DAR-279 #5: superseding a node hides it from recall by default and returns it with supersededBy when asked', async () => {
  const p = await project();
  await req('POST', '/memory/remember', { node: { name: 'port is 8080', type: 'decision', project: p.prefix } });
  await req('POST', '/memory/remember', { node: { name: 'port is 8081', type: 'decision', project: p.prefix } });
  const sup = await req('POST', '/memory/supersede', { nodeName: 'port is 8080', by: 'port is 8081', project: p.prefix });
  expect(sup.status).toBe(200);

  const ordinary = await req<Recalled>('GET', `/memory/recall?q=port&project=${p.prefix}`);
  const names = ordinary.body.nodes.map((n) => n.name);
  expect(names).toContain('port is 8081');
  expect(names).not.toContain('port is 8080'); // excluded by default, asOf-aware

  const withStale = await req<{ nodes: (MemNode & { depth: number; supersededBy?: string | null })[] }>(
    'GET', `/memory/recall?q=port&project=${p.prefix}&includeSuperseded=true`,
  );
  const stale = withStale.body.nodes.find((n) => n.name === 'port is 8080');
  expect(stale).toBeTruthy();
  expect(stale!.supersededBy).toBe('port is 8081');
});

test('DAR-279 #6: traversal is undirected — recall hitting the TO node reaches the FROM node at depth 1', async () => {
  const p = await project();
  await req('POST', '/memory/remember', { node: { name: 'Gotcha X', type: 'gotcha', project: p.prefix } });
  await req('POST', '/memory/remember', { node: { name: 'Hub Service', type: 'service', project: p.prefix } });
  await req('POST', '/memory/remember', {
    node: { name: 'Gotcha X', type: 'gotcha', project: p.prefix },
    edges: [{ to: 'Hub Service', relation: 'RELATES_TO' }],
  });

  // recall matches the HUB (the `to` side of the edge), not the gotcha that points at it
  const hit = await req<Recalled>('GET', `/memory/recall?q=Hub+Service&project=${p.prefix}`);
  const names = hit.body.nodes.map((n) => n.name);
  expect(names).toContain('Hub Service');
  expect(names).toContain('Gotcha X'); // reached backwards along the edge
  const gotchaHit = hit.body.nodes.find((n) => n.name === 'Gotcha X') as (MemNode & { depth: number }) | undefined;
  expect(gotchaHit?.depth).toBe(1);
});

test('DAR-279 #9: a node name over 200 chars is refused, naming the limit', async () => {
  const p = await project();
  const r = await req('POST', '/memory/remember', { node: { name: 'x'.repeat(201), type: 'decision', project: p.prefix } });
  expect(r.status).toBe(400);
  expect(r.error).toContain('200');
});

test('DAR-279 #10: edge.source rejects unknown keys, and recall limit is a validated query param', async () => {
  const p = await project();
  await req('POST', '/memory/remember', { node: { name: 'Src A', type: 'service', project: p.prefix } });
  await req('POST', '/memory/remember', { node: { name: 'Src B', type: 'service', project: p.prefix } });
  const bad = await req('POST', '/memory/remember', {
    node: { name: 'Src A', type: 'service', project: p.prefix },
    edges: [{ to: 'Src B', relation: 'RELATES_TO', source: { session: 's1', bogus: 'nope' } }],
  });
  expect(bad.status).toBe(400);
  expect(bad.error).toContain('bogus');

  const limitTooBig = await req('GET', `/memory/recall?q=Src&project=${p.prefix}&limit=51`);
  expect(limitTooBig.status).toBe(400);
  const limitOk = await req<Recalled & { limit: number }>('GET', `/memory/recall?q=Src&project=${p.prefix}&limit=1`);
  expect(limitOk.status).toBe(200);
  expect(limitOk.body.limit).toBe(1);
});

// ---------- memory index + export (DAR-280) ----------

test('memory index caps its output under 24,000 bytes and ends with the omitted-node count', async () => {
  const p = await project();
  for (let i = 0; i < 400; i++) {
    await req('POST', '/memory/remember', {
      node: { name: `Bulk Node ${i}`, type: 'gotcha', project: p.prefix },
      observations: [`observation text padding out this line to something realistic for node ${i}, so the index has real bytes to cap`],
    });
  }
  const r = await api.request(`/memory/index?project=${p.prefix}`);
  expect(r.status).toBe(200);
  expect(r.headers.get('content-type')).toContain('text/markdown');
  const text = await r.text();
  expect(new TextEncoder().encode(text).length).toBeLessThan(24000);
  expect(text).toMatch(/\d+ node\(s\) omitted/);
});

test('memory index excludes a superseded node', async () => {
  const p = await project();
  await req('POST', '/memory/remember', { node: { name: 'Old Index Pick', type: 'decision', project: p.prefix } });
  await req('POST', '/memory/remember', { node: { name: 'New Index Pick', type: 'decision', project: p.prefix } });
  await req('POST', '/memory/supersede', { nodeName: 'Old Index Pick', by: 'New Index Pick', project: p.prefix });

  const r = await api.request(`/memory/index?project=${p.prefix}`);
  expect(r.status).toBe(200);
  const text = await r.text();
  expect(text).not.toContain('Old Index Pick');
  expect(text).toContain('New Index Pick');
});

test('both memory routes are local-only', async () => {
  const p = await project();
  const headers = { 'x-forwarded-host': 'darbar.ngrok.app' };
  const idx = await api.request(`/memory/index?project=${p.prefix}`, { headers });
  expect(idx.status).toBe(403);
  expect(await idx.text()).toContain('local-only');
  const exp = await api.request(`/memory/export?project=${p.prefix}`, { headers });
  expect(exp.status).toBe(403);
  expect(await exp.text()).toContain('local-only');
});

// minimal store-only zip reader: enough to read back what buildZip (api.ts) writes, without a
// dependency neither this file nor api.ts otherwise needs.
function readZipEntries(buf: Uint8Array): Map<string, string> {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const decoder = new TextDecoder();
  // walk from the end for the end-of-central-directory record (fixed 22-byte tail, no comment used)
  const eocdOffset = buf.length - 22;
  const centralCount = dv.getUint16(eocdOffset + 10, true);
  let centralOffset = dv.getUint32(eocdOffset + 16, true);
  const out = new Map<string, string>();
  for (let i = 0; i < centralCount; i++) {
    const nameLen = dv.getUint16(centralOffset + 28, true);
    const localHeaderOffset = dv.getUint32(centralOffset + 42, true);
    const name = decoder.decode(buf.subarray(centralOffset + 46, centralOffset + 46 + nameLen));
    const localNameLen = dv.getUint16(localHeaderOffset + 26, true);
    const localExtraLen = dv.getUint16(localHeaderOffset + 28, true);
    const size = dv.getUint32(localHeaderOffset + 18, true);
    const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
    out.set(name, decoder.decode(buf.subarray(dataStart, dataStart + size)));
    centralOffset += 46 + nameLen;
  }
  return out;
}

test('memory export streams a zip with one file per node, a README, and a wikilink for an edge', async () => {
  const p = await project();
  await req('POST', '/memory/remember', { node: { name: 'Export From', type: 'service', project: p.prefix }, observations: ['seen once'] });
  await req('POST', '/memory/remember', { node: { name: 'Export To', type: 'service', project: p.prefix } });
  await req('POST', '/memory/remember', {
    node: { name: 'Export From', type: 'service', project: p.prefix },
    edges: [{ to: 'Export To', relation: 'RELATES_TO' }],
  });

  const r = await api.request(`/memory/export?project=${p.prefix}`);
  expect(r.status).toBe(200);
  expect(r.headers.get('content-type')).toContain('application/zip');
  const buf = new Uint8Array(await r.arrayBuffer());
  const entries = readZipEntries(buf);
  expect(entries.has('README.md')).toBe(true);
  expect(entries.get('README.md')).toContain('NO IMPORT PATH');
  expect(entries.has('export-from.md')).toBe(true);
  expect(entries.has('export-to.md')).toBe(true);
  expect(entries.get('export-from.md')).toContain('[[export-to]]');
  expect(entries.get('export-from.md')).toContain('RELATES_TO');
});
