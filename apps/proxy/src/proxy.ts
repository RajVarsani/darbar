// Dynamic reverse proxy — the single front door for everything shared outside.
// ngrok (permanent domain) forwards to this; local services stay loopback-only behind it.
//
// Routing:  /<prefix>/... -> prefixes[prefix].target (prefix stripped)
//           anything else -> routes.default.target
// Public policy: requests arriving THROUGH the tunnel (x-forwarded-host set by ngrok)
//   are only allowed onto paths matching the route's `public` list. Those are PATH PATTERNS,
//   not regexes (see PATH_PATTERN_FORM in @darbar/core) — matched with string operations, so no
//   pattern anyone can write is able to hang this event loop. A tunneled path carrying an ENCODED
//   separator (%2f/%5c) is refused outright — see hasEncodedSeparator. Local requests bypass the
//   policy. Admin endpoints are never reachable from outside.
// WebSockets: upgrade requests take the same route + public policy path, then the
//   upstream socket is connected BEFORE the client handshake completes and frames are
//   pumped both ways (fetch() cannot upgrade). This keeps Vite HMR alive through the
//   tunnel, and both directions are capped in bytes — see the bridge section.
// Routes live in data/routes.json (gitignored) and hot-reload on change.
import { config, compilePublic, matchPathPattern, PATH_PATTERN_FORM } from '@darbar/core';
import type { PathPattern } from '@darbar/core';
import type { Server, ServerWebSocket, WebSocketHandler } from 'bun';

type Route = { target: string; public: string[] };
type Routes = { default: Route; prefixes: Record<string, Route> };
// the same table with every `public` list compiled to matchers, built once per reload rather than
// per request (the old regex allowed() recompiled every pattern on every tunneled request)
type Compiled = { default: PathPattern[]; prefixes: Record<string, PathPattern[]> };

const ROUTES_PATH = new URL('../../../data/routes.json', import.meta.url).pathname;
const DEFAULT_ROUTES: Routes = {
  default: { target: `http://127.0.0.1:${config.port}`, public: ['/p/', '/api/p/', '/files/'] },
  prefixes: {},
};

// routes.json is on-disk state written before the pattern language existed, and it hot-reloads, so
// every read migrates. A rejected entry is DROPPED (fail closed) and named loudly — once per reload,
// not per request, because this only runs when the mtime moves.
function compile(r: Routes): Compiled {
  const reject = (where: string) => (src: string, why: string) =>
    console.error(`routes.json: ${where} public pattern ${JSON.stringify(src)} REJECTED — it ${why}. It is not being served; nothing else on that route changed.`);
  const prefixes: Record<string, PathPattern[]> = {};
  for (const [k, v] of Object.entries(r.prefixes ?? {})) prefixes[k] = compilePublic(v?.public, reject(`/${k}/`));
  return { default: compilePublic(r.default?.public, reject('default')), prefixes };
}

let cache: { routes: Routes; pub: Compiled; mtime: number } =
  { routes: DEFAULT_ROUTES, pub: compile(DEFAULT_ROUTES), mtime: -1 };
async function routes(): Promise<Routes> {
  const f = Bun.file(ROUTES_PATH);
  if (!(await f.exists())) {
    await Bun.write(ROUTES_PATH, JSON.stringify(DEFAULT_ROUTES, null, 2));
  }
  const mtime = f.lastModified;
  if (mtime !== cache.mtime) {
    try {
      const next = (await f.json()) as Routes;
      cache = { routes: next, pub: compile(next), mtime };
    } catch {
      console.error('routes.json invalid, keeping previous routes');
      cache.mtime = mtime;
    }
  }
  return cache.routes;
}
async function saveRoutes(r: Routes) {
  await Bun.write(ROUTES_PATH, JSON.stringify(r, null, 2));
  cache = { routes: r, pub: compile(r), mtime: Bun.file(ROUTES_PATH).lastModified };
}

// `host` is NOT hop-by-hop; dropping it is a deliberate choice that disables the
// upstream's allowedHosts check (see README). Don't "fix" the list.
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer', 'upgrade', 'proxy-authorization', 'proxy-authenticate', 'host']);

