// End-to-end tests for the front door's PUBLIC POLICY — the only auth layer in front of darbar.
//
// This is the repo's first test file: there was no suite to add these to. They are end-to-end on
// purpose. DAR-FB-109 (a narrow allowlist escapable with %2f) was a WIRING bug — the matcher was
// fine, the path it was handed was not — so a unit test on the helper would not have caught it and
// would not catch it coming back. Only a real request through a real proxy does.
//
// Isolation: proxy.ts resolves data/routes.json from its own file location, so an isolated rig means
// an isolated COPY of the source, three directories deep next to its own data/. The copy is taken at
// test time, so it cannot drift from the real thing. Everything lives under data/ (gitignored) with
// a node_modules symlink so @darbar/core resolves, ports are picked free at runtime, and the rig is
// torn down afterwards. The live proxy, its port and the real data/routes.json are never touched.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdir, rm, symlink, copyFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer, connect as netConnect, type Server as NetServer, type Socket } from 'node:net';
import type { Subprocess } from 'bun';

const SRC = new URL('./proxy.ts', import.meta.url).pathname;
const RIG = new URL('../../../data/.proxy-test-rig/', import.meta.url).pathname; // repo data/, gitignored
const PROXY_DIR = `${RIG}a/b/c`; // three deep: proxy.ts reads ../../../data/routes.json from here
const TUNNELED = { 'x-forwarded-host': 'test.ngrok.app' }; // what ngrok sets
// What zrok actually sets, measured off a live share: note the ABSENCE of x-forwarded-host, which is
// the header the public/local switch used to key off exclusively. See the DAR-252 test below.
const ZROK_TUNNELED = {
  'x-forwarded-for': '203.0.113.7, 10.32.0.47',
  'x-forwarded-proto': 'https',
  'x-forwarded-port': '443',
  'x-proxy': 'zrok',
};

// DAR-254: a JSON body shaped like the real thing (repetitive task rows), well over the 1KB floor and
// genuinely compressible — this is what the gzip tests below send and check for.
const COMPRESSIBLE_JSON = JSON.stringify({
  tasks: Array.from({ length: 50 }, (_, i) => ({
    id: `DAR-${i}`, title: 'Board costs a megabyte per tick: no gzip', status: 'todo', type: 'chore',
  })),
});

let proxyPort = 0;
let upPort = 0;
let mutePort = 0;
let proc: Subprocess | null = null;
let upstream: ReturnType<typeof Bun.serve> | null = null;
let mute: NetServer | null = null;
const muteSockets = new Set<Socket>();

