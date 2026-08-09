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
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

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
