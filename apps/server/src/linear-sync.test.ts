// DAR-266. The Linear mirror, end to end through the real routes, against an in-memory stub client.
// Nothing here talks to Linear.
import { describe, test, expect, beforeEach, afterAll, afterEach } from 'bun:test';
import { req, reset, teardown, project, task, feedback, children } from './test-harness';
import { Tasks, Projects, Feedback } from '@darbar/core';
import {
  setLinearClient, flushLinear, pollOnce, startLinearSync, outboundStateId, inboundStatus, linearRefFromUrl, DARBAR_LABEL_GROUP_ID, MAX_FAILURES,
} from './linear-sync';
import type { LinearClient, LinearIssue, LinearState, IssueCreateInput, IssueUpdateInput } from './linear';

const TEAM = 'team-mee';
const STATES: LinearState[] = [
  { id: 's-backlog', name: 'Backlog', type: 'backlog', position: 0 },
  { id: 's-blocked', name: 'Blocked', type: 'unstarted', position: 0.5 },
  { id: 's-todo', name: 'Todo', type: 'unstarted', position: 1 },
  { id: 's-prog', name: 'In Progress', type: 'started', position: 2 },
  { id: 's-pending', name: 'Pending Release', type: 'started', position: 1.5 },
  { id: 's-review', name: 'Review', type: 'started', position: 3 },
  { id: 's-done', name: 'Done', type: 'completed', position: 4 },
  { id: 's-cancel', name: 'Canceled', type: 'canceled', position: 5 },
];
const typeOf = (id: string) => STATES.find((s) => s.id === id)!.type;

let clock = Date.now();
const tick = () => new Date((clock += 1000)).toISOString();

type Stub = LinearClient & {
  issues: Map<string, LinearIssue>;
  comments: { id: string; issueId: string; body: string }[];
  labels: { id: string; name: string; parentId: string }[];
  calls: string[];
  failNext: Partial<Record<'createIssue' | 'createIssueAfterWrite' | 'updateIssue' | 'createComment' | 'createCommentAfterWrite', number>>;
  /** replaces what the poll's list returns (a stale snapshot) */
  listOverride: LinearIssue[] | null;
  /** runs inside updateIssue, before it answers: a darbar edit landing mid-pass */
  onUpdate: (() => Promise<void>) | null;
  seed(over: Partial<LinearIssue> & { title: string }): LinearIssue;
  edit(id: string, patch: Partial<LinearIssue>): void;
};

