// Parking lot for reports the stakeholder gate refused.
//
// The gate in agent.ts fails closed on the verified slack sender id, which is correct.
// The bug it caused was that a refusal ALSO threw the report away: Tanisha's calendar bug
// and its screen recording survived only because Raj happened to be reading the thread.
//
// A parked item is held here instead. It is deliberately NOT a feedback row:
//   - it never touches mongo, so GET /feedback/pending and the board cannot show it
//   - its id lives in the PARK-* namespace, which can never collide with <PREFIX>-FB-<n>
//   - every read path returns it with filed:false attached
// so there is no surface on which a parked item can pass for filed feedback. Promotion into
// a real feedback row is the only way it becomes one, and that runs through the same gate.
//
// One file per parked item, keyed by the slack message it came from, so a model that retries
// the same message with a different project ref refines one parked item instead of piling up.
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(process.env.PARKED_DIR || new URL('../../../data/parked/', import.meta.url).pathname);

export type ParkedStatus =
  | 'parked' // held, nothing filed
  | 'promoted' // became a real feedback row (see promotion.feedbackShortId)
  | 'superseded'; // the same message went on to file for real in the same turn

export type ParkedItem = {
  parkId: string;
  status: ParkedStatus;
  createdAt: string;
  updatedAt: string;
  author: { slackUserId: string; name: string };
  target: { projectRef: string | null; projectName: string | null; taskRef: string | null };
  feedbackType: string;
  /** what the model distilled, kept only as a convenience */
  body: string;
  /** the sender's own words, verbatim from the verified slack payload — the thing that must not be lost */
  rawMessage: string;
  /** darbar /files/ urls; the bytes are already on disk and outlive the slack message */
  attachments: string[];
  /** frame urls / read notes for any attached recording, so the evidence is legible later */
  mediaNotes: string[];
  slack: { channel: string; ts: string; threadTs: string | null };
  gate: { kind: string; detail: string };
  promotion: { at: string; feedbackShortId: string; promotedBy: string } | null;
  supersededBy: string | null;
};

function slackKey(channel: string, ts: string): string {
  return `${channel}-${ts}`.replace(/[^A-Za-z0-9]+/g, '_');
}

export function parkIdFor(channel: string, ts: string): string {
  return `PARK-${slackKey(channel, ts)}`;
}

/** PARK-* is a namespace of its own on purpose: nothing here can be mistaken for a feedback id. */
export function isParkId(s: string): boolean {
  return /^PARK-[A-Za-z0-9_]+$/.test(s.trim());
}

function fileFor(parkId: string): string {
  return path.join(ROOT, `${parkId}.json`);
}

