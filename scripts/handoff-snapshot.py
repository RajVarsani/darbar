#!/usr/bin/env python3
"""Write the deterministic half of a session handoff to data/handoff.md.

Deterministic on purpose: everything here is a fact a shell can read, so it costs no model
turn and cannot be wrong about what it saw. The half a shell CANNOT do — noticing that
something discussed in the conversation was never filed — is the /darbar-handoff skill's job.

Run by the PreCompact hook (so a forgotten handoff still leaves a snapshot) and by the skill.
Printed back into context by the SessionStart(compact) hook. Keep the output SMALL: it is
paid for on every compaction, forever.
"""
import json
import os
import subprocess
import sys
import urllib.request
from datetime import datetime, timezone

API = os.environ.get('DARBAR_API', 'http://127.0.0.1:4899/api')
ROOT = os.path.expanduser(os.environ.get('DARBAR_ROOT', '~/fafo/darbar'))
# Projects are DISCOVERED, never listed. A hardcoded LIVE list makes a project created by
# another session invisible to the handoff, which is the exact blind-spot class DAR-250 is
# about — and it happened here: MRFIII existed for an hour while this script reported on
# three projects. LIVE= still overrides, for narrowing on purpose.
LIVE = [p for p in os.environ.get('LIVE', '').split(',') if p]
OPEN = ('todo', 'in_progress', 'in_review', 'qa', 'blocked')
MAX_ROWS = 40  # a ceiling, and it SAYS when it truncates rather than quietly cutting


def get(path):
    try:
        with urllib.request.urlopen(f'{API}{path}', timeout=5) as r:
            return json.load(r)
    except Exception:
        return None


def sh(*args, cwd=ROOT):
    try:
        return subprocess.run(args, cwd=cwd, capture_output=True, text=True, timeout=15).stdout.strip()
    except Exception:
        return ''


def main():
    out = [f'# darbar handoff · {datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")}', '']

    # ---- board ----
    live = LIVE
    native = set()  # linear-native: Linear holds the tasks, darbar keeps history + the feedback pipe
    if not live:
        projects = get('/projects')
        if projects is None:
            live = []
        else:
            items = projects if isinstance(projects, list) else projects.get('projects', [])
            # Archived projects are closed by choice; do not let their leftover open rows pad
            # the handoff. Only the DISCOVERED path is filtered - an explicit LIVE= is a
            # deliberate narrowing and is trusted as-is.
            live = [p.get('prefix') for p in items if p.get('prefix') and not p.get('archivedAt')]
            native = {p.get('prefix') for p in items if p.get('prefix') and p.get('linearUrl') and not p.get('archivedAt')}
    if not live:
        out.append('BOARD: could not list projects on 4899')
        live = []

    total_open, rows, unreachable = 0, [], False
    for proj in live:
        d = get(f'/tasks?project={proj}&limit=1000')
        if d is None:
            unreachable = True
            continue
        openrows = [t for t in d.get('tasks', []) if t.get('status') in OPEN]
        total_open += len(openrows)
        for t in openrows:
            rows.append(f'  {t["shortId"]:<10} {t.get("status",""):<12} {(t.get("title") or "")[:66]}')

    if unreachable:
        out.append('BOARD: api on 4899 unreachable — every line below about the board is missing, not empty.')
    else:
        fb = get('/feedback?status=pending') or {}
        pending = fb.get('total', fb.get('returned', 0)) if isinstance(fb, dict) else 0
        shown = [p + '(linear-native)' if p in native else p for p in live]
        out.append(f"BOARD: {total_open} open across {','.join(shown)} · {pending} pending feedback")
        out.extend(rows[:MAX_ROWS])
        if len(rows) > MAX_ROWS:
            out.append(f'  … and {len(rows) - MAX_ROWS} more open rows not listed here (ceiling is {MAX_ROWS})')
    out.append('')

    # ---- git ----
    for name, path in (('darbar', ROOT), ('skills', os.path.expanduser('~/fafo/skills'))):
        if not os.path.isdir(os.path.join(path, '.git')):
            continue
        dirty = [l for l in sh('git', 'status', '--porcelain', cwd=path).splitlines() if l]
        branch = sh('git', 'branch', '--show-current', cwd=path)
        ahead = sh('git', 'rev-list', '--count', '@{u}..HEAD', cwd=path) or '?'
        out.append(f'GIT {name}: {branch} · {len(dirty)} dirty · {ahead} unpushed')
        for l in dirty[:8]:
            out.append(f'  {l}')
        if len(dirty) > 8:
            out.append(f'  … and {len(dirty) - 8} more changed files')
    out.append('')

    # ---- processes: what is actually UP, not what we believe we started ----
    def listening(port):
        return bool(sh('lsof', '-nP', f'-iTCP:{port}', '-sTCP:LISTEN'))

    def running(pat):
        return bool(sh('pgrep', '-f', pat))

    proc = [
        f'server:{"up" if listening(4899) else "DOWN"}',
        f'proxy:{"up" if listening(4800) else "DOWN"}',
        f'mongo:{"up" if listening(27018) else "DOWN"}',
        f'tunnel:{"up" if running("zrok share public") else "DOWN"}',
        f'gabbar:{"up" if running("filter @darbar/gabbar") else "DOWN"}',
        # the watchdog is a periodic job with no resident pid, so ask launchd whether it is loaded.
        # A watchdog nobody watches is how the sleep-death outages went unnoticed in the first place.
        f'watchdog:{"up" if sh("launchctl", "list", "com.rajvarsani.darbar-watchdog") else "DOWN"}',
    ]
    out.append('PROCS: ' + ' · '.join(proc))
    out.append('')
    out.append('RECENT COMMITS')
    for l in sh('git', 'log', '--oneline', '-5').splitlines():
        out.append(f'  {l}')

    text = '\n'.join(out) + '\n'
    dest = os.path.join(ROOT, 'data', 'handoff.md')
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    with open(dest, 'w') as f:
        f.write(text)
    if '--print' in sys.argv:
        sys.stdout.write(text)
    return 0


if __name__ == '__main__':
    sys.exit(main())
