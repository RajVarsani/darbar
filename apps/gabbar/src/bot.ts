// Gabbar — Slack transport for the agent brain in agent.ts.
// Socket Mode: outbound websocket only, no public endpoint. The transport owns
// identity, file downloads, and thread context; the agent owns all judgment.
import { App } from '@slack/bolt';
import { config } from '@darbar/core';
import { runAgent, type AgentContext } from './agent';

if (!config.slackBotToken || !config.slackAppToken) {
  console.error('gabbar: SLACK_BOT_TOKEN / SLACK_APP_TOKEN missing in .env, not starting');
  process.exit(0);
}
if (!config.anthropicApiKey) {
  console.error('gabbar: ANTHROPIC_API_KEY missing in .env, not starting');
  process.exit(0);
}

const app = new App({
  token: config.slackBotToken,
  appToken: config.slackAppToken,
  socketMode: true,
});

// skip our own replies, not everything bot-flavored: messages sent via the app's
// own user token carry a bot_id but user = the real human
let SELF_USER = '';

async function pullFiles(files: any[]): Promise<string[]> {
  const out: string[] = [];
  for (const f of files ?? []) {
    if (!f.url_private_download) continue;
    try {
      const name = `${f.id}-${(f.name || 'file').replace(/[^a-zA-Z0-9._-]/g, '_')}`;
      const r = await fetch(f.url_private_download, {
        headers: { authorization: `Bearer ${config.slackBotToken}` },
      });
      if (!r.ok) continue;
      await Bun.write(`${config.filesDir}${name}`, await r.arrayBuffer());
      out.push(`${config.baseUrl}/files/${name}`);
    } catch { /* skip this file, keep the message */ }
  }
  return out;
}

async function senderName(client: any, userId: string): Promise<string> {
  try {
    const r = await fetch(`${config.apiUrl}/projects`);
    const projects = (await r.json()) as Array<{ stakeholders?: Array<{ slackUserId?: string; name: string }> }>;
    for (const p of Array.isArray(projects) ? projects : []) {
      const s = (p.stakeholders || []).find((s) => s.slackUserId === userId);
      if (s) return s.name;
    }
  } catch { /* fall through to slack profile */ }
  const info = await client.users.info({ user: userId }).catch(() => null);
  return info?.user?.profile?.display_name || info?.user?.real_name || userId;
}

// conversation history for the agent: thread replies if threaded, else recent channel
// messages. Our messages become assistant turns; everyone else's become user turns.
async function buildHistory(client: any, channel: string, threadTs: string | null, uptoTs: string) {
  const history: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  try {
    const resp = threadTs
      ? await client.conversations.replies({ channel, ts: threadTs, limit: 15 })
      : await client.conversations.history({ channel, limit: 8 });
    const msgs = (resp.messages ?? [])
      .filter((m: any) => m.ts !== uptoTs && (m.text || '').trim())
      .sort((a: any, b: any) => Number(a.ts) - Number(b.ts))
      .slice(-12);
    for (const m of msgs) {
      if (m.user === SELF_USER) history.push({ role: 'assistant', content: m.text });
      else {
        // gabbar replies in threads, which channel history omits — mark handled parents
        const handled = !threadTs && (m.reply_count ?? 0) > 0 ? ' [gabbar already replied in this message\u2019s thread — handled]' : '';
        history.push({ role: 'user', content: `[${m.user}]: ${m.text}${handled}` });
      }
    }
  } catch { /* no history is fine */ }
  return history;
}

async function existingFeedback(channel: string, threadTs: string | null) {
  if (!threadTs) return null;
  try {
    const r = await fetch(
      `${config.apiUrl}/feedback/by-slack?channel=${encodeURIComponent(channel)}&ts=${encodeURIComponent(threadTs)}`,
    );
    if (!r.ok) return null;
    const fb = (await r.json()) as { shortId?: string; status?: string };
    return fb.shortId ? { shortId: fb.shortId, status: fb.status ?? 'unknown' } : null;
  } catch {
    return null;
  }
}

// immediate feedback: 👀 on intake, ✅/❌ on outcome — best-effort, never blocks the reply
let reactWarned = false;
async function react(client: any, method: 'add' | 'remove', channel: string, timestamp: string, name: string) {
  try {
    await client.reactions[method]({ channel, timestamp, name });
  } catch (e: any) {
    const err = e?.data?.error ?? String(e);
    if (err === 'already_reacted' || err === 'no_reaction') return;
    if (!reactWarned) {
      reactWarned = true;
      console.error(`gabbar: reactions.${method} failed (${err}) — check reactions:write scope`);
    }
  }
}