// Bound all at once, then released, so two rigs can never be handed the same port.
function freePorts(n: number): number[] {
  const probes = Array.from({ length: n }, () => Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') }));
  const ports = probes.map((s) => s.port);
  for (const s of probes) s.stop(true);
  if (ports.some((p) => !p)) throw new Error('could not allocate ports for the rig');
  return ports as number[];
}

// Reports the path it was really handed, resolved the way a static dev server does it: decode FIRST,
// then collapse dot segments. That ordering is the whole bug, so the upstream has to reproduce it —
// a bypass then shows up as a 200 naming the file it reached, not just as a missing 403.
function resolveLikeStaticServer(raw: string): string {
  let p: string;
  try { p = decodeURIComponent(raw); } catch { p = raw; }
  const out: string[] = [];
  for (const seg of p.replace(/\\/g, '/').split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { out.pop(); continue; }
    out.push(seg);
  }
  return `/${out.join('/')}`;
}

// A WebSocket upstream that completes the handshake by hand and then never reads its socket again:
// no pong, ever, and no drain. That is the "upstream that ignores pings entirely" case the proxy's
// budgets name, and it is what makes in-flight bytes accumulate DETERMINISTICALLY — against the Bun
// upstream above, an automatic pong lands within a millisecond and empties the figure under test.
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
function serveMute(port: number): NetServer {
  return createServer((sock) => {
    muteSockets.add(sock);
    sock.on('error', () => {});
    sock.on('close', () => muteSockets.delete(sock));
    const onData = (chunk: Buffer) => {
      if (!chunk.toString('latin1').startsWith('GET ')) return;
      const key = /sec-websocket-key:\s*(\S+)/i.exec(chunk.toString('latin1'))?.[1] ?? '';
      const accept = createHash('sha1').update(key + WS_GUID).digest('base64');
      sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      sock.off('data', onData);
      sock.pause(); // from here the receive window fills and the proxy holds what it is handed
    };
    sock.on('data', onData);
  }).listen(port, '127.0.0.1');
}

beforeAll(async () => {
  [upPort, mutePort, proxyPort] = freePorts(3) as [number, number, number];

  upstream = Bun.serve({
    port: upPort,
    hostname: '127.0.0.1',
    fetch(req, server) {
      const u = new URL(req.url);
      if ((req.headers.get('upgrade') ?? '').toLowerCase().includes('websocket')) {
        return server.upgrade(req, { data: { path: u.pathname } }) ? undefined : new Response('no', { status: 400 });
      }
      // reports what the proxy forwarded, so the upstream's own local-only checks can be tested
      if (u.pathname === '/assets/xfh') return new Response(req.headers.get('x-forwarded-host') ?? 'ABSENT');
      // DAR-254 fixtures, below
      if (u.pathname === '/assets/json') return new Response(COMPRESSIBLE_JSON, { headers: { 'content-type': 'application/json' } });
      if (u.pathname === '/assets/small') return new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } });
      // 'identity' rather than 'gzip': see the test below for why a real gzip body here would prove
      // the wrong thing (Bun's fetch auto-decompresses gzip transparently on the proxy's way IN).
      if (u.pathname === '/assets/pre-encoded') {
        return new Response(COMPRESSIBLE_JSON, { headers: { 'content-type': 'application/json', 'content-encoding': 'identity' } });
      }
      if (u.pathname === '/assets/sse') {
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            for (let i = 0; i < 3; i++) {
              controller.enqueue(new TextEncoder().encode(`data: tick ${i}\n\n`));
              await Bun.sleep(150);
            }
            controller.close();
          },
        });
        return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
      }
      return new Response(`served ${resolveLikeStaticServer(u.pathname)}`);
    },
    // Echoes, so a socket can be shown to be still round-tripping and not merely still open.
    websocket: {
      open(ws) { ws.send(`served ${resolveLikeStaticServer((ws.data as { path: string }).path)}`); },
      message(ws, m) { ws.send(`echo ${typeof m === 'string' ? m.length : m.byteLength}`); },
    },
  });
  mute = serveMute(mutePort);

  await rm(RIG, { recursive: true, force: true });
  await mkdir(PROXY_DIR, { recursive: true });
  await mkdir(`${RIG}data`, { recursive: true });
  await symlink(new URL('../node_modules', import.meta.url).pathname, `${RIG}node_modules`);
  await copyFile(SRC, `${PROXY_DIR}/proxy.ts`);
  await writeFile(`${RIG}data/routes.json`, JSON.stringify({
    default: { target: `http://127.0.0.1:${upPort}`, public: [] },
    // the shape the finding was reproduced against: one narrow prefix, nothing else reachable
    prefixes: { pub: { target: `http://127.0.0.1:${upPort}`, public: ['/assets/'] } },
  }));

  proc = Bun.spawn(['bun', `${PROXY_DIR}/proxy.ts`], {
    env: { ...process.env, PROXY_PORT: String(proxyPort), PROXY_ADMIN_TOKEN: 'test-rig' },
    stdout: 'ignore',
    stderr: 'ignore',
  });
  for (let i = 0; i < 100; i++) {
    try { await fetch(`http://127.0.0.1:${proxyPort}/pub/assets/ready`); break; } catch { await Bun.sleep(50); }
  }
});

