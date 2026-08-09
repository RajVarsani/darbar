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

/**
 * WHY it is held, which decides what happens next.
 *
 * `stakeholder_gap` is a human's decision to make, so the item waits and the owner is pinged at
 * park time. `outage` means darbar could not answer, so we never learned whether they are a
 * stakeholder: that resolves by itself, so it retries and nobody is pinged per message. Telling
 * the two apart is the whole fix; before this they were both just "could not verify".
 */
export type ParkCause = 'stakeholder_gap' | 'outage' | 'bad_reference';

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
  cause: ParkCause;
  /** last time the sweep spent a gate check on this item; null means never tried */
  lastAttemptAt: string | null;
  /** last time the owner was told this is still sitting here, so a digest cannot repeat daily */
  escalatedAt: string | null;
  escalations: number;
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
    if (!item || typeof item.parkId !== 'string') return null;
    // defaults for records written before a cause was recorded: an unknown cause is treated as a
    // gap, which is the conservative choice (it waits for a human instead of retrying quietly)
    return {
      ...item,
      cause: item.cause ?? 'stakeholder_gap',
      lastAttemptAt: item.lastAttemptAt ?? null,
      escalatedAt: item.escalatedAt ?? null,
      escalations: item.escalations ?? 0,
    };
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
  cause: ParkCause;
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
    cause: input.cause,
    lastAttemptAt: existing?.lastAttemptAt ?? null,
    escalatedAt: existing?.escalatedAt ?? null,
    escalations: existing?.escalations ?? 0,
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
    cause: item.cause,
    lastAttemptAt: item.lastAttemptAt,
    reasonParked: item.gate.detail,
    escalatedAt: item.escalatedAt,
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

// ---------- escalation: nothing may sit here unseen ----------
//
// Parking fixed "a refusal loses the report" and created a smaller version of the same failure:
// a held item nobody is told about sits in a directory until a human happens to read it. So a
// held report is re-surfaced to the owner on a bounded clock, and DELIBERATELY NEVER EXPIRES.
//
// Expiry was the obvious alternative and it is wrong: deleting someone's report because nobody
// acted on it trades a visibility problem for a data-loss problem, which is the exact thing this
// whole mechanism exists to prevent. Escalation keeps the item and raises the pressure instead.
//
// The first delay depends on what the owner already knows. A stakeholder gap pinged them at park
// time, so it waits a day before nagging. An outage or a bad reference pinged nobody at all, so
// it surfaces within the hour. After that everything repeats daily, as ONE digest rather than a
// message per item.
export const FIRST_ESCALATION_MS: Record<ParkCause, number> = {
  stakeholder_gap: 24 * 60 * 60 * 1000,
  outage: 60 * 60 * 1000,
  bad_reference: 60 * 60 * 1000,
};
export const REPEAT_ESCALATION_MS = 24 * 60 * 60 * 1000;

/** held items the owner is owed an update about. Pure, so the clock can be tested. */
export function dueForEscalation(now: number = Date.now(), items?: ParkedItem[]): ParkedItem[] {
  return (items ?? listParked({ status: 'parked' })).filter((item) => {
    if (item.status !== 'parked') return false;
    if (item.escalatedAt) return now - Date.parse(item.escalatedAt) >= REPEAT_ESCALATION_MS;
    const age = now - Date.parse(item.createdAt);
    return Number.isFinite(age) && age >= FIRST_ESCALATION_MS[item.cause];
  });
}

export function markEscalated(parkId: string, at: Date = new Date()): void {
  const item = readParked(parkId);
  if (!item || item.status !== 'parked') return;
  try {
    writeItem({ ...item, escalatedAt: at.toISOString(), escalations: item.escalations + 1, updatedAt: at.toISOString() });
  } catch (e) {
    console.error('gabbar: failed to record an escalation:', e);
  }
}

/** one line per held item for the owner digest. Never says filed, never quotes a feedback id. */
export function escalationLine(item: ParkedItem, now: number = Date.now()): string {
  const hours = Math.max(1, Math.round((now - Date.parse(item.createdAt)) / 3_600_000));
  const why = item.cause === 'stakeholder_gap'
    ? `${item.author.name} is not a stakeholder on ${item.target.projectName ?? item.target.projectRef ?? 'that project'}`
    : item.cause === 'outage'
      ? 'darbar could not be reached when they sent it, so it was never checked'
      : 'no project could be resolved for it';
  return `\`${item.parkId}\` held ${hours}h, from ${item.author.name}: "${item.rawMessage.slice(0, 140)}" (${why})`;
}

/**
 * Record that the sweep spent a gate check on these items, which is what lets the next sweep
 * give somebody else a turn. Written even when the answer was "still refused", because the
 * point is fairness of attention, not success.
 */