// "Gabbar is thinking..." via the Assistants status API; probed once, auto-clears on reply
let statusUsable: boolean | null = null;
let statusWarned = false;
async function setThinking(client: any, channel: string, threadTs: string) {
  if (statusUsable === false) return;
  try {
    await client.apiCall('assistant.threads.setStatus', { channel_id: channel, thread_ts: threadTs, status: 'is thinking...' });
    statusUsable = true;
  } catch (e: any) {
    const apiErr = typeof e?.data?.error === 'string' ? e.data.error : null;
    if (!statusWarned) {
      statusWarned = true;
      console.error(`gabbar: assistant status unavailable (${apiErr ?? e}), reactions only`);
    }
    if (apiErr) statusUsable = false; // real API error latches; network blips stay retryable
  }
}
async function clearThinking(client: any, channel: string, threadTs: string) {
  if (statusUsable === false) return;
  try {
    await client.apiCall('assistant.threads.setStatus', { channel_id: channel, thread_ts: threadTs, status: '' });
  } catch {}
}

// eyes add is fire-and-forget, but removal must chain on it or a slow add outruns the remove
const pendingEyes = new Map<string, Promise<void>>();
function eyesOn(client: any, channel: string, ts: string) {
  pendingEyes.set(`${channel}:${ts}`, react(client, 'add', channel, ts, 'eyes'));
}
function eyesOff(client: any, channel: string, ts: string, finalEmoji?: string) {
  const key = `${channel}:${ts}`;
  const p = pendingEyes.get(key) ?? Promise.resolve();
  pendingEyes.delete(key);
  void p.then(() => react(client, 'remove', channel, ts, 'eyes'))
    .then(() => { if (finalEmoji) void react(client, 'add', channel, ts, finalEmoji); });
}

async function handle({ message, event, client, say }: any) {
  const m = message ?? event;
  if (m.subtype || m.user === SELF_USER || (!m.user && m.bot_id)) return; // edits, joins, our own replies
  const text: string = (m.text || '').replace(/<@[A-Z0-9]+>/g, '').trim();
  const threadTs: string | null = m.thread_ts && m.thread_ts !== m.ts ? m.thread_ts : null;
  if (!text && !m.files?.length) return;

  eyesOn(client, m.channel, m.ts);
  if (m.channel_type === 'im') void setThinking(client, m.channel, threadTs ?? m.ts);

  const [name, attachments, history, fb] = await Promise.all([
    senderName(client, m.user),
    pullFiles(m.files),
    buildHistory(client, m.channel, threadTs, m.ts),
    existingFeedback(m.channel, threadTs),
  ]);
  if (!text && attachments.length === 0) {
    // files-only message whose downloads all failed: resolve the ack, don't vanish
    await say({ thread_ts: threadTs ?? m.ts, text: "couldn't read those files, try re-uploading or add a line of text" }).catch(() => {});
    eyesOff(client, m.channel, m.ts, 'x');
    if (m.channel_type === 'im') void clearThinking(client, m.channel, threadTs ?? m.ts);
    return;
  }

  const ctx: AgentContext = {
    senderId: m.user,
    senderName: name,
    isOwner: m.user === config.gabbarOwnerId,
    channel: m.channel,
    channelType: m.channel_type ?? 'channel',
    messageTs: m.ts,
    threadTs,
    attachments,
    existingFeedback: fb,
  };

  const reply = await runAgent(ctx, history, text);
  await say({ thread_ts: threadTs ?? m.ts, text: reply });
  eyesOff(client, m.channel, m.ts, 'white_check_mark');
}

// intake must never die silently: any unexpected failure still answers the human
async function safeHandle(args: any) {
  try {
    await handle(args);
  } catch (e) {
    console.error('gabbar handler error:', e);
    const m = args.message ?? args.event;
    if (m?.channel && m?.ts) {
      eyesOff(args.client, m.channel, m.ts, 'x');
      void clearThinking(args.client, m.channel, m.thread_ts ?? m.ts);
    }
    await args.say?.({ thread_ts: m?.thread_ts ?? m?.ts, text: `kuch toot gaya (${String(e).slice(0, 120)}). try again in a bit.` }).catch(() => {});
  }
}

// channels are noisy: only bare replies inside threads rooted at tracked feedback get through.
// Requires message.channels/message.groups events + channels:history/groups:history scopes on the app.
app.message(async (args: any) => {
  const m = args.message;
  if (m.channel_type === 'im') { await safeHandle(args); return; }
  if (m.subtype || m.user === SELF_USER || (!m.user && m.bot_id)) return;
  if (SELF_USER && (m.text || '').includes(`<@${SELF_USER}>`)) return; // app_mention owns mentions
  if (!(m.thread_ts && m.thread_ts !== m.ts)) return;
  if (!(await existingFeedback(m.channel, m.thread_ts))) return;
  await safeHandle(args);
});
app.event('app_mention', async (args: any) => { await safeHandle(args); });

SELF_USER = ((await app.client.auth.test()) as { user_id?: string }).user_id ?? '';
await app.start();
console.log(`gabbar (agent) connected via socket mode as ${SELF_USER}, model ${config.gabbarModel}`);
