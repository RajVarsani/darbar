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

// ---------- held ADDITIONS (DAR-219) ----------
// A refused append used to be held nowhere, so a non-stakeholder adding a screenshot to an existing
// finding lost it. Holding one is only safe if it can never be promoted the way a report is: filing
// a row for evidence that belongs on an existing finding is the duplicate DAR-182 removed. These
// pin the distinction, and the wording that stops a held addition reading as one that landed.
const addition = (over: Partial<Parameters<typeof P.parkAddition>[0]> = {}) => P.parkAddition({
  ...input({ feedbackType: 'addition', body: 'it also happens on the settings screen', ...over }),
  appendTo: 'MRF-FB-23',
  ...over,
});

test('a refused addition is held, and knows it belongs on a row rather than in a new one', () => {
  const item = addition();
  expect(item.kind).toBe('addition');
  expect(item.appendTo).toBe('MRF-FB-23');
  expect(P.readParked(item.parkId)?.kind).toBe('addition');
  // a park id is still a park id: it cannot be mistaken for the feedback id it names
  expect(P.isParkId(item.parkId)).toBe(true);
  expect(item.parkId).not.toMatch(/-FB-\d+$/);
  expect(item.parkId.startsWith('PARK-')).toBe(true);
});

test('a held addition reads as not filed AND not added to its row', () => {
  const s = P.summarize(addition());
  expect(s.filed).toBe(false);
  expect(s.parked).toBe(true);
  expect(s.kind).toBe('addition');
  expect(s.appendTo).toBe('MRF-FB-23'); // where it belongs
  expect(s.addedToRow).toBe(false); // and the fact that it never got there, next to it
  expect(s.promotedTo).toBeNull();
});

test('a report still carries no feedback id anywhere in its summary', () => {
  const s = P.summarize(P.parkReport(input()));
  expect(s.kind).toBe('report');
  expect(s.appendTo).toBeNull();
  expect(s.addedToRow).toBeNull();
  expect(JSON.stringify(s)).not.toMatch(/-FB-\d+/);
});

test('one message refused a filing AND an append holds both, not one over the other', () => {
  // the same slack message, two refusals: keying both on the message alone lost the first one
  const report = P.parkReport(input());
  const add = addition();
  expect(add.parkId).not.toBe(report.parkId);
  const all = P.listParked({ status: 'parked' });
  expect(all).toHaveLength(2);
  expect(P.listParked({ status: 'parked', kind: 'addition' })).toHaveLength(1);
  expect(P.readParked(report.parkId)?.body).toBe(input().body);
});

test('one message adding to two different rows holds two additions', () => {
  addition();
  addition({ appendTo: 'MRF-FB-99', body: 'and this one is on the other row' });
  expect(P.listParked({ status: 'parked', kind: 'addition' })).toHaveLength(2);
});

test('a message that goes on to append for real retires only that row addition', () => {
  const onFb23 = addition();
  const onFb99 = addition({ appendTo: 'MRF-FB-99' });
  P.markSuperseded('D0AH8292D7Y', '1754771234.123456', 'MRF-FB-23', 'MRF-FB-23');
  expect(P.readParked(onFb23.parkId)?.status).toBe('superseded');
  expect(P.readParked(onFb99.parkId)?.status).toBe('parked');
});

test('an addition that lost its row id is never quietly relabelled a report', async () => {
  // the one relabelling that would put the DAR-182 duplicate back: a report is the only kind that
  // can be promoted by FILING a row, so a broken addition waits instead of becoming promotable
  const broken = { ...addition(), parkId: 'PARK-broken_addition', appendTo: null } as Record<string, unknown>;
  await Bun.write(path.join(RIG, 'PARK-broken_addition.json'), JSON.stringify(broken));
  const read = P.readParked('PARK-broken_addition');
  expect(read?.kind).toBe('addition');
  expect(read?.appendTo).toBeNull();
});

test('a record written before additions existed reads as a report', async () => {
  const legacy = { ...P.parkReport(input()), parkId: 'PARK-legacy_kind' } as Record<string, unknown>;
  delete legacy.kind; delete legacy.appendTo;
  await Bun.write(path.join(RIG, 'PARK-legacy_kind.json'), JSON.stringify(legacy));
  const read = P.readParked('PARK-legacy_kind');
  expect(read?.kind).toBe('report'); // which is what those files actually are
  expect(read?.appendTo).toBeNull();
});

test('a held addition joins the same rotation as a report, not a queue of its own', () => {
  // the sweep spends its budget on ONE question, "is this sender a stakeholder on that project",
  // and the answer is identical for both kinds, so they group and take turns together
  const held = [P.parkAddition({ ...input({ projectRef: 'ALPHA', projectName: 'ALPHA' }), appendTo: 'ALPHA-FB-1' }), parkOnAlpha()];
  const plan = P.planSweep(held, 5);
  expect(plan).toHaveLength(1);
  expect(plan[0]!.target).toEqual({ project: 'ALPHA' });
  expect(plan[0]!.items).toHaveLength(2);
});
function parkOnAlpha() {
  return P.parkReport(input({ ts: '1754771299.000001', projectRef: 'ALPHA', projectName: 'ALPHA' }));
}

