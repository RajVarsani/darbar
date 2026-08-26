import fs from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { streamSSE, streamText } from 'hono/streaming';
import { Projects, Tasks, Feedback, Events, ObjectId, capId, nextShortId } from '@darbar/core';
import { emit, subscribe } from './sse';
import { nudge, waitForNudge } from './inbox';
import { config, pathPatternError, PATH_PATTERN_FORM, isParkId } from '@darbar/core';
import type { FeedbackDoc, ParkedRead, ParkedSummary, Pipeline, Project, ProjectAgent, ProjectProxy, PublishedRoute, Stakeholder, Task, TaskStatus, TaskType, FeedbackStatus } from '@darbar/core';

export const api = new Hono();

export const TASK_STATUSES: TaskStatus[] = ['backlog', 'todo', 'in_progress', 'in_review', 'qa', 'blocked', 'done', 'cancelled'];
export const TASK_TYPES: TaskType[] = ['feature', 'bug', 'chore', 'review', 'regression'];
export const FEEDBACK_STATUSES: FeedbackStatus[] = ['pending', 'triaged', 'needs_clarification', 'accepted', 'in_progress', 'resolved', 'rejected'];
const FEEDBACK_TYPES = ['bug', 'design', 'idea', 'approval'];
const CLOSED: TaskStatus[] = ['done', 'cancelled'];

// body/type guards: user-controlled JSON never reaches Mongo operators or the board untyped
async function readBody(c: Context): Promise<Record<string, unknown> | null> {
  const b = await c.req.json().catch(() => null);
  return b && typeof b === 'object' && !Array.isArray(b) ? b : null;
}
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const strOrNull = (v: unknown): string | null | undefined =>
  v === null ? null : typeof v === 'string' ? v : undefined;
const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);

// str/strOrNull/strArr return "nothing" for a WRONG TYPE and for an ABSENT field alike, and every
// caller then reads that as "not sent". So a field with the wrong type was dropped under a 200 —
// the DAR-187 defect class, one layer down from the routes. This says so instead. Absent stays
// absent; only a field the caller actually sent is judged.
type FieldType = 'string' | 'string|null' | 'string[]' | 'boolean';
const FIELD_WANT: Record<FieldType, string> = {
  string: 'a string',
  'string|null': 'a string or null',
  'string[]': 'an array of strings',
  // the shape the two boolean verbs already in this file (dispatched, reviewAgain) hand-check for.
  // A boolean sent as "true" read as absent is how {"archived": "true"} would mean "not archived".
  boolean: 'true or false',
};
function typeErrors(b: Record<string, unknown>, spec: Record<string, FieldType>): string[] {
  const errs: string[] = [];
  for (const [k, want] of Object.entries(spec)) {
    const v = b[k];
    if (v === undefined) continue;
    const ok = want === 'string' ? typeof v === 'string'
      : want === 'string|null' ? v === null || typeof v === 'string'
      : want === 'boolean' ? typeof v === 'boolean'
      : Array.isArray(v) && v.every((x) => typeof x === 'string');
    if (!ok) errs.push(`${k} must be ${FIELD_WANT[want]} (got ${JSON.stringify(v)})`);
  }
  return errs;
}
// ---------- fields a route does not apply ----------
// DAR-208's actual shape, one layer above typeErrors. typeErrors catches a field sent with the
// WRONG TYPE; this catches a field sent with the right type that the route has no branch for at
// all, which is dropped under a 200 in exactly the same silence. `repos` on PATCH /projects is the
// instance that was reported; the sweep found the same property on eleven other fields across nine
// routes, so this is a table rather than twelve if-statements bolted on one at a time.
//
// How it stays a class fix and not a longer list: each DOCUMENT gets one vocabulary of the field
// names a caller might reasonably send about it, each with the sentence saying where that thing is
// actually changed. A route declares what it APPLIES; everything else in the vocabulary is a 400
// naming the right door. So adding a field to a document means adding one vocabulary line, and
// every route that does not handle it then refuses it loudly instead of eating it.
//
// Deliberately NOT a schema: unknown junk is still ignored. These are the words that MEAN something
// in this system, and a 400 on an unrecognised key would break every caller that pads a body.
//
// ---------- and a field echoed back UNCHANGED is not an edit ----------
// The first cut of this refused a vocabulary field on sight, which broke a caller the code sweep
// could not see: READ THE WHOLE THING, CHANGE ONE PART, SEND IT BACK. That is the procedure the
// project-init skill teaches for restructuring a charter or replacing a stakeholder list, every
// read surface here echoes fields the write path does not apply, and a documented procedure is a
// caller (DAR-FB-121). Refusing it taught people that the guard is noise, which is how a guard
// stops being read.
//
// So the guard fires on what it was built to catch and nothing else: a CHANGE that would be
// dropped. A value identical to the stored one drops nothing, whether it was echoed or typed, so
// it passes and the rest of the body applies. Send a DIFFERENT name and it still 400s, which is
// the case that was ever worth a 400. Absent / null / [] all read as the same emptiness, because
// `proxyPublished: []` echoed onto a project that has never published one says exactly what the
// stored absence says.
// Comparison is on the JSON shape, which is what a read surface actually handed the caller: a Date
// comes back as its ISO string and an ObjectId as its hex, and both must count as unchanged.
type FieldVocab = Record<string, string>;
const jsonish = (v: unknown): unknown => (v === undefined ? null : JSON.parse(JSON.stringify(v)));
const isEmpty = (v: unknown) => v === null || (Array.isArray(v) && v.length === 0);
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a as object), kb = Object.keys(b as object);
    // key ORDER must not decide this: a caller that re-serialised the body it read has not edited it
    return ka.length === kb.length && ka.every((k) => k in (b as object) && deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return false;
}
// exported for silent-drop tests: this predicate is the whole difference between "refuses a dropped
// change" and "refuses an echo", and it is the reason read-edit-send-whole still works
export function echoedUnchanged(sent: unknown, stored: unknown): boolean {
  const a = jsonish(sent), b = jsonish(stored);
  return (isEmpty(a) && isEmpty(b)) || deepEqual(a, b);
}
// `current` is the stored document when there is one. On a CREATE there is nothing to echo, so
// omitting it refuses every vocabulary field, which is right: nothing sent to a create can be
// "unchanged".
function notApplied(
  b: Record<string, unknown>,
  vocab: FieldVocab,
  applied: string[],
  current?: Record<string, unknown> | null,
): string | null {
  const hit = Object.keys(vocab).filter((k) =>
    b[k] !== undefined && !applied.includes(k) && !(current && echoedUnchanged(b[k], current[k])));
  return hit.length
    ? `not settable here, and what you sent differs from what is stored: ${hit.map((k) => `${k} (${vocab[k]})`).join('; ')}`
    : null;
}
// One shape for every refusal, table-driven or hand-written, and no em dashes in any of them:
// gabbar hands these strings verbatim to a slack-facing model as tool results, and the charter bans
// em dashes and AI-tell phrasing in anything that can reach slack.
const notHere = (field: string, why: string) => `not settable here: ${field} (${why})`;

// The project document, as the config write path sees it. `repos` is missing from this table
// because it is APPLIED now (applyConfig grew the branch it never had); everything else here is
// server-owned or set once at create.
const PROJECT_VOCAB: FieldVocab = {
  name: 'set at create (POST /projects); there is no rename, and the name is one of the keys every project lookup accepts',
  prefix: 'set at create and permanent: every task and feedback short id already issued is built from it',
  capId: 'the board capability id is generated by the server; changing it would invalidate every share link already handed out',
  counters: 'the short-id counters belong to the server; a hand-set value re-issues an id that already exists',
  proxyPublished: 'that is the record of what the server actually put in the proxy route table, not a setting. Change `proxy` and the reconciliation rewrites it',
  createdAt: 'stamped by the server at create',
  // ---------- the archive words ----------
  // `archived` is the VERB and archivedAt is the record, the same split as dispatched/dispatchedAt:
  // the server owns the clock so the stamp and the age a reader takes off it cannot disagree. The
  // other three are modifiers that only mean something ON an archive act, so anywhere else they are
  // a caller believing they asked for something. They are in this table so that is a 400 naming the
  // right door, rather than the silent drop under a 200 that DAR-208 spent a day closing.
  archived: 'archiving is its own act: PATCH /api/projects/:ref {"archived": true} to take a finished project off the active board, {"archived": false} to put it back',
  archivedAt: 'the server owns that clock: send {"archived": true} to stamp it now, false to clear it. When a project was finished is the thing the field is for, so it is not hand-settable',
  archiveReason: 'a reason belongs to the act that needs one: PATCH /api/projects/:ref {"archived": true, "archiveReason": "…"}. On its own it would be a reason for nothing, and unarchiving clears it',
  archivedOpenRows: 'the server counts what was still open when a project was forced into the archive; it is a record of what was left behind, not a setting',
  cancelOpen: 'that answers a question only archiving asks: PATCH /api/projects/:ref {"archived": true, "cancelOpen": true} cancels the still-open rows as part of archiving',
  force: 'that answers a question only archiving asks: PATCH /api/projects/:ref {"archived": true, "force": true} archives and leaves the open rows open',
};

// The archive act, and why it is not in CONFIG_FIELDS below. Config fields are declared wholesale at
// init and re-declared freely; this is a LIFECYCLE transition with a gate, a cascade onto tasks and
// a server-owned clock. Keeping them apart is also what stops POST /projects from silently eating
// {"archived": true} at create: that route declares CONFIG_FIELDS applied, so an archive word sent
// to it falls through to the vocabulary above and is refused by name instead of dropped.
const ARCHIVE_FIELDS = ['archived', 'archiveReason', 'cancelOpen', 'force'];

// The seven fields the config write path DOES apply, for use on the granular routes, where each of
// them is somebody else's door. Sending {text, repos} to /charter/append appended the line and
// dropped the repos under a 200, which is the same defect one floor down from the one that started
// this (DAR-216 non-blocking 1). Every granular route now measures itself against this too.
const CONFIG_VOCAB: FieldVocab = {
  charter: 'the charter is its own door: POST /api/projects/:ref/charter/append adds a line, PATCH /api/projects/:ref {"charter": …} replaces the whole thing',
  slackChannel: 'PATCH /api/projects/:ref {"slackChannel": …}',
  repos: 'PATCH /api/projects/:ref {"repos": ["…"]}',
  stakeholders: 'stakeholders are edited one at a time under /api/projects/:ref/stakeholders, or wholesale with PATCH /api/projects/:ref {"stakeholders": […]}',
  pipeline: 'lanes are edited one at a time under /api/projects/:ref/pipeline/lanes, autoAdvance at PATCH /api/projects/:ref/pipeline, or wholesale with PATCH /api/projects/:ref {"pipeline": {…}}',
  agents: 'agents are edited one at a time under /api/projects/:ref/agents, or wholesale with PATCH /api/projects/:ref {"agents": […]}',
  proxy: 'the share is edited at PATCH /api/projects/:ref/proxy and published at PATCH /api/projects/:ref/proxy/enabled, or wholesale with PATCH /api/projects/:ref {"proxy": {…}}',
  linearUrl: 'PATCH /api/projects/:ref {"linearUrl": "https://linear.app/…"} makes this project LINEAR-NATIVE: Linear becomes the board of record for tasks and the console card opens that view (null clears it). Feedback still arrives here through gabbar and is drained into Linear by the orchestrator',
};
// what a granular project route is measured against: the server-owned fields plus the config doors.
// NOTE ON SCOPE: a vocabulary belongs to ONE document, so each route below has to say which of these
// words it owns. `prefix` under /proxy addresses the SHARE, not the project, and `name` under
// /stakeholders and /agents addresses the person or the agent, so those routes list them as applied
// and the project-level meaning is simply not reachable there.
const PROJECT_GRANULAR_VOCAB: FieldVocab = { ...PROJECT_VOCAB, ...CONFIG_VOCAB };

// The task document. PATCH /tasks/:ref already refused most of these by hand (DAR-187 item 4);
// they moved here so the create route is held to the same standard with the same sentences.
const TASK_VOCAB: FieldVocab = {
  origin: 'set at create only (POST /tasks {"origin": …})',
  commits: 'append-only: one hash per call via {"addCommit": "<sha>"}',
  // applied by PATCH /tasks/:ref and by nothing else, so POST /tasks {"addCommit"} returned 200 with
  // commits still empty. A word this API applies somewhere has to be in the table, or the table has
  // the same blind spot as the route it is meant to fix (DAR-FB-120)
  addCommit: 'a commit is appended after the task exists: PATCH /tasks/:ref {"addCommit": "<sha>"}',
  shortId: 'assigned by the server at create and never changes',
  parentTaskRef: 'parentage is set at create only (POST /tasks {"parentTaskRef": …})',
  parentTaskId: 'parentage is set at create only (POST /tasks {"parentTaskRef": …})',
  project: 'a task cannot move between projects; file it on the other project and cancel this row',
  projectId: 'a task cannot move between projects; file it on the other project and cancel this row',
  dispatched: 'filing a task is not dispatching it: hand it to an agent with PATCH /tasks/:ref {"dispatched": true}',
  // applied by PATCH /tasks/:ref and by nothing else. A task being CREATED has no earlier round to
  // duplicate, so on POST /tasks this word means nothing and is a caller believing they asked for a
  // second round on a row that has never had one. Same reason addCommit is in this table.
  reviewAgain: 'a SECOND review round on a task that already had one is asked for on the move itself: PATCH /tasks/:ref {"status": "in_review", "reviewAgain": true}',
  dispatchedAt: 'the server owns that clock: send {"dispatched": true} to stamp it now, false to clear it',
  createdAt: 'stamped by the server at create',
  updatedAt: 'stamped by the server on every write',
};

// The feedback document. body and attachments are the DAR-182 pair: both were dropped here under a
// 200, and both now name the append route, which is the only thing that adds to a filed row.
const FEEDBACK_VOCAB: FieldVocab = {
  // the sentence NAMES the field to send. Pointing at the append route without saying "note" sent a
  // caller who had just been refused for `body` straight back with the same key, into a route that
  // declared `body` applied and read `note` (DAR-FB-120). A redirection that does not name the field
  // is how the guidance became the trap.
  body: 'a feedback body is append-only: POST /api/feedback/:shortId/append with {"note": "…"} adds an attributed note without rewriting what its author wrote',
  attachments: 'evidence is appended, not replaced: POST /api/feedback/:shortId/append with {"attachments": ["…"]} records who added it and when',
  // applied by POST /feedback and PATCH /feedback, and by neither of the others, so it was dropped
  // on the append route under a 200
  type: 'the kind of a row (bug, design, idea, approval) is set when it is filed and changed with PATCH /feedback/:shortId {"type": …}',
  author: 'attribution is set when the row is filed and never changes; it is the human trail the board renders',
  authorType: 'attribution is set when the row is filed and never changes',
  taskRef: 'the task a row was FILED ON is set at create (POST /feedback {"taskRef": …}); to link the task that FIXES it send resolvedTaskRef',
  taskId: 'the task a row was FILED ON is set at create (POST /feedback {"taskRef": …}); to link the task that FIXES it send resolvedTaskRef',
  taskShortId: 'the task a row was FILED ON is set at create (POST /feedback {"taskRef": …}); to link the task that FIXES it send resolvedTaskRef',
  slack: 'the slack thread a row belongs to is set when it is filed; it is where every reply about it is posted',
  project: 'feedback cannot move between projects',
  projectId: 'feedback cannot move between projects',
  shortId: 'assigned by the server at create and never changes',
  resolvedTaskRef: 'the task that FIXES a row is linked after triage: PATCH /feedback/:shortId {"resolvedTaskRef": "DAR-12"}',
  resolvedTaskId: 'send resolvedTaskRef (a short id like DAR-12); the server resolves it and stores both',
  resolvedTaskShortId: 'send resolvedTaskRef (a short id like DAR-12); the server resolves it and stores both',
  status: 'a status change is its own act (a newly filed row is always pending, and an append never moves one): PATCH /feedback/:shortId',
  resolution: 'a resolution is the text posted back to the reporter when a row is resolved or rejected: PATCH /feedback/:shortId',
  // DAR-229. It is APPLIED by POST /feedback and by POST /feedback/:shortId/append, and by nothing
  // else, so anywhere else it is a caller believing a retry is protected when it is not. That is the
  // worst possible field to drop under a 200: the caller's whole reason for sending it is not to
  // duplicate somebody's report.
  idempotencyKey: 'an idempotency key names ONE write, so it is sent with the write itself: POST /api/feedback to file a row once, or POST /api/feedback/:shortId/append to add a note once. There is nothing to make idempotent about editing a row that already exists',
  createdAt: 'stamped by the server at create',
  updatedAt: 'stamped by the server on every write',
};

// lanes: absent = untouched, null = default-all, [] = explicitly none, array = subset.
// malformed shapes 400 instead of coercing — lanes:[123] must never read as "explicitly none"
const LANES_SHAPE_ERROR = 'lanes must be null or an array of lane-key strings';
const lanesShapeBad = (v: unknown): boolean =>
  v !== undefined && v !== null && !(Array.isArray(v) && v.every((x) => typeof x === 'string'));
const lanesArr = (v: unknown): string[] | null | undefined =>
  v === null ? null : Array.isArray(v) ? (v as string[]) : undefined;

// unknown lane keys are typos, not silent no-ops
function laneError(p: { pipeline?: Pipeline } | null, want: string[]): string | null {
  const valid = (p?.pipeline?.reviews ?? []).map((r) => r.lane);
  const bad = want.filter((l) => !valid.includes(l));
  return bad.length
    ? `unknown lane(s): ${bad.join(', ')}; valid lane keys: ${valid.join(', ') || '(none configured)'}`
    : null;
}

async function logEvent(projectId: ObjectId, text: string, taskId?: ObjectId | null) {
  await Events.insertOne({ projectId, taskId: taskId ?? null, text, at: new Date() });
  const p = await Projects.findOne({ _id: projectId }, { projection: { capId: 1 } });
  if (p) emit(p.capId, await boardTick(p.capId, projectId, text));
}

// ---------- DAR-254: the tick carries the change, not a bell ----------
//
// The frame used to be {kind:'event', text} and the board answered it by refetching the WHOLE
// project: 250ms debounce, then GET /api/p/:capId in full. ~2.7KB gzipped on DAR, but it is the
// whole board every time, so it scales with the project (MRF is 1,045KB raw) and it spends a
// request per tick per viewer against a zrok share that allows 2000 per 300s per IP.
//
// So the frame carries the rows that changed, and the board patches its own state. Three separate
// things have to be true for that to be SAFE rather than merely smaller, and each has its own
// mechanism on the frame:
//
//   1. ORDER — epoch + rev/prev. Frames are a sequence per project; the board applies one only when
//      its `prev` is exactly the rev the board is holding. A frame from before the board's own last
//      full load (rev <= ours) is dropped rather than applied, which is the case a digest alone
//      cannot see: a refetch racing a tick would otherwise be overwritten by the older copy the
//      tick was built from, and the digest would AGREE, because it was built from that same older
//      copy. `epoch` is this process; a restart resets the sequence and every board refetches.
//   2. CONTENT — a digest of every row's (id, updatedAt), computed here over the collection and
//      recomputed by the board over its own arrays (board.html: rowSig, same 6 lines). Anything the
//      window below missed, anything deleted out of band, anything the board holds a stale copy of,
//      comes out as a mismatch on the very next tick and the board refetches.
//   3. SHAPE — a frame that is not a delta at all (this build failing, an older server, garbage) is
//      not understood, and not understanding a frame means a full refetch. Every degradation in
//      here lands on the same floor: the behaviour that shipped before this change.
//
// The window is "changed since the last frame for this board", dragged back by a small OVERLAP. The
// overlap is there because a row's updatedAt is stamped when its request is handled and this query
// runs when the emit reaches here: two concurrent writers interleave those by milliseconds, so
// without it a row can miss its own delta. Re-sending is cheap (the board replaces by _id) and it
// is paid on every frame in a burst, so the overlap is a quarter second rather than seconds; a miss
// that slips past it still ends in one refetch off the digest, never in a board that is quietly
// wrong. Both numbers are measured behaviour in engine.test.ts, not estimates.
const DELTA_SKEW_MS = 250;
const DELTA_FLOOR_MS = 60_000; // widest window a delta ever asks for; an older gap is a refetch
const DELTA_MAX_ROWS = 100; // a bulk seed is cheaper to refetch once than to stream row by row
// this process. Not persisted on purpose: a restart MUST invalidate every board's sequence.
const EPOCH = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
type BoardTick = { seq: number; at: Date };
const ticks = new Map<string, BoardTick>(); // capId -> the last delta built for that board
const liveBoards = new Map<string, number>(); // capId -> open SSE streams (0 = build nothing)

function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16);
}
// Order-INDEPENDENT (the lines are sorted), so it says nothing about how rows are arranged and
// everything about which rows exist and what version each is at. board.html computes the identical
// digest from the JSON it holds, where an ObjectId is already its hex string and a Date is already
// its ISO string — which is exactly what these two stamps produce.
const rowSig = <T,>(rows: T[], stamp: (r: T) => string) =>
  fnv1a(rows.map((r) => `${(r as { _id?: unknown })._id}:${stamp(r)}`).sort().join('\n'));
const byUpdated = (r: { updatedAt?: Date }) => r.updatedAt?.toISOString() ?? '';
const idOnly = () => '';
// over the BOARD SHAPE of the project (boardProject), never the raw doc: the raw doc holds
// proxy.target, the one field a link-holder must not learn, and a 32-bit digest of a value drawn
// from a small candidate space (http://127.0.0.1:PORT) is an oracle for it. Over the redacted shape
// it is a digest of what the board already has, which tells a link-holder nothing new.
const projectSig = (bp: unknown) => fnv1a(JSON.stringify(bp));

/** the frame a project's boards get: a delta when one is listening and it built, the old bell otherwise */
async function boardTick(capId: string, projectId: ObjectId, text: string) {
  // nothing connected: the delta would be six queries nobody reads. The bell is what a '*'
  // subscriber (there is none today) would still see, and it costs nothing to keep emitting.
  if (!liveBoards.get(capId)) return { kind: 'event', text };
  try {
    return await buildDelta(capId, projectId, text);
  } catch (e) {
    // a delta that cannot be built is not a reason to leave the board unaware that SOMETHING moved
    console.error(`board delta failed (${capId}): ${String(e)} — boards fall back to a full refetch`);
    return { kind: 'event', text };
  }
}

async function buildDelta(capId: string, projectId: ObjectId, text: string) {
  const prev = ticks.get(capId);
  const now = new Date();
  const since = new Date(Math.max((prev?.at.getTime() ?? 0) - DELTA_SKEW_MS, now.getTime() - DELTA_FLOOR_MS));
  const [changedTasks, taskStamps, changedFb, fbStamps, events, project] = await Promise.all([
    Tasks.find({ projectId, updatedAt: { $gt: since } }).sort({ createdAt: 1 }).toArray(),
    Tasks.find({ projectId }, { projection: { updatedAt: 1 } }).toArray(),
    Feedback.find({ projectId, updatedAt: { $gt: since } }).sort({ createdAt: -1 }).toArray(),
    Feedback.find({ projectId }, { projection: { updatedAt: 1 } }).toArray(),
    // the same read the board payload does, so the board's own list and this digest agree on which
    // 50 events exist; the new ones are taken from it rather than queried a second time
    Events.find({ projectId }).sort({ at: -1 }).limit(config.eventsBoardLimit).toArray(),
    Projects.findOne({ _id: projectId }),
  ]);
  const seq = (prev?.seq ?? 0) + 1;
  ticks.set(capId, { seq, at: now });
  // one delta carrying half a seed is a bigger frame than the refetch it saves
  const flood = changedTasks.length + changedFb.length > DELTA_MAX_ROWS;
  return {
    kind: 'delta',
    epoch: EPOCH,
    rev: seq,
    prev: prev?.seq ?? 0,
    text, // what the old frame carried, kept for anything reading the stream by hand
    // The project is FINGERPRINTED and never sent: its board shape is redacted and sliced, so
    // rebuilding it here would put a second copy of a redaction on a second path. The board holds
    // the same digest from its last full load and refetches the moment the two differ — which also
    // catches an edit made BEFORE this board connected, where a server-side "changed since the last
    // tick" flag would have said nothing.
    projectSig: project ? projectSig(boardProject(project)) : null,
    resync: flood,
    tasks: flood ? [] : changedTasks,
    feedback: flood ? [] : changedFb,
    events: events.filter((e) => e.at > since),
    eventsMax: config.eventsBoardLimit,
    sig: {
      tasks: rowSig(taskStamps, byUpdated),
      feedback: rowSig(fbStamps, byUpdated),
      events: rowSig(events, idOnly),
    },
  };
}

// The feedback statuses that make the server SPEAK TO A HUMAN in their own Slack thread. Every one
// of them needs a resolution, because the resolution is the entire body of that message: there is no
// fallback text worth sending, only a placeholder that reads as a system defect to the person who
// reported something in good faith (DAR-189).
const REPLYING: FeedbackStatus[] = ['resolved', 'rejected', 'needs_clarification'];
const REPLY_ASKS: Record<string, string> = {
  resolved: 'what actually changed for them',
  rejected: 'why this is not being actioned',
  needs_clarification: 'exactly what you need from them',
};

// resolution replies live in the SERVER, not the bot: Gabbar is intake-only.
// A failed reply is logged as a project event so it is visible on the board.
async function slackThreadReply(fb: FeedbackDoc, text: string) {
  if (!fb.slack?.channel || !config.slackBotToken) return;
  try {
    const r = await fetch(`${config.slackApiBase}/chat.postMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.slackBotToken}` },
      body: JSON.stringify({ channel: fb.slack.channel, thread_ts: fb.slack.ts, text }),
    });
    const res = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (!res.ok) await logEvent(fb.projectId, `slack reply FAILED for ${fb.shortId}: ${res.error ?? `http ${r.status}`}`, fb.taskId);
  } catch (e) {
    await logEvent(fb.projectId, `slack reply FAILED for ${fb.shortId}: ${String(e)}`, fb.taskId);
  }
}

async function resolveTaskRef(ref: string) {
  return Tasks.findOne({ shortId: ref.toUpperCase() });
}

// One normalisation for every identity key in the config: agent names, lane keys, stakeholder names.
// All three are LOOKUP KEYS — an agent name is the dispatch/assignee key, a lane key is what a task's
// `lanes` selection matches, a stakeholder name is how a person is addressed — so " qa-lead" and
// "QA-Lead" beside "qa-lead" are not new entries, they are a second key for the same thing, and the
// space-padded one is invisible in any printed registry. Stored trimmed, compared case-folded.
const keyOf = (s: string) => s.trim().toLowerCase();

