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
import { children, feedback, project, req, reset, task, teardown } from './test-harness';
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

// ---------- 3. a feedback row is attributed to somebody the project knows ----------

const ROSTERED = {
  stakeholders: [{ name: 'Raj', role: 'owner' }, { name: 'Tanisha' }],
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
  expect(filed.error).toContain('stakeholders [Raj, Tanisha]');
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

test('with no stakeholder list there is nothing to check a name against, so filing stays open', async () => {
  const p = await project();
  const filed = await req<{ author: string }>('POST', '/feedback', { project: p.prefix, body: 'no roster here' });
  expect(filed.status).toBe(200);
  expect(filed.body.author).toBe('unknown');
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
