#!/bin/sh
# permanent-name zrok share in front of the proxy.
# The name is reserved ONCE, out of band, and then reused forever:
#   zrok create name <name>      -> https://<name>.shares.zrok.io
# `-n` selects <namespaceToken>:<name>; bare `-n <name>` is a NAMESPACE lookup and 409s.
PORT=$(grep '^PROXY_PORT=' .env | cut -d= -f2); PORT=${PORT:-4800}
NAME=$(grep '^ZROK_NAME=' .env | cut -d= -f2)
NS=$(grep '^ZROK_NAMESPACE=' .env | cut -d= -f2); NS=${NS:-public}
if [ -n "$NAME" ]; then exec zrok share public "http://127.0.0.1:$PORT" -n "$NS:$NAME" --headless; fi
echo "ZROK_NAME not set in .env, starting with an ephemeral URL"
exec zrok share public "http://127.0.0.1:$PORT" --headless
