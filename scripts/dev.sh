#!/bin/sh
# One command, whole stack: mongo check -> server + gabbar + proxy (parallel) + tunnel.
set -e
# darbar has its OWN mongo (darbar-mongo on 27018). It must never fall back to the saturn-v2
# container: that was the shared copy this was deliberately separated from. Port comes from
# MONGO_URI so the check cannot drift from what the apps actually dial.
MONGO_PORT=$(grep '^MONGO_URI=' .env | sed -E 's|.*:([0-9]+).*|\1|'); MONGO_PORT=${MONGO_PORT:-27018}
if ! nc -z localhost "$MONGO_PORT" 2>/dev/null; then
  echo "mongo not up on $MONGO_PORT, trying docker start darbar-mongo…"
  docker start darbar-mongo >/dev/null 2>&1 || { echo "start mongo manually, then re-run"; exit 1; }
  sleep 2
fi
grep -q '^SLACK_APP_TOKEN=xapp-' .env 2>/dev/null || echo "note: slack tokens missing, gabbar will skip itself"
trap 'kill 0' INT TERM
bun run --filter './apps/*' dev &
sh scripts/tunnel.sh > data/tunnel-dev.log 2>&1 &
wait
