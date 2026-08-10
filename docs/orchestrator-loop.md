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
`resolved`, `rejected` and `needs_clarification` auto-reply in the author's Slack thread,
and that reply IS the `resolution`: the one in this body, or the one already on the row if
you send none. With neither, the status **400s** rather than posting a placeholder. Send
the reason in the same call.

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

**Reject.** Out of scope, working as intended, or will not do. Always give the reason; a
rejection with none is refused (section 6).

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
lane's `manager` from `project.pipeline.reviews`. Spawning runs on the TRANSITION into
`in_review` and also at create for a row FILED at `in_review`, so a retro-filed card gets
its lanes. A parent pushed out of `in_review` and back in spawns a whole fresh round.

Selection: `["code-review"]` default, add `qa` only when the diff cannot answer the
question (live data migration), add `design-qa` only for a UI surface a human will look
at, `[]` for helper and bookkeeping rows, the full set only for the public front door or
anything touching exposure.

Lane keys are on `GET /api/projects/:ref/context` (→ `pipeline.reviews[].lane`, alongside a
`configured` map), on `GET /api/projects` and on the board payload
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
| `origin`, `commits`, `shortId`, `parentTaskRef`/`parentTaskId`, `project`/`projectId` on `PATCH /tasks` | 400 `not settable on an existing task: origin — set at create only (POST /tasks {"origin": …})`, one clause per field sent |
| prefix with a digit on `POST /projects` | 400 `name (string) and prefix (2-6 letters) required` |
| duplicate project prefix | 409 |
| malformed `stakeholders[].slackUserId` on `POST`/`PATCH /projects` | 400 naming the index and the `U`/`W` shape; on a POST nothing is created. Through a granular route the same 400 names the person instead: `stakeholder "Tanisha": slackUserId must be a slack USER id when present ...` |
| a granular config PATCH/DELETE naming an agent, lane or stakeholder that is not there | 404 `agent "staff-enginer" is not registered — registry holds: staff-engineer, qa-lead, orchestrator`, and the same shape for `lane "x" is not configured — pipeline holds: ...` and `stakeholder "X" is not on this project — listed: ...`. Never an upsert |
| a granular POST of a name already taken, case and spacing folded | 409 naming the existing entry and the PATCH that edits it: `agent "staff-engineer" is already registered (you sent "Staff-Engineer", ...)` |
| granular PATCH with no editable field | 400 `nothing to update (kind, brief, trigger, rename)`, `(label, manager, rename)`, `(slackUserId, role, rename)`, `(autoAdvance) — lanes are edited one at a time under /pipeline/lanes`, `(prefix, target, public)` |
| removing or renaming a lane open tasks select | 409 `removing lane "qa" is invisible to open work: 1 task(s) select it explicitly (DAR-7) and would be left with no configured lane, so at in_review they skip review entirely and (with autoAdvance on) go straight to DONE UNREVIEWED` — or, for the last lane, `... take the default of all lanes (DAR-7) and this removes the last one, so at in_review they spawn nothing, log nothing and STALL in in_review`. `?force=true` (DELETE) or `"force": true` (PATCH) repeats it and returns the same sentences as warnings |
| `enabled` in the body of `PATCH /projects/:ref/proxy` | 400 `enabled is not editable here — use PATCH /api/projects/:ref/proxy/enabled, which states what becomes reachable and requires the prefix as confirmation` |
| `PATCH /projects/:ref/proxy/enabled {"enabled":true}` with no `confirm` | 400 `enabling this share needs confirmation. <url> becomes reachable by ANYONE holding the link ... Repeat with "confirm":"<prefix>"`. Nothing is published |
| a granular proxy or pipeline route on a project that has neither configured | 404 `project has no shared surface configured — declare one with PATCH /api/projects/:ref {proxy} (it starts disabled), then edit it here` / `project has no review pipeline — add the first lane with POST /api/projects/:ref/pipeline/lanes` |
| `resolvedTaskRef` naming a task that does not exist | 404 `task DAR-999 not found — resolvedTaskRef is the link the ship sweep follows ... so an unknown id would leave DAR-FB-3 promoted in name only` |
| `resolved`/`rejected`/`needs_clarification` with no `resolution` in the body and none on the row | 400 `DAR-FB-3 → rejected replies to <author> in their own thread and that reply IS the resolution text, so "resolution" is required: ...` |
| `limit` outside 1 to 1000, or a non-integer `limit`/`offset`, on `GET /tasks` | 400 `limit must be a whole number between 1 and 1000 (got "1001")`. Never clamped |

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

