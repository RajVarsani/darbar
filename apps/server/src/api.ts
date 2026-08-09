import { Hono } from 'hono';
import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { Projects, Tasks, Feedback, Events, ObjectId, capId, nextShortId } from '@darbar/core';
import { emit, subscribe } from './sse';
import { config } from '@darbar/core';
import type { FeedbackDoc, Pipeline, ProjectAgent, Task, TaskStatus, TaskType, FeedbackStatus } from '@darbar/core';

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
  if (p) emit(p.capId, { kind: 'event', text });
}

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
  o.reviews.forEach((r, i) => {
    if (!r || typeof r !== 'object' || Array.isArray(r)) { errs.push(`pipeline.reviews[${i}]: not an object`); return; }
    const { lane, label, manager } = r as Record<string, unknown>;
    const bad: string[] = [];
    if (typeof lane !== 'string' || !lane) bad.push('lane (non-empty string) required');
    if (typeof manager !== 'string' || !manager) bad.push('manager (non-empty string) required');
    if (label !== undefined && typeof label !== 'string') bad.push('label must be a string when present');
    if (bad.length) { errs.push(`pipeline.reviews[${i}]: ${bad.join('; ')}`); return; }
    reviews.push({ lane: lane as string, label: typeof label === 'string' && label ? label : (lane as string), manager: manager as string });
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
  const seen = new Set<string>();
  v.forEach((r, i) => {
    if (!r || typeof r !== 'object' || Array.isArray(r)) { errs.push(`agents[${i}]: not an object`); return; }
    const { name, kind, brief, trigger } = r as Record<string, unknown>;
    const bad: string[] = [];
    if (typeof name !== 'string' || !name) bad.push('name (non-empty string) required');
    if (typeof kind !== 'string' || !AGENT_KINDS.includes(kind as ProjectAgent['kind'])) bad.push(`kind must be ${AGENT_KINDS.join('|')}`);
    if (typeof brief !== 'string' || !brief) bad.push('brief (non-empty string) required');
    if (trigger !== undefined && typeof trigger !== 'string') bad.push('trigger must be a string when present');
    if (bad.length) { errs.push(`agents[${i}]: ${bad.join('; ')}`); return; }
    // name is the assignment/lookup key: a duplicate makes every name-based lookup ambiguous
    if (seen.has(name as string)) { errs.push(`agents[${i}]: duplicate name ${name}`); return; }
    seen.add(name as string);
    agents.push({ name: name as string, kind: kind as ProjectAgent['kind'], brief: brief as string, ...(typeof trigger === 'string' ? { trigger } : {}) });
  });
  return errs.length ? { error: errs.join(' | ') } : { agents };
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
  await Tasks.updateOne({ _id: parentId }, { $set: { status: 'done', updatedAt: new Date() } });
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
  for (const fb of rows) {
    await Feedback.updateOne({ _id: fb._id }, { $set: { status: 'resolved', resolution, updatedAt: new Date() } });
    await logEvent(fb.projectId, `${fb.shortId} auto-resolved: ${task.shortId} shipped`, fb.taskId);
    await slackThreadReply(fb, `*${fb.shortId} resolved.* ${resolution}`.trim());
  }
  // rows just resolved may have been the last hold on the task they were FILED ON
  const filedOn = new Map(rows.filter((fb) => fb.taskId).map((fb) => [fb.taskId!.toHexString(), fb.taskId!]));
  for (const id of filedOn.values()) await maybeAdvanceParent(id);
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
  const doc = {
    name,
    prefix: prefix.toUpperCase(),
    capId: capId(),
    repos: strArr(b.repos),
    charter: str(b.charter) ?? '',
    stakeholders: Array.isArray(b.stakeholders) ? b.stakeholders : [],
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
  await logEvent((doc as { _id?: ObjectId })._id!, `project created: ${doc.name}`);
  return c.json({ ...doc, boardUrl: `${config.baseUrl}/p/${doc.capId}` });
});

api.get('/projects', async (c) => {
  const list = await Projects.find({}, { projection: { charter: 0 } }).sort({ createdAt: -1 }).toArray();
  const withCounts = await Promise.all(list.map(async (p) => {
    const [tasks, done, pendingFb] = await Promise.all([
      Tasks.countDocuments({ projectId: p._id }),
      Tasks.countDocuments({ projectId: p._id, status: 'done' }),
      Feedback.countDocuments({ projectId: p._id, status: { $in: ['pending', 'needs_clarification'] } }),
    ]);
    return { ...p, boardUrl: `${config.baseUrl}/p/${p.capId}`, counts: { tasks, done, pendingFb } };
  }));
  return c.json(withCounts);
});

api.patch('/projects/:ref', async (c) => {
  const p = await resolveProject(c.req.param('ref'));
  if (!p) return c.json({ error: 'project not found' }, 404);
  const b = await readBody(c);
  if (!b) return c.json({ error: 'invalid json body' }, 400);
  const set: Record<string, unknown> = {};
  const charter = str(b.charter); if (charter !== undefined) set.charter = charter;
  const slackChannel = strOrNull(b.slackChannel); if (slackChannel !== undefined) set.slackChannel = slackChannel;
  let pipeline: Pipeline | undefined;
  if (b.pipeline !== undefined) {
    const parsed = readPipeline(b.pipeline);
    if ('error' in parsed) return c.json({ error: parsed.error }, 400);
    pipeline = parsed.pipeline;
    set.pipeline = pipeline;
  }
  let agents: ProjectAgent[] | undefined;
  if (b.agents !== undefined) {
    const parsed = readAgents(b.agents);
    if ('error' in parsed) return c.json({ error: parsed.error }, 400);
    agents = parsed.agents;
    set.agents = agents;
  }
  if (Object.keys(set).length === 0) return c.json({ error: 'nothing to update (charter, slackChannel, pipeline, agents)' }, 400);
  await Projects.updateOne({ _id: p._id }, { $set: set });
  const laneNote = pipeline ? `: lanes [${pipeline.reviews.map((r) => r.lane).join(', ')}], autoAdvance ${pipeline.autoAdvance}` : '';
  const agentNote = agents ? `: agents [${agents.map((a) => a.name).join(', ')}]` : '';
  await logEvent(p._id!, `project updated (${Object.keys(set).join(', ')})${laneNote}${agentNote}`);
  // soft consistency: pipeline managers should exist in the registry (when one exists) — warn, never fail.
  // The write is already committed, so a logging failure must not turn a successful PATCH into a 500.
  if (pipeline || agents) {
    try {
      const effPipeline = pipeline ?? p.pipeline;
      const effAgents = agents ?? p.agents;
      if (effAgents !== undefined && effPipeline) {
        const names = new Set(effAgents.map((a) => a.name));
        for (const r of effPipeline.reviews) {
          if (!names.has(r.manager)) await logEvent(p._id!, `pipeline manager ${r.manager} not in agent registry`);
        }
      }
    } catch {
      // warn-only check: swallow so the committed update still returns 200
    }
  }
  return c.json(await Projects.findOne({ _id: p._id }));
});

api.get('/projects/:ref/context', async (c) => {
  const p = await resolveProject(c.req.param('ref'));
  if (!p) return c.json({ error: 'project not found' }, 404);
  return c.json({ name: p.name, prefix: p.prefix, repos: p.repos, charter: p.charter, stakeholders: p.stakeholders, agents: p.agents ?? [] });
});

api.get('/projects/:ref/events', async (c) => {
  const p = await resolveProject(c.req.param('ref'));
  if (!p) return c.json({ error: 'project not found' }, 404);
  const limit = Math.min(Math.max(Number(c.req.query('limit')) || 20, 1), 50);
  return c.json(await Events.find({ projectId: p._id }).sort({ at: -1 }).limit(limit).toArray());
});

// ---------- board (capability URL) ----------

api.get('/p/:capId', async (c) => {
  const p = await Projects.findOne({ capId: c.req.param('capId') });
  if (!p) return c.json({ error: 'not found' }, 404);
  const [tasks, feedback, events] = await Promise.all([
    Tasks.find({ projectId: p._id }).sort({ createdAt: 1 }).toArray(),
    Feedback.find({ projectId: p._id }).sort({ createdAt: -1 }).toArray(),
    Events.find({ projectId: p._id }).sort({ at: -1 }).limit(config.eventsBoardLimit).toArray(),
  ]);
  // charter sliced to 401: board shows a ~400-char preview and needs the +1 to know it truncated
  return c.json({ project: { name: p.name, prefix: p.prefix, repos: p.repos, stakeholders: p.stakeholders, pipeline: p.pipeline ?? null, agents: p.agents ?? [], charter: (p.charter ?? '').slice(0, 401) }, tasks, feedback, events });
});

api.get('/p/:capId/stream', async (c) => {
  const key = c.req.param('capId');
  const exists = await Projects.findOne({ capId: key }, { projection: { _id: 1 } });
  if (!exists) return c.json({ error: 'not found' }, 404);
  return streamSSE(c, async (stream) => {
    let open = true;
    const off = subscribe(key, {
      send: (data) => { stream.writeSSE({ data }).catch(() => { off(); open = false; }); },
    });
    stream.onAbort(() => { off(); open = false; });
    while (open) {
      await stream.writeSSE({ event: 'ping', data: 'keepalive' }).catch(() => { off(); open = false; });
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
    blocker: null,
    notes: str(b.notes) ?? '',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  await Tasks.insertOne(doc);
  await logEvent(p._id!, `${doc.shortId} created: ${doc.title}`, doc._id);
  return c.json(doc);
});

// my_tasks and lane views: filter by assignee/project/status, open=true for not-closed
api.get('/tasks', async (c) => {
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
  return c.json(await Tasks.find(q as never).sort({ updatedAt: -1 }).limit(200).toArray());
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
  const set: Record<string, unknown> = {};
  for (const k of ['title', 'description', 'status', 'notes', 'type'] as const) {
    const v = str(b[k]); if (v !== undefined) set[k] = v;
  }
  for (const k of ['assignee', 'blocker', 'lane'] as const) {
    const v = strOrNull(b[k]); if (v !== undefined) set[k] = v;
  }
  if (b.assigneeType === 'human' || b.assigneeType === 'agent') set.assigneeType = b.assigneeType;
  // lanes freeze once the review flow starts: reviews already spawned (or closed) from the old selection
  if (lanesShapeBad(b.lanes)) return c.json({ error: LANES_SHAPE_ERROR }, 400);
  const lanes = lanesArr(b.lanes);
  if (lanes !== undefined) {
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
  const addCommit = str(b.addCommit);
  if (Object.keys(set).length === 0 && !addCommit) return c.json(t); // nothing to do, no noise event

  // done-gate: a dev task cannot close over the heads of its open review lanes or open feedback
  if (set.status === 'done' && t.type !== 'review') {
    const open = await openReviewCount(t._id!);
    if (open) return c.json({ error: `${t.shortId} has ${open} open review subtask(s); close them (or cancel them) first` }, 409);
    const fbIds = await openFeedbackShortIds(t._id!);
    if (fbIds.length) return c.json({ error: `${t.shortId} has ${fbIds.length} open feedback row(s) (${fbIds.join(', ')}); resolve or reject them first` }, 409);
  }

  set.updatedAt = new Date();
  const update: { $set: Record<string, unknown>; $push?: { commits: string } } = { $set: set };
  if (addCommit) update.$push = { commits: addCommit };
  await Tasks.updateOne({ _id: t._id }, update);
  const changed = Object.keys(set).filter((k) => k !== 'updatedAt').concat(addCommit ? ['commit'] : []).join(', ');
  await logEvent(t.projectId, `${t.shortId} updated (${changed})${set.status ? ` → ${set.status}` : ''}`, t._id);

  const after = await Tasks.findOne({ _id: t._id });
  // pipeline hooks fire on the transition, not the state: entering review spawns lanes,
  // closing the last review lane advances (or announces) the parent
  if (after && set.status === 'in_review' && t.status !== 'in_review' && t.type !== 'review') await spawnReviews(after);
  if (t.type === 'review' && CLOSED.includes(set.status as TaskStatus) && t.parentTaskId) await maybeAdvanceParent(t.parentTaskId);
  if (after && set.status === 'done') await resolvePromotedFeedback(after);
  return c.json(after);
});

// ---------- feedback ----------

api.post('/feedback', async (c) => {
  const b = await readBody(c);
  if (!b) return c.json({ error: 'invalid json body' }, 400);
  const task = str(b.taskRef) ? await resolveTaskRef(str(b.taskRef)!) : null;
  const p = task
    ? await Projects.findOne({ _id: task.projectId })
    : await resolveProject(str(b.project) ?? '');
  if (!p) return c.json({ error: 'need taskRef or project' }, 404);
  const slack = b.slack && typeof b.slack === 'object' ? (b.slack as Record<string, unknown>) : null;
  const type = str(b.type) ?? 'bug';
  const doc: FeedbackDoc = {
    projectId: p._id!,
    taskId: task?._id ?? null,
    taskShortId: task?.shortId ?? null,
    shortId: await nextShortId(p._id!, 'feedback'),
    author: str(b.author) ?? 'unknown',
    authorType: b.authorType === 'agent' ? 'agent' : 'human',
    type: (FEEDBACK_TYPES.includes(type) ? type : 'bug') as FeedbackDoc['type'],
    body: str(b.body) ?? '',
    attachments: strArr(b.attachments),
    slack: slack && str(slack.channel) && str(slack.ts)
      ? { channel: slack.channel as string, ts: slack.ts as string, user: str(slack.user) ?? '' }
      : null,
    status: 'pending',
    resolution: null,
    resolvedTaskId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  await Feedback.insertOne(doc);
  await logEvent(p._id!, `${doc.shortId} filed by ${doc.author}${doc.taskShortId ? ` on ${doc.taskShortId}` : ''}: ${doc.body.slice(0, 80)}`, doc.taskId);
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
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (str(b.status)) set.status = b.status;
  const resolution = strOrNull(b.resolution); if (resolution !== undefined) set.resolution = resolution;
  const type = str(b.type); if (type && FEEDBACK_TYPES.includes(type)) set.type = type;
  if (str(b.resolvedTaskRef)) {
    const t = await resolveTaskRef(str(b.resolvedTaskRef)!);
    if (t) {
      set.resolvedTaskId = t._id; set.resolvedTaskShortId = t.shortId;
      // promotion IS triage: a pending row promoted without an explicit status must not stay pending
      if (fb.status === 'pending' && !str(b.status)) set.status = 'triaged';
    }
  }
  await Feedback.updateOne({ _id: fb._id }, { $set: set });
  const statusNote = str(b.status) ?? (set.status === 'triaged' ? 'triaged (auto: promoted)' : 'updated');
  await logEvent(fb.projectId, `${fb.shortId} → ${statusNote}${resolution ? `: ${resolution}` : ''}`, fb.taskId);

  // every terminal state (and clarification) replies in the original thread; nothing dies silently
  if (b.status === 'resolved') await slackThreadReply(fb, `*${fb.shortId} resolved.* ${resolution ?? ''}`.trim());
  if (b.status === 'rejected') await slackThreadReply(fb, `*${fb.shortId} not actioned:* ${resolution ?? 'no reason given (that is a bug, flag it)'}`);
  if (b.status === 'needs_clarification') await slackThreadReply(fb, `*${fb.shortId}:* quick question, ${resolution ?? 'can you add detail?'}`);

  // a parent held in_review only by this feedback closes itself once the last blocking row resolves
  if ((b.status === 'resolved' || b.status === 'rejected') && fb.taskId) await maybeAdvanceParent(fb.taskId);
  return c.json(await Feedback.findOne({ _id: fb._id }));
});

// ---------- events ----------

api.post('/events', async (c) => {
  const b = await readBody(c);
  if (!b) return c.json({ error: 'invalid json body' }, 400);
  const p = await resolveProject(str(b.project) ?? '');
  if (!p) return c.json({ error: 'project not found' }, 404);
  const task = str(b.taskRef) ? await resolveTaskRef(str(b.taskRef)!) : null;
  await logEvent(p._id!, str(b.text) ?? '', task?._id ?? null);
  return c.json({ ok: true });
});
