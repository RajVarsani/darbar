// DAR-276: the drain watcher. Everything here exercises drainFile/scanOnce directly against a
// stubbed `remember` — no mongo, no real HTTP, no live server — since the only contract this
// module owes is "parse the file correctly, call remember, and only delete on 2xx".
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { drainFile, scanOnce, type RememberFn } from './memory-inbox';

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
  const full = write('a.md', FIXTURE);
  const remember: RememberFn = async () => ({ ok: true, status: 200, json: {} });
  await scanOnce(RIG, { remember, log: () => {} });
  expect(existsSync(full)).toBe(false);
});

test('a 500 from remember leaves the file in place and logs once', async () => {
  const full = write('b.md', FIXTURE);
  let logs = 0;
  const remember: RememberFn = async () => ({ ok: false, status: 500, json: { error: 'db down' } });
  await scanOnce(RIG, { remember, log: () => { logs++; } });
  expect(existsSync(full)).toBe(true);
  expect(logs).toBeGreaterThanOrEqual(1);
});

test('MEMORY.md is never drained, even if it sits in the inbox', async () => {
  const full = write('MEMORY.md', '# index\n\nsome generated content');
  const calls: unknown[] = [];
  const remember: RememberFn = async (body) => { calls.push(body); return { ok: true, status: 200, json: {} }; };
  await scanOnce(RIG, { remember, log: () => {} });
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
