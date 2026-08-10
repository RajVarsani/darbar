import { Hono } from 'hono';
import { api, reconcileAllProxies } from './api';
import { initDb, config } from '@darbar/core';

const app = new Hono();

// Restart readiness probe (docs/orchestrator-loop.md §12). Cannot answer before the port
// binds below, which waits on initDb(), so 200 here already implies DB connectivity too.
// The pid header matters BECAUSE of reusePort: once two processes share the port, the
// kernel may hand a poll to either one, so "some response" alone cannot tell the caller
// the NEW process specifically is up — only a response carrying the new pid can.
app.get('/healthz', (c) => {
  c.header('x-darbar-pid', String(process.pid));
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

// Bare SIGTERM with no handler kills immediately and drops in-flight requests (verified).
// server.stop() drains: stops taking new connections, finishes what's in flight, then resolves.
process.on('SIGTERM', () => {
  console.log(`darbar (pid ${process.pid}) draining on SIGTERM...`);
  server.stop().then(() => process.exit(0));
});
