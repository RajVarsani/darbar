# Orchestrator loop, wire reference

The executable half of the orchestrator job: exact routes, bodies, field allowlists,
error strings, and the cold-start sequence. All examples use `DAR` as the project
prefix; swap in yours. API base: `http://localhost:4899/api`. The MCP tools wrap the
same routes, so either is fine.

**The `darbar-project-init` skill is the authority**, and it is the full operating manual:
every lifecycle as implemented, the reasoning behind each rule, and how to recover a board
someone else left mid-flight. It is self-sufficient; this file is not. The division of
labour, stated so the two do not drift:

- Every rule's **reasoning, edge cases and recovery** live only in the skill. Nothing here
  is the sole home of a rule.
- This file carries **commands, exact bodies, error strings and the per-round checklist**,
  and states a binding rule as a bare imperative when a command is easy to fire with the
  wrong expectation. Those imperatives are duplication on purpose, kept to one clause.
- Where the two overlap, **the skill wins**. If you change a rule, change it there first
  and reduce whatever is here to a pointer.

Standing constraints in one block, so no command below is available without them:

- The orchestrator writes no code. One subagent per task, each with its own board row.
- One writer per file. Concurrent agents only on disjoint files.
- `lanes` is mandatory and explicit at create. Default `["code-review"]`. Omitting the
  field spawns every configured lane.
- One review round is the norm. On BLOCK, fold accepted findings into ONE rework and
  verify with tests plus a typecheck.
- The board carries ALL known pending work, human-owned included, at all times.
- Slack is draft-first. Never send without approval in that turn.
- Commit per task after its lanes close; stage by explicit path; never `git add -A`.

## 1. The round

Poll pending feedback for your project; the route returns oldest-first already, and
includes `needs_clarification`. A thread reply reopens such a row to `pending` with its
body unchanged: the answer is in Slack, not on the row, so open the thread from
`slack.channel` / `slack.ts` before re-triaging. A follow-up may also arrive as a separate
row; dedupe it (skill, B3).

```bash
curl -s 'localhost:4899/api/feedback/pending?project=DAR'
```

Self-paced: pace with ScheduleWakeup-style waits rather than spinning. Active board =
every few minutes; quiet board (empty result, no open dispatches) = back off to 20 to 30
minutes. Each wake is one round: drain the queue to empty, dispatch, audit (section 8),
then sleep.

## 2. Triage verbs

Every drained item gets exactly one verb, applied via `PATCH /api/feedback/:shortId`.
`resolved`, `rejected` and `needs_clarification` auto-reply in the author's Slack
thread, using the `resolution` **in that same request body**. Send it every time.

**Rework an existing task.** The defect belongs to a card already on the board:

```bash
curl -s -X PATCH localhost:4899/api/tasks/DAR-7 -H 'content-type: application/json' \
  -d '{"status":"todo","notes":"reopened for FB-3: button still clips on mobile"}'
curl -s -X PATCH localhost:4899/api/feedback/DAR-FB-3 -H 'content-type: application/json' \
  -d '{"status":"accepted","resolvedTaskRef":"DAR-7"}'
# ...later, when DAR-7 closes: nothing to do if FB-3 was promoted onto it (section 5).
```

**Create a new task.** Real work with no card yet:

```bash
curl -s -X POST localhost:4899/api/tasks -H 'content-type: application/json' \
  -d '{"project":"DAR","title":"Fix export CSV encoding","type":"bug","origin":"feedback:DAR-FB-4","lanes":["code-review"],"description":"..."}'
curl -s -X PATCH localhost:4899/api/feedback/DAR-FB-4 -H 'content-type: application/json' \
  -d '{"status":"resolved","resolvedTaskRef":"DAR-12","resolution":"Tracked as DAR-12, in this cycle."}'
```

Resolve immediately when "there is now a card" answers the author; keep it `accepted` or
`triaged` plus `resolvedTaskRef` instead if they should only hear back on ship.

**Reject.** Out of scope, working as intended, or will not do. Always give the reason:
with no `resolution` the server posts `no reason given (that is a bug, flag it)` into the
author's thread.

