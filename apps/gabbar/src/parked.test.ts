// The parking lot's one hard invariant: a held report can never pass for filed feedback.
//
// DAR-183 came from a refusal throwing a real bug report away. Holding it instead is only safe
// if the held copy is unmistakably NOT feedback, so these tests pin the properties that keep it
// that way: its own id namespace, filed:false on every read, and terminal states that cannot be
// walked back into "still waiting".
//
// Isolation: parked.ts resolves its directory from PARKED_DIR at import, so the rig sets that
// before the dynamic import and cleans up afterwards. data/parked/ on this machine is untouched.
import { afterAll, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ParkedItem } from './parked';

const RIG = mkdtempSync(path.join(tmpdir(), 'darbar-parked-'));
process.env.PARKED_DIR = RIG;
const P = await import('./parked');

afterAll(() => rmSync(RIG, { recursive: true, force: true }));
beforeEach(() => {
  for (const f of readdirSync(RIG)) rmSync(path.join(RIG, f), { force: true });
});

const input = (over: Partial<Parameters<typeof P.parkReport>[0]> = {}) => ({
  channel: 'D0AH8292D7Y',
  ts: '1754771234.123456',
  threadTs: null,
  authorId: 'U0TANISHA',
  authorName: 'Tanisha',
  projectRef: 'MRF',
  projectName: 'MRF v3',
  taskRef: null,
  feedbackType: 'bug',
  body: 'calendar shifts position when switching months',
  rawMessage: 'the calendar moves when i change the month, video attached',
  attachments: ['http://localhost:4899/files/rec.mov'],
  mediaNotes: ['video rec.mov -> http://localhost:4899/files/rec.mov frames: .../f01.jpg'],
  gateKind: 'not_stakeholder',
  gateDetail: 'Tanisha (U0TANISHA) is not a stakeholder on MRF v3',
  cause: 'stakeholder_gap' as const,
  ...over,
});

test('a park id can never be mistaken for a feedback id', () => {
  const item = P.parkReport(input());
  expect(item.parkId.startsWith('PARK-')).toBe(true);
  expect(item.parkId).not.toMatch(/-FB-\d+$/);
  for (const real of ['DAR-FB-1', 'MRF-FB-42', 'DAR-181', 'PARK', 'park-abc']) {
    expect(P.isParkId(real)).toBe(false);
    expect(P.readParked(real)).toBeNull();
  }
  expect(P.isParkId(item.parkId)).toBe(true);
});

test('every read of a held report carries filed:false and no feedback id', () => {
  const item = P.parkReport(input());
  const s = P.summarize(item);
  expect(s.filed).toBe(false);
  expect(s.parked).toBe(true);
  expect(s.status).toBe('parked');
  expect(s.promotedTo).toBeNull();
  expect(JSON.stringify(s)).not.toMatch(/-FB-\d+/);
});

test('the report and the words survive the refusal verbatim', () => {
  const item = P.parkReport(input());
  const held = P.readParked(item.parkId);
  expect(held?.rawMessage).toBe('the calendar moves when i change the month, video attached');
  expect(held?.attachments).toEqual(['http://localhost:4899/files/rec.mov']);
  expect(held?.mediaNotes[0]).toContain('frames:');
  expect(held?.gate.detail).toContain('not a stakeholder');
});

test('one slack message parks once, and a retry refines it instead of duplicating', () => {
  P.parkReport(input({ projectRef: null, projectName: null, gateKind: 'bad_ref' }));
  P.parkReport(input({ body: 'calendar flips above the input on month change' }));
  const all = P.listParked();
  expect(all).toHaveLength(1);
  expect(all[0]?.body).toBe('calendar flips above the input on month change');
  expect(all[0]?.target.projectName).toBe('MRF v3');
});

test('two different messages park separately', () => {
  P.parkReport(input());
  P.parkReport(input({ ts: '1754779999.000100', body: 'second report' }));
  expect(P.listParked({ status: 'parked' })).toHaveLength(2);
});

