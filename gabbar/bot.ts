// Gabbar — intake scribe. Writes feedback rows at status=pending. Executes nothing.
// Socket Mode: outbound websocket only, no public endpoint.
import pkg from '@slack/bolt';
const { App } = pkg;

const API = process.env.MC_API || 'http://localhost:4899/api';
const BASE_URL = process.env.BASE_URL || 'http://localhost:4899';
const FILES_DIR = new URL('../data/files/', import.meta.url).pathname;

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
});

const TASK_REF = /\b([A-Z]{2,10}-\d+)\b/i;

async function mc(path: string, init?: RequestInit) {
  const r = await fetch(`${API}${path}`, {
    headers: { 'content-type': 'application/json' },
    ...init,
  });
  return { ok: r.ok, body: await r.json().catch(() => ({})) };
}

async function authorName(client: any, userId: string): Promise<string> {
  const { body } = await mc('/projects');
  for (const p of Array.isArray(body) ? body : []) {
    const s = (p.stakeholders || []).find((s: any) => s.slackUserId === userId);
    if (s) return s.name;
  }
  const info = await client.users.info({ user: userId }).catch(() => null);
  return info?.user?.profile?.display_name || info?.user?.real_name || userId;
}

async function pullFiles(files: any[]): Promise<string[]> {
  const out: string[] = [];
  for (const f of files ?? []) {
    if (!f.url_private_download) continue;
    const name = `${f.id}-${(f.name || 'file').replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    const r = await fetch(f.url_private_download, {
      headers: { authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
    });
    if (!r.ok) continue;
    await Bun.write(`${FILES_DIR}${name}`, await r.arrayBuffer());
    out.push(`${BASE_URL}/files/${name}`);
  }
  return out;
}

async function handle({ message, event, client, say }: any) {
  const m = message ?? event;
  if (m.subtype || m.bot_id) return; // edits, joins, our own replies
  const text: string = (m.text || '').replace(/<@[A-Z0-9]+>/g, '').trim();
  const threadTs = m.thread_ts && m.thread_ts !== m.ts ? m.thread_ts : null;

  // reply inside an existing feedback thread -> reopen that row, don't file a new one
  if (threadTs) {
    const { body: pend } = await mc('/feedback/pending');
    const all = Array.isArray(pend) ? pend : [];
    const existing = all.find((f: any) => f.slack?.ts === threadTs && f.slack?.channel === m.channel);
    if (existing) {
      await mc(`/feedback/${existing.shortId}`, { method: 'PATCH', body: JSON.stringify({ status: 'pending', resolution: null }) });
      await say({ thread_ts: threadTs, text: `noted — ${existing.shortId} back in the queue.` });
      return;
    }
  }

  const author = await authorName(client, m.user);
  const attachments = await pullFiles(m.files);
  if (!text && attachments.length === 0) return;

  const refMatch = text.match(TASK_REF);
  const payload: any = {
    author,
    authorType: 'human',
    body: text,
    attachments,
    slack: { channel: m.channel, ts: m.ts, user: m.user },
  };

  if (refMatch) {
    payload.taskRef = refMatch[1].toUpperCase();
  } else {
    // no task id: bind by channel, else fall back to the only/most recent project
    const { body: projects } = await mc('/projects');
    const list = Array.isArray(projects) ? projects : [];
    const byChannel = list.find((p: any) => p.slackChannel === m.channel);
    const target = byChannel ?? (list.length === 1 ? list[0] : list[0]); // most recent first
    if (!target) { await say({ thread_ts: m.ts, text: 'no projects registered yet — run /project-init first.' }); return; }
    payload.project = target.capId;
  }

  const { ok, body } = await mc('/feedback', { method: 'POST', body: JSON.stringify(payload) });
  if (!ok) {
    await say({ thread_ts: m.ts, text: `couldn't log that: ${body.error || 'unknown error'}. include a task id like TST-1, or just send again.` });
    return;
  }
  const where = body.taskShortId ? `on *${body.taskShortId}*` : 'at project level';
  await say({ thread_ts: m.ts, text: `logged *${body.shortId}* ${where} · status pending. board: ${body.boardUrl}` });
}

app.message(async (args: any) => { if (args.message.channel_type === 'im') await handle(args); });
app.event('app_mention', async (args: any) => { await handle(args); });

await app.start();
console.log('gabbar (scribe) connected via socket mode');