function isPublic(req: Request): boolean {
  return req.headers.has('x-forwarded-host'); // set by ngrok on every tunneled request
}
// String ops only — no RegExp anywhere on this path, so no pattern can hang the front door. An empty
// list (nothing configured, or every entry rejected at load) matches nothing, which is the point.
function allowed(pats: PathPattern[], path: string): boolean {
  for (const p of pats) if (matchPathPattern(p, path)) return true;
  return false;
}
// The allowlist is only a boundary while OUR view of the path and the UPSTREAM's agree. WHATWG URL
// resolves dot-segments for us, literal and %2e%2e alike, before allowed() ever sees them — but it
// does NOT decode %2f/%5c, and the path is forwarded VERBATIM. Every dev server this feature exists
// to publish (Vite/sirv, express-static, starlette) decodes BEFORE resolving '..', so
// /assets/..%2fsecret matches an "/assets/" prefix here and lands on /secret there (measured: also
// ..%2F..%2Fetc%2Fpasswd, and %5c on the same trick). Refusing it fails closed and leaves forwarding
// semantics untouched — the alternative, decoding and re-normalising before matching, only works if
// the normalised path is also what gets forwarded, and the two views drift apart again the moment
// they aren't. Cost, accepted: a tunneled request carrying a legitimately encoded slash inside a
// path segment is refused too. Local requests are not filtered, here or anywhere.
function hasEncodedSeparator(pathname: string): boolean {
  const p = pathname.toLowerCase(); // string ops only, like allowed() — nothing here can backtrack
  return p.includes('%2f') || p.includes('%5c');
}

async function admin(req: Request, url: URL): Promise<Response> {
  if (isPublic(req)) return new Response('not found', { status: 404 }); // invisible from outside
  const auth = req.headers.get('authorization') ?? '';
  if (!config.proxyAdminToken || auth !== `Bearer ${config.proxyAdminToken}`) {
    return Response.json({ error: 'admin token required (PROXY_ADMIN_TOKEN)' }, { status: 401 });
  }
  const r = await routes();
  if (url.pathname === '/-/routes' && req.method === 'GET') return Response.json(r);
  if (url.pathname === '/-/routes' && req.method === 'PUT') {
    const body = await req.json().catch(() => null) as Routes | null;
    if (!body?.default?.target) return Response.json({ error: 'need {default:{target,public[]},prefixes:{}}' }, { status: 400 });
    await saveRoutes(body);
    return Response.json(await routes());
  }
  if (url.pathname === '/-/route' && req.method === 'POST') {
    const b = await req.json().catch(() => null) as { prefix?: string; target?: string; public?: string[] } | null;
    if (!b?.target) return Response.json({ error: `target required; prefix optional (omit = set default); public[] is ${PATH_PATTERN_FORM}, and omitting it exposes NOTHING through the tunnel` }, { status: 400 });
    // absent public used to default to ['^/'] — the whole app. An omitted allowlist must never mean
    // match-everything on a publicly reachable front door: the safe reading of "unspecified" is none.
    const pub = Array.isArray(b.public) ? b.public : [];
    if (!Array.isArray(b.public)) console.log(`route ${b.prefix ? `/${b.prefix}/` : 'default'} set with no public[] — nothing on it is reachable through the tunnel`);
    if (b.prefix) r.prefixes[b.prefix] = { target: b.target, public: pub };
    else r.default = { target: b.target, public: pub };
    await saveRoutes(r);
    return Response.json(r);
  }
  const del = url.pathname.match(/^\/-\/route\/([A-Za-z0-9_-]+)$/);
  if (del && req.method === 'DELETE') {
    delete r.prefixes[del[1]!];
    await saveRoutes(r);
    return Response.json(r);
  }
  return Response.json({ error: 'GET/PUT /-/routes · POST /-/route · DELETE /-/route/:prefix' }, { status: 404 });
}

