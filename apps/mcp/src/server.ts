// MCP tracker tools — the one write path for orchestrators, builders and lanes.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { config } from '@darbar/core';

const API = config.apiUrl;

async function call(path: string, method = 'GET', body?: unknown) {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await r.json().catch(() => ({}));
  return { content: [{ type: 'text' as const, text: JSON.stringify(json, null, 2) }], isError: !r.ok };
}

const server = new McpServer({ name: 'darbar', version: '0.1.0' });

// DAR-398. T3 Code puts T3CODE_THREAD_ID in the env of the Claude session that spawns this process,
// so a claim made through these tools can name the thread doing the work. The server builds the link.
const T3_THREAD = process.env.T3CODE_THREAD_ID?.trim() || undefined;
const T3_REF = {
  t3ThreadId: z.string().nullable().optional().describe('the T3 Code thread working this row. Stamped for you from T3CODE_THREAD_ID when you claim it; send it only to override, or null to clear'),
  t3Link: z.string().nullable().optional().describe('open-in-T3 URL; the server builds it from t3ThreadId, so you normally never send this'),
};

server.tool('get_project_context', 'Fetch a project charter: protocols, repos, stakeholders, the review pipeline (lanes + managers + autoAdvance), the agent registry (lane managers, helpers, orchestrator — each with its standing brief), and the shared-surface proxy (prefix, allowlist, enabled — the upstream target is redacted here, use get_proxy_route for that). Every agent should read this before working, and it is the read side of every config edit tool. `configured` says which surfaces exist at all, since the fields themselves normalise absent to []/null and cannot otherwise be told apart from a surface that was cleared.',
  { project: z.string().describe('project prefix, name, or capId') },
  ({ project }) => call(`/projects/${encodeURIComponent(project)}/context`));

server.tool('list_projects', 'List registered projects with board URLs. Omit `archived` (or pass "false") and this returns ACTIVE projects only, which is the default and is a behaviour change worth knowing: an archived project disappears from this list unless you ask for it. Pass "true" for archived projects only, or "all" for both. Every row carries `archivedAt` (an ISO string, or null when live) regardless of which value you pass, so you can always tell live from archived even when you asked for "all". A tool description that hides what it drops is how a caller ends up reporting a finished project as nonexistent; this one does not.',
  { archived: z.enum(['false', 'true', 'all']).optional().describe('omit or "false" = active only (default); "true" = archived only; "all" = both. Any other value is a 400') },
  ({ archived }) => call(`/projects${archived !== undefined ? `?archived=${archived}` : ''}`));

server.tool('get_project_config', 'The project fields you are allowed to WRITE, and only those: charter, slackChannel, repos, stakeholders, and pipeline/agents where they exist. This is the READ half of read-then-write, which is the documented way to restructure a charter or replace a stakeholder list in bulk, and until this route existed there was no read whose output the write path accepted back (DAR-FB-121). It matters because every wholesale door on a project REPLACES the list it is handed — one stakeholder sent as the whole `stakeholders` array deletes everybody else and returns 200. So read here, edit the array you meant to edit, send the whole thing back. The output is a legal PATCH /api/projects/:ref body BY CONSTRUCTION rather than by anyone remembering to keep two shapes in step, which is the reason to read it from this tool and not from a payload that merely looks similar. `proxy` IS DELIBERATELY ABSENT, and its absence is what makes the round trip safe: a field omitted from a PATCH is left untouched, so echoing this body back can never repoint, widen or withdraw a live share by accident, and the internal target never lands on a fresh payload for a model to read (FB-89). The share has two doors of its own, patch_proxy_route and set_proxy_enabled, and they ask for confirmation on purpose. get_project_context is NOT interchangeable with this, and the difference is not cosmetic: that payload CARRIES a `proxy`, redacted, and the write path reads `proxy` as an instruction — `null` means clear the share and withdraw the route, and the redacted object is a 400 because the target it exists to hide is required. So a context payload echoed back is wrong in one of two directions, and only one of them tells you. Unknown project is a 404.',
  { project: z.string().describe('project prefix, name, or capId') },
  ({ project }) => call(`/projects/${encodeURIComponent(project)}`));

server.tool('get_project_events', 'The project event log, newest first: the resume trail a fresh session reads instead of asking somebody what happened. Every status move, promotion, config edit, feedback append, review spawn, auto-advance and auto-resolution writes a line here, so this is where you learn that a task closed itself while you were not looking, or that a proxy push failed rather than quietly not happening. It is a RECENT WINDOW and never the whole history: limit is clamped to 1..50 (default 20) and there is no offset, so an older event is not reachable by paging — get_board returns a whole project in one payload (tasks, feedback, its own events slice) when you need more than the last few moves. Unknown project is a 404.',
  {
    project: z.string(),
    limit: z.number().optional().describe('how many of the most recent events, 1-50, default 20. Anything outside that range is CLAMPED rather than refused, so asking for 500 quietly returns 50'),
  },
  ({ project, limit }) => call(`/projects/${encodeURIComponent(project)}/events${limit !== undefined ? `?limit=${limit}` : ''}`));

server.tool('create_project', 'Register a NEW project: board, capability URL, id namespace, counters, and its ENTIRE configuration in ONE call. pipeline, agents and proxy belong in THIS body — registration used to be a POST followed by three PATCHes because those three were dropped here under a 200, and a project left half-configured is one whose first task reaches in_review and spawns no review at all. They run through the same readers and the same write path as every later edit, and they are validated BEFORE the insert, so a malformed pipeline is a 400 with nothing created rather than a board somebody now has to repair. `prefix` is 2 to 6 letters and becomes the namespace every task and feedback row is named in (DAR-1, DAR-FB-1); it is upper-cased, it cannot be changed afterwards, this API has no delete for anything, and a prefix already registered is a 409. `stakeholders` is validated here rather than stored raw because that list is ACCESS CONTROL: Gabbar matches the verified slack sender against it, so a slackUserId that is not U or W followed by uppercase alphanumerics is a 400 naming the index, instead of a real person being refused in silence forever. A proxy prefix another project already claims is a 409 too. READ the `warnings` on the response: that is where the server puts what it declines to fail on, such as a review lane whose manager is not in the agent registry, and nothing else surfaces it except the event log.',
  {
    name: z.string().describe('human name, e.g. "Darbar Platform"'),
    prefix: z.string().describe('2-6 letters. Permanent, and the id namespace for every task and feedback row on this board'),
    charter: z.string().optional().describe('the prose every agent on this project reads before working: protocols, doctrine, what must never be touched. append_to_charter adds to it afterwards'),
    repos: z.array(z.string()).optional().describe('the checkouts this project is worked in, in the terms the charter uses'),
    slackChannel: z.string().nullable().optional().describe('channel id bound for feedback intake, e.g. C0AB1CD2EFG'),
    stakeholders: z.array(z.object({
      name: z.string(),
      slackUserId: z.string().optional().describe('slack USER id (U/W + uppercase alphanumerics). This exact string is what the feedback gate matches; without one the person cannot file anything'),
      role: z.string().optional(),
    })).optional(),
    pipeline: z.object({
      autoAdvance: z.boolean().optional().describe('default true'),
      reviews: z.array(z.object({ lane: z.string(), label: z.string().optional(), manager: z.string() })),
    }).optional().describe('the review lanes, declared at init; add_review_lane / update_review_lane edit one later'),
    agents: z.array(z.object({
      name: z.string(), kind: z.enum(['lane-manager', 'helper', 'orchestrator']),
      brief: z.string(), trigger: z.string().optional(),
    })).optional().describe('the agent registry; add_agent / update_agent edit one later'),
    proxy: z.object({
      prefix: z.string(), target: z.string(),
      public: z.array(z.string()).optional(), enabled: z.boolean().optional(),
    }).optional().describe('shared surface, same validators as set_proxy: loopback target only, literal path patterns, enabled defaults false'),
  },
  (args) => call('/projects', 'POST', args));

