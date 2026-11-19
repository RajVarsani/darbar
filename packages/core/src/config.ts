// Single source of runtime config. Values come from .env (gitignored, never pushed);
// every default lives here and nowhere else. See .env.example for the full list.
const env = process.env;

const port = Number(env.PORT || 4899);
const baseUrl = env.BASE_URL || `http://localhost:${port}`;

export const config = {
  port,
  baseUrl,
  // BASE_URL is what LINKS point at (tunnel when sharing); internal API calls stay local
  apiUrl: env.MC_API || `http://localhost:${port}/api`,
  mongoUri: env.MONGO_URI || 'mongodb://localhost:27017',
  dbName: env.DB_NAME || 'mission_control',
  filesDir: env.FILES_DIR || new URL('../../../data/files/', import.meta.url).pathname,
  memoryDir: env.MEMORY_DIR || new URL('../../../data/memory', import.meta.url).pathname,
  // DAR-276: Claude's autoMemoryDirectory drop zone. apps/server/src/memory-inbox.ts watches this,
  // POSTs each file to this server's own /api/memory/remember, then deletes it — nothing may ever
  // read this directory as a source of truth. Created at boot if missing.
  memoryInboxDir: env.MEMORY_INBOX_DIR || new URL('../../../data/memory-inbox', import.meta.url).pathname,
  // reports Gabbar's stakeholder gate refused, one JSON per slack message. Gabbar writes it and
  // resolves the same env var itself (apps/gabbar/src/parked.ts); the server only ever reads it.
  parkedDir: env.PARKED_DIR || new URL('../../../data/parked/', import.meta.url).pathname,
  slackBotToken: env.SLACK_BOT_TOKEN || '',
  slackAppToken: env.SLACK_APP_TOKEN || '',
  slackApiBase: env.SLACK_API_BASE || 'https://slack.com/api',
  // DAR-266: absent = the Linear mirror is off (one log line at boot, every hook a no-op)
  linearApiKey: env.LINEAR_API_KEY || '',
  linearApiUrl: env.LINEAR_API_URL || 'https://api.linear.app/graphql',
  linearPollMs: Number(env.LINEAR_POLL_MS || 120_000),
  anthropicApiKey: env.ANTHROPIC_API_KEY || '',
  gabbarModel: env.GABBAR_MODEL || 'claude-opus-5',
  gabbarTriageModel: env.GABBAR_TRIAGE_MODEL || 'claude-haiku-4-5',
  gabbarOwnerId: env.GABBAR_OWNER_ID || '',
  bindHost: env.BIND_HOST || '127.0.0.1', // loopback only; a tunnel fronts anything public
  proxyPort: Number(env.PROXY_PORT || 4800),
  proxyAdminToken: env.PROXY_ADMIN_TOKEN || '',
  zrokName: env.ZROK_NAME || '', // reserved zrok name; the share is <name>.shares.zrok.io
  sseKeepaliveMs: 25_000,
  // ---------- orchestrator inbox long-poll (DAR-245) ----------
  // How long an armed waiter holds the connection before it gives up and lets the caller re-arm.
  // Long on purpose: every expiry costs the orchestrator session one wake and therefore one turn, so
  // a short ceiling here turns a push into a poll with extra steps. It is a ceiling, not a heartbeat
  // — the keepalive below is what keeps the socket alive.
  inboxWaitMsDefault: 6 * 60 * 60_000,
  inboxWaitMsMax: 24 * 60 * 60_000,
  // Held reports are FILES written by another process (gabbar), so there is no in-process nudge for
  // them the way there is for a feedback row. This is how often an armed waiter stats the parked
  // directory to notice a new one. One stat, not a read: the full parse only happens when the
  // directory's mtime actually moved.
  inboxParkedTickMs: 10_000,
  // ---------- DAR-323: feedback outbox to T3 Code ----------
  // kill switch: DARBAR_T3=off stops every send (rows stay unsent and go out when it is back on)
  t3Enabled: (env.DARBAR_T3 || 'on').toLowerCase() !== 'off',
  t3Home: env.T3CODE_HOME || `${env.HOME || ''}/.t3`,
  t3Cli: env.T3_CLI || `${env.T3CODE_HOME || `${env.HOME || ''}/.t3`}/bin/t3`,
  t3Origin: env.T3_ORIGIN || 'http://127.0.0.1:3773',
  t3Model: env.T3_MODEL || 'claude-opus-5-5', // T3 needs --model with --provider; Claude's current default
  t3TimeoutMs: Number(env.T3_TIMEOUT_MS || 60_000),
  t3SweepMs: Number(env.T3_SWEEP_MS || 30_000),
  // ---------- DAR-419: context watcher (apps/ctxwatch) ----------
  // kill switch: CTXWATCH=off stops every title write and every send; DARBAR_T3=off stops it too
  ctxwatchEnabled: (env.CTXWATCH || 'on').toLowerCase() !== 'off' && (env.DARBAR_T3 || 'on').toLowerCase() !== 'off',
  ctxwatchThreshold: Number(env.CTXWATCH_THRESHOLD || 80), // percent of the context window
  ctxwatchBucketStep: Number(env.CTXWATCH_BUCKET_STEP || 5), // the title only changes when the bucket does
  ctxwatchPollMs: Number(env.CTXWATCH_POLL_MS || 15_000),
  ctxwatchPhasePollMs: Number(env.CTXWATCH_PHASE_POLL_MS || 2_000), // while a handoff run is pending
  ctxwatchActiveHours: Number(env.CTXWATCH_ACTIVE_HOURS || 72), // threads untouched for longer are ignored
  ctxwatchMinGapMs: Number(env.CTXWATCH_MIN_GAP_MS || 600_000), // loop guard: no second handoff on a thread inside this gap
  ctxwatchHandoffMsg: env.CTXWATCH_HANDOFF_MSG || 'run /darbar-handoff now',
  ctxwatchResumeMsg: env.CTXWATCH_RESUME_MSG || '/darbar-resume',
  ctxwatchOnlyThreads: (env.CTXWATCH_ONLY_THREADS || '').split(',').map((s) => s.trim()).filter(Boolean), // allowlist; empty = every thread
  ctxwatchSkipThreads: (env.CTXWATCH_SKIP_THREADS || '').split(',').map((s) => s.trim()).filter(Boolean), // per-thread opt-out
  // only used when T3 reports no window for a turn: { "<model>": tokens }
  ctxwatchWindows: (() => { try { return JSON.parse(env.CTXWATCH_WINDOWS || '{}') as Record<string, number>; } catch { return {}; } })(),
  ctxwatchEventProject: env.CTXWATCH_EVENT_PROJECT || 'DAR', // board that receives the watcher's events
  ctxwatchRetries: Number(env.CTXWATCH_RETRIES || 4),
  ctxwatchBackoffMs: Number(env.CTXWATCH_BACKOFF_MS || 1_000),
  t3StateDb: env.T3_STATE_DB || `${env.T3CODE_HOME || `${env.HOME || ''}/.t3`}/userdata/statev2.sqlite`,
  eventsBoardLimit: 50,
  capIdLen: 21,
  serverIdleTimeout: 120,
};