test('promotion is terminal: it leaves the queue and cannot be re-parked', () => {
  const item = P.parkReport(input());
  const promoted = P.markPromoted(item.parkId, 'MRF-FB-7', 'Raj via gabbar');
  expect(promoted?.status).toBe('promoted');
  expect(promoted?.promotion?.feedbackShortId).toBe('MRF-FB-7');
  expect(P.listParked({ status: 'parked' })).toHaveLength(0);

  // a later refusal on the same message must not resurrect it as "still waiting"
  const again = P.parkReport(input({ body: 'tampered' }));
  expect(again.status).toBe('promoted');
  expect(again.body).toBe('calendar shifts position when switching months');
  expect(P.markPromoted(item.parkId, 'MRF-FB-9', 'someone else')).toBeNull();

  // and it still reads as not-filed-by-itself, with the real id kept separate
  const s = P.summarize(P.readParked(item.parkId)!);
  expect(s.filed).toBe(false);
  expect(s.promotedTo).toBe('MRF-FB-7');
});

test('a message that goes on to file for real retires its held copy', () => {
  const item = P.parkReport(input());
  P.markSuperseded('D0AH8292D7Y', '1754771234.123456', 'MRF-FB-8');
  expect(P.listParked({ status: 'parked' })).toHaveLength(0);
  expect(P.readParked(item.parkId)?.supersededBy).toBe('MRF-FB-8');
});

test('held reports are listed per author, so one sender never sees another', () => {
  P.parkReport(input());
  P.parkReport(input({ ts: '1754770000.000200', authorId: 'U0OTHER', authorName: 'Someone' }));
  const mine = P.listParked({ status: 'parked', authorId: 'U0TANISHA' });
  expect(mine).toHaveLength(1);
  expect(mine[0]?.author.name).toBe('Tanisha');
});

test('a corrupt file is skipped, not fatal', async () => {
  P.parkReport(input());
  await Bun.write(path.join(RIG, 'PARK-broken.json'), '{ not json');
  expect(P.listParked()).toHaveLength(1);
});

// The sweep files a row in someone's name; they must hear about it even if the model forgets.
// A bare "thanks yaar" once got "welcome, what's up" while a real row had just been created.
test('a filing the reply forgot to mention is announced anyway', () => {
  expect(P.withFilingNotice('welcome, what\'s up', ['MRF-FB-7']))
    .toBe('welcome, what\'s up\n\nalso: your earlier report that was being held is now filed as MRF-FB-7.');
  expect(P.withFilingNotice('hey', ['MRF-FB-7', 'MRF-FB-8']))
    .toContain('are now filed as MRF-FB-7 and MRF-FB-8');
});

test('a reply that already names the id is left alone', () => {
  const said = 'filed your earlier one as MRF-FB-7, orchestrator has it now';
  expect(P.withFilingNotice(said, ['MRF-FB-7'])).toBe(said);
  expect(P.withFilingNotice('nothing to report', [])).toBe('nothing to report');
});

test('only the ids the reply missed get appended', () => {
  const out = P.withFilingNotice('filed MRF-FB-7 for you', ['MRF-FB-7', 'MRF-FB-8']);
  expect(out).toContain('is now filed as MRF-FB-8');
  expect(out.match(/MRF-FB-7/g)).toHaveLength(1);
});

// ---------- the escalation clock ----------
// Parking fixed "a refusal loses the report" and left a smaller version of it: a held item
// nobody is told about sits in a directory until a human reads it. These pin the bound.
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const aged = (over: Parameters<typeof P.parkReport>[0], msAgo: number) => {
  const item = P.parkReport(over);
  const older = { ...item, createdAt: new Date(Date.now() - msAgo).toISOString() };
  // sync: the very next line reads it back through listParked, so an unawaited write is a race
  writeFileSync(path.join(RIG, `${item.parkId}.json`), JSON.stringify(older, null, 2));
  return older;
};

test('an outage surfaces within the hour, because nobody was told at all', () => {
  const now = Date.now();
  const item = { ...P.parkReport(input({ cause: 'outage' })), createdAt: new Date(now - 61 * 60_000).toISOString() };
  expect(P.dueForEscalation(now, [item])).toHaveLength(1);
  const fresh = { ...item, createdAt: new Date(now - 5 * 60_000).toISOString() };
  expect(P.dueForEscalation(now, [fresh])).toHaveLength(0);
});

test('a stakeholder gap waits a day, because the owner was already pinged once', () => {
  const now = Date.now();
  const gap = { ...P.parkReport(input({ cause: 'stakeholder_gap' })), createdAt: new Date(now - 2 * HOUR).toISOString() };
  expect(P.dueForEscalation(now, [gap])).toHaveLength(0); // an outage would already be due here
  expect(P.dueForEscalation(now, [{ ...gap, createdAt: new Date(now - 25 * HOUR).toISOString() }])).toHaveLength(1);
});

