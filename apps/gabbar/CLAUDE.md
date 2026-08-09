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

**Orchestrator: read `data/parked/` during triage.** Held items are deliberately absent
from the API and the board, so nothing else will surface them. Surfacing them there is a
follow-up that needs `apps/server/src/api.ts` + the board.

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
