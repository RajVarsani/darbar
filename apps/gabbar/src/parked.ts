// Parking lot for reports the stakeholder gate refused.
//
// The gate in agent.ts fails closed on the verified slack sender id, which is correct.
// The bug it caused was that a refusal ALSO threw the report away: a teammate's calendar bug
// and its screen recording survived only because Raj happened to be reading the thread.
//
// A parked item is held here instead. It is deliberately NOT a feedback row:
//   - it never touches mongo, so GET /feedback/pending and the board cannot show it
//   - its id lives in the PARK-* namespace, which can never collide with <PREFIX>-FB-<n>
//   - every read path returns it with filed:false attached
// so there is no surface on which a parked item can pass for filed feedback. Promotion is the only
// way anything here reaches the board, and it runs through the same gate.
//
// Two kinds are held, and the difference is the whole of DAR-219 (see ParkedKind). A REPORT is
// promoted by filing a new feedback row. An ADDITION is promoted by appending to a row that already
// exists, and it must never be promoted the other way: filing a row for evidence that belongs on an
// existing finding is the duplicate DAR-182 removed, so parking an addition without this
// distinction would have fixed a loss by rebuilding a bug.
//
// One file per parked item, keyed by the slack message it came from, so a model that retries
// the same message with a different project ref refines one parked item instead of piling up.
// An addition is keyed by the message AND the row it targets, because one message can be refused
// more than one thing (see parkIdFor).
import fs from 'node:fs';
import path from 'node:path';

// Resolved per read rather than once at import, for the reason api.ts's reader already carries: at
// import it made the directory depend on WHICH FILE IMPORTED THIS MODULE FIRST. Two test files each
// pointing PARKED_DIR at their own rig shared whichever one won, so one wrote held items into a
// directory the other believed it owned and deleted. It is the same string either way in a running
// gabbar, and a path read where it is used cannot be captured by an import order nobody can see.
const root = (): string => path.resolve(process.env.PARKED_DIR || new URL('../../../data/parked/', import.meta.url).pathname);

/**
 * WHY it is held, which decides what happens next.
 *
 * `stakeholder_gap` is a human's decision to make, so the item waits and the owner is pinged at
 * park time. `outage` means darbar could not answer, so we never learned whether they are a
 * stakeholder: that resolves by itself, so it retries and nobody is pinged per message. Telling
 * the two apart is the whole fix; before this they were both just "could not verify".
 */
export type ParkCause = 'stakeholder_gap' | 'outage' | 'bad_reference';

/**
 * WHAT is held, which decides how it is promoted.
 *
 * A `report` is something nobody has filed, so promoting it CREATES a feedback row. An `addition`
 * is evidence or a correction for a row that already exists, so promoting it APPENDS to that row
 * and creates nothing. The difference is recorded rather than inferred later, because a held
 * addition promoted down the report path would file a second row for one finding, which is exactly
 * the duplicate DAR-182 removed.
 *
 * WHICH REFUSALS PARK AT ALL is the third variation on one question, so all three are stated here
 * in one place instead of once per call site:
 *   - file   → PARKS a report. The words are the sender's own and nobody else has a copy.
 *   - append → PARKS an addition. The words are equally the sender's own; the only reason a refused
 *              append could not be held before was that promotion meant filing a new row, and that
 *              is no longer true.
 *   - reopen → PARKS NOTHING, and that is not an oversight. A reopen carries no words of the
 *              sender's at all: the body belongs to whoever filed the row, the row is untouched by
 *              the refusal, and the owner is told what was said. Promoting a held reopen could only
 *              mean writing somebody else's words into a new row under this sender's name.
 * The rule underneath all three: hold what the sender WROTE, never what their request referred to.
 */
export type ParkedKind = 'report' | 'addition';

export type ParkedStatus =
  | 'parked' // held, nothing filed
  | 'promoted' // became a real feedback row (see promotion.feedbackShortId)
  | 'superseded'; // the same message went on to file for real in the same turn