Anything not listed here and not named as a 400 in section 6 is ignored with a 200, so a
rejected field looks like a success. Read back what you wrote.

- `POST /tasks`: `project`, `title`, `description`, `status`, `type`, `parentTaskRef`,
  `lane`, `lanes`, `assignee`, `assigneeType`, `origin`, `notes`. No status gate: any
  status, including `done`, is accepted at create, and a row filed at `in_review` spawns
  its lanes there and then (section 5).
- `PATCH /tasks/:ref`: `title`, `description`, `status`, `notes`, `type`, `assignee`,
  `blocker`, `lane`, `assigneeType`, `dispatched`, `lanes`, `addCommit` (append-only,
  one hash per call). `origin`, `commits`, `shortId`, `parentTaskRef`/`parentTaskId` and
  `project`/`projectId` 400 here and name what does the job instead: origin and parentage
  are create-time only.
- `POST /feedback`: `taskRef` or `project`, `author`, `authorType`, `type`, `body`,
  `attachments`, `slack`. Always lands at `pending`.
- `PATCH /feedback/:shortId`: `status`, `resolution`, `type`, `resolvedTaskRef`.
  Promotion from `pending` with no explicit status auto-sets `triaged`.
- `PATCH /projects/:ref`: `charter`, `slackChannel`, `stakeholders`, `pipeline`, `agents`,
  `proxy`. Each replaces its value wholesale; read, edit, send whole. Use it to DECLARE a
  surface, never to change one entry: a one-element `agents` array deletes the rest and
  returns 200. Section 7b is the per-entry door. A body with none of
  them 400s `nothing to update (charter, slackChannel, stakeholders, pipeline, agents,
  proxy)`, which is also how you check the list.
- `POST /projects`: `name`, `prefix`, `repos`, `charter`, `stakeholders`, `slackChannel`,
  and `pipeline`, `agents` and `proxy` too. Registering a project is ONE call, not a POST
  and then PATCHes. The config is validated before the insert, so a malformed one is a 400
  with nothing created; the response carries `boardUrl` plus `warnings` (the things the
  server declines to fail on, such as a pipeline manager missing from the registry).

MCP tools cover every intent in this section but two, stated as SHAPES rather than as a
list of what is missing: a list of absences goes stale on every tool that lands, and this
one went stale twice in one day.

- **A wholesale replace of a project list that already has a per-entry door.** No tool
  rewrites a charter (`append_to_charter` only adds a line) and there is no
  `set_stakeholders`. Both are the `PATCH /projects/:ref` above: read with
  `get_project_config`, edit, send the whole thing back. `repos`, `pipeline`, `agents`
  and `proxy` are the exceptions that do have a wholesale tool each.
- **Task fields the write tools do not carry**, enumerated because there is no principle
  behind which field landed on which door and a caller about to fire one needs the exact
  word: `update_task` has no `title`, `description`, `lane` or `assigneeType`;
  `create_task` has no `notes` or `lane`. Curl for those.

Reads are not a gap any more: `get_task`, `get_feedback`, `get_project_config`,
`get_project_events` and `list_parked` (held reports, which are NOT feedback and never
reach the board) all have tools, as do `create_project`, `set_repos`,
`set_slack_channel`, `append_to_feedback`, `create_task {blocker}` and
`resolve_feedback {pending}`, which is the deliberate reopen that an append onto a
resolved or rejected row warns you it has not done.

Adding an MCP tool or argument is not done until this paragraph is edited in the same
commit.

## 7b. Editing config one entry at a time

One route per intent, each sending only what changes. The server reads the current value,
merges, and runs the result through the same validators as the wholesale PATCH above, so
these cannot produce a config that door would refuse; the 400s and the event log are
identical. Addressing is edit-only, and every unknown name, taken name, gate and
confirmation string is in section 6. When each door is the right one is the skill's B4.