server.tool('archive_project', 'Archive a project: it drops out of the default list_projects view (and out of anything that reads that list) without being deleted. There is no delete anywhere in this API. Archiving is REFUSED with a 409 when the project still has open rows (anything not done or cancelled), naming the count, because burying live work under an archive silently is the failure this guards against. That 409 hands you a real decision, not a retry: cancelOpen:true cancels every open row as PART OF archiving, recording on each cancelled row that its project was archived and when. Send this when the honest answer is "this release is over, and these did not make it". force:true archives anyway and leaves the open rows exactly as they are, recording the surviving count on the project as `archivedOpenRows`. Send this ONLY when that work genuinely continues somewhere else (a follow-on project, a different board), never as a way to dodge the question cancelOpen answers. cancelOpen and force are opposite answers to the same question, so sending both is a 400. `reason` is optional but you should almost always send one: it is what makes this archive explainable to someone reading the board in a month who was not in this conversation and has only the reason to go on.',
  {
    project: z.string().describe('project prefix, name, or capId'),
    reason: z.string().optional().describe('why this project is being archived, written as a stranger reading the board in a month would need it. Optional, but send it whenever you have one. Sent alone without archived:true this would mean nothing, which is why this tool always sends archived:true alongside it'),
    cancelOpen: z.boolean().optional().describe('cancel every open row as part of archiving, recording that its project was archived and when. The honest choice when the open work did not make it into this release. Mutually exclusive with force (400 if both are set)'),
    force: z.boolean().optional().describe('archive anyway and leave open rows open; the surviving count is recorded on the project as archivedOpenRows. Only right when that work genuinely continues elsewhere. Mutually exclusive with cancelOpen (400 if both are set)'),
  },
  ({ project, reason, ...rest }) => call(`/projects/${px(project)}`, 'PATCH', { archived: true, archiveReason: reason, ...rest }));

server.tool('unarchive_project', 'Bring an archived project back: clears `archivedAt`, clears the archive reason, and clears `archivedOpenRows`. It does NOT resurrect rows that a previous archive cancelled via cancelOpen. That cancellation was a real decision made at the time about work that did not make it, and reversing the archive does not un-decide it. If any of those rows genuinely need to come back, that is a separate, deliberate move on each one, not a side effect of unarchiving the project.',
  { project: z.string().describe('project prefix, name, or capId') },
  ({ project }) => call(`/projects/${px(project)}`, 'PATCH', { archived: false }));

server.tool('get_board', 'Full board for a project: tasks, feedback, recent events.',
  { capId: z.string().describe('project capability id') },
  ({ capId }) => call(`/p/${capId}`));

const STATUS = z.enum(['backlog', 'todo', 'in_progress', 'in_review', 'qa', 'blocked', 'done', 'cancelled']);
const TYPE = z.enum(['feature', 'bug', 'chore', 'review', 'regression']);

server.tool('create_task', 'Create a task (or subtask via parentTaskRef). Only the orchestrator promotes feedback into tasks. Review subtasks are pipeline-spawned by the server — do not create type=review tasks by hand. Any status is accepted at create, including in_review for work already under review: creating one there spawns its review lanes immediately, exactly as moving a task there does. origin and parentTaskRef are create-time only and cannot be changed afterwards.',
  {
    project: z.string(), title: z.string(), description: z.string().optional(),
    parentTaskRef: z.string().optional(), assignee: z.string().optional(),
    assigneeType: z.enum(['agent', 'human']).optional(), origin: z.string().optional(),
    type: TYPE.optional(), status: STATUS.optional(), ...T3_REF,
    blocker: z.string().optional().describe('why this task cannot be started, when you are filing it already blocked. It is applied at create now; it used to be dropped under a 200, which put blocked cards on the board with no why on them. Changing or clearing it later is update_task {blocker} / {blocker: null}'),
    lanes: z.array(z.string()).optional().describe('review lanes to spawn when this task hits in_review — pick by judgment: code-review for code changes, qa for behavior/outcomes, design-qa only for UI surfaces; [] = explicitly no reviews; omit = code-review alone if the pipeline has that lane, else every configured lane'),
  },
  (args) => call('/tasks', 'POST', args.status === 'in_progress' && T3_THREAD && args.t3ThreadId === undefined ? { ...args, t3ThreadId: T3_THREAD } : args));

server.tool('update_task', 'Update a task row: status, blocker, notes, dispatched, or append a commit hash. Moving a dev task to in_review auto-spawns the project pipeline review lanes; done is rejected (409) while review children are open; closing the last review child auto-advances the parent when the project has autoAdvance on. origin, parentage, shortId, the project and the commits array are create-time or append-only and are refused here with a 400 rather than accepted and ignored.',
  {
    taskRef: z.string().describe('short id like TST-1'),
    status: STATUS.optional(),
    assignee: z.string().optional(), blocker: z.string().nullable().optional(),
    notes: z.string().optional(), addCommit: z.string().optional(), type: TYPE.optional(),
    ...T3_REF,
    dispatched: z.boolean().optional().describe('true the moment you hand this task to an agent. The server stamps the time and the board shows the card as dispatched with its age, so work in flight stops reading as idle. The agent PATCHing its own status clears it. Send false only to write off a dispatch that never started'),
    lanes: z.array(z.string()).optional().describe('re-pick review lanes (code-review for code, qa for behavior, design-qa for UI; [] = none); only at backlog/todo/blocked — frozen once a builder holds the row (in_progress) and after (in_review/qa/done/cancelled). Echoing the value back unchanged always passes, so read-then-write still works'),
    reviewAgain: z.boolean().optional().describe('send true ALONGSIDE status=in_review to spawn a SECOND review round on a task whose previous round is fully closed. Without it that move is a 409 naming the closed children, because re-entering in_review used to silently double the round. Only send it when the rework genuinely needs reviewing again; if the round it already had is the answer, leave the row where it is'),
  },
  ({ taskRef, ...rest }) => call(`/tasks/${taskRef}`, 'PATCH', rest.status === 'in_progress' && T3_THREAD && rest.t3ThreadId === undefined ? { ...rest, t3ThreadId: T3_THREAD } : rest));

