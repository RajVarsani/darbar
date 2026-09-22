import type { ObjectId } from 'mongodb';

export type Stakeholder = { name: string; slackUserId?: string; role?: string };

// review pipeline: lanes spawned as subtasks when a dev task hits in_review.
// autoAdvance: parent leaves in_review by itself when the last review child closes.
export type ReviewLane = { lane: string; label: string; manager: string };
export type Pipeline = { autoAdvance: boolean; reviews: ReviewLane[] };

// agent registry: brief = standing charter the orchestrator dispatches with; trigger = when-to-dispatch hint
export type ProjectAgent = { name: string; kind: 'lane-manager' | 'helper' | 'orchestrator'; brief: string; trigger?: string };

// ---------- public path patterns ----------
// `public` entries are NOT regular expressions. A regex allowlist on the front door was a ReDoS
// hole that could not be closed from the execution side: holding the path fixed at 64 chars and
// growing only the PATTERN, `^/`+`.*`xK+`x$` costs 0.1ms at K=3 and 11958ms at K=8 (a 20-char
// pattern), so cost at a fixed short path is unbounded in pattern length and a path-length cap
// bounds the wrong variable; `^/(((z+))+)+$` reaches 1429ms at a 16-char path; and a worker cannot
// rescue it because terminate() cannot preempt a thread already inside the backtracking loop.
// So the language below is matched with STRING OPERATIONS ONLY — ===, startsWith, indexOf. There is
// no engine that can backtrack, which makes the whole class unreachable rather than measured-cheap.
// Deliberately NOT lowered to a constructed RegExp for that same reason: a lowered glob benchmarks
// fine, but its safety would then rest on a measurement instead of on the absence of an engine.
//
//   /assets/       PREFIX — every request path that starts with it (patterns anchor at the start)
//   /$             EXACT  — a trailing $ means the path must equal the literal
//   /assets/*.js$  GLOB   — at most ONE *, matching any run of characters except '/'
//
// An empty list means nothing is reachable, and that is also what an unparseable entry degrades to:
// every failure here drops the entry, never widens it.
export const PATH_PATTERN_FORM =
  'a literal path starting with "/" — prefix by default, a trailing "$" for exact, and at most one "*" matching within a single path segment';
