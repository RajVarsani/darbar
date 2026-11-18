// The two darbar reads the TRANSPORT makes before the agent gets a turn: who is this person, and
// does this thread already have a feedback row.
//
// They lived in bot.ts and are here for one reason: bot.ts opens a slack socket at import, so
// nothing can drive them without connecting to the real workspace, and DAR-235 was a bug in exactly
// these two calls that survived a fix and a review because neither could be exercised. The transport
// still owns them, it just imports them now.
import { fetchDarbar } from './agent';

/**
 * DAR-235. Both of these used a RAW fetch: no AbortSignal, no per-request timeout, no budget. They
 * run inside the Promise.all that executes BEFORE runAgent, so against a darbar that accepts a
 * connection and never answers a slack message hung there forever and never reached any of the
 * protection DAR-210 added. The 20s guarantee was true of agent.ts and not true of a message end to
 * end, which is the claim a reader actually makes.
 *
 * They go through fetchDarbar now, so each one carries the per-request timeout and each one is
 * charged to the message budget, and bot.ts opens that budget scope around the whole message rather
 * than around the model turn. Both halves are needed and neither is sufficient: fetchDarbar with no
 * scope open is bounded per request but unbudgeted, and a scope around a raw fetch bounds nothing at
 * all, because the budget only ever measures calls that go through fetchDarbar.
 *
 * The lesson worth keeping: a bound is only as good as the narrowest path that bypasses it. There is
 * a test in this workspace that reads every source file under apps/gabbar/src and fails if the
 * darbar url is NAMED anywhere outside fetchDarbar, because a sweep done once is a sweep that rots.
 * It checks for the url rather than for a call on purpose: the first version of that guard looked
 * for both on one line and missed the second of these two functions, because this call was written
 * across two lines. A guard that passes on the bug it was built for is worse than no guard.
 */
export async function senderName(client: any, userId: string): Promise<string> {
  // identity lookup, not a work-surface listing: a stakeholder only on an archived project must still resolve
  const f = await fetchDarbar('/projects?archived=all');
  if (f.reachable) {
    // /projects is an array; fetchDarbar passes arrays through untouched for exactly this
    const projects = f.json as unknown as Array<{ stakeholders?: Array<{ slackUserId?: string; name: string }> }>;
    for (const p of Array.isArray(projects) ? projects : []) {
      const s = (p.stakeholders || []).find((s) => s.slackUserId === userId);
      if (s) return s.name;
    }
  }
  // darbar down, or this person is on no roster: fall through to the slack profile, as before
  const info = await client.users.info({ user: userId }).catch(() => null);
  return info?.user?.profile?.display_name || info?.user?.real_name || userId;
}

export async function existingFeedback(channel: string, threadTs: string | null) {
  if (!threadTs) return null;
  const f = await fetchDarbar(
    `/feedback/by-slack?channel=${encodeURIComponent(channel)}&ts=${encodeURIComponent(threadTs)}`,
  );
  // Unreachable and 404 both mean "no row to work with here", exactly as the old !r.ok did. It is
  // not the gate, so there is nothing to fail closed about: a null only costs the turn its thread
  // mapping, and every write this precedes runs the gate itself.
  if (!f.reachable || f.status === 404) return null;
  const fb = f.json as { shortId?: string; status?: string };
  return fb.shortId ? { shortId: fb.shortId, status: fb.status ?? 'unknown' } : null;
}

/**
 * DAR-411. A plain human reply under a thread whose ROOT the Gabbar bot itself posted (a loop's
 * daily report) in a channel bound to a project is filed as pending feedback on that project, so the
 * project's T3 outbox hands it on. One row per reply, keyed on (channel, reply ts). Files nothing
 * and posts nothing to slack in any other case. Returns the filed/matched row's shortId, or null.
 */
export async function fileLoopThreadReply(
  client: any,
  m: { channel: string; ts: string; thread_ts: string; user: string; text?: string },
  selfUser: string,
): Promise<string | null> {
  const text = (m.text || '').trim();
  if (!selfUser || !text) return null;
  const list = await fetchDarbar('/projects');
  if (!list.reachable || !Array.isArray(list.json)) return null;
  const project = (list.json as unknown as Array<{ prefix?: string; slackChannel?: string | null }>)
    .find((p) => p.slackChannel === m.channel && p.prefix);
  if (!project) return null;
  const root = await client.conversations
    .replies({ channel: m.channel, ts: m.thread_ts, limit: 1, inclusive: true })
    .then((r: any) => r?.messages?.[0])
    .catch(() => null);
  if (!root || root.ts !== m.thread_ts || root.user !== selfUser) return null;
  const author = await client.users.info({ user: m.user }).catch(() => null);
  if (author?.user?.is_bot) return null;
  const [name, link] = await Promise.all([
    senderName(client, m.user),
    client.chat.getPermalink({ channel: m.channel, message_ts: m.ts }).then((r: any) => r?.permalink as string | undefined).catch(() => undefined),
  ]);
  const f = await fetchDarbar('/feedback', 'POST', {
    project: project.prefix,
    type: 'feature',
    body: `${text}\n\n(reply in a Gabbar-posted Slack thread: channel ${m.channel}, thread_ts ${m.thread_ts}, reply ts ${m.ts}${link ? `, ${link}` : ''}. Reply in that thread, not in the channel.)`,
    author: name,
    slack: { channel: m.channel, ts: m.ts, user: m.user },
    idempotencyKey: `gabbar:${m.channel}:${m.ts}:loop-reply`,
  });
  if (!f.reachable) {
    console.error(`gabbar: loop-thread reply ${m.channel}/${m.ts} not filed: ${f.detail}`);
    return null;
  }
  const fb = f.json as { shortId?: string; error?: string };
  if (!fb.shortId) console.error(`gabbar: loop-thread reply ${m.channel}/${m.ts} refused: ${fb.error}`);
  return fb.shortId ?? null;
}

const PR_URL = /https?:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/;

/** DAR-413. The first PR url in a message POSTED BY selfUser in this thread, else null. Only slack's own `user` field counts. */
export async function prThreadFor(client: any, channel: string, threadTs: string | null, selfUser: string): Promise<{ url: string } | null> {
  if (!threadTs || !selfUser) return null;
  const msgs: Array<{ user?: string; text?: string }> = await client.conversations
    .replies({ channel, ts: threadTs, limit: 200 })
    .then((r: any) => r?.messages ?? [])
    .catch(() => []);
  for (const m of msgs) {
    if (m.user !== selfUser) continue;
    const hit = (m.text || '').match(PR_URL);
    if (hit) return { url: hit[0] };
  }
  return null;
}
