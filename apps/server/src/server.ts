import { Hono } from 'hono';
import { api, reconcileAllProxies } from './api';
import { startMemoryInboxWatcher } from './memory-inbox';
import { startLinearSync } from './linear-sync';
import { initDb, config, db } from '@darbar/core';

const app = new Hono();

// DAR-250: this used to answer 200 without ever touching mongo, so when docker (and mongo
// with it) died the route stayed green while the API returned nothing — and the restart
// poll below trusts exactly this route to decide the new process is actually up, so a green
// healthz that never checked anything could authorise killing the only working server.
// A bounded ping, not a scan: `db.command({ping:1})` is the cheapest round-trip mongo
// offers. It's raced against a short local timeout rather than trusted to fail fast on its
// own — the driver's default server-selection timeout is 30s, which would turn a dead mongo
// into a healthz that hangs for 30s per poll instead of failing immediately.
const HEALTHZ_MONGO_TIMEOUT_MS = 2000;
async function pingMongo(): Promise<void> {
  await Promise.race([
    db.command({ ping: 1 }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('mongo ping timed out')), HEALTHZ_MONGO_TIMEOUT_MS)),
  ]);
}

// Restart readiness probe (docs/orchestrator-loop.md §12). Cannot answer 200 before the port
// binds below, which waits on initDb(), so a 200 here already implied DB connectivity AT
// BOOT — this adds the same proof on every poll after boot too, since mongo can die later.
// The pid header matters BECAUSE of reusePort: once two processes share the port, the
// kernel may hand a poll to either one, so "some response" alone cannot tell the caller
// the NEW process specifically is up — only a response carrying the new pid can.
app.get('/healthz', async (c) => {
  c.header('x-darbar-pid', String(process.pid));
  try {
    await pingMongo();
  } catch (e) {
    // explicit about WHICH dependency is down, not just "not ok" — this is what a human
    // (or the restart poll's caller, reading the failure) needs to not go debug the wrong thing
    return c.text(`down: mongo (${String(e)})`, 503);
  }
  return c.text('ok');
});

app.route('/api', api);

// capability-URL board page (static shell; data comes from /api/p/:capId)
const boardPath = new URL('../web/board.html', import.meta.url).pathname;
app.get('/p/:capId', async (c) => c.html(await Bun.file(boardPath).text()));

// screenshots pulled from Slack live here. Only image types render inline; anything
// else downloads, so an uploaded .html can never execute on the board origin.
const INLINE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg']);
app.get('/files/:name', async (c) => {
  const name = c.req.param('name').replace(/[^a-zA-Z0-9._-]/g, '');
  const f = Bun.file(`${config.filesDir}${name}`);
  if (!(await f.exists())) return c.text('not found', 404);
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (INLINE_EXT.has(ext)) {
    // svg can carry script: force it to download too
    if (ext === 'svg') return new Response(f, { headers: { 'content-disposition': 'attachment' } });
    return new Response(f);
  }
  return new Response(f, {
    headers: { 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename="${name}"` },
  });
});

// local-only projects index: '/' is not on the proxy's public allowlist,
// so this page 403s through the tunnel by construction
const homePath = new URL('../web/home.html', import.meta.url).pathname;
app.get('/', async (c) => c.html(await Bun.file(homePath).text()));

await initDb();
// converge the proxy route table against every project doc, in both directions. routes.json survives
// a proxy restart, so this is not about a restart losing entries — it is the only thing that repairs a
// push that failed (typically because the proxy was down when a share was changed or withdrawn).
// Fire-and-forget — the proxy may be down, and that must never keep this server from listening.
reconcileAllProxies().catch((e) => console.error(`proxy reconcile pass failed: ${String(e)}`));

// reusePort: a freshly started process can bind this same port while this one still holds
// it, so a restart never closes the port. Explicit Bun.serve, not the `export default
// {fetch,...}` shorthand, so SIGTERM below has a handle to drain. See docs/orchestrator-loop.md §12.
const server = Bun.serve({
  port: config.port,
  hostname: config.bindHost, // loopback by default; a tunnel fronts anything shared
  fetch: app.fetch,
  idleTimeout: config.serverIdleTimeout,
  reusePort: true,
});
console.log(`darbar listening on ${config.bindHost}:${config.port} (pid ${process.pid})`);

// DAR-276: drain Claude's autoMemoryDirectory drop zone into the graph. Started only after the
// port above is bound, since the drain talks to /api/memory/remember on this same server.
startMemoryInboxWatcher();

// DAR-266: mirror linear-native projects to Linear. No key = one log line and every hook a no-op.
startLinearSync();

// Bare SIGTERM with no handler kills immediately and drops in-flight requests (verified).
// server.stop() drains: stops taking new connections, finishes what's in flight, then resolves.
process.on('SIGTERM', () => {
  console.log(`darbar (pid ${process.pid}) draining on SIGTERM...`);
  server.stop().then(() => process.exit(0));
});
