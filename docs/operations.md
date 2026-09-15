# Operations

Day-to-day running: supervision, logs, the tunnel, the database, backups.

## Running one service at a time

`bun run dev` starts the lot. To run just one (boot the matching agent out first, or they
fight over ports):

| command | needs |
|---|---|
| `bun run server` | mongo |
| `bun run proxy` | nothing; reads `data/routes.json` |
| `bun run gabbar` | `SLACK_BOT_TOKEN` + `SLACK_APP_TOKEN` (Socket Mode) |
| `bun run mcp` | nothing extra; stdio |
| `bun run tunnel` | a zrok account and `ZROK_NAME` |

## Supervision (launchd, not a terminal)

The five services run under launchd and come back on their own. Mongo is a docker container
with `unless-stopped`; the other four are user agents:

```
launchctl kickstart -k gui/$(id -u)/com.rajvarsani.darbar-server   # restart one
launchctl print     gui/$(id -u)/com.rajvarsani.darbar-tunnel      # why is it not running
tail -f data/logs/{server,proxy,gabbar,tunnel}.log
launchctl bootout   gui/$(id -u)/com.rajvarsani.darbar-gabbar      # stop for good
```

Plists live in `~/Library/LaunchAgents/com.rajvarsani.darbar-*.plist` and all exec
`scripts/svc.sh <name>`, which sources `.env` — so no secret is ever written into a plist.
`bun dev` still works for a foreground stack; boot the agents out first or they fight over ports.

**Why:** every service started from a shell or an agent session died within hours, and gabbar
was dead for 10h35m before its own heartbeat check caught it. A dev stack that only runs while
somebody is watching is exactly what the health checks kept finding.

The tunnel name is reserved ONCE and then reused forever:
```
zrok create name darbar        # -> https://darbar.shares.zrok.io
bun run tunnel                 # zrok share public, bound to that name
```
`-n` takes `<namespaceToken>:<name>`; a bare `-n darbar` is read as a NAMESPACE and 409s.

**The share does not survive its backend going away**, and it fails in two different ways.
Restart the proxy and the share either exits (`connection refused`, failed ziti re-bind) or —
worse — stays ALIVE with a dead binding, which `pgrep` happily calls healthy. It never
reconnects on its own. Both were observed on 18 Aug.

launchd's KeepAlive now covers the first case, and `tunnel.sh` reclaims its own name on start
so the restart cannot 409 into a respawn loop. Nothing covers the second automatically, because
the process looks fine: `darbar-tick`'s sweep fetching the board through the PUBLIC url is what
catches it. That is the whole argument for checking the path a stakeholder uses — everything
local stays green throughout, and the public url is invisible from this machine.

Note the sweep cannot distinguish "our tunnel is down" from "this network blocks it". On 18 Aug
Vodafone classified `darbar.shares.zrok.io` as `[phishing]` and served a block page, which the
sweep reported as DOWN. Check the cert issuer before believing it is ours (DAR-258).

Mongo: its OWN container `darbar-mongo` on **27018** (db `mission_control`, override via
DB_NAME). Deliberately not the saturn-v2 container — don't point it back at 27017.

## The watchdog

launchd only watches processes, and the two failures that actually happen are invisible to
it: the zrok share's session expires across a macOS sleep and never re-authenticates, and
gabbar's Slack socket dies the same way. Both leave a healthy process serving nothing.

`scripts/watchdog.sh` (agent `darbar-watchdog`, every 120s) probes the PUBLIC board URL and
gabbar's heartbeat file, and restarts either after 2 consecutive failures with a 10-minute
cooldown. It stays silent when the internet is unreachable, so a captive portal cannot cause
a respawn loop, and it leaves the tunnel alone when the local proxy is down, because then the
502 is honest.

```
tail -f data/logs/watchdog.log     # silent means nothing was broken
```

## Backups

`scripts/backup.sh` (agent `darbar-backup`, nightly 03:15) dumps mongo, then VERIFIES the dump
by restoring it into a scratch database and comparing document counts. A dump that fails
verification is kept as `.UNVERIFIED` and is not counted when old archives are pruned, so a
run of corrupt dumps can never quietly age out the last good one. Archives land in
`data/backups/`, 14 kept.

## Scripts

| script | what it does |
|---|---|
| `dev.sh` | foreground stack for development; reads the mongo port from `MONGO_URI` |
| `svc.sh <name>` | the single entry point every launchd agent execs; sources `.env` so no secret is ever written into a plist |
| `tunnel.sh` | starts the zrok share, reclaiming its own reserved name first so a restart cannot 409 into a respawn loop |
| `backup.sh` | verified nightly mongo dump |
| `watchdog.sh` | restarts the tunnel or gabbar when the process is alive but its session is dead |
| `handoff-snapshot.py` | writes the deterministic session snapshot the Claude Code hooks print back after a compaction |