```bash
curl -s -X PATCH localhost:4899/api/feedback/DAR-FB-5 -H 'content-type: application/json' \
  -d '{"status":"rejected","resolution":"Intentional: drafts autosave, no Save button planned."}'
```

**Needs clarification.** `resolution` carries the question. This state does NOT block the
task's `done`, so do not use it as a hold:

```bash
curl -s -X PATCH localhost:4899/api/feedback/DAR-FB-6 -H 'content-type: application/json' \
  -d '{"status":"needs_clarification","resolution":"which browser and page? A screenshot would help."}'
```

## 3. Dedupe

Same defect from two authors is ONE task and two rows pointing at it, so each author gets
their own thread reply. Scan for an existing card before creating anything:
`GET /api/tasks?project=DAR&open=true`.

```bash
curl -s -X PATCH localhost:4899/api/feedback/DAR-FB-8 -H 'content-type: application/json' \
  -d '{"status":"resolved","resolvedTaskRef":"DAR-12","resolution":"Same root cause, tracked as DAR-12."}'
curl -s -X PATCH localhost:4899/api/feedback/DAR-FB-9 -H 'content-type: application/json' \
  -d '{"status":"resolved","resolvedTaskRef":"DAR-12","resolution":"Already tracked as DAR-12."}'
```

## 4. Dispatch

One builder subagent per task, one scoped task each. The builder owns its row:
`in_progress` on start, `in_review` with `notes` when done, `blocked` with `blocker` if
stuck. The orchestrator never moves a dispatched task's status by hand.

The prompt is the agent's registry `brief` verbatim
(`GET /api/projects/DAR/context` → `agents: [{name, kind, brief, trigger?}]`) plus that
task's context. Do not improvise a charter for an agent that has one.

```bash
# orchestrator, at the moment the builder is handed the task:
curl -s -X PATCH localhost:4899/api/tasks/DAR-12 -H 'content-type: application/json' -d '{"dispatched":true}'
# builder, on start / on finish:
curl -s -X PATCH localhost:4899/api/tasks/DAR-12 -H 'content-type: application/json' -d '{"status":"in_progress"}'
curl -s -X PATCH localhost:4899/api/tasks/DAR-12 -H 'content-type: application/json' -d '{"status":"in_review","notes":"2-line summary"}'
```

