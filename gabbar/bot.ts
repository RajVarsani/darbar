// Gabbar — intake scribe. Writes feedback rows at status=pending. Executes nothing.
// Socket Mode: outbound websocket only, no public endpoint.
import { App } from '@slack/bolt';
import { config } from '../src/config';

const app = new App({
  token: config.slackBotToken,
  appToken: config.slackAppToken,
  socketMode: true,
});

const TASK_REF = /\b([A-Z]{2,10}-\d+)\b/i;

// skip our own replies, not everything bot-flavored: messages sent via the app's
// own user token carry a bot_id but user = the real human
let SELF_USER = '';

async function mc(path: string, init?: RequestInit) {
  try {
    const r = await fetch(`${config.apiUrl}${path}`, {
      headers: { 'content-type': 'application/json' },
      ...init,
    });
    return { ok: r.ok, status: r.status, body: (await r.json().catch(() => ({}))) as any };
  } catch (e) {
    return { ok: false, status: 0, body: { error: `houston unreachable: ${String(e)}` } as any };
  }
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

async function handle({ message, event, client, say }: any) {
  const m = message ?? event;
  if (m.subtype || m.user === SELF_USER || (!m.user && m.bot_id)) return; // edits, joins, our own replies
  const text: string = (m.text || '').replace(/<@[A-Z0-9]+>/g, '').trim();
  const threadTs: string | null = m.thread_ts && m.thread_ts !== m.ts ? m.thread_ts : null;

  // reply inside an existing feedback thread reopens that row (ANY status), never duplicates
  if (threadTs) {
    const found = await mc(`/feedback/by-slack?channel=${encodeURIComponent(m.channel)}&ts=${encodeURIComponent(threadTs)}`);
    if (found.ok && found.body.shortId) {
      await mc(`/feedback/${found.body.shortId}`, { method: 'PATCH', body: JSON.stringify({ status: 'pending' }) });
      await say({ thread_ts: threadTs, text: `noted, *${found.body.shortId}* is back in the queue.` });
      return;
    }
  }

  const author = await authorName(client, m.user);
  const attachments = await pullFiles(m.files);
  if (!text && attachments.length === 0) return;

  const payload: Record<string, unknown> = {
    author,
    authorType: 'human',
    body: text,
    attachments,
    // thread ROOT ts, so later replies in the same thread match this row
    slack: { channel: m.channel, ts: threadTs ?? m.ts, user: m.user },
  };

  // a ref-looking token only counts if the task actually exists ("COVID-19" is not a task)
  const refMatch = text.match(TASK_REF);
  const taskRef = refMatch?.[1] ? refMatch[1].toUpperCase() : null;
  const taskExists = taskRef ? (await mc(`/tasks/${taskRef}`)).ok : false;

  if (taskExists) {
    payload.taskRef = taskRef;
  } else {
    const { body: projects } = await mc('/projects');
    const list = Array.isArray(projects) ? projects : [];
    const byChannel = list.find((p: any) => p.slackChannel === m.channel);
    if (!byChannel && list.length > 1) {
      await say({ thread_ts: m.ts, text: `which project is this for? include a task id (like \`${list[0].prefix}-1\`) or a project prefix: ${list.map((p: any) => `\`${p.prefix}\``).join(' ')}` });
      return;
    }
    const target = byChannel ?? list[0];
    if (!target) { await say({ thread_ts: m.ts, text: 'no projects registered yet. run /houston-project-init first.' }); return; }
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

// intake must never die silently: any unexpected failure still answers the human
async function safeHandle(args: any) {
  try {
    await handle(args);
  } catch (e) {
    console.error('gabbar handler error:', e);
    const m = args.message ?? args.event;
    await args.say?.({ thread_ts: m?.ts, text: `something broke logging that (${String(e).slice(0, 120)}). send it again in a bit.` }).catch(() => {});
  }
}

app.message(async (args: any) => { if (args.message.channel_type === 'im') await safeHandle(args); });
app.event('app_mention', async (args: any) => { await safeHandle(args); });

SELF_USER = ((await app.client.auth.test()) as { user_id?: string }).user_id ?? '';
await app.start();
console.log(`gabbar (scribe) connected via socket mode as ${SELF_USER}`);
