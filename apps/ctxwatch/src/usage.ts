// Per-thread context usage straight from T3's own projection: every provider turn carries
// tokenUsage { usedTokens, maxTokens } for every agent, so there is nothing to scrape.
import { Database } from 'bun:sqlite';
import { config } from '@darbar/core';

let db: Database | null = null;
const open = () => (db ??= new Database(config.t3StateDb, { readonly: true }));

export type ThreadRow = { id: string; title: string; relationship: string | null };
export type Usage = { session: string; used: number; max: number; pct: number; model: string | null };

export function liveThreads(sinceIso: string): ThreadRow[] {
  const rows = open().query(
    `SELECT thread_id AS id, title, json_extract(payload_json,'$.lineage.relationshipToParent') AS relationship
       FROM orchestration_v2_projection_threads
      WHERE deleted_at IS NULL AND archived_at IS NULL AND updated_at >= ?`,
  ).all(sinceIso) as ThreadRow[];
  return rows;
}

export function latestUsage(threadId: string): Usage | null {
  const r = open().query(
    `SELECT provider_thread_id AS session,
            json_extract(payload_json,'$.tokenUsage.usedTokens') AS used,
            json_extract(payload_json,'$.tokenUsage.maxTokens') AS max,
            json_extract(payload_json,'$.model') AS model
       FROM orchestration_v2_projection_provider_turns
      WHERE thread_id = ? AND json_extract(payload_json,'$.tokenUsage.usedTokens') IS NOT NULL
      ORDER BY COALESCE(started_at, completed_at) DESC LIMIT 1`,
  ).get(threadId) as { session: string; used: number; max: number | null; model: string | null } | null;
  if (!r) return null;
  const max = r.max && r.max > 0 ? r.max : (r.model ? config.ctxwatchWindows[r.model] : 0) ?? 0;
  if (!max) return null;
  return { session: r.session, used: r.used, max, pct: (r.used / max) * 100, model: r.model };
}

export function runStatus(runId: string): string | null {
  const r = open().query(`SELECT status FROM orchestration_v2_projection_runs WHERE run_id = ?`).get(runId) as { status: string } | null;
  return r?.status ?? null;
}

export function currentTitle(threadId: string): string | null {
  const r = open().query(`SELECT title FROM orchestration_v2_projection_threads WHERE thread_id = ?`).get(threadId) as { title: string } | null;
  return r?.title ?? null;
}
