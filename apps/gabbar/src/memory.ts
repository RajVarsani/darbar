// DAR-282 (gabbar half of DAR-276). Exposes Anthropic's memory tool (memory_20250818) to the
// model, same as before, but the store behind it is no longer a markdown directory: it is darbar's
// memory graph over HTTP (POST /api/memory/remember, GET /api/memory/recall, POST
// /api/memory/supersede — shapes in apps/server/src/api.ts, tool prose in apps/mcp/src/server.ts).
//
// Every call goes through fetchDarbar (agent.ts), never a raw fetch: that is what gives memory
// writes the same per-request timeout, message budget and reachable/unreachable classification
// every other darbar call in gabbar gets, and it is what lookups.test.ts's "config.apiUrl appears
// nowhere outside fetchDarbar" guard enforces across this whole package. Importing fetchDarbar from
// agent.ts while agent.ts imports memoryTool from here is a circular import, but a safe one: both
// sides only ever CALL the other's export from inside a function body, never at module-eval time
// (lookups.ts already does exactly this for the same reason — see its header comment).
//
// MEMORY_DIR (packages/core config) is unused from here on. It is left alone rather than removed:
// removing the env var is a config-surface change outside this file's scope, and a stale MEMORY_DIR
// in somebody's .env must not crash gabbar. Flagged here for whoever eventually deletes it.
//
// PATH MAPPING. The model still addresses memory as /memories/<category>/<name>, because that is
// the shape already baked into its system prompt and its habits, and DAR-282 asks to keep that
// interface as close as possible rather than teach it a new one. Underneath, a path is now just:
//   - node TYPE, inferred from the top-level segment: people/ -> person, projects/ -> project,
//     preferences/ -> preference, anything else -> gotcha (the catch-all durable-fact bucket)
//   - node NAME, from the last segment with .md stripped and dashes/underscores turned to spaces
//   - PROJECT SCOPE, only when the path is itself under projects/<ref>[...]: that segment is the
//     project ref darbar resolves. Every other path is global, same as the old single shared vault.
// recall() then searches "global plus the project when the conversation has one" for free: passing
// `project` to /memory/recall matches that project OR null (see resolveMemoryScope in api.ts), and
// a path with no projects/ segment simply never sets one, so it searches global only.
import { config, MEMORY_NODE_TYPES, slugify, type MemoryNodeType } from '@darbar/core';
import { betaMemoryTool } from '@anthropic-ai/sdk/helpers/beta/memory';
import fs from 'node:fs';
import path from 'node:path';
import { fetchDarbar } from './agent';

void MEMORY_NODE_TYPES; // kept imported for readers checking the type list matches typeForSegments below

// tolerate a stale MEMORY_DIR rather than crash on it; nothing here reads it
void config.memoryDir;

// ---------- path -> (type, name, project) ----------

function segmentsOf(p: string): string[] {
  return p
    .replace(/^\/?memories\/?/, '')
    .split('/')
    .map((s) => s.trim())
    .filter(Boolean);
}

function typeForSegments(segments: string[]): MemoryNodeType {
  switch (segments[0]) {
    case 'people':
      return 'person';
    case 'projects':
      return 'project';
    case 'preferences':
      return 'preference';
    default:
      return 'gotcha';
  }
}

function nameForSegments(segments: string[]): string {
  const last = segments[segments.length - 1] ?? '';
  const base = last.replace(/\.md$/i, '').replace(/[-_]+/g, ' ').trim();
  return base || 'notes';
}

function projectRefForSegments(segments: string[]): string | undefined {
  if (segments[0] === 'projects' && segments[1]) {
    return segments[1].replace(/\.md$/i, '');
  }
  return undefined;
}

function parsePath(p: string): { segments: string[]; type: MemoryNodeType; name: string; project: string | undefined } {
  const segments = segmentsOf(p);
  return { segments, type: typeForSegments(segments), name: nameForSegments(segments), project: projectRefForSegments(segments) };
}

