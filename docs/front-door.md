# The front door

Everything reachable from outside this machine goes through one proxy on `:4800`, with the
zrok tunnel in front of it. Nothing else is exposed, and the proxy decides per route which
paths a tunneled request may reach.

## Routes
The zrok tunnel fronts ONLY the proxy. The proxy enforces the public surface per route:
a request is public unless it proves it came from loopback, and public requests must
match one of a route's `public` path patterns; everything else 403s. Default route ->
darbar with boards, board API and files public. Add more services at runtime:
```
curl -X POST localhost:4800/-/route -H "Authorization: Bearer $PROXY_ADMIN_TOKEN" \
  -d '{"prefix":"fe","target":"http://127.0.0.1:5173","public":["/"]}'
```
`/-/` admin endpoints require the token and are invisible through the tunnel.
Set BASE_URL to the tunnel domain so board links in Gabbar replies work for
stakeholders. The free zrok plan shows visitors a one-click interstitial (adding a
card to the account removes it, at no charge).

## `public` is a path language, not regexes
Entries are matched with string operations only — `===`, `startsWith`, `indexOf` — so
there is no engine to backtrack and no pattern anyone writes can hang the front door.
Each entry is a literal path starting with `/`:

- `/assets/` — PREFIX, the default. Any path that starts with it, `/` included:
  `/assets/deep/b.js` matches, `/assetsx` does not.
- `/$` — EXACT. A trailing `$` means the path must equal the literal: `/` and not
  `/index.html`.
- `/assets/*.js$` — GLOB. At most one `*`, and it never matches across `/`:
  `/assets/a.js` matches, `/assets/deep/a.js` does not.
- `/` — the prefix that matches every path. This is what the old `^/` was written for.

A leading `^`, a `.*`, a second `*`, or any character a URL path does not carry is
refused by name, and the error spells out the form. Write patterns in the form above and
never with a `^`: `PATCH /api/projects/:ref {proxy}` rejects an anchored entry outright,
so `"public":["^/"]` 400s there with the rewrite spelled out in the message.

Only the on-disk read path is lenient, and only so far. An `^`-anchored entry already in
routes.json is migrated when it is a pure literal path once the anchors come off
(`^/p/` -> `/p/`, `^/$` -> `/$`, `^/` -> `/`), which is why an existing routes.json keeps
serving after the language changed. Anything carrying real regex metacharacters
(`^/assets/.*\.js$`, `^/(a|b)/`) is never guessed at: it is DROPPED with a
`routes.json: ... REJECTED` line on the proxy console, and that line is the only notice
you get. `POST /-/route` itself validates nothing, so a bad pattern is accepted there and
surfaces only as that log at load. Failure never widens a route. An empty list, an
all-rejected list and an omitted `public` all mean the same thing: nothing on that route
is reachable through the tunnel.

Three more things the front door does, none of them configurable. A tunneled path
carrying an ENCODED separator (`%2f`/`%5c`) is refused outright, because our view of the
path and the upstream's would otherwise disagree — `/assets/..%2fsecret` matches an
`/assets/` prefix here and lands on `/secret` on a dev server that decodes before
resolving `..`. `proxy.target` on the project config API must be a loopback address
(`localhost`, `127.0.0.0/8`, `::1`, or an unspecified `0.0.0.0`/`::`), since the proxy is
publicly reachable and anything else is an open relay onto a host that never agreed to be
published. That check lives on that API and only there, because as stated above `POST /-/route`
validates nothing, so a route hand-added straight to the proxy may point anywhere. What keeps that
a local choice rather than a hole is the admin token and the endpoint being invisible through the
tunnel. And the board payload at `/api/p/:capId` is itself public, so it reports
`prefix`, `public`, `enabled` and `proxyPublished` but replaces the upstream with
`targetRedacted: true` — the internal host:port is only on the local-only
`/api/projects/:ref/context`.

