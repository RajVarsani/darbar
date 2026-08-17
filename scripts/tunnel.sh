#!/bin/sh
# permanent-name zrok share in front of the proxy.
# The name is reserved ONCE, out of band, and then reused forever:
#   zrok create name <name>      -> https://<name>.shares.zrok.io
# `-n` selects <namespaceToken>:<name>; bare `-n <name>` is a NAMESPACE lookup and 409s.
PORT=$(grep '^PROXY_PORT=' .env | cut -d= -f2); PORT=${PORT:-4800}
NAME=$(grep '^ZROK_NAME=' .env | cut -d= -f2)
NS=$(grep '^ZROK_NAMESPACE=' .env | cut -d= -f2); NS=${NS:-public}
NS_DOMAIN=${ZROK_NS_DOMAIN:-shares.zrok.io}
if [ -n "$NAME" ]; then
  # A share KILLED rather than stopped leaves its server-side record bound to the reserved
  # name, and the next start dies with 409 shareConflict forever — which under launchd
  # KeepAlive is an infinite respawn loop, not a recovery. So reclaim the name first: find any
  # share still holding it and delete it. Harmless when there is none.
  STALE=$(zrok list shares 2>/dev/null | awk -v u="$NAME.$NS_DOMAIN" '$0 ~ u {print $2}' | tr -d ' ')
  [ -n "$STALE" ] && { echo "reclaiming $NAME from stale share $STALE"; zrok delete share "$STALE" 2>/dev/null || true; sleep 2; }
  exec zrok share public "http://127.0.0.1:$PORT" -n "$NS:$NAME" --headless
fi
echo "ZROK_NAME not set in .env, starting with an ephemeral URL"
exec zrok share public "http://127.0.0.1:$PORT" --headless
