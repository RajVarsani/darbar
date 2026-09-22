#!/usr/bin/env python3
"""Render deploy/agents/roles.toml into Claude Code and Codex agent definitions.

    deploy/agents/install.py                 # user scope: ~/.claude/agents, ~/.codex/agents
    deploy/agents/install.py --project DIR   # project scope: DIR/.claude/agents, DIR/.codex/agents,
                                             # merging DIR/.darbar/roles.toml over the defaults
    deploy/agents/install.py --uninstall

One source, two renderings. The orchestrator dispatches by role name (darbar-builder,
darbar-reviewer, darbar-researcher) and never picks a model: the role carries its tier, the
tier carries the model per harness, so a dispatch cannot inherit the flagship by silence.
"""
import argparse, os, sys, tomllib, textwrap

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULTS = os.path.join(HERE, "roles.toml")


def merge(base, over):
    out = dict(base)
    for k, v in over.items():
        out[k] = merge(base[k], v) if isinstance(v, dict) and isinstance(base.get(k), dict) else v
    return out


def load(project):
    cfg = tomllib.load(open(DEFAULTS, "rb"))
    if project:
        p = os.path.join(project, ".darbar", "roles.toml")
        if os.path.exists(p):
            cfg = merge(cfg, tomllib.load(open(p, "rb")))
    return cfg


def claude_md(name, role, cfg):
    tier, tools = cfg["tiers"][role["tier"]], cfg["toolsets"][role["toolset"]]
    fm = [f"name: {name}", f"description: {role['description']}", f"model: {tier['claude']}",
          f"effort: {role['effort']}", f"maxTurns: {role['max_turns']}",
          f"tools: {', '.join(tools['claude'])}"]
    if role["mcp"]:
        fm.append("mcpServers:")
        fm += [f"  - {m}" for m in role["mcp"]]
    return "---\n" + "\n".join(fm) + "\n---\n" + role["brief"].strip() + "\n"


def codex_toml(name, role, cfg):
    tier, tools = cfg["tiers"][role["tier"]], cfg["toolsets"][role["toolset"]]
    q = lambda s: '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'
    lines = [f"name = {q(name)}", f"description = {q(role['description'])}",
             f"model = {q(tier['codex'])}", f"model_reasoning_effort = {q(role['effort'])}",
             f"sandbox_mode = {q(tools['codex'])}",
             "mcp_servers = [" + ", ".join(q(m) for m in role["mcp"]) + "]",
             'developer_instructions = """', role["brief"].strip(), '"""']
    return "\n".join(lines) + "\n"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--project")
    ap.add_argument("--uninstall", action="store_true")
    a = ap.parse_args()
    root = a.project or os.path.expanduser("~")
    claude_dir = os.path.join(root, ".claude", "agents")
    codex_dir = os.path.join(root, ".codex", "agents")
    cfg = load(a.project)
    for role_name in cfg["roles"]:
        name = f"darbar-{role_name}"
        paths = [os.path.join(claude_dir, f"{name}.md"), os.path.join(codex_dir, f"{name}.toml")]
        if a.uninstall:
            for p in paths:
                if os.path.exists(p): os.remove(p); print("removed", p)
            continue
        role = cfg["roles"][role_name]
        os.makedirs(claude_dir, exist_ok=True); os.makedirs(codex_dir, exist_ok=True)
        open(paths[0], "w").write(claude_md(name, role, cfg))
        open(paths[1], "w").write(codex_toml(name, role, cfg))
        tier = cfg["tiers"][role["tier"]]
        print(f"{name:<18} claude={tier['claude']:<8} codex={tier['codex']:<14} turns={role['max_turns']} mcp={role['mcp']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