server.tool('my_tasks', 'Open tasks for an assignee (lane managers and builders start here). Optionally scope by project or lane. Returns a PAGE, not a bare list: {total, returned, offset, limit, truncated, tasks[]}. `total` is how many tasks match the filter in full; `truncated` is true when this page is not all of them, and the reply then carries nextOffset. Never treat the rows as the whole set without checking `truncated` — if it is true, repeat with offset=nextOffset until it is false, or read the whole project in one payload with get_board.',
  {
    assignee: z.string().describe('exact assignee name, e.g. qa-lead'),
    project: z.string().optional(), lane: z.string().optional(),
    limit: z.number().optional().describe('page size, 1-1000; default 1000 (whole matching set on any normal project)'),
    offset: z.number().optional().describe('rows to skip, for reading the next page after a truncated one'),
  },
  ({ assignee, project, lane, limit, offset }) => {
    const qs = new URLSearchParams({ assignee, open: 'true' });
    if (project) qs.set('project', project);
    if (lane) qs.set('lane', lane);
    if (limit !== undefined) qs.set('limit', String(limit));
    if (offset !== undefined) qs.set('offset', String(offset));
    return call(`/tasks?${qs}`);
  });

server.tool('get_task', 'ONE task row exactly as the server holds it, which is not the same thing as the row you remember writing. Read it before you PATCH: `status` says whether the update you are about to send is even legal (done is a 409 while a review child is open, and open feedback filed against the task holds it in in_review too), `lanes` is frozen from in_progress onward, so a re-pick once a builder holds the row is refused (clearing them under a live builder is what once let a row self-advance to done unreviewed); re-entering in_review after a CLOSED review round is a 409 too, overridable with reviewAgain, `commits` is append-only and grows one hash per update_task call, and `dispatchedAt` (stamped by update_task {dispatched}) tells you whether somebody is already working this card. It is also how a builder confirms its own status write landed instead of assuming it did. The row carries what create-time-only means in practice: origin, parentTaskId and shortId are here to read and are 400s on update_task. An unknown ref is a 404, never an empty row, so a typo cannot read as a task with nothing on it. Read-only.',
  { taskRef: z.string().describe('short id like DAR-12, case-insensitive. This is the only way to address a task; there is no lookup by title') },
  ({ taskRef }) => call(`/tasks/${encodeURIComponent(taskRef)}`));

server.tool('set_pipeline', 'DECLARE the whole review pipeline for a project (project init): lanes spawned as subtasks when a dev task hits in_review, each assigned to its lane manager. autoAdvance moves the parent to done when the last lane closes. `reviews` REPLACES the whole lane list, so to change one thing mid-session use add_review_lane / update_review_lane / remove_review_lane / set_auto_advance instead — they merge server-side and refuse to strand tasks that already selected a lane.',
  {
    project: z.string(),
    autoAdvance: z.boolean().optional().describe('default true; false = parent waits in in_review for an explicit push'),
    reviews: z.array(z.object({
      lane: z.string().describe('key, e.g. qa or code-review'),
      label: z.string().optional(),
      manager: z.string().describe('agent the spawned task is assigned to, e.g. qa-lead'),
    })),
  },
  ({ project, ...rest }) => call(`/projects/${encodeURIComponent(project)}`, 'PATCH', { pipeline: rest }));

server.tool('set_agents', 'DECLARE the whole project agent registry (project init): lane managers, helpers, and the orchestrator. Replaces the whole list, so mid-session use add_agent / update_agent / remove_agent instead — sending one entry here to "change one brief" deletes every other agent and returns 200. Pipeline review managers should exist here — the server logs a warning event when one is missing. Names must be unique (they are the assignee key); agents: [] clears the registry and will warn for every pipeline manager.',
  {
    project: z.string(),
    agents: z.array(z.object({
      name: z.string().describe('agent name, e.g. qa-lead — task assignees reference this'),
      kind: z.enum(['lane-manager', 'helper', 'orchestrator']),
      brief: z.string().describe('the agent standing charter — the orchestrator uses it as the dispatch prompt (what it does, how, what never to touch)'),
      trigger: z.string().optional().describe('when-to-dispatch hint for the orchestrator'),
    })),
  },
  ({ project, agents }) => call(`/projects/${encodeURIComponent(project)}`, 'PATCH', { agents }));

server.tool('set_proxy', 'DECLARE the whole shared-surface config for a project (project init), at BASE_URL/<prefix>/. Mid-session use patch_proxy_route to edit one field and set_proxy_enabled to publish or withdraw, which keeps exposure out of routine edits. SECURITY: while enabled, anyone who has the link can reach that target — there is no login in front of it. The public patterns ARE the boundary: only paths matching one of them are served to tunneled requests (local access is never filtered), so ["/"] means the whole app is exposed and omitting them means nothing is. Default is enabled:false — configure first, share deliberately. Replaces the whole proxy config; the server pushes it into the proxy route table and reconciles the two at every change and at boot, so a failed push is repaired rather than left as silent drift. The target is never shown on the public board (a link-holder must not learn the internal host:port); it is on get_project_context, which is local-only.',
  {
    project: z.string(),
    prefix: z.string().describe('URL segment this project is served at, [A-Za-z0-9_-]; it is the routing key, so a prefix already claimed by another project OR already live on the proxy as a hand-added route is rejected 409'),
    target: z.string().describe('http(s) URL of a dev server on THIS machine — loopback only (localhost, 127.0.0.0/8, ::1, or an unspecified address like 0.0.0.0 / ::, which connect to loopback); a public host, a LAN/private address, ANY DNS name (including *.localhost, which is resolved at request time and can point anywhere), or a link-local/metadata address is rejected 400, because the proxy is publicly reachable through the tunnel and would relay to it. No query, fragment or user:pass@ (credentials are never sent upstream, so they would only end up stored). INCLUDE THE PATH when the dev server has a base: a Vite app served at base /fe needs http://127.0.0.1:5173/fe, not http://127.0.0.1:5173 — without it Vite receives / and 302s to /fe/ forever through the prefix strip'),
    public: z.array(z.string()).optional().describe('allowlist of paths reachable from outside. These are NOT regular expressions — each entry is a literal path starting with "/", matching as a PREFIX by default ("/assets/"), with a trailing "$" for an exact path ("/$" = the root and nothing else) and at most one "*" matching within a single path segment ("/assets/*.js$"). Anything else — "^", "(", "[", "+", "\\", ".*" — is rejected 400 with the form spelled out, because the proxy matches these with string operations only: a regex allowlist on a shared front door was a denial-of-service hole no validation could close. Omit = nothing is reachable through the tunnel; ["/"] exposes every path'),
    enabled: z.boolean().optional().describe('default false. true publishes the route immediately; false withdraws it while keeping the config'),
  },
  ({ project, ...rest }) => call(`/projects/${encodeURIComponent(project)}`, 'PATCH', { proxy: rest }));