export type ParkedItem = {
  parkId: string;
  status: ParkedStatus;
  /** report unless stated; see ParkedKind for why this is on the record and not worked out later */
  kind: ParkedKind;
  /** the feedback row an addition belongs on (e.g. MRF-FB-23). Always null on a report. */
  appendTo: string | null;
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
  /** last time the owner was told this is still sitting here, so the digest cannot repeat every tick */
  escalatedAt: string | null;
  escalations: number;
  promotion: { at: string; feedbackShortId: string; promotedBy: string } | null;
  supersededBy: string | null;
};

const idSafe = (s: string): string => s.replace(/[^A-Za-z0-9]+/g, '_');

function slackKey(channel: string, ts: string): string {
  return idSafe(`${channel}-${ts}`);
}

/**
 * One slack message, one held item — except that a message can be refused more than one thing. The
 * model can try file_feedback and then add_to_feedback on the same message, or add to two different
 * rows, and keying every one of those on the message alone meant the second refusal overwrote the
 * first one's words. An addition is therefore keyed by the row it targets as well.
 *
 * The row id is flattened to underscores like everything else here, so a park id still cannot end
 * in -FB-<n> and still cannot be mistaken for a feedback id.
 */
export function parkIdFor(channel: string, ts: string, appendTo?: string | null): string {
  const base = `PARK-${slackKey(channel, ts)}`;
  const row = appendTo?.trim();
  return row ? `${base}_ON_${idSafe(row.toUpperCase())}` : base;
}

/** PARK-* is a namespace of its own on purpose: nothing here can be mistaken for a feedback id. */
export function isParkId(s: string): boolean {
  return /^PARK-[A-Za-z0-9_]+$/.test(s.trim());
}

function fileFor(parkId: string): string {
  return path.join(root(), `${parkId}.json`);
}

