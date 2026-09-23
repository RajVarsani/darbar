// DAR-266. The server mirrors linear-native projects (linearUrl set, not archived) to Linear, so every
// agent keeps writing only to darbar and none of them needs to know Linear exists.
//
// DESIGN (the decisions, in one place; docs/linear-sync.md has the operator view)
//
// Scope. Only rows with type !== 'review' and no parent are mirrored: review children and helper
//   sub-rows are darbar's own orchestration and would be noise on a board colleagues read. Feedback
//   rows are never issues; a PROMOTION (resolvedTaskRef) posts the report as a comment on the issue
//   of the task it was promoted to.
// Scope guard. Every write goes to an issue carrying this project's darbar/<PREFIX> label (a child
//   of the "darbar" group; its Linear name is just <PREFIX>). The issue is read before any update or
//   comment, and an issue without the label is refused and the row records why. Inbound only reads
//   issues the label filter returned, and re-checks the label on each.
// Idempotency. The issue uuid is generated here and stored on the row BEFORE the create call, and
//   sent as the issue id. A retry after an unknown outcome first looks that id up and adopts it, so
//   one row can never become two issues. Comments work the same way (each outbox item has its uuid).
// Merge, not echo-skipping. Each row stores the last-synced value of title/description/status on
//   BOTH sides (`base` = darbar's, `remote` = Linear's). A field changed only here is pushed, changed
//   only there is pulled, changed on both sides to different values goes to the newer side
//   (row.updatedAt vs issue.updatedAt). Our own write coming back on the poll therefore changes
//   nothing, because after it both sides equal their bases; and inbound writes never call the
//   outbound hooks. That is the whole loop-prevention story, and it cannot lose a colleague's edit
//   the way an "ignore updatedAt I wrote" rule can when their edit lands next to ours.
// Gates. A pulled status is never written straight to the row: it goes through transitionTask, the
//   same function PATCH /tasks/:ref runs, so an inbound in_review spawns the selected lanes and an
//   inbound done meets the done-gate. A refused status is HELD (linear.held says what Linear wants and
//   why not), the row stays put and Linear is not flipped back, so the two never fight. Every pulled
//   write carries the updatedAt the pass read, so it cannot land over a darbar edit made meanwhile.
// Failure. Linear never fails a darbar write: hooks enqueue and return. An error is recorded on the
//   row (linear.error) and the poll retries every row that is dirty, errored, uncreated or has an
//   outbox, with exponential backoff (linear.retryAt) and a give-up after MAX_FAILURES that keeps
//   the error on the row. A darbar edit (hook) always gets a fresh pass.
// Backfill. The first poll pulls every labelled issue. An issue with no linked row is matched to an
//   unlinked row that NAMES it (origin linear:<ID>, or an explicit "mirrored as <ID>" / "linear:
//   <ID>" marker; a passing mention is not a link), else to the one legacy row (created before the
//   project's sync started) whose title equals it case-insensitively, else it becomes a new row. An
//   ambiguous match links nothing. Matched rows then take Linear's title and status through the
//   normal pass (so through the gates) and keep their own description. An issue that could not be
//   linked stays in linearSync.pending and is retried from its snapshot, so the cursor never drops it.
//   Rows created BEFORE the project's sync first ran (per project, reset when linearUrl changes) are
//   never pushed out.
// Notes. Each notes change posts only what was appended; a rewrite posts the new text once.
// Counts. Backfilled rows are ordinary rows: completed -> done, canceled/duplicate -> cancelled,
//   backlog/triage -> backlog, so the board header (which excludes backlog and cancelled) and the
//   console card count them the same way as native rows.
import { Projects, Tasks, Feedback, nextShortId, config } from '@darbar/core';
import type { ObjectId, Project, Task, TaskStatus, LinearLink, LinearProjectSync, LinearOutboxItem, LinearSideLocal, LinearSideRemote } from '@darbar/core';
import { graphqlLinearClient } from './linear';
import type { LinearClient, LinearIssue, LinearState, IssueUpdateInput } from './linear';

export const DARBAR_LABEL_GROUP_ID = '8aee3bbe-f165-4507-8438-660f7f03ab55';