```bash
B=localhost:4899/api/projects/DAR
H='content-type: application/json'

# stakeholders — access control: the slack id is what Gabbar's feedback gate matches
curl -s -X POST   $B/stakeholders -H "$H" -d '{"name":"Tanisha","slackUserId":"U08SXQF8RTQ","role":"backend"}'
curl -s -X PATCH  $B/stakeholders/Tanisha -H "$H" -d '{"slackUserId":null,"role":"product","rename":"Tanisha K"}'
curl -s -X DELETE "$B/stakeholders/Tanisha%20K"    # the URL addresses the CURRENT name

# agents — `name` is the assignee key, so a rename is not a cosmetic change
curl -s -X POST   $B/agents -H "$H" -d '{"name":"deploy-devx","kind":"helper","brief":"...","trigger":"after lanes close"}'
curl -s -X PATCH  $B/agents/staff-engineer -H "$H" -d '{"brief":"new standing brief"}'
curl -s -X DELETE $B/agents/deploy-devx

# review lanes, and autoAdvance on its own
curl -s -X POST   $B/pipeline/lanes -H "$H" -d '{"lane":"qa","label":"QA","manager":"qa-lead"}'
curl -s -X PATCH  $B/pipeline/lanes/qa -H "$H" -d '{"manager":"qa-lead","rename":"quality","force":true}'
curl -s -X DELETE "$B/pipeline/lanes/qa?force=true"
curl -s -X PATCH  $B/pipeline -H "$H" -d '{"autoAdvance":false}'

# charter — appends one line at the end, never replaces
curl -s -X POST   $B/charter/append -H "$H" -d '{"text":"- Lane selection is mandatory at create."}'

# shared surface — editing and publishing are two routes on purpose
curl -s           $B/proxy                                        # the only read that carries the target
curl -s -X PATCH  $B/proxy -H "$H" -d '{"public":["/assets/","/$"]}'
curl -s -X PATCH  $B/proxy/enabled -H "$H" -d '{"enabled":false}'  # withdraw; enabling needs "confirm"
```

- The URL addresses the entry; `rename` changes it. On stakeholders a `name` in the BODY
  400s rather than passing as a silent no-op.
- `null` clears: `slackUserId` (revokes feedback filing), `role`, `trigger`. Omitted fields
  are left alone.
- `force` exists only on lane rename and lane removal: `"force": true` in the PATCH body,
  `?force=true` on the DELETE. Nothing else takes it.
- Read `warnings` on every response. That is where a rename reports the open tasks still
  assigned to the old name, an agent removal reports the lane it managed, a lane change
  reports the tasks that lose a review, adding a stakeholder reports what Slack says about
  the id, and adding the first lane reports that a pipeline was created with
  `autoAdvance: true`. None of it fails the call.
- `PATCH /proxy` refuses `enabled` outright. It asks for `{"confirm":"<prefix>"}` only when
  the route is currently enabled AND the edit changes the prefix or target or adds an
  allowlist entry that was not already there; edits to a withdrawn route never ask.
  `PATCH /proxy/enabled` needs `{"confirm":"<prefix>"}` to publish and nothing to withdraw
  (the MCP tools spell this argument `confirmPrefix`),
  and reports `routeLive` (the route table), which is what the link actually resolving
  depends on, not the saved config.
- Appending the same charter text twice succeeds and warns `that text is already in the
  charter verbatim; appended anyway (this route is not idempotent, check before repeating
  a failed call)`.

## 8. End-of-round board audit

What to run before sleeping. What each finding MEANS, and how to recover it, is the skill's
Part D; this is the sweep.

