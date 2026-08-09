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
the queue to empty, dispatch, audit (section 6), then sleep.

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
  -d '{"project":"DAR","title":"Fix export CSV encoding","type":"bug","origin":"feedback:DAR-FB-4","lanes":["code-review"],"description":"..."}'
curl -s -X PATCH localhost:4899/api/feedback/DAR-FB-4 -H 'content-type: application/json' \
  -d '{"status":"resolved","resolvedTaskRef":"DAR-12","resolution":"Tracked as DAR-12, in this cycle."}'
```

(Resolve immediately when "there is now a card" answers the author; keep it
`accepted` + `resolvedTaskRef` instead if they should only hear back on ship.
`lanes` is on the create call on purpose: see section 4 for how to pick it.)

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

When the agent is in the project's agent registry
(`GET /api/projects/DAR/context` → `agents: [{name, kind, brief, trigger?}]`,
or the `get_project_context` MCP tool), that is where the prompt comes from: the
agent's `brief` IS its standing charter — dispatch it verbatim plus that task's
context. Do not improvise a charter for an agent that has one.

Stamp the dispatch as you hand it out (`PATCH {"dispatched": true}`): the board then
shows a DISPATCHED badge with its age, which turns red after 15 minutes with no
`in_progress` report. Any status change clears the stamp server-side, so a builder
that reports in retires its own badge.

```bash
# orchestrator, at the moment the builder is handed the task:
curl -s -X PATCH localhost:4899/api/tasks/DAR-12 -H 'content-type: application/json' -d '{"dispatched":true}'
# builder, on start / on finish:
curl -s -X PATCH localhost:4899/api/tasks/DAR-12 -H 'content-type: application/json' -d '{"status":"in_progress"}'
curl -s -X PATCH localhost:4899/api/tasks/DAR-12 -H 'content-type: application/json' -d '{"status":"in_review","notes":"2-line summary"}'
```

Entering `in_review` spawns the review lanes **server-side** (one `type=review`
subtask per lane the task selected, each assigned to that lane's manager from
`project.pipeline.reviews`). That makes `lanes` a decision you make when you FILE
the task, and it is mandatory: always send it explicitly at `create_task`. Omit
the field and the `in_review` PATCH spawns every configured lane, which is how one
routine feature ate three review agents plus three rounds of re-verification.

- `lanes: ["code-review"]` is the default and the right answer for ordinary work.
- Add `qa` only when reading the diff cannot answer the question. A live data
  migration is the standard case: the code can be correct while the migrated
  rows are wrong.
- Add `design-qa` only for a UI surface a human will actually look at.
- Helper and bookkeeping rows get `lanes: []`, so `in_review` closes itself.
- Keep the full set plus re-verification for work that can hurt someone: the
  public front door, anything touching exposure.

Lane keys must exist in the pipeline (unknown keys 400), and the selection
freezes once the review flow starts — status in `in_review|qa|done|cancelled`
(note `blocked` is not frozen), or any review child already spawned (closed ones
included), both 409. So the lane you left off stays off; decide once, at filing.
Never hand-create review tasks. Lane managers drain their queue, review, file
findings as feedback on the parent, and close their lane:

```bash
curl -s 'localhost:4899/api/tasks?assignee=staff-engineer&open=true'
curl -s -X POST localhost:4899/api/feedback -H 'content-type: application/json' \
  -d '{"taskRef":"DAR-12","author":"staff-engineer","authorType":"agent","type":"bug","body":"finding: ..."}'
curl -s -X PATCH localhost:4899/api/tasks/DAR-13 -H 'content-type: application/json' \
  -d '{"status":"done","notes":"lane passed"}'