export type InboundResult =
  | { ok: true; after: Task }
  | { ok: false; kind: 'gate' | 'round' | 'race'; error: string };
type Hooks = {
  logEvent(projectId: ObjectId, text: string, taskId?: ObjectId | null): Promise<void>;
  /** api.ts transitionTask: the PATCH route's gates, write and pipeline hooks, for a pulled change */
  transition(t: Task, set: Record<string, unknown>, opts: { guard: Record<string, unknown>; via: string }): Promise<InboundResult>;
};
let hooks: Hooks = {
  logEvent: async () => {},
  transition: async () => { throw new Error('linear sync: transition hook not configured'); },
};
export function configureLinearHooks(h: Hooks) { hooks = h; }

let client: LinearClient | null = null;
const stateCache = new Map<string, LinearState[]>();

/** null turns the mirror off (every hook a no-op). Tests inject a stub here. */
export function setLinearClient(c: LinearClient | null) {
  client = c;
  stateCache.clear();
}

export const MAX_FAILURES = 5;
const RETRY_BASE_MS = 60_000;
export const linearEnabled = () => client !== null;

// ---------- status mapping, by Linear state type ----------
const byPos = (a: LinearState, b: LinearState) => a.position - b.position;
function firstOf(states: LinearState[], type: string, name?: RegExp): LinearState | null {
  const of = states.filter((s) => s.type === type).sort(byPos);
  return (name && of.find((s) => name.test(s.name))) || (name ? null : of[0] ?? null);
}
/** the Linear state a darbar status maps to; null = no equivalent (leave Linear's state alone) */
export function outboundStateId(status: TaskStatus, states: LinearState[]): string | null {
  const pick = (type: string, name?: RegExp) => (name ? firstOf(states, type, name) ?? firstOf(states, type) : firstOf(states, type))?.id ?? null;
  switch (status) {
    case 'backlog': return pick('backlog') ?? pick('unstarted');
    case 'todo': return firstOf(states, 'unstarted', /^to ?do$/i)?.id ?? firstOf(states.filter((s) => !/block/i.test(s.name)), 'unstarted')?.id ?? null;
    case 'in_progress': return pick('started', /progress/i);
    case 'in_review': case 'qa': return pick('started', /review/i);
    case 'blocked': return states.find((s) => /block/i.test(s.name))?.id ?? null;
    case 'done': return pick('completed');
    case 'cancelled': return pick('canceled');
  }
}
export function inboundStatus(state: Pick<LinearState, 'type' | 'name'>): TaskStatus {
  if (/block/i.test(state.name)) return 'blocked';
  switch (state.type) {
    case 'completed': return 'done';
    case 'canceled': case 'duplicate': return 'cancelled';
    case 'started': return /review/i.test(state.name) ? 'in_review' : 'in_progress';
    case 'unstarted': return 'todo';
    default: return 'backlog'; // backlog, triage
  }
}

/** where the team comes from: /team/<KEY>/… names it, /project/<slug>-<slugId> names a project */
export function linearRefFromUrl(url: string): { teamKey: string } | { projectSlugId: string } | null {
  let u: URL; try { u = new URL(url); } catch { return null; }
  const seg = u.pathname.split('/').filter(Boolean);
  const team = seg[seg.indexOf('team') + 1];
  if (seg.includes('team') && team) return { teamKey: team };
  const slug = seg[seg.indexOf('project') + 1];
  if (seg.includes('project') && slug) { return { projectSlugId: slug.slice(slug.lastIndexOf('-') + 1) }; }
  return null;
}

// ---------- per-key serial queue: one row is never pushed and pulled at the same time ----------
const queues = new Map<string, Promise<unknown>>();
function enqueue<T>(key: string, fn: () => Promise<T>): Promise<T | undefined> {
  const run = (queues.get(key) ?? Promise.resolve()).then(fn).catch((e) => {
    console.error(`linear sync ${key}: ${String(e)}`);
    return undefined;
  });
  const tail = run.finally(() => { if (queues.get(key) === tail) queues.delete(key); });
  queues.set(key, tail);
  return run;
}
/** resolves once every queued sync job has finished (tests, and a clean shutdown) */
export async function flushLinear() {
  while (queues.size) await Promise.all([...queues.values()]);
}