// pipeline config comes from user JSON: rebuild it field-by-field, never store the raw object.
// Malformed input errors with what failed instead of being dropped (FB-48/FB-56: error, never coerce)
function readPipeline(v: unknown): { pipeline: Pipeline } | { error: string } {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { error: 'pipeline must be an object {autoAdvance?, reviews}' };
  const o = v as Record<string, unknown>;
  if (o.autoAdvance !== undefined && typeof o.autoAdvance !== 'boolean') return { error: 'pipeline.autoAdvance must be a boolean when present' };
  // reviews replaces the whole lane list, so an omitted/garbage array would silently wipe it
  if (!Array.isArray(o.reviews)) return { error: 'pipeline.reviews must be an array of {lane, label?, manager}' };
  const reviews: Pipeline['reviews'] = [];
  const errs: string[] = [];
  const seenLanes = new Map<string, string>();
  o.reviews.forEach((r, i) => {
    if (!r || typeof r !== 'object' || Array.isArray(r)) { errs.push(`pipeline.reviews[${i}]: not an object`); return; }
    const { lane, label, manager } = r as Record<string, unknown>;
    const bad: string[] = [];
    if (typeof lane !== 'string' || !lane.trim()) bad.push('lane (non-empty string) required');
    if (typeof manager !== 'string' || !manager.trim()) bad.push('manager (non-empty string) required');
    if (label !== undefined && typeof label !== 'string') bad.push('label must be a string when present');
    if (bad.length) { errs.push(`pipeline.reviews[${i}]: ${bad.join('; ')}`); return; }
    const key = (lane as string).trim();
    // there was no duplicate check here at all, so two entries with one lane key were accepted and
    // spawnReviews then created two identical review subtasks for it
    const prior = seenLanes.get(keyOf(key));
    if (prior !== undefined) { errs.push(`pipeline.reviews[${i}]: duplicate lane ${JSON.stringify(lane)} (already configured as ${JSON.stringify(prior)}; the lane key is what a task's lanes selection matches, so two spellings are one lane with two keys)`); return; }
    seenLanes.set(keyOf(key), key);
    reviews.push({ lane: key, label: typeof label === 'string' && label.trim() ? label : key, manager: (manager as string).trim() });
  });
  return errs.length ? { error: errs.join(' | ') } : { pipeline: { autoAdvance: o.autoAdvance !== false, reviews } };
}

// agent registry from user JSON: rebuilt field-by-field like readPipeline, but malformed
// entries 400 with what failed instead of silently filtering (FB-48: error, never coerce)
const AGENT_KINDS: ProjectAgent['kind'][] = ['lane-manager', 'helper', 'orchestrator'];
function readAgents(v: unknown): { agents: ProjectAgent[] } | { error: string } {
  if (!Array.isArray(v)) return { error: 'agents must be an array of {name, kind, brief, trigger?}' };
  const agents: ProjectAgent[] = [];
  const errs: string[] = [];
  const seen = new Map<string, string>();
  v.forEach((r, i) => {
    if (!r || typeof r !== 'object' || Array.isArray(r)) { errs.push(`agents[${i}]: not an object`); return; }
    const { name, kind, brief, trigger } = r as Record<string, unknown>;
    const bad: string[] = [];
    if (typeof name !== 'string' || !name.trim()) bad.push('name (non-empty string) required');
    if (typeof kind !== 'string' || !AGENT_KINDS.includes(kind as ProjectAgent['kind'])) bad.push(`kind must be ${AGENT_KINDS.join('|')}`);
    if (typeof brief !== 'string' || !brief) bad.push('brief (non-empty string) required');
    if (trigger !== undefined && typeof trigger !== 'string') bad.push('trigger must be a string when present');
    if (bad.length) { errs.push(`agents[${i}]: ${bad.join('; ')}`); return; }
    // name is the assignment/lookup key: a duplicate makes every name-based lookup ambiguous, and a
    // case or whitespace variant is a duplicate — "Staff-Engineer" and " staff-engineer" were both
    // landing beside "staff-engineer" as separate assignee keys
    const clean = (name as string).trim();
    const prior = seen.get(keyOf(clean));
    if (prior !== undefined) { errs.push(`agents[${i}]: duplicate name ${JSON.stringify(name)} (already registered as ${JSON.stringify(prior)}; the name is the assignee key, so two spellings are one agent with two keys)`); return; }
    seen.set(keyOf(clean), clean);
    agents.push({ name: clean, kind: kind as ProjectAgent['kind'], brief: brief as string, ...(typeof trigger === 'string' ? { trigger } : {}) });
  });
  return errs.length ? { error: errs.join(' | ') } : { agents };
}

// stakeholders from user JSON, rebuilt field-by-field like readAgents. slackUserId is NOT decoration:
// Gabbar's feedback gate matches the verified slack sender id against this exact string
// (stakeholderGate in apps/gabbar/src/agent.ts) and fails closed, so a typo here is completely silent
// — the person keeps being refused, no error is raised anywhere, and the only symptom is a human
// saying "I reported that". The shape is therefore enforced rather than trusted: a slack user id is
// U or W followed by uppercase alphanumerics, which refuses the two plausible mistakes, a display
// name (@tanisha) and a channel id (C09...). It cannot tell a well-formed WRONG id from a right one;
// that is what the best-effort users.info lookup on the write routes is for.
// Names must be unique because the name is how the granular routes address a person, and slack ids
// must be unique because the id is what the gate matches.
const SLACK_USER_ID = /^[UW][A-Z0-9]{6,20}$/;
function readStakeholders(v: unknown): { stakeholders: Stakeholder[] } | { error: string } {
  if (!Array.isArray(v)) return { error: 'stakeholders must be an array of {name, slackUserId?, role?}' };
  const out: Stakeholder[] = [];
  const errs: string[] = [];
  const names = new Set<string>();
  const ids = new Set<string>();
  v.forEach((r, i) => {
    if (!r || typeof r !== 'object' || Array.isArray(r)) { errs.push(`stakeholders[${i}]: not an object`); return; }
    const { name, slackUserId, role } = r as Record<string, unknown>;
    const bad: string[] = [];
    if (typeof name !== 'string' || !name.trim()) bad.push('name (non-empty string) required');
    if (slackUserId !== undefined && (typeof slackUserId !== 'string' || !SLACK_USER_ID.test(slackUserId))) {
      bad.push(`slackUserId must be a slack USER id when present: "U" or "W" then uppercase letters/digits, e.g. U08SXQF8RTQ (got ${JSON.stringify(slackUserId)}). Gabbar's feedback gate matches this exact string against the verified sender, so a wrong one silently refuses a real person`);
    }
    if (role !== undefined && typeof role !== 'string') bad.push('role must be a string when present');
    if (bad.length) { errs.push(`stakeholders[${i}]: ${bad.join('; ')}`); return; }
    const key = keyOf(name as string);
    if (names.has(key)) { errs.push(`stakeholders[${i}]: duplicate name ${JSON.stringify(name)} (the name is how a stakeholder is addressed)`); return; }
    names.add(key);
    if (typeof slackUserId === 'string') {
      if (ids.has(slackUserId)) { errs.push(`stakeholders[${i}]: duplicate slackUserId ${slackUserId} (the id is what the feedback gate matches)`); return; }
      ids.add(slackUserId);
    }
    out.push({
      name: (name as string).trim(),
      ...(typeof slackUserId === 'string' ? { slackUserId } : {}),
      ...(typeof role === 'string' ? { role } : {}),
    });
  });
  return errs.length ? { error: errs.join(' | ') } : { stakeholders: out };
}

// Best effort, never blocking: a Mongo write must not depend on Slack being reachable or on the token
// carrying users:read. When Slack does answer, the display name is the confirmation an operator
// actually wants, and a user_not_found is the one warning that means "this person will still be
// refused". Same posture as slackThreadReply.
// The timeout is what makes "best effort" true rather than aspirational: this runs AFTER the mongo
// write has committed, so a Slack API that accepts the connection and never answers would hang the
// response on a change that is already saved, and the caller would have no idea which. Two seconds,
// then the lookup reports itself as unverified and the write is still reported as done.
const SLACK_LOOKUP_MS = 2000;
async function slackUserNote(id: string): Promise<string | null> {
  if (!config.slackBotToken) return null;
  try {
    const r = await fetch(`${config.slackApiBase}/users.info?user=${encodeURIComponent(id)}`, {
      headers: { authorization: `Bearer ${config.slackBotToken}` },
      signal: AbortSignal.timeout(SLACK_LOOKUP_MS),
    });
    const j = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string; user?: { name?: string; real_name?: string; deleted?: boolean } };
    if (j.ok && j.user) return `slack id ${id} resolves to ${j.user.real_name || j.user.name || '(unnamed)'}${j.user.deleted ? ' — WARNING: that account is deactivated' : ''}`;
    return `slack could NOT confirm ${id} (${j.error ?? `http ${r.status}`}) — the id shape is valid but unverified, and if it is the wrong id the feedback gate will keep refusing this person with no error anywhere`;
  } catch (e) {
    const why = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')
      ? `did not answer within ${SLACK_LOOKUP_MS}ms`
      : `failed (${String(e)})`;
    return `slack lookup for ${id} ${why} — the id was SAVED and the shape is valid, but nobody confirmed it belongs to the person you meant`;
  }
}

// proxy config from user JSON: rebuilt field-by-field like readPipeline/readAgents.
// Every field here is load-bearing for who can reach a dev server, so nothing is coerced:
// prefix is the URL segment and the routing key, and each public pattern IS the security
// boundary — an uncompilable regex errors rather than being dropped (FB-48/FB-56).
// public defaults to [] (route claimed, nothing reachable through the tunnel) and enabled
// defaults to false: sharing is always an explicit act.
const PROXY_RESERVED = ['p', 'api', 'files', '-']; // server's own paths; a prefix here shadows the board itself

// target must be a dev server on THIS machine, and the validator has to say so rather than the tool
// description: the proxy is what the permanent public domain fronts, so an arbitrary host with
// public:['/'] turns it into an open relay (FB-89). Loopback only. A private/LAN address is refused
// with its own reason — it is another box, and republishing it is exactly the open-relay case, just
// aimed inward. Link-local is named separately because 169.254.169.254 is the cloud metadata
// endpoint. A DNS name is refused because it can resolve anywhere; `localhost` is the only NAME with
// a fixed meaning. (FB-89 accepted "loopback, or at least private ranges" — this takes the tighter of
// the two; every route in use today is 127.0.0.1, so it costs nothing.)
//
// FB-108 closed the gap between that decision and the accept set:
//  · `*.localhost` is GONE. It was a DNS name this validator never resolves, exempted by a function
//    whose catch-all rejects DNS names precisely because they "can resolve anywhere" — which is
//    DNS-rebinding-shaped by construction. `http://evil.com.localhost:5173` was accepted, and only
//    landed on loopback here because mDNSResponder special-cases the reserved TLD; on glibc the name
//    NXDOMAINs and is retried against the DHCP search domain. That is a property of the resolver,
//    not of the validator.
//  · 0.0.0.0 / :: / ::ffff:127.x are ACCEPTED. They are the unspecified addresses, and connect() to
//    them goes to loopback — 0.0.0.0 in particular is the string Vite/uvicorn print under --host, so
//    rejecting it as "a public address" was both wrong and the likeliest real friction of the feature.
//  · a single trailing dot (the DNS root label) is normalised before any check, so `localhost.` and
//    `127.0.0.1.` no longer disagree.
//  · userinfo is REJECTED: Bun's fetch does not put those credentials on the wire, so an operator who
//    configures auth this way silently gets none, and the string is persisted into the doc and into
//    routes.json.
// Returns the PARSED href, not the raw string: ' http://localhost:5173' validated and then broke
// every HMR upgrade (proxy.ts does target.replace(/^http/,'ws')), and a trailing space 502'd forever.
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const LOOPBACK = 'localhost, 127.0.0.0/8, ::1, or an unspecified address (0.0.0.0, ::)';
const RELAY_WHY = 'the proxy is publicly reachable through the tunnel, so anything else is an open relay onto a host that never agreed to be published';
// exported for proxy-target.test.ts: this function IS the boundary between "a dev server on this
// machine" and an open relay, and a boundary with no test is a boundary until somebody edits it.
export function readTarget(s: string): { target: string } | { error: string } {
  const err = (error: string) => ({ error });
  let u: URL;
  try { u = new URL(s.trim()); } catch { return err('must be an http(s) URL string, e.g. http://localhost:5173'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return err(`must be http(s), not ${u.protocol}`);
  if (u.username || u.password) {
    return err('must not carry userinfo (user:pass@) — fetch does not send those credentials upstream, so the target would be reached with NO auth while the password sits in the project doc and in routes.json');
  }
  // the proxy forwards `${target}${path}${search}`, so a target search/hash lands mid-URL
  if (u.search) return err(`must not carry a query string (the proxy appends the request path and query, so "${s}" becomes a garbage upstream URL)`);
  if (u.hash) return err(`must not carry a fragment (the proxy appends the request path, so "${s}" becomes a garbage upstream URL)`);
  // strip the brackets of an IPv6 literal and one trailing root dot; both are notation, not identity
  const h = u.hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '').replace(/\.$/, '');
  // LOOPBACK INCLUDES US, and that is the hole every branch below shared (DAR-214). Loopback-only is
  // the right rule and it stays; what it never said is that two of the things on loopback are darbar
  // itself and the front door. A project proxy of {target:"http://127.0.0.1:<our port>", public:["/"]}
  // is a legal route by every check above and tunnels the ENTIRE api through a share link: every
  // task, every feedback body, every charter, the local-only routes, and every write endpoint —
  // reached with no capability id, because the prefix is stripped and the rest of the path is
  // forwarded verbatim. Pointing one at the PROXY's own port is the same shape aimed at the front
  // door, and loops it onto itself besides. Neither is a dev server, which is the only thing this
  // field is for, so both are refused here rather than being left to whoever writes `public` next.
  // The check sits on the single accept path so every spelling of loopback is covered at once
  // (localhost, 127.x, 0.0.0.0, ::1, ::, ::ffff:127.x) — a port is a port however the host is written.
  // The DEFAULT route in routes.json legitimately targets this server; it is written by the proxy
  // itself and never comes through here.
  const port = u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80);
  const OURS: [number, string][] = [
    [config.port, `darbar itself — a route pointed here publishes the WHOLE api through the share link (every task, every feedback body, every charter, and the write routes), not a dev server`],
    [config.proxyPort, `the proxy itself — that is the front door, so a route pointed here republishes the tunnel through itself rather than reaching a dev server`],
  ];
  // origin+pathname, never u.href: href normalises a bare origin to a TRAILING SLASH, and the proxy
  // forwards `${target}${path}` with path already starting with '/', so that would double-slash every
  // upstream URL. Stripping the trailing slash also keeps the DAR-153 base-path form intact
  // (http://127.0.0.1:5173/fe stays exactly that, which is what stops Vite's 302 loop).
  const ok = (): { target: string } | { error: string } => {
    const mine = OURS.find(([n]) => n === port);
    if (mine) return err(`port ${port} on "${u.hostname}" is ${mine[1]}. proxy.target must be a dev server on this machine (${LOOPBACK}), on some other port`);
    return { target: (u.origin + u.pathname).replace(/\/+$/, '') };
  };
  if (h === 'localhost') return ok();
  const v4 = (a: string): string | null => {
    const m = IPV4.exec(a);
    if (!m) return `host "${u.hostname}" is not a valid address`;
    const o = m.slice(1).map(Number) as [number, number, number, number];
    if (o.some((n) => n > 255)) return `host "${u.hostname}" is not a valid address`;
    if (o[0] === 127) return null;
    if (o[0] === 0 && o[1] === 0 && o[2] === 0 && o[3] === 0) return null; // unspecified: connects to loopback
    if (o[0] === 169 && o[1] === 254) {
      return `host "${u.hostname}" is link-local (169.254/16 carries the cloud metadata endpoint) — proxy.target must be a dev server on this machine (${LOOPBACK})`;
    }
    const priv = o[0] === 10 || (o[0] === 172 && o[1] >= 16 && o[1] <= 31) || (o[0] === 192 && o[1] === 168);
    if (priv) return `host "${u.hostname}" is a private/LAN address, i.e. another machine — proxy.target must be a dev server on this machine (${LOOPBACK}); ${RELAY_WHY}`;
    return `host "${u.hostname}" is a public address — proxy.target must be a dev server on this machine (${LOOPBACK}); ${RELAY_WHY}`;
  };
  if (IPV4.test(h)) { const bad = v4(h); return bad ? err(bad) : ok(); }
  // a colon means an IPv6 LITERAL, never a name — say so rather than falling through to "DNS name"
  if (h.includes(':')) {
    if (h === '::1' || h === '::') return ok(); // loopback and unspecified
    // IPv4-mapped: judge it by the IPv4 rules. WHATWG canonicalises ::ffff:127.0.0.1 to the HEX form
    // ::ffff:7f00:1 by the time it reaches u.hostname, so both spellings have to be understood.
    const mapped = /^::ffff:(.+)$/.exec(h);
    if (mapped) {
      const rest = mapped[1]!;
      const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(rest);
      const dotted = hex
        ? [parseInt(hex[1]!, 16) >> 8, parseInt(hex[1]!, 16) & 0xff, parseInt(hex[2]!, 16) >> 8, parseInt(hex[2]!, 16) & 0xff].join('.')
        : rest;
      const bad = v4(dotted);
      return bad ? err(bad) : ok();
    }
    if (/^f[cde][0-9a-f]{0,2}:/.test(h)) return err(`host "${u.hostname}" is a private/link-local IPv6 address, i.e. another machine — proxy.target must be a dev server on this machine (${LOOPBACK}); ${RELAY_WHY}`);
    return err(`host "${u.hostname}" is an IPv6 address outside loopback — proxy.target must be a dev server on this machine (${LOOPBACK}); ${RELAY_WHY}`);
  }
  return err(`host "${u.hostname}" is a DNS name, which can resolve anywhere and is resolved at REQUEST time, not here — proxy.target must be a dev server on this machine, addressed literally (${LOOPBACK})`);
}

// `public` is NOT a regex list any more (FB-107). Two rounds of trying to make user regex safe at
// validation time failed for a structural reason: cost at a FIXED short path is unbounded in PATTERN
// length (`^/`+`.*`xK+`x$` on a 64-char path: 0.1ms at K=3, 11958ms at K=8, and the 200-char cap
// allowed K≈95), so no probe alphabet, no probe length and no length cap bounds the right variable —
// and moving the check to request time does not help either, because terminate() cannot preempt a
// thread already inside the backtracking loop. So the boundary is now a small pattern LANGUAGE that
// is matched with string operations (pathPatternError / matchPathPattern in @darbar/core). The
// safety argument is structural — there is no engine that can backtrack — rather than a measurement.
// Every allowlist in use across the whole system was already a literal prefix, so nothing expressive
// is lost. Anything that still looks like a regex is refused here with the form spelled out.

function readProxy(v: unknown): { proxy: ProjectProxy } | { error: string } {
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    return { error: 'proxy must be an object {prefix, target, public?, enabled?} — or null to clear' };
  }
  const o = v as Record<string, unknown>;
  const errs: string[] = [];
  if (typeof o.prefix !== 'string' || !/^[A-Za-z0-9_-]+$/.test(o.prefix)) {
    errs.push('proxy.prefix must be a non-empty string of [A-Za-z0-9_-] (it is the URL segment and the routing key)');
  } else if (PROXY_RESERVED.includes(o.prefix)) {
    errs.push(`proxy.prefix "${o.prefix}" is reserved (${PROXY_RESERVED.join(', ')} are the server's own paths)`);
  }
  let target = '';
  if (typeof o.target !== 'string' || !o.target) {
    errs.push('proxy.target must be an http(s) URL string, e.g. http://localhost:5173');
  } else {
    const t = readTarget(o.target);
    if ('error' in t) errs.push(`proxy.target ${t.error}`);
    else target = t.target; // normalised href, so a stray space cannot 502 forever or break ws://
  }
  if (o.enabled !== undefined && typeof o.enabled !== 'boolean') errs.push('proxy.enabled must be a boolean when present');
  const pub: string[] = [];
  if (o.public !== undefined) {
    if (!Array.isArray(o.public)) errs.push(`proxy.public must be an array of path patterns, e.g. ["/$","/assets/"] — each is ${PATH_PATTERN_FORM}`);
    else o.public.forEach((r, i) => {
      const bad = pathPatternError(r);
      if (bad) { errs.push(`proxy.public[${i}] (${JSON.stringify(r)}): rejected — it ${bad}`); return; }
      pub.push(r as string);
    });
  }
  if (errs.length) return { error: errs.join(' | ') };
  return { proxy: { prefix: o.prefix as string, target, public: pub, enabled: o.enabled === true } };
}

// ---------- proxy route reconciliation ----------
// The server owns the proxy route table, but "owns" is not "cannot fail": a push can fail with the
// doc already written, so the doc states INTENT (project.proxy) and a second field states FACT
// (project.proxyPublished — what we actually put in the table and have not withdrawn). Every push is
// best-effort like slackThreadReply, and the boot pass is a real SYNC that converges the two in both
// directions (FB-87). Prefixes we did not publish are never touched: the namespace is shared with
// hand-added routes and taking one over is an exposure change (FB-96).

type LiveRoute = { target: string; public: string[] };
type LiveRoutes = { default: LiveRoute; prefixes: Record<string, LiveRoute> };

async function proxyAdmin(path: string, method: string, body?: unknown): Promise<unknown> {
  if (!config.proxyAdminToken) throw new Error('PROXY_ADMIN_TOKEN not configured');
  const r = await fetch(`http://127.0.0.1:${config.proxyPort}${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${config.proxyAdminToken}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${method} ${path} → http ${r.status}`);
  return r.json().catch(() => null);
}

async function fetchRoutes(): Promise<LiveRoutes> {
  const j = (await proxyAdmin('/-/routes', 'GET')) as LiveRoutes | null;
  if (!j || typeof j !== 'object' || !j.prefixes) throw new Error('GET /-/routes returned no route table');
  return j;
}

const publishRoute = (x: PublishedRoute) =>
  proxyAdmin('/-/route', 'POST', { prefix: x.prefix, target: x.target, public: x.public });

// ownership token: a live prefix is ours only while it still carries exactly what we published.
// Once a hand edit or another writer changes it, it is theirs and we neither re-claim nor delete it.
const sameRoute = (a: LiveRoute | PublishedRoute | null | undefined, b: LiveRoute | PublishedRoute | null | undefined): boolean =>
  !!a && !!b && a.target === b.target && a.public.length === b.public.length && a.public.every((x, i) => x === b.public[i]);

const wantOf = (x: ProjectProxy | null | undefined): PublishedRoute | null =>
  x?.enabled ? { prefix: x.prefix, target: x.target, public: x.public } : null;

// Would applying `after` make MORE reachable than `before` already does? Only such a change can put
// a route over one this project does not own, which is the only thing the hijack guard protects
// (FB-105). Disabled publishes nothing. Otherwise it is a de-escalation when the route identity is
// unchanged (same prefix, same target, already enabled) and the new allowlist is a subset of the old.
function escalates(before: ProjectProxy | null | undefined, after: ProjectProxy): boolean {
  if (!wantOf(after)) return false;
  if (!before?.enabled || before.prefix !== after.prefix || before.target !== after.target) return true;
  const was = new Set(before.public);
  return !after.public.every((s) => was.has(s));
}

// Two renderings on purpose. Project events are shipped by GET /p/:capId, which IS on the proxy's
// public allowlist, so anything written into an event is readable by a board-link holder — the
// target must not appear there any more than it appears in the board payload itself (FB-89). The
// allowlist is what an event needs to state anyway: it is the boundary. The full detail goes to the
// server console and to the 409/context responses, all of which are local-only.
const routePub = (r: LiveRoute | PublishedRoute) => `public: ${r.public.join(', ') || 'nothing'}`;
const routeDesc = (r: LiveRoute | PublishedRoute) => `${r.target} (${routePub(r)})`;

// the route work and the doc write are both already done by the time this runs: a logging hiccup must
// not be reported as a sync failure, and must not escape as a 500 on a committed write (FB-90)
async function safeLog(projectId: ObjectId, text: string) {
  try { await logEvent(projectId, text); } catch (e) { console.error(`project event log FAILED (${text}): ${String(e)}`); }
}

async function saveHeld(projectId: ObjectId, held: PublishedRoute[]) {
  try { await Projects.updateOne({ _id: projectId }, { $set: { proxyPublished: held } }); }
  catch (e) { console.error(`proxyPublished write FAILED for ${projectId.toString()}: ${String(e)}`); }
}

// Withdraw one route we hold. Returns whether we still hold it afterwards.
async function withdrawHeld(h: PublishedRoute, live: LiveRoutes, notes: string[]): Promise<boolean> {
  const cur = live.prefixes[h.prefix];
  if (!cur) { notes.push(`proxy route /${h.prefix}/ was already absent`); return false; }
  if (!sameRoute(cur, h)) {
    console.error(`proxy route /${h.prefix}/ not removed: now serves ${routeDesc(cur)}, this project published ${routeDesc(h)}`);
    notes.push(`proxy route /${h.prefix}/ NOT removed: it no longer serves what this project published (now ${routePub(cur)}) — it belongs to someone else and was left alone`);
    return false;
  }
  try { await proxyAdmin(`/-/route/${h.prefix}`, 'DELETE'); delete live.prefixes[h.prefix]; notes.push(`proxy route removed: /${h.prefix}/`); return false; }
  catch (e) { notes.push(`proxy route /${h.prefix}/ NOT removed (${String(e)}) — it is STILL LIVE; the next change or a server restart will withdraw it`); return true; }
}

// Publish the route this project wants. Returns whether we hold it afterwards.
async function publishWanted(want: PublishedRoute, held: PublishedRoute[], live: LiveRoutes, notes: string[]): Promise<boolean> {
  const cur = live.prefixes[want.prefix];
  const ours = held.find((h) => h.prefix === want.prefix) ?? null;
  if (cur && !sameRoute(cur, want) && !sameRoute(cur, ours)) {
    console.error(`proxy route /${want.prefix}/ not published: prefix already serves ${routeDesc(cur)}, wanted ${routeDesc(want)}`);
    notes.push(`proxy route /${want.prefix}/ NOT published: the prefix is already held by a route this project did not publish (${routePub(cur)}) — publishing would repoint someone else's URL and replace their allowlist`);
    return false;
  }
  if (sameRoute(cur, want)) { notes.push(`proxy route /${want.prefix}/ already correct`); return true; }
  try {
    await publishRoute(want);
    live.prefixes[want.prefix] = { target: want.target, public: want.public };
    console.log(`proxy route published: /${want.prefix}/ → ${routeDesc(want)}`);
    notes.push(`proxy route published: /${want.prefix}/ (${routePub(want)})`);
    return true;
  }
  catch (e) { notes.push(`proxy route /${want.prefix}/ NOT published (${String(e)}) — the share is configured but the link does not resolve; the next change or a server restart will publish it`); return false; }
}

