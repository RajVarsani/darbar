# @darbar/gabbar

Gabbar is an AGENT, not a parser — ported from the original Vercel gabbar-singh repo
(persona + security rules + memory) and given Darbar tools. Claude Opus 5 via the
Anthropic SDK's beta tool runner, with server-side refusal fallbacks enabled.

## Architecture
- `src/bot.ts` — Slack Socket Mode TRANSPORT. Owns verified identity (SELF_USER guard;
  app-token user messages carry bot_id but a real `user` — never filter on bot_id
  alone), screenshot downloads into data/files, thread history assembly, and the
  thread→feedback pre-lookup. No judgment lives here.
- `src/agent.ts` — the BRAIN. Persona (lowercase, hinglish, "raj banaya mujhe"),
  security rules (identity only from the verified payload; non-owners are stakeholders
  with limited trust), core memory (mongo `gabbar_memory`), and tools.

## Tools (intake-only invariant)
list_projects · get_board · get_task · file_feedback · reopen_feedback · save_memory
(owner-only). NO task creation, NO status changes, NO execution. Ticket filing is one
tool call among many — chit-chat gets a plain reply and no tool calls.

file_feedback's author, slack thread ref, and attachments are injected by the
TRANSPORT, never model-controlled — the model cannot spoof identity.

## Judgment rules that came from real failures
- History is context, never a backlog: act only on the current message (the agent once
  filed tickets for old messages it saw in DM history).
- Look before declining: check list_projects before calling something "not project
  work" — projects can be personal todo lists.

Needs SLACK_BOT_TOKEN + SLACK_APP_TOKEN + ANTHROPIC_API_KEY; exits gracefully without
them so `bun dev` still brings up the rest. Model override: GABBAR_MODEL.