afterAll(async () => {
  proc?.kill();
  upstream?.stop(true);
  for (const s of muteSockets) s.destroy(); // paused sockets would otherwise outlive the server
  mute?.close();
  await rm(RIG, { recursive: true, force: true });
});

// `path` must not be normalised by fetch(): every case below is already in the form the wire carries.
async function get(path: string, headers: Record<string, string> = {}) {
  const res = await fetch(`http://127.0.0.1:${proxyPort}${path}`, { headers, redirect: 'manual' });
  return { status: res.status, body: await res.text() };
}

// Whether the UPGRADE gets through, which is the half a plain fetch cannot test: the upgrade branch
// sits downstream of the policy check, so it has to be proven separately rather than assumed.
async function upgrades(path: string, headers: Record<string, string> = {}): Promise<boolean> {
  const ws = new WebSocket(`ws://127.0.0.1:${proxyPort}${path}`, { headers } as unknown as string[]);
  // A refused upgrade closes with 1002 "Expected 101 status code"; an accepted one delivers the
  // upstream's greeting. Close only AFTER settling — closing from inside a handler races the
  // handshake and reports a clean 1000 on a socket that was about to succeed.
  const opened = await new Promise<boolean>((resolve) => {
    ws.onmessage = () => resolve(true);
    ws.onclose = () => resolve(false);
    setTimeout(() => resolve(false), 4_000);
  });
  try { ws.close(); } catch {}
  return opened;
}

test('the allowlist serves what it names and refuses what it does not', async () => {
  expect(await get('/pub/assets/app.js', TUNNELED)).toEqual({ status: 200, body: 'served /assets/app.js' });
  expect((await get('/pub/secret', TUNNELED)).status).toBe(403);
});

// DAR-FB-109. Before the fix this was 200 with the body 'served /secret': the pattern matched
// /assets/..%2fsecret here, and the upstream decoded before resolving '..' and served the root file.
test('an encoded separator cannot escape a pattern narrower than "/"', async () => {
  for (const path of [
    '/pub/assets/..%2fsecret',
    '/pub/assets/..%2Fsecret',
    '/pub/assets/..%2F..%2Fetc%2Fpasswd',
    '/pub/assets/..%5csecret',
    '/pub/assets/..%5Csecret',
    '/pu%2fb/assets/app.js', // encoded inside the ROUTING segment, before the prefix is stripped
  ]) {
    const r = await get(path, TUNNELED);
    expect({ path, ...r }).toEqual({ path, status: 403, body: '403 · encoded path separator' });
  }
});

// The other half of FB-109, already correct and easy to lose: dot segments the URL parser resolves
// for us must land on the allowlist as their resolved form, not their written one.
test('literal and %2e-encoded dot segments are resolved before the allowlist sees them', async () => {
  expect((await get('/pub/assets/../secret', TUNNELED)).status).toBe(403);
  expect((await get('/pub/%2e%2e/secret', TUNNELED)).status).toBe(403);
});

test('the upgrade path enforces the same policy as a plain request', async () => {
  expect(await upgrades('/pub/assets/app.js', TUNNELED)).toBe(true);
  expect(await upgrades('/pub/secret', TUNNELED)).toBe(false);
  expect(await upgrades('/pub/assets/..%2fsecret', TUNNELED)).toBe(false);
  expect(await upgrades('/pub/assets/..%5csecret', TUNNELED)).toBe(false);
});

// Local traffic is not behind the tunnel and has never been filtered. Fixing FB-109 by filtering
// everything would break every developer's own browser, so the local side is asserted too.
test('local requests are not filtered', async () => {
  expect(await get('/pub/secret')).toEqual({ status: 200, body: 'served /secret' });
  expect(await get('/pub/assets/..%2fsecret')).toEqual({ status: 200, body: 'served /secret' });
  expect(await upgrades('/pub/assets/..%2fsecret')).toBe(true);
});

