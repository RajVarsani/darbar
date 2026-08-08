#!/bin/sh
# One command, whole stack: mongo check -> server + gabbar + proxy (parallel) + tunnel.
set -e
if ! nc -z localhost 27017 2>/dev/null; then
  echo "mongo not up, trying docker start saturn-v2-mongo…"
  docker start saturn-v2-mongo >/dev/null 2>&1 || { echo "start mongo manually, then re-run"; exit 1; }
  sleep 2
fi
grep -q '^SLACK_APP_TOKEN=xapp-' .env 2>/dev/null || echo "note: slack tokens missing, gabbar will skip itself"
trap 'kill 0' INT TERM
bun run --filter './apps/*' dev &
sh scripts/tunnel.sh > data/ngrok-dev.log 2>&1 &
wait