// ---------- granular config edits ----------
// The set_* tools above declare a whole surface, which is right at project init and a trap for every
// edit after it: they replace the list wholesale, so "change one agent's brief" sent as a one-element
// array deletes the rest and returns 200. The tools below take the granular intent and the SERVER does
// the read-merge-write, against the same validators, so a partial edit cannot produce a config the
// wholesale path would have rejected. Addressing is edit-only everywhere: a name or lane key that does
// not exist is a 404 listing what does exist, never an upsert. Adding is a separate tool that refuses
// a name already taken.
const px = (s: string) => encodeURIComponent(s);

server.tool('add_stakeholder', 'Add ONE person to a project\'s stakeholder list. This is an ACCESS-CONTROL change, not metadata: Gabbar\'s feedback gate matches the verified slack sender id against this list and fails closed, so adding somebody with a slackUserId is what lets them file feedback on this project (and makes them assignable as a human). Without a slackUserId they still cannot file anything. The id shape is validated (U/W + uppercase alphanumerics) because a typo is silent: the person keeps being refused and no error appears anywhere. The server also asks Slack who the id belongs to, best effort, and returns that as a warning.',
  {
    project: z.string(),
    name: z.string().describe('display name; this is how the person is addressed by update_stakeholder / remove_stakeholder and how tasks are assigned to them'),
    slackUserId: z.string().optional().describe('slack USER id, e.g. U0EXAMPLE123 — NOT a display name and not a channel id. This exact string is what the feedback gate matches'),
    role: z.string().optional().describe('owner / design / backend / product — free text, used for context'),
  },
  ({ project, ...rest }) => call(`/projects/${px(project)}/stakeholders`, 'POST', rest));

server.tool('update_stakeholder', 'Change ONE stakeholder\'s slack id, role or display name, leaving everyone else untouched. Correcting slackUserId re-points the feedback gate: the old id is refused from that moment. Pass slackUserId:null to revoke feedback filing while keeping the person on the project, or role:null to drop the role. The display name is changed with `rename` (the `name` argument addresses who you mean); sending only a new `name` is a 400 rather than a no-op success.',
  {
    project: z.string(),
    name: z.string().describe('WHO to edit: the current name, exactly as listed (404 lists the names if it does not match). This is not the new name, use rename for that'),
    slackUserId: z.string().nullable().optional().describe('new slack user id, or null to remove it (which stops them filing feedback)'),
    role: z.string().nullable().optional(),
    rename: z.string().optional().describe('new display name; task assignees are NOT rewritten, they are reported back as a warning'),
  },
  ({ project, name, ...rest }) => call(`/projects/${px(project)}/stakeholders/${px(name)}`, 'PATCH', rest));

server.tool('remove_stakeholder', 'Remove ONE person from a project\'s stakeholder list. This REVOKES their ability to file feedback through Gabbar; feedback they already filed is untouched, and open tasks assigned to them are reported back rather than reassigned.',
  { project: z.string(), name: z.string() },
  ({ project, name }) => call(`/projects/${px(project)}/stakeholders/${px(name)}`, 'DELETE'));

server.tool('get_proxy_route', 'The shared surface for one project INCLUDING the upstream target, plus its public URL, whether the route is actually live in the proxy table, and what it exposes in plain terms. Separate from get_project_context on purpose: that payload is handed to a Slack-facing model, and the internal host:port must not travel (FB-89).',
  { project: z.string() },
  ({ project }) => call(`/projects/${px(project)}/proxy`));

server.tool('add_agent', 'Register ONE new agent (lane-manager, helper or orchestrator) without touching the rest of the registry. 409 if the name is taken, since the name is the assignee key and a second one would make every lookup ambiguous. Names are stored trimmed and compared case-insensitively, so "Staff-Engineer" collides with "staff-engineer" rather than becoming a second dispatch key.',
  {
    project: z.string(),
    name: z.string().describe('unique agent name; this is the assignee key used by assignee, my_tasks and pipeline managers'),
    kind: z.enum(['lane-manager', 'helper', 'orchestrator']),
    brief: z.string().describe('the standing charter the orchestrator dispatches with: what it decides, what it does, what it must never touch'),
    trigger: z.string().optional().describe('when-to-dispatch hint'),
  },
  ({ project, ...rest }) => call(`/projects/${px(project)}/agents`, 'POST', rest));

server.tool('update_agent', 'Edit ONE registered agent: its brief, kind, trigger, or name. The rest of the registry is preserved by the server, which is the whole point — set_agents would have deleted it. Renaming also rewrites any pipeline lane that named this agent as manager (that is config), and reports back the open tasks still assigned to the old name (that is data, and a rename does not move it).',
  {
    project: z.string(),
    name: z.string().describe('current agent name, exactly as registered'),
    brief: z.string().optional(),
    kind: z.enum(['lane-manager', 'helper', 'orchestrator']).optional(),
    trigger: z.string().nullable().optional().describe('new hint, or null to clear it'),
    rename: z.string().optional(),
  },
  ({ project, name, ...rest }) => call(`/projects/${px(project)}/agents/${px(name)}`, 'PATCH', rest));

server.tool('remove_agent', 'Remove ONE agent from the registry. Warns if it manages a review lane (the lane still spawns, its task just lands on a name nobody dispatches) or if open tasks are still assigned to it.',
  { project: z.string(), name: z.string() },
  ({ project, name }) => call(`/projects/${px(project)}/agents/${px(name)}`, 'DELETE'));

server.tool('add_review_lane', 'Add ONE review lane to the pipeline, keeping the existing lanes. Creates the pipeline (autoAdvance true) if the project had none. Lane keys are stored trimmed and compared case-insensitively, so "QA" collides with "qa" instead of becoming a second key for one lane. Adding a lane is the safe direction: tasks already in flight keep their own lane selection, and new tasks may then choose this key.',
  {
    project: z.string(),
    lane: z.string().describe('lane key, e.g. qa or design-qa — tasks select lanes by this key'),
    manager: z.string().describe('agent the spawned review task is assigned to; a name not in the agent registry is allowed but warned about'),
    label: z.string().optional().describe('defaults to the lane key'),
  },
  ({ project, ...rest }) => call(`/projects/${px(project)}/pipeline/lanes`, 'POST', rest));