// ── DAR-254 (first half): gzip at the proxy ────────────────────────────────────────────────────
// Bun's own fetch() sends "Accept-Encoding: gzip, deflate, br, zstd" by default and auto-decompresses
// on receipt (verified empirically against a real Bun.serve response) — so the plain `get()` helper
// above cannot exercise "a client that did not ask" or inspect real wire bytes. A raw socket is the
// only way to control exactly what goes out and see exactly what comes back, same reasoning `rawGet`
// above already uses for the Host-header tests.
// Buffer.concat()'s return generic depends on its input array's element type, which node:net's own
// 'data' event doesn't pin down — bare `Buffer` fights that inference, so everything here is typed off
// Buffer.concat's own return type instead of naming a generic by hand.
type Buf = ReturnType<typeof Buffer.concat>;
type RawResponse = { status: number; headers: Record<string, string>; body: Buf };

// Incremental, not "parse once at the end": this rig keeps the connection open regardless of the
// client's `Connection: close` (same reason `rawGet` above settles on the status line rather than
// waiting for the socket to end — confirmed by hand: a raw request here that waits for a socket 'end'
// event times out even though the full response, headers and body, already arrived). So parsing has
// to recognise "the response is complete" from content-length or the chunked terminator, on every
// 'data' event, and resolve as soon as that's true — never by waiting for the connection itself to close.
function tryDechunk(buf: Buf): { done: boolean; body: Buf } {
  const parts: Buf[] = [];
  let offset = 0;
  for (;;) {
    const lineEnd = buf.indexOf('\r\n', offset);
    if (lineEnd === -1) return { done: false, body: Buffer.alloc(0) }; // size line not fully in yet
    const size = parseInt(buf.slice(offset, lineEnd).toString('latin1').split(';')[0]!.trim(), 16);
    const dataStart = lineEnd + 2;
    if (size === 0) return { done: true, body: Buffer.concat(parts) }; // terminating chunk seen
    if (buf.length < dataStart + size + 2) return { done: false, body: Buffer.alloc(0) }; // chunk incomplete
    parts.push(buf.slice(dataStart, dataStart + size));
    offset = dataStart + size + 2; // past this chunk's trailing CRLF
  }
}

