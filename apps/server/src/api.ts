import { Hono } from 'hono';
import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { Projects, Tasks, Feedback, Events, ObjectId, capId, nextShortId } from '@darbar/core';
import { emit, subscribe } from './sse';
import { config, pathPatternError, PATH_PATTERN_FORM } from '@darbar/core';
import type { FeedbackDoc, Pipeline, ProjectAgent, ProjectProxy, PublishedRoute, Task, TaskStatus, TaskType, FeedbackStatus } from '@darbar/core';

export const api = new Hono();

export const TASK_STATUSES: TaskStatus[] = ['backlog', 'todo', 'in_progress', 'in_review', 'qa', 'blocked', 'done', 'cancelled'];
export const TASK_TYPES: TaskType[] = ['feature', 'bug', 'chore', 'review', 'regression'];
export const FEEDBACK_STATUSES: FeedbackStatus[] = ['pending', 'triaged', 'needs_clarification', 'accepted', 'in_progress', 'resolved', 'rejected'];
const FEEDBACK_TYPES = ['bug', 'design', 'idea', 'approval'];
const CLOSED: TaskStatus[] = ['done', 'cancelled'];

// body/type guards: user-controlled JSON never reaches Mongo operators or the board untyped
async function readBody(c: Context): Promise<Record<string, unknown> | null> {
  const b = await c.req.json().catch(() => null);
  return b && typeof b === 'object' && !Array.isArray(b) ? b : null;
}
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const strOrNull = (v: unknown): string | null | undefined =>
  v === null ? null : typeof v === 'string' ? v : undefined;
const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
// lanes: absent = untouched, null = default-all, [] = explicitly none, array = subset.
// malformed shapes 400 instead of coercing — lanes:[123] must never read as "explicitly none"
const LANES_SHAPE_ERROR = 'lanes must be null or an array of lane-key strings';
const lanesShapeBad = (v: unknown): boolean =>
  v !== undefined && v !== null && !(Array.isArray(v) && v.every((x) => typeof x === 'string'));
const lanesArr = (v: unknown): string[] | null | undefined =>
  v === null ? null : Array.isArray(v) ? (v as string[]) : undefined;

// unknown lane keys are typos, not silent no-ops
function laneError(p: { pipeline?: Pipeline } | null, want: string[]): string | null {
  const valid = (p?.pipeline?.reviews ?? []).map((r) => r.lane);
  const bad = want.filter((l) => !valid.includes(l));
  return bad.length
    ? `unknown lane(s): ${bad.join(', ')}; valid lane keys: ${valid.join(', ') || '(none configured)'}`
    : null;
}

async function logEvent(projectId: ObjectId, text: string, taskId?: ObjectId | null) {
  await Events.insertOne({ projectId, taskId: taskId ?? null, text, at: new Date() });
  const p = await Projects.findOne({ _id: projectId }, { projection: { capId: 1 } });
  if (p) emit(p.capId, { kind: 'event', text });
}

// resolution replies live in the SERVER, not the bot: Gabbar is intake-only.
// A failed reply is logged as a project event so it is visible on the board.
async function slackThreadReply(fb: FeedbackDoc, text: string) {
  if (!fb.slack?.channel || !config.slackBotToken) return;
  try {
    const r = await fetch(`${config.slackApiBase}/chat.postMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.slackBotToken}` },
      body: JSON.stringify({ channel: fb.slack.channel, thread_ts: fb.slack.ts, text }),
    });
    const res = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (!res.ok) await logEvent(fb.projectId, `slack reply FAILED for ${fb.shortId}: ${res.error ?? `http ${r.status}`}`, fb.taskId);
  } catch (e) {
    await logEvent(fb.projectId, `slack reply FAILED for ${fb.shortId}: ${String(e)}`, fb.taskId);
  }
}

async function resolveTaskRef(ref: string) {
  return Tasks.findOne({ shortId: ref.toUpperCase() });
}

// pipeline config comes from user JSON: rebuild it field-by-field, never store the raw object.
// Malformed input errors with what failed instead of being dropped (FB-48/FB-56: error, never coerce)
function readPipeline(v: unknown): { pipeline: Pipeline } | { error: string } {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { error: 'pipeline must be an object {autoAdvance?, reviews}' };
  const o = v as Record<string, unknown>;
  if (o.autoAdvance !== undefined && typeof o.autoAdvance !== 'boolean') return { error: 'pipeline.autoAdvance must be a boolean when present' };
  // reviews replaces the whole lane list, so an omitted/garbage array would silently wipe it
  if (!Array.isArray(o.reviews)) return { error: 'pipeline.reviews must be an array of {lane, label?, manager}' };
  const reviews: Pipeline['reviews'] = [];
  const errs: string[] = [];
  o.reviews.forEach((r, i) => {
    if (!r || typeof r !== 'object' || Array.isArray(r)) { errs.push(`pipeline.reviews[${i}]: not an object`); return; }
    const { lane, label, manager } = r as Record<string, unknown>;
    const bad: string[] = [];
    if (typeof lane !== 'string' || !lane) bad.push('lane (non-empty string) required');
    if (typeof manager !== 'string' || !manager) bad.push('manager (non-empty string) required');
    if (label !== undefined && typeof label !== 'string') bad.push('label must be a string when present');
    if (bad.length) { errs.push(`pipeline.reviews[${i}]: ${bad.join('; ')}`); return; }
    reviews.push({ lane: lane as string, label: typeof label === 'string' && label ? label : (lane as string), manager: manager as string });
  });
  return errs.length ? { error: errs.join(' | ') } : { pipeline: { autoAdvance: o.autoAdvance !== false, reviews } };
}

// agent registry from user JSON: rebuilt field-by-field like readPipeline, but malformed
// entries 400 with what failed instead of silently filtering (FB-48: error, never coerce)
const AGENT_KINDS: ProjectAgent['kind'][] = ['lane-manager', 'helper', 'orchestrator'];
function readAgents(v: unknown): { agents: ProjectAgent[] } | { error: string } {
  if (!Array.isArray(v)) return { error: 'agents must be an array of {name, kind, brief, trigger?}' };
  const agents: ProjectAgent[] = [];
  const errs: string[] = [];
  const seen = new Set<string>();
  v.forEach((r, i) => {
    if (!r || typeof r !== 'object' || Array.isArray(r)) { errs.push(`agents[${i}]: not an object`); return; }
    const { name, kind, brief, trigger } = r as Record<string, unknown>;
    const bad: string[] = [];
    if (typeof name !== 'string' || !name) bad.push('name (non-empty string) required');
    if (typeof kind !== 'string' || !AGENT_KINDS.includes(kind as ProjectAgent['kind'])) bad.push(`kind must be ${AGENT_KINDS.join('|')}`);
    if (typeof brief !== 'string' || !brief) bad.push('brief (non-empty string) required');
    if (trigger !== undefined && typeof trigger !== 'string') bad.push('trigger must be a string when present');
    if (bad.length) { errs.push(`agents[${i}]: ${bad.join('; ')}`); return; }
    // name is the assignment/lookup key: a duplicate makes every name-based lookup ambiguous
    if (seen.has(name as string)) { errs.push(`agents[${i}]: duplicate name ${name}`); return; }
    seen.add(name as string);
    agents.push({ name: name as string, kind: kind as ProjectAgent['kind'], brief: brief as string, ...(typeof trigger === 'string' ? { trigger } : {}) });
  });
  return errs.length ? { error: errs.join(' | ') } : { agents };
}

