// proxy.target is the one field that decides what a public share link can reach, so this pins the
// rule rather than a spelling of it.
//
// DAR-214: the rule was "loopback only", and loopback includes us. A project proxy of
// {target:"http://127.0.0.1:<darbar's port>", public:["/"]} passed every check and would have
// tunnelled the ENTIRE api through the share link — every task, every feedback body, every charter,
// the local-only routes and the write endpoints — with no capability id, because the proxy strips
// the prefix and forwards the rest verbatim. The same shape aimed at the proxy's own port
// republishes the front door through itself. Loopback-only stays; the two ports that are not dev
// servers are now named.
//
// Ports come from config rather than being hardcoded, so this asserts "our own port" whatever the
// environment sets it to, and cannot pass by accident because a default happened to line up.
import { expect, test } from 'bun:test';
import { config } from '@darbar/core';
import { readTarget } from './api';

const refused = (s: string) => {
  const r = readTarget(s);
  expect(r, `${s} was ACCEPTED`).toHaveProperty('error');
  return 'error' in r ? r.error : '';
};
const accepted = (s: string) => {
  const r = readTarget(s);
  expect(r, `${s} was refused`).toHaveProperty('target');
  return 'target' in r ? r.target : '';
};

test('darbar cannot be its own proxy target, in any spelling of loopback', () => {
  const p = config.port;
  for (const host of ['localhost', '127.0.0.1', '127.0.0.2', '0.0.0.0', '[::1]', '[::]', '[::ffff:127.0.0.1]']) {
    expect(refused(`http://${host}:${p}`)).toContain('darbar itself');
  }
  // a base path does not launder it: the proxy forwards the request path onto whatever this is
  expect(refused(`http://127.0.0.1:${p}/api`)).toContain('darbar itself');
  expect(refused(`http://localhost.:${p}`)).toContain('darbar itself'); // trailing root label
});

test('the proxy cannot be pointed at itself either', () => {
  expect(refused(`http://127.0.0.1:${config.proxyPort}`)).toContain('the proxy itself');
  expect(refused(`http://localhost:${config.proxyPort}/x`)).toContain('the proxy itself');
});

test('an ordinary dev server on loopback is still accepted, unchanged', () => {
  const free = [5173, 3000, 8080].find((n) => n !== config.port && n !== config.proxyPort)!;
  expect(accepted(`http://localhost:${free}`)).toBe(`http://localhost:${free}`);
  expect(accepted(`http://127.0.0.1:${free}/fe`)).toBe(`http://127.0.0.1:${free}/fe`); // base path kept
  expect(accepted(` http://0.0.0.0:${free}/ `)).toBe(`http://0.0.0.0:${free}`);        // trimmed, no trailing slash
});

test('the rules this sits on top of are untouched', () => {
  expect(refused('http://192.168.1.10:5173')).toContain('private/LAN');
  expect(refused('http://169.254.169.254')).toContain('link-local');
  expect(refused('http://evil.com.localhost:5173')).toContain('DNS name');
  expect(refused('http://user:pass@localhost:5173')).toContain('userinfo');
  expect(refused('http://localhost:5173?x=1')).toContain('query string');
});
