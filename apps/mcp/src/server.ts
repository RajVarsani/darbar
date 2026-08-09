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

server.tool('get_project_context', 'Fetch a project charter: protocols, repos, stakeholders. Every agent should read this before working.',
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
    assignee: z.string().describe('exact assignee name, e.g. qa-manager'),
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
      manager: z.string().describe('agent the spawned task is assigned to, e.g. qa-manager'),
    })),
  },
  ({ project, ...rest }) => call(`/projects/${encodeURIComponent(project)}`, 'PATCH', { pipeline: rest }));

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