```bash
PROJ=DAR CAP=<capId> python3 - <<'PY'
import json, os, datetime, urllib.request
API, PROJ, CAP = 'http://localhost:4899/api', os.environ['PROJ'], os.environ['CAP']
get = lambda u: json.load(urllib.request.urlopen(u))
# /api/tasks answers with a PAGE, never a bare list: total, returned, offset, limit,
# truncated, and nextOffset when it withheld rows. Check truncated; page until it is false.
tasks, off = [], 0
while True:
    page = get(f'{API}/tasks?project={PROJ}&offset={off}')
    tasks += page['tasks']
    if not page['truncated']: break
    off = page['nextOffset']
assert len(tasks) == page['total'], f'swept {len(tasks)} of {page["total"]}'
board = get(f'{API}/p/{CAP}')   # feedback, events and the proxy pair in one payload
now = datetime.datetime.now(datetime.timezone.utc)
age = lambda s: (now - datetime.datetime.fromisoformat(s.replace('Z','+00:00'))).total_seconds()/60
rev = [t for t in tasks if t['type'] == 'review']
openrev = lambda p: [r for r in rev if r['parentTaskId'] == p['_id'] and r['status'] not in ('done','cancelled')]
for t in tasks:
    if t['type'] == 'review': continue
    if t.get('dispatchedAt') and t['status'] in ('todo','backlog') and age(t['dispatchedAt']) > 15:
        print('STALE DISPATCH', t['shortId'], int(age(t['dispatchedAt'])), 'min, never reported in')
    if t['status'] == 'in_review' and not openrev(t):
        print('HELD IN REVIEW', t['shortId'], '(check feedback filed on it, then autoAdvance)')
    if t['status'] == 'in_review' and not [r for r in rev if r['parentTaskId'] == t['_id']]:
        print('NO LANES EVER SPAWNED', t['shortId'], '(no lanes selected, or none configured)')
    if t['status'] == 'blocked' and not t.get('blocker'):
        print('BLOCKED, NO REASON', t['shortId'])
for f in board['feedback']:
    if f['status'] in ('triaged','accepted','in_progress') and not f.get('resolvedTaskShortId'):
        print('FEEDBACK PARKED, NO TASK', f['shortId'])
print('swept', len(tasks), 'of', page['total'], 'tasks |', 'proxy', board['project'].get('proxy'), '| published', board['project'].get('proxyPublished'))
PY
```

Then the two checks no script can make: every piece of work you learned about this round
has a card (human-owned included), and every `in_progress` row still has a live builder.
Log anything worth a trace: `POST /api/events {"project":"DAR","text":"..."}`.

## 9. The shared surface

Full safety properties, and why teardown is not optional, are in the skill (Step 2 and B4).
Two commands.

**Announce it with the board link.** `GET /api/projects/DAR/context` has the config with
the target redacted; the board payload carries `baseUrl` plus the published prefix, so you
can state the link exactly as a stakeholder receives it. `GET /api/projects/DAR/proxy` is
the one read that carries the target. Never paste that host:port where a link-holder can
read it.

**Withdraw it when the project closes.** One field, one route; nothing else is resent and
withdrawing needs no confirmation.

```bash
# keep the config, take the URL down:
curl -s -X PATCH localhost:4899/api/projects/DAR/proxy/enabled -H 'content-type: application/json' \
  -d '{"enabled":false}'
# or clear the config entirely (the wholesale door, still the only way to remove it):
curl -s -X PATCH localhost:4899/api/projects/DAR -H 'content-type: application/json' -d '{"proxy":null}'
```

Then verify rather than assume. The enabled route answers `routeLive`, and
`GET /api/projects/DAR/proxy` carries `proxyPublished`, which is what the server reports it
actually put in the route table. `routeLive: false` with an empty `proxyPublished` is the
state you want at close; anything else means the withdrawal did not land and the URL is
still open, so re-check. Never hand-edit the proxy route table or `data/routes.json`.

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

`GET /api/tasks` sorts by `updatedAt` desc and answers with a PAGE, not a bare array:
`{total, returned, offset, limit, truncated, tasks}`, plus `nextOffset` and a `note`
whenever it withheld rows. `limit` defaults to 1000 and maxes at 1000. Read `truncated`
before you treat a page as the whole set: if it is true, repeat the same query with
`offset=nextOffset` until it is false, or take the whole project in one payload from
`/api/p/:capId`. The MCP `my_tasks` tool returns the same page and takes the same
`limit`/`offset`.

If that sequence would not tell your successor everything you know, the board is missing
state. Fix that before ending the round.

## 11. Exercising the API safely

Probe on a throwaway project prefix, never on a live one, and never against the running
server's config for a real project. There is no `DELETE /api/projects` and no
`DELETE /api/tasks`, so cleanup is direct Mongo against `mission_control`: delete the
throwaway's `tasks`, `feedback` and `events` by `projectId`, then the project document.
Verify nothing of it remains and touch no other prefix.