server.tool('update_review_lane', 'Reassign ONE lane\'s manager, or change its label or key, keeping every other lane. Renaming the KEY is gated: lane selection on a task is frozen once it enters review and is never re-validated, so open tasks that named the old key and nothing else would silently match no lane, skip review entirely and (with autoAdvance) go straight to done unreviewed. The 409 names those tasks and says which end state each one lands in; force repeats the call anyway. Tasks that also select a surviving lane are reported as a warning rather than gated. Tasks with no lanes field are NOT unaffected: renaming the code-review key changes their default from code-review-only back to every configured lane.',
  {
    project: z.string(),
    lane: z.string().describe('current lane key'),
    manager: z.string().optional(),
    label: z.string().optional(),
    rename: z.string().optional().describe('new lane key'),
    force: z.boolean().optional().describe('only for a rename that would strand open tasks; send it after reading the task list in the 409'),
  },
  ({ project, lane, ...rest }) => call(`/projects/${px(project)}/pipeline/lanes/${px(lane)}`, 'PATCH', rest));

server.tool('remove_review_lane', 'Remove ONE review lane, keeping the others. Gated on any open task the removal would leave with no review, and the 409 distinguishes the two end states, because they are not the same: a task that named only this lane skips review and auto-advances to DONE unreviewed, while a task with no lanes field (the pipeline default: code-review alone when configured, otherwise every lane) that loses the LAST lane spawns nothing, logs nothing and STALLS in in_review. Tasks that keep another lane are warned about, not gated. Pass force after reading the list.',
  { project: z.string(), lane: z.string(), force: z.boolean().optional() },
  ({ project, lane, force }) => call(`/projects/${px(project)}/pipeline/lanes/${px(lane)}${force ? '?force=true' : ''}`, 'DELETE'));

server.tool('set_auto_advance', 'Flip only the pipeline\'s autoAdvance: true = the parent task leaves in_review by itself when the last review lane closes, false = it waits for an explicit push. set_pipeline cannot do this alone, because it requires the full lane list and would wipe it if omitted.',
  { project: z.string(), autoAdvance: z.boolean() },
  ({ project, autoAdvance }) => call(`/projects/${px(project)}/pipeline`, 'PATCH', { autoAdvance }));

server.tool('set_repos', 'Set the repos a project is worked in. The charter tells every builder which checkout it is in and this list is the machine-readable half of that, so losing it hands agents the wrong repo: PATCH /projects had no branch for `repos` at all, and {charter, repos} applied the charter and dropped the repos under a 200. WHOLESALE, like every other list on the project document: what you send becomes the list, so ADD a repo by sending the existing entries plus the new one (get_project_context returns them) and repos: [] clears it — a single-element array here is not "add one", it is "these are now the only repos". A non-string entry is a 400 rather than a quietly filtered array.',
  { project: z.string(), repos: z.array(z.string()).describe('the full repo list after this edit, in the terms the charter uses (a name like "darbar", or a path); it replaces whatever is stored') },
  ({ project, repos }) => call(`/projects/${px(project)}`, 'PATCH', { repos }));

server.tool('set_slack_channel', 'Bind, rebind or unbind the Slack channel a project takes feedback in. Same shape of gap set_repos closed: the field is applied by PATCH /api/projects and had no door of its own, so the only way to set it mid-session was curl, and a project registered without one had no recorded intake channel that any later session could find. Send a channel ID (C…/D…/G…), not a #name — nothing resolves a name here and nothing validates the shape, so "#darbar" is stored exactly as typed and is then a channel id that names no channel. null unbinds and leaves the rest of the project untouched. This is NOT access control and grants nobody anything: Gabbar\'s feedback gate matches the SENDER\'s slack user id against the stakeholder list (add_stakeholder), so a person writing in a bound channel is still refused and still parked until they are a stakeholder. Read it back on get_project_context, which is the payload a Gabbar-facing session reads.',
  {
    project: z.string(),
    slackChannel: z.string().nullable().describe('slack CHANNEL id, e.g. C0AB1CD2EFG (a DM channel id like D0AH8292D7Y is equally valid), or null to unbind. Not a user id, not a #name'),
  },
  ({ project, slackChannel }) => call(`/projects/${px(project)}`, 'PATCH', { slackChannel }));

server.tool('set_linear_url', 'Mark a project as LINEAR-NATIVE, or clear that (null). For such a project, Linear IS the board of record: tasks live there, agents work them there (full CRUD on issues carrying the darbar/<PREFIX> workspace label — and READ-ONLY on any issue without it, those belong to colleagues), and the darbar project is archived, surviving only as history plus the gabbar feedback pipe. The console card opens this URL (the archived native board stays in the card\'s menu) and the URL rides on get_project_context so every agent learns the mode before working. Feedback still arrives HERE via gabbar; the orchestrator drains it into Linear (comment on the relevant ticket, comment on the standing feedback-inbox ticket, or a new labelled issue) and then resolves the darbar row so the reporter\'s Slack thread gets its reply. The URL is a label-filtered view (the darbar/<PREFIX> label), not a Linear project, because rows scatter across the company\'s existing Linear projects. A hand-synced mirror mode preceded this and drifted within two days; do not recreate it.',
  {
    project: z.string(),
    linearUrl: z.string().nullable().describe('absolute https URL of the Linear view that shows this board\'s rows (the darbar/<PREFIX> label filter, or a saved view), or null to make the project darbar-native again'),
  },
  ({ project, linearUrl }) => call(`/projects/${px(project)}`, 'PATCH', { linearUrl }));

server.tool('append_to_charter', 'Append one rule, decision or note to a project charter without resending it. The charter is prose every agent reads before working, so this is how a protocol locked mid-session gets recorded. Appends on its own line at the end; PATCH /api/projects/:ref {charter} is still the way to rewrite or restructure the whole thing.',
  { project: z.string(), text: z.string().describe('the line(s) to append, written as they should read in the charter') },
  ({ project, text }) => call(`/projects/${px(project)}/charter/append`, 'POST', { text }));

server.tool('patch_proxy_route', 'Edit an already-configured shared surface: its prefix, target or public allowlist, without resending the fields you are not changing and WITHOUT being able to publish it. Flipping the share on or off is set_proxy_enabled, deliberately, so exposure is never a side effect of fixing a path pattern. While the route is LIVE, any change to its prefix, its target, or an allowlist that is not a literal subset of the current one needs confirmPrefix (the check is deliberately conservative, so a semantic narrowing like "/" to "/$" asks too); edits to a withdrawn route never ask. Remember public patterns are matched AFTER the prefix is stripped: for prefix mrf write "/assets/", never "/mrf/assets/".',
  {
    project: z.string(),
    prefix: z.string().optional(),
    target: z.string().optional().describe('loopback dev server on this machine, INCLUDING the base path (http://127.0.0.1:5173/fe)'),
    public: z.array(z.string()).optional().describe('replaces the allowlist: literal paths, prefix-match by default, trailing $ for exact, one * inside a segment. [] means nothing is reachable, ["/"] means everything'),
    confirmPrefix: z.string().optional().describe('required only when the edit widens a live share: echo the prefix back'),
  },
  ({ project, confirmPrefix, ...rest }) => call(`/projects/${px(project)}/proxy`, 'PATCH', { ...rest, ...(confirmPrefix ? { confirm: confirmPrefix } : {}) }));

