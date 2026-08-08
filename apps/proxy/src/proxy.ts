// Dynamic reverse proxy — the single front door for everything shared outside.
// ngrok (permanent domain) forwards to this; local services stay loopback-only behind it.
//
// Routing:  /<prefix>/... -> prefixes[prefix].target (prefix stripped)
//           anything else -> routes.default.target
// Public policy: requests arriving THROUGH the tunnel (x-forwarded-host set by ngrok)
//   are only allowed onto paths matching the route's `public` regex list. Local
//   requests bypass the policy. Admin endpoints are never reachable from outside.
// Routes live in data/routes.json (gitignored) and hot-reload on change.
import { config } from '@houston/core';

type Route = { target: string; public: string[] };
type Routes = { default: Route; prefixes: Record<string, Route> };

const ROUTES_PATH = new URL('../../../data/routes.json', import.meta.url).pathname;
const DEFAULT_ROUTES: Routes = {
  default: { target: `http://127.0.0.1:${config.port}`, public: ['^/p/', '^/api/p/', '^/files/'] },
  prefixes: {},
};

let cache: { routes: Routes; mtime: number } = { routes: DEFAULT_ROUTES, mtime: -1 };
async function routes(): Promise<Routes> {
  const f = Bun.file(ROUTES_PATH);
  if (!(await f.exists())) {
    await Bun.write(ROUTES_PATH, JSON.stringify(DEFAULT_ROUTES, null, 2));
  }
  const mtime = f.lastModified;
  if (mtime !== cache.mtime) {
    try {
      cache = { routes: (await f.json()) as Routes, mtime };
    } catch {
      console.error('routes.json invalid, keeping previous routes');
      cache.mtime = mtime;
    }
  }
  return cache.routes;
}
async function saveRoutes(r: Routes) {
  await Bun.write(ROUTES_PATH, JSON.stringify(r, null, 2));
  cache = { routes: r, mtime: Bun.file(ROUTES_PATH).lastModified };
}

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer', 'upgrade', 'proxy-authorization', 'proxy-authenticate', 'host']);

function isPublic(req: Request): boolean {
  return req.headers.has('x-forwarded-host'); // set by ngrok on every tunneled request
}
function allowed(route: Route, path: string): boolean {
  return route.public.some((re) => { try { return new RegExp(re).test(path); } catch { return false; } });
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
    if (!b?.target) return Response.json({ error: 'target required; prefix optional (omit = set default)' }, { status: 400 });
    const pub = Array.isArray(b.public) ? b.public : ['^/'];
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

async function proxy(req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname.startsWith('/-/')) return admin(req, url);

  const r = await routes();
  let route = r.default;
  let path = url.pathname;
  const seg = path.split('/')[1] ?? '';
  if (seg && r.prefixes[seg]) {
    route = r.prefixes[seg]!;
    path = path.slice(seg.length + 1) || '/';
  }
  if (isPublic(req) && !allowed(route, path)) {
    return new Response('403 · not shared', { status: 403, headers: { 'content-type': 'text/plain' } });
  }

  const headers = new Headers();
  req.headers.forEach((v, k) => { if (!HOP_BY_HOP.has(k.toLowerCase())) headers.set(k, v); });
  try {
    const upstream = await fetch(`${route.target}${path}${url.search}`, {
      method: req.method,
      headers,
      body: req.body,
      redirect: 'manual',
    });
    const out = new Headers();
    upstream.headers.forEach((v, k) => { if (!HOP_BY_HOP.has(k.toLowerCase())) out.set(k, v); });
    return new Response(upstream.body, { status: upstream.status, headers: out });
  } catch {
    return new Response(`502 · upstream ${route.target} is down`, { status: 502 });
  }
}

console.log(`proxy listening on 127.0.0.1:${config.proxyPort} (routes: ${ROUTES_PATH})`);
export default {
  port: config.proxyPort,
  hostname: '127.0.0.1', // ngrok's agent connects locally; nothing binds public
  fetch: proxy,
  idleTimeout: config.serverIdleTimeout,
};
