// DAR-276: the drain watcher. Everything here exercises drainFile/scanOnce directly against a
// stubbed `remember` — no mongo, no real HTTP, no live server — since the only contract this
// module owes is "parse the file correctly, call remember, and only delete on 2xx".
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync, utimesSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { drainFile, scanOnce, writeMemoryIndex, type RememberFn, type FetchIndexFn } from './memory-inbox';

// every scanOnce test in this file that doesn't care about the index write stubs fetchIndex too
// (no mongo, no real HTTP, no live server, same rule as remember) — otherwise the default hits
// the real live darbar server on config.port.
const NOOP_FETCH_INDEX: FetchIndexFn = async () => ({ ok: true, status: 200, text: '# index\n\nstub' });

let RIG: string;
beforeEach(() => {
  RIG = mkdtempSync(path.join(tmpdir(), 'darbar-memory-inbox-'));
});
afterEach(() => {
  rmSync(RIG, { recursive: true, force: true });
});

function write(name: string, content: string): string {
  const full = path.join(RIG, name);
  writeFileSync(full, content, 'utf8');
  return full;
}

// scanOnce (both the boot scan and the watcher-debounced tick) skips anything modified in the last
// 2s, so a test that wants an IMMEDIATE drain has to backdate mtime past that window.
function writeAged(name: string, content: string): string {
  const full = write(name, content);
  const old = new Date(Date.now() - 5000);
  utimesSync(full, old, old);
  return full;
}

const FIXTURE = `---
name: chrome-profiles-for-x
description: "Which Chrome profile has Raj's X login"
metadata:
  node_type: memory
  type: feedback
  project: virality-machine
---

Chrome profile \`Default\` is the personal profile. See [[user-raj-creator-profile]].
`;

test('a fixture file is parsed and remember is called with the parsed node, then the file is removed on 2xx', async () => {
  const full = write('chrome-profiles-for-x.md', FIXTURE);
  const calls: unknown[] = [];
  const remember: RememberFn = async (body) => {
    calls.push(body);
    return { ok: true, status: 200, json: { ok: true } };
  };

  const ok = await drainFile(full, { remember, log: () => {} });
  expect(ok).toBe(true);

  // first call is the node + observation write
  const first = calls[0] as { node: { name: string; type: string; project?: string }; observations: string[] };
  expect(first.node.name).toBe('chrome-profiles-for-x');
  expect(first.node.type).toBe('gotcha'); // feedback -> gotcha
  expect(first.node.project).toBe('virality-machine');
  expect(first.observations[0]).toContain("Which Chrome profile has Raj's X login");
  expect(first.observations[0]).toContain('Chrome profile `Default`');

  // second call is the wikilink edge attempt
  const second = calls[1] as { edges: { to: string; relation: string }[] };
  expect(second.edges[0]).toEqual({ to: 'user-raj-creator-profile', relation: 'RELATES_TO' });
});

test('scanOnce deletes the file after a successful drain', async () => {
  const full = writeAged('a.md', FIXTURE);
  const remember: RememberFn = async () => ({ ok: true, status: 200, json: {} });
  await scanOnce(RIG, { remember, fetchIndex: NOOP_FETCH_INDEX, log: () => {} });
  expect(existsSync(full)).toBe(false);
});

test('a 500 from remember leaves the file in place and logs once', async () => {
  const full = writeAged('b.md', FIXTURE);
  let logs = 0;
  const remember: RememberFn = async () => ({ ok: false, status: 500, json: { error: 'db down' } });
  await scanOnce(RIG, { remember, fetchIndex: NOOP_FETCH_INDEX, log: () => { logs++; } });
  expect(existsSync(full)).toBe(true);
  expect(logs).toBeGreaterThanOrEqual(1);
});

test('MEMORY.md is never drained, even if it sits in the inbox', async () => {
  const full = writeAged('MEMORY.md', '# index\n\nsome generated content');
  const calls: unknown[] = [];
  const remember: RememberFn = async (body) => { calls.push(body); return { ok: true, status: 200, json: {} }; };
  await scanOnce(RIG, { remember, fetchIndex: NOOP_FETCH_INDEX, log: () => {} });
  expect(calls.length).toBe(0);
  expect(existsSync(full)).toBe(true);
});

test('memory.md (any case) is never drained either', async () => {
  const full = writeAged('memory.md', '# index\n\nsome generated content');
  const calls: unknown[] = [];
  const remember: RememberFn = async (body) => { calls.push(body); return { ok: true, status: 200, json: {} }; };
  await scanOnce(RIG, { remember, fetchIndex: NOOP_FETCH_INDEX, log: () => {} });
  expect(calls.length).toBe(0);
  expect(existsSync(full)).toBe(true);
});

