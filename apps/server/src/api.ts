import { Hono } from 'hono';
import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { Projects, Tasks, Feedback, Events, ObjectId, capId, nextShortId } from '@darbar/core';
import { emit, subscribe } from './sse';
import { config } from '@darbar/core';
import type { FeedbackDoc, Pipeline, Task, TaskStatus, TaskType, FeedbackStatus } from '@darbar/core';

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

// pipeline config comes from user JSON: rebuild it field-by-field, never store the raw object
function readPipeline(v: unknown): Pipeline | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  const reviews = Array.isArray(o.reviews)
    ? o.reviews.flatMap((r) => {
        if (!r || typeof r !== 'object') return [];
        const { lane, label, manager } = r as Record<string, unknown>;
        return typeof lane === 'string' && lane && typeof manager === 'string' && manager
          ? [{ lane, label: typeof label === 'string' && label ? label : lane, manager }]
          : [];
      })
    : [];
  return { autoAdvance: o.autoAdvance !== false, reviews };
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
// A re-entry after rework spawns a fresh round only once the previous round is fully closed.
async function spawnReviews(t: Task) {
  const p = await Projects.findOne({ _id: t.projectId });
  const lanes = p?.pipeline?.reviews ?? [];
  if (!p || lanes.length === 0) return;
  if (await openReviewCount(t._id!)) return;
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
  const pipeline = b.pipeline !== undefined ? readPipeline(b.pipeline) : undefined;
  if (pipeline) set.pipeline = pipeline;
  if (Object.keys(set).length === 0) return c.json({ error: 'nothing to update (charter, slackChannel, pipeline)' }, 400);
  await Projects.updateOne({ _id: p._id }, { $set: set });
  const laneNote = pipeline ? `: lanes [${pipeline.reviews.map((r) => r.lane).join(', ')}], autoAdvance ${pipeline.autoAdvance}` : '';
  await logEvent(p._id!, `project updated (${Object.keys(set).join(', ')})${laneNote}`);
  return c.json(await Projects.findOne({ _id: p._id }));
});

api.get('/projects/:ref/context', async (c) => {
  const p = await resolveProject(c.req.param('ref'));
  if (!p) return c.json({ error: 'project not found' }, 404);
  return c.json({ name: p.name, prefix: p.prefix, repos: p.repos, charter: p.charter, stakeholders: p.stakeholders });
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
  return c.json({ project: { name: p.name, prefix: p.prefix, repos: p.repos, stakeholders: p.stakeholders, pipeline: p.pipeline ?? null }, tasks, feedback, events });
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
  const doc: Task = {
    projectId: p._id!,
    shortId: await nextShortId(p._id!, 'task'),
    parentTaskId,
    title,
    description: str(b.description) ?? '',
    status,
    type,
    lane: strOrNull(b.lane) ?? null,
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
    if (t) { set.resolvedTaskId = t._id; set.resolvedTaskShortId = t.shortId; }
  }
  await Feedback.updateOne({ _id: fb._id }, { $set: set });
  await logEvent(fb.projectId, `${fb.shortId} → ${str(b.status) ?? 'updated'}${resolution ? `: ${resolution}` : ''}`, fb.taskId);

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