// ---------- project context ----------
type Ctx = { p: Project; sync: LinearProjectSync; states: LinearState[] };
const loggedProjectErr = new Map<string, string>();

async function resolveProject(p: Project, openedAt: Date): Promise<LinearProjectSync> {
  const c = client!;
  const ref = linearRefFromUrl(p.linearUrl!);
  if (!ref) throw new Error(`cannot find a team in linearUrl ${p.linearUrl}; use a /team/<KEY>/… or /project/<slug> link`);
  let teamId: string, linearProjectId: string | null = null;
  if ('teamKey' in ref) {
    const t = await c.teamByKey(ref.teamKey);
    if (!t) throw new Error(`no Linear team with key ${ref.teamKey}`);
    teamId = t.id;
  } else {
    const lp = await c.projectBySlugId(ref.projectSlugId);
    if (!lp) throw new Error(`no Linear project ${ref.projectSlugId}`);
    if (lp.teamIds.length !== 1) throw new Error(`Linear project ${ref.projectSlugId} spans ${lp.teamIds.length} teams; point linearUrl at /team/<KEY>/… instead`);
    teamId = lp.teamIds[0]!; linearProjectId = lp.id;
  }
  // the group child first; a flat "darbar/<PREFIX>" label made by hand before the group existed
  // (MONO has only that) is adopted rather than shadowed by a new child nobody's issues carry
  const found = (await c.findChildLabel(DARBAR_LABEL_GROUP_ID, p.prefix)) ?? (await c.findLabelByName(`darbar/${p.prefix}`));
  const labelId = found?.id ?? (await c.createChildLabel({
    parentId: DARBAR_LABEL_GROUP_ID, name: p.prefix, teamId: await c.labelTeam(DARBAR_LABEL_GROUP_ID),
  })).id;
  // a first run, or a changed linearUrl (the PATCH route also drops linearSync then): the mirror
  // starts NOW for this project, so every row filed before it is legacy and never pushed
  return { resolvedFrom: p.linearUrl!, teamId, linearProjectId, labelId, startedAt: openedAt, cursor: null, pending: [], lastRunAt: null, lastError: null };
}

const resolving = new Map<string, Promise<LinearProjectSync>>();
/** openedAt: when the sync starts if this call is the project's first (a new row's own createdAt, so
 *  the row whose creation opened the mirror is not itself legacy; otherwise now) */
async function projectCtx(p: Project | null, fresh = false, openedAt = new Date()): Promise<Ctx | null> {
  if (!client || !p || !p.linearUrl || p.archivedAt) return null;
  let sync = p.linearSync;
  if (!sync || sync.resolvedFrom !== p.linearUrl) {
    const key = p._id!.toHexString();
    // two hooks racing on a project's first sync must not both create the label
    let pr = resolving.get(key);
    if (!pr) {
      pr = resolveProject(p, openedAt).finally(() => resolving.delete(key));
      resolving.set(key, pr);
    }
    sync = await pr;
    await Projects.updateOne({ _id: p._id }, { $set: { linearSync: sync } });
  }
  let states = stateCache.get(sync.teamId);
  if (!states || fresh) { states = await client.workflowStates(sync.teamId); stateCache.set(sync.teamId, states); }
  return { p: { ...p, linearSync: sync }, sync, states };
}

const mirrorable = (t: Task) => t.type !== 'review' && !t.parentTaskId;

// ---------- the one sync pass for one row, both directions ----------
type Fields = LinearSideLocal;
type Remote = LinearSideRemote;
type Link = LinearLink;
const remoteOf = (i: LinearIssue): Remote => ({ title: i.title, description: i.description ?? '', stateId: i.stateId });
const localOf = (t: Task): Fields => ({ title: t.title, description: t.description, status: t.status });

function newLink(id: string, outbox: LinearOutboxItem[] = []): Link {
  return { id, created: false, identifier: null, url: null, attempts: 0, seenUpdatedAt: null, dirty: true, outbox, error: null, errorAt: null };
}

