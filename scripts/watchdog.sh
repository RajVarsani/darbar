#!/bin/bash
# DAR-267 / DAR-265. Restart a service whose PROCESS is alive but whose upstream SESSION is dead.
#
# launchd only watches processes, and both failures we actually get are invisible to it: the zrok
# share's ziti api-session expires across a macOS sleep and never re-authenticates (the process
# keeps running, serving "bad gateway"), and gabbar's slack socket dies the same way. gabbar has an
# in-process exit timer, but a suspended process cannot count down its own timeout, so sleep beats
# it too. Only an outside prober catches either.
#
# Run on a timer by com.rajvarsani.darbar-watchdog. Read-only unless something is actually broken.
set -u
ROOT="$HOME/fafo/darbar"
LOG="$ROOT/data/logs/watchdog.log"
STATE="$ROOT/data/watchdog-state"
BOARD_URL="https://darbar.shares.zrok.io/p/EaU4Iu4iSTcOHMpclZN3A"
FAILS_BEFORE_RESTART=2   # with a 120s timer, ~4 minutes of real downtime
COOLDOWN=600             # never restart the same service more than once per 10 min
mkdir -p "$STATE" "$(dirname "$LOG")"

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*" >> "$LOG"; }

# Restarting cannot fix a dead network, and a captive portal would otherwise have us respawning
# the tunnel every two minutes for hours. No internet means no verdict, not a failure.
online() { curl -sf -o /dev/null -m 8 https://zrok.io/ 2>/dev/null; }

# count consecutive failures per service, so one blip never triggers a restart
bump() { local n; n=$(( $(cat "$STATE/$1.fails" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$STATE/$1.fails"; echo "$n"; }
clear_fails() { rm -f "$STATE/$1.fails"; }

restart() { # $1 service short name, $2 launchd label, $3 why
  local last now
  now=$(date +%s)
  last=$(cat "$STATE/$1.last" 2>/dev/null || echo 0)
  if [ $(( now - last )) -lt "$COOLDOWN" ]; then
    log "$1 still failing ($3) but restarted $(( now - last ))s ago, holding off"
    return
  fi
  echo "$now" > "$STATE/$1.last"
  log "RESTART $1 — $3"
  launchctl kickstart -k "gui/$(id -u)/$2" >> "$LOG" 2>&1
  clear_fails "$1"
}

# ---- the tunnel: only the public URL proves it, which is the whole point ----
# A local-only check is what let this fail silently for hours: the proxy answers on 4800 and the
# zrok process is alive while the share serves nothing. Skip the verdict when the local side is
# down, because then the 502 is honest and restarting the tunnel fixes nothing.
if curl -sf -o /dev/null -m 8 http://127.0.0.1:4800/ 2>/dev/null; then
  if curl -sf -o /dev/null -m 25 -H 'skip_zrok_interstitial: true' "$BOARD_URL" 2>/dev/null; then
    clear_fails tunnel
  elif online; then
    n=$(bump tunnel)
    log "tunnel probe failed ($n/$FAILS_BEFORE_RESTART)"
    [ "$n" -ge "$FAILS_BEFORE_RESTART" ] && restart tunnel com.rajvarsani.darbar-tunnel "public board unreachable while proxy 4800 is healthy"
  else
    log "tunnel probe failed but the internet is unreachable — no verdict"
  fi
fi

# ---- gabbar: the heartbeat file is only touched while its slack socket says connected ----
HB="$ROOT/data/gabbar-heartbeat.json"
if [ -f "$HB" ]; then
  age=$(( $(date +%s) - $(stat -f %m "$HB") ))
  if [ "$age" -gt 600 ]; then
    n=$(bump gabbar)
    log "gabbar heartbeat stale ${age}s ($n/$FAILS_BEFORE_RESTART)"
    [ "$n" -ge "$FAILS_BEFORE_RESTART" ] && restart gabbar com.rajvarsani.darbar-gabbar "slack socket silent for ${age}s"
  else
    clear_fails gabbar
  fi
fi

# ---- ctxwatch (DAR-419): heartbeat is touched every poll; only checked once the agent is installed ----
HB="$ROOT/data/ctxwatch-heartbeat.json"
if [ -f "$HB" ] && launchctl print "gui/$(id -u)/com.rajvarsani.darbar-ctxwatch" >/dev/null 2>&1; then
  age=$(( $(date +%s) - $(stat -f %m "$HB") ))
  if [ "$age" -gt 300 ]; then
    n=$(bump ctxwatch)
    log "ctxwatch heartbeat stale ${age}s ($n/$FAILS_BEFORE_RESTART)"
    [ "$n" -ge "$FAILS_BEFORE_RESTART" ] && restart ctxwatch com.rajvarsani.darbar-ctxwatch "watcher loop silent for ${age}s"
  else
    clear_fails ctxwatch
  fi
fi