server.tool('set_proxy_enabled', 'Publish or withdraw the project shared surface, and nothing else. SECURITY: enabling puts a dev server running on this machine at BASE_URL/<prefix>/ where ANYONE holding that link reaches it — no login, no session, no per-person access, and the prefix is a short word rather than a secret. The public allowlist is the only boundary. Enabling therefore requires confirmPrefix to equal the configured prefix, so the decision is made with the URL in front of whoever owns it; the 400 you get without it states exactly what becomes reachable. Withdrawing needs no confirmation and keeps the config. The response reports whether the route is actually in the proxy table, since publishing is best effort.',
  {
    project: z.string(),
    enabled: z.boolean(),
    confirmPrefix: z.string().optional().describe('required to enable: the prefix, echoed back after a human has agreed to the exposure'),
  },
  ({ project, enabled, confirmPrefix }) => call(`/projects/${px(project)}/proxy/enabled`, 'PATCH', { enabled, ...(confirmPrefix ? { confirm: confirmPrefix } : {}) }));

server.tool('file_feedback', 'File a NEW finding as feedback (lanes use this). Lands in the same pending queue as human feedback. If what you have is MORE of something already filed — a screenshot for a row on the board, a correction, another screen it also happens on — use append_to_feedback instead: a second row for one defect puts it in the triage queue twice and leaves somebody deduping what was never two things.',
  {
    taskRef: z.string().optional(), project: z.string().optional(),
    author: z.string(), type: z.enum(['bug', 'design', 'idea', 'approval']).optional(),
    body: z.string(), ...T3_REF,
  },
  (args) => call('/feedback', 'POST', { ...args, authorType: 'agent' }));

server.tool('append_to_feedback', 'Add evidence or a follow-up detail to a feedback row that ALREADY EXISTS, so one finding stays one row. This is the tool that prevents the duplicate: an image sent for a finding already on the board was filed as a second row linked as a follow-up, one defect then sat in the triage queue twice, and the orchestrator had to dedupe something that was never two things. Use it whenever somebody is adding to something already filed (a screenshot, a correction, a second screen it also happens on) rather than reporting a new thing (file_feedback). The words go in `note`, not `body`: there is no `body` parameter, and one sent anyway gets a 400 asking for `note` rather than a 200 with your sentence gone. The row body is never replaceable, here or on PATCH /feedback, because nobody rewrites what its author wrote. The note lands at the END of that body under a line naming who added it and when, not one byte of the existing text changes, and `additions[]` carries the same fact structurally for a reader who should not have to parse prose. Attachments are unioned into the row\'s own attachments array, deduped against it AS IT STANDS AT WRITE TIME, so a url a concurrent append got in first is stored once and reported back as a warning. `author` is required (400 without it): there is no "unknown" default, since an addition nobody is named for is the silent rewrite wearing a label. Status is NOT touched and the reporter\'s slack thread is NOT replied to: appending to a resolved or rejected row succeeds with a warning that the addition sits in no triage queue, and reopening stays a deliberate act (resolve_feedback). Not idempotent — a repeat adds a second attributed line and says so.',
  {
    feedbackRef: z.string().describe('the existing row, short id like TST-FB-1 (404 if it does not exist; nothing is created here)'),
    author: z.string().describe('REQUIRED: whoever is ADDING this, not the person who filed the row. It is what the new line in the body is attributed to'),
    note: z.string().optional().describe('the words being added, in the terms they were given to you. Optional only when attachments are the whole point: note and attachments both empty is a 400 naming both'),
    attachments: z.array(z.string()).optional().describe('urls or paths of the evidence being added; they join the row\'s attachments (deduped) and the count appears in the attribution line'),
    authorType: z.enum(['agent', 'human']).optional().describe('defaults to agent, because an MCP caller is an agent session. Send human when you are relaying what a person handed you, so the human trail the board renders stays true'),
  },
  ({ feedbackRef, authorType, ...rest }) =>
    call(`/feedback/${encodeURIComponent(feedbackRef)}/append`, 'POST', { ...rest, authorType: authorType ?? 'agent' }));

server.tool('next_pending_feedback', 'The manager inbox: oldest-first pending + needs_clarification feedback.',
  { project: z.string().optional() },
  ({ project }) => call(`/feedback/pending${project ? `?project=${encodeURIComponent(project)}` : ''}`));

server.tool('get_feedback', 'ONE feedback row in ANY status, which is what next_pending_feedback cannot give you: that tool is the inbox and shows only pending and needs_clarification, so a row you triaged, resolved or rejected is invisible there and is here. Three things you can only learn by reading the row. First, whether an append actually landed: append_to_feedback is NOT idempotent, a repeat adds a second attributed line, so read `additions[]` before re-sending a call you are unsure about rather than paying for the guess. Second, what the current `resolution` text is, since resolve_feedback treats already-stored text as satisfying the requirement and that text is what gets posted into the reporter\'s own Slack thread. Third, `slack.channel` / `slack.ts`, which is where a needs_clarification answer will be, because a thread reply reopens the row to pending WITHOUT changing its body: the answer is in Slack and never on the row. `body` is the reporter\'s own words plus every append under its attribution line and is not rewritable anywhere in this API, so what you read here is the whole trail. Unknown short id is a 404. Read-only: nothing here changes a status or replies to anybody.',
  { feedbackRef: z.string().describe('short id like DAR-FB-7, case-insensitive. NOT a PARK-* id: a held report is not a feedback row and has no row to read (list_parked)') },
  ({ feedbackRef }) => call(`/feedback/${encodeURIComponent(feedbackRef)}`));

server.tool('resolve_feedback', 'Move feedback to a terminal or intermediate state. resolved, rejected and needs_clarification auto-reply IN THE REPORTER\'S OWN SLACK THREAD, with no orchestrator between you and them, and the reply body is your resolution text — so for those three it is REQUIRED (400 without it) and must read as something a stakeholder understands, not a note to a developer. triaged/accepted/in_progress/pending do not reply and do not need one. `pending` is REOPENING, and it is here because the append route\'s own closed-row warning names it ("if it should be looked at again, reopen the row on purpose") and this surface could not do what that sentence asked: an addition onto a resolved or rejected row sits in no triage queue until somebody puts the row back in one. It replies to nobody, and it does NOT erase the stored resolution — send a new one in the same call if the old text should not stand. Reopening a row filed on a task also puts that task back under the done gate, which is the point rather than a side effect.',
  {
    feedbackRef: z.string().describe('short id like TST-FB-1'),
    status: z.enum(['pending', 'triaged', 'accepted', 'in_progress', 'resolved', 'rejected', 'needs_clarification']),
    resolution: z.string().optional().describe('REQUIRED for resolved/rejected/needs_clarification: this exact text is posted to the reporter. What changed for them, why it is not being actioned, or what you need from them. Already-stored text counts, so a status flip after writing the reason is fine'),
    ...T3_REF,
    resolvedTaskRef: z.string().optional().describe('task this feedback became/was fixed by; the link the ship sweep follows to auto-resolve this row. An id that does not exist is a 404, not a silent unlink'),
  },
  ({ feedbackRef, ...rest }) => call(`/feedback/${feedbackRef}`, 'PATCH', (rest.status === 'accepted' || rest.status === 'in_progress') && T3_THREAD && rest.t3ThreadId === undefined ? { ...rest, t3ThreadId: T3_THREAD } : rest));