test('a wikilink to a node that does not exist yet is skipped (logged), but the node itself still drains', async () => {
  const full = write('c.md', FIXTURE);
  const logs: string[] = [];
  const remember: RememberFn = async (body) => {
    const b = body as { edges?: unknown[] };
    if (b.edges) return { ok: false, status: 404, json: { error: 'no node named ... remember it first' } };
    return { ok: true, status: 200, json: {} };
  };
  const ok = await drainFile(full, { remember, log: (m) => logs.push(m) });
  expect(ok).toBe(true);
  expect(logs.some((l) => l.includes('user-raj-creator-profile') && l.includes('skipping edge'))).toBe(true);
});

// ---------- DAR-286 rework: BLOCKER, a mid-write file must never be ingested or deleted ----------

const UNCLOSED_FRONTMATTER = `---
name: mrf-v3-state
description: "the real title"
metadata:
  type: project
`;

test('the exact review probe (frontmatter opened but never closed) is not drained and the file survives', async () => {
  const full = writeAged('mid-write.md', UNCLOSED_FRONTMATTER);
  const calls: unknown[] = [];
  const logs: string[] = [];
  const remember: RememberFn = async (body) => { calls.push(body); return { ok: true, status: 200, json: {} }; };
  const ok = await drainFile(full, { remember, log: (m) => logs.push(m) });
  expect(ok).toBe(false);
  expect(calls.length).toBe(0); // never ingested
  expect(existsSync(full)).toBe(true); // never unlinked (caller only deletes on ok===true)
  expect(logs.some((l) => l.includes('mid-write.md') && l.includes('incomplete'))).toBe(true);
});

test('the same file, completed on the next tick, drains correctly', async () => {
  const full = writeAged('mid-write.md', UNCLOSED_FRONTMATTER);
  const remember: RememberFn = async () => ({ ok: true, status: 200, json: {} });
  const first = await drainFile(full, { remember, log: () => {} });
  expect(first).toBe(false);

  // the writer finishes: closing fence + body now present
  writeFileSync(full, `${UNCLOSED_FRONTMATTER}---\n\nthe rest of the body, written after the frontmatter.\n`, 'utf8');
  const calls: unknown[] = [];
  const remember2: RememberFn = async (body) => { calls.push(body); return { ok: true, status: 200, json: {} }; };
  const second = await drainFile(full, { remember: remember2, log: () => {} });
  expect(second).toBe(true);
  const node = calls[0] as { node: { name: string; type: string } };
  expect(node.node.name).toBe('mrf-v3-state');
  expect(node.node.type).toBe('project');
});

test('scanOnce skips a file modified within the last 2 seconds, even via the boot-scan path', async () => {
  const full = write('fresh.md', FIXTURE); // NOT aged: mtime is "now"
  const calls: unknown[] = [];
  const remember: RememberFn = async (body) => { calls.push(body); return { ok: true, status: 200, json: {} }; };
  await scanOnce(RIG, { remember, fetchIndex: NOOP_FETCH_INDEX, log: () => {} });
  expect(calls.length).toBe(0);
  expect(existsSync(full)).toBe(true);
});

test('an empty body and description is treated as incomplete, not ingested', async () => {
  const full = writeAged('empty.md', `---
name: some-node
metadata:
  type: project
---
`);
  const calls: unknown[] = [];
  const logs: string[] = [];
  const remember: RememberFn = async (body) => { calls.push(body); return { ok: true, status: 200, json: {} }; };
  const ok = await drainFile(full, { remember, log: (m) => logs.push(m) });
  expect(ok).toBe(false);
  expect(calls.length).toBe(0);
  expect(logs.some((l) => l.includes('incomplete'))).toBe(true);
});

// ---------- DAR-284: metadata.type: reference maps to the graph's own 'reference' type ----------

test('metadata.type reference maps to the graph reference type, not decision', async () => {
  const full = writeAged('ref.md', `---
name: metabase-dashboard-link
description: "the RCA dashboard"
metadata:
  type: reference
---

https://metabase.example/dashboard/1
`);
  const calls: unknown[] = [];
  const remember: RememberFn = async (body) => { calls.push(body); return { ok: true, status: 200, json: {} }; };
  await drainFile(full, { remember, log: () => {} });
  const first = calls[0] as { node: { type: string } };
  expect(first.node.type).toBe('reference');
});

// ---------- LOW: stripQuotes unescapes \" and \\ ----------

