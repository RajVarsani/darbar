import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { Projects, Tasks, Feedback, Events, ObjectId, capId, nextShortId } from './db';
import { emit, subscribe } from './sse';

export const api = new Hono();

const BASE_URL = process.env.BASE_URL || 'http://localhost:4899';
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN || '';

export const TASK_STATUSES = ['backlog', 'todo', 'in_progress', 'qa', 'review', 'blocked', 'done'] as const;
export const FEEDBACK_STATUSES = ['pending', 'triaged', 'needs_clarification', 'accepted', 'in_progress', 'resolved', 'rejected'] as const;
const FEEDBACK_TERMINAL = new Set(['resolved', 'rejected']);

async function logEvent(projectId: ObjectId, text: string, taskId?: ObjectId | null) {
  await Events.insertOne({ projectId, taskId: taskId ?? null, text, at: new Date() });
  const p = await Projects.findOne({ _id: projectId }, { projection: { capId: 1 } });
  if (p) emit(p.capId, { kind: 'event', text });
}

// resolution replies live in the SERVER, not the bot: Gabbar is intake-only
async function slackThreadReply(fb: any, text: string) {
  if (!fb.slack?.channel || !SLACK_BOT_TOKEN) return;
  await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${SLACK_BOT_TOKEN}` },
    body: JSON.stringify({ channel: fb.slack.channel, thread_ts: fb.slack.ts, text }),
  }).catch(() => {});
}

async function resolveTaskRef(ref: string) {
  return Tasks.findOne({ shortId: ref.toUpperCase() });
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
  const b = await c.req.json();
  if (!b.name || !b.prefix) return c.json({ error: 'name and prefix required' }, 400);
  const doc = {
    name: b.name,
    prefix: String(b.prefix).toUpperCase(),
    capId: capId(),
    repos: b.repos ?? [],
    charter: b.charter ?? '',
    stakeholders: b.stakeholders ?? [], // [{name, slackUserId, role}]
    slackChannel: b.slackChannel ?? null,
    counters: { task: 0, feedback: 0 },
    createdAt: new Date(),
  };
  await Projects.insertOne(doc as any);
  await logEvent((doc as any)._id, `project created: ${doc.name}`);
  return c.json({ ...doc, boardUrl: `${BASE_URL}/p/${doc.capId}` });
});

api.get('/projects', async (c) => {
  const list = await Projects.find({}, { projection: { charter: 0 } }).sort({ createdAt: -1 }).toArray();
  return c.json(list.map((p) => ({ ...p, boardUrl: `${BASE_URL}/p/${p.capId}` })));
});

api.get('/projects/:ref/context', async (c) => {
  const p = await resolveProject(c.req.param('ref'));
  if (!p) return c.json({ error: 'project not found' }, 404);
  return c.json({ name: p.name, prefix: p.prefix, repos: p.repos, charter: p.charter, stakeholders: p.stakeholders });
});

// ---------- board (capability URL) ----------

api.get('/p/:capId', async (c) => {
  const p = await Projects.findOne({ capId: c.req.param('capId') });
  if (!p) return c.json({ error: 'not found' }, 404);
  const [tasks, feedback, events] = await Promise.all([
    Tasks.find({ projectId: p._id }).sort({ createdAt: 1 }).toArray(),
    Feedback.find({ projectId: p._id }).sort({ createdAt: -1 }).toArray(),
    Events.find({ projectId: p._id }).sort({ at: -1 }).limit(50).toArray(),
  ]);
  return c.json({ project: { name: p.name, prefix: p.prefix, repos: p.repos, stakeholders: p.stakeholders }, tasks, feedback, events });
});

api.get('/p/:capId/stream', (c) => {
  const key = c.req.param('capId');
  return streamSSE(c, async (stream) => {
    let open = true;
    const off = subscribe(key, {
      send: (data) => { stream.writeSSE({ data }); },
      close: () => { open = false; },
    });
    stream.onAbort(() => { off(); open = false; });
    while (open) {
      await stream.writeSSE({ event: 'ping', data: 'keepalive' });
      await stream.sleep(25000);
    }
  });
});

// ---------- tasks ----------

api.post('/tasks', async (c) => {
  const b = await c.req.json();
  const p = await resolveProject(b.project ?? '');
  if (!p) return c.json({ error: 'project not found' }, 404);
  let parentTaskId: ObjectId | null = null;
  if (b.parentTaskRef) {
    const parent = await resolveTaskRef(b.parentTaskRef);
    if (!parent) return c.json({ error: `parent ${b.parentTaskRef} not found` }, 404);
    parentTaskId = parent._id;
  }
  const doc = {
    projectId: p._id,
    shortId: await nextShortId(p._id, 'task'),
    parentTaskId,
    title: b.title,
    description: b.description ?? '',
    status: b.status ?? 'todo',
    assignee: b.assignee ?? null, // 'builder-agent' | 'tanisha' | ...
    assigneeType: b.assigneeType ?? 'agent', // agent | human
    origin: b.origin ?? null,
    commits: [],
    blocker: null,
    notes: b.notes ?? '',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  await Tasks.insertOne(doc as any);
  await logEvent(p._id, `${doc.shortId} created: ${doc.title}`, (doc as any)._id);
  return c.json(doc);
});

api.patch('/tasks/:ref', async (c) => {
  const t = await resolveTaskRef(c.req.param('ref'));
  if (!t) return c.json({ error: 'task not found' }, 404);
  const b = await c.req.json();
  const set: Record<string, unknown> = { updatedAt: new Date() };
  for (const k of ['title', 'description', 'status', 'assignee', 'assigneeType', 'blocker', 'notes'] as const) {
    if (b[k] !== undefined) set[k] = b[k];
  }
  if (b.status && !TASK_STATUSES.includes(b.status)) return c.json({ error: `bad status; use ${TASK_STATUSES.join('|')}` }, 400);
  const update: any = { $set: set };
  if (b.addCommit) update.$push = { commits: b.addCommit };
  await Tasks.updateOne({ _id: t._id }, update);
  const changed = Object.keys(set).filter((k) => k !== 'updatedAt').join(', ') + (b.addCommit ? ', commit' : '');
  await logEvent(t.projectId, `${t.shortId} updated (${changed})${b.status ? ` → ${b.status}` : ''}`, t._id);
  return c.json(await Tasks.findOne({ _id: t._id }));
});

// ---------- feedback ----------

api.post('/feedback', async (c) => {
  const b = await c.req.json();
  let task = b.taskRef ? await resolveTaskRef(b.taskRef) : null;
  const p = task
    ? await Projects.findOne({ _id: task.projectId })
    : await resolveProject(b.project ?? '');
  if (!p) return c.json({ error: 'need taskRef or project' }, 404);
  const doc = {
    projectId: p._id,
    taskId: task?._id ?? null,
    taskShortId: task?.shortId ?? null,
    shortId: await nextShortId(p._id, 'feedback'),
    author: b.author ?? 'unknown',
    authorType: b.authorType ?? 'human', // human | agent
    type: b.type ?? 'bug', // bug | design | idea | approval
    body: b.body ?? '',
    attachments: b.attachments ?? [],
    slack: b.slack ?? null, // {channel, ts, user} for the closing reply
    status: 'pending',
    resolution: null,
    resolvedTaskId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  await Feedback.insertOne(doc as any);
  await logEvent(p._id, `${doc.shortId} filed by ${doc.author}${doc.taskShortId ? ` on ${doc.taskShortId}` : ''}: ${doc.body.slice(0, 80)}`);
  return c.json({ ...doc, boardUrl: `${BASE_URL}/p/${p.capId}` });
});

api.get('/feedback/pending', async (c) => {
  const q: Record<string, unknown> = { status: { $in: ['pending', 'needs_clarification'] } };
  const ref = c.req.query('project');
  if (ref) {
    const p = await resolveProject(ref);
    if (!p) return c.json({ error: 'project not found' }, 404);
    q.projectId = p._id;
  }
  return c.json(await Feedback.find(q).sort({ createdAt: 1 }).toArray());
});

api.patch('/feedback/:shortId', async (c) => {
  const fb = await Feedback.findOne({ shortId: c.req.param('shortId').toUpperCase() });
  if (!fb) return c.json({ error: 'feedback not found' }, 404);
  const b = await c.req.json();
  if (b.status && !FEEDBACK_STATUSES.includes(b.status)) return c.json({ error: `bad status; use ${FEEDBACK_STATUSES.join('|')}` }, 400);
  const set: Record<string, unknown> = { updatedAt: new Date() };
  for (const k of ['status', 'resolution', 'type'] as const) if (b[k] !== undefined) set[k] = b[k];
  if (b.resolvedTaskRef) {
    const t = await resolveTaskRef(b.resolvedTaskRef);
    if (t) { set.resolvedTaskId = t._id; set.resolvedTaskShortId = t.shortId; }
  }
  await Feedback.updateOne({ _id: fb._id }, { $set: set });
  await logEvent(fb.projectId, `${fb.shortId} → ${b.status ?? 'updated'}${b.resolution ? `: ${b.resolution}` : ''}`);

  // every terminal state (and clarification) replies in the original thread — nothing dies silently
  if (b.status === 'resolved') await slackThreadReply(fb, `*${fb.shortId} resolved.* ${b.resolution ?? ''}`.trim());
  if (b.status === 'rejected') await slackThreadReply(fb, `*${fb.shortId} not actioned:* ${b.resolution ?? 'no reason given (that is a bug, flag it)'}`);
  if (b.status === 'needs_clarification') await slackThreadReply(fb, `*${fb.shortId}:* quick question — ${b.resolution ?? 'can you add detail?'}`);
  return c.json(await Feedback.findOne({ _id: fb._id }));
});

// ---------- events ----------

api.post('/events', async (c) => {
  const b = await c.req.json();
  const p = await resolveProject(b.project ?? '');
  if (!p) return c.json({ error: 'project not found' }, 404);
  const task = b.taskRef ? await resolveTaskRef(b.taskRef) : null;
  await logEvent(p._id, b.text ?? '', task?._id ?? null);
  return c.json({ ok: true });
});