function writeItem(item: ParkedItem): void {
  fs.mkdirSync(ROOT, { recursive: true });
  const target = fileFor(item.parkId);
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(item, null, 2)}\n`);
  fs.renameSync(tmp, target); // never leave a half-written report behind
}

export function readParked(parkId: string): ParkedItem | null {
  if (!isParkId(parkId)) return null;
  try {
    const raw = fs.readFileSync(fileFor(parkId.trim()), 'utf-8');
    const item = JSON.parse(raw) as ParkedItem;
    return item && typeof item.parkId === 'string' ? item : null;
  } catch {
    return null;
  }
}

export type ParkInput = {
  channel: string;
  ts: string;
  threadTs: string | null;
  authorId: string;
  authorName: string;
  projectRef: string | null;
  projectName: string | null;
  taskRef: string | null;
  feedbackType: string;
  body: string;
  rawMessage: string;
  attachments: string[];
  mediaNotes: string[];
  gateKind: string;
  gateDetail: string;
};

/**
 * Hold a refused report. Upserts on the slack message, and never overwrites an item that
 * already reached a terminal state — once something is really filed, the record of how it
 * got there stops changing.
 */
export function parkReport(input: ParkInput): ParkedItem {
  const parkId = parkIdFor(input.channel, input.ts);
  const existing = readParked(parkId);
  if (existing && existing.status !== 'parked') return existing;
  const now = new Date().toISOString();
  const item: ParkedItem = {
    parkId,
    status: 'parked',
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    author: { slackUserId: input.authorId, name: input.authorName },
    target: { projectRef: input.projectRef, projectName: input.projectName, taskRef: input.taskRef },
    feedbackType: input.feedbackType,
    body: input.body,
    rawMessage: input.rawMessage,
    attachments: input.attachments,
    mediaNotes: input.mediaNotes,
    slack: { channel: input.channel, ts: input.ts, threadTs: input.threadTs },
    gate: { kind: input.gateKind, detail: input.gateDetail },
    promotion: null,
    supersededBy: null,
  };
  try {
    writeItem(item);
  } catch (e) {
    console.error('gabbar: failed to park report:', e);
  }
  return item;
}

export function listParked(filter?: { status?: ParkedStatus; authorId?: string }): ParkedItem[] {
  let names: string[];
  try {
    names = fs.readdirSync(ROOT).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  const out: ParkedItem[] = [];
  for (const n of names) {
    const item = readParked(n.slice(0, -'.json'.length));
    if (!item) continue;
    if (filter?.status && item.status !== filter.status) continue;
    if (filter?.authorId && item.author.slackUserId !== filter.authorId) continue;
    out.push(item);
  }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function markPromoted(parkId: string, feedbackShortId: string, promotedBy: string): ParkedItem | null {
  const item = readParked(parkId);
  if (!item || item.status !== 'parked') return null;
  const updated: ParkedItem = {
    ...item,
    status: 'promoted',
    updatedAt: new Date().toISOString(),
    promotion: { at: new Date().toISOString(), feedbackShortId, promotedBy },
  };
  try {
    writeItem(updated);
  } catch (e) {
    console.error('gabbar: failed to mark parked item promoted:', e);
  }
  return updated;
}

/**
 * The gate refused once, the model then filed successfully for the same slack message.
 * Retire the parked copy so the queue never shows a duplicate of something already filed.
 */
export function markSuperseded(channel: string, ts: string, feedbackShortId: string): void {
  const item = readParked(parkIdFor(channel, ts));
  if (!item || item.status !== 'parked') return;
  try {
    writeItem({ ...item, status: 'superseded', updatedAt: new Date().toISOString(), supersededBy: feedbackShortId });
  } catch (e) {
    console.error('gabbar: failed to mark parked item superseded:', e);
  }
}

/** Shape handed to the model. filed:false rides along on every row, in every direction. */
export function summarize(item: ParkedItem) {
  return {
    parkId: item.parkId,
    filed: false,
    parked: true,
    status: item.status,
    author: item.author.name,
    authorSlackId: item.author.slackUserId,
    project: item.target.projectName ?? item.target.projectRef,
    onTask: item.target.taskRef,
    type: item.feedbackType,
    body: item.body,
    theirWords: item.rawMessage.slice(0, 600),
    attachments: item.attachments,
    mediaNotes: item.mediaNotes,
    heldSince: item.createdAt,
    reasonParked: item.gate.detail,
    promotedTo: item.promotion?.feedbackShortId ?? null,
  };
}

/**
 * A row was created in this person's name, so they are told, by code.
 *
 * Asking the model to mention it was not enough: the sweep's notices were handed to the 500
 * token haiku chat turn, which answered a bare "thanks yaar" with "welcome, what's up" and never
 * mentioned the row it had just filed for them. Silent filing is the same honesty failure as
 * silently dropping the report, pointing the other way, so the id is appended here unless the
 * reply already carries it.
 */
export function withFilingNotice(reply: string, filedNow: string[]): string {
  const missing = filedNow.filter((id) => !reply.includes(id));
  if (!missing.length) return reply;
  const [one] = missing;
  const tail = missing.length > 1
    ? `your earlier reports that were being held are now filed as ${missing.join(' and ')}`
    : `your earlier report that was being held is now filed as ${one}`;
  return `${reply.trim()}\n\nalso: ${tail}.`;
}