async function recordError(taskId: ObjectId, e: unknown) {
  const cur = await Tasks.findOne({ _id: taskId }, { projection: { linear: 1 } });
  if (!cur?.linear) return;
  const failures = (cur.linear.failures ?? 0) + 1;
  const gaveUp = failures >= MAX_FAILURES;
  await Tasks.updateOne({ _id: taskId, linear: { $exists: true } }, {
    $set: {
      'linear.error': String(e instanceof Error ? e.message : e), 'linear.errorAt': new Date(), 'linear.dirty': true,
      'linear.failures': failures, 'linear.gaveUp': gaveUp,
      'linear.retryAt': gaveUp ? null : new Date(Date.now() + RETRY_BASE_MS * 2 ** (failures - 1)),
    },
  });
}

/** three-way merge of one row against its issue. Exported for the unit tests of the rule itself. */
export function mergeRow(t: Task, issue: LinearIssue, base: Fields, remote: Remote, states: LinearState[]) {
  const push: IssueUpdateInput = {};
  const pull: Partial<Fields> = {};
  const localNewer = t.updatedAt.getTime() > Date.parse(issue.updatedAt);
  for (const k of ['title', 'description'] as const) {
    const mine = t[k], theirs = k === 'description' ? issue.description ?? '' : issue[k];
    const l = mine !== base[k], r = theirs !== remote[k];
    if (mine === theirs) continue;
    if (l && (!r || localNewer)) push[k] = mine;
    else if (r) pull[k] = theirs;
  }
  const want = outboundStateId(t.status, states);
  const equivalent = want === issue.stateId;
  if (!equivalent) {
    const l = t.status !== base.status && want !== null;
    const r = issue.stateId !== remote.stateId;
    if (l && (!r || localNewer)) push.stateId = want!;
    else if (r) {
      const st = states.find((s) => s.id === issue.stateId);
      const next = inboundStatus(st ?? { type: issue.stateType, name: '' });
      if (next !== t.status) pull.status = next;
    }
  }
  return { push, pull };
}

type RowOpts = { hint?: LinearIssue; created?: boolean };