function rawRequest(path: string, headers: Record<string, string> = {}): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const sock = netConnect(proxyPort, '127.0.0.1', () => {
      const lines = Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('');
      sock.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${proxyPort}\r\nConnection: close\r\n${lines}\r\n`);
    });
    let buf: Buf = Buffer.alloc(0);
    let parsed: { status: number; headers: Record<string, string> } | null = null;
    let headerEnd = -1;
    const timer = setTimeout(() => { sock.destroy(); reject(new Error(`raw request to ${path} timed out`)); }, 5_000);
    const finish = (body: Buf) => { clearTimeout(timer); sock.destroy(); resolve({ status: parsed!.status, headers: parsed!.headers, body }); };
    sock.on('data', (d: Buf) => {
      buf = Buffer.concat([buf, d]);
      if (!parsed) {
        headerEnd = buf.indexOf('\r\n\r\n');
        if (headerEnd === -1) return; // headers not fully in yet
        const statusAndHeaders = buf.slice(0, headerEnd).toString('latin1').split('\r\n');
        const status = Number(/^HTTP\/1\.[01] (\d+)/.exec(statusAndHeaders[0]!)?.[1]);
        const respHeaders: Record<string, string> = {};
        for (const line of statusAndHeaders.slice(1)) {
          const idx = line.indexOf(':');
          if (idx === -1) continue;
          respHeaders[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
        }
        parsed = { status, headers: respHeaders };
      }
      const bodySoFar = buf.slice(headerEnd + 4);
      if ((parsed.headers['transfer-encoding'] ?? '').toLowerCase().includes('chunked')) {
        const r = tryDechunk(bodySoFar);
        if (r.done) finish(r.body);
      } else {
        const len = Number(parsed.headers['content-length'] ?? '0');
        if (bodySoFar.length >= len) finish(bodySoFar.slice(0, len));
      }
    });
    sock.on('error', reject);
  });
}

test('a compressible JSON response through the proxy is smaller and decodes to identical bytes', async () => {
  const res = await rawRequest('/pub/assets/json', { ...TUNNELED, 'accept-encoding': 'gzip' });
  expect(res.status).toBe(200);
  expect(res.headers['content-encoding']).toBe('gzip');
  expect(res.body.length).toBeLessThan(COMPRESSIBLE_JSON.length);
  // Bun.gunzipSync returns a Uint8Array, not a node Buffer — Uint8Array#toString() prints a
  // comma-separated numeric list rather than decoding, hence TextDecoder rather than .toString() here.
  expect(new TextDecoder().decode(Bun.gunzipSync(res.body))).toBe(COMPRESSIBLE_JSON);
});

test('a client with no accept-encoding gets the response uncompressed (identity)', async () => {
  const res = await rawRequest('/pub/assets/json', { ...TUNNELED }); // no accept-encoding header at all
  expect(res.status).toBe(200);
  expect(res.headers['content-encoding']).toBeUndefined();
  expect(res.body.toString()).toBe(COMPRESSIBLE_JSON);
});

// The floor: below MIN_COMPRESS_BYTES the response goes out exactly as the upstream sent it, even
// though the client asked for gzip and the content-type is compressible.
test('a tiny compressible response is left uncompressed regardless of accept-encoding', async () => {
  const res = await rawRequest('/pub/assets/small', { ...TUNNELED, 'accept-encoding': 'gzip' });
  expect(res.status).toBe(200);
  expect(res.headers['content-encoding']).toBeUndefined();
  expect(res.body.toString()).toBe('{"ok":true}');
});

test('an upstream response that already carries a content-encoding is passed through untouched', async () => {
  const res = await rawRequest('/pub/assets/pre-encoded', { ...TUNNELED, 'accept-encoding': 'gzip' });
  expect(res.status).toBe(200);
  expect(res.headers['content-encoding']).toBe('identity'); // unchanged, not overwritten to gzip
  expect(res.body.toString()).toBe(COMPRESSIBLE_JSON); // and not gzipped on top of it either
});

// The board holds an EventSource open on /api/p/:capId/stream for the life of the tab; compression
// must not turn that into "wait for the connection to close, then get everything at once." Proven by
// timing real read() calls through the live proxy process, not by inspecting source.
test('SSE is excluded from compression and still streams incrementally, not buffered whole', async () => {
  const res = await fetch(`http://127.0.0.1:${proxyPort}/pub/assets/sse`, { headers: TUNNELED });
  expect(res.status).toBe(200);
  expect(res.headers.get('content-encoding')).toBeNull();
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const arrivals: number[] = [];
  let text = '';
  const start = Date.now();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    arrivals.push(Date.now() - start);
    text += decoder.decode(value);
  }
  expect(text).toBe('data: tick 0\n\ndata: tick 1\n\ndata: tick 2\n\n');
  // A proxy that buffered the whole SSE body before forwarding would deliver one chunk at t≈450ms
  // instead of several roughly 150ms apart — more than one arrival, spread over real time, is what
  // "still streaming" means here.
  expect(arrivals.length).toBeGreaterThanOrEqual(2);
  expect(arrivals[arrivals.length - 1]! - arrivals[0]!).toBeGreaterThan(200);
}, 10_000);

