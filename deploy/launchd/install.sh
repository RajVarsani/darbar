#!/bin/bash
# Install (or reinstall) the darbar launchd agents for the CURRENT user.
#
# Why these live in the repo: every service started from a shell or an agent session died
# within hours, and the plists that replaced them existed only on one laptop. A supervisor
# you cannot reproduce is a supervisor you lose.
#
#   ./deploy/launchd/install.sh            # install + start all agents
#   ./deploy/launchd/install.sh --uninstall
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PREFIX="${DARBAR_LABEL_PREFIX:-com.$(id -un).darbar}"
DEST="$HOME/Library/LaunchAgents"
DOMAIN="gui/$(id -u)"
AGENTS=(server proxy gabbar ctxwatch tunnel backup watchdog)

if [ "${1:-}" = "--uninstall" ]; then
  for a in "${AGENTS[@]}"; do
    launchctl bootout "$DOMAIN/$PREFIX-$a" 2>/dev/null || true
    rm -f "$DEST/$PREFIX-$a.plist"
    echo "removed $PREFIX-$a"
  done
  exit 0
fi

[ -f "$ROOT/.env" ] || { echo "no .env at $ROOT — copy .env.example first"; exit 1; }
mkdir -p "$DEST" "$ROOT/data/logs"

for a in "${AGENTS[@]}"; do
  src="$ROOT/deploy/launchd/darbar-$a.plist.template"
  [ -f "$src" ] || continue
  out="$DEST/$PREFIX-$a.plist"
  sed -e "s#__DARBAR_ROOT__#$ROOT#g" -e "s#__HOME__#$HOME#g" -e "s#__LABEL_PREFIX__#$PREFIX#g" "$src" > "$out"
  launchctl bootout "$DOMAIN/$PREFIX-$a" 2>/dev/null || true
  launchctl bootstrap "$DOMAIN" "$out"
  echo "installed $PREFIX-$a"
done

echo
echo "running agents:"
launchctl list | grep "$PREFIX" || echo "  (none — check $ROOT/data/logs)"
