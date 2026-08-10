// The silently-dropped-field class (DAR-208), and the append that replaced one of its instances
// (DAR-182).
//
// The defect is not any one field. It is a route accepting a field it has no branch for and
// answering 200, so "fix the parent", "file this already triaged", "put the repos back" all read as
// done and changed nothing. The last round of this closed seven listed instances and a reviewer
// immediately found an eighth, which is why the fix is a per-document vocabulary rather than another
// list of names, and why this file asserts the PROPERTY on every route it can reach: a field that
// means something here is either applied or refused by name, never eaten.
//
// Mongo is deliberately not involved. Every assertion below is on a body the route rejects before it
// looks anything up, which is also the honest scope of a unit test here: that the guard fires and
// says which door to use. The applied halves (repos landing on the doc, blocker landing on a new
// task, an append landing on a row) are proved end to end against a running server, since only a
// real write can show that.
import { expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Nothing here reads the held-report directory. The env var is still pointed at a rig in case this
// file is the first thing in the run to import @darbar/core, so this machine's data/parked can
// never be the resolved path; config itself is deliberately NOT overwritten here, so parked.test.ts
// keeps its own rig whatever order bun loads these in.
process.env.PARKED_DIR ??= mkdtempSync(path.join(tmpdir(), 'darbar-fields-'));
const { api, appendedBody, echoedUnchanged } = await import('./api');
const { ObjectId } = await import('@darbar/core');

async function send(route: string, method: string, body: unknown) {
  const r = await api.request(route, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = (await r.json()) as { error?: string };
  return { status: r.status, error: j.error ?? '' };
}

// every one of these named a real thing and was dropped under a 200
test('POST /tasks refuses the server-owned fields instead of dropping them', async () => {
  const cases: Array<[string, unknown, string]> = [
    ['dispatched', true, 'PATCH /tasks/:ref'],
    ['dispatchedAt', '2026-08-09T00:00:00.000Z', 'dispatched'],
    ['commits', ['abc1234'], 'addCommit'],
    ['shortId', 'DAR-999', 'server'],
    ['parentTaskId', '6a78c37ccaad6d9b9177277a', 'parentTaskRef'],
    ['projectId', '6a777ca5273258841c030731', 'cannot move between projects'],
    ['createdAt', '2026-01-01T00:00:00.000Z', 'server'],
    ['updatedAt', '2026-01-01T00:00:00.000Z', 'server'],
  ];
  for (const [field, value, mentions] of cases) {
    const r = await send('/tasks', 'POST', { project: 'NOPE', title: 'x', [field]: value });
    expect(r.status, `${field} was not refused`).toBe(400);
    expect(r.error).toContain(field);
    expect(r.error).toContain(mentions);
  }
});

// A word this API applies SOMEWHERE has to be in that document's table, or the table has the same
// blind spot as the routes it exists to fix. These two were found by asking that question of every
// applied field rather than by reading the routes again.
test('a field applied by one route is refused, not dropped, by the others', async () => {
  const commit = await send('/tasks', 'POST', { project: 'NOPE', title: 'x', addCommit: 'deadbeef' });
  expect(commit.status, 'POST /tasks {addCommit} returned 200 with commits []').toBe(400);
  expect(commit.error).toContain('PATCH /tasks/:ref');
  // and the routes that DO apply them must not start refusing them
  const filedType = await send('/feedback', 'POST', { project: 'NOPE', body: 'x', type: 'design' });
  expect(filedType.error).not.toContain('not settable');
});

// ---------- an echo is not an edit ----------
// This predicate is the whole difference between refusing a dropped CHANGE and refusing a caller who
// read the row, edited one field and sent the rest back, which is the documented way to restructure
// a charter or replace a stakeholder list. The values below are what a GET actually hands back.
test('a field echoed back exactly as it was read is not an edit', () => {
  expect(echoedUnchanged('Darbar Platform', 'Darbar Platform')).toBe(true);
  expect(echoedUnchanged(['darbar'], ['darbar'])).toBe(true);
  expect(echoedUnchanged({ task: 3, feedback: 1 }, { task: 3, feedback: 1 })).toBe(true);
  // a GET serialised these; the stored values are a Date and an ObjectId
  expect(echoedUnchanged('2026-08-09T12:30:00.000Z', new Date('2026-08-09T12:30:00.000Z'))).toBe(true);
  const id = new ObjectId('6a777ca5273258841c030731');
  expect(echoedUnchanged('6a777ca5273258841c030731', id)).toBe(true);
});

test('key order does not decide it, because re-serialising a body is not editing it', () => {
  expect(echoedUnchanged({ b: 2, a: 1 }, { a: 1, b: 2 })).toBe(true);
  expect(echoedUnchanged({ a: 1 }, { a: 1, b: 2 })).toBe(false);
});

test('absent, null and empty all say the same thing, so echoing any of them changes nothing', () => {
  expect(echoedUnchanged([], undefined)).toBe(true);
  expect(echoedUnchanged([], null)).toBe(true);
  expect(echoedUnchanged(null, undefined)).toBe(true);
  expect(echoedUnchanged([], [])).toBe(true);
});

test('a real change is still a change', () => {
  expect(echoedUnchanged('Hijacked', 'Darbar Platform')).toBe(false);
  expect(echoedUnchanged(['darbar', 'skills'], ['darbar'])).toBe(false);
  expect(echoedUnchanged({ task: 99 }, { task: 3 })).toBe(false);
  expect(echoedUnchanged(['x'], [])).toBe(false);
  expect(echoedUnchanged('', null)).toBe(false); // an empty STRING is a value somebody typed
});

// the one field on that route with the property AND a real use: a task can be created at status
// blocked, and the reason was dropped, so the board got a blocked card with no why. It is applied
// now, which means it is also type-checked now — a number no longer passes silently.
test('POST /tasks applies blocker rather than refusing or eating it', async () => {
  const bad = await send('/tasks', 'POST', { project: 'NOPE', title: 'x', blocker: 123 });
  expect(bad.status).toBe(400);
  expect(bad.error).toContain('blocker must be a string or null');
  const refused = await send('/tasks', 'POST', { project: 'NOPE', title: 'x', blocker: 'waiting on the schema' });
  expect(refused.error).not.toContain('not settable');
});

// create-time fields must NOT be refused by the sweep, or the guard would break the route it guards
test('POST /tasks still accepts what a task is created with', async () => {
  for (const [field, value] of [['origin', 'raj slack'], ['lane', null], ['parentTaskRef', 'DAR-1'], ['notes', 'x']] as const) {
    const r = await send('/tasks', 'POST', { project: 'NOPE', title: 'x', [field]: value });
    expect(r.error, `${field} was refused`).not.toContain('not settable');
  }
});

test('POST /feedback refuses a status or a resolution instead of filing pending and saying nothing', async () => {
  const s = await send('/feedback', 'POST', { project: 'NOPE', body: 'x', status: 'accepted' });
  expect(s.status).toBe(400);
  expect(s.error).toContain('always pending');
  const r = await send('/feedback', 'POST', { project: 'NOPE', body: 'x', resolution: 'done' });
  expect(r.status).toBe(400);
  expect(r.error).toContain('resolution');
  const linked = await send('/feedback', 'POST', { project: 'NOPE', body: 'x', resolvedTaskRef: 'DAR-1' });
  expect(linked.status).toBe(400);
  expect(linked.error).toContain('PATCH /feedback/:shortId');
});

test('POST /feedback still accepts everything a row is filed with', async () => {
  for (const [field, value] of [['taskRef', 'DAR-1'], ['type', 'design'], ['author', 'Raj'], ['authorType', 'human'], ['attachments', ['http://x/y.png']]] as const) {
    const r = await send('/feedback', 'POST', { project: 'NOPE', body: 'x', [field]: value });
    expect(r.error, `${field} was refused`).not.toContain('not settable');
  }
});

test('POST /events refuses a backdated at instead of stamping now and reading as fresh', async () => {
  const r = await send('/events', 'POST', { project: 'NOPE', text: 'x', at: '2026-01-01T00:00:00.000Z' });
  expect(r.status).toBe(400);
  expect(r.error).toContain('at');
  expect(r.error).toContain('backdated');
});

// ---------- DAR-182: what an append writes ----------
// The whole design rests on one property, so it is asserted directly rather than inferred from the
// route: the text already on the row survives byte for byte, and everything new is attributed.

const ADD = { author: 'Raj', at: new Date('2026-08-09T12:30:00.000Z'), note: 'its the facts cal field', attachments: ['http://localhost:4899/files/a.png'] };

test('an append never rewrites what is already in the body', () => {
  const before = 'the calendar picker jumps a month when you tab out';
  const after = appendedBody(before, ADD);
  expect(after.startsWith(before)).toBe(true);
  expect(after.slice(0, before.length)).toBe(before);
});

test('an append says who added it, when, and how much evidence came with it', () => {
  const after = appendedBody('original', ADD);
  expect(after).toContain('[Raj added this on 2026-08-09T12:30:00.000Z, with 1 attachment]');
  expect(after).toContain('its the facts cal field');
});

test('the attachment count is stated only when there is one, and pluralises', () => {
  expect(appendedBody('x', { ...ADD, attachments: [] })).toContain('[Raj added this on 2026-08-09T12:30:00.000Z]');
  expect(appendedBody('x', { ...ADD, attachments: [] })).not.toContain('attachment');
  expect(appendedBody('x', { ...ADD, attachments: ['a', 'b'] })).toContain('with 2 attachments');
});

test('evidence with no words still lands as an attributed line, never as an empty edit', () => {
  const after = appendedBody('original', { ...ADD, note: '' });
  expect(after).toBe('original\n\n[Raj added this on 2026-08-09T12:30:00.000Z, with 1 attachment]');
});

test('an append to an empty body is the line alone, with no leading blank', () => {
  expect(appendedBody('', ADD)).toBe('[Raj added this on 2026-08-09T12:30:00.000Z, with 1 attachment] its the facts cal field');
});

// "not one byte of what is already there changes" has to be literally true, or it is not the
// property the route claims. The first cut trimEnd'd the existing body, so a row whose body ended in
// whitespace lost those bytes to a call that was only supposed to add.
test('an append does not trim the body it is appending to', () => {
  const messy = 'the picker jumps  \n\n  ';
  expect(appendedBody(messy, ADD).startsWith(messy)).toBe(true);
  expect(appendedBody(' ', ADD)).toBe(` \n\n${appendedBody('', ADD)}`);
});

test('appends stack, oldest first, each one attributed', () => {
  const one = appendedBody('original', ADD);
  const two = appendedBody(one, { ...ADD, author: 'Tanisha', note: 'same on the mobile layout', attachments: [] });
  expect(two.indexOf('original')).toBe(0);
  expect(two.indexOf('[Raj added')).toBeLessThan(two.indexOf('[Tanisha added'));
});

// a feedback body is quoted back into slack by Gabbar's get_feedback, and the charter bans em
// dashes and AI-tell phrasing in anything that reaches slack
test('the append line is plain prose with no em dashes', () => {
  const after = appendedBody('original', ADD);
  expect(after).not.toContain('—');
  expect(after).not.toContain(' - ');
});
