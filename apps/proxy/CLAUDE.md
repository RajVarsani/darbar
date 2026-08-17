# @darbar/proxy

Dynamic front door. The tunnel (zrok) forwards to THIS (:4800, loopback); local
services stay private behind it.

- Routing: `/<prefix>/…` -> `prefixes[prefix].target` (prefix stripped); everything
  else -> `default.target`. Routes in `data/routes.json`, hot-reloaded on mtime.
- Public policy: a request is PUBLIC unless it proves it came from loopback (Host is
  a loopback name AND no forwarding header is present). Public requests must match the
  route's `public` pattern list or get `403 · not shared`. Local requests bypass policy.
  This is the ONLY auth layer in front of darbar's open API — never widen the default
  `public` list casually.
  **Never re-key this on one vendor's header.** It was `has('x-forwarded-host')` (ngrok)
  until DAR-252: zrok forwards without it, every tunneled request read as LOCAL, and the
  whole API went world-readable behind a share link. Identify the tunnel by exclusion.
- The proxy SETS `x-forwarded-host` on public requests when forwarding, because the
  server has local-only routes that key off it and cannot repeat the Host test (`host`
  is hop-by-hop, so everything proxied looks loopback to it). A forged one is overwritten.
- Admin `/-/routes` (GET/PUT), `/-/route` (POST), `/-/route/:prefix` (DELETE):
  require `Authorization: Bearer PROXY_ADMIN_TOKEN`, return 404 through the tunnel.
- Known gap: fetch-based proxying does not upgrade WebSockets (SSE works fine).