server.tool('list_parked', 'What Gabbar is HOLDING and has not filed: somebody wrote to it about a project, the stakeholder gate refused them, and instead of dropping their words the bot parked them on disk. Held items were made visible so the ORCHESTRATOR could see them, and an orchestrator\'s whole surface is MCP, so without this tool that visibility reaches nobody it was built for.\n\nNOTHING HERE IS FEEDBACK, and that is engineered rather than incidental. A held item never touches Mongo, so it cannot appear on get_board or next_pending_feedback; its id lives in the PARK-* namespace, which cannot collide with a <PREFIX>-FB-<n>; and every row carries filed:false and parked:true in every direction. A parkId is therefore NOT a feedbackRef: PARK-D0AH8292D7Y_1723... handed to get_feedback, resolve_feedback or append_to_feedback is a 404, and that 404 is four layers of defence working, not a lookup to retry another way. Nothing here is in a triage queue, has a feedback id, or has anybody working it. The only route to the board is PROMOTION, which runs back through the same gate and is Gabbar\'s job, not this tool\'s: for cause=stakeholder_gap the fix is a human decision, usually add_stakeholder for that person, after which the sweep promotes what was being held for them; cause=outage means darbar could not answer the gate at all, so it resolves itself on retry and needs nobody.\n\nTWO KINDS ARE HELD AND THEY PROMOTE IN OPPOSITE DIRECTIONS. A report is words nobody has filed, so promoting it CREATES a feedback row. An addition is evidence or a correction for a row that ALREADY EXISTS, so promoting it appends to that row and creates nothing — filing a fresh row for evidence about an existing finding is the exact duplicate that had to be removed once already, so promoting an addition down the report path fixes a loss by rebuilding a bug. Where a row carries `kind`, that is the field that tells them apart, with `appendTo` naming the row an addition belongs on and `addedToRow:false` beside it saying nothing has reached that row yet; an id here is a DESTINATION, never evidence of arrival. Where it does not (older held files, and this reader degrades a missing kind to "report" because that is what every file written before the distinction actually is), read `theirWords` and decide. Never infer "new finding" from the shape of this response.\n\nIT IS A DIRECTORY READ, NOT A QUERY, so the counts are the answer and `items` is a sample of it. `held` is the number that means pending work. Check `truncated` (more PARK-* files on disk than were opened; the cap applies in filename order, which drops the NEWEST) and `unreadable` (files that could not be parsed, counted rather than skipped, because a held report we cannot show is worse than one we know we cannot show) before treating items as everything. A non-null `error` means the directory could not be read AT ALL and must never be read as nothing held; dirPresent:false genuinely is nothing held, and is the ordinary state of a machine where nobody has ever been refused. `ignored` counts .json files that are not PARK-*, which are somebody else\'s files rather than reports we lost.\n\nLocal only, by an explicit check in the route rather than by a config file staying narrow: held words come from somebody the project has not vouched for and carry their slack id, so any request arriving through the share tunnel is refused 403.',
  {
    project: z.string().optional().describe('prefix, name or capId. Matched against what the reporter typed OR what Gabbar resolved; an item with NO project reference at all is returned on every project\'s read, flagged project:null, rather than filed somewhere nobody looks. Omit for every held item on this machine'),
    status: z.string().optional().describe('default "parked", which is the held-and-waiting work. "promoted" and "superseded" are history and stay one query away instead of padding the lane; "all" returns every status'),
  },
  ({ project, status }) => {
    const qs = new URLSearchParams();
    if (project) qs.set('project', project);
    if (status) qs.set('status', status);
    const q = qs.toString();
    return call(`/parked${q ? `?${q}` : ''}`);
  });

server.tool('log_event', 'Append to the project event log (the resume trail).',
  { project: z.string(), taskRef: z.string().optional(), text: z.string() },
  (args) => call('/events', 'POST', args));

// ---------- memory graph (DAR-274) ----------
// A graph, not a bag of notes: NODES are entities (a decision, a gotcha, a person, a service, a
// repo, a project, a preference, a reference), EDGES are typed relations between two nodes with a validity
// window (validAt, and invalidAt once superseded), and EPISODES are provenance — a record of what
// write produced what, not a node or edge themselves. Scoped by project, or left global (a gotcha
// true of the whole machine, a person who spans projects) by omitting project on remember.
//
// NOTHING IS EVER DELETED. remember() only ever inserts a node or appends an observation to one
// that already exists (deduped by the lowercase-kebab slug of its name, within the same project
// scope); it upserts edges the same way, one currently-valid edge per (from, to, relation) triple.
// supersede() is the only way an edge stops being current, and even then it is not removed: its
// invalidAt is stamped and it stays in the collection forever, while a new SUPERSEDES edge records
// what replaced it. recall() only walks edges with invalidAt:null by default, so a superseded fact
// quietly stops showing up — asOf is how you look at the graph as it stood at a past moment instead,
// which a superseded edge can still answer for, as long as it was valid at that moment.
//
// recall() is TEXT SEARCH plus a bounded graph walk, not semantic search and not an LLM anywhere in
// this path: it $text-matches node names and observations, then follows edges outward from each
// match up to `hops` (1 or 2) deep, and returns node names + observations + the edges it actually
// walked — never the full graph and never node bodies you did not ask for.
const MEMORY_TYPE = z.enum(['decision', 'gotcha', 'person', 'service', 'repo', 'project', 'preference', 'reference']);