async function syncRow(taskId: ObjectId, opts: RowOpts = {}): Promise<void> {
  const c = client; if (!c) return;
  let t = await Tasks.findOne({ _id: taskId });
  if (!t || !mirrorable(t)) return;
  let ctx: Ctx | null;
  try {
    ctx = await projectCtx(await Projects.findOne({ _id: t.projectId }), false, opts.created ? t.createdAt : new Date());
  } catch (e) { await recordError(taskId, e); return; }
  if (!ctx) return;
  const { sync, states } = ctx;
  if (!t.linear) {
    if (t.createdAt < sync.startedAt) return; // legacy row: only the backfill match links it
    const outbox: LinearOutboxItem[] = t.notes.trim() ? [{ id: crypto.randomUUID(), body: notesComment(t.notes) }] : [];
    // the reservation: the uuid is on the row before Linear ever hears of it
    await Tasks.updateOne({ _id: taskId, linear: { $exists: false } }, { $set: { linear: newLink(crypto.randomUUID(), outbox) } });
    t = (await Tasks.findOne({ _id: taskId }))!;
  }
  let link = t.linear as Link;
  try {
    let issue: LinearIssue | null;
    let base = link.base, remote = link.remote;
    if (!link.created) {
      const retry = link.attempts > 0;
      await Tasks.updateOne({ _id: taskId }, { $inc: { 'linear.attempts': 1 } });
      issue = retry ? await c.getIssue(link.id) : null;
      if (issue) {
        // adopted after an unknown outcome: whatever the row says now is what darbar wants there
        const st = states.find((x) => x.id === issue!.stateId);
        base = { title: issue.title, description: issue.description ?? '', status: inboundStatus(st ?? { type: issue.stateType, name: '' }) };
        remote = remoteOf(issue);
      } else {
        issue = await c.createIssue({
          id: link.id, teamId: sync.teamId, projectId: sync.linearProjectId, title: t.title, description: t.description,
          stateId: outboundStateId(t.status, states), labelIds: [sync.labelId],
        });
        base = localOf(t); remote = remoteOf(issue);
      }
      await Tasks.updateOne({ _id: taskId }, { $set: { 'linear.created': true, 'linear.identifier': issue.identifier, 'linear.url': issue.url } });
      await hooks.logEvent(t.projectId, `${t.shortId} mirrored to Linear as ${issue.identifier}`, taskId);
    } else {
      const hint = opts.hint;
      // a snapshot older than what this row already saw would undo newer state: fetch instead
      issue = hint && !(link.seenUpdatedAt && Date.parse(hint.updatedAt) < Date.parse(link.seenUpdatedAt)) ? hint : await c.getIssue(link.id);
      if (!issue) throw new Error(`Linear issue ${link.identifier ?? link.id} not found (deleted, archived, or not visible to the key); not writing`);
    }
    if (!issue.labelIds.includes(sync.labelId)) {
      throw new Error(`scope guard: ${issue.identifier} does not carry darbar/${ctx.p.prefix}; not writing to it`);
    }
    // a row linked before the merge fields existed takes both sides as they stand now
    base ??= localOf(t); remote ??= remoteOf(issue);
    const { push, pull } = mergeRow(t, issue, base, remote, states);
    // a status the gates refused earlier is asked for again while Linear still says it
    const held = link.held && issue.stateId === link.held.stateId && t.status !== link.held.status ? link.held : null;
    if (held && push.stateId === undefined && pull.status === undefined) pull.status = held.status;
    if (Object.keys(push).length) issue = await c.updateIssue(issue.id, push);

    // ---- the pull, through the same transition as a darbar PATCH, guarded on the updatedAt we read ----
    const applied: Partial<Fields> = {};
    let stale = false;
    let holdNow: Link['held'] = null;
    let expected = t.updatedAt;
    if (Object.keys(pull).length) {
      const via = `Linear ${issue.identifier}`;
      let r = await hooks.transition(t, { ...pull }, { guard: { updatedAt: t.updatedAt }, via });
      if (!r.ok && r.kind !== 'race' && pull.status !== undefined) {
        holdNow = { status: pull.status, stateId: issue.stateId, reason: r.error, at: new Date() };
        const { status: _held, ...rest } = pull;
        r = Object.keys(rest).length ? await hooks.transition(t, rest, { guard: { updatedAt: t.updatedAt }, via }) : { ok: true, after: t };
        if (r.ok) Object.assign(applied, rest);
      } else if (r.ok) Object.assign(applied, pull);
      if (!r.ok) stale = true; // a darbar edit landed first; nothing pulled, the next pass merges again
      else expected = r.after.updatedAt;
      if (holdNow && !(link.held && link.held.stateId === holdNow.stateId && link.held.status === holdNow.status)) {
        await hooks.logEvent(t.projectId, `${t.shortId}: Linear ${issue.identifier} says ${holdNow.status}, held by the gate (${holdNow.reason})`, taskId);
      }
    }
    // ---- bookkeeping, per field: synced = pushed, agreed or applied; a field not applied keeps its old base ----
    const cur = remoteOf(issue);
    const nb: Fields = { ...base }, nr: Remote = { ...remote };
    for (const k of ['title', 'description'] as const) {
      if (k in pull && !(k in applied)) continue;
      nb[k] = k in applied ? applied[k]! : t[k]; nr[k] = cur[k];
    }
    if (!('status' in pull) || 'status' in applied || holdNow) {
      // a held status is SEEN (remote moves on) but not taken (base keeps darbar's), so no fight
      nb.status = applied.status ?? t.status; nr.stateId = cur.stateId;
    }
    const keep = holdNow ?? (held && !('status' in applied) ? held : null);
    const set: Record<string, unknown> = {
      'linear.base': nb, 'linear.remote': nr, 'linear.seenUpdatedAt': issue.updatedAt,
      'linear.identifier': issue.identifier, 'linear.url': issue.url, 'linear.error': null, 'linear.errorAt': null,
      'linear.failures': 0, 'linear.retryAt': null, 'linear.gaveUp': false, 'linear.held': keep,
    };
    // dirty clears only if the row is still the one this pass read (or wrote): a darbar edit made
    // meanwhile has queued its own pass, and must also survive a restart
    const mine = await Tasks.updateOne({ _id: taskId, updatedAt: expected }, { $set: { ...set, 'linear.dirty': stale } });
    if (!mine.matchedCount) await Tasks.updateOne({ _id: taskId }, { $set: { ...set, 'linear.dirty': true } });
    await drainOutbox(taskId, issue.id);
  } catch (e) {
    await recordError(taskId, e);
  }
}