// DAR-252, measured on a live share before the fix: /api/tasks answered 200 with all 862 rows through
// a zrok URL. isPublic() was `req.headers.has('x-forwarded-host')` — the one header ngrok happens to
// set — so a tunnel that forwards differently read as LOCAL and got the whole app unfiltered. The
// vulnerability is recognising tunnels one at a time, so this asserts the shapes we do not run too.
test('a tunnel that does not set x-forwarded-host is still public', async () => {
  for (const [name, headers] of [
    ['zrok, as measured', ZROK_TUNNELED],
    ['x-forwarded-for alone', { 'x-forwarded-for': '203.0.113.7' }],
    ['RFC 7239 Forwarded', { forwarded: 'for=203.0.113.7;proto=https' }],
    ['x-real-ip alone', { 'x-real-ip': '203.0.113.7' }],
  ] as const) {
    expect({ name, ...(await get('/pub/secret', headers)) }).toEqual({ name, status: 403, body: '403 · not shared' });
    expect({ name, ...(await get('/pub/assets/..%2fsecret', headers)) }).toEqual({ name, status: 403, body: '403 · encoded path separator' });
    expect({ name, upgraded: await upgrades('/pub/secret', headers) }).toEqual({ name, upgraded: false });
  }
});

// The case no forwarding header covers: a tunnel that rewrites nothing and just delivers the request
// with its original Host. Loopback is the only thing that proves a request came from this machine,
// so an unrecognised Host must fail closed on its own. fetch() will not let us set Host, so this one
// is written onto the socket by hand.
// Settles on the STATUS LINE and destroys the socket immediately, rather than waiting for the server
// to close. Waiting on 'end' hangs when the connection is kept alive, and every socket left hanging
// here is a slot the concurrent-socket test later expects to be free — the rig is shared.
function rawGet(path: string, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const sock = netConnect(proxyPort, '127.0.0.1', () => {
      sock.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
    });
    let buf = '';
    const settle = (fn: () => void) => { clearTimeout(timer); sock.destroy(); fn(); };
    const timer = setTimeout(() => settle(() => reject(new Error(`raw request to ${host} timed out`))), 5_000);
    sock.on('data', (d) => {
      buf += d.toString();
      const m = /^HTTP\/1\.[01] (\d{3})/.exec(buf);
      if (m) settle(() => resolve(Number(m[1])));
    });
    sock.on('error', (e) => settle(() => reject(e)));
  });
}

// The upstream has local-only routes (/api/parked, the inbox doorbell) that key off x-forwarded-host,
// and it CANNOT repeat the proxy's own test because `host` is hop-by-hop and every proxied request
// arrives at it looking like loopback. So the proxy states the fact instead of relying on the tunnel
// to state it — which is exactly what stopped being true when ngrok became zrok.
test('the proxy tells the upstream a request was tunneled, whatever the tunnel sets', async () => {
  const local = await get('/pub/assets/xfh');
  expect(local.body).toBe('ABSENT'); // local stays local, so local-only routes still answer

  for (const headers of [TUNNELED, ZROK_TUNNELED, { 'x-real-ip': '203.0.113.7' }]) {
    const r = await get('/pub/assets/xfh', headers);
    expect(r.status).toBe(200);
    expect(r.body).not.toBe('ABSENT'); // the upstream can tell, even from a tunnel setting nothing
  }

  // And it is OUR fact, not the caller's: a forged value is overwritten, never forwarded as given.
  const forged = await get('/pub/assets/xfh', { 'x-forwarded-host': 'evil.example' });
  expect(forged.body).not.toBe('evil.example');
});

test('an unrecognised Host is public even with no forwarding headers at all', async () => {
  expect(await rawGet('/pub/secret', 'darbar.shares.zrok.io')).toBe(403);
  expect(await rawGet('/pub/assets/app.js', 'darbar.shares.zrok.io')).toBe(200); // still serves what is shared
  // and the loopback names stay local, ports and IPv6 brackets included
  for (const host of ['localhost:4800', '127.0.0.1:4800', 'LocalHost', '[::1]:4800']) {
    expect({ host, status: await rawGet('/pub/secret', host) }).toEqual({ host, status: 200 });
  }
});