function stubClient(): Stub {
  let n = 0;
  const s: Stub = {
    issues: new Map(), comments: [], labels: [], calls: [], failNext: {}, listOverride: null, onUpdate: null,
    seed(over) {
      const id = over.id ?? crypto.randomUUID();
      const i: LinearIssue = {
        id, identifier: `MEE-${++n + 100}`, url: `https://linear.app/x/issue/MEE-${n + 100}`, description: '',
        stateId: 's-todo', stateType: 'unstarted', updatedAt: tick(), labelIds: [], ...over,
      };
      i.stateType = typeOf(i.stateId);
      s.issues.set(id, i);
      return i;
    },
    edit(id, patch) {
      const i = s.issues.get(id)!;
      Object.assign(i, patch, { updatedAt: tick() });
      i.stateType = typeOf(i.stateId);
    },
    async teamByKey(key) { s.calls.push(`teamByKey:${key}`); return key === 'MEE' ? { id: TEAM, key } : null; },
    async projectBySlugId() { return null; },
    async workflowStates() { return STATES; },
    async labelTeam() { return null; },
    async findChildLabel(parentId, name) {
      return s.labels.find((l) => l.parentId === parentId && l.name.toLowerCase() === name.toLowerCase()) ?? null;
    },
    async findLabelByName(name) { return s.labels.find((l) => l.name === name) ?? null; },
    async createChildLabel({ parentId, name }) {
      s.calls.push(`createChildLabel:${name}`);
      const l = { id: `label-${name}`, name, parentId };
      s.labels.push(l);
      return l;
    },
    async getIssue(id) { s.calls.push('getIssue'); const i = s.issues.get(id); return i ? { ...i } : null; },
    async createIssue(input: IssueCreateInput) {
      s.calls.push('createIssue');
      if (s.failNext.createIssue) { s.failNext.createIssue--; throw new Error('linear: network down'); }
      if (s.issues.has(input.id)) throw new Error('linear: entity already exists');
      const i = s.seed({ id: input.id, title: input.title, description: input.description, stateId: input.stateId ?? 's-todo', labelIds: input.labelIds });
      // the response is lost AFTER Linear created the issue: the case idempotency exists for
      if (s.failNext.createIssueAfterWrite) { s.failNext.createIssueAfterWrite--; throw new Error('linear: socket hang up'); }
      return { ...i };
    },
    async updateIssue(id, input: IssueUpdateInput) {
      s.calls.push(`updateIssue:${Object.keys(input).sort().join(',')}`);
      if (s.failNext.updateIssue) { s.failNext.updateIssue--; throw new Error('linear: 500'); }
      s.edit(id, input);
      const during = s.onUpdate; s.onUpdate = null;
      if (during) await during();
      return { ...s.issues.get(id)! };
    },
    async commentExists(id) { return s.comments.some((c) => c.id === id); },
    async createComment(c) {
      s.calls.push('createComment');
      if (s.failNext.createComment) { s.failNext.createComment--; throw new Error('linear: 502'); }
      s.comments.push(c);
      if (s.failNext.createCommentAfterWrite) { s.failNext.createCommentAfterWrite--; throw new Error('linear: socket hang up'); }
      const i = s.issues.get(c.issueId)!;
      i.updatedAt = tick();
      return { issueUpdatedAt: i.updatedAt };
    },
    async listLabelledIssues(labelId, since) {
      s.calls.push('listLabelledIssues');
      if (s.listOverride) return { issues: s.listOverride.map((i) => ({ ...i })), endCursor: null, hasNextPage: false };
      // deliberately does NOT filter by label: the sync must re-check each issue itself
      const all = [...s.issues.values()].filter((i) => !since || Date.parse(i.updatedAt) >= Date.parse(since));
      return { issues: all.map((i) => ({ ...i })), endCursor: null, hasNextPage: false };
    },
  };
  return s;
}

let stub: Stub;
const LINEAR_URL = 'https://linear.app/saturn-tech/team/MEE/issue-label/x';

beforeEach(async () => {
  await reset();
  stub = stubClient();
  setLinearClient(stub);
});
afterEach(async () => { await flushLinear(); setLinearClient(null); });
afterAll(teardown);

async function linearProject() {
  const p = await project();
  const r = await req('PATCH', `/projects/${p.prefix}`, { linearUrl: LINEAR_URL });
  if (r.status !== 200) throw new Error(`linearUrl patch failed: ${r.error}`);
  return p;
}
const row = (shortId: string) => Tasks.findOne({ shortId });
const patch = (ref: string, b: Record<string, unknown>) => req('PATCH', `/tasks/${ref}`, b);
const settle = async () => { await flushLinear(); };
/** the failure backoff has run out: the next poll retries this row */
const elapse = (shortId: string) => Tasks.updateOne({ shortId }, { $set: { 'linear.retryAt': new Date(0) } });