async function drainOutbox(taskId: ObjectId, issueId: string) {
  const c = client!;
  const t = await Tasks.findOne({ _id: taskId });
  for (const item of t?.linear?.outbox ?? []) {
    // a tried item may already have landed with its uuid; look before posting it again
    const landed = item.tried ? await c.commentExists(item.id) : false;
    if (!landed) {
      await Tasks.updateOne({ _id: taskId, 'linear.outbox.id': item.id }, { $set: { 'linear.outbox.$.tried': true } });
      const r = await c.createComment({ id: item.id, issueId, body: item.body });
      if (r.issueUpdatedAt) await Tasks.updateOne({ _id: taskId }, { $set: { 'linear.seenUpdatedAt': r.issueUpdatedAt } });
    }
    await Tasks.updateOne({ _id: taskId }, { $pull: { 'linear.outbox': { id: item.id } } });
  }
}

const notesComment = (notes: string) => `**darbar notes**\n\n${notes}`;
/** what a notes change adds to the issue: the appended tail, or the whole text once when it was rewritten */
export function notesDelta(prev: string, next: string): string | null {
  if (next === prev || !next.trim()) return null;
  if (next.startsWith(prev)) return next.slice(prev.length).trim() || null;
  return `(notes rewritten)\n\n${next}`;
}

// ---------- hooks api.ts calls after its own write has landed ----------
// Each returns fast: at most one local mongo write (so a comment is durable before anything goes to
// the network), then the network half runs on the row's queue. None of them can throw into a route.
async function queueComment(taskId: ObjectId, body: string) {
  // only onto a row that is already linked; an unlinked row gets its notes at creation
  await Tasks.updateOne({ _id: taskId, linear: { $exists: true } }, {
    $push: { 'linear.outbox': { id: crypto.randomUUID(), body } }, $set: { 'linear.dirty': true },
  });
}

export async function taskCreated(taskId: ObjectId | undefined) {
  if (!client || !taskId) return;
  void enqueue(taskId.toHexString(), () => syncRow(taskId, { created: true }));
}

export async function taskUpdated(taskId: ObjectId | undefined, change: { fields: string[]; notes?: string; prevNotes?: string; commit?: string }) {
  if (!client || !taskId) return;
  try {
    if (change.fields.some((f) => f === 'title' || f === 'description' || f === 'status')) {
      await Tasks.updateOne({ _id: taskId, linear: { $exists: true } }, { $set: { 'linear.dirty': true } });
    }
    const delta = change.notes !== undefined ? notesDelta(change.prevNotes ?? '', change.notes) : null;
    if (delta) await queueComment(taskId, notesComment(delta));
    if (change.commit) await queueComment(taskId, `**commit** \`${change.commit}\``);
  } catch (e) { console.error(`linear sync hook: ${String(e)}`); }
  void enqueue(taskId.toHexString(), () => syncRow(taskId));
}

export async function feedbackPromoted(feedbackId: ObjectId | undefined, taskId: ObjectId) {
  if (!client || !feedbackId) return;
  try {
    const fb = await Feedback.findOne({ _id: feedbackId });
    if (!fb) return;
    const files = fb.attachments.length ? `\n\n${fb.attachments.map((a) => `- ${a}`).join('\n')}` : '';
    await queueComment(taskId, `**${fb.shortId}** (${fb.type}) from ${fb.author}\n\n${fb.body}${files}`);
  } catch (e) { console.error(`linear sync hook: ${String(e)}`); }
  void enqueue(taskId.toHexString(), () => syncRow(taskId));
}

// ---------- inbound ----------
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** the row itself says it IS this issue: its origin, or an explicit marker. A passing mention
 *  ("blocked on MEE-145", "carried to MEE-48") is not a link. */
export function namesIssue(t: Pick<Task, 'origin' | 'title' | 'description' | 'notes'>, identifier: string): boolean {
  if (t.origin === `linear:${identifier}`) return true;
  const marker = new RegExp(`(?:mirrored as|linear:)\\s*${esc(identifier)}(?![\\w-])`, 'i');
  return marker.test(`${t.title}\n${t.description}\n${t.notes}`);
}
const sameTitle = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