export function markAttempted(parkIds: string[], at: Date = new Date()): void {
  const stamp = at.toISOString();
  for (const parkId of parkIds) {
    const item = readParked(parkId);
    if (!item || item.status !== 'parked') continue;
    try {
      writeItem({ ...item, lastAttemptAt: stamp });
    } catch (e) {
      console.error('gabbar: failed to record a sweep attempt:', e);
      return; // the disk is unhappy; stop rather than log once per item
    }
  }
}

// A digest has to fit in one slack message. Unbounded, 200 held items came to 51,845 characters
// against a 40,000 limit, and since a failed send correctly marks nothing, it would then retry
// hourly and never land: the last safety net going silent exactly when there is most to say.
// Two individually correct behaviours, jointly fatal.
export const MAX_DIGEST_LINES = 30;
const MAX_DIGEST_CHARS = 35_000;

/**
 * The owner digest, capped. The oldest are NAMED and the rest are COUNTED, because the headline
 * of a 200-item backlog is the number, not the enumeration, and list_parked exists for the full
 * set. Every due item is still marked escalated on a successful send: each one is represented,
 * either by its line or by the count.
 */
export function buildEscalationDigest(due: ParkedItem[], now: number = Date.now()): { text: string; listed: number; omitted: number } {
  const oldest = [...due].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const shown = oldest.slice(0, MAX_DIGEST_LINES);
  const omitted = oldest.length - shown.length;
  const head = due.length > 1 ? `${due.length} reports are still held and NOT filed:` : 'a report is still held and NOT filed:';
  const lines = [head, ...shown.map((i) => escalationLine(i, now))];
  if (omitted > 0) lines.push(`...and ${omitted} more held report${omitted > 1 ? 's' : ''} not listed here. ask me to list_parked for the full set.`);
  lines.push('', 'none of this is on a board and no orchestrator has it. add the person as a stakeholder, or ask me to promote it.');
  let text = lines.join('\n');
  if (text.length > MAX_DIGEST_CHARS) text = `${text.slice(0, MAX_DIGEST_CHARS - 80)}\n...truncated. ask me to list_parked for the full set.`;
  return { text, listed: shown.length, omitted };
}

// ---------- which held items get a gate check this message ----------
export type SweepTarget = { taskRef?: string; project?: string };
export type Attempt = { target: SweepTarget; items: ParkedItem[] };

export function parkedTarget(item: ParkedItem, override?: { taskRef?: string; project?: string }): SweepTarget | null {
  if (override?.taskRef) return { taskRef: override.taskRef };
  if (override?.project) return { project: override.project };
  if (item.target.taskRef) return { taskRef: item.target.taskRef };
  if (item.target.projectRef) return { project: item.target.projectRef };
  return null;
}

/** never attempted first, then least recently attempted, oldest breaking ties */
function rotationOrder(a: ParkedItem, b: ParkedItem): number {
  if (a.lastAttemptAt !== b.lastAttemptAt) {
    if (!a.lastAttemptAt) return -1;
    if (!b.lastAttemptAt) return 1;
    return a.lastAttemptAt.localeCompare(b.lastAttemptAt);
  }
  return a.createdAt.localeCompare(b.createdAt);
}

/**
 * The budget bounds gate calls per message, and what it is spent ON is the whole problem.
 *
 * The first fix dropped items with no resolvable target, which is only ONE way to be
 * unpromotable. The class is "cannot be promoted RIGHT NOW", and a stakeholder_gap item is in it
 * too: it has a perfectly resolvable target and the gate keeps refusing it until a human acts,
 * possibly forever. Ordering by age then pins the budget to the same items on every message and
 * nothing behind them is ever reached, which is the same starvation wearing a different cause.
 *
 * So the budget counts DISTINCT TARGETS rather than items, and the queue ROTATES:
 *   - items sharing a target are verified once and the answer applied to all of them, so five
 *     reports on one project cost one call instead of five
 *   - never-attempted items go first, then least-recently-attempted, so every held item gets a
 *     turn within ceil(distinct targets / budget) messages instead of never
 * Raising the budget would not have fixed this. Only the ordering does.
 */
export function planSweep(held: ParkedItem[], maxTargets: number): Attempt[] {
  const groups = new Map<string, Attempt>();
  for (const item of [...held].sort(rotationOrder)) {
    const target = parkedTarget(item);
    if (!target) continue; // structurally unpromotable; the escalation clock owns these
    const key = target.taskRef ? `task:${target.taskRef.toUpperCase()}` : `project:${target.project}`;
    const existing = groups.get(key);
    if (existing) {
      existing.items.push(item); // free: same target, same answer, no extra call
      continue;
    }
    if (groups.size >= maxTargets) continue; // its turn comes on a later message
    groups.set(key, { target, items: [item] });
  }
  return [...groups.values()];
}
