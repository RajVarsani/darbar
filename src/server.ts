import { Hono } from 'hono';
import { api } from './api';
import { initDb } from './db';
import { config } from './config';

const app = new Hono();

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

app.get('/', (c) => c.text('houston up. Boards are at /p/<capId>.'));

await initDb();
console.log(`houston listening on ${config.bindHost}:${config.port}`);

export default {
  port: config.port,
  hostname: config.bindHost, // loopback by default; a tunnel fronts anything shared
  fetch: app.fetch,
  idleTimeout: config.serverIdleTimeout,
};
