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

server.tool('get_project_context', 'Fetch a project charter: protocols, repos, stakeholders, and the agent registry (lane managers, helpers, orchestrator — each with its standing brief). Every agent should read this before working.',
  { project: z.string().describe('project prefix, name, or capId') },
  ({ project }) => call(`/projects/${encodeURIComponent(project)}/context`));

server.tool('list_projects', 'List registered projects with board URLs.', {}, () => call('/projects'));

server.tool('get_board', 'Full board for a project: tasks, feedback, recent events.',
  { capId: z.string().describe('project capability id') },
  ({ capId }) => call(`/p/${capId}`));

const STATUS = z.enum(['backlog', 'todo', 'in_progress', 'in_review', 'qa', 'blocked', 'done', 'cancelled']);
const TYPE = z.enum(['feature', 'bug', 'chore', 'review', 'regression']);

server.tool('create_task', 'Create a task (or subtask via parentTaskRef). Only the orchestrator promotes feedback into tasks. Review subtasks are pipeline-spawned by the server — do not create type=review tasks by hand.',
  {
    project: z.string(), title: z.string(), description: z.string().optional(),
    parentTaskRef: z.string().optional(), assignee: z.string().optional(),
    assigneeType: z.enum(['agent', 'human']).optional(), origin: z.string().optional(),
    type: TYPE.optional(), status: STATUS.optional(),
    lanes: z.array(z.string()).optional().describe('review lanes to spawn when this task hits in_review — pick by judgment: code-review for code changes, qa for behavior/outcomes, design-qa only for UI surfaces; [] = explicitly no reviews; omit = all configured lanes'),
  },
  (args) => call('/tasks', 'POST', args));

server.tool('update_task', 'Update a task row: status, blocker, notes, or append a commit hash. Moving a dev task to in_review auto-spawns the project pipeline review lanes; done is rejected (409) while review children are open; closing the last review child auto-advances the parent when the project has autoAdvance on.',
  {
    taskRef: z.string().describe('short id like TST-1'),
    status: STATUS.optional(),
    assignee: z.string().optional(), blocker: z.string().nullable().optional(),
    notes: z.string().optional(), addCommit: z.string().optional(), type: TYPE.optional(),
    lanes: z.array(z.string()).optional().describe('re-pick review lanes (code-review for code, qa for behavior, design-qa for UI; [] = none); only before the task enters in_review — frozen after'),
  },
  ({ taskRef, ...rest }) => call(`/tasks/${taskRef}`, 'PATCH', rest));

server.tool('my_tasks', 'Open tasks for an assignee (lane managers and builders start here). Optionally scope by project or lane.',
  {
    assignee: z.string().describe('exact assignee name, e.g. qa-lead'),
    project: z.string().optional(), lane: z.string().optional(),
  },
  ({ assignee, project, lane }) => {
    const qs = new URLSearchParams({ assignee, open: 'true' });
    if (project) qs.set('project', project);
    if (lane) qs.set('lane', lane);
    return call(`/tasks?${qs}`);
  });

server.tool('set_pipeline', 'Configure the review pipeline for a project: lanes spawned as subtasks when a dev task hits in_review, each assigned to its lane manager. autoAdvance moves the parent to done when the last lane closes.',
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

server.tool('set_agents', 'Register the project agent registry: lane managers, helpers, and the orchestrator. Replaces the whole list. Pipeline review managers should exist here — the server logs a warning event when one is missing. Names must be unique (they are the assignee key); agents: [] clears the registry and will warn for every pipeline manager.',
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

server.tool('set_proxy', 'Share a LOCAL dev server for this project through the public proxy, at BASE_URL/<prefix>/. SECURITY: while enabled, anyone who has the link can reach that target — there is no login in front of it. The public patterns ARE the boundary: only paths matching one of them are served to tunneled requests (local access is never filtered), so ["/"] means the whole app is exposed and omitting them means nothing is. Default is enabled:false — configure first, share deliberately. Replaces the whole proxy config; the server pushes it into the proxy route table and reconciles the two at every change and at boot, so a failed push is repaired rather than left as silent drift. The target is never shown on the public board (a link-holder must not learn the internal host:port); it is on get_project_context, which is local-only.',
  {
    project: z.string(),
    prefix: z.string().describe('URL segment this project is served at, [A-Za-z0-9_-]; it is the routing key, so a prefix already claimed by another project OR already live on the proxy as a hand-added route is rejected 409'),
    target: z.string().describe('http(s) URL of a dev server on THIS machine — loopback only (localhost, 127.0.0.0/8, ::1, or an unspecified address like 0.0.0.0 / ::, which connect to loopback); a public host, a LAN/private address, ANY DNS name (including *.localhost, which is resolved at request time and can point anywhere), or a link-local/metadata address is rejected 400, because the proxy is publicly reachable through the tunnel and would relay to it. No query, fragment or user:pass@ (credentials are never sent upstream, so they would only end up stored). INCLUDE THE PATH when the dev server has a base: a Vite app served at base /fe needs http://127.0.0.1:5173/fe, not http://127.0.0.1:5173 — without it Vite receives / and 302s to /fe/ forever through the prefix strip'),
    public: z.array(z.string()).optional().describe('allowlist of paths reachable from outside. These are NOT regular expressions — each entry is a literal path starting with "/", matching as a PREFIX by default ("/assets/"), with a trailing "$" for an exact path ("/$" = the root and nothing else) and at most one "*" matching within a single path segment ("/assets/*.js$"). Anything else — "^", "(", "[", "+", "\\", ".*" — is rejected 400 with the form spelled out, because the proxy matches these with string operations only: a regex allowlist on a shared front door was a denial-of-service hole no validation could close. Omit = nothing is reachable through the tunnel; ["/"] exposes every path'),
    enabled: z.boolean().optional().describe('default false. true publishes the route immediately; false withdraws it while keeping the config'),
  },
  ({ project, ...rest }) => call(`/projects/${encodeURIComponent(project)}`, 'PATCH', { proxy: rest }));

server.tool('file_feedback', 'File a finding as feedback (lanes use this). Lands in the same pending queue as human feedback.',
  {
    taskRef: z.string().optional(), project: z.string().optional(),
    author: z.string(), type: z.enum(['bug', 'design', 'idea', 'approval']).optional(),
    body: z.string(),
  },
  (args) => call('/feedback', 'POST', { ...args, authorType: 'agent' }));

server.tool('next_pending_feedback', 'The manager inbox: oldest-first pending + needs_clarification feedback.',
  { project: z.string().optional() },
  ({ project }) => call(`/feedback/pending${project ? `?project=${encodeURIComponent(project)}` : ''}`));

server.tool('resolve_feedback', 'Move feedback to a terminal or intermediate state. resolved/rejected/needs_clarification auto-reply in the original Slack thread.',
  {
    feedbackRef: z.string().describe('short id like TST-FB-1'),
    status: z.enum(['triaged', 'accepted', 'in_progress', 'resolved', 'rejected', 'needs_clarification']),
    resolution: z.string().optional().describe('shown to the author — reason, fix note, or the clarifying question'),
    resolvedTaskRef: z.string().optional().describe('task this feedback became/was fixed by'),
  },
  ({ feedbackRef, ...rest }) => call(`/feedback/${feedbackRef}`, 'PATCH', rest));

server.tool('log_event', 'Append to the project event log (the resume trail).',
  { project: z.string(), taskRef: z.string().optional(), text: z.string() },
  (args) => call('/events', 'POST', args));

await server.connect(new StdioServerTransport());