type LinkResult = { ok: true } | { ok: false; error: string; ambiguous?: boolean };

async function linkIssue(ctx: Ctx, issue: LinearIssue): Promise<LinkResult> {
  const pid = ctx.p._id!;
  if (await Tasks.findOne({ projectId: pid, 'linear.id': issue.id }, { projection: { _id: 1 } })) return { ok: true };
  const unlinked = await Tasks.find({ projectId: pid, linear: { $exists: false }, type: { $ne: 'review' }, parentTaskId: null }).toArray();
  const named = unlinked.filter((t) => namesIssue(t, issue.identifier));
  // title only among legacy rows: a newer unlinked row is about to get its own issue
  const titled = named.length ? [] : unlinked.filter((t) => t.createdAt < ctx.sync.startedAt && sameTitle(t.title, issue.title));
  const match = named.length ? named : titled;
  if (match.length > 1) {
    return { ok: false, ambiguous: true, error: `${issue.identifier} matches ${match.map((t) => t.shortId).join(', ')}; put "mirrored as ${issue.identifier}" in the right row's notes` };
  }
  const t = match[0];
  if (t) {
    // linked as it stands; `remote` is left unseen for title and status so the ordinary pass pulls
    // Linear's (the board of record) through the gates. The description stays the row's own.
    const r = await Tasks.updateOne({ _id: t._id, linear: { $exists: false } }, {
      $set: {
        linear: {
          ...newLink(issue.id), created: true, dirty: true, identifier: issue.identifier, url: issue.url,
          base: localOf(t), remote: { title: '', description: issue.description ?? '', stateId: '' },
        } satisfies Link,
      },
    });
    if (!r.matchedCount) return { ok: false, error: `${t.shortId} was linked elsewhere while ${issue.identifier} was being matched` };
    await hooks.logEvent(pid, `${t.shortId} linked to Linear ${issue.identifier} by ${named.length ? 'its marker' : 'title'} (was "${t.title}", ${t.status})`, t._id);
    await enqueue(t._id!.toHexString(), () => syncRow(t._id!, { hint: issue }));
    return { ok: true };
  }
  // a new row, filed at backlog; the pass below then moves it to Linear's status like any other pull
  const now = new Date();
  const description = issue.description ?? '';
  const doc: Task = {
    projectId: pid, shortId: await nextShortId(pid, 'task'), parentTaskId: null,
    title: issue.title, description, status: 'backlog', type: 'feature', lane: null, lanes: null,
    assignee: null, assigneeType: 'human', origin: `linear:${issue.identifier}`, commits: [], blocker: null, notes: '',
    dispatchedAt: null, createdAt: now, updatedAt: now,
    linear: {
      ...newLink(issue.id), created: true, dirty: true, identifier: issue.identifier, url: issue.url,
      base: { title: issue.title, description, status: 'backlog' }, remote: { title: issue.title, description, stateId: '' },
    },
  };
  await Tasks.insertOne(doc);
  await hooks.logEvent(pid, `${doc.shortId} created from Linear ${issue.identifier}: ${doc.title}`, doc._id);
  await enqueue(doc._id!.toHexString(), () => syncRow(doc._id!, { hint: issue }));
  return { ok: true };
}

async function tryLink(ctx: Ctx, issue: LinearIssue): Promise<LinkResult> {
  const r = await enqueue(`issue:${issue.id}`, async (): Promise<LinkResult> => {
    try { return await linkIssue(ctx, issue); } catch (e) { return { ok: false, error: String(e instanceof Error ? e.message : e) }; }
  });
  return r ?? { ok: false, error: 'link failed' };
}