test('a quoted description with escaped quotes and backslashes is unescaped', async () => {
  const full = writeAged('escaped.md', `---
name: escaped-node
description: "she said \\"hi\\" then a path C:\\\\temp"
metadata:
  type: project
---

body text.
`);
  const calls: unknown[] = [];
  const remember: RememberFn = async (body) => { calls.push(body); return { ok: true, status: 200, json: {} }; };
  await drainFile(full, { remember, log: () => {} });
  const first = calls[0] as { observations: string[] };
  expect(first.observations[0]).toContain('she said "hi" then a path C:\\temp');
});

test('unknown metadata.type falls back to the closest graph type and logs which', async () => {
  const full = write('d.md', `---
name: some-weird-note
metadata:
  type: mystery
---

body text here.
`);
  const calls: unknown[] = [];
  const logs: string[] = [];
  const remember: RememberFn = async (body) => { calls.push(body); return { ok: true, status: 200, json: {} }; };
  await drainFile(full, { remember, log: (m) => logs.push(m) });
  const first = calls[0] as { node: { type: string } };
  expect(first.node.type).toBe('decision');
  expect(logs.some((l) => l.includes('mystery') && l.includes('decision'))).toBe(true);
});

// ---------- DAR-288: the watcher owns MEMORY.md, generated from the global index ----------

test('after a drain the inbox MEMORY.md equals the header plus the stubbed index body', async () => {
  writeAged('e.md', FIXTURE);
  const remember: RememberFn = async () => ({ ok: true, status: 200, json: {} });
  const fetchIndex: FetchIndexFn = async () => ({ ok: true, status: 200, text: '# Memory index — global\n\nsome node lines\n' });
  await scanOnce(RIG, { remember, fetchIndex, log: () => {} });
  const written = readFileSync(path.join(RIG, 'MEMORY.md'), 'utf8');
  expect(written).toBe(
    '<!-- generated by darbar from the memory graph; edits here are overwritten; write memory with the remember tool -->\n\n' +
    '# Memory index — global\n\nsome node lines\n',
  );
});

test('a MEMORY.md that Claude appended lines to is replaced wholesale on the next drain', async () => {
  writeFileSync(path.join(RIG, 'MEMORY.md'), '# stale header\n\n- [[topic-claude-appended]] some pointer\n', 'utf8');
  const remember: RememberFn = async () => ({ ok: true, status: 200, json: {} });
  const fetchIndex: FetchIndexFn = async () => ({ ok: true, status: 200, text: '# Memory index — global\n\nfresh content\n' });
  await scanOnce(RIG, { remember, fetchIndex, log: () => {} });
  const written = readFileSync(path.join(RIG, 'MEMORY.md'), 'utf8');
  expect(written).not.toContain('topic-claude-appended');
  expect(written).toContain('fresh content');
});

test('boot (scanOnce on an empty inbox) still writes MEMORY.md from the index', async () => {
  const remember: RememberFn = async () => ({ ok: true, status: 200, json: {} });
  const fetchIndex: FetchIndexFn = async () => ({ ok: true, status: 200, text: '# Memory index — global\n\nboot content\n' });
  await scanOnce(RIG, { remember, fetchIndex, log: () => {} });
  const written = readFileSync(path.join(RIG, 'MEMORY.md'), 'utf8');
  expect(written).toContain('boot content');
});

test('a failed index fetch leaves a pre-existing MEMORY.md untouched and logs once', async () => {
  writeFileSync(path.join(RIG, 'MEMORY.md'), '# whatever was there before\n', 'utf8');
  const remember: RememberFn = async () => ({ ok: true, status: 200, json: {} });
  const fetchIndex: FetchIndexFn = async () => ({ ok: false, status: 500, text: 'boom' });
  let logs = 0;
  await scanOnce(RIG, { remember, fetchIndex, log: () => { logs++; } });
  const written = readFileSync(path.join(RIG, 'MEMORY.md'), 'utf8');
  expect(written).toBe('# whatever was there before\n');
  expect(logs).toBeGreaterThanOrEqual(1);
});

test('writeMemoryIndex itself: a thrown fetchIndex error leaves a pre-existing MEMORY.md untouched', async () => {
  writeFileSync(path.join(RIG, 'MEMORY.md'), '# untouched\n', 'utf8');
  const fetchIndex: FetchIndexFn = async () => { throw new Error('ECONNREFUSED'); };
  let logs = 0;
  await writeMemoryIndex(RIG, { remember: async () => ({ ok: true, status: 200, json: {} }), fetchIndex, log: () => { logs++; } });
  const written = readFileSync(path.join(RIG, 'MEMORY.md'), 'utf8');
  expect(written).toBe('# untouched\n');
  expect(logs).toBe(1);
});