// ONE convergence pass, used by both callers (a PATCH and the boot sync). It was copy-pasted before,
// which is exactly how the fail-open below came to exist in two places that then had to be fixed twice.
// `held` is project.proxyPublished going in — what is live because of us, not what the doc wants.
// Withdrawal is driven off it rather than off the previous config, so a clear ($unset) is still
// convergeable (FB-87 trace 3), and a failed delete keeps its orphan recorded instead of losing it.
// The publish is attempted even when the withdrawal failed, so a rename never loses BOTH ends (trace 2).
// Returns what this project holds after the pass.
async function convergeRoutes(held: PublishedRoute[], want: PublishedRoute | null, live: LiveRoutes, notes: string[]): Promise<PublishedRoute[]> {
  const next: PublishedRoute[] = [];
  // FB-103. The held entry for the WANTED prefix is the ownership token that proves the live route is
  // ours, and it must survive until the publish is CONFIRMED. Dropping it up front (the withdraw loop
  // used to `continue` past it, and only a truthy publish put it back) meant a same-prefix edit with a
  // failing POST left the old route live with proxyPublished:[] — after which the boot sync REFUSED to
  // repair its own route ("held by a route this project did not publish", the token being gone) and a
  // later clear made zero proxy calls while logging a false "no route published" all-clear. That is
  // permanently unconvergeable plus a confident wrong answer, over a dev server still on public ["/"].
  const prior = want ? held.find((h) => h.prefix === want.prefix) ?? null : null;
  for (const h of held) {
    if (want && h.prefix === want.prefix) continue; // the publish below decides this prefix's fate
    if (await withdrawHeld(h, live, notes)) next.push(h);
  }
  if (want) {
    if (await publishWanted(want, held, live, notes)) next.push(want);
    // publish failed: whatever we had on that prefix is STILL LIVE and still ours. Keep the token so
    // the next pass can recognise and repair it. (If someone else has since taken the prefix over,
    // withdrawHeld will see that and drop it then — the safe direction is to keep the record.)
    else if (prior) next.push(prior);
  }
  return next;
}

async function reconcileProxy(projectId: ObjectId, held: PublishedRoute[], after: ProjectProxy | null) {
  const want = wantOf(after);
  const notes: string[] = [];
  // nothing live because of us and nothing to publish: the table is not involved, so do not touch it
  // (and do not raise a scary "unreachable" note about a save that never needed it — FB-90)
  if (!held.length && !want) { await safeLog(projectId, 'proxy config saved (disabled — no route published)'); return; }
  let live: LiveRoutes | null = null;
  try { live = await fetchRoutes(); } catch (e) { notes.push(`proxy route table unreachable (${String(e)}) — nothing was published or withdrawn; the boot sync will converge it`); }

  const next = live ? await convergeRoutes(held, want, live, notes) : held;
  if (!notes.length) notes.push('proxy config saved (disabled — no route published)');

  const changed = next.length !== held.length || next.some((h, i) => h.prefix !== held[i]?.prefix || !sameRoute(h, held[i]));
  if (changed) await saveHeld(projectId, next);
  await safeLog(projectId, notes.join(' · '));
}

// Boot SYNC (not a re-publish pass): reads the live table once and converges it against every
// project doc in BOTH directions — publish what is missing, withdraw what we published and no longer
// want. Prefixes nobody's doc claims are left strictly alone, so a hand-added route survives.
// routes.json persists across a proxy restart, so this is not about a restart losing entries — it is
// the only thing that ever repairs a push that failed while the proxy was down.
// The proxy may not be up at all: log and continue, never block the server from starting.
export async function reconcileAllProxies() {
  let live: LiveRoutes;
  try { live = await fetchRoutes(); }
  catch (e) { console.error(`proxy route sync SKIPPED: cannot read the route table (${String(e)}) — routes may differ from the project docs until the next change`); return; }

  const rows = await Projects.find({ $or: [{ proxy: { $exists: true } }, { proxyPublished: { $exists: true, $ne: [] } }] }).toArray();
  for (const p of rows) {
    const held = p.proxyPublished ?? [];
    const want = wantOf(p.proxy);
    if (!held.length && !want) continue;
    const notes: string[] = [];
    const next = await convergeRoutes(held, want, live, notes); // same implementation as the PATCH path
    if (!notes.length) continue;
    console.log(`proxy sync (${p.prefix}): ${notes.join(' · ')}`);
    const changed = next.length !== held.length || next.some((h, i) => h.prefix !== held[i]?.prefix || !sameRoute(h, held[i]));
    if (changed) await saveHeld(p._id!, next);
    // a sync that changed or refused something changed the EXPOSURE state, which is the one thing
    // this feature owes the board; only the pure no-op ("already correct") is left as console noise
    if (!notes.every((n) => n.includes('already correct'))) await safeLog(p._id!, `proxy route sync at boot: ${notes.join(' · ')}`);
  }
}

// ---------- review pipeline engine ----------
// All three live server-side so the rules hold no matter who moves a task (UI drag, MCP, curl).

const openReviewCount = (parentId: ObjectId) =>
  Tasks.countDocuments({ parentTaskId: parentId, type: 'review', status: { $nin: CLOSED } });

// feedback rows still blocking a task; needs_clarification is with the reporter, so not blocking
const OPEN_FEEDBACK: FeedbackStatus[] = ['pending', 'triaged', 'accepted', 'in_progress'];
const openFeedbackShortIds = async (taskId: ObjectId) =>
  (await Feedback.find({ taskId, status: { $in: OPEN_FEEDBACK } }, { projection: { shortId: 1 } }).toArray())
    .map((f) => f.shortId);

