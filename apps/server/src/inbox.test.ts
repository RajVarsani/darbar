// The doorbell on the orchestrator inbox (DAR-245).
//
// What is pinned here is the small set of properties the whole design rests on, and nothing else.
// A doorbell that rings on the orchestrator's own writes is worse than no doorbell, because it turns
// every triage into a wake and the session never gets to stop; a doorbell that hands over a partial
// queue is worse still, because the item it left out looks handled. So:
//
//  · the inbox is pending feedback and held reports, and NOTHING the orchestrator itself does can
//    add to it (triage, promotion, resolution all move a row out of `pending`)
//  · needs_clarification is not inbox work: that row is with the reporter
//  · a wake carries the WHOLE queue; the cursor only decides whether it rings
//  · a reopen rings, because that is a person coming back
//  · the wait actually blocks and actually fires, in real time, on a real POST
//  · it is local-only, like every other orchestrator surface
//
// Timings are deliberately short here (hundreds of ms against a 6 hour default) so a wait that never
// fires fails the run instead of hanging it.
import { afterAll, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { config } from '@darbar/core';
import { api, req, reset, teardown, project, feedback } from './test-harness';

// Held reports live in a directory another process writes. This file gets its own, and puts back
// whatever was configured when it loaded: bun runs every test file in one process and parked.test.ts
// points the same config field at a rig of its own.
const RIG = mkdtempSync(path.join(tmpdir(), 'darbar-inbox-'));
const ORIGINAL_PARKED = config.parkedDir;

beforeEach(async () => {
  await reset();
  config.parkedDir = RIG;
  mkdirSync(RIG, { recursive: true });
  for (const f of readdirSync(RIG)) rmSync(path.join(RIG, f), { force: true });
});

afterAll(async () => {
  config.parkedDir = ORIGINAL_PARKED;
  rmSync(RIG, { recursive: true, force: true });
  await teardown();
});

type Inbox = {
  woke: boolean;
  items: { kind: string; id: string; at: string }[];
  newSince: string[];
  nextCursor: string;
  pendingCount: number;
  heldCount: number;
  note?: string;
};

/** the streaming route: read to close, and the last non-blank line is the payload */
async function wait(ref: string, q: string): Promise<Inbox> {
  const r = await api.request(`/projects/${ref}/inbox/wait?${q}`);
  const text = await r.text();
  const last = text.split('\n').map((l) => l.trim()).filter(Boolean).pop();
  if (!last) throw new Error(`wait stream closed with no payload: ${JSON.stringify(text)}`);
  return JSON.parse(last) as Inbox;
}

const heldFile = (parkId: string, over: Record<string, unknown> = {}) =>
  writeFileSync(path.join(RIG, `${parkId}.json`), JSON.stringify({
    status: 'parked',
    createdAt: new Date().toISOString(),
    author: { name: 'Abhishek', slackUserId: 'U07UJ38U2RK' },
    feedbackType: 'idea',
    body: 'held idea',
    rawMessage: 'held idea',
    gate: { kind: 'stakeholder_gap', detail: 'not a stakeholder' },
    ...over,
  }));

// ---------- what counts as inbox work ----------

test('a filed row is inbox work; every triage verb takes it back out', async () => {
  const p = await project();
  const fb = await feedback({ project: p.prefix, body: 'the board drops a column' });

  const filed = await req<Inbox>('GET', `/projects/${p.prefix}/inbox`);
  expect(filed.body.woke).toBe(true);
  expect(filed.body.newSince).toEqual([fb.shortId]);
  expect(filed.body.pendingCount).toBe(1);

  // the orchestrator's own act on a pending row, which must never be able to ring its own doorbell
  await req('PATCH', `/feedback/${fb.shortId}`, { status: 'triaged' });
  const after = await req<Inbox>('GET', `/projects/${p.prefix}/inbox`);
  expect(after.body.woke).toBe(false);
  expect(after.body.items).toEqual([]);
  expect(after.body.pendingCount).toBe(0);
});

test('needs_clarification is with the reporter, so it is not in the inbox', async () => {
  const p = await project();
  const fb = await feedback({ project: p.prefix, body: 'vague' });
  await req('PATCH', `/feedback/${fb.shortId}`, { status: 'needs_clarification', resolution: 'which screen?' });
  const r = await req<Inbox>('GET', `/projects/${p.prefix}/inbox`);
  expect(r.body.pendingCount).toBe(0);
  expect(r.body.items).toEqual([]);
});

test('a held report is inbox work, and promoted ones are not', async () => {
  const p = await project();
  heldFile('PARK-held1', { target: { projectRef: p.prefix } });
  heldFile('PARK-done1', { status: 'promoted', target: { projectRef: p.prefix } });
  const r = await req<Inbox>('GET', `/projects/${p.prefix}/inbox`);
  expect(r.body.heldCount).toBe(1);
  expect(r.body.items.map((i) => i.id)).toEqual(['PARK-held1']);
  expect(r.body.items[0]!.kind).toBe('parked');
});

// ---------- the cursor decides whether it rings, never what it sends ----------

test('a wake carries the whole queue, and newSince names only the new part', async () => {
  const p = await project();
  const older = await feedback({ project: p.prefix, body: 'first' });
  const snap = await req<Inbox>('GET', `/projects/${p.prefix}/inbox`);
  const cursor = snap.body.nextCursor;

  await Bun.sleep(5);
  const newer = await feedback({ project: p.prefix, body: 'second' });

  const r = await req<Inbox>('GET', `/projects/${p.prefix}/inbox?cursor=${encodeURIComponent(cursor)}`);
  expect(r.body.newSince).toEqual([newer.shortId]);
  // the whole point: the row it already told us about is still on the payload, so a wake can never
  // hand over half a queue
  expect(r.body.items.map((i) => i.id).sort()).toEqual([older.shortId, newer.shortId].sort());
  expect(r.body.pendingCount).toBe(2);
});

test('an empty inbox leaves the caller cursor standing rather than stamping now', async () => {
  const p = await project();
  const cursor = '2026-08-01T00:00:00.000Z';
  const r = await req<Inbox>('GET', `/projects/${p.prefix}/inbox?cursor=${encodeURIComponent(cursor)}`);
  expect(r.body.woke).toBe(false);
  expect(r.body.nextCursor).toBe(cursor);
});

// ---------- the wait itself ----------

test('the wait returns at once when something is already newer than the cursor', async () => {
  const p = await project();
  const fb = await feedback({ project: p.prefix, body: 'already here' });
  const started = Date.now();
  const out = await wait(p.prefix, 'waitMs=5000');
  expect(out.woke).toBe(true);
  expect(out.newSince).toEqual([fb.shortId]);
  expect(Date.now() - started).toBeLessThan(2000);
});

test('the wait blocks, then fires on a real POST /feedback', async () => {
  const p = await project();
  const snap = await req<Inbox>('GET', `/projects/${p.prefix}/inbox`);
  const armed = wait(p.prefix, `waitMs=5000&cursor=${encodeURIComponent(snap.body.nextCursor)}`);

  await Bun.sleep(120); // long enough that a wait which never blocked would already have answered
  const fb = await feedback({ project: p.prefix, body: 'filed while it was waiting' });

  const out = await armed;
  expect(out.woke).toBe(true);
  expect(out.newSince).toEqual([fb.shortId]);
  expect(out.note).toContain('re-arm');
});

test('the wait times out quietly when the orchestrator is the only one writing', async () => {
  const p = await project();
  const fb = await feedback({ project: p.prefix, body: 'already triaged by the time we arm' });
  const snap = await req<Inbox>('GET', `/projects/${p.prefix}/inbox`);
  const armed = wait(p.prefix, `waitMs=700&cursor=${encodeURIComponent(snap.body.nextCursor)}`);

  await Bun.sleep(80);
  await req('PATCH', `/feedback/${fb.shortId}`, { status: 'accepted' });

  const out = await armed;
  expect(out.woke).toBe(false);
  expect(out.newSince).toEqual([]);
  expect(out.pendingCount).toBe(0);
});

test('a reopen rings, because that is a person coming back', async () => {
  const p = await project();
  const fb = await feedback({ project: p.prefix, body: 'thought this was done' });
  await req('PATCH', `/feedback/${fb.shortId}`, { status: 'triaged' });
  const snap = await req<Inbox>('GET', `/projects/${p.prefix}/inbox`);
  const armed = wait(p.prefix, `waitMs=5000&cursor=${encodeURIComponent(snap.body.nextCursor)}`);

  await Bun.sleep(120);
  await req('PATCH', `/feedback/${fb.shortId}`, { status: 'pending' });

  const out = await armed;
  expect(out.woke).toBe(true);
  expect(out.newSince).toEqual([fb.shortId]);
});

test('a report parked while the wait is armed rings it too', async () => {
  const p = await project();
  const armed = wait(p.prefix, 'waitMs=30000');
  await Bun.sleep(80);
  heldFile('PARK-latecomer', { target: { projectRef: p.prefix } });

  const out = await armed;
  expect(out.woke).toBe(true);
  expect(out.newSince).toEqual(['PARK-latecomer']);
  expect(out.heldCount).toBe(1);
}, 40_000);

// ---------- boundaries ----------

test('both inbox routes are local-only', async () => {
  const p = await project();
  for (const p2 of [`/projects/${p.prefix}/inbox`, `/projects/${p.prefix}/inbox/wait`]) {
    const r = await api.request(p2, { headers: { 'x-forwarded-host': 'darbar.ngrok.app' } });
    expect(r.status).toBe(403);
    expect(await r.text()).toContain('local-only');
  }
});

test('a cursor or a waitMs this route cannot use is a 400, not a silent default', async () => {
  const p = await project();
  const bad = await req('GET', `/projects/${p.prefix}/inbox?cursor=yesterday`);
  expect(bad.status).toBe(400);
  expect(bad.error).toContain('ISO timestamp');

  const badWait = await req('GET', `/projects/${p.prefix}/inbox?waitMs=soon`);
  expect(badWait.status).toBe(400);
  expect(badWait.error).toContain('positive number');

  const missing = await req('GET', '/projects/NOPE/inbox');
  expect(missing.status).toBe(404);
});