// ---------- held writes: darbar outage must not lose what the model wanted to remember ----------
//
// Same shape as parked.ts's hold (mkdir + write-to-.tmp + rename, so a crash mid-write never leaves
// a half-written file), deliberately not shared code with it: parked.ts's ParkedItem carries a
// slack-message identity and a promotion/sweep lifecycle that a memory write has no use for. This
// is the minimum that satisfies the same invariant — an unreachable darbar holds the words instead
// of dropping them — without inventing a sweep nothing here calls.
const holdRoot = (): string =>
  path.resolve(process.env.MEMORY_HOLD_DIR || new URL('../../../data/memory-hold/', import.meta.url).pathname);

// leading zero-padded counter so two holds written in the same millisecond still sort by creation
// order (holdRoot's readdir + filename sort is how drainHeld() decides replay order below).
let holdSeq = 0;

function holdWrite(kind: 'remember' | 'supersede', originalPath: string, body: Record<string, unknown>, detail: string): string {
  const dir = holdRoot();
  fs.mkdirSync(dir, { recursive: true });
  const id = `${String(holdSeq++).padStart(10, '0')}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const file = path.join(dir, `${id}.json`);
  const tmp = `${file}.tmp`;
  const record = { id, kind, path: originalPath, body, detail, at: new Date().toISOString() };
  fs.writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`);
  fs.renameSync(tmp, file); // never leave a half-written hold behind
  return id;
}

// ---------- draining held writes: a HELD file is not a promise anything replays it ----------
//
// DAR-287. holdWrite() gave an unreachable darbar somewhere to put the words; nothing afterwards
// ever looked in that directory again, so a held remember/supersede sat on disk forever unless a
// human noticed. Two triggers replay it, same function underneath:
//   1. right after any darbar call FROM THIS FILE comes back reachable — the ordinary "gabbar is
//      talking to darbar again" signal, so the backlog clears as a side effect of normal traffic
//      with no separate process needed.
//   2. a 60s timer, for the case nobody calls memory again for a while and a hold would otherwise
//      sit unnoticed between conversations.
// Idempotent by construction on the server side (remember dedupes a node by name+type+project and,
// as of today's server rework, an identical observation on it too), so replaying the same file
// twice — one attempt via each trigger racing — is harmless. The file is still deleted promptly on
// the first 2xx rather than left for the other trigger to find, since there is no reason to keep it.
//
// Failures are logged ONCE PER FILE, not once per tick: draining runs every 60s regardless of
// whether darbar is back, so a still-down darbar would otherwise log the same file 60x an hour.
// loggedDrainFailures tracks which files already got their one line; a file that eventually
// succeeds is dropped from it so a LATER unrelated failure on a re-created hold logs again.
const DRAIN_INTERVAL_MS = 60_000;
let draining = false; // re-entrancy guard: a drain triggered mid-drain (by its own successful
// replay calling back here) is a no-op, not a second pass over the same directory
const loggedDrainFailures = new Set<string>();

async function drainHeld(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    const dir = holdRoot();
    let files: string[];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
    } catch {
      return; // no hold dir yet: nothing to drain
    }
    for (const f of files) {
      const file = path.join(dir, f);
      let record: { kind?: string; body?: Record<string, unknown> } | null = null;
      try {
        record = JSON.parse(fs.readFileSync(file, 'utf-8'));
      } catch {
        continue; // unreadable/corrupt hold file: leave it for a human rather than loop on garbage
      }
      const kind = record?.kind === 'supersede' ? 'supersede' : 'remember';
      const rf = await fetchDarbar(`/memory/${kind}`, 'POST', record?.body ?? {});
      if (!rf.reachable) {
        if (!loggedDrainFailures.has(f)) {
          console.error(`gabbar: replaying held memory ${f} failed, still held: ${rf.detail}`);
          loggedDrainFailures.add(f);
        }
        continue;
      }
      const rj = rf.json as { error?: string };
      if (rj?.error) {
        // darbar answered and refused the payload outright — not a reachability failure, but
        // still not delivered, so it stays held and logs the same way a timeout would.
        if (!loggedDrainFailures.has(f)) {
          console.error(`gabbar: replaying held memory ${f} was refused, still held: ${rj.error}`);
          loggedDrainFailures.add(f);
        }
        continue;
      }
      try {
        fs.unlinkSync(file);
      } catch (e) {
        console.error(`gabbar: replayed held memory ${f} but could not delete the hold file:`, e);
        continue;
      }
      loggedDrainFailures.delete(f);
    }
  } finally {
    draining = false;
  }
}