// proxy config from user JSON: rebuilt field-by-field like readPipeline/readAgents.
// Every field here is load-bearing for who can reach a dev server, so nothing is coerced:
// prefix is the URL segment and the routing key, and each public pattern IS the security
// boundary — an uncompilable regex errors rather than being dropped (FB-48/FB-56).
// public defaults to [] (route claimed, nothing reachable through the tunnel) and enabled
// defaults to false: sharing is always an explicit act.
const PROXY_RESERVED = ['p', 'api', 'files', '-']; // server's own paths; a prefix here shadows the board itself

// target must be a dev server on THIS machine, and the validator has to say so rather than the tool
// description: the proxy is what the permanent public domain fronts, so an arbitrary host with
// public:['/'] turns it into an open relay (FB-89). Loopback only. A private/LAN address is refused
// with its own reason — it is another box, and republishing it is exactly the open-relay case, just
// aimed inward. Link-local is named separately because 169.254.169.254 is the cloud metadata
// endpoint. A DNS name is refused because it can resolve anywhere; `localhost` is the only NAME with
// a fixed meaning. (FB-89 accepted "loopback, or at least private ranges" — this takes the tighter of
// the two; every route in use today is 127.0.0.1, so it costs nothing.)
//
// FB-108 closed the gap between that decision and the accept set:
//  · `*.localhost` is GONE. It was a DNS name this validator never resolves, exempted by a function
//    whose catch-all rejects DNS names precisely because they "can resolve anywhere" — which is
//    DNS-rebinding-shaped by construction. `http://evil.com.localhost:5173` was accepted, and only
//    landed on loopback here because mDNSResponder special-cases the reserved TLD; on glibc the name
//    NXDOMAINs and is retried against the DHCP search domain. That is a property of the resolver,
//    not of the validator.
//  · 0.0.0.0 / :: / ::ffff:127.x are ACCEPTED. They are the unspecified addresses, and connect() to
//    them goes to loopback — 0.0.0.0 in particular is the string Vite/uvicorn print under --host, so
//    rejecting it as "a public address" was both wrong and the likeliest real friction of the feature.
//  · a single trailing dot (the DNS root label) is normalised before any check, so `localhost.` and
//    `127.0.0.1.` no longer disagree.
//  · userinfo is REJECTED: Bun's fetch does not put those credentials on the wire, so an operator who
//    configures auth this way silently gets none, and the string is persisted into the doc and into
//    routes.json.
// Returns the PARSED href, not the raw string: ' http://localhost:5173' validated and then broke
// every HMR upgrade (proxy.ts does target.replace(/^http/,'ws')), and a trailing space 502'd forever.
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const LOOPBACK = 'localhost, 127.0.0.0/8, ::1, or an unspecified address (0.0.0.0, ::)';
const RELAY_WHY = 'the proxy is publicly reachable through the tunnel, so anything else is an open relay onto a host that never agreed to be published';
function readTarget(s: string): { target: string } | { error: string } {
  const err = (error: string) => ({ error });
  let u: URL;
  try { u = new URL(s.trim()); } catch { return err('must be an http(s) URL string, e.g. http://localhost:5173'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return err(`must be http(s), not ${u.protocol}`);
  if (u.username || u.password) {
    return err('must not carry userinfo (user:pass@) — fetch does not send those credentials upstream, so the target would be reached with NO auth while the password sits in the project doc and in routes.json');
  }
  // the proxy forwards `${target}${path}${search}`, so a target search/hash lands mid-URL
  if (u.search) return err(`must not carry a query string (the proxy appends the request path and query, so "${s}" becomes a garbage upstream URL)`);
  if (u.hash) return err(`must not carry a fragment (the proxy appends the request path, so "${s}" becomes a garbage upstream URL)`);
  // strip the brackets of an IPv6 literal and one trailing root dot; both are notation, not identity
  const h = u.hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '').replace(/\.$/, '');
  // origin+pathname, never u.href: href normalises a bare origin to a TRAILING SLASH, and the proxy
  // forwards `${target}${path}` with path already starting with '/', so that would double-slash every
  // upstream URL. Stripping the trailing slash also keeps the DAR-153 base-path form intact
  // (http://127.0.0.1:5173/fe stays exactly that, which is what stops Vite's 302 loop).
  const ok = () => ({ target: (u.origin + u.pathname).replace(/\/+$/, '') });
  if (h === 'localhost') return ok();
  const v4 = (a: string): string | null => {
    const m = IPV4.exec(a);
    if (!m) return `host "${u.hostname}" is not a valid address`;
    const o = m.slice(1).map(Number) as [number, number, number, number];
    if (o.some((n) => n > 255)) return `host "${u.hostname}" is not a valid address`;
    if (o[0] === 127) return null;
    if (o[0] === 0 && o[1] === 0 && o[2] === 0 && o[3] === 0) return null; // unspecified: connects to loopback
    if (o[0] === 169 && o[1] === 254) {
      return `host "${u.hostname}" is link-local (169.254/16 carries the cloud metadata endpoint) — proxy.target must be a dev server on this machine (${LOOPBACK})`;
    }
    const priv = o[0] === 10 || (o[0] === 172 && o[1] >= 16 && o[1] <= 31) || (o[0] === 192 && o[1] === 168);
    if (priv) return `host "${u.hostname}" is a private/LAN address, i.e. another machine — proxy.target must be a dev server on this machine (${LOOPBACK}); ${RELAY_WHY}`;
    return `host "${u.hostname}" is a public address — proxy.target must be a dev server on this machine (${LOOPBACK}); ${RELAY_WHY}`;
  };
  if (IPV4.test(h)) { const bad = v4(h); return bad ? err(bad) : ok(); }
  // a colon means an IPv6 LITERAL, never a name — say so rather than falling through to "DNS name"
  if (h.includes(':')) {
    if (h === '::1' || h === '::') return ok(); // loopback and unspecified
    // IPv4-mapped: judge it by the IPv4 rules. WHATWG canonicalises ::ffff:127.0.0.1 to the HEX form
    // ::ffff:7f00:1 by the time it reaches u.hostname, so both spellings have to be understood.
    const mapped = /^::ffff:(.+)$/.exec(h);
    if (mapped) {
      const rest = mapped[1]!;
      const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(rest);
      const dotted = hex
        ? [parseInt(hex[1]!, 16) >> 8, parseInt(hex[1]!, 16) & 0xff, parseInt(hex[2]!, 16) >> 8, parseInt(hex[2]!, 16) & 0xff].join('.')
        : rest;
      const bad = v4(dotted);
      return bad ? err(bad) : ok();
    }
    if (/^f[cde][0-9a-f]{0,2}:/.test(h)) return err(`host "${u.hostname}" is a private/link-local IPv6 address, i.e. another machine — proxy.target must be a dev server on this machine (${LOOPBACK}); ${RELAY_WHY}`);
    return err(`host "${u.hostname}" is an IPv6 address outside loopback — proxy.target must be a dev server on this machine (${LOOPBACK}); ${RELAY_WHY}`);
  }
  return err(`host "${u.hostname}" is a DNS name, which can resolve anywhere and is resolved at REQUEST time, not here — proxy.target must be a dev server on this machine, addressed literally (${LOOPBACK})`);
}

// `public` is NOT a regex list any more (FB-107). Two rounds of trying to make user regex safe at
// validation time failed for a structural reason: cost at a FIXED short path is unbounded in PATTERN
// length (`^/`+`.*`xK+`x$` on a 64-char path: 0.1ms at K=3, 11958ms at K=8, and the 200-char cap
// allowed K≈95), so no probe alphabet, no probe length and no length cap bounds the right variable —
// and moving the check to request time does not help either, because terminate() cannot preempt a
// thread already inside the backtracking loop. So the boundary is now a small pattern LANGUAGE that
// is matched with string operations (pathPatternError / matchPathPattern in @darbar/core). The
// safety argument is structural — there is no engine that can backtrack — rather than a measurement.
// Every allowlist in use across the whole system was already a literal prefix, so nothing expressive
// is lost. Anything that still looks like a regex is refused here with the form spelled out.

function readProxy(v: unknown): { proxy: ProjectProxy } | { error: string } {
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    return { error: 'proxy must be an object {prefix, target, public?, enabled?} — or null to clear' };
  }
  const o = v as Record<string, unknown>;
  const errs: string[] = [];
  if (typeof o.prefix !== 'string' || !/^[A-Za-z0-9_-]+$/.test(o.prefix)) {
    errs.push('proxy.prefix must be a non-empty string of [A-Za-z0-9_-] (it is the URL segment and the routing key)');
  } else if (PROXY_RESERVED.includes(o.prefix)) {
    errs.push(`proxy.prefix "${o.prefix}" is reserved (${PROXY_RESERVED.join(', ')} are the server's own paths)`);
  }
  let target = '';
  if (typeof o.target !== 'string' || !o.target) {
    errs.push('proxy.target must be an http(s) URL string, e.g. http://localhost:5173');
  } else {
    const t = readTarget(o.target);
    if ('error' in t) errs.push(`proxy.target ${t.error}`);
    else target = t.target; // normalised href, so a stray space cannot 502 forever or break ws://
  }
  if (o.enabled !== undefined && typeof o.enabled !== 'boolean') errs.push('proxy.enabled must be a boolean when present');
  const pub: string[] = [];
  if (o.public !== undefined) {
    if (!Array.isArray(o.public)) errs.push(`proxy.public must be an array of path patterns, e.g. ["/$","/assets/"] — each is ${PATH_PATTERN_FORM}`);
    else o.public.forEach((r, i) => {
      const bad = pathPatternError(r);
      if (bad) { errs.push(`proxy.public[${i}] (${JSON.stringify(r)}): rejected — it ${bad}`); return; }
      pub.push(r as string);
    });
  }
  if (errs.length) return { error: errs.join(' | ') };
  return { proxy: { prefix: o.prefix as string, target, public: pub, enabled: o.enabled === true } };
}