// ── websocket bridge ────────────────────────────────────────────────────────
// Upstream FIRST, then upgrade. The client's 101 is only sent once the upstream socket
// is really open, which buys three things: the 101 means the tunnel works instead of
// meaning we accepted; the subprotocol on it is the one the UPSTREAM negotiated rather
// than an echo of the client's first offer; and there is no pre-OPEN frame queue to
// grow. Cost: the client handshake now waits on the upstream one, bounded by WS_CONNECT_MS.
//
// Everything below is bounded in bytes. An unbounded proxy buffer is an OOM of the one
// process every share, board and /files sits behind, and it is reachable unauthenticated
// (a cross-origin `new WebSocket('ws://127.0.0.1:4800/<prefix>/x')` from any page the
// developer visits needs no preflight, and the public policy only applies to tunneled
// requests). Measured pre-fix: one socket pushing 1 GB through an upstream that had
// stopped reading took the proxy from 30 MB to 1.2 GB RSS; at full speed it was killed.
const WS_CONNECT_MS = 8_000;              // upstream handshake deadline. Loopback handshakes
  // are sub-millisecond unless the dev server is blocked mid-rebuild, which 8s covers. Before
  // this there was no deadline at all: idleTimeout only fires on an IDLE socket, so a half-open
  // bridge with a busy client could sit there for the full 16 minutes, buffering.
const WS_MAX_BUFFERED = 8 * 1024 * 1024;  // upstream -> client, real buffered bytes. HMR frames
  // are KBs, so 8 MiB absorbs a burst and a second of a blocked event loop (a Vite rebuild)
  // without killing a healthy socket, while bounding a socket to ~8 MiB instead of all of RAM.
const WS_MAX_UNACKED = 16 * 1024 * 1024;  // client -> upstream, bytes IN FLIGHT per pong RTT (below).
  // Not an upstream health check and not a rate limit: it is also reached by a client that hands the
  // proxy more than this in ONE event-loop turn, before any pong can possibly land, however healthy
  // the upstream is. Measured cliff: a 16 MiB single burst survives and 20 MiB does not; 100 MB/s
  // sustained survives (a healthy upstream peaked at 1.9 MB unacked, a slower one at 4.8 MB) and
  // 200 MB/s does not. That is the real headroom — several times the worst SUSTAINED case seen, and
  // three orders of magnitude below the 1.2 GB this used to reach, but only one turn of burst.
const WS_PROBE_BYTES = 1024 * 1024;       // ping the upstream after this much unacked traffic

type WsData = {
  up: WebSocket;
  target: string;                       // upstream URL — logs only, never sent to a viewer
  client: ServerWebSocket<WsData> | null;
  pending: (string | ArrayBuffer)[];    // upstream frames that land before the client socket
  pendingBytes: number;                 //   exists (microseconds, but a greeting frame fits)
  unacked: number;                      // bytes handed to the upstream since its last pong
  probeBytes: number;                   // unacked at the moment we pinged; 0 = no probe out
  dead: boolean;                        // teardown started on either side
};
const OPEN = 1;
// 1005/1006 and the unassigned ranges can't go back out on the wire.
const sendable = (c: number) =>
  (c >= 1000 && c <= 1003) || (c >= 1007 && c <= 1013) || (c >= 3000 && c <= 4999) ? c : 1000;
// WIRE bytes, which is what the budgets below are denominated in. String.length counts UTF-16 units,
// so a UTF-8 payload was undercounted by up to 3x: measured, a text flood tripped the 16 MiB budget
// only after 51 MiB of real bytes, taking one socket from 66 MB to 192 MB RSS.
const sizeOf = (m: unknown): number =>
  typeof m === 'string' ? Buffer.byteLength(m, 'utf8') : ((m as ArrayBufferView | ArrayBuffer | null)?.byteLength ?? 0);

function teardown(d: WsData, code: number, reason: string) {
  if (d.dead) return;
  d.dead = true;
  d.pending.length = 0;
  try { d.client?.close(sendable(code), reason.slice(0, 123)); } catch {}
  try { if (d.up.readyState <= OPEN) d.up.close(); } catch {}
}