test('a landed addition is announced as landing on its row, never as a filing', () => {
  const out = P.withFilingNotice('nice one', [], ['MRF-FB-23']);
  expect(out).toContain('is now on MRF-FB-23');
  expect(out).not.toContain('filed');
  // both at once still read correctly, and a reply that already said it is left alone
  expect(P.withFilingNotice('hey', ['MRF-FB-7'], ['MRF-FB-23'])).toContain('now filed as MRF-FB-7; what you were adding earlier was being held and is now on MRF-FB-23');
  expect(P.withFilingNotice('added it to MRF-FB-23', [], ['MRF-FB-23'])).toBe('added it to MRF-FB-23');
});

test('the digest says an addition was never ADDED, not that it was never filed', () => {
  const { text } = P.buildEscalationDigest([addition()], Date.now());
  expect(text).toContain('an addition is still held and was NEVER added to the row it names');
  expect(text).toContain('an addition to MRF-FB-23 that was NEVER added to it');
  expect(text).toContain('that row is unchanged');
  expect(text).toContain('it never becomes a second row');
  expect(text).not.toMatch(/https?:\/\//);
});

test('a mixed backlog counts both kinds instead of calling them all reports', () => {
  const { text } = P.buildEscalationDigest([P.parkReport(input()), addition(), addition({ appendTo: 'MRF-FB-99' })], Date.now());
  expect(text).toContain('3 items are still held: 1 report never filed, and 2 additions never added to the rows they name');
  expect(text).toContain('nothing here is filed');
  expect(text).toContain('those rows are unchanged');
});

test('a reports-only digest is worded exactly as it was', () => {
  const { text } = P.buildEscalationDigest([P.parkReport(input())], Date.now());
  expect(text).toContain('a report is still held and NOT filed:');
  expect(text).not.toContain('addition');
  expect(text).not.toMatch(/-FB-\d+/);
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

test('escalating an outage buys a day of quiet, then it comes back', () => {
  const now = Date.now();
  const item = aged(input({ cause: 'outage' }), 5 * DAY);
  expect(P.dueForEscalation(now)).toHaveLength(1);

  P.markEscalated(item.parkId, new Date(now));
  expect(P.readParked(item.parkId)?.escalations).toBe(1);
  expect(P.dueForEscalation(now)).toHaveLength(0);
  // and it does NOT go quiet forever: still held tomorrow means told again tomorrow
  expect(P.dueForEscalation(now + DAY + 1000)).toHaveLength(1);
});

// ---------- the repeat is weekly now that the board carries the same report ----------
// The daily repeat was set when the owner DM was the only place a held report existed. The board's
// Feedback view now shows every one of them with reporter, cause, age, verbatim words, attachments,
// whether the owner has been told, and the remedy, so a daily DM nags about something already on
// screen. What the DM still uniquely does is reach somebody who is NOT looking, and that is worth
// less often. These pin the new ladder, and the one cause that keeps the daily push.
const escalatedAgo = (item: ParkedItem, createdMsAgo: number, escalatedMsAgo: number, now: number): ParkedItem => ({
  ...item,
  createdAt: new Date(now - createdMsAgo).toISOString(),
  escalatedAt: new Date(now - escalatedMsAgo).toISOString(),
  escalations: 1,
});

test('an already-reported gap waits a week, not a day: the board is carrying it', () => {
  const now = Date.now();
  const gap = P.parkReport(input({ cause: 'stakeholder_gap' }));
  // told 25h ago, held 2 days: the old daily rule would have fired again by now
  expect(P.dueForEscalation(now, [escalatedAgo(gap, 2 * DAY, 25 * HOUR, now)])).toHaveLength(0);
  expect(P.dueForEscalation(now, [escalatedAgo(gap, 5 * DAY, 3 * DAY, now)])).toHaveLength(0);
});

test('an outage keeps the daily push: a held outage is a fault, not a queue', () => {
  const now = Date.now();
  const out = P.parkReport(input({ cause: 'outage' }));
  expect(P.dueForEscalation(now, [escalatedAgo(out, 2 * DAY, 25 * HOUR, now)])).toHaveLength(1);
  expect(P.dueForEscalation(now, [escalatedAgo(out, 2 * DAY, 2 * HOUR, now)])).toHaveLength(0);
});

// THE ASSERTION THAT WOULD HAVE CAUGHT THE FIRST ATTEMPT AT THIS. Escalating an old item back to
// daily was tried and dropped: a daily DM about a report held for months does not raise pressure,
// it teaches the owner to skim the digest, which costs tomorrow's report its one safety net. It was
// also unreachable, since a week after a 1h-or-24h first ping is already past any week-old mark, so
// "weekly" would have been a bound that never once held. Weekly means weekly, at any age.
test('a report held for months is still weekly, never promoted back to daily', () => {
  const now = Date.now();
  const gap = P.parkReport(input({ cause: 'stakeholder_gap' }));
  const ref = P.parkReport(input({ ts: '1754771234.777777', cause: 'bad_reference' }));
  for (const [age, told] of [[40 * DAY, 25 * HOUR], [90 * DAY, 3 * DAY], [400 * DAY, 6 * DAY]] as const) {
    expect(P.dueForEscalation(now, [escalatedAgo(gap, age, told, now)])).toHaveLength(0);
    expect(P.dueForEscalation(now, [escalatedAgo(ref, age, told, now)])).toHaveLength(0);
  }
  // and it is silence, not amnesia: the week comes round and it is told again
  expect(P.dueForEscalation(now, [escalatedAgo(gap, 400 * DAY, 7 * DAY + HOUR, now)])).toHaveLength(1);
});

// The ladder, pinned end to end, so "weekly" is a claim the code has to keep rather than a word in
// a comment. A stakeholder gap: first ping on the 24h clock, then one every seven days, forever.
test('the ladder is one early ping and then a reminder a week, at every age', () => {
  const T = Date.parse('2026-08-01T00:00:00.000Z');
  const run = (cause: 'stakeholder_gap' | 'outage', hours: number) => {
    let item: ParkedItem = { ...P.parkReport(input({ cause })), createdAt: new Date(T).toISOString(), escalatedAt: null, escalations: 0 };
    const pings: number[] = [];
    for (let h = 0; h <= hours; h++) {
      const now = T + h * HOUR;
      if (!P.dueForEscalation(now, [item]).length) continue;
      pings.push(h);
      item = { ...item, escalatedAt: new Date(now).toISOString(), escalations: item.escalations + 1 };
    }
    return pings;
  };
  // 24h, then day 8, 15, 22, 29, 36: no day-7 switch, no daily tail
  expect(run('stakeholder_gap', 40 * 24)).toEqual([24, 24 + 7 * 24, 24 + 14 * 24, 24 + 21 * 24, 24 + 28 * 24, 24 + 35 * 24]);
  // an outage is the one that stays daily, and it starts within the hour
  expect(run('outage', 5 * 24)).toEqual([1, 25, 49, 73, 97]);
});

test('the gap between reminders is a function of the cause and of nothing else', () => {
  const now = Date.now();
  const gap = P.parkReport(input({ cause: 'stakeholder_gap' }));
  expect(P.repeatEscalationMs(gap)).toBe(7 * DAY);
  expect(P.repeatEscalationMs({ ...gap, cause: 'bad_reference' })).toBe(7 * DAY);
  expect(P.repeatEscalationMs({ ...gap, cause: 'outage' })).toBe(DAY);
  // age cannot move it, and neither can a createdAt nothing can parse
  for (const createdAt of [new Date(now - HOUR).toISOString(), new Date(now - 500 * DAY).toISOString(), 'not a date']) {
    expect(P.repeatEscalationMs({ ...gap, createdAt })).toBe(7 * DAY);
    expect(P.repeatEscalationMs({ ...gap, cause: 'outage', createdAt })).toBe(DAY);
  }
});

test('a longer cadence still never deletes anything and still never escalates what is filed', () => {
  const item = aged(input({ cause: 'stakeholder_gap' }), 90 * DAY);
  expect(P.dueForEscalation(Date.now())).toHaveLength(1); // 90 days on, still owed a reminder
  expect(P.readParked(item.parkId)?.status).toBe('parked');
  P.markPromoted(item.parkId, 'MRF-FB-4', 'Raj');
  expect(P.dueForEscalation(Date.now())).toHaveLength(0);
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
  expect(text).toContain('nothing here is filed');
  expect(text).not.toMatch(/-FB-\d+/);
  expect(text).toContain('report number 0'); // the oldest is named, not an arbitrary 30
});

test('a small backlog is listed in full with no count line', () => {
  const { text, listed, omitted } = P.buildEscalationDigest([P.parkReport(input())], Date.now());
  expect(listed).toBe(1);
  expect(omitted).toBe(0);
  expect(text).toContain('a report is still held and NOT filed');
  expect(text).not.toContain('not listed here');
  // the board carries held reports now, so the digest no longer claims otherwise. What it must
  // still never do is imply something was filed, or hand over a link instead of the words.
  expect(text).toContain('nothing here is filed. no feedback id, no triage queue, no orchestrator working it.');
  expect(text).not.toContain('none of this is on a board');
  expect(text).not.toMatch(/https?:\/\//);
});

test('the digest ages items against the clock it was given', () => {
  const item = aged(input(), 3 * HOUR);
  const { text } = P.buildEscalationDigest([item], Date.now() + 25 * HOUR);
  expect(text).toContain('held 28h'); // not 3h: the injected clock is what counts
});