// ---------- proxy route reconciliation ----------
// The server owns the proxy route table, but "owns" is not "cannot fail": a push can fail with the
// doc already written, so the doc states INTENT (project.proxy) and a second field states FACT
// (project.proxyPublished — what we actually put in the table and have not withdrawn). Every push is
// best-effort like slackThreadReply, and the boot pass is a real SYNC that converges the two in both
// directions (FB-87). Prefixes we did not publish are never touched: the namespace is shared with
// hand-added routes and taking one over is an exposure change (FB-96).

type LiveRoute = { target: string; public: string[] };
type LiveRoutes = { default: LiveRoute; prefixes: Record<string, LiveRoute> };

async function proxyAdmin(path: string, method: string, body?: unknown): Promise<unknown> {
  if (!config.proxyAdminToken) throw new Error('PROXY_ADMIN_TOKEN not configured');
  const r = await fetch(`http://127.0.0.1:${config.proxyPort}${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${config.proxyAdminToken}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${method} ${path} → http ${r.status}`);
  return r.json().catch(() => null);
}

async function fetchRoutes(): Promise<LiveRoutes> {
  const j = (await proxyAdmin('/-/routes', 'GET')) as LiveRoutes | null;
  if (!j || typeof j !== 'object' || !j.prefixes) throw new Error('GET /-/routes returned no route table');
  return j;
}

const publishRoute = (x: PublishedRoute) =>
  proxyAdmin('/-/route', 'POST', { prefix: x.prefix, target: x.target, public: x.public });

// ownership token: a live prefix is ours only while it still carries exactly what we published.
// Once a hand edit or another writer changes it, it is theirs and we neither re-claim nor delete it.
const sameRoute = (a: LiveRoute | PublishedRoute | null | undefined, b: LiveRoute | PublishedRoute | null | undefined): boolean =>
  !!a && !!b && a.target === b.target && a.public.length === b.public.length && a.public.every((x, i) => x === b.public[i]);

const wantOf = (x: ProjectProxy | null | undefined): PublishedRoute | null =>
  x?.enabled ? { prefix: x.prefix, target: x.target, public: x.public } : null;

// Would applying `after` make MORE reachable than `before` already does? Only such a change can put
// a route over one this project does not own, which is the only thing the hijack guard protects
// (FB-105). Disabled publishes nothing. Otherwise it is a de-escalation when the route identity is
// unchanged (same prefix, same target, already enabled) and the new allowlist is a subset of the old.
function escalates(before: ProjectProxy | null | undefined, after: ProjectProxy): boolean {
  if (!wantOf(after)) return false;
  if (!before?.enabled || before.prefix !== after.prefix || before.target !== after.target) return true;
  const was = new Set(before.public);
  return !after.public.every((s) => was.has(s));
}

// Two renderings on purpose. Project events are shipped by GET /p/:capId, which IS on the proxy's
// public allowlist, so anything written into an event is readable by a board-link holder — the
// target must not appear there any more than it appears in the board payload itself (FB-89). The
// allowlist is what an event needs to state anyway: it is the boundary. The full detail goes to the
// server console and to the 409/context responses, all of which are local-only.
const routePub = (r: LiveRoute | PublishedRoute) => `public: ${r.public.join(', ') || 'nothing'}`;
const routeDesc = (r: LiveRoute | PublishedRoute) => `${r.target} (${routePub(r)})`;

// the route work and the doc write are both already done by the time this runs: a logging hiccup must
// not be reported as a sync failure, and must not escape as a 500 on a committed write (FB-90)
async function safeLog(projectId: ObjectId, text: string) {
  try { await logEvent(projectId, text); } catch (e) { console.error(`project event log FAILED (${text}): ${String(e)}`); }
}

async function saveHeld(projectId: ObjectId, held: PublishedRoute[]) {
  try { await Projects.updateOne({ _id: projectId }, { $set: { proxyPublished: held } }); }
  catch (e) { console.error(`proxyPublished write FAILED for ${projectId.toString()}: ${String(e)}`); }
}

// Withdraw one route we hold. Returns whether we still hold it afterwards.
async function withdrawHeld(h: PublishedRoute, live: LiveRoutes, notes: string[]): Promise<boolean> {
  const cur = live.prefixes[h.prefix];
  if (!cur) { notes.push(`proxy route /${h.prefix}/ was already absent`); return false; }
  if (!sameRoute(cur, h)) {
    console.error(`proxy route /${h.prefix}/ not removed: now serves ${routeDesc(cur)}, this project published ${routeDesc(h)}`);
    notes.push(`proxy route /${h.prefix}/ NOT removed: it no longer serves what this project published (now ${routePub(cur)}) — it belongs to someone else and was left alone`);
    return false;
  }
  try { await proxyAdmin(`/-/route/${h.prefix}`, 'DELETE'); delete live.prefixes[h.prefix]; notes.push(`proxy route removed: /${h.prefix}/`); return false; }
  catch (e) { notes.push(`proxy route /${h.prefix}/ NOT removed (${String(e)}) — it is STILL LIVE; the next change or a server restart will withdraw it`); return true; }
}

