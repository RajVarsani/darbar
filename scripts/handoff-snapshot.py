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
import re
import subprocess
import sys
import urllib.error
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
HOOK_MODE = '--hook' in sys.argv  # DAR-292 FB-163 LOW: only the SessionStart hook gets the trailer

# DAR-292 rework (FB-163): the real harness cap on hook stdout is 10,000 CHARACTERS (Claude
# Code 2.1.280: ine(stdout.trim(), id, "stdout", {threshold: 1e4}), 2,000-char preview beyond
# that) — NOT bytes, and not the 20,000 this file used before. The old MEMORY_INDEX_MAX_BYTES
# (12000) and TOTAL_BYTE_CAP (20000) were both already over the real limit on their own,
# which is exactly how the 25.8KB overflow this row exists for happened. Budget in characters
# throughout. The route's own MEMORY_INDEX_BYTE_CAP_MIN floor (1000) is a byte figure server
# side, but for a global index (near-all-ASCII) chars and bytes are close enough that using it
# as a char floor here is a fine approximation; if it is ever wrong it errs toward requesting
# slightly more than needed, which the client-side trim below still enforces.
TOTAL_CHAR_CAP = 9500
INDEX_ROUTE_FLOOR = 1000
# hook preamble in darbar-session-resume (the "Darbar board state, read live..." wrapper) adds
# roughly 190 chars outside this script's own output; leave headroom for that plus rounding.
HOOK_PREAMBLE_MARGIN = 300


def get(path):
    try:
        with urllib.request.urlopen(f'{API}{path}', timeout=5) as r:
            return json.load(r)
    except Exception:
        return None


def get_text_status(path):
    """Like get_text, but also reports the HTTP status so callers can tell a 400 (route
    doesn't understand a query param we sent — old server) apart from an unreachable server or
    a 404 (route not deployed), both of which must stay silent per the DAR-275/281 contract."""
    try:
        with urllib.request.urlopen(f'{API}{path}', timeout=5) as r:
            if r.status != 200:
                return r.status, None
            return 200, r.read().decode('utf-8', errors='replace').strip()
    except urllib.error.HTTPError as e:
        return e.code, None
    except Exception:
        return None, None


def get_text(path):
    # DAR-275/281: memory index is text/markdown, not JSON, and a 404 (route not deployed
    # yet) or any other failure must produce NOTHING — never an error string injected into
    # a live session's context.
    _, text = get_text_status(path)
    return text


