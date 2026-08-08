#!/bin/sh
# permanent-domain ngrok tunnel in front of the proxy
PORT=$(grep '^PROXY_PORT=' .env | cut -d= -f2); PORT=${PORT:-4800}
DOMAIN=$(grep '^NGROK_DOMAIN=' .env | cut -d= -f2)
if [ -n "$DOMAIN" ]; then exec ngrok http "$PORT" --url "https://$DOMAIN"; fi
echo "NGROK_DOMAIN not set in .env, starting with an ephemeral URL"
exec ngrok http "$PORT"
