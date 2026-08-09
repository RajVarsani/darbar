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
import type { Subprocess } from 'bun';

const SRC = new URL('./proxy.ts', import.meta.url).pathname;
const RIG = new URL('../../../data/.proxy-test-rig/', import.meta.url).pathname; // repo data/, gitignored
const PROXY_DIR = `${RIG}a/b/c`; // three deep: proxy.ts reads ../../../data/routes.json from here
const TUNNELED = { 'x-forwarded-host': 'test.ngrok.app' }; // what ngrok sets; the public/local switch

let proxyPort = 0;
let upPort = 0;
let proc: Subprocess | null = null;
let upstream: ReturnType<typeof Bun.serve> | null = null;

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

beforeAll(async () => {
  [upPort, proxyPort] = freePorts(2) as [number, number];

  upstream = Bun.serve({
    port: upPort,
    hostname: '127.0.0.1',
    fetch(req, server) {
      const u = new URL(req.url);
      if ((req.headers.get('upgrade') ?? '').toLowerCase().includes('websocket')) {
        return server.upgrade(req, { data: { path: u.pathname } }) ? undefined : new Response('no', { status: 400 });
      }
      return new Response(`served ${resolveLikeStaticServer(u.pathname)}`);
    },
    websocket: { open(ws) { ws.send(`served ${resolveLikeStaticServer((ws.data as { path: string }).path)}`); }, message() {} },
  });

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