// board.html warns about a public[] entry that exposes the whole app, and the warning is only right
// if it agrees with the proxy. These are the forms in its CATCH_ALL set that the current pattern
// language can express, plus the one that looks like a catch-all and is not.
test('"/" and "/*" serve every path; "/*$" is exact and stops at a segment', async () => {
  const routes = `${RIG}data/routes.json`;
  const setPattern = async (p: string) => {
    await writeFile(routes, JSON.stringify({
      default: { target: `http://127.0.0.1:${upPort}`, public: [] },
      prefixes: { pub: { target: `http://127.0.0.1:${upPort}`, public: [p] } },
    }));
    await Bun.sleep(50); // routes.json hot-reloads on mtime
  };
  const deep = '/pub/a/b/c.js';

  await setPattern('/');
  expect((await get(deep, TUNNELED)).status).toBe(200);
  await setPattern('/*');
  expect((await get(deep, TUNNELED)).status).toBe(200);
  await setPattern('/*$');
  expect((await get(deep, TUNNELED)).status).toBe(403);
  expect((await get('/pub/top', TUNNELED)).status).toBe(200); // top level only, hence not a catch-all
});

// ── process-wide ceilings ───────────────────────────────────────────────────────────────────────
// The per-socket byte budgets predate these tests; what follows covers the two PROCESS-wide ceilings.
// Measured on this rig with only the per-socket caps in place: 50 sockets each holding 16 MiB, every
// one of them individually legal and none of them closed, took the proxy from 61 MB to 972 MB RSS.
// The three tests below need routes of their own, so they write routes.json (it hot-reloads on mtime)
// rather than depending on the shape beforeAll installed or on the test above it.
const MAX_CONNECTIONS = 64; // must match WS_MAX_CONNECTIONS in proxy.ts

async function setRoutes(prefixes: Record<string, { target: string; public: string[] }>) {
  await writeFile(`${RIG}data/routes.json`, JSON.stringify({ default: { target: `http://127.0.0.1:${upPort}`, public: [] }, prefixes }));
  await Bun.sleep(80); // hot-reloads on mtime, same as setPattern above
}

// A socket plus the close it eventually gets. The close is half of what is under test: a ceiling has
// to say what actually happened, and a previous round shipped one that closed healthy upstreams with
// the reason "upstream cannot keep up", which sent people debugging Vite.
type Tracked = { ws: WebSocket; closed: { code: number; reason: string } | null; msgs: number };
async function open(path: string): Promise<Tracked> {
  const ws = new WebSocket(`ws://127.0.0.1:${proxyPort}${path}`);
  const t: Tracked = { ws, closed: null, msgs: 0 };
  // Both listeners are attached BEFORE the handshake settles: the upstream greeting and a close that
  // races the open would otherwise land in the gap and go uncounted.
  ws.onmessage = () => { t.msgs++; };
  ws.addEventListener('close', (e) => { t.closed ??= { code: (e as CloseEvent).code, reason: (e as CloseEvent).reason }; });
  const ok = await new Promise<boolean>((res) => {
    ws.onopen = () => res(true);
    ws.addEventListener('close', () => res(false), { once: true });
    setTimeout(() => res(false), 4_000);
  });
  if (!ok) t.closed ??= { code: 0, reason: 'never opened' };
  return t;
}
const closeAll = (ts: Tracked[]) => { for (const t of ts) { try { t.ws.close(); } catch {} } };

