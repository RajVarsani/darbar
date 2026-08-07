import { Hono } from 'hono';
import { api } from './api';
import { initDb } from './db';

const app = new Hono();

app.route('/api', api);

// capability-URL board page (static shell; data comes from /api/p/:capId)
const boardPath = new URL('../web/board.html', import.meta.url).pathname;
app.get('/p/:capId', async (c) => c.html(await Bun.file(boardPath).text()));

// screenshots pulled from Slack live here
app.get('/files/:name', async (c) => {
  const name = c.req.param('name').replace(/[^a-zA-Z0-9._-]/g, '');
  const f = Bun.file(new URL(`../data/files/${name}`, import.meta.url).pathname);
  if (!(await f.exists())) return c.text('not found', 404);
  return new Response(f);
});

app.get('/', (c) => c.text('mission-control up. Boards are at /p/<capId>.'));

await initDb();
const port = Number(process.env.PORT || 4899);
console.log(`mission-control listening on :${port}`);

export default { port, fetch: app.fetch, idleTimeout: 120 };