test('escalating once buys a day of quiet, then it comes back', () => {
  const now = Date.now();
  const item = aged(input({ cause: 'outage' }), 5 * DAY);
  expect(P.dueForEscalation(now)).toHaveLength(1);

  P.markEscalated(item.parkId, new Date(now));
  expect(P.readParked(item.parkId)?.escalations).toBe(1);
  expect(P.dueForEscalation(now)).toHaveLength(0);
  // and it does NOT go quiet forever: still held tomorrow means told again tomorrow
  expect(P.dueForEscalation(now + DAY + 1000)).toHaveLength(1);
});

test('a held report is never deleted, only escalated', () => {
  const item = aged(input({ cause: 'bad_reference' }), 30 * DAY);
  P.markEscalated(item.parkId, new Date());
  const held = P.readParked(item.parkId);
  expect(held?.status).toBe('parked'); // a month old and still here, on purpose
  expect(held?.rawMessage).toBe(input().rawMessage);
});

test('what is already filed is never escalated', () => {
  const item = aged(input(), 30 * DAY);
  P.markPromoted(item.parkId, 'MRF-FB-3', 'Raj');
  expect(P.dueForEscalation(Date.now())).toHaveLength(0);
  P.markEscalated(item.parkId);
  expect(P.readParked(item.parkId)?.escalations).toBe(0);
});

test('the digest line says held, names the cause, and quotes no feedback id', () => {
  const line = P.escalationLine(aged(input({ cause: 'outage' }), 3 * HOUR));
  expect(line).toContain('held 3h');
  expect(line).toContain('Tanisha');
  expect(line).toContain('darbar could not be reached');
  expect(line).not.toMatch(/-FB-\d+/);
  expect(P.escalationLine(aged(input({ ts: '1754771234.999999' }), 2 * DAY))).toContain('not a stakeholder on MRF v3');
});

test('a record written before causes existed reads as a gap, not as retryable', async () => {
  const legacy = { ...P.parkReport(input()), parkId: 'PARK-legacy' } as Record<string, unknown>;
  delete legacy.cause; delete legacy.escalatedAt; delete legacy.escalations;
  await Bun.write(path.join(RIG, 'PARK-legacy.json'), JSON.stringify(legacy));
  const read = P.readParked('PARK-legacy');
  expect(read?.cause).toBe('stakeholder_gap'); // waits for a human rather than retrying quietly
  expect(read?.escalations).toBe(0);
  expect(read?.escalatedAt).toBeNull();
});

// ---------- the retry budget: fairness, not age ----------
// The previous fix dropped items with no target, which is only ONE way to be unpromotable. A
// stakeholder_gap item has a perfectly good target and stays refusable until a human acts, so
// age ordering pinned the budget to the same items forever. These pin the class instead.
const BUDGET = 5;
const parkOn = (project: string | null, over: Partial<Parameters<typeof P.parkReport>[0]> = {}) =>
  P.parkReport(input({ ts: `1754${Math.random().toString().slice(2, 12)}`, projectRef: project, projectName: project, ...over }));

const attemptedAgo = (item: ParkedItem, msAgo: number | null) => {
  const next = { ...item, lastAttemptAt: msAgo === null ? null : new Date(Date.now() - msAgo).toISOString() };
  writeFileSync(path.join(RIG, `${item.parkId}.json`), JSON.stringify(next, null, 2));
  return next;
};

test('items sharing a target cost ONE gate check, not one each', () => {
  const held = Array.from({ length: 20 }, () => parkOn('ALPHA'));
  const plan = P.planSweep(held, BUDGET);
  expect(plan).toHaveLength(1); // twenty reports, one darbar round trip
  expect(plan[0]!.items).toHaveLength(20);
  expect(plan[0]!.target).toEqual({ project: 'ALPHA' });
});

test('five blocked items on ONE project cannot crowd out a sixth on another', () => {
  const blocked = Array.from({ length: 5 }, () => parkOn('ALPHA'));
  const promotable = parkOn('BETA');
  const plan = P.planSweep([...blocked, promotable], BUDGET);
  expect(plan.map((g) => g.target)).toContainEqual({ project: 'BETA' });
  expect(plan).toHaveLength(2);
});

