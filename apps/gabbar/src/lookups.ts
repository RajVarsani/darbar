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
  const f = await fetchDarbar('/projects');
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