// Publish the route this project wants. Returns whether we hold it afterwards.
async function publishWanted(want: PublishedRoute, held: PublishedRoute[], live: LiveRoutes, notes: string[]): Promise<boolean> {
  const cur = live.prefixes[want.prefix];
  const ours = held.find((h) => h.prefix === want.prefix) ?? null;
  if (cur && !sameRoute(cur, want) && !sameRoute(cur, ours)) {
    console.error(`proxy route /${want.prefix}/ not published: prefix already serves ${routeDesc(cur)}, wanted ${routeDesc(want)}`);
    notes.push(`proxy route /${want.prefix}/ NOT published: the prefix is already held by a route this project did not publish (${routePub(cur)}) — publishing would repoint someone else's URL and replace their allowlist`);
    return false;
  }
  if (sameRoute(cur, want)) { notes.push(`proxy route /${want.prefix}/ already correct`); return true; }
  try {
    await publishRoute(want);
    live.prefixes[want.prefix] = { target: want.target, public: want.public };
    console.log(`proxy route published: /${want.prefix}/ → ${routeDesc(want)}`);
    notes.push(`proxy route published: /${want.prefix}/ (${routePub(want)})`);
    return true;
  }
  catch (e) { notes.push(`proxy route /${want.prefix}/ NOT published (${String(e)}) — the share is configured but the link does not resolve; the next change or a server restart will publish it`); return false; }
}

// ONE convergence pass, used by both callers (a PATCH and the boot sync). It was copy-pasted before,
// which is exactly how the fail-open below came to exist in two places that then had to be fixed twice.
// `held` is project.proxyPublished going in — what is live because of us, not what the doc wants.
// Withdrawal is driven off it rather than off the previous config, so a clear ($unset) is still
// convergeable (FB-87 trace 3), and a failed delete keeps its orphan recorded instead of losing it.
// The publish is attempted even when the withdrawal failed, so a rename never loses BOTH ends (trace 2).
// Returns what this project holds after the pass.
async function convergeRoutes(held: PublishedRoute[], want: PublishedRoute | null, live: LiveRoutes, notes: string[]): Promise<PublishedRoute[]> {
  const next: PublishedRoute[] = [];
  // FB-103. The held entry for the WANTED prefix is the ownership token that proves the live route is
  // ours, and it must survive until the publish is CONFIRMED. Dropping it up front (the withdraw loop
  // used to `continue` past it, and only a truthy publish put it back) meant a same-prefix edit with a
  // failing POST left the old route live with proxyPublished:[] — after which the boot sync REFUSED to
  // repair its own route ("held by a route this project did not publish", the token being gone) and a
  // later clear made zero proxy calls while logging a false "no route published" all-clear. That is
  // permanently unconvergeable plus a confident wrong answer, over a dev server still on public ["/"].
  const prior = want ? held.find((h) => h.prefix === want.prefix) ?? null : null;
  for (const h of held) {
    if (want && h.prefix === want.prefix) continue; // the publish below decides this prefix's fate
    if (await withdrawHeld(h, live, notes)) next.push(h);
  }
  if (want) {
    if (await publishWanted(want, held, live, notes)) next.push(want);
    // publish failed: whatever we had on that prefix is STILL LIVE and still ours. Keep the token so
    // the next pass can recognise and repair it. (If someone else has since taken the prefix over,
    // withdrawHeld will see that and drop it then — the safe direction is to keep the record.)
    else if (prior) next.push(prior);
  }
  return next;
}

async function reconcileProxy(projectId: ObjectId, held: PublishedRoute[], after: ProjectProxy | null) {
  const want = wantOf(after);
  const notes: string[] = [];
  // nothing live because of us and nothing to publish: the table is not involved, so do not touch it
  // (and do not raise a scary "unreachable" note about a save that never needed it — FB-90)
  if (!held.length && !want) { await safeLog(projectId, 'proxy config saved (disabled — no route published)'); return; }
  let live: LiveRoutes | null = null;
  try { live = await fetchRoutes(); } catch (e) { notes.push(`proxy route table unreachable (${String(e)}) — nothing was published or withdrawn; the boot sync will converge it`); }

  const next = live ? await convergeRoutes(held, want, live, notes) : held;
  if (!notes.length) notes.push('proxy config saved (disabled — no route published)');

  const changed = next.length !== held.length || next.some((h, i) => h.prefix !== held[i]?.prefix || !sameRoute(h, held[i]));
  if (changed) await saveHeld(projectId, next);
  await safeLog(projectId, notes.join(' · '));
}

// Boot SYNC (not a re-publish pass): reads the live table once and converges it against every
// project doc in BOTH directions — publish what is missing, withdraw what we published and no longer
// want. Prefixes nobody's doc claims are left strictly alone, so a hand-added route survives.
// routes.json persists across a proxy restart, so this is not about a restart losing entries — it is
// the only thing that ever repairs a push that failed while the proxy was down.
// The proxy may not be up at all: log and continue, never block the server from starting.
export async function reconcileAllProxies() {
  let live: LiveRoutes;
  try { live = await fetchRoutes(); }
  catch (e) { console.error(`proxy route sync SKIPPED: cannot read the route table (${String(e)}) — routes may differ from the project docs until the next change`); return; }

  const rows = await Projects.find({ $or: [{ proxy: { $exists: true } }, { proxyPublished: { $exists: true, $ne: [] } }] }).toArray();
  for (const p of rows) {
    const held = p.proxyPublished ?? [];
    const want = wantOf(p.proxy);
    if (!held.length && !want) continue;
    const notes: string[] = [];
    const next = await convergeRoutes(held, want, live, notes); // same implementation as the PATCH path
    if (!notes.length) continue;
    console.log(`proxy sync (${p.prefix}): ${notes.join(' · ')}`);
    const changed = next.length !== held.length || next.some((h, i) => h.prefix !== held[i]?.prefix || !sameRoute(h, held[i]));
    if (changed) await saveHeld(p._id!, next);
    // a sync that changed or refused something changed the EXPOSURE state, which is the one thing
    // this feature owes the board; only the pure no-op ("already correct") is left as console noise
    if (!notes.every((n) => n.includes('already correct'))) await safeLog(p._id!, `proxy route sync at boot: ${notes.join(' · ')}`);
  }
}

// ---------- review pipeline engine ----------
// All three live server-side so the rules hold no matter who moves a task (UI drag, MCP, curl).

const openReviewCount = (parentId: ObjectId) =>
  Tasks.countDocuments({ parentTaskId: parentId, type: 'review', status: { $nin: CLOSED } });

// feedback rows still blocking a task; needs_clarification is with the reporter, so not blocking
const OPEN_FEEDBACK: FeedbackStatus[] = ['pending', 'triaged', 'accepted', 'in_progress'];
const openFeedbackShortIds = async (taskId: ObjectId) =>
  (await Feedback.find({ taskId, status: { $in: OPEN_FEEDBACK } }, { projection: { shortId: 1 } }).toArray())
    .map((f) => f.shortId);

