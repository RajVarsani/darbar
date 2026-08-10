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
