# @houston/proxy

Dynamic front door. ngrok tunnels to THIS (:4800, loopback); local services stay
private behind it.

- Routing: `/<prefix>/…` -> `prefixes[prefix].target` (prefix stripped); everything
  else -> `default.target`. Routes in `data/routes.json`, hot-reloaded on mtime.
- Public policy: tunneled requests carry `x-forwarded-host` (ngrok sets it). Those
  must match the route's `public` regex list or get `403 · not shared`. Local
  requests bypass policy. This is the ONLY auth layer in front of houston's open
  API — never widen the default `public` list casually.
- Admin `/-/routes` (GET/PUT), `/-/route` (POST), `/-/route/:prefix` (DELETE):
  require `Authorization: Bearer PROXY_ADMIN_TOKEN`, return 404 through the tunnel.
- Known gap: fetch-based proxying does not upgrade WebSockets (SSE works fine).
