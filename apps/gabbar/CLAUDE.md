# @darbar/gabbar

Gabbar is an AGENT, not a parser — ported from the original Vercel gabbar-singh repo
(persona + security rules + memory) and given Darbar tools. Claude Opus 5 via the
Anthropic SDK's beta tool runner, with server-side refusal fallbacks enabled.

## Architecture
- `src/bot.ts` — Slack Socket Mode TRANSPORT. Owns verified identity (SELF_USER guard;
  app-token user messages carry bot_id but a real `user` — never filter on bot_id
  alone), attachment downloads into data/files, thread history assembly, and the
  thread→feedback pre-lookup. No judgment lives here.
- `src/agent.ts` — the BRAIN. Persona (lowercase, hinglish, "raj banaya mujhe"),
  security rules (identity only from the verified payload; non-owners are stakeholders
  with limited trust), core memory (mongo `gabbar_memory`), and tools.
- `src/media.ts` — makes attachments legible. Images go to the model as image blocks;
  a screen recording goes as frames sampled at its moments of change (ranked by scene
  score, never a fixed threshold — a popover moving inside a 3024px capture scores
  ~0.005, two orders under the usual 0.3 cut). No ffmpeg, or a file that will not
  open, degrades to a NOT READABLE note and the prompt makes the model say so.
- `src/lookups.ts` — the two darbar reads the transport makes before the agent gets a turn
  (who is this person, does this thread already have a row). They live outside bot.ts for one
  reason: bot.ts opens a slack socket at import, so nothing in bot.ts can be exercised by a test,
  and DAR-235 was a bug in exactly these two calls that survived a fix and a review because of it.
- `src/parked.ts` — the parking lot for reports the gate refused (see below).

## Tools (intake-only invariant)
list_projects · get_board · get_task · file_feedback · reopen_feedback · save_memory
(owner-only). NO task creation, NO status changes, NO execution. Ticket filing is one
tool call among many — chit-chat gets a plain reply and no tool calls.

file_feedback's author, slack thread ref, and attachments are injected by the
TRANSPORT, never model-controlled — the model cannot spoof identity.

## Parked reports (a refusal must not lose the report)

The stakeholder gate fails closed on the verified slack id and is prompt-proof. It stays
that way. What changed is that a refusal now HOLDS the report in `data/parked/*.json`
(one file per slack message) instead of discarding it, with the sender's verbatim words,
the attachment urls and any extracted frames.

A parked item is not feedback and must never read as feedback: `PARK-*` ids, never in
mongo, so never in `/feedback/pending` or on a board, and `filed:false` on every read.

**A WRITE THAT FAILS AFTER THE GATE PASSED ALSO PARKS (DAR-229).** Every parking rule below is
about a REFUSAL; this is the other half. The api restarts several times a day to pick up shipped
code, and each restart is a few seconds in which every write fails, so the report of whoever is
talking to Gabbar at that moment used to be dropped with nothing held. It is held now, with
`cause: outage` (it behaves like one in every respect) and `gate.kind: write_failed` (it is not
one: the check passed, the WRITE failed).

Holding it is only safe because of the second half, which is the reason this sat in the backlog:
**a failed write may have succeeded.** Every write Gabbar makes for a slack message carries an
`idempotencyKey` built from the verified payload (`writeKey` in agent.ts), and the retry the sweep
issues later presents the same one. The server keeps the first result and returns it: a filing key
is unique per PROJECT, an append key per ROW. So a retry finds the row its own earlier attempt
made rather than making a second, a model correcting itself onto a different project still files
properly, and a held addition retargeted at a different row still lands. Of the two, `append` is
the one this really protects: a duplicated filing is a visible second row somebody deletes, a
duplicated append is one more attributed line inside a body nobody diffs.

**Only a filing parks. A refused REOPEN never parks.** A reopen is a status change on a row
that already exists and was written by someone else, so there is nothing of the sender's to
lose: the row, the thread and the owner ping all survive the refusal. Parking one copied the
original author's body into a held item, and once the sender was later recognised the sweep
filed it as a NEW row under THEIR name carrying the other person's words, while the row they
asked about was never reopened. Never copy an existing row's body anywhere.