// Exposed under a test-facing name only so memory.test.ts can invoke a tick deterministically
// instead of racing the real timer; nothing outside this file and its test calls it directly.
export const drainMemoryHoldForTest = drainHeld;

setInterval(() => {
  void drainHeld();
}, DRAIN_INTERVAL_MS).unref?.();

// ---------- recall ----------

type RecallNode = {
  name: string;
  type: MemoryNodeType;
  project: string | null;
  observations: Array<{ text: string; at: string; source: string }>;
  supersededBy?: string | null;
};
type RecallResult = { nodes: RecallNode[]; edges: Array<{ from: string | null; to: string | null; relation: string }> };

async function recall(
  q: string,
  opts: { project?: string; type?: MemoryNodeType; limit?: number } = {},
): Promise<{ ok: true; result: RecallResult } | { ok: false; message: string }> {
  const qs = new URLSearchParams({ q });
  if (opts.project) qs.set('project', opts.project);
  if (opts.type) qs.set('type', opts.type);
  qs.set('limit', String(opts.limit ?? 20));
  const f = await fetchDarbar(`/memory/recall?${qs.toString()}`);
  if (!f.reachable) return { ok: false, message: `memory unreachable: ${f.detail}` };
  void drainHeld(); // darbar just answered: worth clearing any backlog before we even use this response
  const j = f.json as { error?: string } & Partial<RecallResult>;
  if (j.error) return { ok: false, message: j.error };
  return { ok: true, result: { nodes: j.nodes ?? [], edges: j.edges ?? [] } };
}

function formatNode(n: RecallNode): string {
  const lines = n.observations.map((o, i) => `${i + 1}: ${o.text}`);
  return lines.length ? lines.join('\n') : '(no observations yet)';
}

function formatListing(nodes: RecallNode[]): string {
  return nodes.length ? nodes.map((n) => `${n.type}/${n.name}`).join('\n') : '(no matches)';
}

// injected into the system prompt so the agent knows how to use its memory without a tool call.
// No live listing here on purpose: recall requires actual search text (a bare "list everything" is
// not an operation the graph API has), so a real directory tree would need one HTTP call per turn
// for a page that is mostly static guidance anyway.
export async function memoryTree(): Promise<string> {
  return [
    "memory is darbar's memory graph now, not a browsable directory — there is no static file list.",
    'search it: view a specific name/topic to recall it (people/<name>, projects/<ref>, preferences/<topic>, or anything else for a durable fact/gotcha).',
    'create saves a new fact under that path; str_replace records a correction; nothing is ever deleted.',
  ].join('\n');
}

// stakeholders get their own people-file as read-only context, nothing else — same restriction as
// before, just served from recall instead of a file read.
export async function readPersonFile(name: string): Promise<string | null> {
  const r = await recall(name, { type: 'person', limit: 1 });
  if (!r.ok) return null;
  const hit = r.result.nodes.find((n) => n.type === 'person' && slugify(n.name) === slugify(name));
  return hit ? formatNode(hit) : null;
}

// ---------- the memory tool the model calls ----------

