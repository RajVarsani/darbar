#!/usr/bin/env python3
"""One-off migration: file-based memory stores -> the live darbar memory graph (DAR-278).

Sources (read-only):
  1. claude   ~/.claude/projects/-Users-raj-all-things-saturn-everything-saturn-v2/memory/*.md
              137 files, YAML frontmatter (name, description, metadata.type), body has
              [[wikilinks]] and "**Why:**"/"**How to apply:**" lines. MEMORY.md is an index, skipped.
  2. gabbar   darbar/data/memory/ vault: index.md (index, skipped), workspace.md, people/*.md,
              projects/*.md. Plain markdown, no frontmatter -- one node per file.
  3. repo     ~/all-things-saturn/saturn-agent-memory/*.md, 12 notes (+ MEMORY.md/AGENTS.md,
              both skipped; index-area51.md is an index, skipped). Same frontmatter shape as (1),
              two files (letters-v15-adoption-catalogue.md, letters-page-settings-feasibility.md)
              have none -- filename + first H1 stand in for name/description.

Target: POST /api/memory/remember and POST /api/memory/supersede on the live server
(http://127.0.0.1:4899 by default). Shapes read from apps/server/src/api.ts (~3400-3800) and
apps/mcp/src/server.ts tool descriptions -- READ ONLY, never edited by this script.

Two passes, because an edge's `to` must already exist as a node:
  pass 1: remember() every node (source-type -> graph node type, see TYPE_MAP / infer_type)
  pass 2: for every [[wikilink]] in a body, RELATES_TO edge iff the target's slug now exists
          as a node (source={harness: "migration", session: "scripts/migrate-memory.py"})

Idempotent: remember() already dedupes nodes by slug. Observations are appended, never
overwritten, so this script checks (via recall) whether a same-text observation is already on
the node before sending it again, so a rerun is a no-op on the node content, and edges are
already an upsert on the server side (resend, no duplication) -- see api.ts's edge-upsert block.

Flags:
  --dry-run   (default) print node/edge counts + first 10 nodes per source, write nothing
  --apply     actually POST to the server
  --source    claude | gabbar | repo | all (default all)
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

API_BASE = "http://127.0.0.1:4899/api"

CLAUDE_DIR = Path(
    "/Users/raj/.claude/projects/-Users-raj-all-things-saturn-everything-saturn-v2/memory"
)
GABBAR_DIR = Path("/Users/raj/fafo/darbar/data/memory")
REPO_DIR = Path("/Users/raj/all-things-saturn/saturn-agent-memory")

MEMORY_NODE_TYPES = ("decision", "gotcha", "person", "service", "repo", "project", "preference", "reference")

# source frontmatter type -> graph node type. DAR-284: "reference" now has a direct match in
# MEMORY_NODE_TYPES (a URL/dashboard/ticket is not a decision). Anything not in this map is
# skipped by the call sites below (logged into plan.unparsed) rather than written under a guess.
TYPE_MAP = {
    "user": "preference",
    "feedback": "gotcha",
    "project": "project",
    "reference": "reference",
}

WIKILINK_RE = re.compile(r"\[\[([^\]|#]+)")
PREFIX_RE = re.compile(r"\b([A-Z]{2,8})-\d+\b")


def slugify(name: str) -> str:
    """Must match packages/core/src/types.ts slugify() exactly, or dedupe silently breaks."""
    s = name.strip().lower()
    s = re.sub(r"[^a-z0-9]+", "-", s)
    return s.strip("-")


@dataclass
class Node:
    name: str
    type: str
    project: Optional[str]  # a project prefix, or None for global
    observation: str
    source_tag: str  # which of claude/gabbar/repo this came from
    origin_file: str
    body_for_links: str = ""

    @property
    def slug(self) -> str:
        return slugify(self.name)


@dataclass
class Plan:
    nodes: list = field(default_factory=list)
    edges: list = field(default_factory=list)  # (from_name, to_name, project)
    unparsed: list = field(default_factory=list)


# ---------- frontmatter ----------

def parse_frontmatter(text: str) -> tuple[dict, str]:
    """Minimal parser for this repo's one frontmatter shape: flat key: value pairs, plus a
    `metadata:` block whose own keys are 2-space indented. Not general YAML on purpose --
    the corpus never nests deeper than that, and a general parser is not stdlib anyway.
    """
    if not text.startswith("---"):
        return {}, text
    lines = text.split("\n")
    if lines[0].strip() != "---":
        return {}, text
    end = None
    for i in range(1, len(lines)):
        if lines[i].strip() == "---":
            end = i
            break
    if end is None:
        return {}, text
    meta: dict = {}
    in_metadata = False
    for raw in lines[1:end]:
        if not raw.strip():
            continue
        if not raw.startswith(" ") and ":" in raw:
            in_metadata = raw.split(":", 1)[0].strip() == "metadata"
            key, _, val = raw.partition(":")
            val = val.strip()
            if val:
                meta[key.strip()] = _unquote(val)
            continue
        if in_metadata and raw.startswith(" ") and ":" in raw:
            key, _, val = raw.strip().partition(":")
            val = val.strip()
            if val:
                meta.setdefault("metadata", {})[key.strip()] = _unquote(val)
    body = "\n".join(lines[end + 1 :]).strip()
    return meta, body


def _unquote(v: str) -> str:
    if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
        return v[1:-1]
    return v


# ---------- project inference ----------

def infer_project(name: str, body: str, meta: dict, folder_hint: Optional[str], live_projects: set) -> Optional[str]:
    fm_project = meta.get("project") or meta.get("metadata", {}).get("project")
    if fm_project:
        up = fm_project.strip().upper()
        if up in live_projects:
            return up
    m = PREFIX_RE.search(name)
    if m and m.group(1) in live_projects:
        return m.group(1)
    if folder_hint:
        up = folder_hint.strip().upper()
        if up in live_projects:
            return up
    # last resort: any DAR-/LPVOF-/MRF-style prefix anywhere in the body
    m = PREFIX_RE.search(body)
    if m and m.group(1) in live_projects:
        return m.group(1)
    return None


# ---------- source 1: claude memory ----------

def load_claude(live_projects: set, plan: Plan) -> None:
    if not CLAUDE_DIR.is_dir():
        plan.unparsed.append(f"{CLAUDE_DIR} (directory missing)")
        return
    for f in sorted(CLAUDE_DIR.glob("*.md")):
        if f.name == "MEMORY.md":
            continue
        try:
            text = f.read_text()
        except Exception as e:
            plan.unparsed.append(f"{f} (read error: {e})")
            continue
        meta, body = parse_frontmatter(text)
        name = meta.get("name") or f.stem
        description = meta.get("description")
        src_type = meta.get("metadata", {}).get("type")
        if not src_type or src_type not in TYPE_MAP:
            plan.unparsed.append(f"{f} (unrecognized metadata.type: {src_type!r})")
            continue
        node_type = TYPE_MAP[src_type]
        obs = body
        if description and description not in body:
            obs = f"{description}\n\n{body}"
        project = infer_project(name, body, meta, None, live_projects)
        plan.nodes.append(
            Node(name=name, type=node_type, project=project, observation=obs.strip(),
                 source_tag="claude", origin_file=str(f), body_for_links=body)
        )


# ---------- source 2: gabbar vault ----------

def _title_from_body(text: str, fallback: str) -> str:
    for line in text.split("\n"):
        line = line.strip()
        if line.startswith("#"):
            return line.lstrip("#").strip()
    return fallback


def load_gabbar(live_projects: set, plan: Plan) -> None:
    if not GABBAR_DIR.is_dir():
        plan.unparsed.append(f"{GABBAR_DIR} (directory missing)")
        return
    for f in sorted(GABBAR_DIR.glob("*.md")) + sorted((GABBAR_DIR / "people").glob("*.md")) + sorted(
        (GABBAR_DIR / "projects").glob("*.md")
    ):
        if f.name == "index.md":
            continue
        try:
            text = f.read_text()
        except Exception as e:
            plan.unparsed.append(f"{f} (read error: {e})")
            continue
        rel = f.relative_to(GABBAR_DIR)
        folder = rel.parts[0] if len(rel.parts) > 1 else None
        if folder == "people":
            node_type = "person"
            name = _title_from_body(text, f.stem.replace("-", " ").title())
            project = infer_project(name, text, {}, None, live_projects)
        elif folder == "projects":
            node_type = "project"
            name = _title_from_body(text, f.stem.upper())
            project = infer_project(name, text, {}, f.stem, live_projects)
        else:
            # workspace.md and any future top-level vault file: a global process/decision note.
            node_type = "decision"
            name = _title_from_body(text, f.stem)
            project = infer_project(name, text, {}, None, live_projects)
        plan.nodes.append(
            Node(name=name, type=node_type, project=project, observation=text.strip(),
                 source_tag="gabbar", origin_file=str(f), body_for_links=text)
        )


# ---------- source 3: saturn-agent-memory ----------

def load_repo(live_projects: set, plan: Plan) -> None:
    if not REPO_DIR.is_dir():
        plan.unparsed.append(f"{REPO_DIR} (directory missing)")
        return
    skip = {"MEMORY.md", "AGENTS.md", "index-area51.md"}
    for f in sorted(REPO_DIR.glob("*.md")):
        if f.name in skip:
            continue
        try:
            text = f.read_text()
        except Exception as e:
            plan.unparsed.append(f"{f} (read error: {e})")
            continue
        meta, body = parse_frontmatter(text)
        name = meta.get("name") or f.stem
        description = meta.get("description")
        src_type = meta.get("metadata", {}).get("type")
        if not src_type:
            # no frontmatter at all (2 known files): name from filename, first H1 as description
            name = f.stem
            description = _title_from_body(text, f.stem)
            src_type = "reference"
            body = text
        if src_type not in TYPE_MAP:
            plan.unparsed.append(f"{f} (unrecognized metadata.type: {src_type!r})")
            continue
        node_type = TYPE_MAP[src_type]
        obs = body
        if description and description not in body:
            obs = f"{description}\n\n{body}"
        project = infer_project(name, body, meta, None, live_projects)
        plan.nodes.append(
            Node(name=name, type=node_type, project=project, observation=obs.strip(),
                 source_tag="repo", origin_file=str(f), body_for_links=body)
        )


SOURCE_LOADERS = {"claude": load_claude, "gabbar": load_gabbar, "repo": load_repo}


# ---------- HTTP ----------

def api_get(path: str, base: str) -> dict:
    with urllib.request.urlopen(f"{base}{path}") as resp:
        return json.loads(resp.read())


def api_post(path: str, body: dict, base: str) -> dict:
    data = json.dumps(body).encode()
    req = urllib.request.Request(f"{base}{path}", data=data, method="POST",
                                  headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")
        raise RuntimeError(f"POST {path} -> {e.code}: {detail}") from e


def fetch_live_projects(base: str) -> set:
    try:
        projects = api_get("/projects", base)
    except Exception:
        return set()
    return {p.get("prefix", "").upper() for p in projects if p.get("prefix")}


# ---------- broad-count probe (no dedicated count endpoint exists on the memory API) ----------

BROAD_PROBES = ["darbar", "saturn", "raj", "the", "memory", "project", "fix", "build", "data", "work"]


def probe_node_count(base: str) -> int:
    seen = set()
    for q in BROAD_PROBES:
        try:
            r = api_get(f"/memory/recall?q={urllib.request.quote(q)}&limit=50&hops=1", base)
        except Exception:
            continue
        for n in r.get("nodes", []):
            seen.add((n.get("name"), n.get("project")))
    return len(seen)


# ---------- observation-dedupe for idempotent --apply ----------

def existing_observation_texts(base: str, node: Node) -> set:
    project_q = f"&project={urllib.request.quote(node.project)}" if node.project else ""
    try:
        r = api_get(f"/memory/recall?q={urllib.request.quote(node.name)}&limit=50&hops=1{project_q}", base)
    except Exception:
        return set()
    for n in r.get("nodes", []):
        if n.get("name") == node.name and slugify(n.get("name", "")) == node.slug:
            return {o.get("text") for o in n.get("observations", [])}
    return set()


# ---------- main ----------

def build_plan(sources: list, live_projects: set) -> Plan:
    plan = Plan()
    for s in sources:
        SOURCE_LOADERS[s](live_projects, plan)
    return plan


def collect_edges(plan: Plan) -> list:
    slugs = {n.slug for n in plan.nodes}
    edges = []
    for n in plan.nodes:
        targets = {slugify(t) for t in WIKILINK_RE.findall(n.body_for_links)}
        for t_slug in targets:
            if t_slug == n.slug:
                continue
            if t_slug in slugs:
                target_name = next(x.name for x in plan.nodes if x.slug == t_slug)
                edges.append((n, target_name))
    return edges


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dry-run", action="store_true", help="default; print what would happen, write nothing")
    ap.add_argument("--apply", action="store_true", help="actually write to the memory graph")
    ap.add_argument("--source", choices=["claude", "gabbar", "repo", "all"], default="all")
    ap.add_argument("--base", default=API_BASE, help=f"API base (default {API_BASE})")
    args = ap.parse_args()

    apply = args.apply
    dry_run = not apply
    sources = list(SOURCE_LOADERS) if args.source == "all" else [args.source]

    live_projects = fetch_live_projects(args.base)
    print(f"live project prefixes: {sorted(live_projects) or '(none / server unreachable)'}")

    before = probe_node_count(args.base)
    print(f"before (broad-probe node count, lower bound, no count endpoint exists): {before}")

    plan = build_plan(sources, live_projects)
    edges = collect_edges(plan)

    per_source: dict = {}
    for n in plan.nodes:
        per_source.setdefault(n.source_tag, []).append(n)

    print(f"\n{'DRY RUN' if dry_run else 'APPLY'} -- {len(plan.nodes)} node(s), {len(edges)} edge(s) planned across {len(sources)} source(s)")
    for tag, nodes in per_source.items():
        print(f"\n== {tag}: {len(nodes)} node(s) ==")
        for n in nodes[:10]:
            proj = n.project or "global"
            print(f"  [{n.type}/{proj}] {n.name}  ({n.origin_file})")
        if len(nodes) > 10:
            print(f"  ... and {len(nodes) - 10} more")

    if plan.unparsed:
        print(f"\ncould not parse {len(plan.unparsed)} file(s):")
        for u in plan.unparsed:
            print(f"  - {u}")

    print(f"\nedges (RELATES_TO) planned: {len(edges)}")
    for n, target in edges[:10]:
        print(f"  {n.name} -> {target}")
    if len(edges) > 10:
        print(f"  ... and {len(edges) - 10} more")

    if dry_run:
        print(f"\nafter (dry run, nothing written): {before}")
        print("\nrerun with --apply to write. --source narrows to one of claude/gabbar/repo.")
        return 0

    # ---------- pass 1: nodes ----------
    written_nodes = 0
    for n in plan.nodes:
        already = existing_observation_texts(args.base, n)
        obs = [] if n.observation in already else [n.observation]
        body = {"node": {"name": n.name, "type": n.type, **({"project": n.project} if n.project else {})}}
        if obs:
            body["observations"] = obs
        api_post("/memory/remember", body, args.base)
        written_nodes += 1

    # ---------- pass 2: edges ----------
    written_edges = 0
    for n, target in edges:
        body = {
            "node": {"name": n.name, "type": n.type, **({"project": n.project} if n.project else {})},
            "edges": [
                {
                    "to": target,
                    "relation": "RELATES_TO",
                    "source": {"harness": "migration", "session": "scripts/migrate-memory.py"},
                }
            ],
        }
        api_post("/memory/remember", body, args.base)
        written_edges += 1

    after = probe_node_count(args.base)
    print(f"\nwrote {written_nodes} node(s), {written_edges} edge(s)")
    print(f"after (broad-probe node count, lower bound): {after}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