def trim_index_text(text, budget):
    """Trim a rendered /memory/index body to at most `budget` characters, cutting on LINE
    boundaries only (never mid-line), dropping from the end (lowest-ranked nodes render last
    within a group, and groups are already priority-ordered, so trimming the tail is trimming
    the least-important content first). The server's own "N node(s) omitted for space." footer
    is preserved and its count bumped by whatever we additionally drop, so the reader still
    sees one honest number instead of a second, disconnected one.

    Returns (trimmed_text, note_or_None). note is only set when there was nothing cheap to fold
    the drop count into (no recognizable footer line).
    """
    if len(text) <= budget:
        return text, None
    lines = text.split('\n')
    footer_m = re.match(r'^(\d+) node\(s\) omitted for space\.$', lines[-1].strip()) if lines else None
    prior_omitted = int(footer_m.group(1)) if footer_m else None
    body = lines[:-1] if footer_m else lines

    def footer_text(n):
        return f'{n} node(s) omitted for space.'

    reserve = len(footer_text(prior_omitted if prior_omitted is not None else 0)) + 1
    dropped_nodes = 0
    while body and (sum(len(l) + 1 for l in body) + reserve) > budget:
        gone = body.pop()
        if gone.strip().startswith('- **'):
            dropped_nodes += 1

    if footer_m is not None:
        body.append(footer_text(prior_omitted + dropped_nodes))
        note = None
    elif dropped_nodes:
        note = f'NOTE: client-side trim dropped {dropped_nodes} more memory line(s); no "N node(s) omitted" footer was present to fold that count into.'
    else:
        note = None
    return '\n'.join(body), note


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

    # DAR-292: the doctrine-pointer trailer must print BEFORE the memory section, not after —
    # if the total ever needs trimming, the trim below only ever eats memory-index lines, never
    # these instructions. This paragraph used to live in the SessionStart hook script itself,
    # printed AFTER $SNAP (i.e. after the memory section); moved here so it is guaranteed first.
    #
    # FB-163 LOW: this text says "invoke the darbar-resume skill", which reads oddly inside
    # darbar-resume's own output (data/handoff.md, and the --print used by /darbar-handoff and
    # the PreCompact hook). Gated on --hook (only darbar-session-resume passes it) so the
    # doctrine reminder shows up exactly where it is a reminder — at session start — and not in
    # the handoff artifact or the skill's own read of it.
    if HOOK_MODE:
        out.append(
            'If you are mid-task, re-read the row you were on before acting; another session or a\n'
            'lane may have moved it. Before the next compaction, run /darbar-handoff so anything that\n'
            'exists only in this conversation gets filed to the board first.\n'
            '\n'
            'The state above survived; your ORCHESTRATION DOCTRINE did not. If you are running one of\n'
            'these boards, invoke the darbar-resume skill before your next dispatch: it re-reads the\n'
            'charter (your standing instructions) and re-loads the manual from darbar-project-init.\n'
            'Skipping it is how a session drifts into working inline and dispatching on the wrong tier.\n'
            '\n'
            'Every reply to Raj ends with a short Done / Blocked / Next (one line each), so it reads\n'
            'on a phone.\n'
            '\n'
            'Memory reads come from darbar (recall) — the "# memory · <PREFIX>" section below, if\n'
            'present, is the live index; memory writes go through darbar (remember), never by editing\n'
            'a memory file directly.'
        )
        out.append('')

    # ---- everything below is non-memory too: build it now so the memory budget is computed
    # against the ACTUAL remaining space, not a guess. (DAR-292 FB-163: a fixed ?max=12000 was
    # already over the real 10,000-char hook-stdout cap before board/git/procs/trailer/commits
    # were even counted.) ----
    project_memory_line = (
        'project memory: /darbar-resume fetches /api/memory/index?project=<PREFIX> for '
        'the board you are running; or recall <PREFIX> on demand.'
    )
    commit_lines = ['RECENT COMMITS'] + [f'  {l}' for l in sh('git', 'log', '--oneline', '-5').splitlines()]

    skeleton = out + [project_memory_line, '', ''] + commit_lines
    skeleton_chars = len('\n'.join(skeleton) + '\n')
    remaining = TOTAL_CHAR_CAP - skeleton_chars - HOOK_PREAMBLE_MARGIN

    memory_lines = []
    if remaining <= 0:
        memory_lines = [
            f'NOTE: skipped the memory section — board/git/procs/trailer/commits alone used '
            f'{skeleton_chars} of the {TOTAL_CHAR_CAP}-character hook display cap.',
            '',
        ]
    else:
        req_max = max(remaining, INDEX_ROUTE_FLOOR)
        status, idx = get_text_status(f'/memory/index?max={req_max}')
        if status == 400:
            # DAR-292 FB-163 MEDIUM: a server still on the pre-DAR-292 route rejects an unknown
            # ?max key outright (closedBody). Fall back to the plain route so a stale server
            # still gets SOME memory injected, rather than none with no NOTE at all.
            _, idx = get_text_status('/memory/index')
        elif status != 200:
            idx = None  # unreachable / 404 — stay silent, per the DAR-275/281 contract

        if idx:
            trimmed, trim_note = trim_index_text(idx, remaining)
            memory_lines = (['NOTE: ' + trim_note] if trim_note else []) + ['# memory · global', trimmed, '']

    out.extend(memory_lines)
    out.append(project_memory_line)
    out.append('')
    out.extend(commit_lines)

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