export const memoryTool = betaMemoryTool({
  async view({ path: p }) {
    const { segments, type, name, project } = parsePath(p);
    if (!segments.length) return await memoryTree();
    const r = await recall(name, { project, type, limit: 10 });
    if (!r.ok) return r.message;
    const exact = r.result.nodes.find((n) => n.type === type && slugify(n.name) === slugify(name));
    if (exact) return formatNode(exact);
    // no exact match on this type+name: show whatever recall() found under that search text instead
    // of a bare "does not exist", since a fuzzy hit is more useful than nothing to a model deciding
    // whether to create() or look elsewhere.
    return r.result.nodes.length ? formatListing(r.result.nodes) : `${p} does not exist`;
  },

  async create({ path: p, file_text }) {
    const { segments, type, name, project } = parsePath(p);
    if (!segments.length) return 'cannot create at the memory root; give it a category, e.g. /memories/people/<name>';
    const body = { node: { name, type, project }, observations: [{ text: file_text, source: 'gabbar' }] };
    const f = await fetchDarbar('/memory/remember', 'POST', body);
    if (!f.reachable) {
      const id = holdWrite('remember', p, body, f.detail);
      return `darbar was unreachable (${f.detail}), so this was held locally (hold id ${id}) instead of lost. it is NOT yet in memory — say so, and try again once darbar is back.`;
    }
    void drainHeld(); // darbar just took a write: clear any earlier backlog now rather than wait for the timer
    const j = f.json as { error?: string };
    if (j.error) return j.error;
    return `remembered ${p}`;
  },

  // Corrections don't mutate: they append the new fact to the same node (remember() only ever
  // inserts or appends, same as create) and then retire the STALE version by superseding it with a
  // fresh node that carries the correction, so recall stops surfacing the wrong text by default
  // while the old one stays reachable forever via includeSuperseded/asOf. A self-supersede (marking
  // the SAME node both the new content and the thing being replaced) was considered and rejected: it
  // stamps the node itself invalidAt, which would hide the correction we just wrote right along with
  // the stale text it was meant to fix.
  async str_replace({ path: p, new_str }) {
    const { segments, type, name, project } = parsePath(p);
    if (!segments.length) return 'cannot edit the memory root';
    const found = await recall(name, { project, type, limit: 5 });
    if (!found.ok) return found.message;
    const existing = found.result.nodes.find((n) => n.type === type && slugify(n.name) === slugify(name));
    if (!existing) return `${p} does not exist`;
    const revisionName = `${existing.name} (rev ${Date.now()})`;
    const rememberBody = { node: { name: revisionName, type, project }, observations: [{ text: new_str, source: 'gabbar' }] };
    const rf = await fetchDarbar('/memory/remember', 'POST', rememberBody);
    if (!rf.reachable) {
      const id = holdWrite('remember', p, rememberBody, rf.detail);
      return `darbar was unreachable (${rf.detail}), so this correction was held locally (hold id ${id}) instead of lost. it is NOT yet in memory — say so, and try again once darbar is back.`;
    }
    void drainHeld(); // darbar just took the remember half: clear any earlier backlog now rather than wait for the timer
    const rj = rf.json as { error?: string };
    if (rj.error) return rj.error;
    const supersedeBody = { nodeName: existing.name, by: revisionName, project, source: { harness: 'gabbar' } };
    const sf = await fetchDarbar('/memory/supersede', 'POST', supersedeBody);
    if (!sf.reachable) {
      const id = holdWrite('supersede', p, supersedeBody, sf.detail);
      return `the new text was saved as ${revisionName}, but darbar was unreachable (${sf.detail}) marking the old one stale, so that half was held locally (hold id ${id}). both versions will show up until it retries.`;
    }
    void drainHeld();
    const sj = sf.json as { error?: string };
    if (sj.error) return `the new text was saved as ${revisionName}, but marking the old one stale failed: ${sj.error}`;
    return `edited ${p}`;
  },

  // insert had a line-position in the directory store; an observation log has no positions to
  // insert between, so this is the same append remember() always is, insert_line notwithstanding.
  async insert({ path: p, insert_text }) {
    const { segments, type, name, project } = parsePath(p);
    if (!segments.length) return 'cannot insert at the memory root';
    const body = { node: { name, type, project }, observations: [{ text: insert_text, source: 'gabbar' }] };
    const f = await fetchDarbar('/memory/remember', 'POST', body);
    if (!f.reachable) {
      const id = holdWrite('remember', p, body, f.detail);
      return `darbar was unreachable (${f.detail}), so this was held locally (hold id ${id}) instead of lost. it is NOT yet in memory — say so, and try again once darbar is back.`;
    }
    void drainHeld(); // darbar just took a write: clear any earlier backlog now rather than wait for the timer
    const j = f.json as { error?: string };
    if (j.error) return j.error;
    return `inserted into ${p}`;
  },

  // nothing deletes. Ever. There is no door in the graph API that removes a node or an
  // observation, on purpose (DAR-274's whole point), so this refuses rather than pretending.
  async delete() {
    return 'memory never deletes anything, on purpose — nothing was removed. if a fact is stale, str_replace it instead so the correction is on record.';
  },

  // no move/rename primitive exists on the graph (remember only ever targets one name). Refuse
  // rather than fabricate a rename by duplicating content under a new name and leaving the old node
  // untouched and undiscoverable-as-renamed.
  async rename() {
    return 'memory has no rename — create the content under the new path and leave a note on the old one if it matters that they are related.';
  },
});