`dispatched` is a boolean verb; the server owns the clock. A status CHANGE clears the
stamp (the agent's own report supersedes the hand-off); re-sending the same status does
not. The board shows the badge with its age and reds it past 15 minutes, but only on
`todo`/`backlog` rows.

Helpers are dispatched the same way, with their own row and `lanes: []`:

```bash
curl -s -X POST localhost:4899/api/tasks -H 'content-type: application/json' \
  -d '{"project":"DAR","title":"Deploy DAR-12 branch to devx","type":"chore","assignee":"deploy-devx","origin":"helper:DAR-12","lanes":[]}'
```

A registry `trigger` is a hint. Nothing server-side dispatches helpers.

## 5. Lanes

Entering `in_review` spawns one `type=review` child per selected lane, assigned to that
lane's `manager` from `project.pipeline.reviews`. Spawning happens on the TRANSITION into
`in_review`, so a task created at `in_review` never spawns anything, and a parent pushed
out and back in spawns a whole fresh round.

Selection: `["code-review"]` default, add `qa` only when the diff cannot answer the
question (live data migration), add `design-qa` only for a UI surface a human will look
at, `[]` for helper and bookkeeping rows, the full set only for the public front door or
anything touching exposure.

Lane keys are NOT on `/projects/:ref/context`. Read them from `GET /api/projects`
(everything but the charter, and line 1 of the cold start) or the board payload
(`/api/p/:capId` → `project.pipeline`); a wrong key also 400s with the valid list.

Manager queue, finding, close:

```bash
curl -s 'localhost:4899/api/tasks?assignee=staff-engineer&open=true'
curl -s -X POST localhost:4899/api/feedback -H 'content-type: application/json' \
  -d '{"taskRef":"DAR-12","author":"staff-engineer","authorType":"agent","type":"bug","body":"finding: ..."}'
curl -s -X PATCH localhost:4899/api/tasks/DAR-13 -H 'content-type: application/json' \
  -d '{"status":"done","notes":"lane passed"}'
```

Never hand-create a `type=review` task; the route accepts one and it will have no gate
behind it. Findings go on the PARENT, which is what holds the parent's `done`.

## 6. Gates and error strings

Both `done` gates apply to non-review tasks only. A review child's own close is never
gated.

| Attempt | Result |
|---|---|
| `done` with an open review child | 409 `has N open review subtask(s); close them (or cancel them) first` |
| `done` with feedback filed on it in `pending`/`triaged`/`accepted`/`in_progress` | 409 `has N open feedback row(s) (DAR-FB-3); resolve or reject them first` |
| `done` with only `needs_clarification` feedback | allowed |
| `lanes` on a task in `in_review`/`qa`/`done`/`cancelled` | 409 `lanes are frozen once the review flow starts` (`blocked` is NOT frozen) |
| `lanes` on a task with any review child, closed ones included | 409 `already has review children; lanes cannot change` |
| `lanes` with an unknown key | 400 `unknown lane(s): x; valid lane keys: ...` |
| `lanes: [123]` | 400 `lanes must be null or an array of lane-key strings` |
| `dispatched: "yes"` | 400 `dispatched must be true (stamp now) or false (clear)` |
| prefix with a digit on `POST /projects` | 400 `name (string) and prefix (2-6 letters) required` |
| duplicate project prefix | 409 |
| `resolvedTaskRef` naming a task that does not exist | 200, silently unlinked. Read back `resolvedTaskShortId` |

Last review child closes and then, in order: open reviews? hold. Blocking feedback?
log `reviews closed but N open feedback (...) — holding`. `autoAdvance:false`? log
`all reviews closed — awaiting explicit push out of in_review`. Otherwise set `done`,
clear the dispatch stamp, and auto-resolve every row promoted onto it (`triaged`,
`accepted`, `in_progress`) with `shipped: DAR-12 (title) is done (commit abc123)` plus a
thread reply, then re-run the same check on whatever task those rows were filed on. That
cascade is what closes a one-round BLOCK with no manual status moves.

`lanes: []` self-closes only when `autoAdvance` is true. With it false the row waits for
an explicit push like any other.

## 7. Field allowlists

Anything not listed is ignored with a 200, so a rejected field looks like a success.

- `POST /tasks`: `project`, `title`, `description`, `status`, `type`, `parentTaskRef`,
  `lane`, `lanes`, `assignee`, `assigneeType`, `origin`, `notes`. No status gate: any
  status, including `done`, is accepted at create.
- `PATCH /tasks/:ref`: `title`, `description`, `status`, `notes`, `type`, `assignee`,
  `blocker`, `lane`, `assigneeType`, `dispatched`, `lanes`, `addCommit` (append-only,
  one hash per call). NOT settable: `origin`, `commits`, `shortId`, `parentTaskRef`,
  project. Origin and parentage are create-time only.
- `POST /feedback`: `taskRef` or `project`, `author`, `authorType`, `type`, `body`,
  `attachments`, `slack`. Always lands at `pending`.
- `PATCH /feedback/:shortId`: `status`, `resolution`, `type`, `resolvedTaskRef`.
  Promotion from `pending` with no explicit status auto-sets `triaged`.
- `PATCH /projects/:ref`: `charter`, `slackChannel`, `pipeline`, `agents`, `proxy`.
  Each replaces its value wholesale; read, edit, send whole. An empty body 400s.
- `POST /projects`: `name`, `prefix`, `repos`, `charter`, `stakeholders`, `slackChannel`
  only. `pipeline`, `agents` and `proxy` sent here are dropped silently.

MCP tools cover most of this but not all: `update_task` has no `title`, `description`,
`lane` or `assigneeType`; `create_task` has no `notes` or `lane`; there is no
create-project tool; `resolve_feedback` cannot set `pending` (only Gabbar's thread reopen
does). Use curl for those.

## 8. End-of-round board audit

What to run before sleeping. What each finding MEANS, and how to recover it, is the skill's
Part D; this is the sweep.

```bash
curl -s "localhost:4899/api/p/$CAP" > /tmp/board.json   # every task, no 200-row cap
python3 - <<'PY'
import json, datetime
d = json.load(open('/tmp/board.json'))
now = datetime.datetime.now(datetime.timezone.utc)
age = lambda s: (now - datetime.datetime.fromisoformat(s.replace('Z','+00:00'))).total_seconds()/60
rev = [t for t in d['tasks'] if t['type'] == 'review']
openrev = lambda p: [r for r in rev if r['parentTaskId'] == p['_id'] and r['status'] not in ('done','cancelled')]
for t in d['tasks']:
    if t['type'] == 'review': continue
    if t.get('dispatchedAt') and t['status'] in ('todo','backlog') and age(t['dispatchedAt']) > 15:
        print('STALE DISPATCH', t['shortId'], int(age(t['dispatchedAt'])), 'min, never reported in')
    if t['status'] == 'in_review' and not openrev(t):
        print('HELD IN REVIEW', t['shortId'], '(check feedback filed on it, then autoAdvance)')
    if t['status'] == 'in_review' and not [r for r in rev if r['parentTaskId'] == t['_id']]:
        print('NO LANES EVER SPAWNED', t['shortId'], '(created at in_review?)')
    if t['status'] == 'blocked' and not t.get('blocker'):
        print('BLOCKED, NO REASON', t['shortId'])
for f in d['feedback']:
    if f['status'] in ('triaged','accepted','in_progress') and not f.get('resolvedTaskShortId'):
        print('FEEDBACK PARKED, NO TASK', f['shortId'])
print('proxy', d['project']['proxy'], '| published', d['project']['proxyPublished'])
PY
```

Then the two checks no script can make: every piece of work you learned about this round
has a card (human-owned included), and every `in_progress` row still has a live builder.
Log anything worth a trace: `POST /api/events {"project":"DAR","text":"..."}`.

## 9. The shared surface

Full safety properties, and why teardown is not optional, are in the skill (Step 2 and B4).
Two commands.

**Announce it with the board link.** `GET /api/projects/DAR/context` has the config; the
board payload carries `baseUrl` plus the published prefix, so you can state the link
exactly as a stakeholder receives it. Never paste the target host:port where a link-holder
can read it.

**Withdraw it when the project closes.** Send the whole object; this config is replaced
wholesale.

```bash
# keep the config, take the URL down:
curl -s -X PATCH localhost:4899/api/projects/DAR -H 'content-type: application/json' \
  -d '{"proxy":{"prefix":"fe","target":"http://127.0.0.1:5173/fe","public":["/"],"enabled":false}}'
# or clear it entirely:
curl -s -X PATCH localhost:4899/api/projects/DAR -H 'content-type: application/json' -d '{"proxy":null}'
```

Then verify rather than assume: `proxyPublished` on the returned doc is what is actually
live. Empty is the state you want at close; anything else means the withdrawal did not
land and the URL is still open, so re-check. Never hand-edit the proxy route table or
`data/routes.json`.

## 10. Resume contract

A fresh session must be able to take over from the API alone. Keep all state on the board
(statuses, notes, blockers, origins), never only in session memory. Cold start:

```bash
curl -s localhost:4899/api/projects                      # find project, capId, pending-fb counts
curl -s localhost:4899/api/projects/DAR/context          # charter + agent registry = standing orders
curl -s localhost:4899/api/p/<capId>                     # full board: tasks + feedback + events + pipeline
curl -s 'localhost:4899/api/tasks?project=DAR&open=true' # the working set
curl -s 'localhost:4899/api/feedback/pending?project=DAR'
curl -s 'localhost:4899/api/projects/DAR/events?limit=50'  # why the board looks like this
```

`GET /api/tasks` caps at 200 rows sorted by `updatedAt` desc, so on a large project use
the board payload (`/api/p/:capId`), which returns every task, as the authority.

If that sequence would not tell your successor everything you know, the board is missing
state. Fix that before ending the round.

## 11. Exercising the API safely

Probe on a throwaway project prefix, never on a live one, and never against the running
server's config for a real project. There is no `DELETE /api/projects` and no
`DELETE /api/tasks`, so cleanup is direct Mongo against `mission_control`: delete the
throwaway's `tasks`, `feedback` and `events` by `projectId`, then the project document.
Verify nothing of it remains and touch no other prefix.
