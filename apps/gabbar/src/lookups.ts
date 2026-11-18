// The two darbar reads the TRANSPORT makes before the agent gets a turn: who is this person, and
// does this thread already have a feedback row.
//
// They lived in bot.ts and are here for one reason: bot.ts opens a slack socket at import, so
// nothing can drive them without connecting to the real workspace, and DAR-235 was a bug in exactly
// these two calls that survived a fix and a review because neither could be exercised. The transport
// still owns them, it just imports them now.
import { fetchDarbar, notifyOwnerGated, type AgentContext } from './agent';
import { parkIdFor, parkReport, readParked } from './parked';

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
 * in any other case. A reply darbar refuses or cannot take, or one whose slack reads fail, is PARKED
 * (parked.ts), never dropped. Returns the row's shortId, a PARK- id when held, or null.
 */
export async function fileLoopThreadReply(
  client: any,
  m: { channel: string; ts: string; thread_ts: string; user: string; text?: string },
  selfUser: string,
): Promise<string | null> {
  const text = (m.text || '').trim();
  if (!selfUser || !text) return null;
  const at = `${m.channel}/${m.ts}`;
  const list = await fetchDarbar('/projects');
  const listed = list.reachable && Array.isArray(list.json);
  const project = listed
    ? (list.json as unknown as Array<{ prefix?: string; name?: string; slackChannel?: string | null }>)
      .find((p) => p.slackChannel === m.channel && p.prefix) ?? null
    : null;
  if (listed && !project) return null;
  const bodyOf = (link?: string) =>
    `${text}\n\n(reply in a Gabbar-posted Slack thread: channel ${m.channel}, thread_ts ${m.thread_ts}, reply ts ${m.ts}${link ? `, ${link}` : ''}. Reply in that thread, not in the channel.)`;
  const park = (cause: 'stakeholder_gap' | 'outage', gateKind: string, gateDetail: string, name: string, body: string) => {
    const id = parkIdFor(m.channel, m.ts);
    const fresh = !readParked(id);
    const item = parkReport({
      channel: m.channel, ts: m.ts, threadTs: m.thread_ts, authorId: m.user, authorName: name,
      projectRef: project?.prefix ?? null, projectName: project?.name ?? null, taskRef: null,
      feedbackType: 'feature', body, rawMessage: text, attachments: [], mediaNotes: [],
      gateKind, gateDetail, cause,
    });
    console.error(`gabbar: loop-thread reply ${at} parked as ${item.parkId} (${cause}): ${gateDetail}`);
    return { item, fresh };
  };
  const unread = (what: string, e: unknown) => {
    console.error(`gabbar: loop-thread ${what} failed for ${at}:`, e);
    return park('outage', 'slack_read_failed', `${what} failed: ${String(e)}`, m.user, bodyOf()).item.parkId;
  };

  let root: any;
  try {
    root = await client.conversations.replies({ channel: m.channel, ts: m.thread_ts, limit: 1, inclusive: true }).then((r: any) => r?.messages?.[0]);
  } catch (e) {
    return unread('conversations.replies', e);
  }
  if (!root || root.ts !== m.thread_ts || root.user !== selfUser) return null;
  let who: any;
  try {
    who = await client.users.info({ user: m.user });
  } catch (e) {
    return unread('users.info', e);
  }
  if (who?.user?.is_bot) return null;
  const name: string = who?.user?.profile?.display_name || who?.user?.real_name || m.user;
  const link: string | undefined = await client.chat.getPermalink({ channel: m.channel, message_ts: m.ts })
    .then((r: any) => r?.permalink as string | undefined)
    .catch((e: unknown) => { console.error(`gabbar: loop-thread getPermalink failed for ${at}:`, e); return undefined; });
  const body = bodyOf(link);

  if (!project) {
    return park('outage', 'unreachable', list.reachable ? 'projects list unreadable' : list.detail, name, body).item.parkId;
  }
  const f = await fetchDarbar('/feedback', 'POST', {
    project: project.prefix,
    type: 'feature',
    body,
    author: name,
    slack: { channel: m.channel, ts: m.ts, user: m.user },
    idempotencyKey: `gabbar:${m.channel}:${m.ts}:loop-reply`,
  });
  if (!f.reachable) return park('outage', 'write_failed', f.detail, name, body).item.parkId;
  const fb = f.json as { shortId?: string; error?: string };
  if (fb.shortId) return fb.shortId;
  const gap = f.status === 400;
  const { item, fresh } = park(gap ? 'stakeholder_gap' : 'outage', gap ? 'not_stakeholder' : 'write_failed', `${f.status}: ${fb.error ?? 'refused'}`, name, body);
  if (gap && fresh) {
    await notifyOwnerGated(
      { senderId: m.user, senderName: name, channel: m.channel, channelType: 'channel', threadTs: m.thread_ts, messageTs: m.ts } as AgentContext,
      `replied in a Gabbar-posted thread on *${project.name ?? project.prefix}* but is not on its roster. nothing was filed. their reply is parked as \`${item.parkId}\`, add them as a stakeholder and it files on their next message to me.`,
      text,
    );
  }
  return item.parkId;
}

const PR_URL = /https?:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/;

/** DAR-413. The first PR url in a message POSTED BY selfUser in this thread, else null. Only slack's own `user` field counts. */
export async function prThreadFor(client: any, channel: string, threadTs: string | null, selfUser: string): Promise<{ url: string } | null> {
  if (!threadTs || !selfUser) return null;
  // signal is only "Gabbar posted a PR link in this thread", nothing stronger
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