describe('pure mapping', () => {
  test('darbar status -> Linear state by type, review/progress/blocked by name', () => {
    expect(outboundStateId('backlog', STATES)).toBe('s-backlog');
    expect(outboundStateId('todo', STATES)).toBe('s-todo');
    expect(outboundStateId('in_progress', STATES)).toBe('s-prog');
    expect(outboundStateId('in_review', STATES)).toBe('s-review');
    expect(outboundStateId('qa', STATES)).toBe('s-review');
    expect(outboundStateId('blocked', STATES)).toBe('s-blocked');
    expect(outboundStateId('done', STATES)).toBe('s-done');
    expect(outboundStateId('cancelled', STATES)).toBe('s-cancel');
    // a team with no "Review" state: first started state by position
    const noReview = STATES.filter((s) => s.id !== 's-review');
    expect(outboundStateId('in_review', noReview)).toBe('s-pending');
    expect(outboundStateId('blocked', noReview.filter((s) => s.id !== 's-blocked'))).toBeNull();
  });
  test('Linear state -> darbar status', () => {
    expect(inboundStatus({ type: 'started', name: 'Review' })).toBe('in_review');
    expect(inboundStatus({ type: 'started', name: 'Pending Release' })).toBe('in_progress');
    expect(inboundStatus({ type: 'unstarted', name: 'Blocked' })).toBe('blocked');
    expect(inboundStatus({ type: 'unstarted', name: 'Todo' })).toBe('todo');
    expect(inboundStatus({ type: 'completed', name: 'Done' })).toBe('done');
    expect(inboundStatus({ type: 'duplicate', name: 'Duplicate' })).toBe('cancelled');
    expect(inboundStatus({ type: 'triage', name: 'Triage' })).toBe('backlog');
  });
  test('team derivation from linearUrl', () => {
    expect(linearRefFromUrl('https://linear.app/saturn-tech/team/LET/issue-label/lpvof')).toEqual({ teamKey: 'LET' });
    expect(linearRefFromUrl('https://linear.app/saturn-tech/project/sjp-onboarding-gate-7798b7ca9670')).toEqual({ projectSlugId: '7798b7ca9670' });
    expect(linearRefFromUrl('not a url')).toBeNull();
  });
});