It becomes real feedback two ways, both through the same gate:
- automatically, on the author's next message, once they are a recognised stakeholder
  (code-driven off the verified sender id, so no message can trigger or suppress it). The id is
  appended to the reply in code, because a row filed in someone's name and never mentioned is
  the same honesty failure as dropping it
- `promote_parked` (owner-only, with `list_parked`), attributed to the original reporter

### Why it is held decides what happens next

`cause` is recorded on every held item, because a stakeholder gap and a darbar outage look
identical at the point of refusal and need opposite handling:

| cause | what it means | ping at park | retried | first escalation |
|---|---|---|---|---|
| `stakeholder_gap` | project resolved, sender is not on the list | yes, once | on their next message | 24h |
| `outage` | darbar could not answer, so nothing was ever checked | **no** | on their next message | 1h |
| `bad_reference` | no project resolves for it | no | never (cannot) | 1h |

`gate.kind: write_failed` rides on `outage` and is the one held item that cannot claim "nothing was
filed": the write went out and never came back. The digest says so, and says promoting it is safe
anyway because of the key. A mistyped `feedbackRef` is the one `bad_reference` that parks FOREVER
(the sweep re-asks the same unresolvable row every message and is refused every time, and
registering the sender does nothing), so the digest names `promote_parked` with `feedbackRef` as
the only thing that clears it.

Telling those apart needed a transport fix, not a parking fix: `mc()` never checked `r.ok`, so a
503 from a restarting server came back looking exactly like a legitimate 404. `fetchDarbar`
now separates "darbar answered" from "darbar could not answer", and the gate reads that
distinction. **Unreachable still refuses.** Failing closed is unchanged; only the recorded reason
and what happens afterwards differ.

Consequences worth knowing: an outage no longer DMs the owner once per refused message, and a
report filed by a genuine stakeholder during an outage is held and then filed on their next
message.

### The retry budget rotates

The sweep's budget is spent on DISTINCT TARGETS, not items, and the queue is ordered
never-attempted first then least-recently-attempted. Both halves are load bearing.

The class being avoided is "cannot be promoted right now", which is wider than it first looks: a
`stakeholder_gap` item has a perfectly resolvable target and will keep being refused until a
human acts. Filtering only on "has a target" therefore fixed one shape and left the rest, and
with age ordering the same items hold the budget on every message while everything behind them
is never reached. Rotation is what makes the guarantee: every held item gets a turn within
ceil(distinct targets / budget) messages. Raising the budget does not fix it.

Grouping by target is why five reports on one project cost one gate call rather than five, and
why everything still held is summarised in ONE prompt line instead of one line per item.

### Nothing sits here unseen, and nothing is deleted

Held reports escalate to the owner on a clock: a digest DM, driven by a timer in `bot.ts` rather
than by traffic, so a report from someone who never messages again still surfaces. Sending is
what marks an item escalated, so a failed DM leaves it due rather than quiet for a day.

**Held items never expire.** Deleting a report because nobody acted on it trades a visibility
problem for a data-loss problem, which is the thing this whole mechanism exists to prevent.
Escalation keeps the item and raises the pressure instead.

**Orchestrator: read `data/parked/` during triage.** Held items are deliberately absent
from the API and the board, so nothing else will surface them. Surfacing them there is a
follow-up that needs `apps/server/src/api.ts` + the board (DAR-194). `summarize()` in
`parked.ts` is the intended contract for it: one shaped record per held item carrying `cause`,
`heldSince`, `escalatedAt` and `filed:false`. Build the board lane on that rather than reading
the JSON shape directly, and there is no second source of truth to drift.

## Judgment rules that came from real failures
- History is context, never a backlog: act only on the current message (the agent once
  filed tickets for old messages it saw in DM history).
- Look before declining: check list_projects before calling something "not project
  work" — projects can be personal todo lists.
- An attachment the model cannot see contributes nothing: a .mov was once downloaded,
  served and linked into a feedback body while the filed text rested on the filename.
  Anything shown to the model goes in as pixels, and anything unreadable is named as
  unreadable rather than guessed at.

Needs SLACK_BOT_TOKEN + SLACK_APP_TOKEN + ANTHROPIC_API_KEY; exits gracefully without
them so `bun dev` still brings up the rest. Model override: GABBAR_MODEL.