// Connects the upstream socket and waits for its handshake. null = it never opened, which
// the caller answers with an HTTP error instead of a 101 that would immediately die.
async function openUpstream(target: string, headers: Record<string, string>, protocols?: string[]): Promise<WsData | null> {
  let up: WebSocket;
  try { up = new WebSocket(target, { headers, protocols } as any); } catch { return null; }
  up.binaryType = 'arraybuffer';
  const d: WsData = { up, target, client: null, pending: [], pendingBytes: 0, unacked: 0, probeBytes: 0, dead: false };

  up.addEventListener('pong', () => { d.unacked = Math.max(0, d.unacked - d.probeBytes); d.probeBytes = 0; });
  up.onmessage = (e) => {
    if (d.dead) return;
    const c = d.client;
    if (!c) {
      d.pendingBytes += sizeOf(e.data);
      if (d.pendingBytes > WS_MAX_BUFFERED) return teardown(d, 1011, 'upstream over budget before client open');
      d.pending.push(e.data as string | ArrayBuffer);
      return;
    }
    // upstream -> client backpressure: a fast upstream with a slow tunneled viewer buffers
    // exactly like the other direction, so it gets the same budget.
    if (c.getBufferedAmount() > WS_MAX_BUFFERED) return teardown(d, 1013, 'client cannot keep up');
    c.send(e.data as any);
  };
  up.onclose = (e) => teardown(d, e.code, e.reason || 'upstream closed');
  up.onerror = () => teardown(d, 1011, 'upstream error');

  const opened = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), WS_CONNECT_MS);
    const settle = (ok: boolean) => { clearTimeout(timer); resolve(ok); };
    up.onopen = () => settle(true);
    up.addEventListener('close', () => settle(false), { once: true });
    up.addEventListener('error', () => settle(false), { once: true });
  });
  if (!opened) { teardown(d, 1011, 'upstream handshake timeout'); return null; }
  return d;
}

const websocket: WebSocketHandler<WsData> = {
  idleTimeout: 960, // dev tunnel: don't cull an idle HMR socket every 2 minutes
  open(ws) {
    const d = ws.data;
    d.client = ws;
    if (d.dead || d.up.readyState !== OPEN) { ws.close(1011, 'upstream gone'); return; } // died during the upgrade
    for (const m of d.pending) ws.send(m as any);
    d.pending.length = 0;
    d.pendingBytes = 0;
  },
  message(ws, msg) {
    const d = ws.data;
    if (d.dead) return;
    if (d.up.readyState !== OPEN) return teardown(d, 1011, 'upstream gone');
    // Bun's CLIENT WebSocket reports bufferedAmount as 0 always (verified on 1.3.14), so
    // checking it there is a no-op. Frames are ordered on one connection, so a pong proves
    // the upstream consumed everything sent before the ping: unacked bytes are the real
    // in-flight figure. Past the budget we close rather than buffer, whichever side put the
    // bytes there: a slow upstream that has not ponged, an upstream that ignores pings entirely,
    // or a client that dumped the whole budget in one event-loop turn. The close reason says
    // exactly that instead of blaming the upstream, which is often innocent. HMR sends KBs.
    d.unacked += sizeOf(msg);
    d.up.send(msg as any);
    if (d.unacked > WS_MAX_UNACKED) {
      return teardown(d, 1008, `over the ${WS_MAX_UNACKED >> 20} MiB in-flight budget: bytes sent with no upstream pong`);
    }
    if (!d.probeBytes && d.unacked > WS_PROBE_BYTES) {
      d.probeBytes = d.unacked;
      try { (d.up as unknown as { ping(): void }).ping(); } catch {}
    }
  },
  close(ws, code, reason) { teardown(ws.data, code, reason); },
};

