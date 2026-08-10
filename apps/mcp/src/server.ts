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

server.tool('get_project_context', 'Fetch a project charter: protocols, repos, stakeholders, the review pipeline (lanes + managers + autoAdvance), the agent registry (lane managers, helpers, orchestrator — each with its standing brief), and the shared-surface proxy (prefix, allowlist, enabled — the upstream target is redacted here, use get_proxy_route for that). Every agent should read this before working, and it is the read side of every config edit tool. `configured` says which surfaces exist at all, since the fields themselves normalise absent to []/null and cannot otherwise be told apart from a surface that was cleared.',
  { project: z.string().describe('project prefix, name, or capId') },
  ({ project }) => call(`/projects/${encodeURIComponent(project)}/context`));

server.tool('list_projects', 'List registered projects with board URLs.', {}, () => call('/projects'));

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
    type: TYPE.optional(), status: STATUS.optional(),
    blocker: z.string().optional().describe('why this task cannot be started, when you are filing it already blocked. It is applied at create now; it used to be dropped under a 200, which put blocked cards on the board with no why on them. Changing or clearing it later is update_task {blocker} / {blocker: null}'),
    lanes: z.array(z.string()).optional().describe('review lanes to spawn when this task hits in_review — pick by judgment: code-review for code changes, qa for behavior/outcomes, design-qa only for UI surfaces; [] = explicitly no reviews; omit = all configured lanes'),
  },
  (args) => call('/tasks', 'POST', args));

server.tool('update_task', 'Update a task row: status, blocker, notes, dispatched, or append a commit hash. Moving a dev task to in_review auto-spawns the project pipeline review lanes; done is rejected (409) while review children are open; closing the last review child auto-advances the parent when the project has autoAdvance on. origin, parentage, shortId, the project and the commits array are create-time or append-only and are refused here with a 400 rather than accepted and ignored.',
  {
    taskRef: z.string().describe('short id like TST-1'),
    status: STATUS.optional(),
    assignee: z.string().optional(), blocker: z.string().nullable().optional(),
    notes: z.string().optional(), addCommit: z.string().optional(), type: TYPE.optional(),
    dispatched: z.boolean().optional().describe('true the moment you hand this task to an agent. The server stamps the time and the board shows the card as dispatched with its age, so work in flight stops reading as idle. The agent PATCHing its own status clears it. Send false only to write off a dispatch that never started'),
    lanes: z.array(z.string()).optional().describe('re-pick review lanes (code-review for code, qa for behavior, design-qa for UI; [] = none); only before the task enters in_review — frozen after'),
  },
  ({ taskRef, ...rest }) => call(`/tasks/${taskRef}`, 'PATCH', rest));

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
    slackUserId: z.string().optional().describe('slack USER id, e.g. U08SXQF8RTQ — NOT a display name and not a channel id. This exact string is what the feedback gate matches'),
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

server.tool('update_review_lane', 'Reassign ONE lane\'s manager, or change its label or key, keeping every other lane. Renaming the KEY is gated: lane selection on a task is frozen once it enters review and is never re-validated, so open tasks that named the old key and nothing else would silently match no lane, skip review entirely and (with autoAdvance) go straight to done unreviewed. The 409 names those tasks and says which end state each one lands in; force repeats the call anyway. Tasks that also select a surviving lane are reported as a warning rather than gated, and tasks with no lanes field are unaffected by a rename since they take whatever the pipeline holds.',
  {
    project: z.string(),
    lane: z.string().describe('current lane key'),
    manager: z.string().optional(),
    label: z.string().optional(),
    rename: z.string().optional().describe('new lane key'),
    force: z.boolean().optional().describe('only for a rename that would strand open tasks; send it after reading the task list in the 409'),
  },
  ({ project, lane, ...rest }) => call(`/projects/${px(project)}/pipeline/lanes/${px(lane)}`, 'PATCH', rest));

server.tool('remove_review_lane', 'Remove ONE review lane, keeping the others. Gated on any open task the removal would leave with no review, and the 409 distinguishes the two end states, because they are not the same: a task that named only this lane skips review and auto-advances to DONE unreviewed, while a task with no lanes field (the default of all lanes) that loses the LAST lane spawns nothing, logs nothing and STALLS in in_review. Tasks that keep another lane are warned about, not gated. Pass force after reading the list.',
  { project: z.string(), lane: z.string(), force: z.boolean().optional() },
  ({ project, lane, force }) => call(`/projects/${px(project)}/pipeline/lanes/${px(lane)}${force ? '?force=true' : ''}`, 'DELETE'));

server.tool('set_auto_advance', 'Flip only the pipeline\'s autoAdvance: true = the parent task leaves in_review by itself when the last review lane closes, false = it waits for an explicit push. set_pipeline cannot do this alone, because it requires the full lane list and would wipe it if omitted.',
  { project: z.string(), autoAdvance: z.boolean() },
  ({ project, autoAdvance }) => call(`/projects/${px(project)}/pipeline`, 'PATCH', { autoAdvance }));

server.tool('set_repos', 'Set the repos a project is worked in. The charter tells every builder which checkout it is in and this list is the machine-readable half of that, so losing it hands agents the wrong repo: PATCH /projects had no branch for `repos` at all, and {charter, repos} applied the charter and dropped the repos under a 200. WHOLESALE, like every other list on the project document: what you send becomes the list, so ADD a repo by sending the existing entries plus the new one (get_project_context returns them) and repos: [] clears it — a single-element array here is not "add one", it is "these are now the only repos". A non-string entry is a 400 rather than a quietly filtered array.',
  { project: z.string(), repos: z.array(z.string()).describe('the full repo list after this edit, in the terms the charter uses (a name like "darbar", or a path); it replaces whatever is stored') },
  ({ project, repos }) => call(`/projects/${px(project)}`, 'PATCH', { repos }));

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
    body: z.string(),
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

server.tool('resolve_feedback', 'Move feedback to a terminal or intermediate state. resolved, rejected and needs_clarification auto-reply IN THE REPORTER\'S OWN SLACK THREAD, with no orchestrator between you and them, and the reply body is your resolution text — so for those three it is REQUIRED (400 without it) and must read as something a stakeholder understands, not a note to a developer. triaged/accepted/in_progress do not reply and do not need one.',
  {
    feedbackRef: z.string().describe('short id like TST-FB-1'),
    status: z.enum(['triaged', 'accepted', 'in_progress', 'resolved', 'rejected', 'needs_clarification']),
    resolution: z.string().optional().describe('REQUIRED for resolved/rejected/needs_clarification: this exact text is posted to the reporter. What changed for them, why it is not being actioned, or what you need from them. Already-stored text counts, so a status flip after writing the reason is fine'),
    resolvedTaskRef: z.string().optional().describe('task this feedback became/was fixed by; the link the ship sweep follows to auto-resolve this row. An id that does not exist is a 404, not a silent unlink'),
  },
  ({ feedbackRef, ...rest }) => call(`/feedback/${feedbackRef}`, 'PATCH', rest));

server.tool('log_event', 'Append to the project event log (the resume trail).',
  { project: z.string(), taskRef: z.string().optional(), text: z.string() },
  (args) => call('/events', 'POST', args));

await server.connect(new StdioServerTransport());