function writeItem(item: ParkedItem): void {
  fs.mkdirSync(root(), { recursive: true });
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
    // Every record written before additions existed is a report, which is also the safe default: a
    // report is the only kind that can be promoted by filing a new row, and it is what those files
    // actually are. The reverse default would turn old reports into appends onto nothing.
    const kind: ParkedKind = item.kind === 'addition' ? 'addition' : 'report';
    // defaults for records written before a cause was recorded: an unknown cause is treated as a
    // gap, which is the conservative choice (it waits for a human instead of retrying quietly)
    return {
      ...item,
      kind,
      // An addition whose target row id is missing or unusable stays an ADDITION with no target: it
      // becomes unpromotable and waits for a human, rather than being quietly relabelled a report,
      // which is the one relabelling that would put the DAR-182 duplicate back on the board.
      appendTo: kind === 'addition' && typeof item.appendTo === 'string' && item.appendTo.trim() ? item.appendTo.trim() : null,
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
 * Hold a refused item. Upserts on its key, and never overwrites one that already reached a
 * terminal state — once something is really filed or added, the record of how it got there stops
 * changing.
 */
function hold(input: ParkInput, kind: ParkedKind, appendTo: string | null): ParkedItem {
  const parkId = parkIdFor(input.channel, input.ts, appendTo);
  const existing = readParked(parkId);
  if (existing && existing.status !== 'parked') return existing;
  const now = new Date().toISOString();
  const item: ParkedItem = {
    parkId,
    status: 'parked',
    kind,
    appendTo,
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
    console.error(`gabbar: failed to park ${kind}:`, e);
  }
  return item;
}

/** A refused report of the sender's own: promoted by FILING a new feedback row. */
export function parkReport(input: ParkInput): ParkedItem {
  return hold(input, 'report', null);
}

/**
 * A refused addition to a row that already exists: promoted by APPENDING to that row, never by
 * filing anything. The words are the sender's own, which is why this is held at all; the row id is
 * what keeps promotion off the file_feedback path.
 */
export function parkAddition(input: ParkInput & { appendTo: string }): ParkedItem {
  return hold(input, 'addition', input.appendTo.trim());
}

export function listParked(filter?: { status?: ParkedStatus; authorId?: string; kind?: ParkedKind }): ParkedItem[] {
  let names: string[];
  try {
    names = fs.readdirSync(root()).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  const out: ParkedItem[] = [];
  for (const n of names) {
    const item = readParked(n.slice(0, -'.json'.length));
    if (!item) continue;
    if (filter?.status && item.status !== filter.status) continue;
    if (filter?.authorId && item.author.slackUserId !== filter.authorId) continue;
    if (filter?.kind && item.kind !== filter.kind) continue;
    out.push(item);
  }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * Terminal. `feedbackShortId` is the row this ended up on: the row that was CREATED for a report,
 * the row that was APPENDED TO for an addition. Either way the held copy leaves the queue and the
 * record points at where the words actually live now.
 */
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
 * The gate refused once, the model then succeeded for the same slack message. Retire the parked
 * copy so the queue never shows a duplicate of something already on the board.
 *
 * `appendTo` addresses the held ADDITION for that row rather than the held report, because the two
 * are separate records under separate ids (parkIdFor). Passing the wrong one retires nothing, which
 * is the safe direction: an item that stays held is visible, one retired by mistake is not.
 */
export function markSuperseded(channel: string, ts: string, feedbackShortId: string, appendTo?: string | null): void {
  const item = readParked(parkIdFor(channel, ts, appendTo));
  if (!item || item.status !== 'parked') return;
  try {
    writeItem({ ...item, status: 'superseded', updatedAt: new Date().toISOString(), supersededBy: feedbackShortId });
  } catch (e) {
    console.error('gabbar: failed to mark parked item superseded:', e);
  }
}

/**
 * Shape handed to the model. filed:false rides along on every row, in every direction.
 *
 * `kind`, `appendTo` and `addedToRow` are what stop a held ADDITION reading as a held report. The
 * row id has to be here, since it is the only thing that says where the words belong and the owner
 * cannot act without it, so `addedToRow:false` is next to it: an id on a held item is a destination,
 * never evidence that anything reached it.
 */
export function summarize(item: ParkedItem) {
  return {
    parkId: item.parkId,
    filed: false,
    parked: true,
    kind: item.kind,
    appendTo: item.appendTo, // null on a report
    addedToRow: item.kind === 'addition' ? false : null, // never true here: held means not on the row
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
export function withFilingNotice(reply: string, filedNow: string[], addedNow: string[] = [], confirmedNow: string[] = []): string {
  const missingFiled = filedNow.filter((id) => !reply.includes(id));
  // An addition that landed is NOT a filing and must not be announced as one: nothing new exists,
  // an existing row gained their words. Said in its own clause for that reason.
  const missingAdded = addedNow.filter((id) => !reply.includes(id));
  // DAR-241. THE THIRD CASE, and it exists because this function and the sweep notice are two
  // sentences generated from ONE TURN and were able to contradict each other. The sweep told the
  // model a row already carried this write; this tail then appended "is now filed as", flatly
  // asserting the opposite about the same id, and whichever the model repeated, half of what the
  // sender heard was untrue. It is the same defect as a digest that hedges in one sentence and
  // asserts in the next, one layer out.
  //
  // It says WHERE the words are and not WHEN they got there, because when is not known: a row under
  // this write's key may have been created by a concurrent sweep of the same held item rather than
  // by the sender's original attempt.
  const missingConfirmed = confirmedNow.filter((id) => !reply.includes(id));
  const tails: string[] = [];
  if (missingFiled.length) {
    tails.push(missingFiled.length > 1
      ? `your earlier reports that were being held are now filed as ${missingFiled.join(' and ')}`
      : `your earlier report that was being held is now filed as ${missingFiled[0]}`);
  }
  if (missingAdded.length) {
    tails.push(missingAdded.length > 1
      ? `what you were adding earlier was being held and is now on ${missingAdded.join(' and ')}`
      : `what you were adding earlier was being held and is now on ${missingAdded[0]}`);
  }
  if (missingConfirmed.length) {
    tails.push(missingConfirmed.length > 1
      ? `what you sent earlier is on the board as ${missingConfirmed.join(' and ')}, so it did not need sending again`
      : `what you sent earlier is on the board as ${missingConfirmed[0]}, so it did not need sending again`);
  }
  if (!tails.length) return reply;
  return `${reply.trim()}\n\nalso: ${tails.join('; ')}.`;
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
// it surfaces within the hour. After that it repeats, as ONE digest rather than a message per item.
export const FIRST_ESCALATION_MS: Record<ParkCause, number> = {
  stakeholder_gap: 24 * 60 * 60 * 1000,
  outage: 60 * 60 * 1000,
  bad_reference: 60 * 60 * 1000,
};

// THE REPEAT USED TO BE DAILY, and it was daily because the DM was the only place a held report
// existed at all. That stopped being true: the board's Feedback view now carries a held band, with
// the count on the tab from every view, and per report the reporter, the cause, the age, their
// words verbatim, the attachments, whether the owner has already been told, and the remedy. Checked
// against the rendering rather than taken on trust. Everything the digest says is visible without
// it now, so what the digest still uniquely does is PUSH: reach somebody who is not looking.
//
// A push is worth less often, so the repeat is weekly and STAYS weekly however long the item sits.
// Escalating an old item back to daily was considered and rejected on both counts. On the merits: a
// daily DM about a ninety-day-old held report does not raise pressure, it teaches the owner to skim
// past the digest, which costs the report that arrives tomorrow its one safety net. The ladder still
// has its pressure step, and it is the FIRST ping at 1h or 24h; after that a steady weekly reminder
// is a reminder rather than nagging. On the mechanics: any age-based switch to daily fires before a
// weekly repeat ever can, because the first escalation lands at 1h or 24h and a week from there is
// already past the age mark. "Weekly by default" would then have been a bound that never once held,
// which is the same dead-config defect as a comment describing a limit the code does not apply.
//
// `outage` is the one exception and it is not a repeat at all in spirit: nobody was pinged at park
// time for those, so daily is first contact rather than nagging, and an outage item still held means
// the retry path never healed, which is a fault rather than a queue.
export const REPEAT_ESCALATION_MS = 7 * 24 * 60 * 60 * 1000;
export const OUTAGE_REPEAT_ESCALATION_MS = 24 * 60 * 60 * 1000;

/**
 * How long this item waits between reminders. A function of the CAUSE and nothing else: age does not
 * enter into it, so the gap a held item gets on day 3 is the gap it still gets on day 300, and there
 * is no clock in here that can silently reclassify an item as it sits.
 */
export function repeatEscalationMs(item: ParkedItem): number {
  return item.cause === 'outage' ? OUTAGE_REPEAT_ESCALATION_MS : REPEAT_ESCALATION_MS;
}

/** held items the owner is owed an update about. Pure, so the clock can be tested. */
export function dueForEscalation(now: number = Date.now(), items?: ParkedItem[]): ParkedItem[] {
  return (items ?? listParked({ status: 'parked' })).filter((item) => {
    if (item.status !== 'parked') return false;
    if (item.escalatedAt) return now - Date.parse(item.escalatedAt) >= repeatEscalationMs(item);
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

/**
 * One line per held item for the owner digest. Never says filed, and never claims a held item HAS a
 * feedback id.
 *
 * A held addition is the one line that names a feedback id, and that is a narrowing of the old rule
 * rather than a break with it. The id is the row the sender was trying to add to, not an id this
 * item was given, and the owner cannot do anything about a held addition without knowing which row
 * it belongs on. The clause that carries it says NEVER added, so the id reads as a destination.
 */
/** a held item whose gate PASSED and whose write then failed (DAR-229), so it may already exist */
export function isWriteFailure(item: ParkedItem): boolean {
  return item.gate.kind === 'write_failed';
}

export function escalationLine(item: ParkedItem, now: number = Date.now()): string {
  const hours = Math.max(1, Math.round((now - Date.parse(item.createdAt)) / 3_600_000));
  const why = isWriteFailure(item)
    // DAR-229. Recorded as an outage because that is what it behaves like, but "never checked" is
    // the one thing it is not: the check passed and the WRITE is what failed.
    ? 'the stakeholder check passed and the write itself failed, so it may or may not have gone through'
    : item.cause === 'stakeholder_gap'
      ? `${item.author.name} is not a stakeholder on ${item.target.projectName ?? item.target.projectRef ?? 'that project'}`
      : item.cause === 'outage'
        ? 'darbar could not be reached when they sent it, so it was never checked'
        // DAR-232: a mistyped row id is the one bad reference that never clears by itself, and the
        // remedy for it is not the remedy for a report with no project, so it says which it is
        : item.kind === 'addition' && item.appendTo
          ? `${item.appendTo} could not be resolved, so the sweep re-asks and is refused every time`
          : 'no project could be resolved for it';
  // DAR-239/B1. "NEVER added to it" is the one thing a write-failure hold cannot say. The write went
  // out and darbar stopped answering, so the row may well carry these words already, and this clause
  // used to assert otherwise in the same sentence as the `why` above that hedges it.
  const row = item.appendTo ?? 'a row it no longer names';
  const what = item.kind !== 'addition'
    ? ''
    : isWriteFailure(item)
      ? `, an addition to ${row} that MAY OR MAY NOT have reached it`
      : `, an addition to ${row} that was NEVER added to it`;
  return `\`${item.parkId}\` held ${hours}h, from ${item.author.name}${what}: "${item.rawMessage.slice(0, 140)}" (${why})`;
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
  // "N reports are still held and NOT filed" is false of an addition twice over: it is not a report
  // and NOT FILED is not the thing that went wrong with it. A backlog of both says both, and the
  // reports-only wording is left exactly as it was rather than generalised into something vaguer.
  //
  // DAR-239/B1. AND EVERY ONE OF THOSE CERTAINTIES HAS TO BE GATED, not just the closing sentence.
  // Gating only the ending produced one message that asserted a write-failure hold was never added,
  // said the row shows no sign anything was sent, and then admitted at the bottom that nobody knows
  // whether it landed. Three claims and a contradiction of them, in the one message whose entire
  // reason for existing is that the outcome is unknown. So the counts the head and the trailing
  // addition sentence are built from EXCLUDE write failures, and those are described separately.
  //
  // When nothing here is a write failure, which is the ordinary digest, every string below is
  // byte-identical to what it was.
  const unsureItems = oldest.filter(isWriteFailure);
  const certain = oldest.filter((i) => !isWriteFailure(i));
  const unsure = unsureItems.length;
  const adds = certain.filter((i) => i.kind === 'addition').length;
  const reports = certain.length - adds;
  const s = (n: number) => (n > 1 ? 's' : '');
  const certainHead = certain.length === 0
    ? ''
    : adds === 0
      ? (certain.length > 1 ? `${certain.length} reports are still held and NOT filed` : 'a report is still held and NOT filed')
      : reports === 0
        ? (adds > 1
          ? `${adds} additions are still held and were NEVER added to the rows they name`
          : 'an addition is still held and was NEVER added to the row it names')
        : `${certain.length} items are still held: ${reports} report${s(reports)} never filed, and ${adds} addition${s(adds)} never added to the row${s(adds)} they name`;
  const unsureHead = unsure === 0
    ? ''
    : certain.length === 0
      ? (unsure > 1
        ? `${unsure} items are still held, and whether any of them landed is not known`
        : 'an item is still held, and whether it landed is not known')
      : (unsure > 1
        ? `${unsure} more are held whose writes never came back, so whether they landed is not known`
        : 'one more is held whose write never came back, so whether it landed is not known');
  const head = `${[certainHead, unsureHead].filter(Boolean).join('. ')}:`;
  const lines = [head, ...shown.map((i) => escalationLine(i, now))];
  if (omitted > 0) {
    // read off EVERY held item, not off the certain ones: an unlisted addition is still an addition,
    // and "held reports" would be the wrong noun for a backlog that has one
    const noun = oldest.some((i) => i.kind === 'addition') ? 'held item' : 'held report';
    lines.push(`...and ${omitted} more ${noun}${omitted > 1 ? 's' : ''} not listed here. ask me to list_parked for the full set.`);
  }
  // "none of this is on a board" was true when it was written and is not any more: the board's
  // Feedback view carries a held band now. What has not changed is that nothing here is filed and
  // nobody is working it, which is the part that matters, so the claim narrows to that instead of
  // being dropped. Still no feedback id and still no link, because a held report has neither.
  // DAR-229. "nothing here is filed" is the sentence this digest has always closed on, and it is the
  // one claim a write-failure hold cannot make: the gate passed, the write went out, and darbar
  // stopped answering before it said whether the row was created. So the blanket claim is only made
  // when it is true of everything listed, and the write failures get their own sentence saying what
  // is genuinely unknown and why acting on it is still safe.
  lines.push('', unsure === 0
    ? 'nothing here is filed. no feedback id, no triage queue, no orchestrator working it. add the person as a stakeholder, or ask me to promote it.'
    : unsure === oldest.length
      ? 'none of this is known to be filed, and none of it is known not to be: these are writes that went out and never came back. no feedback id was ever returned for any of them, so nothing here is in a triage queue that anybody can point to.'
      : `${certain.length} of these ${certain.length > 1 ? 'are' : 'is'} definitely not filed: no feedback id, no triage queue, no orchestrator working ${certain.length > 1 ? 'them' : 'it'}. add the person as a stakeholder, or ask me to promote it.`);
  if (unsure > 0) {
    // one sentence covering BOTH shapes, rather than a fourth line for held additions. A write
    // failure lands as a row that was created or as words added to a row that already existed, and
    // the row an addition names looks untouched in either case, so there is nothing on any surface
    // that answers the question for you.
    lines.push(`${unsure} of the${unsure === oldest.length ? 'se' : 'm'} got past the stakeholder check and failed on the WRITE, which is what an api restart looks like from here. ${unsure > 1 ? 'those may already have landed' : 'that one may already have landed'}, either as a row that was created or as words added to a row that already existed, and nothing came back to say which. promoting ${unsure > 1 ? 'them' : 'it'} is safe either way: the retry carries the same key as the attempt that failed, so it finds what that attempt made and makes it only if it was never made, and it cannot produce a second copy.`);
  }
  // DAR-232. A mistyped row id parks an addition FOREVER: the sweep re-asks the same unresolvable
  // row on every message and is refused every time, and adding the sender as a stakeholder does not
  // touch it. The only thing that clears it is the owner naming the right row, and a digest that
  // does not say so leaves the remedy to be worked out by whoever reads it.
  const stuckAdds = oldest.filter((i) => i.kind === 'addition' && i.cause === 'bad_reference').length;
  if (stuckAdds > 0) {
    lines.push(`${stuckAdds > 1 ? `${stuckAdds} of the additions name a row that does not resolve` : 'one of the additions names a row that does not resolve'}, usually a typo. that never clears on its own and registering the sender does not help: ask me to promote it with the right row (promote_parked with feedbackRef), or it sits here for good.`);
  }
  // and the row an addition names is not carrying it either, which the sentence above does not say:
  // that row exists, is on the board, and looks untouched because it IS untouched.
  // "the addition above" is unambiguous only while every addition listed is one this sentence is
  // true of. Once a write-failure addition is listed too, both are "above" and this would read as
  // covering it, which is the certainty being gated everywhere else in this function. When that
  // happens the clause says WHICH ones it means, in the same words their own lines use.
  if (adds > 0) {
    const which = unsure === 0
      ? `the ${adds > 1 ? 'additions' : 'addition'} above`
      : `the ${adds > 1 ? `${adds} additions` : 'addition'} above marked NEVER added`;
    lines.push(`${which} never reached the row${s(adds)} named: ${adds > 1 ? 'those rows are' : 'that row is'} unchanged and ${adds > 1 ? 'show' : 'shows'} no sign anything was sent. promoting ${adds > 1 ? 'one' : 'it'} adds it to that row, it never becomes a second row.`);
  }
  let text = lines.join('\n');
  if (text.length > MAX_DIGEST_CHARS) text = `${text.slice(0, MAX_DIGEST_CHARS - 80)}\n...truncated. ask me to list_parked for the full set.`;
  return { text, listed: shown.length, omitted };
}

// ---------- which held items get a gate check this message ----------
/**
 * How the sweep addresses a held item when it re-asks the gate. `feedbackRef` is the HALF KNOWN
 * case (DAR-225): a refusal that landed before the target row could be resolved knows the row the
 * sender named and nothing else, so the project has to be looked up from that row at sweep time.
 */
export type SweepTarget = { taskRef?: string; project?: string; feedbackRef?: string };
export type Attempt = { target: SweepTarget; items: ParkedItem[] };

export function parkedTarget(item: ParkedItem, override?: { taskRef?: string; project?: string }): SweepTarget | null {
  if (override?.taskRef) return { taskRef: override.taskRef };
  if (override?.project) return { project: override.project };
  if (item.target.taskRef) return { taskRef: item.target.taskRef };
  if (item.target.projectRef) return { project: item.target.projectRef };
  // An addition parked before its row could be resolved: darbar was down, so nobody ever learned
  // which project the row belongs to. The row id is the ONLY thing known about where these words
  // go, and it is enough, because the project is a property of that row rather than of anything
  // the sender said. Without this the item is structurally unpromotable and only the escalation
  // clock ever mentions it again, which is a slower version of losing it.
  if (item.kind === 'addition' && item.appendTo) return { feedbackRef: item.appendTo };
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
 *
 * A held ADDITION plans exactly like a held report and deliberately gets no path of its own. The
 * question the sweep spends its budget on is "is this sender a stakeholder on that project", and
 * that question and its answer are identical for both kinds, so an addition groups by the same
 * target, is verified by the same single call, and takes its turn in the same rotation. Only what
 * happens AFTER the gate says yes differs, and that belongs to the promoter, not to the plan. A
 * separate queue for additions would have been a second fairness guarantee to keep in step with
 * this one, and the stated bound of a turn within ceil(distinct targets / budget) messages would
 * have quietly stopped covering every held item.
 *
 * A HALF KNOWN addition (`feedbackRef`, DAR-225) is one more target in that same rotation and costs
 * one budget slot like any other, so the bound is untouched: it is stated in DISTINCT TARGETS per
 * message, not in http calls. What it does cost is the calls inside its slot. Resolving one is two
 * round trips rather than one, the row then the project, so a message whose whole budget is half
 * known additions makes 10 calls instead of 5, still under the same 20s message budget that bounds
 * every other shape of turn. That is the price of not guessing a project, and guessing one is how
 * somebody's evidence lands on a stranger's finding.
 *
 * Its key is the ROW, so it cannot merge with a `project:` group even when it turns out to be the
 * same project: merging them would need the answer the resolve is there to find. Two additions to
 * the same row do share one slot and one resolve.
 */
export function planSweep(held: ParkedItem[], maxTargets: number): Attempt[] {
  const groups = new Map<string, Attempt>();
  for (const item of [...held].sort(rotationOrder)) {
    const target = parkedTarget(item);
    if (!target) continue; // structurally unpromotable; the escalation clock owns these
    // DAR-232. The KEY was uppercased and the TARGET was not, so a group took the casing of whichever
    // item happened to be first in the rotation and two spellings of one row read as two targets in
    // a log. The server uppercases a short id on the way in, so the uppercased form is the one thing
    // being addressed either way, and normalising the target rather than only the key means the
    // grouping and the thing actually sent agree. `project` is deliberately left alone: it can be a
    // mongo id, where case is not decoration.
    const norm: SweepTarget = target.taskRef
      ? { taskRef: target.taskRef.toUpperCase() }
      : target.feedbackRef
        ? { feedbackRef: target.feedbackRef.toUpperCase() }
        : target;
    const key = norm.taskRef
      ? `task:${norm.taskRef}`
      : norm.feedbackRef
        ? `feedback:${norm.feedbackRef}`
        : `project:${norm.project}`;
    const existing = groups.get(key);
    if (existing) {
      existing.items.push(item); // free: same target, same answer, no extra call
      continue;
    }
    if (groups.size >= maxTargets) continue; // its turn comes on a later message
    groups.set(key, { target: norm, items: [item] });
  }
  return [...groups.values()];
}
