# Orchestrator drain loop

The standing manager loop a Darbar orchestrator session runs after
`darbar-project-init` step 6. The orchestrator writes no code: it drains
feedback, keeps the board truthful, and dispatches builders. All examples use
`DAR` as the project prefix; swap in yours. API base: `http://localhost:4899/api`
(MCP tools wrap the same routes — use either).

## 1. The loop

Poll pending feedback for your project; the route returns oldest-first already:

```bash
curl -s 'localhost:4899/api/feedback/pending?project=DAR'
```

Rows come back in `pending` or `needs_clarification` (a thread reply reopens a
clarification row to `pending`; it re-appears here — never duplicate it).

Self-paced: in a Claude session, pace with ScheduleWakeup-style waits rather
than spinning. Active board = poll every few minutes; quiet board (empty result,
no open dispatches) = back off to 20-30 min. Each wake is one **round**: drain
the queue to empty, dispatch, audit (section 5), then sleep.

## 2. Triage verbs

Every drained item gets exactly one verb, applied via
`PATCH /api/feedback/:shortId`. The three terminal-ish states
(`resolved`, `rejected`, `needs_clarification`) auto-reply in the author's
original Slack thread server-side — write `resolution` as a human-readable
sentence, it is the reply text.

**Rework an existing task** — the defect belongs to a task already on the
board. Reopen the task, park the feedback on it, resolve when the rework lands:

```bash
curl -s -X PATCH localhost:4899/api/tasks/DAR-7 -H 'content-type: application/json' \
  -d '{"status":"todo","notes":"reopened for FB-3: button still clips on mobile"}'
curl -s -X PATCH localhost:4899/api/feedback/DAR-FB-3 -H 'content-type: application/json' \
  -d '{"status":"accepted","resolvedTaskRef":"DAR-7"}'
# ...later, when DAR-7 closes:
curl -s -X PATCH localhost:4899/api/feedback/DAR-FB-3 -H 'content-type: application/json' \
  -d '{"status":"resolved","resolution":"Fixed in DAR-7; mobile clipping gone."}'
```

**Create a new task** — real work with no card yet:

```bash
curl -s -X POST localhost:4899/api/tasks -H 'content-type: application/json' \
  -d '{"project":"DAR","title":"Fix export CSV encoding","type":"bug","origin":"feedback:DAR-FB-4","description":"..."}'
curl -s -X PATCH localhost:4899/api/feedback/DAR-FB-4 -H 'content-type: application/json' \
  -d '{"status":"resolved","resolvedTaskRef":"DAR-12","resolution":"Tracked as DAR-12, in this cycle."}'
```

(Resolve immediately when "there is now a card" answers the author; keep it
`accepted` + `resolvedTaskRef` instead if they should only hear back on ship.)

**Reject** — out of scope, working as intended, or won't do. Always give the reason:

```bash
curl -s -X PATCH localhost:4899/api/feedback/DAR-FB-5 -H 'content-type: application/json' \
  -d '{"status":"rejected","resolution":"Intentional: drafts autosave, no Save button planned."}'
```

**Needs clarification** — cannot triage without more. `resolution` carries the question:

```bash
curl -s -X PATCH localhost:4899/api/feedback/DAR-FB-6 -H 'content-type: application/json' \
  -d '{"status":"needs_clarification","resolution":"which browser and page? A screenshot would help."}'
```

The author's thread reply flips the row back to `pending`; it returns in a
later round with the answer appended.

## 3. Dedupe

Same defect from two authors = **one task**, both feedback rows resolved
pointing at it (each author gets their own thread reply):

```bash
curl -s -X PATCH localhost:4899/api/feedback/DAR-FB-8 -H 'content-type: application/json' \
  -d '{"status":"resolved","resolvedTaskRef":"DAR-12","resolution":"Same root cause, tracked as DAR-12."}'
curl -s -X PATCH localhost:4899/api/feedback/DAR-FB-9 -H 'content-type: application/json' \
  -d '{"status":"resolved","resolvedTaskRef":"DAR-12","resolution":"Already tracked as DAR-12."}'
```

Before creating any task, scan open tasks for an existing card
(`GET /api/tasks?project=DAR&open=true`).

## 4. Dispatch

One builder subagent per task, one scoped task each. The builder owns its own
row: it PATCHes itself `in_progress` on start and `in_review` (with `notes`)
when done. The orchestrator never moves a dispatched task's status by hand.

```bash
# builder, on start / on finish:
curl -s -X PATCH localhost:4899/api/tasks/DAR-12 -H 'content-type: application/json' -d '{"status":"in_progress"}'
curl -s -X PATCH localhost:4899/api/tasks/DAR-12 -H 'content-type: application/json' -d '{"status":"in_review","notes":"2-line summary"}'
```

Entering `in_review` spawns the review lanes **server-side** (one `type=review`
subtask per `project.pipeline.reviews` lane, assigned to that lane's manager).
Pick a task's lanes by judgment at `create_task` time via `lanes` (code-review
for code, qa for behavior/outcomes, design-qa only for UI; `[]` = no reviews;
omit = all configured lanes).
Never hand-create review tasks. Lane managers drain their queue, review, file
findings as feedback on the parent, and close their lane:

```bash
curl -s 'localhost:4899/api/tasks?assignee=code-review-manager&open=true'
curl -s -X POST localhost:4899/api/feedback -H 'content-type: application/json' \
  -d '{"taskRef":"DAR-12","author":"code-review-manager","authorType":"agent","type":"bug","body":"finding: ..."}'
curl -s -X PATCH localhost:4899/api/tasks/DAR-13 -H 'content-type: application/json' \
  -d '{"status":"done","notes":"lane passed"}'
```

The parent takes care of itself: `done` is rejected (409) while review children
are open, and closing the last lane auto-advances the parent to `done` (unless
`pipeline.autoAdvance` is false — then push it explicitly). Lane findings
arrive as agent-authored feedback in your normal drain; triage them like any
other row (usually: rework verb on the parent).

## 5. End-of-round board audit

Before sleeping, reconcile board vs. reality:

- Every known pending piece of work has a card. Anything learned this round —
  from feedback threads, builder notes, lane findings, your own observations —
  that isn't on the board gets seeded (`POST /api/tasks`) before the round ends.
- No task sits `in_progress` with a dead builder; re-dispatch or mark `blocked`
  (with `blocker`).
- Nothing gated: check for `in_review` parents whose lanes all closed under
  `autoAdvance:false`, and `blocked` tasks whose blocker has cleared.
- Log anything worth a trace: `POST /api/events {"project":"DAR","text":"..."}`.

## 6. Resume contract

A fresh session must be able to take over from the API alone — keep all state
on the board (statuses, notes, blockers, origins), never only in session memory.
Cold-start sequence:

```bash
curl -s localhost:4899/api/projects                      # find project, capId, pending-fb counts
curl -s localhost:4899/api/projects/DAR/context          # charter = standing protocols
curl -s localhost:4899/api/p/<capId>                     # full board: tasks + feedback + events
curl -s 'localhost:4899/api/tasks?project=DAR&open=true' # the working set
curl -s 'localhost:4899/api/feedback/pending?project=DAR'
```

If that sequence would not tell your successor everything you know, the board
is missing state — fix that before ending the round.