// dev task entered in_review -> one review subtask per configured lane, assigned to the lane manager.
// task.lanes narrows the configured lanes when set (null/absent = all).
// A re-entry after rework spawns a fresh round only once the previous round is fully closed.
async function spawnReviews(t: Task) {
  const p = await Projects.findOne({ _id: t.projectId });
  if (!p) return;
  const want = t.lanes ?? null;
  const lanes = (p.pipeline?.reviews ?? []).filter((l) => !want || want.includes(l.lane));
  if (await openReviewCount(t._id!)) return;
  if (lanes.length === 0) {
    if (!want) return; // no pipeline configured: task waits in in_review as before
    // explicit selection spawned nothing, so no child close will ever advance this task — do it now
    await logEvent(p._id!, `${t.shortId}: no review lanes selected — skipping reviews`, t._id);
    await maybeAdvanceParent(t._id!); // respects the feedback gate and autoAdvance
    return;
  }
  for (const l of lanes) {
    const doc: Task = {
      projectId: p._id!,
      shortId: await nextShortId(p._id!, 'task'),
      parentTaskId: t._id!,
      title: `${l.label}: ${t.title}`,
      description: `pipeline-spawned ${l.label} of ${t.shortId}. The lane manager reassigns to a subagent, files findings as feedback on ${t.shortId}, and closes this when the lane passes.`,
      status: 'todo',
      type: 'review',
      lane: l.lane,
      assignee: l.manager,
      assigneeType: 'agent',
      origin: `pipeline:${t.shortId}`,
      commits: [],
      blocker: null,
      notes: '',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await Tasks.insertOne(doc);
    await logEvent(p._id!, `${doc.shortId} spawned: ${l.label} review of ${t.shortId} → ${l.manager}`, doc._id);
  }
}

// last review child closed -> parent leaves in_review (autoAdvance) or waits for an explicit push
async function maybeAdvanceParent(parentId: ObjectId) {
  const parent = await Tasks.findOne({ _id: parentId });
  if (!parent || parent.status !== 'in_review') return;
  if (await openReviewCount(parentId)) return;
  const fbIds = await openFeedbackShortIds(parentId);
  if (fbIds.length) {
    await logEvent(parent.projectId, `${parent.shortId}: reviews closed but ${fbIds.length} open feedback (${fbIds.join(', ')}) — holding`, parent._id);
    return;
  }
  const p = await Projects.findOne({ _id: parent.projectId });
  if (p?.pipeline?.autoAdvance === false) {
    await logEvent(parent.projectId, `${parent.shortId}: all reviews closed — awaiting explicit push out of in_review`, parent._id);
    return;
  }
  // ---------- DAR-259: the advance itself is the lock ----------
  // Every line above this one is a READ, so two review children closing together both find the
  // parent in_review and both find zero open children before either writes. Measured on this rig,
  // not argued: the very first race produced two "auto-advanced → done" events on one row.
  //
  // The status write is idempotent, which is why this stayed invisible; the CASCADE hanging off it
  // is not. Both racers log the advance, and both go on to resolvePromotedFeedback — which resolves
  // the same feedback rows twice and posts the "*FB-n resolved.*" reply into the real Slack thread
  // once per racer. Duplicate events on the board and duplicate messages to a human are the damage.
  //
  // So the precondition this function already read moves INTO the write, and only the racer that
  // actually flips the row runs the cascade. NARROW on purpose: this write is the one in_review →
  // done advance, it carries no caller-supplied body, and the loser has nothing to report — its own
  // request (closing a review child) landed in full and the parent really is done. Uncontended
  // advances are unchanged: the same single write, no extra read.
  // dispatchedAt goes with the status change here too: a shipped task has nothing outstanding
  const advanced = await Tasks.updateOne(
    { _id: parentId, status: 'in_review' as TaskStatus },
    { $set: { status: 'done', dispatchedAt: null, updatedAt: new Date() } },
  );
  if (advanced.matchedCount === 0) return; // a concurrent closer advanced it and owns the cascade
  await logEvent(parent.projectId, `${parent.shortId} auto-advanced → done (all reviews closed)`, parent._id);
  const shipped = await Tasks.findOne({ _id: parentId });
  if (shipped) await resolvePromotedFeedback(shipped);
}

// task shipped -> feedback PROMOTED to it (resolvedTaskId) auto-resolves and the thread hears the ending.
// Asymmetric with the done-gate on purpose: rows FILED ON a task (taskId) still block done.
// Direct updateOne + reply here — never re-enters the PATCH /feedback route.
const PROMOTED_OPEN: FeedbackStatus[] = ['triaged', 'accepted', 'in_progress'];
async function resolvePromotedFeedback(task: Task) {
  if (task.type === 'review') return; // reviews are never promotion targets
  const rows = await Feedback.find({ resolvedTaskId: task._id, status: { $in: PROMOTED_OPEN } }).toArray();
  if (rows.length === 0) return;
  const last = task.commits[task.commits.length - 1];
  const resolution = `shipped: ${task.shortId} (${task.title}) is done${last ? ` (commit ${last})` : ''}`;
  // ---------- DAR-262: the resolution of each ROW is the lock ----------
  // The find above is a READ, and this function has a second caller the two fixes above do not
  // cover: PATCH /tasks/:ref with {status: 'done'}, which any number of clients can send at once on
  // one task. All of them read the same open rows and all of them resolve each one. Measured on this
  // rig: 3 concurrent closes, 2 promoted rows, 6 "auto-resolved" events and the same
  // "*FB-n resolved.*" posted into the reporter's Slack thread 3 times. Board litter is the cheap
  // half; the message to a human is the reason this one was worth fixing.
  //
  // PER ROW, NOT PER TASK, because the racers do not divide cleanly: the same run produced one row
  // resolved once and the other three times in a single iteration. Whoever wins the write on a row
  // owns that row's event and that row's reply, and a claim scoped to the task would have handed one
  // racer rows another had already announced.
  //
  // AND NOT ON THE CALLER'S WRITE. Unlike DAR-256, the patch that gets here carries a body — a
  // `notes`, an `addCommit`, an `assignee` can ride along with the status. A conditional up there
  // would answer 200 having applied none of it, which is the silent drop the rest of this route
  // exists to stop. So every closer's own patch lands in full and every closer is told the truth
  // about the row; only the cascade has a single owner. Uncontended closes are unchanged: the same
  // one write per row, no extra read.
  const claimed: typeof rows = [];
  for (const fb of rows) {
    const won = await Feedback.updateOne(
      { _id: fb._id, status: { $in: PROMOTED_OPEN } },
      { $set: { status: 'resolved', resolution, updatedAt: new Date() } },
    );
    if (won.matchedCount === 0) continue; // a concurrent closer resolved this row and owns its reply
    claimed.push(fb);
    await logEvent(fb.projectId, `${fb.shortId} auto-resolved: ${task.shortId} shipped`, fb.taskId);
    await slackThreadReply(fb, `*${fb.shortId} resolved.* ${resolution}`.trim());
  }
  // rows just resolved may have been the last hold on the task they were FILED ON. Only the rows
  // THIS call resolved: a row somebody else claimed is somebody else's cascade to run, and they run
  // it — dropping it here cannot lose the advance, and keeping it would re-read the same parent.
  const filedOn = new Map(claimed.filter((fb) => fb.taskId).map((fb) => [fb.taskId!.toHexString(), fb.taskId!]));
  for (const id of filedOn.values()) await maybeAdvanceParent(id);
}

// ---------- project archived with cancelOpen: close the rows, and say why on each one ----------
// Direct writes rather than a re-entry into PATCH /tasks/:ref, the same way resolvePromotedFeedback
// does it: this is one decision cascading, not N independent edits, and the task route's own gates
// are about a row moving on its own (the done-gate, the lanes freeze, the review-round guard) and
// mean nothing to a row being closed because its project ended.
//
// The REASON is the point. A row that just turns up cancelled with an empty note is unreadable in a
// month, which is the same defect as an archive with no reason one level down. It is APPENDED to
// `notes` and never overwrites them, because whatever the builder wrote there is the other half of
// the story. This is also the shape the project-init skill already teaches by hand ("cancel what
// will not be done, with a reason in notes"), so a cancelled row reads the same however it got there.
//
// ONE event for the whole cascade, not one per row: logEvent pushes an SSE tick to every connected
// board, and 82 of those is a burst that buries the archive itself. The per-row record lives in the
// notes, which is where somebody looking at that row will actually be.
async function cancelForArchive(p: Project, rows: Task[], at: Date, reason?: string) {
  const day = at.toISOString().slice(0, 10);
  const why = `cancelled: ${p.prefix} was archived on ${day} and this row was still open, so it did not ship.${reason ? ` Archive reason: ${reason}` : ''}`;
  for (const t of rows) {
    const notes = t.notes ? `${t.notes.replace(/\s+$/, '')}\n${why}` : why;
    // dispatchedAt goes with the status change, as everywhere else: a closed row has nothing
    // outstanding, and a stamp left behind would read as a live hand-off on the board
    await Tasks.updateOne({ _id: t._id }, { $set: { status: 'cancelled', notes, dispatchedAt: null, updatedAt: new Date() } });
  }
  const ids = rows.map((t) => t.shortId);
  const named = ids.slice(0, 8).join(', ') + (ids.length > 8 ? `, and ${ids.length - 8} more` : '');
  await logEvent(p._id!, `${rows.length} open row(s) cancelled by the archive of ${p.prefix}: ${named}. Each row carries the reason in its notes`);
}

async function resolveProject(ref: string) {
  if (ObjectId.isValid(ref)) {
    const byId = await Projects.findOne({ _id: new ObjectId(ref) });
    if (byId) return byId;
  }
  return Projects.findOne({ $or: [{ capId: ref }, { prefix: ref.toUpperCase() }, { name: ref }] });
}

// ---------- projects ----------

api.post('/projects', async (c) => {
  const b = await readBody(c);
  if (!b) return c.json({ error: 'invalid json body' }, 400);
  const name = str(b.name), prefix = str(b.prefix);
  if (!name || !prefix || !/^[A-Za-z]{2,6}$/.test(prefix)) {
    return c.json({ error: 'name (string) and prefix (2-6 letters) required' }, 400);
  }
  const badTypes = typeErrors(b, { charter: 'string', slackChannel: 'string|null', repos: 'string[]' });
  if (badTypes.length) return c.json({ error: badTypes.join(' | ') }, 400);
  // name and prefix ARE applied here, so they are not refused; the server-owned rest still is
  const badFields = notApplied(b, PROJECT_VOCAB, [...CONFIG_FIELDS, 'name', 'prefix']);
  if (badFields) return c.json({ error: badFields }, 400);
  // stakeholders were stored raw here, which let a malformed slackUserId in at CREATE time and then
  // silently refuse that person at Gabbar's gate forever. Same reader as every later write.
  const people = readStakeholders(b.stakeholders ?? []);
  if ('error' in people) return c.json({ error: people.error }, 400);
  // pipeline, agents and proxy were DROPPED here under a 200, which is the only reason registering a
  // project takes a POST and then a PATCH. They are honoured now, through applyConfig — the one
  // config write path — so the readers, the event log, the proxy reconciliation and the warnings are
  // identical to every later edit rather than a second implementation that can drift from it.
  // Validated BEFORE the insert, so a malformed pipeline is a 400 with nothing created, not a project
  // left half-configured. (The prefix claim is re-checked inside applyConfig; the pre-check exists so
  // the 409 does not arrive after the project row is already written.)
  const cfg: Record<string, unknown> = {};
  for (const k of ['pipeline', 'agents', 'proxy'] as const) if (b[k] !== undefined) cfg[k] = b[k];
  if (cfg.pipeline !== undefined) {
    const parsed = readPipeline(cfg.pipeline);
    if ('error' in parsed) return c.json({ error: parsed.error }, 400);
  }
  if (cfg.agents !== undefined) {
    const parsed = readAgents(cfg.agents);
    if ('error' in parsed) return c.json({ error: parsed.error }, 400);
  }
  if (cfg.proxy !== undefined && cfg.proxy !== null) {
    const parsed = readProxy(cfg.proxy);
    if ('error' in parsed) return c.json({ error: parsed.error }, 400);
    const owner = await Projects.findOne({ 'proxy.prefix': parsed.proxy.prefix });
    if (owner) return c.json({ error: `proxy prefix "${parsed.proxy.prefix}" is already claimed by project ${owner.prefix} (${owner.name})` }, 409);
  }
  const doc = {
    name,
    prefix: prefix.toUpperCase(),
    capId: capId(),
    repos: strArr(b.repos),
    charter: str(b.charter) ?? '',
    stakeholders: people.stakeholders,
    slackChannel: strOrNull(b.slackChannel) ?? null,
    counters: { task: 0, feedback: 0 },
    createdAt: new Date(),
  };
  try {
    await Projects.insertOne(doc as never);
  } catch (e: unknown) {
    if ((e as { code?: number }).code === 11000) return c.json({ error: `prefix ${doc.prefix} already exists` }, 409);
    throw e;
  }
  const created = doc as unknown as Project;
  await logEvent(created._id!, `project created: ${doc.name}`);
  if (Object.keys(cfg).length === 0) return c.json({ ...doc, boardUrl: `${config.baseUrl}/p/${doc.capId}`, warnings: [] });
  const r = await applyConfig(created, cfg);
  // pre-validated above with the same readers, so this is reachable only if the prefix claim was won
  // by another writer in between. Say what exists and what did not apply, rather than a bare 409.
  if (failed(r)) {
    return c.json({ error: `project ${doc.prefix} WAS created (board ${config.baseUrl}/p/${doc.capId}), but its ${Object.keys(cfg).join('/')} config was not applied: ${r.error}` }, r.status);
  }
  return c.json({ ...r.doc, boardUrl: `${config.baseUrl}/p/${doc.capId}`, warnings: r.warnings });
});

// ---------- the archived default, and why it is exclude ----------
// Four things read this list and every one of them treats it as "the projects that are live": the
// console grid, the MCP and Gabbar project tools, the tick sweep and the handoff snapshot. So the
// question is which way a consumer that has NOT been updated should fail. Defaulting to include
// means every one of them has to grow a filter, and the one that forgets reports finished work as
// pending forever, which is the thing archiving exists to stop. Defaulting to exclude means an
// un-updated consumer gets the SAFE answer and the cost is a project that is merely harder to find,
// which the explicit parameter fixes and which `archivedAt` on every row makes visible anyway.
//
// A BAD VALUE IS A 400, not a fallback to the default. `?archived=1` silently meaning "active only"
// is the same silent drop as a body field a route does not apply, one layer along in the query
// string, and it would hide exactly the projects the caller asked to see.
const ARCHIVED_QUERY = ['false', 'true', 'all'];
api.get('/projects', async (c) => {
  const want = c.req.query('archived') ?? 'false';
  if (!ARCHIVED_QUERY.includes(want)) {
    return c.json({ error: `archived must be one of ${ARCHIVED_QUERY.join(', ')} (got ${JSON.stringify(want)}); it defaults to "false", which lists ACTIVE projects only. "true" lists archived projects only and "all" lists both. Every row carries archivedAt either way` }, 400);
  }
  // `archivedAt: null` matches an explicit null AND a missing field, which is exactly the population
  // of projects that were registered before archiving existed plus every one since put back.
  const scope = want === 'all' ? {} : want === 'true' ? { archivedAt: { $ne: null } } : { archivedAt: null };
  const list = await Projects.find(scope, { projection: { charter: 0 } }).sort({ createdAt: -1 }).toArray();
  const withCounts = await Promise.all(list.map(async (p) => {
    const [tasks, done, cancelled, pendingFb] = await Promise.all([
      Tasks.countDocuments({ projectId: p._id }),
      Tasks.countDocuments({ projectId: p._id, status: 'done' }),
      // cancelled rides along so the console can keep its fraction consistent with the board
      // header, which excludes cancelled rows ("not counted here") from the denominator
      Tasks.countDocuments({ projectId: p._id, status: 'cancelled' }),
      Feedback.countDocuments({ projectId: p._id, status: { $in: ['pending', 'needs_clarification'] } }),
    ]);
    // proxy target redacted here for the same reason as on /context: Gabbar's list_projects tool
    // returns this payload verbatim to a Slack-facing model. GET /projects/:ref/proxy is the read
    // that carries the upstream. (redactProxy/redactPublished are defined with that endpoint.)
    return {
      ...p, boardUrl: `${config.baseUrl}/p/${p.capId}`, counts: { tasks, done, cancelled, pendingFb },
      // ALWAYS present, normalised to null, whatever was asked for. A consumer must be able to tell
      // live from archived off the row itself rather than off which query it happened to send, and
      // absent-vs-null is a distinction no reader of this list should have to know about.
      archivedAt: p.archivedAt ?? null,
      ...(p.proxy ? { proxy: redactProxy(p.proxy) } : {}),
      ...(p.proxyPublished ? { proxyPublished: redactPublished(p.proxyPublished) } : {}),
    };
  }));
  return c.json(withCounts);
});

// ---------- the config write path ----------
// ONE function behind every config write, wholesale or granular. It owns validation (the read*
// guards above), the write, the event log, the proxy reconciliation and the warn-only registry
// check, so a second edit surface cannot drift from the first one. Returns the fresh doc plus the
// warnings the caller should be shown: the things this API deliberately does NOT fail on, which
// otherwise are discoverable only by reading the event feed afterwards.
type ConfigFail = { error: string; status: 400 | 409 };
type ConfigOk = { doc: Project; warnings: string[] };
const failed = (r: ConfigFail | ConfigOk): r is ConfigFail => 'error' in r;
// the whole config surface, in one place: what applyConfig writes, what the 'nothing to update'
// message lists, and what PROJECT_VOCAB is measured against
const CONFIG_FIELDS = ['charter', 'slackChannel', 'repos', 'stakeholders', 'pipeline', 'agents', 'proxy', 'linearUrl'];

async function applyConfig(p: Project, b: Record<string, unknown>): Promise<ConfigFail | ConfigOk> {
  const warnings: string[] = [];
  const set: Record<string, unknown> = {};
  // a non-string charter used to vanish whenever another valid field rode along in the same body:
  // str() returned undefined, the field was skipped, and the write still reported success on
  // everything sent. Every other field here already errors on a shape it cannot store; these two
  // were the exceptions (DAR-187 item 5).
  const badTypes = typeErrors(b, {
    charter: 'string', slackChannel: 'string|null', repos: 'string[]', linearUrl: 'string|null',
    // typed here rather than hand-checked below so {"archived": "true"} is a 400 that says what is
    // wrong, instead of a non-boolean read as absent and quietly meaning "not archived"
    archived: 'boolean', cancelOpen: 'boolean', force: 'boolean', archiveReason: 'string',
  });
  if (badTypes.length) return { error: badTypes.join(' | '), status: 400 };
  // The archive words are applied HERE and nowhere else, and only on a patch that is actually
  // archiving: `archiveReason`, `cancelOpen` and `force` sent without `archived` are a caller
  // believing they asked for something, so they get the vocabulary 400 naming the real door rather
  // than a 200 that did none of it. `false` on the two flags is exempt for the same reason
  // reviewAgain:false is exempt on PATCH /tasks: nothing here reads false as an instruction, so
  // declining an option on an unrelated patch has not claimed anything untrue about that patch.
  const archiveApplied = b.archived !== undefined
    ? ARCHIVE_FIELDS
    : (['cancelOpen', 'force'] as const).filter((k) => b[k] === false);
  // DAR-208. There was no repos branch and no granular route, so {repos, charter} applied the
  // charter and dropped repos under a 200 — and the charter is the thing that tells every builder
  // which repo and branch it is working in, so the drop hands agents the wrong one. It is a plain
  // wholesale list like stakeholders/agents: sent, replaced; absent, untouched.
  const badFields = notApplied(b, PROJECT_VOCAB, [...CONFIG_FIELDS, ...archiveApplied], p as unknown as Record<string, unknown>);
  if (badFields) {
    return { error: `${badFields}. If you are editing a project by reading it and sending it back, GET /api/projects/${p.prefix} returns exactly the body this route accepts`, status: 400 };
  }
  const charter = str(b.charter); if (charter !== undefined) set.charter = charter;
  const slackChannel = strOrNull(b.slackChannel); if (slackChannel !== undefined) set.slackChannel = slackChannel;
  const linearUrl = strOrNull(b.linearUrl);
  if (linearUrl !== undefined) {
    if (linearUrl !== null) {
      let httpUrl = false;
      try { httpUrl = /^https?:$/.test(new URL(linearUrl).protocol); } catch { /* not a URL at all */ }
      if (!httpUrl) return { error: `linearUrl must be an absolute http(s) URL or null to clear (got ${JSON.stringify(linearUrl)})`, status: 400 };
    }
    set.linearUrl = linearUrl;
  }
  if (b.repos !== undefined) set.repos = strArr(b.repos);
  let pipeline: Pipeline | undefined;
  if (b.pipeline !== undefined) {
    const parsed = readPipeline(b.pipeline);
    if ('error' in parsed) return { error: parsed.error, status: 400 };
    pipeline = parsed.pipeline;
    set.pipeline = pipeline;
  }
  let stakeholders: Stakeholder[] | undefined;
  if (b.stakeholders !== undefined) {
    const parsed = readStakeholders(b.stakeholders);
    if ('error' in parsed) return { error: parsed.error, status: 400 };
    stakeholders = parsed.stakeholders;
    set.stakeholders = stakeholders;
  }
  let agents: ProjectAgent[] | undefined;
  if (b.agents !== undefined) {
    const parsed = readAgents(b.agents);
    if ('error' in parsed) return { error: parsed.error, status: 400 };
    agents = parsed.agents;
    set.agents = agents;
  }
  // proxy: absent = untouched, null = cleared (route withdrawn), object = replaced wholesale
  let proxyChange: { after: ProjectProxy | null } | undefined;
  const unset: Record<string, ''> = {};
  if (b.proxy !== undefined) {
    if (b.proxy === null) {
      unset.proxy = '';
      proxyChange = { after: null };
    } else {
      const parsed = readProxy(b.proxy);
      if ('error' in parsed) return { error: parsed.error, status: 400 };
      // the prefix is the routing key: a collision silently hijacks another project's URL
      const owner = await Projects.findOne({ _id: { $ne: p._id }, 'proxy.prefix': parsed.proxy.prefix });
      if (owner) return { error: `proxy prefix "${parsed.proxy.prefix}" is already claimed by project ${owner.prefix} (${owner.name})`, status: 409 };
      // ...but that namespace is SHARED with hand-added routes, so checking projects is not enough:
      // publishing over one repoints its target AND replaces its allowlist (an exposure change), and
      // the later withdrawal destroys it (FB-96). A proxy we cannot reach is not a veto — nothing is
      // published in that case anyway, and the boot sync applies the same check before it publishes.
      //
      // FB-105: this guard only belongs on a change that would PUBLISH over someone else's route.
      // Applying it to every PATCH meant a squatted prefix froze proxy.enabled at true — disable,
      // narrow, retarget all 409'd — so the board advertised a share the project could not switch
      // off, and the only escape was PATCH {proxy:null}, which skips this check and throws the config
      // away. A guard against exposure must never be the thing that guarantees it. So: a config that
      // publishes nothing is always allowed, and so is a pure de-escalation of one already in place.
      // (publishWanted applies the same ownership test before it writes, so the route table is
      // protected either way; this 409 exists to say so at the API edge rather than in an event log.)
      if (escalates(p.proxy, parsed.proxy)) {
        const liveHit = await fetchRoutes().then((r) => r.prefixes[parsed.proxy.prefix] ?? null).catch(() => null);
        const ourHit = (p.proxyPublished ?? []).find((h) => h.prefix === parsed.proxy.prefix) ?? null;
        if (liveHit && !sameRoute(liveHit, ourHit) && !sameRoute(liveHit, parsed.proxy)) {
          return { error: `proxy prefix "${parsed.proxy.prefix}" is already live on the proxy (${routeDesc(liveHit)}) and was not published by this project — pick another prefix, or withdraw that route by hand first. Disabling, narrowing proxy.public or clearing the config is always allowed`, status: 409 };
        }
      }
      set.proxy = parsed.proxy;
      proxyChange = { after: parsed.proxy };
    }
  }
  // ---------- archiving: the honest way a finished project leaves the active board ----------
  // Until this existed the only way off was deleting the project out of mongo by hand, which throws
  // away the charter, the event log and every row it ever carried. The design problem is not the
  // flag, it is that this project's standing doctrine says the board carries ALL pending work and an
  // empty todo column while work is pending is a bug. Archiving a project with 82 open rows would
  // swallow all 82 in one write and satisfy every check on the board by making the work invisible,
  // which is the doctrine defeated rather than met.
  //
  // So an archive with open rows is REFUSED, and the refusal names the two honest answers. Both are
  // real, and the server cannot tell which is true, so it makes the caller say:
  //   cancelOpen — this release is over and these did not make it. Each row is cancelled WITH THE
  //                REASON on it, because a cancelled row with no reason is unreadable in a month.
  //   force      — the work genuinely continues somewhere else. The rows stay open and the count of
  //                what was left behind is recorded on the project, so forcing costs a number that
  //                stays visible rather than a silence.
  let cancelOpenRows: Task[] | null = null;
  let archiveEvent = '';
  if (b.archived !== undefined) {
    const already = p.archivedAt ?? null;
    if (b.archived === true) {
      // re-archiving would re-stamp the date, and WHEN it was finished is the whole reason this is a
      // timestamp and not a boolean. Refused rather than silently moved.
      if (already) {
        return { error: `${p.prefix} was already archived on ${new Date(already).toISOString()}${p.archiveReason ? ` (${p.archiveReason})` : ''}. Archiving it again would re-stamp that date, and when it was finished is the thing the field is for. Send {"archived": false} first if it genuinely went back into flight and has now finished a second time`, status: 409 };
      }
      if (b.cancelOpen === true && b.force === true) {
        return { error: 'cancelOpen and force are opposite answers to the same question: cancelOpen closes the still-open rows as part of archiving, force leaves them open and records how many were left. Send one of them', status: 400 };
      }
      const open = await Tasks.find({ projectId: p._id, status: { $nin: CLOSED } }).toArray();
      if (open.length && b.cancelOpen !== true && b.force !== true) {
        const ids = open.map((t) => t.shortId);
        const named = ids.slice(0, 8).join(', ') + (ids.length > 8 ? `, and ${ids.length - 8} more` : '');
        return {
          error: `${p.prefix} has ${open.length} open row(s) (${named}), and archiving takes a project off every active surface, so those rows would go with it and nothing would say what happened to them. Send {"archived": true, "cancelOpen": true} to cancel them as part of archiving, which is the honest "this release is over and these did not make it" and writes onto each row that ${p.prefix} was archived and when. Send {"archived": true, "force": true} to archive and leave them open, which is right only when that work genuinely continues somewhere else; the surviving count is then recorded on the project as archivedOpenRows`,
          status: 409,
        };
      }
      if (b.cancelOpen === true) cancelOpenRows = open;
      set.archivedAt = new Date();
      const reason = str(b.archiveReason);
      // the reason is stored exactly as it was written and is never appended to by the server. What
      // was left open is its own field, so a human's sentence stays a human's sentence.
      if (reason !== undefined) set.archiveReason = reason; else unset.archiveReason = '';
      unset.archivedOpenRows = ''; // recounted below from what actually happened, never from intent
      archiveEvent = `project ARCHIVED${reason ? `: ${reason}` : ' (no reason given)'}`;
    } else {
      // false: back onto the active board. Everything the archive recorded goes with it, because a
      // stale reason on a live project is a sentence that is no longer true.
      if (!already) return { error: `${p.prefix} is not archived, so there is nothing to put back`, status: 400 };
      for (const k of ['cancelOpen', 'force'] as const) {
        if (b[k] === true) return { error: notHere(k, `${k} is part of ARCHIVING a project, and this patch is unarchiving one. Send {"archived": false} on its own`), status: 400 };
      }
      if (b.archiveReason !== undefined) {
        return { error: notHere('archiveReason', 'unarchiving clears the reason rather than setting one, since a project back on the active board is not archived for anything'), status: 400 };
      }
      set.archivedAt = null;
      unset.archiveReason = '';
      unset.archivedOpenRows = '';
      // rows a previous cancelOpen closed are NOT reopened. They were a decision somebody made with
      // a reason attached, and undoing the archive does not un-decide them.
      archiveEvent = `project unarchived (archived ${new Date(already).toISOString()}); rows cancelled by that archive stay cancelled`;
    }
  }
  if (Object.keys(set).length === 0 && Object.keys(unset).length === 0) {
    return { error: `nothing to update (${[...CONFIG_FIELDS, ...ARCHIVE_FIELDS].join(', ')})`, status: 400 };
  }
  // ---------- the archive transition is its own lock ----------
  // Every gate above is a READ, so two archives crossing together both pass and the second one
  // re-stamps the date the first just wrote, which is DAR-256 one document along. The condition
  // moves INTO the write and the driver settles it: `archivedAt: null` matches both an explicit null
  // and a missing field, which is exactly the not-archived population. Scoped to an archive patch,
  // so an ordinary config write is the same one filter on _id it always was.
  const claim = b.archived === true ? { archivedAt: null }
    : b.archived === false ? { archivedAt: { $ne: null } }
    : {};
  const wrote = await Projects.updateOne({ _id: p._id, ...claim }, {
    ...(Object.keys(set).length ? { $set: set } : {}),
    ...(Object.keys(unset).length ? { $unset: unset } : {}),
  });
  // the loser matched nothing, so NOTHING it sent landed, not the archive and not the config beside
  // it. A 200 naming the real state would be true about the archive and false about the rest.
  if (b.archived !== undefined && wrote.matchedCount === 0) {
    const now = await Projects.findOne({ _id: p._id });
    return { error: `${p.prefix} is ${now?.archivedAt ? `already archived (${new Date(now.archivedAt).toISOString()})` : 'not archived'}: another write settled that while this one was in flight, so nothing in this patch was applied, not the archive and not the fields beside it. Re-read the project and send whatever still applies`, status: 409 };
  }
  // the cascade runs only for the writer that WON the claim above, so open rows can never be
  // cancelled on behalf of an archive that did not happen
  if (cancelOpenRows?.length) await cancelForArchive(p, cancelOpenRows, set.archivedAt as Date, str(b.archiveReason));
  // What was left open is counted AFTER the cascade, from the board rather than from the intent, so
  // a cancellation that only partly landed is reported as what it actually did.
  if (b.archived === true) {
    const left = await Tasks.countDocuments({ projectId: p._id, status: { $nin: CLOSED } });
    await Projects.updateOne({ _id: p._id }, { $set: { archivedOpenRows: left } });
    if (left) archiveEvent += `; ${left} row(s) left OPEN and still on the board`;
  }
  const laneNote = pipeline ? `: lanes [${pipeline.reviews.map((r) => r.lane).join(', ')}], autoAdvance ${pipeline.autoAdvance}` : '';
  const agentNote = agents ? `: agents [${agents.map((a) => a.name).join(', ')}]` : '';
  // who may file feedback is an access-control fact, so the event log carries the resulting list
  const peopleNote = stakeholders ? `: stakeholders [${stakeholders.map((s) => s.name).join(', ') || 'nobody'}]` : '';
  // the archive is a lifecycle fact, not a field list, so it gets its own sentence in the log rather
  // than reading as "project updated (archivedAt)" next to a charter edit
  await logEvent(p._id!, archiveEvent
    ? `${archiveEvent}${laneNote}${agentNote}${peopleNote}`
    : `project updated (${[...Object.keys(set), ...Object.keys(unset)].join(', ')})${laneNote}${agentNote}${peopleNote}`);
  // the server owns the route table, so the proxy is updated from the doc that was just written.
  // What gets WITHDRAWN comes from proxyPublished (what is actually live) rather than from the old
  // config, so clearing the config never destroys the record of the prefix still to withdraw.
  if (proxyChange) await reconcileProxy(p._id!, p.proxyPublished ?? [], proxyChange.after);
  // soft consistency: pipeline managers should exist in the registry (when one exists) — warn, never fail.
  // The write is already committed, so a logging failure must not turn a successful PATCH into a 500.
  if (pipeline || agents) {
    try {
      const effPipeline = pipeline ?? p.pipeline;
      const effAgents = agents ?? p.agents;
      if (effAgents !== undefined && effPipeline) {
        const names = new Set(effAgents.map((a) => a.name));
        for (const r of effPipeline.reviews) {
          if (!names.has(r.manager)) {
            warnings.push(`pipeline manager "${r.manager}" (lane ${r.lane}) is not in the agent registry — the lane still spawns, but its review task is assigned to a name nobody dispatches`);
            await logEvent(p._id!, `pipeline manager ${r.manager} not in agent registry`);
          }
        }
      }
    } catch {
      // warn-only check: swallow so the committed update still returns 200
    }
  }
  const doc = await Projects.findOne({ _id: p._id });
  return { doc: doc ?? p, warnings };
}

api.patch('/projects/:ref', async (c) => {
  const p = await resolveProject(c.req.param('ref'));
  if (!p) return c.json({ error: 'project not found' }, 404);
  const b = await readBody(c);
  if (!b) return c.json({ error: 'invalid json body' }, 400);
  const r = await applyConfig(p, b);
  // response shape unchanged (the bare project doc): warnings are surfaced by the granular routes
  // below, which are the ones an orchestrator drives mid-session
  return failed(r) ? c.json({ error: r.error }, r.status) : c.json(r.doc);
});

// ---------- granular config edits ----------
// The wholesale path above replaces a whole list per field, which is right for a project being
// declared at init and a trap for every edit after that: "change one agent's brief" sent as a
// one-element `agents` array deletes every other agent, returns 200, and logs a cheerful
// `project updated (agents)`. These routes take the granular intent instead — one agent, one lane,
// one appended charter line — read the current value, merge SERVER-side, and hand the result to
// applyConfig, which is the same function the wholesale PATCH uses. So a partial edit cannot produce
// a config the wholesale path would have rejected: identical readers, identical 400s, identical
// events and identical proxy reconciliation. Nothing here re-validates anything by hand.
//
// Addressing is EDIT-ONLY and consistent across all of them: an agent name or lane key that does not
// exist is a 404 that lists what does exist, never an upsert, because a typo that silently registers
// a second agent called "staff-enginer" is the class of accident this surface exists to prevent.
// Creation is its own POST and 409s on a name already taken. The one thing that is created implicitly
// is the pipeline CONTAINER when the first lane is added, since a container has no name to mistype.
//
// Some edits are gated rather than warned, and the rule is the same in each: gate when the
// consequence is a review that silently does not happen, warn when the consequence is visible on the
// board or leaves the task with some review. Removing a lane's manager is only warned, because the
// review task still gets created and sits there unassigned-in-effect where anyone can see it.
//
// One thing these gates are NOT: an invariant of the system. The wholesale doors (PATCH
// /projects/:ref with pipeline/agents/stakeholders/proxy, and the set_* MCP tools on top of them)
// stay deliberately unguarded — no lane gate, no exposure confirmation — because they are the
// declare-the-whole-surface path a project is bootstrapped through, and gating them would mean an
// init could not configure a share or a pipeline in one call. So every guarantee below is a
// convention of the granular door, holding for anything that comes through these routes, and
// bypassable in one deliberate wholesale PATCH by someone who has read this far. applyConfig is the
// invariant; these gates are the manners.

const agentNames = (p: Project) => (p.agents ?? []).map((a) => a.name);

// "rename" on a CREATE route means the caller meant the edit door. It was dropped under a 200 on all
// three of these, which reads as "renamed" and is actually "added a second one" (DAR-208 sweep).
const renameOnCreate = (b: Record<string, unknown>, what: string, editRoute: string): string | null =>
  b.rename === undefined ? null : notHere('rename', `this route only ADDS ${what}. To rename one, ${editRoute}`);

// The class fix was a TABLE on the wholesale doors and hand-written ifs on the granular ones, which
// left the new doors with the old defect: POST /charter/append {text, slackChannel, repos} appended
// the line and dropped both under a 200, and PATCH /pipeline {autoAdvance, charter, repos} did the
// same. Every granular route runs this now, with the words it genuinely owns declared as applied.
// `p` rides along so an echoed-unchanged field still passes (see notApplied).
const granularDrops = (b: Record<string, unknown>, p: Project, applied: string[]): string | null =>
  notApplied(b, PROJECT_GRANULAR_VOCAB, applied, p as unknown as Record<string, unknown>);

// readAgents/readPipeline report the index within the MERGED list, which means nothing to a caller
// who addressed one entry by name. Re-label it with the thing they actually addressed.
const relabel = (msg: string, i: number, label: string) =>
  msg.split(`agents[${i}]:`).join(`${label}:`).split(`pipeline.reviews[${i}]:`).join(`${label}:`);

// Which open tasks does a lane change actually hurt, and how. Two populations, two end states, and
// the difference matters because one of them stalls silently:
//  · EXPLICIT selectors (`lanes` is an array naming the lane). If the change leaves them with no
//    configured lane at all, spawnReviews logs "no review lanes selected" and maybeAdvanceParent
//    takes them straight to done UNREVIEWED. If they still name another surviving lane, they simply
//    lose this one review.
//  · DEFAULT-ALL tasks (`lanes` null or absent = every configured lane). A rename never touches them,
//    since they take whatever the pipeline holds. Removing one lane of several only loses that review.
//    But removing the LAST lane strands them somewhere worse than done: spawnReviews returns early
//    when `want` is null and lanes is empty, so there is no event, no advance, and the task sits in
//    in_review forever. The earlier version of this code both missed these tasks and told the operator
//    they "advance immediately", which is wrong in the direction that makes someone stop looking.
// Mongo note: `{ lanes: null }` matches both an explicit null and a missing field, which is exactly
// the default-all population.
type LaneImpact = { stranded: string[]; partial: string[]; strandedStall: string[] };
async function laneImpact(projectId: ObjectId, lane: string, remaining: string[]): Promise<LaneImpact> {
  const open = { projectId, status: { $nin: CLOSED } };
  const explicit = await Tasks.find({ ...open, lanes: lane }, { projection: { shortId: 1, lanes: 1 } }).toArray();
  const keep = new Set(remaining);
  const stranded: string[] = [];
  const partial: string[] = [];
  for (const t of explicit) {
    ((t.lanes ?? []).some((l) => keep.has(l)) ? partial : stranded).push(t.shortId);
  }
  const defaults = remaining.length
    ? []
    : (await Tasks.find({ ...open, lanes: null }, { projection: { shortId: 1 } }).toArray()).map((t) => t.shortId);
  return { stranded, partial, strandedStall: defaults };
}
// what a gate should refuse over, and the sentence that says why
const laneBlockers = (x: LaneImpact) => [...x.stranded, ...x.strandedStall];
const laneBlockerWhy = (x: LaneImpact, subject: string): string => {
  const parts: string[] = [];
  if (x.stranded.length) parts.push(`${x.stranded.length} task(s) select it explicitly (${x.stranded.join(', ')}) and would be left with no configured lane, so at in_review they skip review entirely and (with autoAdvance on) go straight to DONE UNREVIEWED`);
  if (x.strandedStall.length) parts.push(`${x.strandedStall.length} task(s) take the default of all lanes (${x.strandedStall.join(', ')}) and this removes the last one, so at in_review they spawn nothing, log nothing and STALL in in_review rather than advancing`);
  return `${subject} is invisible to open work: ${parts.join('; and ')}`;
};
async function tasksAssignedTo(projectId: ObjectId, assignee: string): Promise<string[]> {
  const rows = await Tasks.find({ projectId, assignee, status: { $nin: CLOSED } }, { projection: { shortId: 1 } }).toArray();
  return rows.map((t) => t.shortId);
}

// what a link-holder can reach, in terms a human can approve or refuse. The target is deliberately
// absent: this text is written to be quotable into Slack, and the internal host:port never leaves
// this machine (FB-89).
const exposureLines = (px: ProjectProxy): string[] => [
  `${config.baseUrl}/${px.prefix}/ becomes reachable by ANYONE holding the link: no login, no session, no per-person access, and the prefix is a short word rather than a secret`,
  px.public.length
    ? `paths served through the tunnel: ${px.public.join(', ')} — matched AFTER "/${px.prefix}" is stripped, prefix-match by default, and "/" alone means every path on that dev server`
    : 'paths served through the tunnel: NONE — proxy.public is empty, so every tunneled request 403s and the link looks like a broken dev server',
];

// Stakeholders get the same treatment as the agent registry, and for a sharper reason: this list is
// ACCESS CONTROL, not metadata. Gabbar's feedback gate matches the verified slack sender id against
// it and fails closed, so adding a person is granting them the ability to file feedback on this
// project, and removing one revokes it. Until now there was no route for this at all: PATCH
// /projects/:ref did not accept `stakeholders`, so the only way to add somebody mid-project was a
// hand-written Mongo update, which is how a real report from a real person went unfiled.
api.post('/projects/:ref/stakeholders', async (c) => {
  const p = await resolveProject(c.req.param('ref'));
  if (!p) return c.json({ error: 'project not found' }, 404);
  const b = await readBody(c);
  if (!b) return c.json({ error: 'invalid json body' }, 400);
  const renameHere = renameOnCreate(b, 'a stakeholder', 'PATCH /api/projects/:ref/stakeholders/:name with {"rename": …}');
  if (renameHere) return c.json({ error: renameHere }, 400);
  // `name` here is the PERSON, so the project-level meaning of the word is not reachable on this route
  const dropped = granularDrops(b, p, ['name']);
  if (dropped) return c.json({ error: dropped }, 400);
  const name = str(b.name)?.trim();
  if (!name) return c.json({ error: 'name (non-empty string) required' }, 400);
  const current = p.stakeholders ?? [];
  // strict on creation, exact on addressing: adding "raj" next to "Raj" is a mistake rather than a
  // second person, but a lookup stays literal so the 404 below can be retried verbatim
  const clash = current.find((s) => s.name.trim().toLowerCase() === name.toLowerCase());
  if (clash) return c.json({ error: `stakeholder "${clash.name}" already exists (${clash.role ?? 'no role'}, ${clash.slackUserId ?? 'no slack id'}) — PATCH /api/projects/${p.prefix}/stakeholders/${encodeURIComponent(clash.name)} edits them` }, 409);
  const entry: Record<string, unknown> = { name };
  if (b.slackUserId !== undefined && b.slackUserId !== null) entry.slackUserId = b.slackUserId;
  if (b.role !== undefined && b.role !== null) entry.role = b.role;
  const r = await applyConfig(p, { stakeholders: [...current, entry] });
  if (failed(r)) return c.json({ error: r.error.split(`stakeholders[${current.length}]:`).join(`stakeholder "${name}":`) }, r.status);
  const id = str(entry.slackUserId);
  const note = id ? await slackUserNote(id) : null;
  return c.json({
    added: name,
    stakeholders: r.doc.stakeholders,
    grants: id
      ? `${name} can now file feedback on ${p.prefix} by DMing or mentioning Gabbar (the gate matches slack id ${id}), and can be assigned tasks as a human`
      : `${name} has NO slackUserId, so they still cannot file feedback through Gabbar — the gate matches on the id, not the name. They can be assigned tasks as a human`,
    warnings: [...(note ? [note] : []), ...r.warnings],
  });
});

api.patch('/projects/:ref/stakeholders/:name', async (c) => {
  const p = await resolveProject(c.req.param('ref'));
  if (!p) return c.json({ error: 'project not found' }, 404);
  const name = c.req.param('name');
  const current = p.stakeholders ?? [];
  const i = current.findIndex((s) => s.name === name);
  if (i < 0) return c.json({ error: `stakeholder "${name}" is not on this project — listed: ${current.map((s) => s.name).join(', ') || '(nobody)'}` }, 404);
  const b = await readBody(c);
  if (!b) return c.json({ error: 'invalid json body' }, 400);
  // `name` is NOT on this list. It used to be, which made {"name":"Tanisha"} a 200 reporting
  // `updated` while changing nothing, because only `rename` is ever applied — a silent success on the
  // access-control surface, reachable by the curl the charter tells builders to use (same defect class
  // as DAR-187). Now it falls through to the 400 below, exactly like the agent route.
  // `name` fell through to the 400 below only when it was sent ALONE. {"name":"Tanisha","role":"x"}
  // applied the role and dropped the rename under a 200, which is the same hole the agent route had
  // one floor up, on the access-control surface. It is refused by name now, either way.
  if (b.name !== undefined) {
    return c.json({ error: notHere('name', 'it addresses the person in the URL. To change their display name send "rename"') }, 400);
  }
  if (!['slackUserId', 'role', 'rename'].some((k) => b[k] !== undefined)) {
    return c.json({ error: 'nothing to update (slackUserId, role, rename)' }, 400);
  }
  const dropped = granularDrops(b, p, ['name']);
  if (dropped) return c.json({ error: dropped }, 400);
  const rename = b.rename === undefined ? undefined : str(b.rename)?.trim();
  if (b.rename !== undefined && !rename) return c.json({ error: 'rename must be a non-empty string' }, 400);
  if (rename && rename.toLowerCase() !== name.toLowerCase() && current.some((s) => s.name.trim().toLowerCase() === rename.toLowerCase())) {
    return c.json({ error: `cannot rename "${name}" to "${rename}": somebody with that name is already on the project` }, 409);
  }
  const next: Record<string, unknown> = { ...current[i]! };
  if (rename) next.name = rename;
  if (b.slackUserId !== undefined) { if (b.slackUserId === null) delete next.slackUserId; else next.slackUserId = b.slackUserId; }
  if (b.role !== undefined) { if (b.role === null) delete next.role; else next.role = b.role; }
  const pre: string[] = [];
  const before = current[i]!.slackUserId;
  if (b.slackUserId !== undefined) {
    pre.push(b.slackUserId === null
      ? `slack id removed: ${name} can no longer file feedback through Gabbar (the gate has nothing to match)`
      : `feedback gate for ${name} now matches ${String(b.slackUserId)} only${before ? `; the previous id ${before} is refused from here on` : ''}`);
  }
  // the agent route reports this and the MCP description promised it here too, while the route never
  // looked: a stakeholder rename leaves task assignees pointing at the old name exactly like an agent
  // rename does, since assignee is a plain string on the task
  if (rename && rename !== name) {
    const open = await tasksAssignedTo(p._id!, name);
    if (open.length) {
      pre.push(`${open.length} open task(s) are STILL assigned to "${name}" (${open.join(', ')}) — a rename does not move task assignees: PATCH /api/tasks/<ref> {"assignee":"${rename}"} on each`);
    }
  }
  const r = await applyConfig(p, { stakeholders: current.map((s, k) => (k === i ? next : s)) });
  if (failed(r)) return c.json({ error: r.error.split(`stakeholders[${i}]:`).join(`stakeholder "${name}":`) }, r.status);
  const id = str(next.slackUserId);
  const note = b.slackUserId !== undefined && id ? await slackUserNote(id) : null;
  return c.json({ updated: rename ?? name, stakeholders: r.doc.stakeholders, warnings: [...pre, ...(note ? [note] : []), ...r.warnings] });
});

api.delete('/projects/:ref/stakeholders/:name', async (c) => {
  const p = await resolveProject(c.req.param('ref'));
  if (!p) return c.json({ error: 'project not found' }, 404);
  const name = c.req.param('name');
  const current = p.stakeholders ?? [];
  const victim = current.find((s) => s.name === name);
  if (!victim) return c.json({ error: `stakeholder "${name}" is not on this project — listed: ${current.map((s) => s.name).join(', ') || '(nobody)'}` }, 404);
  const pre = [`${name} can no longer file feedback on ${p.prefix} through Gabbar; feedback they already filed is untouched`];
  const open = await tasksAssignedTo(p._id!, name);
  if (open.length) pre.push(`${open.length} open task(s) are still assigned to ${name} (${open.join(', ')}) — removing them from the list does not reassign anything`);
  if (victim.role === 'owner') pre.push('that was the OWNER row: nothing else in the system replaces it, so this project now has no owner listed');
  const r = await applyConfig(p, { stakeholders: current.filter((s) => s.name !== name) });
  if (failed(r)) return c.json({ error: r.error }, r.status);
  return c.json({ removed: name, stakeholders: r.doc.stakeholders, warnings: [...pre, ...r.warnings] });
});

api.post('/projects/:ref/agents', async (c) => {
  const p = await resolveProject(c.req.param('ref'));
  if (!p) return c.json({ error: 'project not found' }, 404);
  const b = await readBody(c);
  if (!b) return c.json({ error: 'invalid json body' }, 400);
  const renameHere = renameOnCreate(b, 'an agent', 'PATCH /api/projects/:ref/agents/:name with {"rename": …}');
  if (renameHere) return c.json({ error: renameHere }, 400);
  const dropped = granularDrops(b, p, ['name']); // `name` here is the AGENT
  if (dropped) return c.json({ error: dropped }, 400);
  const name = str(b.name)?.trim();
  if (!name) return c.json({ error: 'name (non-empty string) required' }, 400);
  const current = p.agents ?? [];
  // case-folded, like the stakeholder route: "Staff-Engineer" and " staff-engineer " are the same
  // dispatch key as "staff-engineer", so this is a collision, not a new agent
  const clash = current.find((a) => keyOf(a.name) === keyOf(name));
  if (clash) {
    return c.json({ error: `agent "${clash.name}" is already registered${clash.name === name ? '' : ` (you sent "${name}", which is the same name once case and spacing are ignored, and the name is the dispatch key)`} — PATCH /api/projects/${p.prefix}/agents/${encodeURIComponent(clash.name)} edits it (this route only adds, so a name collision is never resolved by overwriting)` }, 409);
  }
  const entry: Record<string, unknown> = { name, kind: b.kind, brief: b.brief };
  if (b.trigger !== undefined && b.trigger !== null) entry.trigger = b.trigger;
  const r = await applyConfig(p, { agents: [...current, entry] });
  if (failed(r)) return c.json({ error: relabel(r.error, current.length, `agent "${name}"`) }, r.status);
  return c.json({ added: name, agents: r.doc.agents ?? [], warnings: r.warnings });
});

api.patch('/projects/:ref/agents/:name', async (c) => {
  const p = await resolveProject(c.req.param('ref'));
  if (!p) return c.json({ error: 'project not found' }, 404);
  const name = c.req.param('name');
  const current = p.agents ?? [];
  const i = current.findIndex((a) => a.name === name);
  if (i < 0) {
    return c.json({ error: `agent "${name}" is not registered — registry holds: ${agentNames(p).join(', ') || '(nothing; register the first agent with POST /api/projects/:ref/agents)'}` }, 404);
  }
  const b = await readBody(c);
  if (!b) return c.json({ error: 'invalid json body' }, 400);
  const fields = ['kind', 'brief', 'trigger', 'rename'];
  // `name` addresses the agent in the URL and is never read from the body, so {"name":"x","brief":…}
  // used to change the brief, report 200, and drop the rename silently — the same hole the
  // stakeholder route below already names. (DAR-208 sweep)
  if (b.name !== undefined) {
    return c.json({ error: notHere('name', 'it addresses the agent in the URL. To change the registry name send "rename", which also rewrites the pipeline manager and reports the tasks still assigned to the old one') }, 400);
  }
  if (!fields.some((k) => b[k] !== undefined)) return c.json({ error: 'nothing to update (kind, brief, trigger, rename)' }, 400);
  const dropped = granularDrops(b, p, ['name']);
  if (dropped) return c.json({ error: dropped }, 400);
  const rename = b.rename === undefined ? undefined : str(b.rename)?.trim();
  if (b.rename !== undefined && !rename) return c.json({ error: 'rename must be a non-empty string' }, 400);
  if (rename && keyOf(rename) !== keyOf(name) && current.some((a) => keyOf(a.name) === keyOf(rename))) {
    return c.json({ error: `cannot rename "${name}" to "${rename}": that name is already registered (case and spacing ignored), and the name is the assignee key so two of them would make every lookup ambiguous` }, 409);
  }
  const next: Record<string, unknown> = { ...current[i]! };
  if (rename) next.name = rename;
  if (b.kind !== undefined) next.kind = b.kind;
  if (b.brief !== undefined) next.brief = b.brief;
  // trigger:null CLEARS it. Passing it through to readAgents would 400 ("must be a string when
  // present"), which would leave no way to remove a trigger at all short of a wholesale set_agents.
  if (b.trigger !== undefined) { if (b.trigger === null) delete next.trigger; else next.trigger = b.trigger; }

  const patch: Record<string, unknown> = { agents: current.map((a, k) => (k === i ? next : a)) };
  const pre: string[] = [];
  if (rename && rename !== name) {
    // the pipeline manager IS config, so a rename that left it behind would break the pipeline and
    // trip the warn-only registry check; task assignees are DATA, so they are reported, not moved
    const lanes = (p.pipeline?.reviews ?? []).filter((r) => r.manager === name).map((r) => r.lane);
    if (lanes.length && p.pipeline) {
      patch.pipeline = { autoAdvance: p.pipeline.autoAdvance, reviews: p.pipeline.reviews.map((r) => (r.manager === name ? { ...r, manager: rename } : r)) };
      pre.push(`pipeline manager rewritten on lane(s) ${lanes.join(', ')}: "${name}" -> "${rename}"`);
    }
    const open = await tasksAssignedTo(p._id!, name);
    if (open.length) {
      pre.push(`${open.length} open task(s) are STILL assigned to "${name}" (${open.join(', ')}) — a registry rename does not move task assignees, so that queue is now unread: PATCH /api/tasks/<ref> {"assignee":"${rename}"} on each`);
    }
  }
  const r = await applyConfig(p, patch);
  if (failed(r)) return c.json({ error: relabel(r.error, i, `agent "${name}"`) }, r.status);
  return c.json({ updated: rename ?? name, agents: r.doc.agents ?? [], warnings: [...pre, ...r.warnings] });
});

api.delete('/projects/:ref/agents/:name', async (c) => {
  const p = await resolveProject(c.req.param('ref'));
  if (!p) return c.json({ error: 'project not found' }, 404);
  const name = c.req.param('name');
  const current = p.agents ?? [];
  if (!current.some((a) => a.name === name)) {
    return c.json({ error: `agent "${name}" is not registered — registry holds: ${agentNames(p).join(', ') || '(nothing)'}` }, 404);
  }
  const pre: string[] = [];
  const open = await tasksAssignedTo(p._id!, name);
  if (open.length) pre.push(`${open.length} open task(s) are still assigned to "${name}" (${open.join(', ')}) — removing the registry entry does not touch them, so reassign or close them`);
  const r = await applyConfig(p, { agents: current.filter((a) => a.name !== name) });
  if (failed(r)) return c.json({ error: r.error }, r.status);
  return c.json({ removed: name, agents: r.doc.agents ?? [], warnings: [...pre, ...r.warnings] });
});

api.post('/projects/:ref/pipeline/lanes', async (c) => {
  const p = await resolveProject(c.req.param('ref'));
  if (!p) return c.json({ error: 'project not found' }, 404);
  const b = await readBody(c);
  if (!b) return c.json({ error: 'invalid json body' }, 400);
  const renameHere = renameOnCreate(b, 'a lane', 'PATCH /api/projects/:ref/pipeline/lanes/:lane with {"rename": …}');
  if (renameHere) return c.json({ error: renameHere }, 400);
  const dropped = granularDrops(b, p, []);
  if (dropped) return c.json({ error: dropped }, 400);
  const lane = str(b.lane)?.trim();
  if (!lane) return c.json({ error: 'lane (non-empty string) required' }, 400);
  const reviews = p.pipeline?.reviews ?? [];
  // case-folded like agent and stakeholder names: the lane key is what a task's `lanes` selection
  // matches, so "QA" beside "qa" would be one lane addressable two ways
  const clash = reviews.find((r) => keyOf(r.lane) === keyOf(lane));
  if (clash) {
    return c.json({ error: `lane "${clash.lane}" already exists (manager ${clash.manager})${clash.lane === lane ? '' : `, and "${lane}" is the same key once case and spacing are ignored`} — PATCH /api/projects/${p.prefix}/pipeline/lanes/${encodeURIComponent(clash.lane)} changes its manager or label` }, 409);
  }
  const entry: Record<string, unknown> = { lane, manager: b.manager };
  if (b.label !== undefined) entry.label = b.label;
  const pre = p.pipeline ? [] : ['this project had no review pipeline; it now has one with autoAdvance true'];
  const r = await applyConfig(p, { pipeline: { autoAdvance: p.pipeline?.autoAdvance ?? true, reviews: [...reviews, entry] } });
  if (failed(r)) return c.json({ error: relabel(r.error, reviews.length, `lane "${lane}"`) }, r.status);
  return c.json({ added: lane, pipeline: r.doc.pipeline, warnings: [...pre, ...r.warnings] });
});

api.patch('/projects/:ref/pipeline/lanes/:lane', async (c) => {
  const p = await resolveProject(c.req.param('ref'));
  if (!p) return c.json({ error: 'project not found' }, 404);
  const lane = c.req.param('lane');
  const cur = p.pipeline;
  if (!cur) return c.json({ error: 'project has no review pipeline — add the first lane with POST /api/projects/:ref/pipeline/lanes' }, 404);
  const i = cur.reviews.findIndex((r) => r.lane === lane);
  if (i < 0) return c.json({ error: `lane "${lane}" is not configured — pipeline holds: ${cur.reviews.map((r) => r.lane).join(', ') || '(no lanes)'}` }, 404);
  const b = await readBody(c);
  if (!b) return c.json({ error: 'invalid json body' }, 400);
  // same shape as the agent route: `lane` addresses the lane in the URL and the body never reads it,
  // so {"lane":"qa","manager":…} silently kept the old key (DAR-208 sweep)
  if (b.lane !== undefined) {
    return c.json({ error: notHere('lane', 'it addresses the lane in the URL. To change the lane KEY send "rename", which checks what it strands first') }, 400);
  }
  if (!['label', 'manager', 'rename'].some((k) => b[k] !== undefined)) return c.json({ error: 'nothing to update (label, manager, rename)' }, 400);
  const dropped = granularDrops(b, p, []);
  if (dropped) return c.json({ error: dropped }, 400);
  const rename = b.rename === undefined ? undefined : str(b.rename)?.trim();
  if (b.rename !== undefined && !rename) return c.json({ error: 'rename must be a non-empty string' }, 400);
  if (rename && keyOf(rename) !== keyOf(lane) && cur.reviews.some((r) => keyOf(r.lane) === keyOf(rename))) {
    return c.json({ error: `cannot rename lane "${lane}" to "${rename}": that lane key already exists (case and spacing ignored)` }, 409);
  }
  const pre: string[] = [];
  if (rename && rename !== lane) {
    // a rename keeps the lane count, so default-all tasks are untouched (they take whatever the
    // pipeline holds); only explicit selectors of the old key can be stranded by it
    const remaining = cur.reviews.map((r) => (r.lane === lane ? rename : r.lane));
    const impact = await laneImpact(p._id!, lane, remaining);
    const blockers = laneBlockers(impact);
    if (blockers.length && b.force !== true) {
      return c.json({ error: `${laneBlockerWhy(impact, `renaming lane "${lane}" to "${rename}"`)}. Re-pick their lanes first (PATCH /api/tasks/<ref> {"lanes":["${rename}"]}), or repeat this call with "force": true` }, 409);
    }
    if (blockers.length) pre.push(`FORCED: ${blockers.length} open task(s) (${blockers.join(', ')}) still select the old key "${lane}" and will now get no review at all`);
    if (impact.partial.length) pre.push(`${impact.partial.length} open task(s) (${impact.partial.join(', ')}) select "${lane}" among other lanes: they lose this one review and keep the rest`);
  }
  const next: Record<string, unknown> = { ...cur.reviews[i]! };
  if (rename) next.lane = rename;
  if (b.label !== undefined) next.label = b.label;
  if (b.manager !== undefined) next.manager = b.manager;
  const r = await applyConfig(p, { pipeline: { autoAdvance: cur.autoAdvance, reviews: cur.reviews.map((x, k) => (k === i ? next : x)) } });
  if (failed(r)) return c.json({ error: relabel(r.error, i, `lane "${lane}"`) }, r.status);
  return c.json({ updated: rename ?? lane, pipeline: r.doc.pipeline, warnings: [...pre, ...r.warnings] });
});

api.delete('/projects/:ref/pipeline/lanes/:lane', async (c) => {
  const p = await resolveProject(c.req.param('ref'));
  if (!p) return c.json({ error: 'project not found' }, 404);
  const lane = c.req.param('lane');
  const cur = p.pipeline;
  if (!cur) return c.json({ error: 'project has no review pipeline — nothing to remove' }, 404);
  if (!cur.reviews.some((r) => r.lane === lane)) {
    return c.json({ error: `lane "${lane}" is not configured — pipeline holds: ${cur.reviews.map((r) => r.lane).join(', ') || '(no lanes)'}` }, 404);
  }
  const reviews = cur.reviews.filter((r) => r.lane !== lane);
  const impact = await laneImpact(p._id!, lane, reviews.map((r) => r.lane));
  const blockers = laneBlockers(impact);
  const force = c.req.query('force') === 'true';
  if (blockers.length && !force) {
    return c.json({ error: `${laneBlockerWhy(impact, `removing lane "${lane}"`)}. Re-pick their lanes first (PATCH /api/tasks/<ref> {"lanes":[...]}), or repeat with ?force=true` }, 409);
  }
  const pre: string[] = [];
  if (impact.stranded.length) pre.push(`FORCED: ${impact.stranded.length} open task(s) (${impact.stranded.join(', ')}) selected only this lane and will now go to done with no review`);
  if (impact.strandedStall.length) pre.push(`FORCED: ${impact.strandedStall.length} open task(s) (${impact.strandedStall.join(', ')}) take the default of all lanes and will now STALL in in_review, since spawnReviews returns early with no lanes configured and nothing advances them`);
  if (impact.partial.length) pre.push(`${impact.partial.length} open task(s) (${impact.partial.join(', ')}) select "${lane}" among other lanes: they lose this one review and keep the rest`);
  // the two end states differ and the difference is the whole point: an explicit empty selection is
  // handled (event + advance), a default-all selection is not (early return, task sits in in_review)
  if (!reviews.length) pre.push('no review lanes remain: a task that names its lanes explicitly now skips review and, with autoAdvance on, advances; a task with no lanes field takes the default of all lanes, matches nothing, and stalls in in_review with no event');
  const r = await applyConfig(p, { pipeline: { autoAdvance: cur.autoAdvance, reviews } });
  if (failed(r)) return c.json({ error: r.error }, r.status);
  return c.json({ removed: lane, pipeline: r.doc.pipeline, warnings: [...pre, ...r.warnings] });
});

// autoAdvance on its own. The wholesale readPipeline REQUIRES `reviews` (an omitted array would
// silently wipe the lane list, so it 400s instead), which means there was no way to flip this one
// boolean without resending every lane from memory.
api.patch('/projects/:ref/pipeline', async (c) => {
  const p = await resolveProject(c.req.param('ref'));
  if (!p) return c.json({ error: 'project not found' }, 404);
  const cur = p.pipeline;
  if (!cur) return c.json({ error: 'project has no review pipeline — add the first lane with POST /api/projects/:ref/pipeline/lanes' }, 404);
  const b = await readBody(c);
  if (!b) return c.json({ error: 'invalid json body' }, 400);
  // this route rewrites the lane list from `cur`, so a `reviews` in the body was applied to nothing
  // and reported 200 (DAR-208 sweep)
  if (b.reviews !== undefined) {
    return c.json({ error: notHere('reviews', 'lanes are edited one at a time under /pipeline/lanes (POST to add, PATCH /pipeline/lanes/:lane to change, DELETE to remove), so a partial edit cannot wipe the list. PATCH /api/projects/:ref {"pipeline":{…}} replaces it wholesale if that is really what you want') }, 400);
  }
  if (b.autoAdvance === undefined) return c.json({ error: 'nothing to update (autoAdvance). Lanes are edited one at a time under /pipeline/lanes' }, 400);
  // `pipeline` is NOT applied here: this route reads autoAdvance and rebuilds the rest from `cur`,
  // so a pipeline object in the body would have been dropped exactly like `reviews` above
  const dropped = granularDrops(b, p, []);
  if (dropped) return c.json({ error: dropped }, 400);
  const r = await applyConfig(p, { pipeline: { autoAdvance: b.autoAdvance, reviews: cur.reviews } });
  if (failed(r)) return c.json({ error: r.error }, r.status);
  return c.json({ pipeline: r.doc.pipeline, warnings: r.warnings });
});

// Append to the charter instead of resending it. The charter is deliberately NOT structured: it is
// prose an agent reads before working, and giving it sections or ids would invent a schema no reader
// honours plus a migration for every charter already written. What makes appending safe is not
// structure, it is never having to resend the existing 3KB: the caller sends only the new line.
api.post('/projects/:ref/charter/append', async (c) => {
  const p = await resolveProject(c.req.param('ref'));
  if (!p) return c.json({ error: 'project not found' }, 404);
  const b = await readBody(c);
  if (!b) return c.json({ error: 'invalid json body' }, 400);
  // `charter` here means the caller wanted the wholesale door: it was dropped under a 200, so the
  // append landed and the replacement they also sent did not (DAR-208 sweep)
  if (b.charter !== undefined) {
    return c.json({ error: notHere('charter', 'this route appends the one line in "text" to what is already there. PATCH /api/projects/:ref {"charter": …} replaces the whole thing') }, 400);
  }
  const dropped = granularDrops(b, p, ['charter']); // refused just above, with a better sentence
  if (dropped) return c.json({ error: dropped }, 400);
  const text = str(b.text)?.trim();
  if (!text) return c.json({ error: 'text (non-empty string) required — this appends one rule or note to the existing charter, it does not replace it (PATCH /api/projects/:ref {charter} replaces)' }, 400);
  const existing = (p.charter ?? '').trimEnd();
  const pre = existing.includes(text) ? ['that text is already in the charter verbatim; appended anyway (this route is not idempotent, check before repeating a failed call)'] : [];
  const r = await applyConfig(p, { charter: existing ? `${existing}\n${text}` : text });
  if (failed(r)) return c.json({ error: r.error }, r.status);
  return c.json({ appended: text, charterLength: (r.doc.charter ?? '').length, warnings: [...pre, ...r.warnings] });
});

// Edit a configured share WITHOUT touching `enabled`. Flipping the share on or off is a separate
// route on purpose: publishing a dev server to anyone with the link must never be a side effect of
// fixing a path pattern.
api.patch('/projects/:ref/proxy', async (c) => {
  const p = await resolveProject(c.req.param('ref'));
  if (!p) return c.json({ error: 'project not found' }, 404);
  const cur = p.proxy;
  if (!cur) return c.json({ error: 'project has no shared surface configured — declare one with PATCH /api/projects/:ref {proxy} (it starts disabled), then edit it here' }, 404);
  const b = await readBody(c);
  if (!b) return c.json({ error: 'invalid json body' }, 400);
  if (b.enabled !== undefined) {
    return c.json({ error: 'enabled is not editable here — use PATCH /api/projects/:ref/proxy/enabled, which states what becomes reachable and requires the prefix as confirmation' }, 400);
  }
  if (!['prefix', 'target', 'public'].some((k) => b[k] !== undefined)) return c.json({ error: 'nothing to update (prefix, target, public)' }, 400);
  const dropped = granularDrops(b, p, ['prefix']); // `prefix` here addresses the SHARE, not the project
  if (dropped) return c.json({ error: dropped }, 400);
  const merged: Record<string, unknown> = { ...cur };
  for (const k of ['prefix', 'target', 'public']) if (b[k] !== undefined) merged[k] = b[k];
  // readProxy has to run before the escalation check can be trusted, since a widened allowlist is
  // only comparable once the patterns are validated
  const parsed = readProxy(merged);
  if ('error' in parsed) return c.json({ error: parsed.error }, 400);
  // escalates() compares allowlists as literal string sets, so it also fires on a change that is
  // semantically a narrowing ("/" -> "/$"). Left deliberately conservative — the safe direction on an
  // exposure change is to ask — but the message must not claim "widens", because for that case it
  // would be false, and a gate that misstates what it is gating teaches people to wave it through.
  if (escalates(cur, parsed.proxy) && str(b.confirm) !== parsed.proxy.prefix) {
    return c.json({ error: `this edit CHANGES WHAT A LIVE SHARE EXPOSES (its prefix, its upstream, or an allowlist that is not a literal subset of the current one), so it needs confirmation. After the edit: ${exposureLines(parsed.proxy).join(' | ')}. Repeat with "confirm":"${parsed.proxy.prefix}" if that is intended, or disable the route first and edit it withdrawn` }, 400);
  }
  const r = await applyConfig(p, { proxy: parsed.proxy });
  if (failed(r)) return c.json({ error: r.error }, r.status);
  // the two proxy WRITE responses keep the target, unlike every read above: nothing model-facing can
  // reach a PATCH, and the operator who just set the upstream is the one who needs to see it back
  return c.json({ proxy: r.doc.proxy, url: `${config.baseUrl}/${parsed.proxy.prefix}/`, live: parsed.proxy.enabled, exposure: exposureLines(parsed.proxy), warnings: r.warnings });
});

// The one route that publishes or withdraws the share, and it does nothing else. Enabling requires
// the prefix echoed back, because "anyone with this link reaches my dev server" is a decision a
// human should make with the URL in front of them, not a boolean riding along in a config payload.
api.patch('/projects/:ref/proxy/enabled', async (c) => {
  const p = await resolveProject(c.req.param('ref'));
  if (!p) return c.json({ error: 'project not found' }, 404);
  const cur = p.proxy;
  if (!cur) return c.json({ error: 'project has no shared surface configured — nothing to publish or withdraw' }, 404);
  const b = await readBody(c);
  if (!b) return c.json({ error: 'invalid json body' }, 400);
  if (typeof b.enabled !== 'boolean') return c.json({ error: 'enabled (boolean) required: true publishes the route, false withdraws it and keeps the config' }, 400);
  // the mirror of the guard on PATCH /proxy: that route refuses `enabled`, this one refused nothing,
  // so a prefix or an allowlist sent alongside the flip was dropped while the share went live on the
  // OLD one. An exposure change must never ride along unapplied (DAR-208 sweep)
  const alongside = ['prefix', 'target', 'public'].filter((k) => b[k] !== undefined);
  if (alongside.length) {
    return c.json({ error: notHere(alongside.join(', '), 'this route only publishes or withdraws what is already configured, so those would have been dropped while the share went live on the current config. Edit them with PATCH /api/projects/:ref/proxy first, then flip this') }, 400);
  }
  if (b.enabled && str(b.confirm) !== cur.prefix) {
    return c.json({ error: `enabling this share needs confirmation. ${exposureLines(cur).join(' | ')}. Repeat with "confirm":"${cur.prefix}" once whoever owns that decision has said yes` }, 400);
  }
  const dropped = granularDrops(b, p, ['prefix']); // prefix/target/public are refused just above
  if (dropped) return c.json({ error: dropped }, 400);
  const pre = cur.enabled === b.enabled ? [`the share was already ${b.enabled ? 'enabled' : 'disabled'}; the route table was reconciled again anyway`] : [];
  const r = await applyConfig(p, { proxy: { ...cur, enabled: b.enabled } });
  if (failed(r)) return c.json({ error: r.error }, r.status);
  // the doc states intent; proxyPublished states what is actually in the route table, and a publish
  // is best effort, so report both rather than claiming the link works
  const published = (r.doc.proxyPublished ?? []).some((h) => h.prefix === cur.prefix);
  return c.json({
    enabled: b.enabled,
    url: `${config.baseUrl}/${cur.prefix}/`,
    routeLive: published,
    exposure: b.enabled ? exposureLines(cur) : ['withdrawn: nothing on this project is reachable through the tunnel'],
    warnings: [...pre, ...r.warnings, ...(b.enabled && !published ? ['the config is saved but the route is NOT in the proxy table — the link does not resolve yet; check GET /api/projects/:ref/events and whether the proxy is running'] : [])],
    proxy: r.doc.proxy,
  });
});

// ---------- proxy target redaction ----------
// FB-89 says the internal host:port must not reach anyone on the far side of the tunnel. "Local-only
// endpoint" turned out to be the wrong boundary: Gabbar's list_projects and get_project_context tools
// hand the raw JSON of GET /projects and GET /projects/:ref/context to a Slack-facing model, and a
// model can be asked to repeat what it read. So the target is off BOTH of those payloads, in the same
// shape /p/:capId already uses, and lives on one endpoint (GET /projects/:ref/proxy) that nothing
// model-facing calls. Redacting context and not the list would have been theatre: same class, same
// reachability, one line apart.
const redactProxy = (x: ProjectProxy | null | undefined) =>
  x ? { prefix: x.prefix, public: x.public, enabled: x.enabled, targetRedacted: true } : null;
const redactPublished = (rs: PublishedRoute[] | undefined) =>
  (rs ?? []).filter((r) => r && typeof r.prefix === 'string')
    .map((r) => ({ prefix: r.prefix, public: Array.isArray(r.public) ? r.public : [], targetRedacted: true }));

// The read that PATCH /api/projects/:ref accepts back, unchanged. (DAR-FB-121)
//
// READ THE WHOLE THING, CHANGE ONE PART, SEND IT BACK is the documented way to restructure a charter
// or replace a stakeholder list in bulk, and until this existed there was no read whose output was a
// legal input: /context and the project list both carry fields the write path cannot apply, and
// there was no GET /api/projects/:ref at all. Tolerating an unchanged echo (notApplied) keeps those
// two working; this endpoint is the one that is actually round-trippable by construction, so the
// procedure has a door that is right rather than merely forgiven.
//
// `proxy` IS DELIBERATELY ABSENT, and its absence is what makes the round trip safe. A field left
// out of a PATCH is untouched, so echoing this body back can never repoint, widen or withdraw a live
// share by accident, and the internal target never lands on a new payload for a model to read
// (FB-89). The share has two doors of its own and they ask for confirmation, which is the point.
api.get('/projects/:ref', async (c) => {
  const p = await resolveProject(c.req.param('ref'));
  if (!p) return c.json({ error: 'project not found' }, 404);
  return c.json({
    charter: p.charter ?? '',
    slackChannel: p.slackChannel ?? null,
    linearUrl: p.linearUrl ?? null,
    repos: p.repos ?? [],
    stakeholders: p.stakeholders ?? [],
    ...(p.pipeline ? { pipeline: p.pipeline } : {}),
    ...(p.agents ? { agents: p.agents } : {}),
  });
});

api.get('/projects/:ref/context', async (c) => {
  const p = await resolveProject(c.req.param('ref'));
  if (!p) return c.json({ error: 'project not found' }, 404);
  // pipeline was missing here, which meant the only read path for the review lanes was the project
  // LIST, and every agent editing a lane had to reconstruct the list from somewhere else.
  // `configured` states which surfaces exist at all: the fields below normalise absent to []/null,
  // so on their own they cannot tell a project that never had a registry from one cleared to [].
  // Everything else here is already on the public board payload (pipeline, agents, stakeholders) or
  // is not a secret (slackChannel is an id the bot posts into); the target was the one exception.
  return c.json({
    name: p.name, prefix: p.prefix, repos: p.repos, charter: p.charter, stakeholders: p.stakeholders,
    slackChannel: p.slackChannel ?? null,
    // linear-native project: Linear is the board of record for TASKS, so an agent reading this
    // works there (full CRUD only on issues carrying the darbar/<PREFIX> label). Feedback still
    // arrives HERE through gabbar and the orchestrator drains it into Linear; the darbar project
    // is archived and keeps history plus that pipe.
    linearUrl: p.linearUrl ?? null,
    pipeline: p.pipeline ?? null, agents: p.agents ?? [], proxy: redactProxy(p.proxy),
    proxyPublished: redactPublished(p.proxyPublished),
    // this is the read every agent takes before working, so it is the right place to learn the work
    // is over. Normalised to null like the list, and archiveReason rides along because "archived"
    // with no reason tells an agent to stop without telling it what happened.
    archivedAt: p.archivedAt ?? null, archiveReason: p.archiveReason ?? null,
    archivedOpenRows: p.archivedOpenRows ?? null,
    configured: { pipeline: p.pipeline !== undefined, agents: p.agents !== undefined, proxy: p.proxy !== undefined },
  });
});

// The one read that carries the upstream, for the operator who has to check what is being served.
// Deliberately its own endpoint rather than a flag on /context: a flag is one careless caller away
// from putting the target back on a model-visible payload, whereas a separate path has to be asked
// for by name. Nothing in apps/gabbar calls it.
api.get('/projects/:ref/proxy', async (c) => {
  const p = await resolveProject(c.req.param('ref'));
  if (!p) return c.json({ error: 'project not found' }, 404);
  if (!p.proxy) return c.json({ configured: false, proxy: null, proxyPublished: p.proxyPublished ?? [] });
  return c.json({
    configured: true,
    proxy: p.proxy,
    proxyPublished: p.proxyPublished ?? [],
    url: `${config.baseUrl}/${p.proxy.prefix}/`,
    routeLive: (p.proxyPublished ?? []).some((h) => h.prefix === p.proxy!.prefix),
    exposure: p.proxy.enabled ? exposureLines(p.proxy) : ['withdrawn: nothing on this project is reachable through the tunnel'],
  });
});

api.get('/projects/:ref/events', async (c) => {
  const p = await resolveProject(c.req.param('ref'));
  if (!p) return c.json({ error: 'project not found' }, 404);
  const limit = Math.min(Math.max(Number(c.req.query('limit')) || 20, 1), 50);
  return c.json(await Events.find({ projectId: p._id }).sort({ at: -1 }).limit(limit).toArray());
});

// ---------- board (capability URL) ----------

// The project as a board link may see it. ONE function, called by the board payload and by the
// digest on every SSE tick, because the redaction below is the whole reason this shape exists and a
// second copy of it is a second place for it to be got wrong. Key order is fixed here, which is
// also what makes JSON.stringify of it a stable fingerprint.
function boardProject(p: Project) {
  // This endpoint IS on the proxy's public allowlist, so everything here is readable by anyone
  // holding a board link. proxy.target is the internal host:port being exposed — the one field a
  // link-holder must not learn — so it is dropped and flagged (FB-89). prefix/public/enabled stay:
  // disclosing WHAT is exposed is the whole point of the panel. The full config, target included,
  // is on /projects/:ref/context, which is local-only.
  const proxy = p.proxy ? { prefix: p.proxy.prefix, public: p.proxy.public, enabled: p.proxy.enabled, targetRedacted: true } : null;
  // proxyPublished is what the server reports it actually PUT in the route table and has not
  // withdrawn — the only fact on this payload that can contradict the config, and therefore the only
  // thing that lets the panel say "configured off, route still live" instead of a confident wrong
  // "nothing shared" (FB-95/FB-102). It was being read by the board and never sent, which made every
  // fail-open state on that surface unreachable. Same redaction as above: prefix and allowlist are
  // the boundary and belong on the board; the internal host:port never leaves the machine.
  const proxyPublished = (p.proxyPublished ?? [])
    .filter((r) => r && typeof r.prefix === 'string')
    .map((r) => ({ prefix: r.prefix, public: Array.isArray(r.public) ? r.public : [], targetRedacted: true }));
  // charter sliced to 401: board shows a ~400-char preview and needs the +1 to know it truncated
  // baseUrl rides along so the board can state the shared link exactly as a stakeholder receives it
  return {
    name: p.name, prefix: p.prefix, repos: p.repos, stakeholders: p.stakeholders,
    pipeline: p.pipeline ?? null, agents: p.agents ?? [], proxy, proxyPublished,
    baseUrl: config.baseUrl, charter: (p.charter ?? '').slice(0, 401),
  };
}

api.get('/p/:capId', async (c) => {
  const p = await Projects.findOne({ capId: c.req.param('capId') });
  if (!p) return c.json({ error: 'not found' }, 404);
  // READ BEFORE THE ROWS, deliberately. This snapshot is at least as new as `rev`, so a write that
  // lands mid-read either arrives in the rows below (and its delta re-applies the same values,
  // which is a no-op) or bumps the sequence past this number (and the board sees the gap on the
  // next frame and refetches). Read AFTER, it could name a sequence newer than the rows, and the
  // board would drop the very frame that carried the row it is missing. See buildDelta.
  const rev = ticks.get(p.capId)?.seq ?? 0;
  const project = boardProject(p);
  const [tasks, feedback, events] = await Promise.all([
    Tasks.find({ projectId: p._id }).sort({ createdAt: 1 }).toArray(),
    Feedback.find({ projectId: p._id }).sort({ createdAt: -1 }).toArray(),
    Events.find({ projectId: p._id }).sort({ at: -1 }).limit(config.eventsBoardLimit).toArray(),
  ]);
  // epoch/rev/projectSig are how the board knows whether a later SSE delta continues from THIS
  // snapshot or has left it behind; the project itself is never sent on a tick, only fingerprinted.
  return c.json({ epoch: EPOCH, rev, projectSig: projectSig(project), project, tasks, feedback, events });
});

api.get('/p/:capId/stream', async (c) => {
  const key = c.req.param('capId');
  const exists = await Projects.findOne({ capId: key }, { projection: { _id: 1 } });
  if (!exists) return c.json({ error: 'not found' }, 404);
  return streamSSE(c, async (stream) => {
    let open = true;
    // a connected board is the only reason to build a delta (boardTick), so the count of open
    // streams is kept where the open and every close already are. One `close` for all three exits,
    // idempotent, so a stream that fails a write AND aborts cannot decrement twice.
    liveBoards.set(key, (liveBoards.get(key) ?? 0) + 1);
    function close() {
      if (!open) return;
      open = false;
      off();
      const n = (liveBoards.get(key) ?? 1) - 1;
      if (n > 0) liveBoards.set(key, n); else liveBoards.delete(key);
    }
    const off = subscribe(key, {
      send: (data) => { stream.writeSSE({ data }).catch(close); },
    });
    stream.onAbort(close);
    while (open) {
      await stream.writeSSE({ event: 'ping', data: 'keepalive' }).catch(close);
      await stream.sleep(config.sseKeepaliveMs);
    }
  });
});

// ---------- tasks ----------

api.post('/tasks', async (c) => {
  const b = await readBody(c);
  if (!b) return c.json({ error: 'invalid json body' }, 400);
  const title = str(b.title);
  if (!title) return c.json({ error: 'title (string) required' }, 400);
  const status = (str(b.status) ?? 'todo') as TaskStatus;
  if (!TASK_STATUSES.includes(status)) return c.json({ error: `bad status; use ${TASK_STATUSES.join('|')}` }, 400);
  const type = (str(b.type) ?? 'feature') as TaskType;
  if (!TASK_TYPES.includes(type)) return c.json({ error: `bad type; use ${TASK_TYPES.join('|')}` }, 400);
  const badTypes = typeErrors(b, {
    description: 'string', notes: 'string', parentTaskRef: 'string',
    lane: 'string|null', assignee: 'string|null', origin: 'string|null', blocker: 'string|null',
  });
  if (b.assigneeType !== undefined && b.assigneeType !== 'agent' && b.assigneeType !== 'human') {
    // silently defaulting to 'agent' meant a task filed for a person was filed as agent work
    badTypes.push(`assigneeType must be "agent" or "human" (got ${JSON.stringify(b.assigneeType)})`);
  }
  if (badTypes.length) return c.json({ error: badTypes.join(' | ') }, 400);
  // DAR-208 sweep. `blocker` was the one field here with the reported property and a real use: a task
  // can be CREATED at status blocked, and the reason was dropped under a 200, so the board got a
  // blocked card with no why. It is applied now. `parentTaskRef`, `project`, `origin` and `lane` are
  // create-time fields, so they are excluded from the refusal; the server-owned rest is refused.
  const badFields = notApplied(b, TASK_VOCAB, ['parentTaskRef', 'project', 'origin', 'lane']);
  if (badFields) return c.json({ error: badFields }, 400);
  const p = await resolveProject(str(b.project) ?? '');
  if (!p) return c.json({ error: 'project not found' }, 404);
  let parentTaskId: ObjectId | null = null;
  if (str(b.parentTaskRef)) {
    const parent = await resolveTaskRef(str(b.parentTaskRef)!);
    if (!parent) return c.json({ error: `parent ${b.parentTaskRef} not found` }, 404);
    parentTaskId = parent._id!;
  }
  if (lanesShapeBad(b.lanes)) return c.json({ error: LANES_SHAPE_ERROR }, 400);
  const lanes = lanesArr(b.lanes) ?? null;
  if (lanes) {
    const laneErr = laneError(p, lanes);
    if (laneErr) return c.json({ error: laneErr }, 400);
  }
  const doc: Task = {
    projectId: p._id!,
    shortId: await nextShortId(p._id!, 'task'),
    parentTaskId,
    title,
    description: str(b.description) ?? '',
    status,
    type,
    lane: strOrNull(b.lane) ?? null,
    lanes,
    assignee: strOrNull(b.assignee) ?? null,
    assigneeType: b.assigneeType === 'human' ? 'human' : 'agent',
    origin: strOrNull(b.origin) ?? null,
    commits: [],
    blocker: strOrNull(b.blocker) ?? null,
    notes: str(b.notes) ?? '',
    dispatchedAt: null, // filing a task is not dispatching it; only the dispatch PATCH stamps this
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  await Tasks.insertOne(doc);
  await logEvent(p._id!, `${doc.shortId} created: ${doc.title}`, doc._id);
  // Review spawning hangs off the in_review TRANSITION in the PATCH route, so a task CREATED at
  // in_review — a retro-init of work already under review, which this API explicitly allows at any
  // status — spawned no lanes and had no transition left to make: it sat in in_review forever, with
  // the board showing a review in flight that nobody was ever assigned. Spawning off the STATE here
  // is the fix rather than refusing the create, because the create is legitimate and refusing it
  // would leave no way to file a row at the status the work is actually at. Same guard as the PATCH
  // path (spawnReviews is idempotent: it returns early when a round is already open).
  if (doc.status === 'in_review' && doc.type !== 'review') await spawnReviews(doc);
  // re-read: an explicit lanes:[] selection self-advances the parent inside spawnReviews, so the
  // created doc in hand can already be stale about its own status
  return c.json((await Tasks.findOne({ _id: doc._id })) ?? doc);
});

// my_tasks and lane views: filter by assignee/project/status, open=true for not-closed.
//
// This endpoint used to `.limit(200)` and return a bare array, so on a project past 200 rows the
// answer was a silent sample: nothing on the payload said it had been cut, and this is the read every
// AGENT resumes from (my_tasks, and every "what is still open" sweep). MRF returns 419 tasks from the
// board and returned exactly 200 here. The board payload was never affected, which is why the
// orchestrator loop routes its audit through /api/p/:capId to dodge this.
// The rows now come back inside a page that always states `total` and `truncated`, so a partial
// answer cannot be read as a complete one without ignoring a field that says otherwise, and
// limit/offset make the rest actually reachable instead of merely knowable.
const TASKS_PAGE_MAX = 1000;
// out-of-range or non-numeric paging 400s rather than being clamped: a silently clamped limit is the
// same lie in a smaller place
function pageNum(raw: string | undefined, name: string, min: number, max: number, dflt: number): number | { error: string } {
  if (raw === undefined) return dflt;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    const range = max === Number.MAX_SAFE_INTEGER ? `${min} or greater` : `between ${min} and ${max}`;
    return { error: `${name} must be a whole number ${range} (got ${JSON.stringify(raw)})` };
  }
  return n;
}
api.get('/tasks', async (c) => {
  const limit = pageNum(c.req.query('limit'), 'limit', 1, TASKS_PAGE_MAX, TASKS_PAGE_MAX);
  if (typeof limit !== 'number') return c.json(limit, 400);
  const offset = pageNum(c.req.query('offset'), 'offset', 0, Number.MAX_SAFE_INTEGER, 0);
  if (typeof offset !== 'number') return c.json(offset, 400);
  const q: Record<string, unknown> = {};
  const assignee = c.req.query('assignee'); if (assignee) q.assignee = assignee;
  const lane = c.req.query('lane'); if (lane) q.lane = lane;
  const status = c.req.query('status');
  if (status) q.status = { $in: status.split(',').filter((s) => TASK_STATUSES.includes(s as TaskStatus)) };
  else if (c.req.query('open') === 'true') q.status = { $nin: CLOSED };
  const ref = c.req.query('project');
  if (ref) {
    const p = await resolveProject(ref);
    if (!p) return c.json({ error: 'project not found' }, 404);
    q.projectId = p._id;
  }
  const [total, tasks] = await Promise.all([
    Tasks.countDocuments(q as never),
    Tasks.find(q as never).sort({ updatedAt: -1 }).skip(offset).limit(limit).toArray(),
  ]);
  const seen = offset + tasks.length;
  const truncated = seen < total;
  return c.json({
    total,
    returned: tasks.length,
    offset,
    limit,
    truncated,
    ...(truncated
      ? {
          nextOffset: seen,
          note: `PARTIAL ANSWER: ${tasks.length} of ${total} matching tasks, sorted by updatedAt desc. This is NOT the whole set — repeat the same query with offset=${seen} until truncated is false, or read GET /api/p/:capId for a whole project in one payload`,
        }
      : {}),
    tasks,
  });
});

api.get('/tasks/:ref', async (c) => {
  const t = await resolveTaskRef(c.req.param('ref'));
  if (!t) return c.json({ error: 'task not found' }, 404);
  return c.json(t);
});

api.patch('/tasks/:ref', async (c) => {
  const t = await resolveTaskRef(c.req.param('ref'));
  if (!t) return c.json({ error: 'task not found' }, 404);
  const b = await readBody(c);
  if (!b) return c.json({ error: 'invalid json body' }, 400);
  if (b.status !== undefined && !TASK_STATUSES.includes(b.status as TaskStatus)) {
    return c.json({ error: `bad status; use ${TASK_STATUSES.join('|')}` }, 400);
  }
  if (b.type !== undefined && !TASK_TYPES.includes(b.type as TaskType)) {
    return c.json({ error: `bad type; use ${TASK_TYPES.join('|')}` }, 400);
  }
  // Fields this route has never applied. They used to be accepted and dropped under a 200, so
  // "correct the origin" or "fix the parent" read as done and changed nothing. A field that cannot
  // be set after creation has to SAY it cannot, and point at whatever does the job (DAR-187 item 4).
  // The list moved into TASK_VOCAB so the CREATE route is held to the same standard by the same
  // sentences — `dispatchedAt` and the timestamps were the two this hand-written copy had missed.
  const frozen = notApplied(b, TASK_VOCAB, ['dispatched', 'addCommit', 'reviewAgain'], t as unknown as Record<string, unknown>);
  if (frozen) return c.json({ error: frozen }, 400);
  const badTypes = typeErrors(b, {
    title: 'string', description: 'string', notes: 'string', addCommit: 'string',
    assignee: 'string|null', blocker: 'string|null', lane: 'string|null',
  });
  if (b.assigneeType !== undefined && b.assigneeType !== 'agent' && b.assigneeType !== 'human') {
    badTypes.push(`assigneeType must be "agent" or "human" (got ${JSON.stringify(b.assigneeType)})`);
  }
  // a boolean verb like `dispatched`, and typed here for the same reason: reviewAgain:"true" read as
  // absent would drop the one word that distinguishes a deliberate second round from the accident
  // the guard below exists to stop
  if (b.reviewAgain !== undefined && typeof b.reviewAgain !== 'boolean') {
    badTypes.push(`reviewAgain must be true (spawn a fresh review round on a task that already had one) or false (got ${JSON.stringify(b.reviewAgain)})`);
  }
  if (badTypes.length) return c.json({ error: badTypes.join(' | ') }, 400);
  const set: Record<string, unknown> = {};
  for (const k of ['title', 'description', 'status', 'notes', 'type'] as const) {
    const v = str(b[k]); if (v !== undefined) set[k] = v;
  }
  for (const k of ['assignee', 'blocker', 'lane'] as const) {
    const v = strOrNull(b[k]); if (v !== undefined) set[k] = v;
  }
  if (b.assigneeType === 'human' || b.assigneeType === 'agent') set.assigneeType = b.assigneeType;
  // dispatch: a boolean verb, never a caller-supplied time. The server owns the clock so the stamp
  // and the age the board reads off it cannot disagree, and a garbage value is a 400 rather than an
  // Invalid Date on the card. false clears (dispatch abandoned, dead builder written off).
  if (b.dispatched !== undefined) {
    if (typeof b.dispatched !== 'boolean') {
      return c.json({ error: 'dispatched must be true (stamp now) or false (clear); the server sets the time' }, 400);
    }
    set.dispatchedAt = b.dispatched ? new Date() : null;
  }
  // lanes freeze once the review flow starts: reviews already spawned (or closed) from the old selection
  if (lanesShapeBad(b.lanes)) return c.json({ error: LANES_SHAPE_ERROR }, 400);
  const lanes = lanesArr(b.lanes);
  // An echo is not an edit, which is the notApplied rule one floor down and it has to hold here too:
  // read-the-row / change-one-part / send-it-back is the documented procedure, and every builder's
  // own status PATCH now travels past a freeze that covers the status it is reporting FROM. Compared
  // STRICTLY rather than with echoedUnchanged, because that predicate reads null and [] as the same
  // emptiness and here they are opposite selections (all lanes vs no lanes): conflating them would
  // wave a real change through the freeze, which is the bug rather than the exemption.
  const lanesEchoed = lanes !== undefined && deepEqual(jsonish(b.lanes), jsonish(t.lanes));
  if (lanes !== undefined && !lanesEchoed) {
    // in_progress is the status a live builder holds, and it was NOT frozen: lanes cleared under a
    // running builder, and when that builder reported in_review the row found no lanes to spawn,
    // self-advanced through the empty selection and shipped DONE UNREVIEWED. dispatchedAt cannot
    // stand in for this — the builder's own status PATCH clears it — so the status is the liveness
    // signal and the freeze reads it.
    if (t.status === 'in_progress') {
      return c.json({ error: `${t.shortId} is in_progress; a builder is holding this row, so lanes cannot change here. Move it to todo or blocked in a separate patch first.` }, 409);
    }
    if ((['in_review', 'qa', 'done', 'cancelled'] as TaskStatus[]).includes(t.status)) {
      return c.json({ error: `${t.shortId} is ${t.status}; lanes are frozen once the review flow starts` }, 409);
    }
    if (await Tasks.countDocuments({ parentTaskId: t._id, type: 'review' })) {
      return c.json({ error: `${t.shortId} already has review children; lanes cannot change` }, 409);
    }
    if (lanes) {
      const p = await Projects.findOne({ _id: t.projectId }, { projection: { pipeline: 1 } });
      const laneErr = laneError(p, lanes);
      if (laneErr) return c.json({ error: laneErr }, 400);
    }
    set.lanes = lanes;
  }
  // any status change is the assignee reporting for itself, which retires the dispatch fact: the row
  // has moved on, and a stamp left behind would claim a fresh hand-off if the task ever came back to
  // todo. An explicit `dispatched` in the same body wins — that is a re-dispatch, not a leftover.
  if (set.status !== undefined && set.status !== t.status && t.dispatchedAt && b.dispatched === undefined) {
    set.dispatchedAt = null;
  }
  // reviewAgain names an override for exactly one thing below: the no-double-spawn guard, which only
  // fires on a patch that is genuinely crossing INTO in_review (a status change, off a non-in_review
  // status, on a non-review task). Anywhere else the word has nothing to attach to, and the route used
  // to accept it there anyway and do nothing: {reviewAgain: true} alone, or alongside an unrelated
  // status, 200'd and spawned nothing. That is the same "answers 200 and should not" class as the rest
  // of this file, and a caller who typo'd the status but got the override right walks away believing a
  // second round is coming. reviewAgain:false is exempt: nothing here treats false as an instruction
  // (the guard below already reads absent and false alike), so declining an override on an unrelated
  // patch has not claimed anything false about what the patch does.
  const enteringReview = set.status === 'in_review' && t.status !== 'in_review' && t.type !== 'review';
  if (b.reviewAgain === true && !enteringReview) {
    return c.json({ error: `${t.shortId}: reviewAgain only means something on a patch that moves this task INTO in_review (a status change, off a status other than in_review, and not on a review task itself). Send {"status": "in_review", "reviewAgain": true} together, or drop reviewAgain if that is not what this patch is doing` }, 400);
  }
  const addCommit = str(b.addCommit);
  if (Object.keys(set).length === 0 && !addCommit) return c.json(t); // nothing to do, no noise event

  // done-gate: a dev task cannot close over the heads of its open review lanes or open feedback
  if (set.status === 'done' && t.type !== 'review') {
    const open = await openReviewCount(t._id!);
    if (open) return c.json({ error: `${t.shortId} has ${open} open review subtask(s); close them (or cancel them) first` }, 409);
    const fbIds = await openFeedbackShortIds(t._id!);
    if (fbIds.length) return c.json({ error: `${t.shortId} has ${fbIds.length} open feedback row(s) (${fbIds.join(', ')}); resolve or reject them first` }, 409);
  }

  // ---------- one entry into in_review, one review round ----------
  // The no-double-spawn guard lives inside spawnReviews and counts only OPEN children, so a task
  // whose round had CLOSED and was then moved back to in_review came out carrying two rounds on one
  // row: the closed one and a fresh one. Refused here rather than swallowed in the hook, because a
  // second round is sometimes exactly what rework wants and the server cannot tell the two apart on
  // its own. `reviewAgain` is the caller saying which of the two this is.
  //
  // Scoped to a round that is fully CLOSED, which is precisely the case that duplicates. With a
  // child still open spawnReviews already declines, the re-entry genuinely changes nothing and 200
  // is the honest answer; a 409 there would refuse a move that is not this bug, and an override
  // there would answer 200 having spawned nothing, which is the same silence one door along.
  if (enteringReview && b.reviewAgain !== true) {
    const kids = await Tasks.find({ parentTaskId: t._id, type: 'review' }).toArray();
    if (kids.length && kids.every((k) => CLOSED.includes(k.status))) {
      const named = kids.map((k) => `${k.shortId} (${k.lane ?? 'no lane'}, ${k.status})`).join(', ');
      return c.json({ error: `${t.shortId} already had a review round and every lane of it is closed: ${named}. Moving it back to in_review spawns a SECOND round on top of that one. Send {"reviewAgain": true} in this same patch if a fresh round is what the rework needs, or leave the row where it is if the round it already had is the answer` }, 409);
    }
  }

  set.updatedAt = new Date();
  const update: { $set: Record<string, unknown>; $push?: { commits: string } } = { $set: set };
  if (addCommit) update.$push = { commits: addCommit };
  // ---------- DAR-256: the transition itself is the lock ----------
  // Every guard above this line, and openReviewCount inside spawnReviews, is a READ. Two requests
  // crossing into in_review together therefore both pass all of them before either one writes, and
  // the row comes out carrying two rounds — measured on this rig, not argued: 4 children on a
  // two-lane task, 3 on the reviewAgain shape. Guarding harder in front of the write cannot fix
  // that; it only reproduces the same window one floor up, which is what DAR-247 did.
  //
  // So the condition moves INTO the write, where the driver settles it: exactly one racer flips the
  // status, and only that one goes on to run the hooks. `$ne` rather than a compare-and-swap on the
  // status we read, because the invariant this owes is "one entry into in_review", not "the row has
  // not moved at all" — a patch that crossed some other status in between is not this bug.
  //
  // SCOPED TO THE ENTERING-REVIEW PATCH and nowhere else. As a filter on every PATCH it would
  // refuse every legitimate write to a row that is sitting in in_review: a note, a commit, an
  // assignee, a lanes echo, and the explicit `done` that leaves in_review when autoAdvance is off.
  // Uncontended patches are unchanged — same one filter on _id, same one write, no extra read.
  const res = await Tasks.updateOne(
    { _id: t._id, ...(enteringReview ? { status: { $ne: 'in_review' as TaskStatus } } : {}) },
    update,
  );
  // The loser matched nothing, so NOTHING it sent landed: not the status, not the notes beside it,
  // not its addCommit. That is why this is a 409 and not a 200 naming the real state — the row does
  // end up in_review, so a 200 would be true about the status and false about the rest of the body,
  // which is the silent drop the rest of this route exists to stop. One re-read, on the contended
  // path only, so the sentence states what the row actually says rather than assuming.
  if (enteringReview && res.matchedCount === 0) {
    const now = await Tasks.findOne({ _id: t._id });
    return c.json({ error: `${t.shortId} is ${now ? now.status : 'no longer on the board'}: another patch crossed into in_review while this one was in flight, and that one owns the review round. So nothing in this patch was applied — not the status, and not the other fields it carried. Re-read the row and send whatever still applies.` }, 409);
  }
  const changed = Object.keys(set).filter((k) => k !== 'updatedAt').concat(addCommit ? ['commit'] : []).join(', ');
  await logEvent(t.projectId, `${t.shortId} updated (${changed})${set.status ? ` → ${set.status}` : ''}`, t._id);

  const after = await Tasks.findOne({ _id: t._id });
  // pipeline hooks fire on the transition, not the state: entering review spawns lanes,
  // closing the last review lane advances (or announces) the parent
  if (after && enteringReview) await spawnReviews(after);
  if (t.type === 'review' && CLOSED.includes(set.status as TaskStatus) && t.parentTaskId) await maybeAdvanceParent(t.parentTaskId);
  if (after && set.status === 'done') await resolvePromotedFeedback(after);
  // RE-READ, because the hooks above write to this very row. `after` is the row as it stood BEFORE
  // them, so a self-advancing patch (a lanes:[] selection entering in_review, which spawns nothing
  // and ships the row inside spawnReviews) answered in_review about a row that was already done. The
  // caller then acts on a status the server had itself just replaced, which is a shell chain printing
  // the previous commit after a failed step. POST /tasks re-reads for exactly this reason and this
  // route did not.
  return c.json((await Tasks.findOne({ _id: t._id })) ?? after);
});

// ---------- feedback ----------

api.post('/feedback', async (c) => {
  const b = await readBody(c);
  if (!b) return c.json({ error: 'invalid json body' }, 400);
  // DAR-208 sweep: a `status` or a `resolution` sent at filing time was dropped under a 200, so a
  // caller who thought they were filing something already triaged filed a pending row instead
  const badFields = notApplied(b, FEEDBACK_VOCAB, ['taskRef', 'project', 'type', 'body', 'author', 'authorType', 'attachments', 'slack', 'idempotencyKey']);
  if (badFields) return c.json({ error: badFields }, 400);
  // author gets a type check here, not just the str()-and-refuse further down: str() collapses a
  // WRONG type and an ABSENT field into the same "nothing", so {author: 42} on a gated project fell
  // through to the "author required" sentence (wrong: the caller sent something, it was the wrong
  // shape) and on an ungated project fell all the way through to being stored as "unknown" under a
  // 200, the same probe-litter signature this route exists to stop.
  const badTypes = typeErrors(b, { idempotencyKey: 'string', author: 'string' });
  if (badTypes.length) return c.json({ error: badTypes.join(' | ') }, 400);
  const task = str(b.taskRef) ? await resolveTaskRef(str(b.taskRef)!) : null;
  const p = task
    ? await Projects.findOne({ _id: task.projectId })
    : await resolveProject(str(b.project) ?? '');
  if (!p) return c.json({ error: 'need taskRef or project' }, 404);
  // ---------- DAR-229: file this row at most once ----------
  // A POST that never answered may have inserted anyway. Gabbar holds the report and retries it
  // later (a restart of this very process is the ordinary cause), and without a key the retry files
  // the same report a second time. With one, the retry finds the row its own earlier attempt made.
  //
  // Scoped per PROJECT, because the key names the slack message and a message can legitimately
  // produce a row on two projects: a model that files against the wrong one and corrects itself is
  // making a second write, not repeating the first. Scoped globally, that correction would silently
  // return the wrong row.
  //
  // THE READ BELOW IS THE FAST PATH, NOT THE DECISION. The index is (DAR-241).
  //
  // Read-then-insert on its own has a window, and the caller reaches it, which corrects what this
  // comment first claimed. The first version argued that a retry only ever follows a failure and
  // that two slack messages carry different keys, so nobody could present one key twice at once.
  // True of live filings and FALSE of sweep retries: Gabbar's sweep builds the key from the HELD
  // ITEM's original message rather than from the message being handled, so two messages from one
  // sender in flight together both sweep the same held item and both arrive here with one key.
  // Gabbar handles slack events concurrently by design, which is why its message budget needs
  // AsyncLocalStorage, so the premise is its own, and nothing locks between its list, its post and
  // its mark. Measured in that shape rather than argued about: eight concurrent sweeps of ONE held
  // report produced SIX rows, all carrying the same key. The ten-concurrent-POST probe that "did not
  // reproduce" was measuring the wrong thing.
  //
  // So a partial unique index on {projectId, idempotencyKey} decides it (packages/core/src/db.ts),
  // and the catch below turns the loser of that race into the same answer the read gives. BOTH HALVES
  // OR NEITHER: with the index and no catch the same eight sweeps gave one row and seven 500s, and
  // Gabbar told the sender "STILL HELD, filing it just failed" seven times about a report that had
  // just landed. A visible duplicate traded for a confident false negative is the worse trade, and
  // this thread exists to stop the system saying things that are not so.
  //
  // The append route next door has NO index and needs none: its check is a clause in the
  // findOneAndUpdate rather than a read in front of one, so it has no window (thirty concurrent keyed
  // appends onto one row produced one addition). A unique index there would also be wrong rather than
  // merely unnecessary, because additions.idempotencyKey is inside an array, so the index would be
  // multikey and therefore global across rows, which would break the one semantic this design paid
  // for: the same held addition retargeted at a different row has to land on it.
  const idempotencyKey = str(b.idempotencyKey)?.trim();
  if (idempotencyKey) {
    const already = await Feedback.findOne({ projectId: p._id!, idempotencyKey });
    if (already) {
      // No write of any kind, so a repeat cannot edit the row it matched either: whatever the first
      // attempt stored is what stands, and a body that arrives with a repeat is ignored rather than
      // applied. That is the right way round here. The caller retrying is the one holding the LESS
      // authoritative copy: Gabbar's retry body is a provenance wrapper written after the fact,
      // while the row already carries the words the sender's own attempt put there.
      return c.json({ ...already, boardUrl: `${config.baseUrl}/p/${p.capId}`, idempotent: true });
    }
  }
  // ---------- who is allowed to be the author of a row ----------
  // This route took ANY author and turned a missing one into the literal "unknown". That is the
  // probe-litter signature: 43 rows attributed to nobody, on a live board, purged by hand. The
  // APPEND route next door has required an author since it was written and 400s without one, so of
  // the two doors onto a feedback row the CREATE door was the weak one, and it is the one the mess
  // came through.
  //
  // Gated on the project having a ROSTER — stakeholders or agents — because between them they are
  // the only statement of who this project's reports come from. With neither there is nothing to
  // check a name against and refusing would just block bootstrapping; with either, an author outside
  // it is either a typo or a probe. Agents count as reporters in their own right: the MCP
  // file_feedback tool files under an agent's own name, and an agent-only project (REV on the live
  // board: stakeholders [], agents [orchestrator, review-agent]) was the one shape the gate still
  // let probes through, because it switched on off `people.length` while matching on both lists.
  // DAR-257, Raj's call: agents should be able to file and others not. Accepted consequence — a
  // human not on an agent-only roster is refused, and the error names the fix.
  //
  // Trimmed and case-folded through keyOf, the same normalisation the config uses for every other
  // identity key, so " Raj" and "raj" address the person the roster already knows rather than
  // being refused for their whitespace.
  //
  // Placed AFTER the idempotency return on purpose: that return is not a write, and re-judging a
  // filing that already landed would turn a retry into a 400 about a row that exists.
  const people = (p.stakeholders ?? []).map((s) => s.name);
  const bots = (p.agents ?? []).map((a) => a.name);
  const knownAuthors = [...people, ...bots];
  if (knownAuthors.length) {
    const roster = [
      people.length ? `stakeholders [${people.join(', ')}]` : '',
      bots.length ? `agents [${bots.join(', ')}]` : '',
    ].filter(Boolean).join(' and ');
    const author = str(b.author)?.trim();
    if (!author) {
      return c.json({ error: `author (non-empty string) required: a filed row is only honest if the board says who reported it, and a row filed as "unknown" is what a probe looks like to everyone who reads the queue afterwards. Send whoever is reporting this. ${p.prefix} knows ${roster}` }, 400);
    }
    if (!knownAuthors.some((n) => keyOf(n) === keyOf(author))) {
      return c.json({ error: `author ${JSON.stringify(author)} is not on ${p.prefix}: a feedback row is attributed to a person or an agent this project knows, so the trail leads to somebody who can be asked about it. ${p.prefix} knows ${roster}. If they belong here, add them first with POST /api/projects/${p.prefix}/stakeholders {"name": ${JSON.stringify(author)}} and file the row again` }, 400);
    }
  }
  const slack = b.slack && typeof b.slack === 'object' ? (b.slack as Record<string, unknown>) : null;
  const type = str(b.type) ?? 'bug';
  const doc: FeedbackDoc = {
    projectId: p._id!,
    taskId: task?._id ?? null,
    taskShortId: task?.shortId ?? null,
    shortId: await nextShortId(p._id!, 'feedback'),
    author: str(b.author)?.trim() || 'unknown',
    authorType: b.authorType === 'agent' ? 'agent' : 'human',
    type: (FEEDBACK_TYPES.includes(type) ? type : 'bug') as FeedbackDoc['type'],
    body: str(b.body) ?? '',
    attachments: strArr(b.attachments),
    ...(idempotencyKey ? { idempotencyKey } : {}),
    slack: slack && str(slack.channel) && str(slack.ts)
      ? { channel: slack.channel as string, ts: slack.ts as string, user: str(slack.user) ?? '' }
      : null,
    status: 'pending',
    resolution: null,
    resolvedTaskId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  // The other end of the read above, and the half that actually holds. A concurrent writer that got
  // past the read is stopped by the unique index here, and E11000 means precisely one thing: a row
  // with this key exists on this project, which is the same fact the read looks for and deserves the
  // same answer. Anything else rethrows, so a genuine write failure still fails.
  try {
    await Feedback.insertOne(doc);
  } catch (e) {
    if (idempotencyKey && (e as { code?: number }).code === 11000) {
      const already = await Feedback.findOne({ projectId: p._id!, idempotencyKey });
      if (already) return c.json({ ...already, boardUrl: `${config.baseUrl}/p/${p.capId}`, idempotent: true });
    }
    throw e;
  }
  await logEvent(p._id!, `${doc.shortId} filed by ${doc.author}${doc.taskShortId ? ` on ${doc.taskShortId}` : ''}: ${doc.body.slice(0, 80)}`, doc.taskId);
  // DAR-245: ring the orchestrator's doorbell. AFTER the insert and the event, so an armed waiter
  // that re-reads the queue on this signal cannot read it before the row is in it. The idempotent
  // returns above deliberately do NOT ring: a retry of a write that already landed rang when it
  // landed, and ringing again would wake a session over a row it has possibly already triaged.
  nudge(p._id!.toHexString());
  return c.json({ ...doc, boardUrl: `${config.baseUrl}/p/${p.capId}` });
});

api.get('/feedback/pending', async (c) => {
  const q: Record<string, unknown> = { status: { $in: ['pending', 'needs_clarification'] } };
  const ref = c.req.query('project');
  if (ref) {
    const p = await resolveProject(ref);
    if (!p) return c.json({ error: 'project not found' }, 404);
    q.projectId = p._id;
  }
  return c.json(await Feedback.find(q as never).sort({ createdAt: 1 }).toArray());
});

// thread-root lookup for the bot's reopen flow: ANY status, not just pending
api.get('/feedback/by-slack', async (c) => {
  const channel = c.req.query('channel'), ts = c.req.query('ts');
  if (!channel || !ts) return c.json({ error: 'channel and ts required' }, 400);
  const fb = await Feedback.findOne({ 'slack.channel': channel, 'slack.ts': ts });
  if (!fb) return c.json({ error: 'not found' }, 404);
  return c.json(fb);
});

// param route stays registered AFTER the static /feedback/pending and /feedback/by-slack
api.get('/feedback/:shortId', async (c) => {
  const fb = await Feedback.findOne({ shortId: c.req.param('shortId').toUpperCase() });
  if (!fb) return c.json({ error: 'feedback not found' }, 404);
  return c.json(fb);
});

api.patch('/feedback/:shortId', async (c) => {
  const fb = await Feedback.findOne({ shortId: c.req.param('shortId').toUpperCase() });
  if (!fb) return c.json({ error: 'feedback not found' }, 404);
  const b = await readBody(c);
  if (!b) return c.json({ error: 'invalid json body' }, 400);
  if (b.status !== undefined && !FEEDBACK_STATUSES.includes(b.status as FeedbackStatus)) {
    return c.json({ error: `bad status; use ${FEEDBACK_STATUSES.join('|')}` }, 400);
  }
  const badTypes = typeErrors(b, { resolution: 'string|null', resolvedTaskRef: 'string' });
  if (badTypes.length) return c.json({ error: badTypes.join(' | ') }, 400);
  // DAR-182/DAR-208. `body` and `attachments` were the two live drops here: this route writes only
  // status, resolution, type and resolvedTaskRef, so an image or a corrected body sent with a status
  // change vanished under a 200. The body stays UNREPLACEABLE, deliberately, and the append route
  // named in FEEDBACK_VOCAB is how a row grows without anyone's words being rewritten under them.
  const badFields = notApplied(b, FEEDBACK_VOCAB, ['status', 'resolution', 'resolvedTaskRef', 'type'], fb as unknown as Record<string, unknown>);
  if (badFields) return c.json({ error: badFields }, 400);
  // an unrecognised type was dropped here under a 200, like the status one line up is not
  const type = str(b.type);
  if (b.type !== undefined && !(type && FEEDBACK_TYPES.includes(type))) {
    return c.json({ error: `bad type; use ${FEEDBACK_TYPES.join('|')}` }, 400);
  }
  const set: Record<string, unknown> = { updatedAt: new Date() };
  const next = str(b.status) as FeedbackStatus | undefined;
  if (next) set.status = next;
  const resolution = strOrNull(b.resolution); if (resolution !== undefined) set.resolution = resolution;
  if (type) set.type = type;
  if (b.resolvedTaskRef !== undefined) {
    // an unknown ref used to be ignored under a 200, so a promoted row kept NO link to the task meant
    // to fix it: the ship sweep (resolvePromotedFeedback) follows resolvedTaskId and never found it,
    // and the row sat open with the board saying it was promoted. A typo is a 404 now, not a ghost.
    const ref = str(b.resolvedTaskRef)!.trim();
    if (!ref) return c.json({ error: 'resolvedTaskRef must be a non-empty task short id, e.g. DAR-12' }, 400);
    const t = await resolveTaskRef(ref);
    if (!t) {
      return c.json({ error: `task ${ref.toUpperCase()} not found — resolvedTaskRef is the link the ship sweep follows to auto-resolve this row when that task is done, so an unknown id would leave ${fb.shortId} promoted in name only` }, 404);
    }
    set.resolvedTaskId = t._id; set.resolvedTaskShortId = t.shortId;
    // promotion IS triage: a pending row promoted without an explicit status must not stay pending
    if (fb.status === 'pending' && !next) set.status = 'triaged';
  }
  // Every status below REPLIES TO A HUMAN in their own Slack thread, and the reply text IS the
  // resolution. Without one the server posted a developer placeholder ("no reason given (that is a
  // bug, flag it)") or a bare header into a stakeholder's thread, with no orchestrator in the loop to
  // catch it. A rejection with no reason is not something this system should be able to send, so the
  // reason is required rather than substituted. The EFFECTIVE resolution is the one in this patch or
  // the one already on the row, so writing the reason first and flipping the status after still works,
  // and so does a re-send of the same status.
  const effective = ((resolution !== undefined ? resolution : fb.resolution) ?? '').trim();
  if (next && REPLYING.includes(next) && !effective) {
    return c.json({ error: `${fb.shortId} → ${next} replies to ${fb.author} in their own thread and that reply IS the resolution text, so "resolution" is required: say ${REPLY_ASKS[next]}, in plain words that person will understand` }, 400);
  }
  await Feedback.updateOne({ _id: fb._id }, { $set: set });
  const statusNote = next ?? (set.status === 'triaged' ? 'triaged (auto: promoted)' : 'updated');
  await logEvent(fb.projectId, `${fb.shortId} → ${statusNote}${resolution ? `: ${resolution}` : ''}`, fb.taskId);

  // every terminal state (and clarification) replies in the original thread; nothing dies silently.
  // `effective` is non-empty for all three by the gate above, so no placeholder can reach a human.
  if (next === 'resolved') await slackThreadReply(fb, `*${fb.shortId} resolved.* ${effective}`);
  if (next === 'rejected') await slackThreadReply(fb, `*${fb.shortId} not actioned:* ${effective}`);
  if (next === 'needs_clarification') await slackThreadReply(fb, `*${fb.shortId}:* quick question, ${effective}`);

  // a parent held in_review only by this feedback closes itself once the last blocking row resolves
  if ((next === 'resolved' || next === 'rejected') && fb.taskId) await maybeAdvanceParent(fb.taskId);
  // DAR-245: only a REOPEN rings. Everything else this route writes moves a row out of `pending`,
  // which is what the inbox is, so it cannot add work; ringing on it would mean the orchestrator
  // wakes itself every time it triages something. A reopen is a person coming back in their own
  // thread, and that is the case the doorbell exists for.
  if (set.status === 'pending' && fb.status !== 'pending') nudge(fb.projectId.toHexString());
  return c.json(await Feedback.findOne({ _id: fb._id }));
});

// ---------- adding to a filed row, instead of filing a second one ----------
//
// DAR-182. Raj sent an image to add to an existing finding and Gabbar filed MRF-FB-24, linked as a
// follow-up to MRF-FB-23. One defect then occupied two rows in the triage queue and the orchestrator
// had to dedupe something that was never two things. Adding evidence to a finding has to MUTATE that
// finding, so this is the route that does it, and Gabbar's add_to_feedback tool is the caller.
//
// Two judgments, both visible in what this writes:
//
// 1. WHERE THE EVIDENCE LIVES. FeedbackDoc already had `attachments`, so no new field was invented
//    for the urls; they go on the row's own array, which is what the board renders and what a
//    promotion carries. A second bucket would have been a second place to look for one kind of
//    thing. The NOTE goes in the body, because the body is the only text surface any reader of a
//    feedback row has: the board renders it, Gabbar's get_feedback returns it, the pending queue
//    slices it. A note held anywhere else would be a fact nobody is shown.
//
// 2. AN APPEND IS AN EDIT, AND IT SAYS SO. The body is never rewritten — not one byte of what is
//    already there changes — and the new text arrives under a line naming who added it and when.
//    Someone else's words appearing changed under their name is its own kind of dishonesty, and it
//    is also what makes a wrong append recoverable: the original report is still readable above it.
//    `additions` carries the same fact structurally so a reader does not have to parse prose.
//
// The body therefore stays UNREPLACEABLE, which is what it always was in practice: PATCH
// /feedback/:shortId ignored a `body` under a 200. That silence is the part that changed. The PATCH
// now refuses `body` and `attachments` by name (FEEDBACK_VOCAB) and points here.
//
// What this route deliberately does NOT do: change status, and reply in the reporter's slack thread.
// An append is not a state change, so it does not fire the reply machinery, and a row that is
// already resolved says so in a warning rather than being silently reopened — reopening is a
// decision with a slack message attached, and it stays one act made on purpose.

// The one line of prose an append writes, kept pure so the exact wording is pinned by a test rather
// than by whoever reads the route next. Plain sentence, no em dashes: a feedback body is quoted back
// to slack-facing models by Gabbar's get_feedback.
//
// It does NOT trim the body it is given. "Not one byte of what is already there changes" has to be
// literally true or it is not the property it claims to be, and a row whose body ends in whitespace
// was still losing those bytes.
export function additionLine(add: { author: string; at: Date; note: string; attachments: string[] }): string {
  const n = add.attachments.length;
  const head = `[${add.author} added this on ${add.at.toISOString()}${n ? `, with ${n} attachment${n > 1 ? 's' : ''}` : ''}]`;
  return add.note ? `${head} ${add.note}` : head;
}
export function appendedBody(body: string, add: { author: string; at: Date; note: string; attachments: string[] }): string {
  const line = additionLine(add);
  return body ? `${body}\n\n${line}` : line;
}

api.post('/feedback/:shortId/append', async (c) => {
  const fb = await Feedback.findOne({ shortId: c.req.param('shortId').toUpperCase() });
  if (!fb) return c.json({ error: 'feedback not found' }, 404);
  const b = await readBody(c);
  if (!b) return c.json({ error: 'invalid json body' }, 400);
  const badTypes = typeErrors(b, { note: 'string', author: 'string', attachments: 'string[]', idempotencyKey: 'string' });
  if (b.authorType !== undefined && b.authorType !== 'human' && b.authorType !== 'agent') {
    badTypes.push(`authorType must be "human" or "agent" (got ${JSON.stringify(b.authorType)})`);
  }
  if (badTypes.length) return c.json({ error: badTypes.join(' | ') }, 400);
  // `body` is NOT on this list, and listing it was the whole of DAR-FB-120: this route reads `note`,
  // so a caller who sent {body} got a 200 with their sentence gone, which is the exact class the
  // vocabulary exists to end, inside the route that ends it. It is refused here, and FEEDBACK_VOCAB
  // now names `note` in the sentence that sent them here in the first place.
  const badFields = notApplied(b, FEEDBACK_VOCAB, ['attachments', 'author', 'authorType', 'idempotencyKey'], fb as unknown as Record<string, unknown>);
  if (badFields) return c.json({ error: badFields }, 400);
  // Required, not defaulted to 'unknown' like the author of a filing. The entire point of this route
  // over a body rewrite is that the row records who added what, and an addition attributed to
  // "unknown" is the silent rewrite wearing a label.
  const author = str(b.author)?.trim();
  if (!author) {
    return c.json({ error: 'author (non-empty string) required: an append is only honest if the row says who made it. Send whoever is adding this, not the person who filed the row' }, 400);
  }
  const note = (str(b.note) ?? '').trim();
  const sent = strArr(b.attachments).map((s) => s.trim()).filter(Boolean);
  if (!note && !sent.length) {
    return c.json({ error: `nothing to append to ${fb.shortId}: send "note" (the words being added), "attachments" (urls), or both. To change its status or write a resolution use PATCH /api/feedback/${fb.shortId} instead` }, 400);
  }
  const at = new Date();
  // ---------- DAR-229: add these words at most once ----------
  // The route says out loud that it is not idempotent, and it warns when a note it has already seen
  // comes round again. That warning is the honest answer for a human repeating themselves and the
  // wrong one for a RETRY, where a duplicate is not visible at all: an append writes one more
  // attributed line inside a body nobody diffs, so the same screenshot arriving twice from a write
  // that timed out and was re-sent leaves no obvious trace. Of the two writes Gabbar holds and
  // retries, this is the dangerous one for exactly that reason.
  //
  // Scoped to THIS ROW, which is what the key not naming a row buys: the same held addition pointed
  // at a different row is a different scope and lands there properly, while a repeat onto the row
  // its own earlier attempt already reached does nothing.
  //
  // Unlike the filing route this needs no separate read, and so has no race at all: the check is a
  // clause in the same single findOneAndUpdate the concurrency rewrite below already made atomic.
  const idempotencyKey = str(b.idempotencyKey)?.trim();
  const addition = {
    author,
    authorType: b.authorType === 'agent' ? ('agent' as const) : ('human' as const),
    at,
    note,
    // WHAT THEY ATTACHED, not what turned out to be new. The row's own `attachments` is the deduped
    // union and is computed at WRITE time (below), so a url a concurrent append got in first is
    // still recorded here as something this person sent, and is still stored exactly once. Two
    // different questions, two honest answers, and neither depends on who won a race.
    attachments: sent,
  };
  const line = additionLine(addition);

  // ---------- one document operation, because two appends overlap (DAR-FB-119) ----------
  // This used to read fb.body at the top of the handler and $set the whole recomputed string back.
  // Two overlapping requests computed from the same base and the second erased the first one's
  // line: a note lost in 8 of 8 trials at two concurrent, and at thirty concurrent, 30 additions
  // recorded against 2 surviving lines. Every one of them answered 200 with appended:true.
  //
  // It is not a theoretical race. bot.ts handles slack events concurrently (which is exactly why
  // the message budget next door needs AsyncLocalStorage rather than a module variable), and the
  // orchestrator appends by curl, so two writers on one row is the ordinary case, not the storm.
  //
  // The whole write is now an aggregation pipeline, so the concat happens INSIDE the update against
  // whatever the document holds at that instant. There is no window to lose: mongo applies each
  // update to one document serially, so the second append concatenates onto the first one's result.
  // The body branch is byte-identical to appendedBody() above (empty stays bare, non-empty gets
  // "\n\n" and is otherwise untouched), and $literal wraps every caller-supplied string so a note or
  // a name beginning with "$" is text rather than a field path.
  // returnDocument 'before' gives the exact pre-image THIS write landed on, which is what the
  // warnings below have to be measured against. Measuring them from the snapshot read at the top of
  // the handler would make them wrong under precisely the concurrency this rewrite exists to handle.
  const prior = await Feedback.findOneAndUpdate({
    _id: fb._id,
    // the idempotency clause, in the filter rather than in a read before it: no match means this
    // exact write is already on the row, and no write of any kind happens
    ...(idempotencyKey ? { 'additions.idempotencyKey': { $ne: idempotencyKey } } : {}),
  }, [
    {
      $set: {
        body: {
          $cond: [
            { $eq: [{ $ifNull: ['$body', ''] }, ''] },
            { $literal: line },
            { $concat: [{ $ifNull: ['$body', ''] }, '\n\n', { $literal: line }] },
          ],
        },
        additions: {
          $concatArrays: [
            { $ifNull: ['$additions', []] },
            [{
              author: { $literal: addition.author },
              authorType: { $literal: addition.authorType },
              at,
              note: { $literal: addition.note },
              attachments: { $literal: addition.attachments },
              ...(idempotencyKey ? { idempotencyKey: { $literal: idempotencyKey } } : {}),
            }],
          ],
        },
        // deduped against the array as it stands at write time, not against the snapshot read above
        attachments: {
          $concatArrays: [
            { $ifNull: ['$attachments', []] },
            {
              $filter: {
                input: { $literal: sent },
                as: 'u',
                cond: { $not: [{ $in: ['$$u', { $ifNull: ['$attachments', []] }] }] },
              },
            },
          ],
        },
        updatedAt: at,
      },
    },
  ] as never, { returnDocument: 'before' });
  // Two ways to match nothing now, and they are opposite facts. The row was deleted mid-flight, or
  // this exact write is already on it, so the row is checked before either is reported.
  if (!prior) {
    const still = idempotencyKey ? await Feedback.findOne({ _id: fb._id }) : null;
    if (!still) return c.json({ error: `${fb.shortId} no longer exists; nothing was appended` }, 404);
    // appended:true because the words ARE on the row, which is what the caller was asking for and
    // what every caller of this route branches on. idempotent:true is how it learns nothing happened
    // just now, which matters to anyone about to tell a human their note was "just added".
    return c.json({
      appended: true,
      idempotent: true,
      feedback: still,
      warnings: [`this exact append (idempotencyKey ${idempotencyKey}) was already on ${fb.shortId}, so nothing was written and nothing was duplicated. it is on the row from the earlier call, not from this one`],
    });
  }
  const after = await Feedback.findOne({ _id: fb._id });

  const warnings: string[] = [];
  // same posture as POST /charter/append: not idempotent, and it says so rather than guessing that a
  // repeat was a mistake. A retried call adds a second attributed line, which is visible and
  // removable; a swallowed one would be neither.
  if (note && (prior.body ?? '').includes(note)) {
    warnings.push('that note is already on this row verbatim; appended anyway (this route is not idempotent, check before repeating a call you are unsure landed)');
  }
  const already = sent.filter((u) => (prior.attachments ?? []).includes(u)).length;
  if (already) {
    warnings.push(`${already} of the ${sent.length} attachment(s) you sent were already on ${fb.shortId} and are stored once, not twice; the note was appended either way`);
  }
  // Status is NOT touched: a resolved row that gains evidence is not automatically open again, and
  // the reporter's thread does not get a message nobody decided to send. But a closed row is not in
  // any triage queue, so an append onto one is invisible work unless somebody is told.
  if (['resolved', 'rejected'].includes(prior.status)) {
    warnings.push(`${fb.shortId} is ${prior.status}, so this addition is not in any triage queue and nothing here changed that. If it should be looked at again, reopen the row on purpose (PATCH /api/feedback/${fb.shortId} {"status":"pending"})`);
  }
  const what = [note ? 'a note' : '', sent.length ? `${sent.length} attachment(s)` : ''].filter(Boolean).join(' and ');
  await logEvent(fb.projectId, `${fb.shortId}: ${author} appended ${what}${note ? `: ${note.slice(0, 80)}` : ''}`, fb.taskId);
  return c.json({ appended: true, feedback: after, warnings });
});

// ---------- parked reports: held by Gabbar's gate, and NOT feedback ----------
//
// WHERE THE DATA COMES FROM, and what it costs.
// A parked report is a JSON file under config.parkedDir, written by apps/gabbar/src/parked.ts when
// the stakeholder gate refuses a report. It is not in Mongo, and its absence from Mongo is
// load-bearing: "never touches the feedback collection" is the reason a refused report cannot pass
// for a filed one. So the server READS THE DIRECTORY and never writes a byte of it. Gabbar remains
// the only writer, which also means there is no lock to get wrong.
//
// The honest cost is a second process bound to an on-disk format nothing enforces. The parser below
// therefore assumes almost nothing: a file only has to be JSON under a PARK-* name, every field
// degrades to a stated default, and a file that cannot be read is COUNTED rather than skipped in
// silence — a held report we cannot show is worse than one we know we cannot show. The fields it
// depends on are the ones parking itself shipped with (status, createdAt, author, target,
// feedbackType, body, rawMessage, attachments, mediaNotes, gate.detail, promotion.feedbackShortId).
// cause / escalatedAt / lastAttemptAt come from escalation work still in review, so they are read
// when present and absent otherwise; nothing here breaks if that lands, changes, or never does.
// kind / appendTo arrived with held ADDITIONS and degrade the same way: no kind is a report, which
// is what every file written before them actually is.
//
// Two alternatives, rejected:
//  · Gabbar POSTs held reports to the server, which stores them. That gives a refused report a home
//    in the database, which is the one thing that must not exist, and needs a Gabbar change besides.
//  · a separate Mongo collection rather than `feedback`. Same objection one indirection later: the
//    invariant a human actually checks is "there is no row for a refused report", and a row is a row.
// Resolved per read rather than once at import. It is the same string either way in a running
// server, and at import it made this module's directory depend on WHICH FILE IMPORTED IT FIRST:
// parked.test.ts had to be the first importer of api.ts in the process for its rig to take, so any
// later test file that imported api.ts earlier silently pointed the parser at the wrong directory.
// A path read where it is used cannot be captured by an import order nobody can see.
const parkedDir = () => path.resolve(config.parkedDir);
// A directory grown past this IS the headline, so the count says so instead of the response quietly
// getting bigger every sweep. Same reasoning as the digest cap in Gabbar's escalation.
const PARKED_READ_CAP = 500;
// per item, for transport only: the file on disk stays the full record, and theirWordsTruncated says
// when a reader is not looking at all of it
const PARKED_WORDS_CAP = 2000;
const PARKED_BODY_CAP = 1000;

const objOf = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const trimOrNull = (v: unknown): string | null => { const s = str(v)?.trim(); return s ? s : null; };

function parkedSummary(parkId: string, raw: Record<string, unknown>, mtime: Date): ParkedSummary {
  const author = objOf(raw.author), target = objOf(raw.target), gate = objOf(raw.gate), promotion = objOf(raw.promotion);
  const words = str(raw.rawMessage) ?? '';
  // WHAT is held, not just that something is. A refused APPEND holds evidence for a row that already
  // exists, and rendering it in report language says somebody reported a thing when what they did was
  // add a screenshot to a finding — the board narrating an event that did not happen. Gabbar's
  // escalation digest already tells the two apart, so this reader was the surface that lagged.
  // Collapsed exactly the way parked.ts collapses its own files: anything that is not literally
  // 'addition' is a report, which is also what a file written before `kind` existed is. Conservative
  // in the right direction — an unknown word cannot make a held item disappear, it reads as the
  // ordinary case, and a third kind would have to be added here and in ParkedSummary to be told apart.
  const kind: ParkedSummary['kind'] = trimOrNull(raw.kind) === 'addition' ? 'addition' : 'report';
  return {
    parkId,
    filed: false, // literally false on every row, like Gabbar's own summarize()
    parked: true,
    kind,
    // read only on an addition: a report has no destination, and a stray appendTo on a report file
    // would put a feedback id on a card whose words are not going to any row
    appendTo: kind === 'addition' ? trimOrNull(raw.appendTo) : null,
    // constant per kind, and here for the reason parked.ts's summarize() carries it: the field that
    // says nothing reached that row travels beside the only field that names one
    addedToRow: kind === 'addition' ? false : null,
    status: trimOrNull(raw.status) ?? 'parked',
    author: trimOrNull(author.name) ?? 'unknown',
    authorSlackId: trimOrNull(author.slackUserId) ?? '',
    project: trimOrNull(target.projectName) ?? trimOrNull(target.projectRef),
    projectRef: trimOrNull(target.projectRef),
    onTask: trimOrNull(target.taskRef),
    type: trimOrNull(raw.feedbackType) ?? 'bug',
    body: (str(raw.body) ?? '').slice(0, PARKED_BODY_CAP),
    theirWords: words.slice(0, PARKED_WORDS_CAP),
    theirWordsTruncated: words.length > PARKED_WORDS_CAP,
    attachments: strArr(raw.attachments),
    mediaNotes: strArr(raw.mediaNotes),
    // a file with no readable timestamp still has an age; mtime beats claiming it arrived just now
    heldSince: trimOrNull(raw.createdAt) ?? mtime.toISOString(),
    // Gabbar reads a missing cause as stakeholder_gap, its conservative default. The same word is
    // used here on purpose, so the board and the owner's digest cannot describe one item two ways.
    cause: trimOrNull(raw.cause) ?? 'stakeholder_gap',
    reasonParked: trimOrNull(gate.detail) ?? trimOrNull(gate.kind) ?? '',
    escalatedAt: trimOrNull(raw.escalatedAt),
    lastAttemptAt: trimOrNull(raw.lastAttemptAt),
    promotedTo: trimOrNull(promotion.feedbackShortId),
  };
}

type ParkedDirRead = { items: ParkedSummary[]; dirPresent: boolean; error: string | null; unreadable: number; ignored: number; files: number; scanned: number };
function readParkedDir(dir: string): ParkedDirRead {
  let names: string[];
  let ignored = 0;
  try {
    // The PARK-* filter happens HERE, on the listing, not inside the loop, and that is the whole
    // point: a name that is not a park id is not a held report we failed to read, it is somebody
    // else's file. Counting a stray notes.json as unreadable made the band announce a lost report
    // and there was none. They are counted apart, and nothing that fails isParkId is ever joined
    // onto a path — the id guard is still the path guard, one step earlier.
    const all = fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
    names = all.filter((n) => isParkId(n.slice(0, -'.json'.length))).sort();
    ignored = all.length - names.length;
  } catch (e) {
    // ENOENT is the ordinary state of a machine where nothing has ever been refused: no directory,
    // nothing held, no alarm. Anything else means held reports we cannot see, which must not render
    // as "none held" — it is reported verbatim instead.
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return { items: [], dirPresent: false, error: null, unreadable: 0, ignored: 0, files: 0, scanned: 0 };
    console.error(`parked: cannot read ${dir}: ${String(e)}`);
    return { items: [], dirPresent: true, error: `the held-report directory could not be read (${String(e)})`, unreadable: 0, ignored: 0, files: 0, scanned: 0 };
  }
  const items: ParkedSummary[] = [];
  let unreadable = 0;
  // The cap bounds the WORK, so it applies to filenames before anything is opened, which makes the
  // selection filename order rather than age. A parkId is channel + slack ts, so within a channel
  // that order IS chronological and the cap drops the NEWEST — the safer direction for a surface
  // whose job is that nothing gets forgotten. Across channels it is neither, so the response states
  // how many files it did not open rather than implying anything about which.
  const scan = names.slice(0, PARKED_READ_CAP);
  for (const name of scan) {
    const parkId = name.slice(0, -'.json'.length); // already through isParkId above: no '/', '.' or '..'
    try {
      const file = path.join(dir, name);
      const mtime = fs.statSync(file).mtime;
      const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as unknown;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { unreadable++; continue; }
      items.push(parkedSummary(parkId, raw as Record<string, unknown>, mtime));
    } catch { unreadable++; }
  }
  items.sort((a, b) => a.heldSince.localeCompare(b.heldSince)); // oldest first, like the owner digest
  return { items, dirPresent: true, error: null, unreadable, ignored, files: names.length, scanned: scan.length };
}

const parkedKeyMatches = (v: string | null, p: Project): boolean => {
  const k = (v ?? '').trim().toLowerCase();
  return !!k && (k === p.prefix.trim().toLowerCase() || k === p.name.trim().toLowerCase());
};
// An item with no project reference at all is the one that would otherwise never be found again, so
// it shows on every project's read, flagged by project:null, rather than being filed into a place
// nobody looks. Everything else is matched on what the reporter wrote or what Gabbar resolved.
const parkedFor = (i: ParkedSummary, p: Project): boolean =>
  (!i.projectRef && !i.project) || parkedKeyMatches(i.projectRef, p) || parkedKeyMatches(i.project, p);

// LOCAL ONLY, and it now says so IN CODE rather than leaning on a config file staying narrow.
// Why the route must be local: a parked report is by definition from somebody this project has NOT
// vouched for, held verbatim with their slack id, and /api/p/:capId is readable by anyone holding a
// share link. Putting held reports on that payload would widen the tunnel surface to solve a
// visibility problem the ORCHESTRATOR has, and the orchestrator is local.
//
// It used to be local for one reason only: '/api/parked' is not under the '/api/p/' prefix that
// data/routes.json currently publishes. True today, and one character from false — '/api/p' without
// the trailing slash publishes this route, and so do '/api/' and '/api/*'. That is a property of a
// file somebody edits, not of this code, and an exposure boundary that a typo elsewhere can move is
// not a boundary. So the check below is the boundary, and routes.json is the second layer.
// x-forwarded-host is set by OUR proxy on every request it judged public, and stripped from every
// request it judged local, so this is the proxy's own decision asserted here rather than a new one.
// It is deliberately not re-derived: `host` is hop-by-hop at the proxy, so everything forwarded
// arrives here looking like loopback and a Host test at this end would pass for the whole internet.
//
// This comment used to say the header was "what ngrok sets", and named as a tolerable residual that
// "a front door that does not set the header fools this check and the proxy's identically". DAR-252
// is that residual happening: zrok forwards without it. The proxy setting it is what closes it, so
// the dependency runs on our code now, not a vendor's. A local caller can still set it by hand and
// lose access to a local route, which fails closed and costs somebody with shell access nothing.
// Whatever else changes here, this route must never move under '/api/p/' and this check must not
// come out.
api.get('/parked', async (c) => {
  if (c.req.header('x-forwarded-host')) {
    return c.json({ error: 'held reports are local-only: they are unfiled words from somebody this project has not vouched for, and they do not travel through a share link' }, 403);
  }
  const ref = c.req.query('project');
  let p: Project | null = null;
  if (ref) {
    p = await resolveProject(ref);
    if (!p) return c.json({ error: 'project not found' }, 404);
  }
  // 'parked' is the default because held-and-waiting is the pending work; promoted and superseded
  // rows are history and stay one query away rather than padding the lane.
  const status = (c.req.query('status') ?? 'parked').trim().toLowerCase();
  const dir = parkedDir();
  const read = readParkedDir(dir);
  const scoped = p ? read.items.filter((i) => parkedFor(i, p!)) : read.items;
  const items = status === 'all' ? scoped : scoped.filter((i) => i.status === status);
  const truncated = read.scanned < read.files;
  const body: ParkedRead = {
    dir,
    dirPresent: read.dirPresent,
    error: read.error,
    files: read.files,
    scanned: read.scanned,
    truncated,
    ...(truncated
      ? { note: `PARTIAL ANSWER: ${read.scanned} of ${read.files} files in ${dir} were read, in filename order. The rest are still held on disk and are NOT represented in any count below.` }
      : {}),
    unreadable: read.unreadable,
    ignored: read.ignored,
    inScope: scoped.length,
    held: scoped.filter((i) => i.status === 'parked').length,
    returned: items.length,
    items,
  };
  return c.json(body);
});

// ---------- the orchestrator inbox, and the doorbell on it ----------
//
// DAR-245. The pending queue is the orchestrator's inbox and, until this, nothing rang it: Gabbar
// filed a row and the row waited for somebody to think of it. Two real cases in one day. Abhishek's
// idea sat until Raj typed "process the feedbacks". A held report promoted only because Raj happened
// to add him as a stakeholder, which ran the sweep by luck.
//
// WHY A STREAM AND NOT A PLAIN LONG-POLL. See apps/server/src/inbox.ts for the harness side: the
// only thing that wakes an idle Claude session is a task-notification, and the one an orchestrator
// can arm for itself is a background command EXITING. So the wake carrier is a process exit, which
// makes the contract "hold the connection open until there is something, then close it" — the client
// is one `curl` and needs no parser. A silent held-open connection dies on Bun's idleTimeout
// (config.serverIdleTimeout, 120s), so this writes a single space every config.sseKeepaliveMs, the
// same trick and the same clock the board's SSE stream already uses. The keepalives are whitespace
// precisely so the caller can read the last line as the answer.
//
// LEVEL-TRIGGERED ON STATE, NOT ON EVENTS. What fires is not "a POST happened", it is "this project
// has inbox work whose watermark is newer than the cursor you handed me". Three things follow, and
// they are the reason this design is worth having over a queue:
//  · A wake that nobody was armed to receive is not lost. The next arm re-reads the queue.
//  · A server restart, which happens several times a day here, costs one wake: curl's connection
//    drops, the process exits, the session re-arms with the same cursor and gets whatever landed.
//  · THE ORCHESTRATOR CANNOT WAKE ITSELF ON ITS OWN WRITES. The inbox is feedback at `pending` plus
//    reports still held at `parked`, and every act the orchestrator performs on a pending row moves
//    it OUT of pending (triaged, accepted, rejected, resolved). needs_clarification is deliberately
//    NOT in the inbox for the same reason the done-gate skips it: that row is with the reporter, not
//    with us. The only writer that can put something INTO this inbox is a human, via Gabbar or via a
//    thread reply reopening a row, which is exactly the set of events worth a wake.
//
// THE CURSOR NAMES WHAT YOU HAVE ALREADY BEEN TOLD, and nothing else. It decides whether to FIRE; it
// never decides what to SEND. A wake always carries the whole current inbox, with `newSince` naming
// the part that is new to you, so a wake can never hand over a partial queue and no item can slip
// between two adjacent watermarks. Re-arming with the `nextCursor` you were given is what stops a
// wake you chose to ignore from ringing again in a loop; re-arming with the cursor you sent replays
// it. Both are legitimate and neither loses anything, because the board is the record and this is
// only the doorbell.
//
// A WAKE THAT ARRIVES MID-TURN cannot interrupt one: the harness queues a task-notification behind
// the running turn. The session re-arms at the end of that turn and, being level-triggered, is
// immediately handed anything that landed while it was busy.
const INBOX_SUMMARY_CAP = 240;

// One shape for both halves of the inbox, because the orchestrator's question is the same either
// way: who is waiting on me and since when. What differs (a feedback row can be triaged, a held
// report has to be promoted first) is carried by `kind` rather than by two payload shapes.
type InboxItem = {
  kind: 'feedback' | 'parked';
  id: string;
  /** watermark: the moment this became, or became again, something waiting on the orchestrator */
  at: string;
  author: string;
  type: string;
  onTask: string | null;
  summary: string;
};

// max(createdAt, updatedAt), not createdAt. A row reopened by a thread reply keeps its original
// createdAt, so a createdAt-only watermark would put a reopened row permanently behind every cursor
// and it would never ring again — the exact silence this route exists to end.
const feedbackWatermark = (fb: FeedbackDoc): string => {
  const c = new Date(fb.createdAt).getTime(), u = new Date(fb.updatedAt ?? fb.createdAt).getTime();
  return new Date(Math.max(c, Number.isFinite(u) ? u : c)).toISOString();
};

// Cheap "did a file appear here" probe for the parked directory. A directory's mtime moves when an
// entry is created or removed, which is the only parked change that can add inbox work: a file
// EDITED in place (escalation stamping escalatedAt, a promotion writing its status) does not move it,
// and neither of those is a new report. A missing directory is the ordinary state of a machine where
// nothing has ever been refused, so it stamps as absent rather than as an error.
function dirStamp(dir: string): string {
  try { return String(fs.statSync(dir).mtimeMs); } catch { return 'absent'; }
}

type InboxRead = {
  items: InboxItem[];
  newSince: string[];
  nextCursor: string;
  pendingCount: number;
  heldCount: number;
  /** a parked directory we could not read: "none held" and "cannot look" must never read the same */
  parkedError: string | null;
  parkedTruncated: boolean;
};

// The parked half, kept apart from the feedback half because they are refreshed on different
// clocks: a feedback row is one indexed query and is re-read on every tick, while this opens up to
// PARKED_READ_CAP files and is only re-read when the directory's mtime says one appeared.
type ParkedPart = { stamp: string; items: InboxItem[]; error: string | null; truncated: boolean };
function readParkedPart(p: Project): ParkedPart {
  const dir = parkedDir();
  // stamped BEFORE the read, deliberately: a file that lands mid-read is then still newer than the
  // stamp and gets picked up on the next tick, where stamping after would record it as already seen
  const stamp = dirStamp(dir);
  const park = readParkedDir(dir);
  const held = park.items.filter((i) => i.status === 'parked' && parkedFor(i, p));
  return {
    stamp,
    error: park.error,
    truncated: park.scanned < park.files,
    items: held.map((i) => ({
      kind: 'parked' as const,
      id: i.parkId,
      at: i.heldSince,
      author: i.author,
      type: i.type,
      onTask: i.onTask,
      summary: (i.body || i.theirWords).slice(0, INBOX_SUMMARY_CAP),
    })),
  };
}

async function readInbox(p: Project, cursor: string | null, park?: ParkedPart): Promise<InboxRead> {
  const pending = await Feedback.find({ projectId: p._id!, status: 'pending' }).sort({ createdAt: 1 }).toArray();
  const items: InboxItem[] = pending.map((fb) => ({
    kind: 'feedback' as const,
    id: fb.shortId,
    at: feedbackWatermark(fb),
    author: fb.author,
    type: fb.type,
    onTask: fb.taskShortId,
    summary: fb.body.slice(0, INBOX_SUMMARY_CAP),
  }));
  const held = park ?? readParkedPart(p);
  items.push(...held.items);
  items.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  const cut = cursor ? Date.parse(cursor) : Number.NEGATIVE_INFINITY;
  const newSince = items.filter((i) => Date.parse(i.at) > cut).map((i) => i.id);
  // never moves backwards: an empty inbox leaves the caller's own cursor standing rather than
  // stamping now, so a re-arm cannot step over something filed in the same breath
  const maxAt = items.reduce((m, i) => (i.at > m ? i.at : m), cursor ?? '');
  return {
    items,
    newSince,
    nextCursor: maxAt || new Date(0).toISOString(),
    pendingCount: pending.length,
    heldCount: held.items.length,
    parkedError: held.error,
    parkedTruncated: held.truncated,
  };
}

// Same boundary as /parked next door, for the same reason and stated in code rather than left to a
// routes file staying narrow: this payload is pending feedback bodies plus verbatim words from
// people the project has NOT vouched for, and it is an orchestrator surface. It must never be
// reachable through a share link.
const inboxIsRemote = (c: Context) => !!c.req.header('x-forwarded-host');
const INBOX_REMOTE_ERROR =
  'the orchestrator inbox is local-only: it carries unfiled words from people this project has not vouched for, and it does not travel through a share link';

// Query params get the DAR-208 treatment the bodies get: a cursor or a timeout the caller sent and
// this route cannot use is a 400 naming the problem, never a silent fall back to the default. A
// cursor misread as "no cursor" would replay the whole queue on every wake, and a caller would have
// no way to see why.
function inboxArgs(c: Context): { cursor: string | null; waitMs: number } | string {
  const rawCursor = c.req.query('cursor');
  let cursor: string | null = null;
  if (rawCursor !== undefined && rawCursor !== '') {
    const t = Date.parse(rawCursor);
    if (!Number.isFinite(t)) {
      return `cursor must be an ISO timestamp, e.g. 2026-08-11T09:15:00.000Z (got ${JSON.stringify(rawCursor)}). It is the nextCursor from your previous read, and it decides only whether this rings, never what it sends`;
    }
    cursor = new Date(t).toISOString();
  }
  const rawWait = c.req.query('waitMs');
  let waitMs = config.inboxWaitMsDefault;
  if (rawWait !== undefined && rawWait !== '') {
    const n = Number(rawWait);
    if (!Number.isFinite(n) || n <= 0) return `waitMs must be a positive number of milliseconds (got ${JSON.stringify(rawWait)})`;
    waitMs = Math.min(n, config.inboxWaitMsMax);
  }
  return { cursor, waitMs };
}

// The non-blocking read. This is the first call of a drain: take the snapshot, work the items, then
// arm the wait below with the nextCursor it hands back. Doing it in that order is also what keeps a
// row the orchestrator files itself (a chat item filed as feedback, per the charter) from ringing
// its own doorbell a moment later.
api.get('/projects/:ref/inbox', async (c) => {
  if (inboxIsRemote(c)) return c.json({ error: INBOX_REMOTE_ERROR }, 403);
  const p = await resolveProject(c.req.param('ref'));
  if (!p) return c.json({ error: 'project not found' }, 404);
  const args = inboxArgs(c);
  if (typeof args === 'string') return c.json({ error: args }, 400);
  const read = await readInbox(p, args.cursor);
  return c.json({ woke: read.newSince.length > 0, project: p.prefix, at: new Date().toISOString(), cursor: args.cursor, ...read });
});

// The doorbell itself. Holds until this project's inbox has something newer than `cursor`, then
// writes one JSON line and closes, which is what makes the caller's process exit.
//
// The intended caller is a background shell in the orchestrator session, and it is one line:
//   curl -sN "http://localhost:4899/api/projects/DAR/inbox/wait?cursor=<nextCursor>"
// Everything before the payload is whitespace, so the last line of that output is the answer.
api.get('/projects/:ref/inbox/wait', async (c) => {
  if (inboxIsRemote(c)) return c.json({ error: INBOX_REMOTE_ERROR }, 403);
  const p = await resolveProject(c.req.param('ref'));
  if (!p) return c.json({ error: 'project not found' }, 404);
  const args = inboxArgs(c);
  if (typeof args === 'string') return c.json({ error: args }, 400);
  const { cursor, waitMs } = args;
  const key = p._id!.toHexString();
  const deadline = Date.now() + waitMs;

  return streamText(c, async (s) => {
    let open = true;
    s.onAbort(() => { open = false; });
    const say = async (line: string) => { await s.write(line).catch(() => { open = false; }); };

    // Held reports are files another process writes, so there is no in-process signal for them at
    // all. Their half of the inbox is therefore cached and only re-parsed when the directory's mtime
    // says a file appeared, which costs one stat per tick instead of opening every held report.
    let park = readParkedPart(p);
    let read = await readInbox(p, cursor, park);
    let lastKeepalive = Date.now();

    while (open && read.newSince.length === 0 && Date.now() < deadline) {
      const slice = Math.min(config.inboxParkedTickMs, deadline - Date.now());
      if (slice <= 0) break;
      // A nudge cuts the tick short, so a filed row rings in milliseconds. The tick itself is the
      // safety net under it: THE QUEUE IS RE-READ EITHER WAY. There is a real (sub-millisecond)
      // window between the read above and this waiter arming in which a nudge reaches nobody, and
      // there will be future write paths whose author forgets to ring at all. Re-reading on the
      // tick regardless turns both of those from a wake lost until the deadline into a wake late by
      // one tick, and it costs one indexed query on a local database every inboxParkedTickMs.
      await waitForNudge(key, slice);
      if (!open) break;
      if (dirStamp(parkedDir()) !== park.stamp) park = readParkedPart(p);
      read = await readInbox(p, cursor, park);
      if (read.newSince.length === 0 && Date.now() - lastKeepalive >= config.sseKeepaliveMs) {
        await say(' ');
        lastKeepalive = Date.now();
      }
    }
    if (!open) return;

    const woke = read.newSince.length > 0;
    await say(`\n${JSON.stringify({
      woke,
      project: p.prefix,
      at: new Date().toISOString(),
      cursor,
      ...read,
      note: woke
        ? `${read.newSince.length} new in the ${p.prefix} inbox (${read.pendingCount} pending feedback, ${read.heldCount} held). Triage them, then re-arm this wait with cursor=${read.nextCursor}.`
        : `nothing new in ${waitMs}ms (${read.pendingCount} pending feedback, ${read.heldCount} held, none newer than your cursor). Re-arm with cursor=${read.nextCursor}.`,
    })}\n`);
  });
});

// ---------- events ----------

api.post('/events', async (c) => {
  const b = await readBody(c);
  if (!b) return c.json({ error: 'invalid json body' }, 400);
  // an `at` was dropped under a 200, so a backfilled event landed stamped now and read as fresh
  // activity on the resume trail (DAR-208 sweep)
  if (b.at !== undefined) {
    return c.json({ error: notHere('at', 'the server stamps an event when it is written, so a backdated one would read as something that just happened. Say the real time in the text') }, 400);
  }
  const p = await resolveProject(str(b.project) ?? '');
  if (!p) return c.json({ error: 'project not found' }, 404);
  const task = str(b.taskRef) ? await resolveTaskRef(str(b.taskRef)!) : null;
  await logEvent(p._id!, str(b.text) ?? '', task?._id ?? null);
  return c.json({ ok: true });
});