```

The parent takes care of itself: `done` is rejected (409) while review children
are open, and closing the last lane auto-advances the parent to `done` (unless
`pipeline.autoAdvance` is false — then push it explicitly). Lane findings
arrive as agent-authored feedback in your normal drain; triage them like any
other row (usually: rework verb on the parent).

**One review round is the norm.** A lane returns SHIP or BLOCK. On BLOCK, sort
the findings first: the ones you accept go to ONE builder as a single rework
task, and that rework is verified with tests plus a typecheck, not by opening a
fresh lane. Findings that are real but not blocking become their own backlog
tasks and never sit on a ship gate. Putting the same change through a second
review round needs a reason you can say out loud, beyond wanting to be thorough.

**Helpers** (`kind: "helper"` in the registry — deploy, seeding, migrations,
release notes) are dispatched exactly like builders. Give the run a task row,
prompt the subagent with the helper's `brief` plus the task context, and let it
PATCH its own row from `in_progress` to `in_review`/`done` — helper work shows
on the board like everyone else's, never as an invisible side errand:

```bash
curl -s -X POST localhost:4899/api/tasks -H 'content-type: application/json' \
  -d '{"project":"DAR","title":"Deploy DAR-12 branch to devx","type":"chore","assignee":"deploy-devx","origin":"helper:DAR-12","lanes":[]}'
```

A registry `trigger` ("after a task's review lanes close") is a hint about when
it usually fires, not an automatic rule — nothing server-side dispatches
helpers. You still decide whether this task warrants one.

## 5. The shared surface, if the project has one

Some projects publish one local dev server through the proxy at
`<baseUrl>/<prefix>/` (configured by `set_proxy` at init, see the
`darbar-project-init` skill). That URL is not a secret and must not be treated as one: the
board link carries a 21-char random `capId` and is genuinely unguessable, but the prefix is
a short word a human chose, so `<baseUrl>/<prefix>/` is guessable by anyone who knows the
domain. The `public` patterns are the boundary; the prefix is not a credential. They match
the path AFTER the prefix is stripped: at prefix `dar`, the public request
`/dar/assets/app.js` is matched as `/assets/app.js`, so an entry written `/dar/assets/`
matches nothing and the route serves nothing. Two things belong to the orchestrator.

**Announce it with the board link.** When Gabbar posts the project announcement,
the shared URL goes right next to the board URL, with a line saying what it is
("the dev server, live while I am working"). A link nobody was told about gets
asked for in DMs instead. `GET /api/projects/DAR/context` has the config, and
the board payload (`GET /api/p/:capId`) carries `baseUrl` plus the published
prefix so you can state the link exactly as a stakeholder receives it. Do not
paste the target host:port anywhere a link-holder can read: the public board
redacts it on purpose, and only the local context route returns it.

**Tear it down when the project closes.** There is no login in front of that route and
nothing but the `public` list keeps a passer-by out, so a finished project with a live
route is an open door nobody is watching. Withdraw it as part of closing out:

```bash
# keep the config, take the URL down:
curl -s -X PATCH localhost:4899/api/projects/DAR -H 'content-type: application/json' \
  -d '{"proxy":{"prefix":"fe","target":"http://127.0.0.1:5173/fe","public":["/"],"enabled":false}}'
# or clear it entirely:
curl -s -X PATCH localhost:4899/api/projects/DAR -H 'content-type: application/json' -d '{"proxy":null}'
```

The proxy config is replaced wholesale, so send the whole object when you
disable. Then confirm rather than assume: the returned project doc carries
`proxyPublished`, which is what the server reports it actually put in the route
table and has not withdrawn, and the reconcile writes what it published or
withdrew into the project event log (visible on the board payload). An empty
`proxyPublished` is the state you want at close. If the reconcile could not reach
the proxy it says so and leaves the route live, and the next change or a server
restart converges it, so re-check instead of walking away on the first 200.

## 6. End-of-round board audit

Before sleeping, reconcile board vs. reality:

- Every known pending piece of work has a card. Anything learned this round —
  from feedback threads, builder notes, lane findings, your own observations —
  that isn't on the board gets seeded (`POST /api/tasks`) before the round ends.
- No task sits `in_progress` with a dead builder; re-dispatch or mark `blocked`
  (with `blocker`).
- No dispatch stamp is older than 15 minutes: a `dispatchedAt` that old on a
  `todo`/`backlog` row (the red DISPATCHED badge) means the builder never reported
  in. Re-dispatch it or mark it `blocked`, and never assume it started.
- Nothing gated: check for `in_review` parents whose lanes all closed under
  `autoAdvance:false`, and `blocked` tasks whose blocker has cleared.
- If the project shares a surface, the live route still matches what you meant to
  share: compare `proxy` against `proxyPublished`. Config off with a route still
  published means the withdrawal did not land, and the URL is still open.
- Log anything worth a trace: `POST /api/events {"project":"DAR","text":"..."}`.

## 7. Resume contract

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
