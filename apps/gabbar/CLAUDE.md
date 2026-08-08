# @houston/gabbar

Slack Socket Mode intake scribe. INTAKE-ONLY: writes feedback rows at `pending`,
confirms in thread, nothing else. No task creation, no status changes, no execution.

Flow per message (src/bot.ts):
1. Skip own messages (`SELF_USER`), edits, joins. App-token user messages carry a
   bot_id but a real `user` — do NOT filter on bot_id alone (learned the hard way).
2. Thread reply? Look up the row by thread-root ts via `/api/feedback/by-slack`
   (ANY status) and reopen to pending. Never file duplicates from threads.
3. Task ref (TST-12) only counts if `/api/tasks/:ref` confirms it exists.
4. No ref: channel-bound project, else the only project, else ASK (never guess
   between multiple projects).
5. Screenshots -> `data/files/` via bot token; URLs use `config.baseUrl`.
6. Everything wrapped in `safeHandle`: failures reply to the human, never vanish.

Needs SLACK_BOT_TOKEN + SLACK_APP_TOKEN; exits gracefully without them so `bun dev`
still brings up the rest.
