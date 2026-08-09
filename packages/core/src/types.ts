import type { ObjectId } from 'mongodb';

export type Stakeholder = { name: string; slackUserId?: string; role?: string };

// review pipeline: lanes spawned as subtasks when a dev task hits in_review.
// autoAdvance: parent leaves in_review by itself when the last review child closes.
export type ReviewLane = { lane: string; label: string; manager: string };
export type Pipeline = { autoAdvance: boolean; reviews: ReviewLane[] };

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
  counters: { task: number; feedback: number };
  createdAt: Date;
};

// jira-style workflow; blocked stays a status (visible column) with the free-text `blocker` field carrying the why
export type TaskStatus = 'backlog' | 'todo' | 'in_progress' | 'in_review' | 'qa' | 'blocked' | 'done' | 'cancelled';
// review tasks are pipeline-spawned children: they render as pips on the parent card, never as kanban cards
export type TaskType = 'feature' | 'bug' | 'chore' | 'review' | 'regression';
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
  createdAt: Date;
  updatedAt: Date;
};

export type SlackRef = { channel: string; ts: string; user: string };

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