export const PATH_PATTERN_MAX_LEN = 200;
// what a URL path legitimately carries. Every regex metacharacter that is not on this list
// (^ ( ) [ ] { } | + ? \ and a bare $ mid-pattern) is refused by name, so an old regex fails loudly
// instead of being silently reinterpreted as literal text. '.' and '-' are literals here.
// This is the ONLY RegExp in the file and it is not on the matching path: it is a fixed character
// class run once per pattern at CONFIG time, over an input already capped at PATH_PATTERN_MAX_LEN,
// and it is not attacker-authored. matchPathPattern below — the thing every tunneled request runs —
// contains no regex at all.
const PATH_PATTERN_LITERAL = /^[A-Za-z0-9._~%!'@:,;=&/-]*$/;

// head/tail are the literal chunks either side of the single '*'; tail is null when there is no '*'.
export type PathPattern = { src: string; head: string; tail: string | null; exact: boolean };

export function pathPatternError(src: unknown): string | null {
  if (typeof src !== 'string' || !src) return 'must be a non-empty string';
  if (src.length > PATH_PATTERN_MAX_LEN) return `is longer than ${PATH_PATTERN_MAX_LEN} chars`;
  const body = src.endsWith('$') ? src.slice(0, -1) : src;
  if (!body.startsWith('/')) {
    return src.startsWith('^')
      ? `starts with "^" — public patterns are no longer regular expressions. Write ${PATH_PATTERN_FORM}: "^/assets/" becomes "/assets/", "^/$" becomes "/$", "^/" becomes "/"`
      : `must start with "/" — ${PATH_PATTERN_FORM}`;
  }
  if (body.split('*').length - 1 > 1) return 'contains more than one "*" — at most one is allowed, and it never matches across "/"';
  if (body.includes('.*')) return 'contains ".*", which is regex — here "." is a literal dot and "*" is a glob; write "/" alone for a prefix that matches every path';
  const lit = body.split('*').join('');
  if (!PATH_PATTERN_LITERAL.test(lit)) {
    const bad = [...lit].find((ch) => !PATH_PATTERN_LITERAL.test(ch));
    return `contains ${JSON.stringify(bad)}, which is not a literal path character — ${PATH_PATTERN_FORM}`;
  }
  return null;
}

export function parsePathPattern(src: string): PathPattern | null {
  if (pathPatternError(src)) return null;
  const exact = src.endsWith('$');
  const body = exact ? src.slice(0, -1) : src;
  const i = body.indexOf('*');
  return i < 0
    ? { src, head: body, tail: null, exact }
    : { src, head: body.slice(0, i), tail: body.slice(i + 1), exact };
}

// String ops only. Worst case O(path length) per pattern, no backtracking, always terminates.
// With exactly one '*' the leftmost tail match is also exactly correct: a '/' before the leftmost
// occurrence is a '/' before every later one, so there is nothing a second attempt could recover.
export function matchPathPattern(p: PathPattern, path: string): boolean {
  if (p.tail === null) return p.exact ? path === p.head : path.startsWith(p.head);
  if (!path.startsWith(p.head)) return false;
  const rest = path.slice(p.head.length); // the '*' plus the tail must cover exactly this
  if (p.exact) {
    if (rest.length < p.tail.length || !rest.endsWith(p.tail)) return false;
    return !rest.slice(0, rest.length - p.tail.length).includes('/');
  }
  const at = rest.indexOf(p.tail);
  return at >= 0 && !rest.slice(0, at).includes('/');
}

// READ-TIME MIGRATION for strings written before this language existed (routes.json on disk, and
// project docs not re-saved since). A legacy entry converts only when it is a PURE LITERAL path once
// the anchors come off; anything else is HARD-REJECTED loudly, because silently reading a regex as
// literal text mis-matches — usually narrower, sometimes wider, never what was written.
const LEGACY_META = '.*+?()[]{}|\\^$';
export function migratePathPattern(src: unknown): { pattern: string } | { error: string } {
  if (typeof src !== 'string' || !src) return { error: 'is not a non-empty string' };
  if (!src.startsWith('^')) {
    const e = pathPatternError(src);
    return e ? { error: e } : { pattern: src };
  }
  let body = src.slice(1);
  let exact = false;
  if (body.endsWith('$')) { body = body.slice(0, -1); exact = true; }
  const meta = [...body].find((ch) => LEGACY_META.includes(ch));
  if (meta) {
    return { error: `is a legacy regex containing ${JSON.stringify(meta)}, which this language cannot express — rewrite it as ${PATH_PATTERN_FORM}` };
  }
  const out = body + (exact ? '$' : '');
  const e = pathPatternError(out);
  return e ? { error: `is a legacy regex that converts to ${JSON.stringify(out)}, which ${e}` } : { pattern: out };
}

// Compile a stored `public` list into matchers. FAILS CLOSED: a bad entry is dropped (never widened,
// never reinterpreted) and reported through onReject, so an all-bad list ends up as [] — nothing
// reachable. An absent or non-array list is likewise [], never match-everything.
export function compilePublic(list: unknown, onReject: (src: string, why: string) => void): PathPattern[] {
  if (!Array.isArray(list)) {
    if (list !== undefined && list !== null) onReject(String(list), 'is not an array of patterns');
    return [];
  }
  const out: PathPattern[] = [];
  for (const raw of list) {
    const m = migratePathPattern(raw);
    if ('error' in m) { onReject(typeof raw === 'string' ? raw : String(raw), m.error); continue; }
    const p = parsePathPattern(m.pattern);
    if (!p) { onReject(String(raw), 'could not be parsed'); continue; }
    out.push(p);
  }
  return out;
}

// dev server shared through the proxy. prefix is the URL segment AND the routing key (unique
// across projects); public[] is the path-pattern allowlist (above) the proxy enforces on tunneled
// requests. target must be a LOCAL address — the proxy is what the tunnel fronts.
export type ProjectProxy = { prefix: string; target: string; public: string[]; enabled: boolean };

// what the server has actually put in the proxy route table for this project and not yet
// successfully withdrawn. `proxy` is intent, this is fact, and they differ whenever a push failed.
// Normally 0 or 1 entries; more only when a withdrawal failed and left an orphan behind. Kept even
// after `proxy` is cleared, so a failed withdrawal is still convergeable by the boot sync, and used
// as the ownership token so we never delete a prefix somebody else now holds.
export type PublishedRoute = { prefix: string; target: string; public: string[] };

export type Project = {
  _id?: ObjectId;
  name: string;
  prefix: string;
  capId: string;
  repos: string[];
  charter: string;
  stakeholders: Stakeholder[];
  slackChannel: string | null;
  pipeline?: Pipeline;
  agents?: ProjectAgent[];
  proxy?: ProjectProxy;
  proxyPublished?: PublishedRoute[];
  /** external mirror: when set, the console card opens this Linear view instead of the native
   *  board. Rows, feedback and the engine stay HERE; the Linear side is a hand-synced copy. */
  linearUrl?: string | null;
  counters: { task: number; feedback: number };
  createdAt: Date;
  // ---------- archiving: a finished project comes OFF the active board ----------
  // A TIMESTAMP, not a boolean, for the same reason dispatchedAt is: when it was finished is the
  // thing you want later, and a boolean throws it away on the one write that could have recorded it.
  // Absent on every project registered before this existed, and that is the honest reading: never
  // archived, not "we lost the date". Nothing is backfilled. null means the same as absent and is
  // what an UNARCHIVE writes, because a field that has been cleared is worth telling apart from one
  // that was never set. Every read normalises both to null so a consumer never has to know which.
  archivedAt?: Date | null;
  /** why it was finished, in the words of whoever archived it. A project archived with no reason is
   *  a project nobody can explain in a month, which is why the doors ask for one. */
  archiveReason?: string;
  /**
   * Rows still OPEN at the moment it was archived and deliberately LEFT open, which only happens on
   * a forced archive. 0 on every honest archive, including one that cancelled its open rows.
   *
   * Server-owned and counted at archive time. It exists because forcing is the one path that takes
   * pending work off every active surface without closing it, and a count that lives only in an
   * event line is a count nobody reads. The rows themselves are untouched and still on their board.
   */
  archivedOpenRows?: number;
};

// jira-style workflow; blocked stays a status (visible column) with the free-text `blocker` field carrying the why
export type TaskStatus = 'backlog' | 'todo' | 'in_progress' | 'in_review' | 'qa' | 'blocked' | 'done' | 'cancelled';
// review tasks are pipeline-spawned children: they render as pips on the parent card, never as kanban cards
export type TaskType = 'feature' | 'bug' | 'chore' | 'review' | 'regression';
// CLOSED, and it stays closed. A report Gabbar's stakeholder gate refused is NOT a state of this
// union — see the parked section at the bottom of this file for why adding one would undo the thing
// parking exists to guarantee.
export type FeedbackStatus =
  | 'pending' | 'triaged' | 'needs_clarification' | 'accepted' | 'in_progress' | 'resolved' | 'rejected';

export type Task = {
  _id?: ObjectId;
  projectId: ObjectId;
  shortId: string;
  parentTaskId: ObjectId | null;
  title: string;
  description: string;
  status: TaskStatus;
  type: TaskType;
  lane: string | null; // review lane key (qa, code-review, …) on pipeline-spawned tasks
  lanes?: string[] | null; // per-task review-lane subset; null/absent = all configured, [] = explicitly none
  assignee: string | null;
  assigneeType: 'agent' | 'human';
  origin: string | null;
  commits: string[];
  blocker: string | null;
  notes: string;
  // when the orchestrator handed this task to an agent. Dispatched and started are different facts:
  // only the agent can report the second, so this one is stamped server-side on the dispatch call and
  // cleared by any status change, i.e. the agent's own report always supersedes it. The board renders
  // it WITH ITS AGE, so a dispatch that never turns into in_progress reads as stale rather than as
  // work in flight — the field can go unset (nobody dispatched) but it cannot quietly go wrong.
  dispatchedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type SlackRef = { channel: string; ts: string; user: string };

// Evidence added to a row AFTER it was filed, and the reason this is a record rather than an edit.
//
// The row already has `attachments`, so nothing new was needed to hold the urls, and appending to
// that array is what puts an image where a human already looks. What was missing is the second
// half: WHO added it and WHEN. A body silently rewritten still carries its original author's name,
// so a later reader is shown somebody else's words under that name with no seam. So an append never
// touches a byte of what is already in the body — it adds an attributed line after it — and this
// array carries the same fact structurally, so a reader does not have to parse prose to know which
// part of a row is the original report and which part arrived later.
//
// Absent on every row filed before this existed, and that is the honest reading: no additions
// recorded, not "we lost them". Nothing is backfilled.
export type FeedbackAddition = {
  author: string;
  authorType: 'human' | 'agent';
  at: Date;
  /** what they said when they added it; may be empty when the evidence is the whole point */
  note: string;
  /**
   * the urls THIS PERSON ATTACHED, all of them. The row's own `attachments` is the deduped union,
   * so a url that was already there (or that a simultaneous append got in first) is listed here as
   * something they sent and is still stored exactly once up there. Two different questions: what
   * did this person add, and what evidence is on this row.
   */
  attachments: string[];
  /**
   * DAR-229. The caller's own name for THIS append, so a retry of a write whose answer never came
   * back cannot add the same words a second time. Matched within the row, which is why the key
   * itself does not have to name one: the same held addition sent to a DIFFERENT row is a different
   * scope and lands there properly.
   *
   * Absent on every addition made before this existed and on every caller that does not send one,
   * and an absent key never matches anything, so an unkeyed append behaves exactly as it always did.
   * That is the honest default: this route is not idempotent by nature, it is idempotent for callers
   * that say which write they are making.
   */
  idempotencyKey?: string;
};

export type FeedbackDoc = {
  _id?: ObjectId;
  projectId: ObjectId;
  taskId: ObjectId | null;
  taskShortId: string | null;
  shortId: string;
  author: string;
  authorType: 'human' | 'agent';
  type: 'bug' | 'design' | 'idea' | 'approval';
  body: string;
  attachments: string[];
  additions?: FeedbackAddition[];
  /**
   * DAR-229. The caller's own name for the write that CREATED this row, unique per project.
   *
   * A POST that times out or dies mid flight may have created the row anyway, so a client that
   * retries has no way to tell "it never landed" from "it landed and I never heard". Gabbar hit
   * exactly that: the api restarts several times a day to pick up shipped code, and each restart is
   * a few seconds in which every write fails, so the report of whoever was talking to Gabbar at that
   * moment was lost. It can be held and retried now, and this field is what makes retrying safe.
   *
   * Scoped to the project rather than global, deliberately. A model that files against one project
   * and then corrects itself to another is making two different writes and must still get two rows;
   * a retry of the same write against the same project is one write and must get one row.
   *
   * Absent on every row filed before this existed and on every caller that does not send one.
   */
  idempotencyKey?: string;
  slack: SlackRef | null;
  status: FeedbackStatus;
  resolution: string | null;
  resolvedTaskId: ObjectId | null;
  resolvedTaskShortId?: string;
  createdAt: Date;
  updatedAt: Date;
};

export type EventDoc = {
  _id?: ObjectId;
  projectId: ObjectId;
  taskId: ObjectId | null;
  text: string;
  at: Date;
};

// ---------- parked reports: held by Gabbar's gate, and NOT feedback ----------
// When the stakeholder gate refuses a report, Gabbar keeps the person's words on disk instead of
// dropping them: one JSON file per slack message under data/parked/, written by apps/gabbar/src/
// parked.ts and by nothing else. That directory is the whole store. There is no collection.
//
// Which is why FeedbackStatus above is not the place for this, however convenient it looks. A
// status is a FIELD OF A FEEDBACK ROW, so a 'parked' member means a document in the feedback
// collection with a <PREFIX>-FB-<n> id, and from that moment a refused report is quotable as
// feedback, countable in a triage queue, and one status PATCH away from being real. Three of the
// four defences parking relies on (its own id namespace, never touching Mongo, filed:false on
// every read) die in that one edit. So the type below is a PARALLEL shape with a PARK-* id: no
// reader of feedback can ever be handed one, because it is not that type.
//
// This mirrors summarize() in apps/gabbar/src/parked.ts, which is the shape the bot already hands
// its model. Two processes agree on one directory format; only Gabbar writes it, the server reads.
export const PARK_ID_PREFIX = 'PARK-';
// one bounded character class, no nesting, no alternation: linear on a match and on a failure
// alike. It is also the filename guard on the read side, so '/', '.' and '..' cannot appear in a
// value that gets joined onto a directory path.
export const PARK_ID_RE = /^PARK-[A-Za-z0-9_]+$/;
export function isParkId(s: unknown): boolean {
  return typeof s === 'string' && PARK_ID_RE.test(s.trim());
}

// status and cause are STRINGS, not unions, and that is deliberate. Gabbar owns those vocabularies
// (ParkedStatus / ParkCause) and its escalation work is still in review, so a union here would make
// this file the second place a new cause has to be added and would turn an unrecognised one into
// either a dropped field or a 400 on a read path. A reader that renders whatever it is handed
// cannot hide a held report because it did not recognise a word.
export type ParkedSummary = {
  parkId: string;
  /** literal false on every row, in every direction, exactly as Gabbar's own summarize() does */
  filed: false;
  parked: true;
  status: string; // parked | promoted | superseded
  /**
   * WHAT is held, which decides how it would be promoted and therefore what the board may say about
   * it. A `report` is promoted by filing a new feedback row; an `addition` is promoted by appending
   * to the row named in `appendTo`, and creates nothing. Describing the second one in report
   * language is the board telling a story that did not happen, so the distinction rides on the read.
   *
   * Unlike `status` and `cause` above this IS a union, because the parser does not pass it through:
   * it COLLAPSES anything that is not literally 'addition' to 'report', exactly as gabbar's own
   * reader does, so a file written before kinds existed reads as the report it is and no held item
   * can vanish for being an unrecognised word. The cost is stated rather than hidden: a THIRD kind
   * would render as a report until it is added here and to the collapse in api.ts.
   */
  kind: 'report' | 'addition';
  /** the feedback row an addition was meant to be added to (e.g. MRF-FB-23). Always null on a report. */
  appendTo: string | null;
  /**
   * false on an addition, null on a report, never true — the same field, for the same reason, as
   * gabbar's summarize(). `appendTo` is the only field on a held item that names a feedback id, and
   * a reader holding just that id could take it for a row this reached. Held means it did not.
   */
  addedToRow: false | null;
  author: string;
  authorSlackId: string;
  /** display name for the target: what Gabbar resolved, else what the reporter typed */
  project: string | null;
  /** the raw project reference, kept apart from the display name so a filter can match on it */
  projectRef: string | null;
  onTask: string | null;
  type: string;
  body: string;
  theirWords: string;
  /** their words are capped for transport; the file on disk is always the full record */
  theirWordsTruncated: boolean;
  attachments: string[];
  mediaNotes: string[];
  heldSince: string;
  cause: string;
  reasonParked: string;
  escalatedAt: string | null;
  lastAttemptAt: string | null;
  promotedTo: string | null;
};

// Shaped like the paged reads on GET /tasks, and for the same reason: `truncated` is the one word
// a caller checks before treating an answer as the whole set, so it means the same thing here —
// a boolean, with a note that says what was left out.
export type ParkedRead = {
  dir: string;
  dirPresent: boolean;
  /** a directory-level failure, verbatim: "none held" and "cannot look" must never read the same */
  error: string | null;
  /** PARK-* .json files in the directory: the true size of the parking lot, before any cap */
  files: number;
  /** .json files that are NOT PARK-* — somebody else's file, not a held report we lost */
  ignored: number;
  /** how many of those files were actually opened this call */
  scanned: number;
  /** scanned < files — this is NOT the whole parking lot */
  truncated: boolean;
  note?: string;
  /** scanned files that could not be read or parsed. A held report we cannot show is worse than none */
  unreadable: number;
  /** scanned rows belonging to the requested project, any status */
  inScope: number;
  /** of those, the ones still held: the number that means pending work */
  held: number;
  /** rows returned after the status filter */
  returned: number;
  items: ParkedSummary[];
};

// ---------- memory graph ----------
// DAR-274. Agent memory as a first-class store: nodes are entities (a decision, a gotcha, a
// person, a service, ...), edges are typed, bi-temporal relations between them, and episodes are
// provenance — the record of what write produced what. Schema borrowed from Graphiti (bi-temporal
// edges: validAt/invalidAt rather than a mutable "current" flag) and the MCP reference memory
// server (readable entity/observation shape: a node accumulates observations rather than being
// overwritten). NOTHING IS EVER DELETED: `supersede` stamps invalidAt on the thing it replaces and
// ADDS a new SUPERSEDES edge, so a superseded fact stays on the graph, invisible to an ordinary
// recall() but recoverable with asOf. There is no LLM anywhere in this write path — the caller
// names the entities and the relation, and the store just holds what it is told.
export type MemoryNodeType = 'decision' | 'gotcha' | 'person' | 'service' | 'repo' | 'project' | 'preference';

/** one thing observed about a node, appended (never overwritten) by remember() */
export type MemoryObservation = { text: string; at: Date; source: string };

export type MemoryNode = {
  _id?: ObjectId;
  name: string;
  /** lowercase-kebab of name, unique within a project (or within the global scope when project is null) */
  slug: string;
  type: MemoryNodeType;
  observations: MemoryObservation[];
  /** null = global/cross-project memory (a gotcha true of the whole machine, a person, ...) */
  project: ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * A common open vocabulary plus room for a caller-named relation — this is deliberately not a
 * closed union. SUPERSEDES is reserved: it is written only by POST /api/memory/supersede, never
 * accepted directly from remember()'s edges[].
 */
export type MemoryRelation = 'DECIDED_FOR' | 'BLOCKED_ON' | 'OWNS' | 'FIXES' | 'RELATES_TO' | 'SUPERSEDES' | (string & {});

export type MemoryEdgeSource = { session?: string; harness?: string; taskRef?: string };

export type MemoryEdge = {
  _id?: ObjectId;
  from: ObjectId;
  to: ObjectId;
  relation: MemoryRelation;
  /** when this edge became true. Set at write time and never moved */
  validAt: Date;
  /** null while the edge still holds; stamped by supersede() and never cleared again */
  invalidAt: Date | null;
  source: MemoryEdgeSource;
  /** 0-1; how sure the writer was */
  confidence: number;
};

export type MemoryEpisodeKind = 'handoff' | 'feedback' | 'session' | 'manual';

/** provenance for a write: what produced this node/edge, not the node/edge itself */
export type MemoryEpisode = {
  _id?: ObjectId;
  kind: MemoryEpisodeKind;
  /** what this episode is about — a node slug, an edge id, a task ref; free text, reader's choice */
  ref: string;
  at: Date;
  summary: string;
};

export const MEMORY_NODE_TYPES: MemoryNodeType[] = ['decision', 'gotcha', 'person', 'service', 'repo', 'project', 'preference'];

/** lowercase kebab of a name, the slug every node is deduped on within its project scope */
export function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
