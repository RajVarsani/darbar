// T3 Code's MCP endpoint as a full-access client: the only door for rename, queue reorder and
// fresh-context sends (the t3 CLI has none of them). Signs in the way T3's own peer link does:
// a one-time pairing code minted by the local t3 CLI, then register, decide, token.
import fs from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { config } from '@darbar/core';

const TOKEN_FILE = new URL('../../../data/ctxwatch-token.json', import.meta.url).pathname;
const REDIRECT = 'http://127.0.0.1:1/darbar-ctxwatch';
const SCOPES = ['orchestration:read', 'orchestration:operate', 'settings:write', 'source-control:write'];

export class T3ToolError extends Error {
  constructor(public tool: string, public code: string, message: string) { super(`${tool}: ${code}: ${message}`); }
}
class AuthError extends Error {}

const b64u = (b: Buffer) => b.toString('base64url');

async function cli(args: string[]): Promise<string> {
  const proc = Bun.spawn([config.t3Cli, ...args], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, T3CODE_HOME: config.t3Home } });
  const timer = setTimeout(() => proc.kill(), config.t3TimeoutMs);
  try {
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (code !== 0) throw new Error(`t3 ${args.slice(0, 2).join(' ')}: exit ${code} ${(err || out).trim().slice(0, 200)}`);
    return out;
  } finally { clearTimeout(timer); }
}

async function post(path: string, body: Record<string, unknown>, form = false): Promise<any> {
  const r = await fetch(`${config.t3Origin}${path}`, { method: 'POST', headers: { 'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json' }, body: form ? new URLSearchParams(body as Record<string, string>).toString() : JSON.stringify(body), signal: AbortSignal.timeout(config.t3TimeoutMs) });
  const text = await r.text();
  if (!r.ok) throw new Error(`${path}: ${r.status} ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

async function signIn(): Promise<{ token: string; expiresAt: number }> {
  const pairing = JSON.parse(await cli(['auth', 'pairing', 'create', ...SCOPES.flatMap((s) => ['--scope', s]), '--ttl', '5m', '--label', 'darbar ctxwatch', '--json']));
  const reg = await post('/oauth/mcp/register', { client_name: 'darbar ctxwatch', redirect_uris: [REDIRECT] });
  const verifier = b64u(randomBytes(32));
  const challenge = b64u(createHash('sha256').update(verifier).digest());
  const state = b64u(randomBytes(16));
  const resource = `${config.t3Origin}/mcp`;
  const decided = await post('/oauth/mcp/decision', {
    authorization: { response_type: 'code', client_id: reg.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', state, resource },
    decision: { _tag: 'pairing-code', access: 'full-access', code: pairing.credential },
  });
  const redirect = new URL(decided.redirectTo);
  const code = redirect.searchParams.get('code');
  if (!code || redirect.searchParams.get('state') !== state) throw new Error(`sign-in refused: ${redirect.searchParams.get('error_description') ?? 'no code'}`);
  const tok = await post('/oauth/mcp/token', { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: reg.client_id, code_verifier: verifier, resource }, true);
  return { token: tok.access_token, expiresAt: Date.now() + Math.max(0, tok.expires_in - 3600) * 1000 };
}

let token: { token: string; expiresAt: number } | null = null;
let sessionId: string | null = null;

async function ensureToken() {
  if (!token) { try { token = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')); } catch { /* none yet */ } }
  if (token && token.expiresAt > Date.now()) return token.token;
  token = await signIn();
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(token), { mode: 0o600 });
  sessionId = null;
  return token.token;
}

async function rpc(method: string, params: unknown, id: number | null, retryAuth = true): Promise<any> {
  const bearer = await ensureToken();
  const headers: Record<string, string> = { authorization: `Bearer ${bearer}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  if (sessionId) headers['mcp-session-id'] = sessionId;
  const r = await fetch(`${config.t3Origin}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', ...(id === null ? {} : { id }), method, params }), signal: AbortSignal.timeout(config.t3TimeoutMs) });
  if (r.status === 401 || r.status === 404) {
    if (!retryAuth) throw new AuthError(`mcp ${r.status}`);
    if (r.status === 401) token = null; // expired or revoked: mint again
    sessionId = null;
    return rpc(method, params, id, false);
  }
  const sid = r.headers.get('mcp-session-id');
  if (sid) sessionId = sid;
  const text = await r.text();
  if (!r.ok) throw new Error(`mcp ${method}: ${r.status} ${text.slice(0, 200)}`);
  if (id === null) return null;
  const json = text.trimStart().startsWith('{') ? text : (text.split('\n').find((l) => l.startsWith('data:')) ?? '').slice(5);
  return JSON.parse(json);
}

async function ensureSession() {
  if (sessionId) return;
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'darbar-ctxwatch', version: '1' } }, 1);
  await rpc('notifications/initialized', {}, null);
}

/** one tool call; transport failures retry with backoff, a tool-level refusal throws T3ToolError at once */
export async function callTool<T = any>(name: string, args: Record<string, unknown>): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt <= config.ctxwatchRetries; attempt++) {
    if (attempt) await Bun.sleep(config.ctxwatchBackoffMs * 2 ** (attempt - 1));
    try {
      await ensureSession();
      const res = (await rpc('tools/call', { name, arguments: args }, 2))?.result;
      if (!res) { sessionId = null; throw new Error(`mcp ${name}: empty result`); }
      if (res.isError) {
        let code = 'tool_error', msg = String(res.content?.[0]?.text ?? '');
        try { const f = JSON.parse(msg); code = f.code ?? code; msg = f.message ?? msg; } catch { /* plain text */ }
        throw new T3ToolError(name, code, msg);
      }
      return res.structuredContent as T;
    } catch (e) {
      if (e instanceof T3ToolError) throw e;
      last = e;
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}