describe('outbound', () => {
  test('create: one labelled issue in the team, link stored on the row; review children and non-linear projects are not mirrored', async () => {
    const p = await linearProject();
    const t = await task(p.prefix, { title: 'ship the gate', description: 'why' });
    await settle();
    const r = (await row(t.shortId))!;
    expect(r.linear?.created).toBe(true);
    const issue = stub.issues.get(r.linear!.id)!;
    expect(issue.title).toBe('ship the gate');
    expect(issue.stateId).toBe('s-todo');
    expect(stub.labels).toEqual([{ id: `label-${p.prefix}`, name: p.prefix, parentId: DARBAR_LABEL_GROUP_ID }]);
    expect(issue.labelIds).toEqual([`label-${p.prefix}`]);
    expect(r.linear!.identifier).toBe(issue.identifier);

    await patch(t.shortId, { status: 'in_review' });
    await settle();
    const kids = await children(t.shortId);
    expect(kids.length).toBe(1);
    expect((await row(kids[0]!.shortId))!.linear).toBeUndefined();

    const plain = await project();
    const other = await task(plain.prefix);
    await settle();
    expect((await row(other.shortId))!.linear).toBeUndefined();
    expect(stub.issues.size).toBe(1);
  });

  test('status map: each darbar move lands on the mapped Linear state', async () => {
    const p = await linearProject();
    const t = await task(p.prefix, { lanes: [] });
    await settle();
    const id = (await row(t.shortId))!.linear!.id;
    for (const [status, state] of [['in_progress', 's-prog'], ['blocked', 's-blocked'], ['backlog', 's-backlog'], ['cancelled', 's-cancel']] as const) {
      await patch(t.shortId, { status });
      await settle();
      expect(stub.issues.get(id)!.stateId).toBe(state);
    }
  });

  test('notes, commits and a feedback promotion become comments; a pure echo of our write changes nothing', async () => {
    const p = await linearProject();
    const t = await task(p.prefix);
    await settle();
    await patch(t.shortId, { notes: 'spec v2' });
    await patch(t.shortId, { addCommit: 'abc1234' });
    const fb = await feedback({ project: p.prefix, body: 'button is blue', author: 'Janet' });
    await req('PATCH', `/feedback/${fb.shortId}`, { resolvedTaskRef: t.shortId });
    await settle();
    const bodies = stub.comments.map((c) => c.body);
    expect(bodies.length).toBe(3);
    expect(bodies[0]).toContain('spec v2');
    expect(bodies[1]).toContain('abc1234');
    expect(bodies[2]).toContain(fb.shortId);
    expect(bodies[2]).toContain('button is blue');
    const r = (await row(t.shortId))!;
    expect(r.linear!.outbox).toEqual([]);

    // the poll sees our own writes come back and must not write anything anywhere
    const before = { updatedAt: r.updatedAt.getTime(), calls: stub.calls.length };
    await pollOnce();
    await settle();
    expect((await row(t.shortId))!.updatedAt.getTime()).toBe(before.updatedAt);
    expect(stub.calls.slice(before.calls).filter((c) => c.startsWith('updateIssue') || c === 'createComment' || c === 'createIssue')).toEqual([]);
  });

  test('idempotent retry: a create whose answer was lost is adopted, never created twice; a failed comment is retried once', async () => {
    const p = await linearProject();
    stub.failNext.createIssueAfterWrite = 1;
    const t = await task(p.prefix, { title: 'lost reply' });
    await settle();
    let r = (await row(t.shortId))!;
    expect(r.linear!.created).toBe(false);
    expect(r.linear!.error).toContain('socket hang up');
    expect(stub.issues.size).toBe(1); // Linear DID create it

    await elapse(t.shortId);
    await pollOnce();
    await settle();
    r = (await row(t.shortId))!;
    expect(r.linear!.created).toBe(true);
    expect(r.linear!.error).toBeNull();
    expect(stub.issues.size).toBe(1);
    expect(stub.calls.filter((c) => c === 'createIssue').length).toBe(1);

    stub.failNext.createComment = 1;
    await patch(t.shortId, { notes: 'retry me' });
    await settle();
    expect((await row(t.shortId))!.linear!.outbox.length).toBe(1);
    await elapse(t.shortId);
    await pollOnce();
    await settle();
    expect(stub.comments.filter((c) => c.body.includes('retry me')).length).toBe(1);
    expect((await row(t.shortId))!.linear!.outbox).toEqual([]);
  });

  test('a Linear failure never fails the darbar write', async () => {
    const p = await linearProject();
    stub.failNext.createIssue = 1;
    const res = await req('POST', '/tasks', { project: p.prefix, title: 'still saved' });
    expect(res.status).toBe(200);
    await settle();
    expect((await row(String(res.body.shortId)))!.linear!.error).toContain('network down');
  });

  test('scope guard: an issue that lost the darbar label is never written to', async () => {
    const p = await linearProject();
    const t = await task(p.prefix);
    await settle();
    const id = (await row(t.shortId))!.linear!.id;
    stub.edit(id, { labelIds: [] }); // a colleague took the label off
    const before = stub.calls.length;
    await patch(t.shortId, { title: 'renamed here', notes: 'and noted' });
    await settle();
    expect(stub.calls.slice(before).filter((c) => c.startsWith('updateIssue') || c === 'createComment')).toEqual([]);
    expect(stub.issues.get(id)!.title).toBe('scratch task');
    expect((await row(t.shortId))!.linear!.error).toContain('scope guard');
  });
});