// dev task entered in_review -> one review subtask per configured lane, assigned to the lane manager.
// task.lanes narrows the configured lanes when set (null/absent = all).
// A re-entry after rework spawns a fresh round only once the previous round is fully closed.
async function spawnReviews(t: Task) {
  const p = await Projects.findOne({ _id: t.projectId });
  if (!p) return;
  const want = t.lanes ?? null;
  const lanes = (p.pipeline?.reviews ?? []).filter((l) => !want || want.includes(l.lane));
  if (await openReviewCount(t._id!)) return;
  if (lanes.length === 0) {
    if (!want) return; // no pipeline configured: task waits in in_review as before
    // explicit selection spawned nothing, so no child close will ever advance this task — do it now
    await logEvent(p._id!, `${t.shortId}: no review lanes selected — skipping reviews`, t._id);
    await maybeAdvanceParent(t._id!); // respects the feedback gate and autoAdvance
    return;
  }
  for (const l of lanes) {
    const doc: Task = {
      projectId: p._id!,
      shortId: await nextShortId(p._id!, 'task'),
      parentTaskId: t._id!,
      title: `${l.label}: ${t.title}`,
      description: `pipeline-spawned ${l.label} of ${t.shortId}. The lane manager reassigns to a subagent, files findings as feedback on ${t.shortId}, and closes this when the lane passes.`,
      status: 'todo',
      type: 'review',
      lane: l.lane,
      assignee: l.manager,
      assigneeType: 'agent',
      origin: `pipeline:${t.shortId}`,
      commits: [],
      blocker: null,
      notes: '',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await Tasks.insertOne(doc);
    await logEvent(p._id!, `${doc.shortId} spawned: ${l.label} review of ${t.shortId} → ${l.manager}`, doc._id);
  }
}

// last review child closed -> parent leaves in_review (autoAdvance) or waits for an explicit push
async function maybeAdvanceParent(parentId: ObjectId) {
  const parent = await Tasks.findOne({ _id: parentId });
  if (!parent || parent.status !== 'in_review') return;
  if (await openReviewCount(parentId)) return;
  const fbIds = await openFeedbackShortIds(parentId);
  if (fbIds.length) {
    await logEvent(parent.projectId, `${parent.shortId}: reviews closed but ${fbIds.length} open feedback (${fbIds.join(', ')}) — holding`, parent._id);
    return;
  }
  const p = await Projects.findOne({ _id: parent.projectId });
  if (p?.pipeline?.autoAdvance === false) {
    await logEvent(parent.projectId, `${parent.shortId}: all reviews closed — awaiting explicit push out of in_review`, parent._id);
    return;
  }
  await Tasks.updateOne({ _id: parentId }, { $set: { status: 'done', updatedAt: new Date() } });
  await logEvent(parent.projectId, `${parent.shortId} auto-advanced → done (all reviews closed)`, parent._id);
  const shipped = await Tasks.findOne({ _id: parentId });
  if (shipped) await resolvePromotedFeedback(shipped);
}

// task shipped -> feedback PROMOTED to it (resolvedTaskId) auto-resolves and the thread hears the ending.
// Asymmetric with the done-gate on purpose: rows FILED ON a task (taskId) still block done.
// Direct updateOne + reply here — never re-enters the PATCH /feedback route.
const PROMOTED_OPEN: FeedbackStatus[] = ['triaged', 'accepted', 'in_progress'];
async function resolvePromotedFeedback(task: Task) {
  if (task.type === 'review') return; // reviews are never promotion targets
  const rows = await Feedback.find({ resolvedTaskId: task._id, status: { $in: PROMOTED_OPEN } }).toArray();
  if (rows.length === 0) return;
  const last = task.commits[task.commits.length - 1];
  const resolution = `shipped: ${task.shortId} (${task.title}) is done${last ? ` (commit ${last})` : ''}`;
  for (const fb of rows) {
    await Feedback.updateOne({ _id: fb._id }, { $set: { status: 'resolved', resolution, updatedAt: new Date() } });
    await logEvent(fb.projectId, `${fb.shortId} auto-resolved: ${task.shortId} shipped`, fb.taskId);
    await slackThreadReply(fb, `*${fb.shortId} resolved.* ${resolution}`.trim());
  }
  // rows just resolved may have been the last hold on the task they were FILED ON
  const filedOn = new Map(rows.filter((fb) => fb.taskId).map((fb) => [fb.taskId!.toHexString(), fb.taskId!]));
  for (const id of filedOn.values()) await maybeAdvanceParent(id);
}

async function resolveProject(ref: string) {
  if (ObjectId.isValid(ref)) {
    const byId = await Projects.findOne({ _id: new ObjectId(ref) });
    if (byId) return byId;
  }
  return Projects.findOne({ $or: [{ capId: ref }, { prefix: ref.toUpperCase() }, { name: ref }] });
}

// ---------- projects ----------

api.post('/projects', async (c) => {
  const b = await readBody(c);
  if (!b) return c.json({ error: 'invalid json body' }, 400);
  const name = str(b.name), prefix = str(b.prefix);
  if (!name || !prefix || !/^[A-Za-z]{2,6}$/.test(prefix)) {
    return c.json({ error: 'name (string) and prefix (2-6 letters) required' }, 400);
  }
  const doc = {
    name,
    prefix: prefix.toUpperCase(),
    capId: capId(),
    repos: strArr(b.repos),
    charter: str(b.charter) ?? '',
    stakeholders: Array.isArray(b.stakeholders) ? b.stakeholders : [],
    slackChannel: strOrNull(b.slackChannel) ?? null,
    counters: { task: 0, feedback: 0 },
    createdAt: new Date(),
  };
  try {
    await Projects.insertOne(doc as never);
  } catch (e: unknown) {
    if ((e as { code?: number }).code === 11000) return c.json({ error: `prefix ${doc.prefix} already exists` }, 409);
    throw e;
  }
  await logEvent((doc as { _id?: ObjectId })._id!, `project created: ${doc.name}`);
  return c.json({ ...doc, boardUrl: `${config.baseUrl}/p/${doc.capId}` });
});

api.get('/projects', async (c) => {
  const list = await Projects.find({}, { projection: { charter: 0 } }).sort({ createdAt: -1 }).toArray();
  const withCounts = await Promise.all(list.map(async (p) => {
    const [tasks, done, pendingFb] = await Promise.all([
      Tasks.countDocuments({ projectId: p._id }),
      Tasks.countDocuments({ projectId: p._id, status: 'done' }),
      Feedback.countDocuments({ projectId: p._id, status: { $in: ['pending', 'needs_clarification'] } }),
    ]);
    return { ...p, boardUrl: `${config.baseUrl}/p/${p.capId}`, counts: { tasks, done, pendingFb } };
  }));
  return c.json(withCounts);
});

api.patch('/projects/:ref', async (c) => {
  const p = await resolveProject(c.req.param('ref'));
  if (!p) return c.json({ error: 'project not found' }, 404);
  const b = await readBody(c);
  if (!b) return c.json({ error: 'invalid json body' }, 400);
  const set: Record<string, unknown> = {};
  const charter = str(b.charter); if (charter !== undefined) set.charter = charter;
  const slackChannel = strOrNull(b.slackChannel); if (slackChannel !== undefined) set.slackChannel = slackChannel;
  let pipeline: Pipeline | undefined;
  if (b.pipeline !== undefined) {
    const parsed = readPipeline(b.pipeline);
    if ('error' in parsed) return c.json({ error: parsed.error }, 400);
    pipeline = parsed.pipeline;
    set.pipeline = pipeline;
  }
  let agents: ProjectAgent[] | undefined;
  if (b.agents !== undefined) {
    const parsed = readAgents(b.agents);
    if ('error' in parsed) return c.json({ error: parsed.error }, 400);
    agents = parsed.agents;
    set.agents = agents;
  }
  // proxy: absent = untouched, null = cleared (route withdrawn), object = replaced wholesale
  let proxyChange: { after: ProjectProxy | null } | undefined;
  const unset: Record<string, ''> = {};
  if (b.proxy !== undefined) {
    if (b.proxy === null) {
      unset.proxy = '';
      proxyChange = { after: null };
    } else {
      const parsed = readProxy(b.proxy);
      if ('error' in parsed) return c.json({ error: parsed.error }, 400);
      // the prefix is the routing key: a collision silently hijacks another project's URL
      const owner = await Projects.findOne({ _id: { $ne: p._id }, 'proxy.prefix': parsed.proxy.prefix });
      if (owner) return c.json({ error: `proxy prefix "${parsed.proxy.prefix}" is already claimed by project ${owner.prefix} (${owner.name})` }, 409);
      // ...but that namespace is SHARED with hand-added routes, so checking projects is not enough:
      // publishing over one repoints its target AND replaces its allowlist (an exposure change), and
      // the later withdrawal destroys it (FB-96). A proxy we cannot reach is not a veto — nothing is
      // published in that case anyway, and the boot sync applies the same check before it publishes.
      //
      // FB-105: this guard only belongs on a change that would PUBLISH over someone else's route.
      // Applying it to every PATCH meant a squatted prefix froze proxy.enabled at true — disable,
      // narrow, retarget all 409'd — so the board advertised a share the project could not switch
      // off, and the only escape was PATCH {proxy:null}, which skips this check and throws the config
      // away. A guard against exposure must never be the thing that guarantees it. So: a config that
      // publishes nothing is always allowed, and so is a pure de-escalation of one already in place.
      // (publishWanted applies the same ownership test before it writes, so the route table is
      // protected either way; this 409 exists to say so at the API edge rather than in an event log.)
      if (escalates(p.proxy, parsed.proxy)) {
        const liveHit = await fetchRoutes().then((r) => r.prefixes[parsed.proxy.prefix] ?? null).catch(() => null);
        const ourHit = (p.proxyPublished ?? []).find((h) => h.prefix === parsed.proxy.prefix) ?? null;
        if (liveHit && !sameRoute(liveHit, ourHit) && !sameRoute(liveHit, parsed.proxy)) {
          return c.json({ error: `proxy prefix "${parsed.proxy.prefix}" is already live on the proxy (${routeDesc(liveHit)}) and was not published by this project — pick another prefix, or withdraw that route by hand first. Disabling, narrowing proxy.public or clearing the config is always allowed` }, 409);
        }
      }
      set.proxy = parsed.proxy;
      proxyChange = { after: parsed.proxy };
    }
  }
  if (Object.keys(set).length === 0 && Object.keys(unset).length === 0) {
    return c.json({ error: 'nothing to update (charter, slackChannel, pipeline, agents, proxy)' }, 400);
  }
  await Projects.updateOne({ _id: p._id }, {
    ...(Object.keys(set).length ? { $set: set } : {}),
    ...(Object.keys(unset).length ? { $unset: unset } : {}),
  });
  const laneNote = pipeline ? `: lanes [${pipeline.reviews.map((r) => r.lane).join(', ')}], autoAdvance ${pipeline.autoAdvance}` : '';
  const agentNote = agents ? `: agents [${agents.map((a) => a.name).join(', ')}]` : '';
  await logEvent(p._id!, `project updated (${[...Object.keys(set), ...Object.keys(unset)].join(', ')})${laneNote}${agentNote}`);
  // the server owns the route table, so the proxy is updated from the doc that was just written.
  // What gets WITHDRAWN comes from proxyPublished (what is actually live) rather than from the old
  // config, so clearing the config never destroys the record of the prefix still to withdraw.
  if (proxyChange) await reconcileProxy(p._id!, p.proxyPublished ?? [], proxyChange.after);
  // soft consistency: pipeline managers should exist in the registry (when one exists) — warn, never fail.
  // The write is already committed, so a logging failure must not turn a successful PATCH into a 500.
  if (pipeline || agents) {
    try {
      const effPipeline = pipeline ?? p.pipeline;
      const effAgents = agents ?? p.agents;
      if (effAgents !== undefined && effPipeline) {
        const names = new Set(effAgents.map((a) => a.name));
        for (const r of effPipeline.reviews) {
          if (!names.has(r.manager)) await logEvent(p._id!, `pipeline manager ${r.manager} not in agent registry`);
        }
      }
    } catch {
      // warn-only check: swallow so the committed update still returns 200
    }
  }
  return c.json(await Projects.findOne({ _id: p._id }));
});

api.get('/projects/:ref/context', async (c) => {
  const p = await resolveProject(c.req.param('ref'));
  if (!p) return c.json({ error: 'project not found' }, 404);
  return c.json({ name: p.name, prefix: p.prefix, repos: p.repos, charter: p.charter, stakeholders: p.stakeholders, agents: p.agents ?? [], proxy: p.proxy ?? null });
});

api.get('/projects/:ref/events', async (c) => {
  const p = await resolveProject(c.req.param('ref'));
  if (!p) return c.json({ error: 'project not found' }, 404);
  const limit = Math.min(Math.max(Number(c.req.query('limit')) || 20, 1), 50);
  return c.json(await Events.find({ projectId: p._id }).sort({ at: -1 }).limit(limit).toArray());
});

// ---------- board (capability URL) ----------

api.get('/p/:capId', async (c) => {
  const p = await Projects.findOne({ capId: c.req.param('capId') });
  if (!p) return c.json({ error: 'not found' }, 404);
  const [tasks, feedback, events] = await Promise.all([
    Tasks.find({ projectId: p._id }).sort({ createdAt: 1 }).toArray(),
    Feedback.find({ projectId: p._id }).sort({ createdAt: -1 }).toArray(),
    Events.find({ projectId: p._id }).sort({ at: -1 }).limit(config.eventsBoardLimit).toArray(),
  ]);
  // This endpoint IS on the proxy's public allowlist, so everything here is readable by anyone
  // holding a board link. proxy.target is the internal host:port being exposed — the one field a
  // link-holder must not learn — so it is dropped and flagged (FB-89). prefix/public/enabled stay:
  // disclosing WHAT is exposed is the whole point of the panel. The full config, target included,
  // is on /projects/:ref/context, which is local-only.
  const proxy = p.proxy ? { prefix: p.proxy.prefix, public: p.proxy.public, enabled: p.proxy.enabled, targetRedacted: true } : null;
  // proxyPublished is what the server reports it actually PUT in the route table and has not
  // withdrawn — the only fact on this payload that can contradict the config, and therefore the only
  // thing that lets the panel say "configured off, route still live" instead of a confident wrong
  // "nothing shared" (FB-95/FB-102). It was being read by the board and never sent, which made every
  // fail-open state on that surface unreachable. Same redaction as above: prefix and allowlist are
  // the boundary and belong on the board; the internal host:port never leaves the machine.
  const published = (p.proxyPublished ?? [])
    .filter((r) => r && typeof r.prefix === 'string')
    .map((r) => ({ prefix: r.prefix, public: Array.isArray(r.public) ? r.public : [], targetRedacted: true }));
  // charter sliced to 401: board shows a ~400-char preview and needs the +1 to know it truncated
  // baseUrl rides along so the board can state the shared link exactly as a stakeholder receives it
  return c.json({ project: { name: p.name, prefix: p.prefix, repos: p.repos, stakeholders: p.stakeholders, pipeline: p.pipeline ?? null, agents: p.agents ?? [], proxy, proxyPublished: published, baseUrl: config.baseUrl, charter: (p.charter ?? '').slice(0, 401) }, tasks, feedback, events });
});

api.get('/p/:capId/stream', async (c) => {
  const key = c.req.param('capId');
  const exists = await Projects.findOne({ capId: key }, { projection: { _id: 1 } });
  if (!exists) return c.json({ error: 'not found' }, 404);
  return streamSSE(c, async (stream) => {
    let open = true;
    const off = subscribe(key, {
      send: (data) => { stream.writeSSE({ data }).catch(() => { off(); open = false; }); },
    });
    stream.onAbort(() => { off(); open = false; });
    while (open) {
      await stream.writeSSE({ event: 'ping', data: 'keepalive' }).catch(() => { off(); open = false; });
      await stream.sleep(config.sseKeepaliveMs);
    }
  });
});

// ---------- tasks ----------

api.post('/tasks', async (c) => {
  const b = await readBody(c);
  if (!b) return c.json({ error: 'invalid json body' }, 400);
  const title = str(b.title);
  if (!title) return c.json({ error: 'title (string) required' }, 400);
  const status = (str(b.status) ?? 'todo') as TaskStatus;
  if (!TASK_STATUSES.includes(status)) return c.json({ error: `bad status; use ${TASK_STATUSES.join('|')}` }, 400);
  const type = (str(b.type) ?? 'feature') as TaskType;
  if (!TASK_TYPES.includes(type)) return c.json({ error: `bad type; use ${TASK_TYPES.join('|')}` }, 400);
  const p = await resolveProject(str(b.project) ?? '');
  if (!p) return c.json({ error: 'project not found' }, 404);
  let parentTaskId: ObjectId | null = null;
  if (str(b.parentTaskRef)) {
    const parent = await resolveTaskRef(str(b.parentTaskRef)!);
    if (!parent) return c.json({ error: `parent ${b.parentTaskRef} not found` }, 404);
    parentTaskId = parent._id!;
  }
  if (lanesShapeBad(b.lanes)) return c.json({ error: LANES_SHAPE_ERROR }, 400);
  const lanes = lanesArr(b.lanes) ?? null;
  if (lanes) {
    const laneErr = laneError(p, lanes);
    if (laneErr) return c.json({ error: laneErr }, 400);
  }
  const doc: Task = {
    projectId: p._id!,
    shortId: await nextShortId(p._id!, 'task'),
    parentTaskId,
    title,
    description: str(b.description) ?? '',
    status,
    type,
    lane: strOrNull(b.lane) ?? null,
    lanes,
    assignee: strOrNull(b.assignee) ?? null,
    assigneeType: b.assigneeType === 'human' ? 'human' : 'agent',
    origin: strOrNull(b.origin) ?? null,
    commits: [],
    blocker: null,
    notes: str(b.notes) ?? '',
    dispatchedAt: null, // filing a task is not dispatching it; only the dispatch PATCH stamps this
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  await Tasks.insertOne(doc);
  await logEvent(p._id!, `${doc.shortId} created: ${doc.title}`, doc._id);
  return c.json(doc);
});

// my_tasks and lane views: filter by assignee/project/status, open=true for not-closed
api.get('/tasks', async (c) => {
  const q: Record<string, unknown> = {};
  const assignee = c.req.query('assignee'); if (assignee) q.assignee = assignee;
  const lane = c.req.query('lane'); if (lane) q.lane = lane;
  const status = c.req.query('status');
  if (status) q.status = { $in: status.split(',').filter((s) => TASK_STATUSES.includes(s as TaskStatus)) };
  else if (c.req.query('open') === 'true') q.status = { $nin: CLOSED };
  const ref = c.req.query('project');
  if (ref) {
    const p = await resolveProject(ref);
    if (!p) return c.json({ error: 'project not found' }, 404);
    q.projectId = p._id;
  }
  return c.json(await Tasks.find(q as never).sort({ updatedAt: -1 }).limit(200).toArray());
});

api.get('/tasks/:ref', async (c) => {
  const t = await resolveTaskRef(c.req.param('ref'));
  if (!t) return c.json({ error: 'task not found' }, 404);
  return c.json(t);
});

api.patch('/tasks/:ref', async (c) => {
  const t = await resolveTaskRef(c.req.param('ref'));
  if (!t) return c.json({ error: 'task not found' }, 404);
  const b = await readBody(c);
  if (!b) return c.json({ error: 'invalid json body' }, 400);
  if (b.status !== undefined && !TASK_STATUSES.includes(b.status as TaskStatus)) {
    return c.json({ error: `bad status; use ${TASK_STATUSES.join('|')}` }, 400);
  }
  if (b.type !== undefined && !TASK_TYPES.includes(b.type as TaskType)) {
    return c.json({ error: `bad type; use ${TASK_TYPES.join('|')}` }, 400);
  }
  const set: Record<string, unknown> = {};
  for (const k of ['title', 'description', 'status', 'notes', 'type'] as const) {
    const v = str(b[k]); if (v !== undefined) set[k] = v;
  }
  for (const k of ['assignee', 'blocker', 'lane'] as const) {
    const v = strOrNull(b[k]); if (v !== undefined) set[k] = v;
  }
  if (b.assigneeType === 'human' || b.assigneeType === 'agent') set.assigneeType = b.assigneeType;
  // dispatch: a boolean verb, never a caller-supplied time. The server owns the clock so the stamp
  // and the age the board reads off it cannot disagree, and a garbage value is a 400 rather than an
  // Invalid Date on the card. false clears (dispatch abandoned, dead builder written off).
  if (b.dispatched !== undefined) {
    if (typeof b.dispatched !== 'boolean') {
      return c.json({ error: 'dispatched must be true (stamp now) or false (clear); the server sets the time' }, 400);
    }
    set.dispatchedAt = b.dispatched ? new Date() : null;
  }
  // lanes freeze once the review flow starts: reviews already spawned (or closed) from the old selection
  if (lanesShapeBad(b.lanes)) return c.json({ error: LANES_SHAPE_ERROR }, 400);
  const lanes = lanesArr(b.lanes);
  if (lanes !== undefined) {
    if ((['in_review', 'qa', 'done', 'cancelled'] as TaskStatus[]).includes(t.status)) {
      return c.json({ error: `${t.shortId} is ${t.status}; lanes are frozen once the review flow starts` }, 409);
    }
    if (await Tasks.countDocuments({ parentTaskId: t._id, type: 'review' })) {
      return c.json({ error: `${t.shortId} already has review children; lanes cannot change` }, 409);
    }
    if (lanes) {
      const p = await Projects.findOne({ _id: t.projectId }, { projection: { pipeline: 1 } });
      const laneErr = laneError(p, lanes);
      if (laneErr) return c.json({ error: laneErr }, 400);
    }
    set.lanes = lanes;
  }
  // any status change is the assignee reporting for itself, which retires the dispatch fact: the row
  // has moved on, and a stamp left behind would claim a fresh hand-off if the task ever came back to
  // todo. An explicit `dispatched` in the same body wins — that is a re-dispatch, not a leftover.
  if (set.status !== undefined && set.status !== t.status && t.dispatchedAt && b.dispatched === undefined) {
    set.dispatchedAt = null;
  }
  const addCommit = str(b.addCommit);
  if (Object.keys(set).length === 0 && !addCommit) return c.json(t); // nothing to do, no noise event

  // done-gate: a dev task cannot close over the heads of its open review lanes or open feedback
  if (set.status === 'done' && t.type !== 'review') {
    const open = await openReviewCount(t._id!);
    if (open) return c.json({ error: `${t.shortId} has ${open} open review subtask(s); close them (or cancel them) first` }, 409);
    const fbIds = await openFeedbackShortIds(t._id!);
    if (fbIds.length) return c.json({ error: `${t.shortId} has ${fbIds.length} open feedback row(s) (${fbIds.join(', ')}); resolve or reject them first` }, 409);
  }

  set.updatedAt = new Date();
  const update: { $set: Record<string, unknown>; $push?: { commits: string } } = { $set: set };
  if (addCommit) update.$push = { commits: addCommit };
  await Tasks.updateOne({ _id: t._id }, update);
  const changed = Object.keys(set).filter((k) => k !== 'updatedAt').concat(addCommit ? ['commit'] : []).join(', ');
  await logEvent(t.projectId, `${t.shortId} updated (${changed})${set.status ? ` → ${set.status}` : ''}`, t._id);

  const after = await Tasks.findOne({ _id: t._id });
  // pipeline hooks fire on the transition, not the state: entering review spawns lanes,
  // closing the last review lane advances (or announces) the parent
  if (after && set.status === 'in_review' && t.status !== 'in_review' && t.type !== 'review') await spawnReviews(after);
  if (t.type === 'review' && CLOSED.includes(set.status as TaskStatus) && t.parentTaskId) await maybeAdvanceParent(t.parentTaskId);
  if (after && set.status === 'done') await resolvePromotedFeedback(after);
  return c.json(after);
});

// ---------- feedback ----------

api.post('/feedback', async (c) => {
  const b = await readBody(c);
  if (!b) return c.json({ error: 'invalid json body' }, 400);
  const task = str(b.taskRef) ? await resolveTaskRef(str(b.taskRef)!) : null;
  const p = task
    ? await Projects.findOne({ _id: task.projectId })
    : await resolveProject(str(b.project) ?? '');
  if (!p) return c.json({ error: 'need taskRef or project' }, 404);
  const slack = b.slack && typeof b.slack === 'object' ? (b.slack as Record<string, unknown>) : null;
  const type = str(b.type) ?? 'bug';
  const doc: FeedbackDoc = {
    projectId: p._id!,
    taskId: task?._id ?? null,
    taskShortId: task?.shortId ?? null,
    shortId: await nextShortId(p._id!, 'feedback'),
    author: str(b.author) ?? 'unknown',
    authorType: b.authorType === 'agent' ? 'agent' : 'human',
    type: (FEEDBACK_TYPES.includes(type) ? type : 'bug') as FeedbackDoc['type'],
    body: str(b.body) ?? '',
    attachments: strArr(b.attachments),
    slack: slack && str(slack.channel) && str(slack.ts)
      ? { channel: slack.channel as string, ts: slack.ts as string, user: str(slack.user) ?? '' }
      : null,
    status: 'pending',
    resolution: null,
    resolvedTaskId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  await Feedback.insertOne(doc);
  await logEvent(p._id!, `${doc.shortId} filed by ${doc.author}${doc.taskShortId ? ` on ${doc.taskShortId}` : ''}: ${doc.body.slice(0, 80)}`, doc.taskId);
  return c.json({ ...doc, boardUrl: `${config.baseUrl}/p/${p.capId}` });
});

api.get('/feedback/pending', async (c) => {
  const q: Record<string, unknown> = { status: { $in: ['pending', 'needs_clarification'] } };
  const ref = c.req.query('project');
  if (ref) {
    const p = await resolveProject(ref);
    if (!p) return c.json({ error: 'project not found' }, 404);
    q.projectId = p._id;
  }
  return c.json(await Feedback.find(q as never).sort({ createdAt: 1 }).toArray());
});

// thread-root lookup for the bot's reopen flow: ANY status, not just pending
api.get('/feedback/by-slack', async (c) => {
  const channel = c.req.query('channel'), ts = c.req.query('ts');
  if (!channel || !ts) return c.json({ error: 'channel and ts required' }, 400);
  const fb = await Feedback.findOne({ 'slack.channel': channel, 'slack.ts': ts });
  if (!fb) return c.json({ error: 'not found' }, 404);
  return c.json(fb);
});

// param route stays registered AFTER the static /feedback/pending and /feedback/by-slack
api.get('/feedback/:shortId', async (c) => {
  const fb = await Feedback.findOne({ shortId: c.req.param('shortId').toUpperCase() });
  if (!fb) return c.json({ error: 'feedback not found' }, 404);
  return c.json(fb);
});

api.patch('/feedback/:shortId', async (c) => {
  const fb = await Feedback.findOne({ shortId: c.req.param('shortId').toUpperCase() });
  if (!fb) return c.json({ error: 'feedback not found' }, 404);
  const b = await readBody(c);
  if (!b) return c.json({ error: 'invalid json body' }, 400);
  if (b.status !== undefined && !FEEDBACK_STATUSES.includes(b.status as FeedbackStatus)) {
    return c.json({ error: `bad status; use ${FEEDBACK_STATUSES.join('|')}` }, 400);
  }
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (str(b.status)) set.status = b.status;
  const resolution = strOrNull(b.resolution); if (resolution !== undefined) set.resolution = resolution;
  const type = str(b.type); if (type && FEEDBACK_TYPES.includes(type)) set.type = type;
  if (str(b.resolvedTaskRef)) {
    const t = await resolveTaskRef(str(b.resolvedTaskRef)!);
    if (t) {
      set.resolvedTaskId = t._id; set.resolvedTaskShortId = t.shortId;
      // promotion IS triage: a pending row promoted without an explicit status must not stay pending
      if (fb.status === 'pending' && !str(b.status)) set.status = 'triaged';
    }
  }
  await Feedback.updateOne({ _id: fb._id }, { $set: set });
  const statusNote = str(b.status) ?? (set.status === 'triaged' ? 'triaged (auto: promoted)' : 'updated');
  await logEvent(fb.projectId, `${fb.shortId} → ${statusNote}${resolution ? `: ${resolution}` : ''}`, fb.taskId);

  // every terminal state (and clarification) replies in the original thread; nothing dies silently
  if (b.status === 'resolved') await slackThreadReply(fb, `*${fb.shortId} resolved.* ${resolution ?? ''}`.trim());
  if (b.status === 'rejected') await slackThreadReply(fb, `*${fb.shortId} not actioned:* ${resolution ?? 'no reason given (that is a bug, flag it)'}`);
  if (b.status === 'needs_clarification') await slackThreadReply(fb, `*${fb.shortId}:* quick question, ${resolution ?? 'can you add detail?'}`);

  // a parent held in_review only by this feedback closes itself once the last blocking row resolves
  if ((b.status === 'resolved' || b.status === 'rejected') && fb.taskId) await maybeAdvanceParent(fb.taskId);
  return c.json(await Feedback.findOne({ _id: fb._id }));
});

// ---------- events ----------

api.post('/events', async (c) => {
  const b = await readBody(c);
  if (!b) return c.json({ error: 'invalid json body' }, 400);
  const p = await resolveProject(str(b.project) ?? '');
  if (!p) return c.json({ error: 'project not found' }, 404);
  const task = str(b.taskRef) ? await resolveTaskRef(str(b.taskRef)!) : null;
  await logEvent(p._id!, str(b.text) ?? '', task?._id ?? null);
  return c.json({ ok: true });
});
