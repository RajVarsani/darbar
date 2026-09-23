#!/usr/bin/env python3
"""DAR-292: the row asked for a test proving handoff-snapshot.py's hook-path output stays under
the harness's real 10,000-character hook-stdout cap even when a full 24KB memory index is
available to it. There is no python test harness elsewhere in this repo (all tests are the bun
suite in apps/server), so this is a small standalone script: run it directly,

    python3 scripts/test-handoff-snapshot-size.py

It starts a throwaway local HTTP server that answers like darbar's API but serves a >24,000-byte
/memory/index body (the route's own default cap), points handoff-snapshot.py at it via
DARBAR_API, and asserts the --hook --print output is under 10,000 characters AND still carries
the doctrine trailer (the thing FB-163 was worried a truncation would eat first).
"""
import http.server
import json
import socketserver
import subprocess
import sys
import threading

ROOT = __file__.rsplit('/scripts/', 1)[0]

# > 24,000 bytes, matching the server's own MEMORY_INDEX_BYTE_CAP_DEFAULT — this stands in for
# "a 24KB index available" without needing a live darbar project seeded with 400 real nodes.
_NODE_LINE = '- **node-{i}** (gotcha) — a realistic-length observation line padding this out to a real size for node {i}\n'
_BIG_INDEX = '# Memory index — global\n\n## gotcha\n' + ''.join(_NODE_LINE.format(i=i) for i in range(400)) + '\n0 node(s) omitted for space.\n'
assert len(_BIG_INDEX.encode('utf-8')) > 24000, 'fixture must exceed the 24,000-byte default cap'


class FakeDarbar(http.server.BaseHTTPRequestHandler):
    def _json(self, obj):
        body = json.dumps(obj).encode()
        self.send_response(200)
        self.send_header('content-type', 'application/json')
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path, _, query = self.path.partition('?')
        if path == '/healthz':
            self.send_response(200); self.end_headers(); self.wfile.write(b'ok')
        elif path == '/api/projects':
            self._json([])
        elif path == '/api/feedback':
            self._json({'total': 0})
        elif path.startswith('/api/tasks'):
            self._json({'tasks': []})
        elif path == '/api/memory/index':
            # honour ?max like the real route so the script's own budgeting is exercised, not bypassed
            max_bytes = None
            for kv in query.split('&'):
                if kv.startswith('max='):
                    try:
                        max_bytes = int(kv[4:])
                    except ValueError:
                        pass
            body = _BIG_INDEX
            if max_bytes is not None:
                # crude clamp mirroring the route's own drop-from-the-bottom behaviour
                enc = body.encode('utf-8')
                if len(enc) > max_bytes:
                    body = enc[: max(max_bytes - 40, 0)].decode('utf-8', errors='ignore') + '\n0 node(s) omitted for space.\n'
            self.send_response(200)
            self.send_header('content-type', 'text/markdown')
            self.end_headers()
            self.wfile.write(body.encode('utf-8'))
        else:
            self.send_response(404); self.end_headers()

    def log_message(self, *a):
        pass


def main():
    socketserver.TCPServer.allow_reuse_address = True
    httpd = socketserver.TCPServer(('127.0.0.1', 0), FakeDarbar)
    port = httpd.server_address[1]
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    try:
        result = subprocess.run(
            ['python3', f'{ROOT}/scripts/handoff-snapshot.py', '--print', '--hook'],
            env={'DARBAR_API': f'http://127.0.0.1:{port}/api', 'HOME': __import__('os').environ.get('HOME', '')},
            capture_output=True, text=True, timeout=15,
        )
    finally:
        httpd.shutdown()

    output = result.stdout
    ok = True
    length = len(output)
    if length >= 10000:
        print(f'FAIL: output is {length} characters, not under the 10,000-character hook-stdout cap')
        ok = False
    else:
        print(f'PASS: output is {length} characters (< 10,000)')

    if 'invoke the darbar-resume skill' not in output:
        print('FAIL: doctrine trailer is missing from --hook output')
        ok = False
    else:
        print('PASS: doctrine trailer present in --hook output')

    if result.returncode != 0:
        print(f'FAIL: handoff-snapshot.py exited {result.returncode}; stderr:\n{result.stderr}')
        ok = False

    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