async function proxy(req: Request, server: Server<WsData>): Promise<Response | undefined> {
  const url = new URL(req.url);
  if (url.pathname.startsWith('/-/')) return admin(req, url);

  const r = await routes(); // refreshes `cache`, so cache.pub is this table's compiled allowlists
  let route = r.default;
  let pats = cache.pub.default;
  let path = url.pathname;
  const seg = path.split('/')[1] ?? '';
  if (seg && r.prefixes[seg]) {
    route = r.prefixes[seg]!;
    pats = cache.pub.prefixes[seg] ?? [];
    path = path.slice(seg.length + 1) || '/';
  }
  // Policy gate. Everything below is downstream of it, upgrades included, so both checks cover the
  // WebSocket path as well as the plain one — verified on both.
  if (isPublic(req)) {
    if (hasEncodedSeparator(url.pathname)) { // the RAW path: the prefix segment is inside it too
      return new Response('403 · encoded path separator', { status: 403, headers: { 'content-type': 'text/plain' } });
    }
    if (!allowed(pats, path)) {
      return new Response('403 · not shared', { status: 403, headers: { 'content-type': 'text/plain' } });
    }
  }

  // Upgrade takes the same route + public policy above; only the transport differs.
  if ((req.headers.get('upgrade') ?? '').toLowerCase().includes('websocket')) {
    const h: Record<string, string> = {};
    // sec-websocket-* is per-hop handshake state (key/version/extensions) — the
    // upstream client regenerates it; protocols are re-offered explicitly below.
    req.headers.forEach((v, k) => {
      const lk = k.toLowerCase();
      if (!HOP_BY_HOP.has(lk) && !lk.startsWith('sec-websocket-')) h[lk] = v;
    });
    const proto = req.headers.get('sec-websocket-protocol');
    const target = `${route.target.replace(/^http/, 'ws')}${path}${url.search}`;
    const data = await openUpstream(target, h, proto ? proto.split(',').map((s) => s.trim()).filter(Boolean) : undefined);
    if (!data) {
      console.error(`ws 502 · upstream ${target} did not open within ${WS_CONNECT_MS}ms`);
      return new Response(isPublic(req) ? '502 · upstream is down' : `502 · upstream ${target} did not open`, { status: 502, headers: { 'content-type': 'text/plain' } });
    }
    // Negotiation is end-to-end: the protocol on our 101 is the one the upstream chose.
    // Residual, and not fixable from here: if the upstream DECLINES every offer
    // (up.protocol === ''), Bun still echoes the client's first offer on the 101 and there
    // is no API to suppress it — an empty header value makes Bun's own client fail with 1002.
    const accepted = data.up.protocol ? { 'Sec-WebSocket-Protocol': data.up.protocol } : undefined;
    if (server.upgrade(req, { data, headers: accepted })) return undefined;
    teardown(data, 1001, 'client upgrade refused');
    return new Response('426 · websocket upgrade required', { status: 426 });
  }

  const headers = new Headers();
  req.headers.forEach((v, k) => { if (!HOP_BY_HOP.has(k.toLowerCase())) headers.set(k, v); });
  try {
    const upstream = await fetch(`${route.target}${path}${url.search}`, {
      method: req.method,
      headers,
      body: req.body,
      redirect: 'manual',
      // Propagate client disconnect. Without it the upstream request outlives the viewer
      // and keeps producing into a stream nobody reads — every board SSE view through the
      // tunnel left a permanent subscriber on the darbar server.
      signal: req.signal,
    });
    const out = new Headers();
    upstream.headers.forEach((v, k) => { if (!HOP_BY_HOP.has(k.toLowerCase())) out.set(k, v); });
    return new Response(upstream.body, { status: upstream.status, headers: out });
  } catch {
    if (req.signal.aborted) return new Response(null, { status: 499 }); // client left; nobody to answer
    // route.target is the internal host:port — the one field a link-holder must not learn
    // (api.ts strips it from the public payload for the same reason). Console, not the wire.
    console.error(`502 · upstream ${route.target}${path} is down`);
    return new Response(isPublic(req) ? '502 · upstream is down' : `502 · upstream ${route.target} is down`, { status: 502, headers: { 'content-type': 'text/plain' } });
  }
}

console.log(`proxy listening on 127.0.0.1:${config.proxyPort} (routes: ${ROUTES_PATH})`);
export default {
  port: config.proxyPort,
  hostname: '127.0.0.1', // ngrok's agent connects locally; nothing binds public
  fetch: proxy,
  websocket, // Bun only accepts server.upgrade() when a handler is declared here
  idleTimeout: config.serverIdleTimeout,
};