## Exposing a Vite dev server (HMR works through the tunnel)
The proxy bridges WebSocket upgrades, so Vite's HMR socket survives the tunnel —
the same route + `public` policy applies to the upgrade as to plain HTTP, on the
prefix-stripped path. The upstream socket is connected before the client handshake is
answered, so a 101 means the tunnel really works (a dead or wedged dev server gets a 502
instead), and buffering is capped in both directions: an end that stops reading has its
socket closed rather than growing the proxy's memory. Those caps are per socket, and the
process has two of its own on top, because 25 individually well-behaved sockets still added
up to 585 MB: a total in-flight budget across all sockets, which closes the largest holder
when it is crossed, and a limit of 64 concurrent proxied sockets, past which a new upgrade is
answered with a 503 rather than a 101. The byte budget sits four orders of magnitude above what
HMR moves; the socket cap sits several times above it, since the real peak is one HMR socket per
open tab per shared dev server. An HMR socket can never be the one shed, and by arithmetic rather
than by luck: crossing 128 MiB across at most 64 sockets forces the largest holder above 2 MiB.
The 503 is the one that can fire with nobody misbehaving, since pending upgrades hold slots too,
so a burst of them against a wedged dev server can refuse a healthy route for a few seconds. The
constants in `apps/proxy/src/proxy.ts` carry the numbers, the reasoning, and an honest list of
what they do not protect against. Two Vite-side requirements:

1. **`base` must match the prefix** (`base: '/fe/'` for prefix `fe`) — otherwise the
   HTML points at `/assets/...` and `/@vite/client` at the tunnel root, which lands
   on the default route instead of your app. The HMR socket URL follows `base` too.
2. **Put the same path on the route target** (`http://127.0.0.1:5173/fe`). The proxy
   strips the prefix, so without it Vite receives `/` and 302-redirects to `base` —
   an infinite redirect loop in the viewer's browser.

```
curl -X POST localhost:4800/-/route -H "Authorization: Bearer $PROXY_ADMIN_TOKEN" \
  -d '{"prefix":"fe","target":"http://127.0.0.1:5173/fe","public":["/"]}'
```
**`Origin` is forwarded unchanged, deliberately.** On plain requests and on upgrades alike: the
upgrade path copies every header that is not hop-by-hop and not `sec-websocket-*`, so `Origin`
survives both. That gives the upstream the one thing it needs to make its own decisions. A dev
server that runs a cross-site-WebSocket-hijacking check, or refuses a state-changing request from
a foreign origin, sees the viewer's real origin and can act on it. Rewrite the header and every
tunneled request looks same-origin to those checks, which is the one outcome strictly worse than
not having them; Vite's own proxy docs say as much about `changeOrigin` for proxied websockets,
that it "can expose the proxy to CSRF attacks". The query string is passed through unchanged for
the same reason, which is what lets a dev server whose HMR URL carries a token complete its own
handshake.

**Why forwarding is safe here is about what sits either side of it,** not about any check the
upstream happens to run. A route created through the project config API must point at loopback, so
the only thing an `Origin` decision is protecting is a dev server on this machine that the
developer started and pointed the proxy at on purpose. In front of it, a tunneled request reaches
only the paths that route's `public` list names. And every viewer holds the same unauthenticated
capability link: darbar has no login, no session and sets no cookie anywhere, so a viewer's browser
carries no ambient credentials for what is published. Cross-site request forgery is borrowing a
victim's credentials; with none to borrow, an attacker's page can make a viewer's browser do nothing
the attacker cannot already do directly with `curl` and the link. That is the case `Origin` checks
are not defending, and it is the case we are in. The real exposure of sharing a dev server is that
whoever holds the link holds the whole shared surface, and no `Origin` policy narrows that by one
byte.

**Three changes would flip the answer,** and any of them means revisiting this section rather than
tweaking a header. If route targets are ever allowed off loopback, the proxy becomes a relay onto a
host that never agreed to be published, and the upstream's own origin policy is suddenly its last
line of defence. If anything published through here grows a login or sets a cookie, or the proxy ever
attaches a credential of its own, then ambient credentials exist and CSRF is real. And if something
is ever put behind here that treats `Origin` as an authorisation decision rather than an
anti-forgery hint, then forwarding a viewer-controlled header into an authorisation check is a
worse mistake than rewriting it would have been. Until one of those is true: forwarded, unchanged,
and not a security control.

**`Host` is dropped on purpose, and that disables `allowedHosts`.** Not because it is
hop-by-hop (it isn't, per RFC 7230) but because we choose to: the upstream sees
`127.0.0.1:<port>`, so its `allowedHosts` check passes with no config. That is the right call
for a front door that is the intended entry point, but name it for what it is. `allowedHosts`
is disabled for anything behind this proxy, not satisfied. Don't trust it as a defence, and
don't "fix" the hop-by-hop list to restore it.