async function pollProject(p: Project) {
  const ctx = await projectCtx(p, true);
  if (!ctx) return;
  const c = client!;
  const pid = p._id!;
  let cursor = ctx.sync.cursor;
  let after: string | null = null;
  const pending = new Map((ctx.sync.pending ?? []).map((x) => [x.issue.id, x]));
  const seen = new Set<string>();
  const unlinked = (issue: LinearIssue, r: LinkResult) => {
    if (r.ok) { pending.delete(issue.id); return; }
    const prev = pending.get(issue.id);
    const attempts = (prev?.attempts ?? 0) + (r.ambiguous ? 0 : 1);
    pending.set(issue.id, { issue, attempts, error: r.error, gaveUp: attempts >= MAX_FAILURES });
  };
  for (;;) {
    const page = await c.listLabelledIssues(ctx.sync.labelId, ctx.sync.cursor, after);
    for (const issue of page.issues) {
      if (!issue.labelIds.includes(ctx.sync.labelId)) continue; // never trust the filter alone
      seen.add(issue.id);
      const row = await Tasks.findOne({ projectId: pid, 'linear.id': issue.id }, { projection: { _id: 1 } });
      if (row) await enqueue(row._id.toHexString(), () => syncRow(row._id, { hint: issue }));
      else unlinked(issue, await tryLink(ctx, issue));
      if (!cursor || Date.parse(issue.updatedAt) > Date.parse(cursor)) cursor = issue.updatedAt;
    }
    if (!page.hasNextPage || !page.endCursor) break;
    after = page.endCursor;
  }
  // issues an earlier poll could not link: retried from their snapshot (no Linear call), since the
  // cursor has moved past them; a fresher copy on this poll's pages already took their place
  for (const x of [...pending.values()]) {
    if (seen.has(x.issue.id) || x.gaveUp) continue;
    unlinked(x.issue as LinearIssue, await tryLink(ctx, x.issue as LinearIssue));
  }
  // outbound retry: anything a hook left unfinished, and rows a hook never saw (process died),
  // except rows backing off after a failure or given up on (their error stays on the row)
  const now = new Date();
  const retry = await Tasks.find({
    projectId: pid, type: { $ne: 'review' }, parentTaskId: null,
    'linear.gaveUp': { $ne: true },
    $and: [
      { $or: [{ 'linear.retryAt': null }, { 'linear.retryAt': { $lte: now } }] },
      { $or: [
        { 'linear.dirty': true }, { 'linear.created': false }, { 'linear.error': { $ne: null, $exists: true } },
        { 'linear.outbox.0': { $exists: true } },
        { linear: { $exists: false }, createdAt: { $gte: ctx.sync.startedAt } },
      ] },
    ],
  }, { projection: { _id: 1 } }).toArray();
  for (const r of retry) await enqueue(r._id.toHexString(), () => syncRow(r._id));
  await Projects.updateOne({ _id: pid }, { $set: {
    'linearSync.cursor': cursor, 'linearSync.pending': [...pending.values()], 'linearSync.lastRunAt': new Date(), 'linearSync.lastError': null,
  } });
}

let polling = false;
/** one pass over every active linear-native project. Never throws. */
export async function pollOnce() {
  if (!client || polling) return;
  polling = true;
  try {
    const projects = await Projects.find({ linearUrl: { $type: 'string' }, archivedAt: null }).toArray();
    for (const p of projects) {
      try {
        await pollProject(p);
        loggedProjectErr.delete(p.prefix);
      } catch (e) {
        const msg = String(e instanceof Error ? e.message : e);
        await Projects.updateOne({ _id: p._id, linearSync: { $exists: true } }, { $set: { 'linearSync.lastError': msg } });
        if (loggedProjectErr.get(p.prefix) !== msg) console.error(`linear sync ${p.prefix}: ${msg}`);
        loggedProjectErr.set(p.prefix, msg);
      }
    }
  } finally {
    polling = false;
  }
}

/** boot: off with one log line when there is no key, otherwise an in-process poll timer */
export function startLinearSync(apiKey = config.linearApiKey, log: (s: string) => void = console.log): () => void {
  if (!apiKey) {
    log('linear sync off: LINEAR_API_KEY is not set, linear-native projects are not mirrored');
    return () => {};
  }
  setLinearClient(graphqlLinearClient(apiKey, { url: config.linearApiUrl }));
  log(`linear sync on: polling every ${Math.round(config.linearPollMs / 1000)}s`);
  const tick = () => { void pollOnce(); };
  const first = setTimeout(tick, 5_000);
  const every = setInterval(tick, config.linearPollMs);
  return () => { clearTimeout(first); clearInterval(every); setLinearClient(null); };
}