describe('inbound', () => {
  test('a flat darbar/<PREFIX> label made by hand is adopted, not shadowed by a new group child', async () => {
    const p = await linearProject();
    stub.labels.push({ id: 'flat', name: `darbar/${p.prefix}`, parentId: '' });
    stub.seed({ title: 'hand labelled', labelIds: ['flat'] });
    await pollOnce();
    await settle();
    expect(stub.calls.filter((c) => c.startsWith('createChildLabel'))).toEqual([]);
    expect(await Tasks.countDocuments({ title: 'hand labelled' })).toBe(1);
  });

  test('backfill: labelled issues become rows (unlabelled ones do not), mapped status, matched by identifier', async () => {
    const p = await linearProject();
    const label = `label-${p.prefix}`;
    const done = stub.seed({ title: 'already shipped', stateId: 's-done', labelIds: [label] });
    stub.seed({ title: 'in review', stateId: 's-review', labelIds: [label] });
    stub.seed({ title: 'a colleague ticket', labelIds: [] });
    // a hand-mirrored row filed before the sync ever ran, naming its issue: linked, not duplicated
    setLinearClient(null);
    const legacy = await task(p.prefix, { title: 'old name', notes: `mirrored as ${done.identifier}` });
    await new Promise((res) => setTimeout(res, 5));
    setLinearClient(stub);

    await pollOnce();
    await settle();
    const rows = await Tasks.find({ projectId: (await row(legacy.shortId))!.projectId }).toArray();
    const byTitle = new Map(rows.map((r) => [r.title, r]));
    expect(byTitle.has('a colleague ticket')).toBe(false);
    expect(byTitle.get('in review')!.status).toBe('in_review');
    expect(byTitle.get('in review')!.origin).toMatch(/^linear:MEE-/);
    const linked = (await row(legacy.shortId))!;
    expect(linked.title).toBe('already shipped');
    expect(linked.status).toBe('done');
    expect(linked.linear!.id).toBe(done.id);
    expect(rows.filter((r) => r.linear?.id === done.id).length).toBe(1);

    // a second poll over the same issues is a no-op
    const count = rows.length;
    await pollOnce();
    await settle();
    expect(await Tasks.countDocuments({ projectId: linked.projectId })).toBe(count);
  });

  test('upsert: a colleague change in Linear lands on the row; a both-sides conflict goes to the newer side', async () => {
    const p = await linearProject();
    const t = await task(p.prefix, { title: 'from darbar' });
    await settle();
    const id = (await row(t.shortId))!.linear!.id;

    stub.edit(id, { stateId: 's-prog', title: 'renamed in linear' });
    await pollOnce();
    await settle();
    let r = (await row(t.shortId))!;
    expect(r.status).toBe('in_progress');
    expect(r.title).toBe('renamed in linear');

    // both sides change the title while the push is failing; darbar is newer, so darbar wins
    stub.failNext.updateIssue = 1;
    await patch(t.shortId, { title: 'darbar edit (newer)' });
    await settle();
    expect((await row(t.shortId))!.linear!.error).toContain('500');
    clock = Date.now() - 60_000;
    stub.edit(id, { title: 'linear edit (older)' });
    await elapse(t.shortId);
    await pollOnce();
    await settle()
    expect(stub.issues.get(id)!.title).toBe('darbar edit (newer)');
    r = (await row(t.shortId))!;
    expect(r.title).toBe('darbar edit (newer)');

    // and the other way round: Linear is newer, so Linear wins
    stub.failNext.updateIssue = 1;
    await patch(t.shortId, { title: 'darbar edit (older)' });
    await settle();
    clock = Date.now() + 60_000;
    stub.edit(id, { title: 'linear edit (newer)' });
    await elapse(t.shortId);
    await pollOnce();
    await settle();
    expect((await row(t.shortId))!.title).toBe('linear edit (newer)');
    expect(stub.issues.get(id)!.title).toBe('linear edit (newer)');
  });
});

// ---------- DAR-310 rework: FB-167..170 ----------
const creates = () => stub.calls.filter((c) => c === 'createIssue').length;
/** a row filed while the mirror is off, so it predates the project's sync */
async function legacyRow(prefix: string, over: Record<string, unknown> = {}) {
  setLinearClient(null);
  const t = await task(prefix, over);
  await new Promise((res) => setTimeout(res, 5));
  setLinearClient(stub);
  return t;
}

