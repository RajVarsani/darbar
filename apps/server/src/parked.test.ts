// The held-report lane, on both sides of the wire.
//
// Two things are pinned here, and the second one is why this file exists at all.
//
// THE PARSER reads a directory another process writes, in a format nothing enforces, so it is fed
// the shapes that directory can really contain: prose, a bare array, an empty file, a record with
// the wrong type in every field, a legacy record with no cause, somebody else's .json, and a
// missing directory. None of it may throw, none of it may 500, and none of it may quietly turn a
// held report into nothing — a report we cannot show is worse than one we know we cannot show.
//
// THE REMEDY BUILDER shipped a shell-injection: it interpolated the reporter's display name into a
// single-quoted `curl ... -d '<json>'` and put the result on the clipboard, so a display name of
// ';touch /tmp/PWNED;' closed the quote and ran the rest when the operator pasted it, and a reporter
// called O'Brien produced an unterminated quote. The name is the slack profile of somebody who by
// definition just failed the stakeholder check, so that input is hostile by construction. The fix
// removed the affordance rather than escaping it: the board calls the API itself and untrusted text
// never becomes a word of anything. What is asserted below is that PROPERTY, not the absence of one
// bug — no clipboard payload, no command anywhere in the band, and untrusted bytes only ever in a
// text node or a tooltip, never in an attribute that does something.
//
// Isolation: the rig is set two ways, because the env var alone was not enough. bun runs every test
// file in ONE process, so @darbar/core builds config from the environment as it stood when the FIRST
// file imported it, and api.ts used to resolve the directory once at its own import. This file
// therefore only worked while it happened to be the first importer of api.ts in the run, and a new
// test file sorting ahead of it silently pointed the parser at a different directory. api.ts now
// resolves the path per read, and the rig is written onto config as well as into the environment, so
// neither this file's position in the run nor anyone else's matters.
// data/parked/ on this machine is never read and never created. Nothing here touches Mongo: the
// project-scoped read does, so the tests use the unscoped one, which is the same parser.
import { afterAll, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const RIG = mkdtempSync(path.join(tmpdir(), 'darbar-parked-api-'));
process.env.PARKED_DIR = RIG;
const { config } = await import('@darbar/core');
config.parkedDir = RIG;
const { api } = await import('./api');

afterAll(() => rmSync(RIG, { recursive: true, force: true }));
beforeEach(() => {
  mkdirSync(RIG, { recursive: true });
  for (const f of readdirSync(RIG)) rmSync(path.join(RIG, f), { force: true });
});

const write = (name: string, body: string) => writeFileSync(path.join(RIG, name), body);
const park = (name: string, o: unknown) => write(`${name}.json`, JSON.stringify(o));
const held = (over: Record<string, unknown> = {}) => ({
  status: 'parked',
  createdAt: '2026-08-05T10:00:00.000Z',
  author: { name: 'Priya Nair', slackUserId: 'U08SXQF8RTQ' },
  target: { projectRef: 'PKT', projectName: 'Parked Kit' },
  feedbackType: 'bug',
  body: 'the board drops the last column on a narrow window',
  rawMessage: 'hey gabbar the board drops the last column when my window is narrow',
  attachments: [],
  mediaNotes: [],
  gate: { kind: 'stakeholder_gap', detail: 'not a stakeholder on PKT' },
  cause: 'stakeholder_gap',
  ...over,
});

type Read = {
  dirPresent: boolean; error: string | null; files: number; ignored: number; scanned: number;
  truncated: boolean; unreadable: number; held: number; returned: number;
  items: { parkId: string; filed: boolean; author: string; cause: string; status: string; type: string }[];
};
const get = async (headers: Record<string, string> = {}): Promise<{ status: number; body: Read }> => {
  const r = await api.request('/parked', { headers });
  return { status: r.status, body: (await r.json()) as Read };
};

// ---------- the parser ----------

test('every shape that directory can really hold parses, and nothing held goes missing', async () => {
  park('PARK-C1_1_001', held());
  park('PARK-C1_1_002', held({ cause: undefined })); // legacy: parked before causes existed
  park('PARK-C1_1_003', held({ status: 7, author: 'not an object', target: [], attachments: 'x', body: null }));
  write('PARK-C1_1_004.json', 'this is not json, it is prose');
  write('PARK-C1_1_005.json', '[1,2,3]');
  write('PARK-C1_1_006.json', '""');
  write('PARK-C1_1_007.json', '');
  write('notes.json', '{"mine":true}');       // somebody else's file
  write('PARK-nope!.json', '{"a":1}');        // .json, PARK-ish, not a park id
  write('PARK-C1_1_008.txt', 'not json at all');

  const { status, body } = await get();
  expect(status).toBe(200);
  expect(body.dirPresent).toBe(true);
  expect(body.error).toBeNull();
  // 7 PARK-* .json files. The stray notes.json and the malformed PARK-nope! are NOT held reports we
  // failed to read, and counting them as unreadable made the band announce a lost report there was
  // never any evidence for. They are counted apart.
  expect(body.files).toBe(7);
  expect(body.ignored).toBe(2);
  expect(body.unreadable).toBe(4); // prose, array, bare string, empty
  expect(body.returned).toBe(3);
  expect(body.truncated).toBe(false);
});

test('a report with no cause reads as stakeholder_gap, the same word gabbar uses', async () => {
  park('PARK-C1_1_002', held({ cause: undefined }));
  const { body } = await get();
  expect(body.items[0]!.cause).toBe('stakeholder_gap');
});

test('a record with the wrong type in every field still renders as a held report', async () => {
  park('PARK-C1_1_003', held({ status: 7, author: 'not an object', target: [], feedbackType: 9, body: null, rawMessage: {} }));
  const { body } = await get();
  expect(body.items).toHaveLength(1);
  expect(body.items[0]).toMatchObject({ author: 'unknown', status: 'parked', type: 'bug', filed: false });
});

test('filed is literally false and the id is a PARK id, on every row', async () => {
  park('PARK-C1_1_001', held());
  park('PARK-C1_1_002', held({ author: { name: 'Sam', slackUserId: 'U09BBBBBBBB' } }));
  const { body } = await get();
  expect(body.items).toHaveLength(2);
  for (const i of body.items) {
    expect(i.filed).toBe(false);
    expect(i.parkId.startsWith('PARK-')).toBe(true);
  }
});

test('no directory means none held, not an error', async () => {
  rmSync(RIG, { recursive: true, force: true });
  const { status, body } = await get();
  expect(status).toBe(200);
  expect(body.dirPresent).toBe(false);
  expect(body.error).toBeNull();
  expect(body.files).toBe(0);
  expect(body.items).toHaveLength(0);
});

// ---------- the exposure boundary ----------
// This used to hold only because data/routes.json does not publish '/api/parked' — true, and one
// character from false ('/api/p' without the slash publishes it, as do '/api/' and '/api/*').
// The route now asserts it itself, on the same header the proxy's own isPublic() switches on.
test('a tunneled request cannot read held reports, whatever routes.json says', async () => {
  park('PARK-C1_1_001', held());
  const r = await api.request('/parked', { headers: { 'x-forwarded-host': 'darbar.ngrok.app' } });
  expect(r.status).toBe(403);
  expect(await r.text()).not.toContain('PARK-C1_1_001');
});

// ---------- the remedy builder, out of the real board ----------
// board.html is one file with its script inline, so the functions under test are lifted out of it by
// anchor and evaluated with the real esc(). The anchors are asserted, so a rename breaks this loudly
// instead of quietly testing nothing.
const BOARD = readFileSync(new URL('../web/board.html', import.meta.url).pathname, 'utf-8');
function lift(from: string, to: string): string {
  const a = BOARD.indexOf(from);
  const b = BOARD.indexOf(to, a + 1);
  if (a < 0 || b < 0) throw new Error(`board.html anchors moved (${from} … ${to}) — this test is reading source that no longer exists`);
  return BOARD.slice(a, b);
}
type Band = {
  heldFix: (i: Record<string, unknown>) => { t: string; p: string; act: Record<string, string> | null };
  heldRowHtml: (i: Record<string, unknown>) => string;
};
const state: Record<string, unknown> = {};
const band: Band = new Function('state', 'stubs', `
  const {initials, ageShort, relTime, nice, safeUrl} = stubs;
  ${lift('const esc = s =>', '\n')}
  ${lift('const CAUSE_LABEL', 'function heldBandHtml')}
  return {heldFix, heldRowHtml};
`)(state, {
  initials: (n: string) => String(n ?? '').slice(0, 2).toUpperCase(),
  ageShort: () => '4d',
  relTime: () => '4 days ago',
  nice: (s: string) => String(s || '').replace(/_/g, ' '),
  safeUrl: (a: string) => /^(https?:\/\/|\/)/i.test(String(a || '')),
});

const PWN = `';touch /tmp/darbar-should-never-exist;'`;
const item = (over: Record<string, unknown> = {}) => ({
  parkId: 'PARK-C1_1_001', filed: false, parked: true, status: 'parked',
  author: 'Priya Nair', authorSlackId: 'U08SXQF8RTQ',
  project: 'Parked Kit', projectRef: 'PKT', onTask: null, type: 'bug',
  body: 'the export button does nothing', theirWords: 'the export button does nothing on safari',
  theirWordsTruncated: false, attachments: [], mediaNotes: [],
  heldSince: '2026-08-05T10:00:00.000Z', cause: 'stakeholder_gap',
  reasonParked: 'not a stakeholder on PKT', escalatedAt: null, lastAttemptAt: null, promotedTo: null,
  ...over,
});
const board = (over: Record<string, unknown> = {}) => {
  state.data = { project: { prefix: 'PKT', name: 'Parked Kit', stakeholders: [] } };
  state.parkOpen = new Set(['PARK-C1_1_001']);
  state.parkArm = null;
  Object.assign(state, over);
};
// untrusted text is allowed to be SHOWN — as a text node, or as a tooltip nobody executes. What it
// may never be is the value of an attribute that does something.
const actionableAttrs = (html: string) =>
  [...html.matchAll(/([a-zA-Z-]+)="([^"]*)"/g)].filter((m) => m[1] !== 'title').map((m) => m[2]!);

test('a display name that breaks out of a shell quote produces no command at all', () => {
  board();
  const i = item({ author: PWN });
  const fix = band.heldFix(i);
  // the remedy is structured data now: a name is a value, not a word of a command
  expect(fix.act).toEqual({ parkId: 'PARK-C1_1_001', name: PWN, slackUserId: 'U08SXQF8RTQ', prefix: 'PKT' });
  expect(JSON.stringify(fix)).not.toContain('curl');

  const html = band.heldRowHtml(i);
  expect(html).not.toContain('data-copy');   // nothing on this surface reaches a clipboard
  expect(html).not.toContain('curl');
  expect(html).not.toContain("-d '");
  for (const v of actionableAttrs(html)) expect(v).not.toContain('touch /tmp');
  // and it is still shown, which is the whole point of keeping the report
  expect(html).toContain('touch /tmp/darbar-should-never-exist');
});

test("an ordinary reporter called O'Brien is not a special case any more", () => {
  board();
  const html = band.heldRowHtml(item({ author: "Aoife O'Brien" }));
  expect(html).toContain("Aoife O'Brien");
  expect(html).not.toContain('curl');
  for (const v of actionableAttrs(html)) expect(v).not.toContain("O'Brien");
});

test('the armed confirm carries the park id and nothing else', () => {
  board({ parkArm: 'PARK-C1_1_001' });
  const html = band.heldRowHtml(item({ author: PWN }));
  expect(html).toContain('data-register="PARK-C1_1_001"');
  const registers = [...html.matchAll(/data-register="([^"]*)"/g)].map((m) => m[1]);
  expect(registers).toEqual(['PARK-C1_1_001']);
  // the grant is spelled out before it fires, and the name in it is escaped text
  expect(html).toContain('the standing right to file feedback on PKT');
  for (const v of actionableAttrs(html)) expect(v).not.toContain('touch /tmp');
});

test('markup in a display name stays markup-shaped text', () => {
  board();
  const html = band.heldRowHtml(item({ author: '<script>alert(1)</script>', theirWords: '<img src=x onerror=alert(1)>' }));
  expect(html).not.toContain('<script');
  expect(html).not.toContain('<img');
  expect(html).toContain('&lt;script&gt;');
});

test('a project ref from the parked file never addresses the write route', () => {
  board({ data: { project: null } });
  const fix = band.heldFix(item({ projectRef: 'PKT/../../evil' }));
  expect(fix.act).toBeNull(); // no project on the board means no action, not a ref off the file
  expect(JSON.stringify(fix)).not.toContain('evil');
});

test('a slack id that can never clear the gate gets no button', () => {
  board();
  for (const bad of ['', 'not-an-id', 'C09CHANNELID', '@priya', 'U08 SXQF8RTQ']) {
    const fix = band.heldFix(item({ authorSlackId: bad }));
    expect(fix.act).toBeNull();
    expect(band.heldRowHtml(item({ authorSlackId: bad }))).not.toContain('data-arm=');
  }
});

test('somebody already registered is told so instead of offered a duplicate grant', () => {
  board();
  (state.data as { project: { stakeholders: unknown[] } }).project.stakeholders = [{ name: 'Priya Nair', slackUserId: 'U08SXQF8RTQ' }];
  const fix = band.heldFix(item());
  expect(fix.act).toBeNull();
  expect(fix.p).toContain('already registered');
});

test('a cause named after a prototype key renders as a cause, not as native code', () => {
  board();
  for (const cause of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    const html = band.heldRowHtml(item({ cause, reasonParked: '' }));
    expect(html).not.toContain('native code');
    expect(html).not.toContain('[object');
  }
});
