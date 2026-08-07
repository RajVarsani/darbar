import type { ObjectId } from 'mongodb';

export type Stakeholder = { name: string; slackUserId?: string; role?: string };

export type Project = {
  _id?: ObjectId;
  name: string;
  prefix: string;
  capId: string;
  repos: string[];
  charter: string;
  stakeholders: Stakeholder[];
  slackChannel: string | null;
  counters: { task: number; feedback: number };
  createdAt: Date;
};

export type TaskStatus = 'backlog' | 'todo' | 'in_progress' | 'qa' | 'review' | 'blocked' | 'done';
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