test('five blocked items on FIVE DIFFERENT projects still cannot crowd out a sixth', () => {
  // the case the previous fix missed entirely: every one of these has a resolvable target
  const blocked = ['A', 'B', 'C', 'D', 'E'].map((p) => attemptedAgo(parkOn(p), 60_000));
  const fresh = parkOn('NEW'); // never attempted
  const plan = P.planSweep([...blocked, fresh], BUDGET);
  expect(plan[0]!.target).toEqual({ project: 'NEW' }); // never-attempted goes first
  expect(plan.map((g) => g.target)).toContainEqual({ project: 'NEW' });
});

test('every held item gets a turn rather than the same ones every message', () => {
  const targets = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
  let held = targets.map((t) => parkOn(t));
  const seen = new Set<string>();
  // two sweeps is ceil(7 targets / 5) rounded up, so everything must have been reached by then
  for (let round = 0; round < 2; round++) {
    const plan = P.planSweep(held, BUDGET);
    const now = Date.now() + round * 1000;
    held = held.map((item) => {
      const attempted = plan.some((g) => g.items.some((i) => i.parkId === item.parkId));
      if (attempted) seen.add(item.target.projectRef!);
      return attempted ? attemptedAgo(item, -(now - Date.now())) : item;
    });
  }
  expect([...seen].sort()).toEqual(targets);
});

test('an item with no resolvable target never enters the plan', () => {
  const plan = P.planSweep([parkOn(null), parkOn(null), parkOn('REAL')], BUDGET);
  expect(plan).toHaveLength(1);
  expect(plan[0]!.target).toEqual({ project: 'REAL' });
});

test('a task target and a project target are different targets', () => {
  const byTask = parkOn(null, { taskRef: 'ALPHA-1' });
  const plan = P.planSweep([byTask, parkOn('ALPHA')], BUDGET);
  expect(plan).toHaveLength(2);
  expect(plan.map((g) => g.target)).toContainEqual({ taskRef: 'ALPHA-1' });
});

test('recording an attempt is what lets somebody else go next', () => {
  const item = parkOn('ALPHA');
  expect(P.readParked(item.parkId)?.lastAttemptAt).toBeNull();
  P.markAttempted([item.parkId]);
  expect(P.readParked(item.parkId)?.lastAttemptAt).not.toBeNull();
  // and it never resurrects something already filed
  const done = parkOn('BETA');
  P.markPromoted(done.parkId, 'MRF-FB-1', 'Raj');
  P.markAttempted([done.parkId]);
  expect(P.readParked(done.parkId)?.status).toBe('promoted');
});

// ---------- the digest has to fit in a slack message ----------
test('a big backlog names the oldest, counts the rest, and stays sendable', () => {
  const many = Array.from({ length: 200 }, (_, i) => ({
    ...P.parkReport(input({ ts: `17547${String(i).padStart(5, '0')}` })),
    createdAt: new Date(Date.now() - (200 - i) * 3_600_000).toISOString(),
    rawMessage: `report number ${i} `.repeat(20),
  }));
  const { text, listed, omitted } = P.buildEscalationDigest(many, Date.now());
  expect(listed).toBe(P.MAX_DIGEST_LINES);
  expect(omitted).toBe(200 - P.MAX_DIGEST_LINES);
  expect(text.length).toBeLessThan(40_000); // slack's hard limit, which 200 lines blew past
  expect(text).toContain('200 reports are still held and NOT filed');
  expect(text).toContain(`and ${omitted} more held reports not listed here`);
  expect(text).toContain('none of this is on a board');
  expect(text).not.toMatch(/-FB-\d+/);
  expect(text).toContain('report number 0'); // the oldest is named, not an arbitrary 30
});

test('a small backlog is listed in full with no count line', () => {
  const { text, listed, omitted } = P.buildEscalationDigest([P.parkReport(input())], Date.now());
  expect(listed).toBe(1);
  expect(omitted).toBe(0);
  expect(text).toContain('a report is still held and NOT filed');
  expect(text).not.toContain('not listed here');
});

test('the digest ages items against the clock it was given', () => {
  const item = aged(input(), 3 * HOUR);
  const { text } = P.buildEscalationDigest([item], Date.now() + 25 * HOUR);
  expect(text).toContain('held 28h'); // not 3h: the injected clock is what counts
});
