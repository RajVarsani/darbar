#!/bin/sh
# One entry point for every darbar service, so launchd never sees a secret.
#
# The plists exec THIS with a service name; .env is sourced here and stays on disk, out of
# ~/Library/LaunchAgents (which is world-readable and gets backed up).
#
# Why launchd at all: every service started from a shell or an agent session died within
# hours on 2026-08-17/18 — the parent goes away and takes them with it. Gabbar was dead for
# 10.5h before its own new heartbeat check caught it. A dev stack that only runs while
# somebody is watching is the thing the health checks kept finding.
set -eu
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a

case "${1:-}" in
  server) exec bun apps/server/src/server.ts ;;
  proxy)  exec bun apps/proxy/src/proxy.ts ;;
  gabbar) exec bun run --filter @darbar/gabbar dev ;;
  # The tunnel MUST outlive a proxy restart, and it does not: the zrok share either exits or
  # (worse) stays alive with a dead binding, which pgrep calls healthy. KeepAlive restarts it;
  # the sweep's tunnel check is what notices the alive-but-broken case.
  tunnel) exec sh scripts/tunnel.sh ;;
  *) echo "usage: svc.sh server|proxy|gabbar|tunnel" >&2; exit 2 ;;
esac