describe('FB-167: the cutoff is per project, from its own first sync', () => {
  test('a project with done rows becomes linear-native at runtime: none of them is pushed', async () => {
    const p = await project();
    const old = [];
    for (const title of ['one', 'two', 'three']) {
      const t = await task(p.prefix, { title });
      await patch(t.shortId, { status: 'done' });
      old.push(t);
    }
    await new Promise((res) => setTimeout(res, 5));
    expect((await req('PATCH', `/projects/${p.prefix}`, { linearUrl: LINEAR_URL })).status).toBe(200);
    await patch(old[0]!.shortId, { notes: 'touched after the switch' }); // a hook on a legacy row
    await pollOnce();
    await settle();
    expect(stub.issues.size).toBe(0);
    expect(creates()).toBe(0);
    for (const t of old) expect((await row(t.shortId))!.linear).toBeUndefined();
    // and a row filed now is mirrored
    await task(p.prefix, { title: 'new here' });
    await settle();
    expect(creates()).toBe(1);
  });

  test('clearing and re-setting linearUrl restarts the cutoff', async () => {
    const p = await linearProject();
    await task(p.prefix, { title: 'while on' });
    await settle();
    expect(creates()).toBe(1);
    await req('PATCH', `/projects/${p.prefix}`, { linearUrl: null });
    const off = await task(p.prefix, { title: 'while off' });
    await new Promise((res) => setTimeout(res, 5));
    await req('PATCH', `/projects/${p.prefix}`, { linearUrl: LINEAR_URL });
    await pollOnce();
    await settle();
    expect(creates()).toBe(1);
    expect((await row(off.shortId))!.linear).toBeUndefined();
  });
});

describe('FB-168: an inbound status goes through the same gates as a darbar move', () => {
  test('Linear Review spawns the review lanes, so done is still gated', async () => {
    const p = await linearProject();
    const t = await task(p.prefix);
    await settle();
    const id = (await row(t.shortId))!.linear!.id;
    stub.edit(id, { stateId: 's-review' });
    await pollOnce();
    await settle();
    expect((await row(t.shortId))!.status).toBe('in_review');
    expect((await children(t.shortId)).length).toBe(1);
    expect((await patch(t.shortId, { status: 'done' })).status).toBe(409);
  });

  test('Linear Done over an open review is held: no ship, no cascade, Linear not flipped back', async () => {
    const p = await linearProject();
    const t = await task(p.prefix);
    await settle();
    await patch(t.shortId, { status: 'in_review' });
    const fb = await feedback({ project: p.prefix, body: 'from a colleague', author: 'Janet' });
    await req('PATCH', `/feedback/${fb.shortId}`, { resolvedTaskRef: t.shortId });
    await settle();
    const id = (await row(t.shortId))!.linear!.id;
    stub.edit(id, { stateId: 's-done' });
    const before = stub.calls.length;
    await pollOnce();
    await settle();
    await pollOnce();
    await settle();
    let r = (await row(t.shortId))!;
    expect(r.status).toBe('in_review');
    expect(r.linear!.held?.status).toBe('done');
    expect(r.linear!.held?.reason).toContain('open review');
    expect((await Feedback.findOne({ shortId: fb.shortId }))!.status).toBe('triaged');
    expect(stub.issues.get(id)!.stateId).toBe('s-done');
    expect(stub.calls.slice(before).filter((c) => c.startsWith('updateIssue'))).toEqual([]);

    // the review passes: darbar ships it itself, and the hold clears
    const kid = (await children(t.shortId))[0]!;
    await patch(kid.shortId, { status: 'done' });
    await settle();
    r = (await row(t.shortId))!;
    expect(r.status).toBe('done');
    expect(r.linear!.held ?? null).toBeNull();
    expect((await Feedback.findOne({ shortId: fb.shortId }))!.status).toBe('resolved');
  });

  test('Linear Done with no gate open ships the row and runs the ship cascade', async () => {
    const p = await linearProject();
    const t = await task(p.prefix, { lanes: [] });
    await settle();
    const fb = await feedback({ project: p.prefix, body: 'please fix', author: 'Janet' });
    await req('PATCH', `/feedback/${fb.shortId}`, { resolvedTaskRef: t.shortId });
    await settle();
    stub.edit((await row(t.shortId))!.linear!.id, { stateId: 's-done' });
    await pollOnce();
    await settle();
    expect((await row(t.shortId))!.status).toBe('done');
    expect((await Feedback.findOne({ shortId: fb.shortId }))!.status).toBe('resolved');
  });
});

