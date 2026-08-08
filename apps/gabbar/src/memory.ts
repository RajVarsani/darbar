// Filesystem backend for Anthropic's memory tool (memory_20250818).
// The store is a plain markdown directory (config.memoryDir) — open it in Obsidian,
// grep it, edit it by hand; Gabbar and you share the same vault.
//
// Security: every model-supplied path is resolved and must stay inside the vault
// root. Traversal (.., absolute escapes, symlinks out) is rejected.
import fs from 'node:fs';
import path from 'node:path';
import { config } from '@houston/core';
import { betaMemoryTool } from '@anthropic-ai/sdk/helpers/beta/memory';

const ROOT = path.resolve(config.memoryDir);

function resolveSafe(p: string): string {
  // the tool addresses everything under /memories
  const rel = p.replace(/^\/memories\/?/, '');
  const abs = path.resolve(ROOT, rel);
  if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) {
    throw new Error(`path escapes the memory directory: ${p}`);
  }
  return abs;
}

function listDir(abs: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.')) continue;
    if (entry.isDirectory()) {
      out.push(`${prefix}${entry.name}/`);
      out.push(...listDir(path.join(abs, entry.name), `${prefix}${entry.name}/`));
    } else {
      out.push(`${prefix}${entry.name}`);
    }
  }
  return out;
}

// injected into the system prompt so the agent knows what exists without a tool call
export function memoryTree(): string {
  try {
    const entries = listDir(ROOT);
    return entries.length ? entries.map((e) => `/memories/${e}`).join('\n') : '(empty)';
  } catch {
    return '(empty)';
  }
}

// stakeholders get their own people-file as read-only context, nothing else
export function readPersonFile(name: string): string | null {
  try {
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const abs = resolveSafe(`/memories/people/${slug}.md`);
    return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf-8') : null;
  } catch {
    return null;
  }
}

export const memoryTool = betaMemoryTool({
  async view({ path: p, view_range }) {
    const abs = resolveSafe(p);
    if (!fs.existsSync(abs)) return `${p} does not exist`;
    if (fs.statSync(abs).isDirectory()) {
      const entries = listDir(abs);
      return entries.length ? entries.join('\n') : '(empty directory)';
    }
    const lines = fs.readFileSync(abs, 'utf-8').split('\n');
    const [start = 1, end = lines.length] = view_range ?? [];
    return lines
      .slice(Math.max(0, start - 1), end)
      .map((l, i) => `${start + i}: ${l}`)
      .join('\n');
  },
  async create({ path: p, file_text }) {
    const abs = resolveSafe(p);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, file_text);
    return `created ${p}`;
  },
  async str_replace({ path: p, old_str, new_str }) {
    const abs = resolveSafe(p);
    const content = fs.readFileSync(abs, 'utf-8');
    const count = content.split(old_str).length - 1;
    if (count === 0) return `old_str not found in ${p}`;
    if (count > 1) return `old_str matches ${count} times in ${p}; make it unique`;
    fs.writeFileSync(abs, content.replace(old_str, new_str ?? ''));
    return `edited ${p}`;
  },
  async insert({ path: p, insert_line, insert_text }) {
    const abs = resolveSafe(p);
    const lines = fs.readFileSync(abs, 'utf-8').split('\n');
    lines.splice(insert_line, 0, insert_text);
    fs.writeFileSync(abs, lines.join('\n'));
    return `inserted into ${p}`;
  },
  async delete({ path: p }) {
    const abs = resolveSafe(p);
    if (abs === ROOT) return 'refusing to delete the memory root';
    fs.rmSync(abs, { recursive: true, force: true });
    return `deleted ${p}`;
  },
  async rename({ old_path, new_path }) {
    const from = resolveSafe(old_path);
    const to = resolveSafe(new_path);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.renameSync(from, to);
    return `renamed ${old_path} -> ${new_path}`;
  },
});