server.tool('remember', 'Write to the memory graph: create or update ONE node, and optionally link it to nodes that already exist. DEDUPES BY SLUG (lowercase-kebab of the name) within the project scope (or the global scope when project is omitted): calling this again for a node you already remembered does NOT overwrite it, it APPENDS your new observations to the ones already there and leaves the rest of the node untouched, exactly like the reference MCP memory server\'s entity/observation model. This is the only write door for a node\'s content; there is no edit or delete anywhere in this API. `type` is REQUIRED the first time you remember a node; on a node that already exists you may OMIT it and the existing type is kept — but sending a DIFFERENT type than what is already stored is refused with a 409 naming the existing type and slug, never silently changed. Node types: decision, gotcha, person, service, repo, project, preference, reference (reference is for a URL/dashboard/ticket — a settled pointer, not a decision). `edges` link this node to OTHER nodes that must already exist (created by an earlier remember call): a `to` name resolves in YOUR scope first (the project you passed, if any), then the global scope, preferring a project match over a same-slug global one — a global caller only ever finds global nodes, never a project-only one — and a name not found in either is a 404 telling you to remember it first, nothing here silently creates a stub on the other end. Each edge is upserted: sending the same (to, relation) pair again NEVER erases what is already stored — with no `source` it keeps the one already there, and `confidence` only ever moves up, never down; every source it is ever given is kept in history. An observation whose text exactly matches one already on the node is silently skipped, not appended a second time. `SUPERSEDES` is a reserved relation name written only by the supersede tool and is refused here. There is no LLM in this path: you name the entity, the type and the relation, and the store holds exactly what you send.',
  {
    node: z.object({
      name: z.string().describe('the entity\'s name, up to 200 chars; slugified (lowercase-kebab, ascii-folded) for dedup, so "Mars flag precedence" and "mars-flag-precedence" address the same node, and so do "Cafe" and "Café" — the fold is on purpose'),
      type: MEMORY_TYPE.optional().describe('required when this node does not exist yet; optional (and ignored in favor of the stored type) once it does — a different type than what is stored is a 409, not a silent change'),
      project: z.string().optional().describe('prefix, name, or capId to scope this node to one project; omit for a GLOBAL node (a person, a gotcha true of the whole machine) visible from every project\'s recall'),
    }),
    observations: z.array(z.union([
      z.string(),
      z.object({ text: z.string(), source: z.string().optional() }),
    ])).optional().describe('things learned about this node, appended (never overwritten) to what is already stored. A bare string is stored with source "unknown"; send {text, source} to say where it came from (a session id, a task ref, a person)'),
    edges: z.array(z.object({
      to: z.string().describe('name of an EXISTING node in the same project scope to link to (404 if it does not exist yet)'),
      relation: z.string().describe('e.g. DECIDED_FOR, BLOCKED_ON, OWNS, FIXES, RELATES_TO — open vocabulary, but not "SUPERSEDES" (reserved for the supersede tool)'),
      confidence: z.number().min(0).max(1).optional().describe('how sure you are, 0-1; default 1'),
      source: z.object({ session: z.string().optional(), harness: z.string().optional(), taskRef: z.string().optional() }).optional(),
    })).optional().describe('relations FROM this node to others that already exist'),
  },
  (args) => call('/memory/remember', 'POST', args));

server.tool('recall', 'Search the memory graph: $text-match node names and observations against `q`, then walk outward along edges (either direction — a hub node surfaces what points AT it, not just what it points to) up to `hops` deep (1 or 2, default 1), and return the node names + observations + the edges actually walked — not the whole graph, not full bodies of everything reachable. Only CURRENTLY VALID edges are walked by default (a superseded one is invisible here, on purpose), and a node that was itself superseded (via the supersede tool\'s `nodeName` form) is excluded by default too, its replacement is the thing you want; pass `asOf` to see the graph as it stood at a past moment instead, which a since-superseded edge or node can still answer for, or `includeSuperseded: true` to see a stale node anyway, with `supersededBy` filled in so you can follow it. Results are ranked by text-match score first, then by how many hops away a related node is, capped at `limit` primary matches (default 20, max 50). Scope with `project` to search one project\'s memory plus anything global; omit it to search the global scope only. `type` narrows the PRIMARY text match to one node type (decision, gotcha, person, service, repo, project, preference, reference) — nodes reached by a walked edge are returned regardless of their type.',
  {
    q: z.string().describe('search text, matched against node names and every observation ever recorded on them'),
    project: z.string().optional().describe('prefix, name, or capId; omit to search only the global scope'),
    type: MEMORY_TYPE.optional(),
    hops: z.union([z.literal(1), z.literal(2)]).optional().describe('graph walk depth from each text match, 1 or 2 (default 1). Never more than 2'),
    asOf: z.string().optional().describe('ISO timestamp; walk edges as they stood at this moment instead of the current graph, so a since-superseded edge that was valid then is still walked, and a node superseded after this moment is still shown'),
    limit: z.number().int().min(1).max(50).optional().describe('max PRIMARY text-match nodes to rank and walk from; default 20, max 50'),
    includeSuperseded: z.boolean().optional().describe('include nodes that were superseded (nodeName form of the supersede tool); default false. Returned nodes carry `supersededBy` when this is on'),
  },
  ({ q, project, type, hops, asOf, limit, includeSuperseded }) => {
    const qs = new URLSearchParams({ q });
    if (project) qs.set('project', project);
    if (type) qs.set('type', type);
    if (hops) qs.set('hops', String(hops));
    if (asOf) qs.set('asOf', asOf);
    if (limit) qs.set('limit', String(limit));
    if (includeSuperseded) qs.set('includeSuperseded', String(includeSuperseded));
    return call(`/memory/recall?${qs}`);
  });

server.tool('supersede', 'Replace a fact on the memory graph WITHOUT deleting anything. Exactly one of `edgeId` (supersede one specific relation) or `nodeName` (supersede everything this node currently asserts, i.e. every currently-valid edge FROM it, AND the node itself) is required. Either way this: (1) stamps `invalidAt` on what is being replaced — the edge (and, for `nodeName`, the node) is never removed, it just stops being walked/returned by an ordinary recall; and (2) inserts a NEW edge, relation SUPERSEDES, from `by` (a node that must already exist — remember it first; resolved in your scope first, then the global scope, project match preferred, and a global caller only ever finds a global `by`) to the node whose assertion was just invalidated. Use `edgeId` when you know exactly which relation is wrong (get it from a prior recall\'s edge list, or the id remember returned). Use `nodeName` for "this whole node\'s current facts are stale, here is what replaced them" — every currently-valid outgoing edge on it is invalidated in one call, the node itself is stamped with `invalidAt`/`supersededBy`, and recall stops returning it by default (pass `includeSuperseded` to see it anyway). Nothing is ever deleted anywhere in this path: a superseded edge, and the node it came from, both remain in the graph forever and are reachable again with recall\'s `asOf` or `includeSuperseded`.',
  {
    edgeId: z.string().optional().describe('the edge to supersede, e.g. from a recall result or remember\'s response. Mutually exclusive with nodeName'),
    nodeName: z.string().optional().describe('supersede every currently-valid edge FROM this node. Mutually exclusive with edgeId'),
    by: z.string().describe('name of the EXISTING node that replaces what is being superseded (must already be remembered)'),
    project: z.string().optional().describe('scope both the target and `by` are looked up in; omit for the global scope'),
    source: z.object({ session: z.string().optional(), harness: z.string().optional(), taskRef: z.string().optional() }).optional(),
  },
  (args) => call('/memory/supersede', 'POST', args));

await server.connect(new StdioServerTransport());