describe('FB-169: backfill links only what names the issue', () => {
  test('a passing mention of an identifier is not a link', async () => {
    const p = await linearProject();
    const issue = stub.seed({ title: 'Xplan E2E blocker', stateId: 's-done', labelIds: [`label-${p.prefix}`] });
    const mine = await legacyRow(p.prefix, { title: 'my own row', notes: `blocked on ${issue.identifier}` });
    await pollOnce();
    await settle();
    const r = (await row(mine.shortId))!;
    expect(r.title).toBe('my own row');
    expect(r.status).toBe('todo');
    expect(r.linear).toBeUndefined();
    expect(await Tasks.countDocuments({ 'linear.id': issue.id })).toBe(1);
  });

  test('title: the one legacy row, case-insensitively; ambiguous links nothing until marked; newer rows never', async () => {
    const p = await linearProject();
    const label = `label-${p.prefix}`;
    const gate = stub.seed({ title: 'Ship The Gate', labelIds: [label] });
    const dup = stub.seed({ title: 'dup title', labelIds: [label] });
    const legacy = await legacyRow(p.prefix, { title: 'ship the gate' });
    const d1 = await legacyRow(p.prefix, { title: 'Dup Title' });
    const d2 = await legacyRow(p.prefix, { title: 'dup title' });
    await pollOnce();
    await settle();
    expect((await row(legacy.shortId))!.linear!.id).toBe(gate.id);
    expect(await Tasks.countDocuments({ 'linear.id': gate.id })).toBe(1);
    expect((await row(d1.shortId))!.linear).toBeUndefined();
    expect((await row(d2.shortId))!.linear).toBeUndefined();
    expect(await Tasks.countDocuments({ 'linear.id': dup.id })).toBe(0);
    const proj = (await Projects.findOne({ prefix: p.prefix }))!;
    expect(proj.linearSync!.pending!.map((x) => x.issue.id)).toEqual([dup.id]);

    // the orchestrator marks the right row; the next poll links it from the pending snapshot
    await Tasks.updateOne({ shortId: d2.shortId }, { $set: { notes: `mirrored as ${dup.identifier}` } });
    await pollOnce();
    await settle();
    expect((await row(d2.shortId))!.linear!.id).toBe(dup.id);
    expect((await Projects.findOne({ prefix: p.prefix }))!.linearSync!.pending).toEqual([]);

    // a row filed after the sync started is never title-matched: it gets its own issue
    const late = await legacyRow(p.prefix, { title: 'late row' });
    const lateIssue = stub.seed({ title: 'late row', labelIds: [label] });
    await pollOnce();
    await settle();
    expect((await row(late.shortId))!.linear!.id).not.toBe(lateIssue.id);
    expect(await Tasks.countDocuments({ 'linear.id': lateIssue.id })).toBe(1);
  });
});