// First of the three, deliberately: it needs every socket slot free, so it runs before the tests that
// hold dozens open.
test('at the concurrent-socket cap the newcomer is refused, with a 503 that names the proxy', async () => {
  await setRoutes({ ok: { target: `http://127.0.0.1:${upPort}`, public: ['/'] } });
  const held = await Promise.all(Array.from({ length: MAX_CONNECTIONS }, () => open('/ok/hmr')));
  expect(held.filter((t) => t.closed)).toEqual([]); // the cap is exactly this many, so none refused

  // The refusal is an HTTP answer rather than a 101 that dies a second later, so it is assertable
  // directly. Only the `upgrade` header decides which branch of the proxy answers.
  const res = await fetch(`http://127.0.0.1:${proxyPort}/ok/hmr`, { headers: { upgrade: 'websocket' } });
  const body = await res.text();
  expect({ status: res.status, body }).toEqual({
    status: 503,
    body: `503 · proxy is at its limit of ${MAX_CONNECTIONS} concurrent websockets; a proxy-wide cap, not an upstream fault`,
  });
  expect(await upgrades('/ok/hmr')).toBe(false); // and a real client gets no socket either

  // A live counter, not a high-water mark: freeing slots frees the cap.
  closeAll(held);
  let recovered = false;
  for (let i = 0; i < 20 && !recovered; i++) { await Bun.sleep(100); recovered = await upgrades('/ok/hmr'); }
  expect(recovered).toBe(true);
}, 30_000);

// The ceiling is worthless if it fires on real traffic. HMR frames are KBs, so this is the shape of
// every day: a lot of sockets moving very little each.
test('HMR-scale traffic on many sockets never reaches either ceiling', async () => {
  await setRoutes({ ok: { target: `http://127.0.0.1:${upPort}`, public: ['/'] } });
  const socks = await Promise.all(Array.from({ length: 24 }, () => open('/ok/hmr')));
  const frame = 'x'.repeat(8 * 1024); // 8 KiB, a generous single HMR update
  for (let round = 0; round < 40; round++) for (const t of socks) t.ws.send(frame);
  // 24 sockets x 320 KiB = 7.5 MiB in total, which is under HALF what ONE socket may hold in flight.
  for (let i = 0; i < 40 && !socks.every((t) => t.msgs >= 41); i++) await Bun.sleep(100);
  expect(socks.filter((t) => t.closed)).toEqual([]);
  expect(socks.every((t) => t.msgs >= 41)).toBe(true); // greeting + all 40 echoes: still round-tripping
  closeAll(socks);
});

test('the process-wide in-flight ceiling sheds the biggest holder, and says what happened', async () => {
  await setRoutes({ mute: { target: `http://127.0.0.1:${mutePort}`, public: ['/'] } });
  const CHUNK = new Uint8Array(4 * 1024 * 1024);
  const thin = await open('/mute/hmr'); // HMR-scale, and therefore never the biggest holder
  thin.ws.send(new Uint8Array(64 * 1024));

  // Each socket parks 12 MiB, inside its own 16 MiB budget, so nothing here trips the PER-SOCKET cap.
  // Grown one socket at a time until something is shed rather than sized against the constant, so the
  // test still means what it says if the budget is retuned.
  const fat: Tracked[] = [];
  let shed: { code: number; reason: string } | null = null;
  for (let i = 0; i < 30 && !shed; i++) {
    const t = await open('/mute/hmr');
    fat.push(t);
    for (let k = 0; k < 3; k++) t.ws.send(CHUNK);
    await Bun.sleep(200);
    shed = fat.find((f) => f.closed)?.closed ?? null;
  }
  expect(shed).not.toBeNull();
  expect(shed!.code).toBe(1013); // 1013 "try again later": a temporary condition on OUR side
  // Names the proxy's own budget and the socket's own share of it, and blames neither end. The 1008
  // per-socket reason ("no upstream pong") and the 1013 "client cannot keep up" would both be lies.
  expect(shed!.reason).toMatch(/^proxy-wide \d+ MiB in-flight budget exceeded; this socket held the most \(\d+ MiB\)\. Not an upstream fault\.$/);
  expect(thin.closed).toBeNull(); // the newcomer crosses the line; the biggest holder pays
  closeAll([thin, ...fat]);
}, 30_000); // measured 2.4s; the default 5s is thin margin for 30 sockets x 12 MiB