describe('FB-170: deltas, backoff, no dropped issues, no lost edits', () => {
  test('a notes append posts only what was appended', async () => {
    const p = await linearProject();
    const t = await task(p.prefix);
    await settle();
    await patch(t.shortId, { notes: 'first line' });
    await patch(t.shortId, { notes: 'first line\nsecond line' });
    await settle();
    expect(stub.comments.length).toBe(2);
    expect(stub.comments[1]!.body).toContain('second line');
    expect(stub.comments[1]!.body).not.toContain('first line');
  });

  test('a failing row backs off between polls and gives up after MAX_FAILURES, keeping its error', async () => {
    const p = await linearProject();
    stub.failNext.createIssue = 1000;
    const t = await task(p.prefix);
    await settle();
    expect(creates()).toBe(1);
    for (let i = 0; i < 3; i++) { await pollOnce(); await settle(); }
    expect(creates()).toBe(1); // backing off
    for (let i = 0; i < MAX_FAILURES + 2; i++) { await elapse(t.shortId); await pollOnce(); await settle(); }
    expect(creates()).toBe(MAX_FAILURES);
    const r = (await row(t.shortId))!;
    expect(r.linear!.gaveUp).toBe(true);
    expect(r.linear!.error).toContain('network down');
  });

  test('a backfill link that fails is retried after the cursor has moved past it', async () => {
    const p = await linearProject();
    const label = `label-${p.prefix}`;
    const a = stub.seed({ title: 'A', labelIds: [label] });
    stub.seed({ title: 'B', labelIds: [label] }); // updated later, so the cursor passes A
    const insert = Tasks.insertOne.bind(Tasks);
    (Tasks as unknown as { insertOne: unknown }).insertOne = async (doc: { title?: string }) => {
      if (doc.title === 'A') throw new Error('mongo: write failed');
      return insert(doc as never);
    };
    try { await pollOnce(); await settle(); } finally { (Tasks as unknown as { insertOne: unknown }).insertOne = insert; }
    expect(await Tasks.countDocuments({ 'linear.id': a.id })).toBe(0);
    await pollOnce();
    await settle();
    expect(await Tasks.countDocuments({ 'linear.id': a.id })).toBe(1);
    expect((await Projects.findOne({ prefix: p.prefix }))!.linearSync!.pending).toEqual([]);
  });

  test('a comment whose reply was lost is not posted twice', async () => {
    const p = await linearProject();
    const t = await task(p.prefix);
    await settle();
    stub.failNext.createCommentAfterWrite = 1;
    await patch(t.shortId, { notes: 'once only' });
    await settle();
    await elapse(t.shortId);
    await pollOnce();
    await settle();
    expect(stub.comments.filter((c) => c.body.includes('once only')).length).toBe(1);
    expect((await row(t.shortId))!.linear!.outbox).toEqual([]);
  });

  test('a poll snapshot older than what the row has seen is refetched, never merged', async () => {
    clock = Date.now();
    const p = await linearProject();
    const t = await task(p.prefix, { title: 'first' });
    await settle();
    const id = (await row(t.shortId))!.linear!.id;
    const snapshot = { ...stub.issues.get(id)! };
    await patch(t.shortId, { title: 'second' });
    await settle();
    stub.listOverride = [snapshot];
    await pollOnce();
    await settle();
    expect((await row(t.shortId))!.title).toBe('second');
    expect(stub.issues.get(id)!.title).toBe('second');
  });

  test('a pull never lands over a darbar edit made during the same pass', async () => {
    clock = Date.now() - 120_000; // Linear's edits are older than darbar's
    const p = await linearProject();
    const t = await task(p.prefix);
    await settle();
    const id = (await row(t.shortId))!.linear!.id;
    stub.failNext.updateIssue = 1;
    await patch(t.shortId, { description: 'needs a push' });
    await settle();
    stub.edit(id, { title: 'linear title' });
    await elapse(t.shortId);
    stub.onUpdate = async () => { await patch(t.shortId, { title: 'darbar mid-pass' }); };
    await pollOnce();
    await settle();
    expect((await row(t.shortId))!.title).toBe('darbar mid-pass');
    expect(stub.issues.get(id)!.title).toBe('darbar mid-pass');
  });
});

test('no key: one startup log line, and every hook is a no-op', async () => {
  setLinearClient(null);
  const lines: string[] = [];
  const stop = startLinearSync('', (s) => lines.push(s));
  expect(lines).toEqual(['linear sync off: LINEAR_API_KEY is not set, linear-native projects are not mirrored']);
  const p = await linearProject();
  const t = await task(p.prefix);
  await patch(t.shortId, { notes: 'x', status: 'in_progress' });
  await pollOnce();
  await settle();
  expect((await row(t.shortId))!.linear).toBeUndefined();
  expect(stub.calls).toEqual([]);
  stop();
});

test('graphql client: key sent bare in Authorization, never echoed into an error', async () => {
  const { graphqlLinearClient } = await import('./linear');
  const seen: Record<string, string>[] = [];
  const fake = (async (_u: string, init: RequestInit) => {
    seen.push(init.headers as Record<string, string>);
    return new Response(JSON.stringify({ errors: [{ message: 'Authentication required' }] }), { status: 400 });
  }) as unknown as typeof fetch;
  const c = graphqlLinearClient('lin_api_SECRET', { fetch: fake });
  const err = await c.teamByKey('MEE').catch((e: Error) => e.message);
  expect(seen[0]!.authorization).toBe('lin_api_SECRET');
  expect(String(err)).toBe('linear: Authentication required');
  expect(String(err)).not.toContain('SECRET');
});
