from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import re
import sqlite3
import time
from typing import Any

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

try:  # Optional: local neural TTS. ``/audio/generate`` returns 502 when unavailable.
    from .audio_tts import synthesize_dialogue_mp3

    TTS_AVAILABLE = True
except ImportError:  # pragma: no cover - exercised when no TTS backend is installed
    TTS_AVAILABLE = False

    def synthesize_dialogue_mp3(turns: list[dict[str, str]], out_path: Path) -> Any:
        raise RuntimeError(
            "No neural TTS backend is installed. Install `edge-tts` or `pocket-tts` to enable audio synthesis."
        )

try:  # Optional: real AST graph engine. Falls back to a deterministic built-in extractor.
    from graphify.analyze import (
        god_nodes as graphify_god_nodes,
        suggest_questions as graphify_suggest_questions,
        surprising_connections as graphify_surprising_connections,
    )
    from graphify.build import build_from_json as graphify_build_from_json
    from graphify.cluster import cluster as graphify_cluster, score_all as graphify_score_all
    from graphify.detect import detect as graphify_detect
    from graphify.export import to_canvas as graphify_to_canvas, to_json as graphify_to_json
    from graphify.extract import collect_files as graphify_collect_files, extract as graphify_extract
    from graphify.report import generate as graphify_generate
    from graphify.wiki import to_wiki as graphify_to_wiki

    GRAPHIFY_AVAILABLE = True
except ImportError:  # pragma: no cover - exercised when graphify extra is not installed
    import ast as _ast

    GRAPHIFY_AVAILABLE = False

    class _FallbackGraph:
        """Minimal directed-graph stand-in for graphify's networkx graph."""

        def __init__(self) -> None:
            self.nodes: dict[str, dict[str, Any]] = {}
            self.edges: list[tuple[str, str, str]] = []
            self._adj: dict[str, set[str]] = {}

        def add_node(self, nid: str, **attrs: Any) -> None:
            self.nodes.setdefault(nid, {}).update(attrs)
            self._adj.setdefault(nid, set())

        def add_edge(self, src: str, tgt: str, relation: str = "references") -> None:
            if src == tgt:
                return
            self.edges.append((src, tgt, relation))
            self._adj.setdefault(src, set()).add(tgt)

        def __contains__(self, nid: object) -> bool:
            return nid in self.nodes

        def number_of_nodes(self) -> int:
            return len(self.nodes)

        def number_of_edges(self) -> int:
            return len(self.edges)

        def degree(self, nid: str) -> int:
            out = len(self._adj.get(nid, set()))
            inc = sum(1 for _s, t, _r in self.edges if t == nid)
            return out + inc

    def graphify_collect_files(root: Path) -> list[Path]:
        exts = {".py", ".js", ".jsx", ".ts", ".tsx", ".go", ".rs", ".java", ".md", ".rb", ".c", ".cpp", ".h"}
        collected: list[Path] = []
        for path in sorted(Path(root).rglob("*")):
            if path.is_file() and path.suffix.lower() in exts:
                collected.append(path)
        return collected

    def graphify_extract(files: list[Path], root: Path | None = None) -> dict[str, Any]:
        defs: list[dict[str, Any]] = []
        calls: list[dict[str, Any]] = []
        for fp in files:
            try:
                text = Path(fp).read_text(encoding="utf-8", errors="ignore")
            except Exception:
                continue
            rel = str(fp)
            if str(fp).endswith(".py"):
                try:
                    tree = _ast.parse(text)
                except SyntaxError:
                    continue
                for node in _ast.walk(tree):
                    if isinstance(node, (_ast.FunctionDef, _ast.AsyncFunctionDef, _ast.ClassDef)):
                        defs.append({"name": node.name, "file": rel, "line": getattr(node, "lineno", 0)})
                    if isinstance(node, _ast.Call):
                        fn = node.func
                        name = fn.id if isinstance(fn, _ast.Name) else (fn.attr if isinstance(fn, _ast.Attribute) else None)
                        if name:
                            calls.append({"name": name, "file": rel, "line": getattr(node, "lineno", 0)})
            else:
                for m in re.finditer(r"(?:function|class|def|const|let|var)\s+([A-Za-z_][A-Za-z0-9_]*)", text):
                    defs.append({"name": m.group(1), "file": rel, "line": text[: m.start()].count(chr(10)) + 1})
        return {"files": [str(f) for f in files], "definitions": defs, "calls": calls, "input_tokens": 0, "output_tokens": 0}

    def graphify_build_from_json(extraction: dict[str, Any], root: Path | None = None) -> _FallbackGraph:
        G = _FallbackGraph()
        by_name: dict[str, str] = {}
        for d in extraction.get("definitions") or []:
            nid = f"{d.get('file')}:{d.get('name')}"
            by_name[str(d.get("name"))] = nid
            G.add_node(
                nid,
                label=str(d.get("name")),
                node_kind="symbol",
                source_file=str(d.get("file")),
                source_location=str(d.get("line")),
                file_type=str(d.get("file", "")).rsplit(".", 1)[-1],
            )
        for c in extraction.get("calls") or []:
            tgt = by_name.get(str(c.get("name")))
            caller = next((nid for name, nid in by_name.items() if name in str(c.get("file"))), None)
            src = f"{c.get('file')}:{c.get('name')}"
            G.add_node(src, label=str(c.get("name")), node_kind="call", source_file=str(c.get("file")), source_location=str(c.get("line")))
            if tgt:
                G.add_edge(src, tgt, "calls")
        return G

    def graphify_cluster(G: Any) -> dict[int, list[str]]:
        labels = sorted(G.nodes.keys())
        buckets: dict[int, list[str]] = {}
        for idx, nid in enumerate(labels):
            buckets.setdefault(idx % max(1, min(8, len(labels) or 1)), []).append(nid)
        return buckets

    def graphify_score_all(G: Any, communities: dict[int, list[str]]) -> dict[int, float]:
        return {cid: round(len(nodes) / max(1, G.number_of_nodes()), 4) for cid, nodes in communities.items()}

    def graphify_god_nodes(G: Any, limit: int = 10) -> list[dict[str, Any]]:
        ranked = sorted(G.nodes.keys(), key=lambda nid: G.degree(nid), reverse=True)[:limit]
        return [{"id": nid, "label": G.nodes[nid].get("label", nid), "degree": G.degree(nid)} for nid in ranked]

    def graphify_surprising_connections(G: Any, communities: dict[int, list[str]], limit: int = 10) -> list[dict[str, Any]]:
        node_comm = {nid: cid for cid, nodes in communities.items() for nid in nodes}
        out: list[dict[str, Any]] = []
        for src, tgt, rel in G.edges:
            if node_comm.get(src) != node_comm.get(tgt):
                out.append({"source": src, "target": tgt, "relation": rel})
            if len(out) >= limit:
                break
        return out

    def graphify_suggest_questions(G: Any, communities: dict[int, list[str]], labels: dict[int, str], limit: int = 8) -> list[str]:
        return [f"What couples {labels.get(cid, f'cluster {cid}')} to the rest of the system?" for cid in list(communities)[:limit]]

    def graphify_detect(root: Path) -> dict[str, Any]:
        files = graphify_collect_files(root)
        return {"total_files": len(files), "total_words": 0, "warning": None, "unclassified": []}

    def graphify_generate(G: Any, communities: dict[int, list[str]], cohesion: dict[int, float], community_labels: dict[int, str], god_nodes_list: list[dict[str, Any]], surprises: list[dict[str, Any]], detection_result: dict[str, Any], token_cost: dict[str, Any], target: str, suggested_questions: list[Any] | None = None) -> str:
        lines = [
            f"# Knowledge Graph Report — {target}",
            "",
            f"**Nodes:** {G.number_of_nodes()} · **Edges:** {G.number_of_edges()} · **Communities:** {len(communities)}",
            "",
            "## God Nodes",
        ]
        lines += [f"- {n.get('label', n.get('id'))} (degree {n.get('degree', 0)})" for n in god_nodes_list] or ["- _(none)_"]
        lines += ["", "## Communities"]
        lines += [f"- **{community_labels.get(cid, f'Cluster {cid}')}** — {len(nodes)} nodes, cohesion {cohesion.get(cid, 0)}" for cid, nodes in communities.items()] or ["- _(none)_"]
        lines += ["", "## Surprising Connections"]
        lines += [f"- `{s.get('source')}` → `{s.get('target')}` ({s.get('relation')})" for s in surprises] or ["- _(none)_"]
        lines += ["", "_Generated by the built-in deterministic AST extractor (graphify not installed)._"]
        return "\n".join(lines)

    def graphify_to_json(G: Any, communities: dict[int, list[str]], out_path: str, force: bool = True, community_labels: dict[int, str] | None = None) -> None:
        community_labels = community_labels or {}
        node_comm = {nid: cid for cid, nodes in communities.items() for nid in nodes}
        payload = {
            "nodes": [
                {
                    "id": nid,
                    "label": attrs.get("label", nid),
                    "node_kind": attrs.get("node_kind", "symbol"),
                    "source_file": attrs.get("source_file", ""),
                    "source_location": attrs.get("source_location", ""),
                    "file_type": attrs.get("file_type", ""),
                    "community": community_labels.get(node_comm.get(nid), node_comm.get(nid, 0)),
                }
                for nid, attrs in G.nodes.items()
            ],
            "links": [{"source": s, "target": t, "relation": r, "confidence": "EXTRACTED"} for s, t, r in G.edges],
        }
        Path(out_path).write_text(json.dumps(payload, indent=2), encoding="utf-8")

    def graphify_to_canvas(G: Any, communities: dict[int, list[str]], out_path: str, community_labels: dict[int, str] | None = None) -> None:
        Path(out_path).write_text(json.dumps({"nodes": list(G.nodes.keys()), "edges": G.edges}, indent=2), encoding="utf-8")

    def graphify_to_wiki(G: Any, communities: dict[int, list[str]], wiki_dir: Path, community_labels: dict[int, str] | None = None, cohesion: dict[int, float] | None = None, god_nodes_data: list[dict[str, Any]] | None = None) -> int:
        community_labels = community_labels or {}
        wiki_path = Path(wiki_dir)
        wiki_path.mkdir(parents=True, exist_ok=True)
        count = 0
        for cid, nodes in communities.items():
            title = community_labels.get(cid, f"Cluster {cid}")
            body = [f"# {title}", "", f"*Part of the graphify knowledge wiki* — {len(nodes)} nodes.", "", "## Symbols"]
            body += [f"- `{nid}`" for nid in nodes[:60]]
            slug = re.sub(r"[^a-zA-Z0-9._-]+", "-", str(title).lower()).strip("-") or f"cluster-{cid}"
            (wiki_path / f"{slug}.md").write_text("\n".join(body), encoding="utf-8")
            count += 1
        return count

from . import config
from .db import db_session, row_to_dict, utc_now_iso
from .memory import GatewayLLMClient, hybrid_search, resolve_active_llm_runtime
from .profiles import OWNER_PROFILE_ID, get_active_profile

router = APIRouter(prefix="/api/cognitive", tags=["cognitive"])

VAULT_FOLDERS = ("wiki", "raw", "daily", "decisions")
HERMES_MEMORY_LIMIT = 2200
HERMES_USER_LIMIT = 1375

def _build_cognitive_schema_sql(default_profile_id: str) -> str:
    safe_pid = re.sub(r"[^a-zA-Z0-9._-]+", "-", default_profile_id or "default") or "default"
    return f"""
CREATE TABLE IF NOT EXISTS flashcards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id TEXT NOT NULL DEFAULT '{safe_pid}',
    deck TEXT NOT NULL DEFAULT 'Knowledge Vault',
    front TEXT NOT NULL,
    back TEXT NOT NULL,
    source_ref TEXT NOT NULL DEFAULT '',
    tags_json TEXT NOT NULL DEFAULT '[]',
    ease_factor REAL DEFAULT 2.5,
    interval_days REAL DEFAULT 0,
    repetitions INTEGER DEFAULT 0,
    due_at TEXT,
    last_reviewed_at TEXT,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_flashcards_due ON flashcards(due_at, deck);

CREATE TABLE IF NOT EXISTS audio_briefings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id TEXT NOT NULL DEFAULT '{safe_pid}',
    title TEXT NOT NULL,
    mode TEXT NOT NULL,
    script_json TEXT NOT NULL DEFAULT '[]',
    mp3_path TEXT NOT NULL,
    duration_est_sec INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id TEXT NOT NULL DEFAULT '{safe_pid}',
    title TEXT NOT NULL,
    decision TEXT NOT NULL,
    alternatives_ruled_out TEXT NOT NULL DEFAULT '',
    rationale TEXT NOT NULL DEFAULT '',
    repo TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS learned_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id TEXT NOT NULL DEFAULT '{safe_pid}',
    category TEXT NOT NULL,
    rule_text TEXT NOT NULL,
    confidence REAL DEFAULT 0.9,
    active INTEGER DEFAULT 1,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS wiki_tensions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id TEXT NOT NULL DEFAULT '{safe_pid}',
    topic TEXT NOT NULL,
    page_a TEXT NOT NULL,
    page_b TEXT NOT NULL,
    conflict TEXT NOT NULL,
    suggested_resolution TEXT NOT NULL DEFAULT '',
    status TEXT DEFAULT 'open',
    created_at TEXT NOT NULL
);
"""

ACTIVE_SKILLS = [
    {
        "id": "karpathy-llm-wiki",
        "name": "Knowledge Wiki Compiler",
        "category": "Knowledge Vault",
        "status": "active",
        "description": "Compiles raw notes, transcripts, and URLs into cross-linked [[wikilink]] knowledge pages, updating index.md and log.md.",
    },
    {
        "id": "graphify-ast-mapper",
        "name": "AST & Knowledge Graph Mapper",
        "category": "Knowledge Graph",
        "status": "active",
        "description": "Deterministic tree-sitter AST extraction, community clustering, hub centrality, and 3D knowledge graph fusion.",
    },
    {
        "id": "hermes-second-brain",
        "name": "Persistent Profile Memory",
        "category": "Memory",
        "status": "active",
        "description": "Maintains bounded MEMORY.md (~2200 chars), USER.md (~1375 chars), and persistent learned rules across sessions.",
    },
    {
        "id": "deep-grounded-research",
        "name": "Deep Grounded Research",
        "category": "Research",
        "status": "active",
        "description": "Runs RRF hybrid FTS5 + embedding + Vault search with deterministic numbered citations [1..N].",
    },
    {
        "id": "multi-model-council",
        "name": "Multi-Model Consensus Council",
        "category": "Reasoning",
        "status": "active",
        "description": "Queries configured council models in parallel and synthesizes consensus and trade-offs.",
    },
    {
        "id": "jev-system1-triage",
        "name": "Fast System-1 Signal Triage",
        "category": "Triage",
        "status": "active",
        "description": "Sub-second classification of urgency (P0-P3), domain, intent, and skill routing.",
    },
    {
        "id": "notebooklm-audio-studio",
        "name": "Two-Host Neural Audio Studio",
        "category": "Audio & Docs",
        "status": "active",
        "description": "Generates Alex & Maya two-host natural neural MP3 dialogues via local neural TTS and cited study guides / FAQs / mindmaps.",
    },
    {
        "id": "anki-sm2-srs",
        "name": "Spaced Repetition Flashcards",
        "category": "Retention",
        "status": "active",
        "description": "Generates high-yield flashcards from notes/code and schedules reviews using SM-2 ease & interval math.",
    },
    {
        "id": "tension-contradiction-detector",
        "name": "Tension & Contradiction Detector",
        "category": "Wiki Hygiene",
        "status": "active",
        "description": "Lints the vault for orphan pages, broken wikilinks, and semantic contradictions against architecture decisions.",
    },
    {
        "id": "temporal-decision-ledger",
        "name": "Temporal Decision Ledger",
        "category": "Architecture",
        "status": "active",
        "description": "Records architectural decisions, ruled-out alternatives, and rationale into SQLite + vault/decisions/*.md.",
    },
    {
        "id": "pr-review-2phase-fixer",
        "name": "PR Review 2-Phase Fixer",
        "category": "Engineering",
        "status": "active",
        "description": "Isolated worktree review fixing, test verification, review replies, and board status staging.",
    },
    {
        "id": "post-call-15m-intelligence",
        "name": "Post-Call +15m Intelligence",
        "category": "Meetings",
        "status": "active",
        "description": "Extracts summary, My Todos vs Waiting On Others, and follow-up drafts 15 minutes after meetings.",
    },
]

DEFAULT_INDEX_MD = """# Command Engine Knowledge Vault Index

Master catalog of compiled knowledge pages in `vault/wiki/`.

## Core Architecture
- [[command-engine-architecture]] — Personal Intelligence OS orchestration, SQLite FTS5 + semantic RAG, and outbound approval guardrails.

## Operating Playbooks
- *(Compile new raw notes or deep research reports to grow this index automatically.)*
"""

DEFAULT_LOG_MD = """# Knowledge Vault Activity Log

Chronological ledger of vault ingestions, manual edits, architectural decisions, and lint passes.
"""

DEFAULT_MEMORY_MD = """# Command Engine — Workspace & Architecture Memory

- **Runtime:** Local-first Personal Intelligence OS — FastAPI backend, React/Tauri desktop shell, and SQLite + FTS5 hybrid memory in `data/command_engine.db`.
- **AI Routing:** Supports OpenAI-compatible gateways, OpenAI, Anthropic, Google Gemini, local Ollama / LM Studio runtimes, and key-free Limited Mode.
- **Safety Guardrails:**
  1. Strict ownership scoping: only execute or stage actions on items owned by or explicitly assigned to the active operator profile.
  2. Outbound Approval Gate: external messages, git pushes, PR creation/replies, and board changes always stage in Approval Studio unless explicitly approved.
  3. Isolated `.worktrees/<repo>/<branch-slug>` sandboxes for all automated code changes and test runs.
"""

DEFAULT_USER_MD = """# Operator Profile — Preferences & Working Cadence

- **Role:** Workspace Owner & Principal Operator.
- **Schedule Defaults:** Weekday Morning Briefing 08:30, End-of-Day Wrap-Up 18:00, Delta Sync every 30m.
- **Communication Style:** Concise, direct, bullet-first executive & senior engineering tone; zero fluff. Cite exact repositories, PR/issue numbers, channels, and file paths.
"""


def _safe_profile_slug(profile_id: str) -> str:
    cleaned = re.sub(r"[^a-zA-Z0-9._-]+", "-", (profile_id or "").strip()).strip(".-")
    return cleaned or "default"


def _active_profile_context() -> tuple[str, dict[str, Any]]:
    try:
        with db_session() as conn:
            prof = get_active_profile(conn)
            pid = str(prof.get("id") or OWNER_PROFILE_ID)
            return pid, prof
    except Exception:
        return OWNER_PROFILE_ID, {"id": OWNER_PROFILE_ID}


def _resolve_profile_id(profile_id: str | None = None) -> str:
    if profile_id and str(profile_id).strip():
        return str(profile_id).strip()
    pid, _ = _active_profile_context()
    return pid


def _profile_workspace_base(profile_id: str | None = None) -> Path | None:
    pid = _resolve_profile_id(profile_id)
    if pid == OWNER_PROFILE_ID:
        return None
    return config.DATA_DIR / "workspaces" / _safe_profile_slug(pid)


def _vault_root(profile_id: str | None = None) -> Path:
    base = _profile_workspace_base(profile_id)
    if base is not None:
        return base / "vault"
    return config.WORKSPACE_ROOT / "vault"


def _audio_dir(profile_id: str | None = None) -> Path:
    base = _profile_workspace_base(profile_id)
    if base is not None:
        return base / "audio"
    return config.DATA_DIR / "audio"


def _graphify_dir(profile_id: str | None = None) -> Path:
    base = _profile_workspace_base(profile_id)
    if base is not None:
        return base / "graphify-out"
    return config.DATA_DIR / "graphify-out"


def _wiki_ast_dir(profile_id: str | None = None) -> Path:
    base = _profile_workspace_base(profile_id)
    if base is not None:
        return base / "code-graph" / "wiki_ast"
    return config.DATA_DIR / "code-graph" / "wiki_ast"


def _build_profile_starter_seeds(profile_id: str, profile: dict[str, Any]) -> dict[str, str]:
    display_name = str(profile.get("display_name") or "Workspace Owner").strip()
    brand = str(profile.get("brand_display_name") or "Command Engine").strip()
    org = str(profile.get("org_name") or "Local Workspace").strip()
    role = str(profile.get("role_title") or "Principal Operator").strip()
    tz = str(profile.get("timezone") or "UTC").strip()
    posture = str(profile.get("autonomy_posture") or "prepare").strip()
    voice = str(profile.get("voice_style") or "concise, direct, technical, zero-fluff").strip()
    repos = profile.get("core_repos") if isinstance(profile.get("core_repos"), dict) else {}
    repo_lines = "\n".join(
        f"  - `{cfg.get('full_name') or key}`"
        for key, cfg in list(repos.items())[:8]
        if isinstance(cfg, dict)
    )
    repos_block = f"- **Tracked Repositories:**\n{repo_lines}\n" if repo_lines else "- **Tracked Repositories:** *(Configure in Settings -> Repositories)*\n"

    clean_index = (
        f"# {brand} Knowledge Vault Index\n\n"
        "Master catalog of compiled knowledge pages in `vault/wiki/`.\n\n"
        "## Topics\n"
        "- *(Compile new raw notes or deep research reports to grow this index automatically.)*\n"
    )
    clean_memory = (
        f"# {brand} — Workspace & Architecture Memory\n\n"
        f"- **Profile:** {display_name} ({org})\n"
        f"- **Autonomy Posture:** `{posture}` (outbound actions gated via Approval Studio)\n"
        f"{repos_block}"
        "- **Notes:** Record key architecture, repositories, decisions, and operating conventions here.\n"
    )[:HERMES_MEMORY_LIMIT]
    clean_user = (
        f"# Operator Profile — {display_name}\n\n"
        f"- **Role:** {role}\n"
        f"- **Organization:** {org}\n"
        f"- **Timezone:** {tz} (Weekday Briefings: 08:30 & 18:00)\n"
        f"- **Communication Style:** {voice}\n"
    )[:HERMES_USER_LIMIT]
    return {
        "index.md": clean_index,
        "log.md": DEFAULT_LOG_MD,
        "MEMORY.md": clean_memory if len(clean_memory) >= 110 else DEFAULT_MEMORY_MD[:HERMES_MEMORY_LIMIT],
        "USER.md": clean_user if len(clean_user) >= 110 else DEFAULT_USER_MD[:HERMES_USER_LIMIT],
    }


_VAULT_FTS_CACHE: dict[str, Any] = {"key": None}


def _invalidate_vault_fts_cache() -> None:
    _VAULT_FTS_CACHE["key"] = None


def _ensure_cognitive_column(conn: sqlite3.Connection, table: str, column: str, definition: str) -> None:
    cols = {str(r["name"]) for r in conn.execute(f"PRAGMA table_info({table})").fetchall()}
    if column not in cols:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")


def init_cognitive_storage(profile_id: str | None = None) -> None:
    """Ensure vault/data directories, seeded memory/wiki markdown files, and SQLite tables exist."""
    default_pid = OWNER_PROFILE_ID
    with db_session() as conn:
        conn.executescript(_build_cognitive_schema_sql(default_pid))
        for tbl in ("flashcards", "audio_briefings", "decisions", "learned_rules", "wiki_tensions"):
            _ensure_cognitive_column(conn, tbl, "profile_id", f"TEXT NOT NULL DEFAULT '{default_pid}'")
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_flashcards_profile_due ON flashcards(profile_id, due_at, deck)"
        )
        vault_fts_cols = {
            str(r["name"])
            for r in conn.execute("PRAGMA table_info(vault_notes_fts)").fetchall()
        }
        if vault_fts_cols and "profile_id" not in vault_fts_cols:
            conn.execute("DROP TABLE IF EXISTS vault_notes_fts")
        conn.execute(
            """
            CREATE VIRTUAL TABLE IF NOT EXISTS vault_notes_fts USING fts5(
                profile_id UNINDEXED,
                folder,
                slug,
                title,
                content_md,
                tags
            );
            """
        )
        conn.execute("DELETE FROM audio_briefings WHERE mp3_path = ''")

        try:
            active_prof = get_active_profile(conn)
            active_pid = str(active_prof.get("id") or OWNER_PROFILE_ID)
        except Exception:
            active_prof = {"id": OWNER_PROFILE_ID}
            active_pid = OWNER_PROFILE_ID
        pid = str(profile_id).strip() if profile_id and str(profile_id).strip() else active_pid
        prof = active_prof if pid == active_pid else {"id": pid}

    vault = _vault_root(pid)
    for sub in VAULT_FOLDERS:
        (vault / sub).mkdir(parents=True, exist_ok=True)
    _audio_dir(pid).mkdir(parents=True, exist_ok=True)
    _graphify_dir(pid).mkdir(parents=True, exist_ok=True)
    _wiki_ast_dir(pid).mkdir(parents=True, exist_ok=True)

    seeds = _build_profile_starter_seeds(pid, prof)
    for filename, content in seeds.items():
        path = vault / filename
        if not path.exists():
            path.write_text(content, encoding="utf-8")


def _sync_vault_fts(
    notes: list[dict[str, Any]],
    profile_id: str,
    cache_key: tuple[Any, ...] | None = None,
) -> None:
    if cache_key is not None and _VAULT_FTS_CACHE.get("key") == cache_key:
        return
    try:
        with db_session() as conn:
            conn.execute("DELETE FROM vault_notes_fts WHERE profile_id = ?", (profile_id,))
            for n in notes:
                conn.execute(
                    "INSERT INTO vault_notes_fts(profile_id, folder, slug, title, content_md, tags) VALUES (?, ?, ?, ?, ?, ?)",
                    (
                        profile_id,
                        str(n["folder"]),
                        str(n["slug"]),
                        str(n["title"]),
                        str(n["content_md"]),
                        " ".join(n.get("tags") or []),
                    ),
                )
        if cache_key is not None:
            _VAULT_FTS_CACHE["key"] = cache_key
    except Exception:
        pass


def _slugify(value: str, default: str = "note") -> str:
    cleaned = re.sub(r"[^a-zA-Z0-9_-]+", "-", (value or "").strip().lower()).strip("-_")
    return cleaned[:80] or default


def _validate_folder_and_slug(folder: str, slug: str) -> tuple[str, str]:
    if folder not in VAULT_FOLDERS:
        raise HTTPException(status_code=400, detail=f"Invalid vault folder '{folder}'. Must be one of {VAULT_FOLDERS}.")
    if not slug or "/" in slug or "\\" in slug or ".." in slug:
        raise HTTPException(status_code=400, detail="Invalid note slug.")
    safe_slug = re.sub(r"[^a-zA-Z0-9._-]+", "-", slug.strip()).strip(".-")
    if not safe_slug:
        raise HTTPException(status_code=400, detail="Invalid note slug.")
    return folder, safe_slug


def _strip_frontmatter(text: str) -> tuple[dict[str, str], str]:
    if not text.startswith("---"):
        return {}, text
    lines = text.splitlines()
    if len(lines) < 3:
        return {}, text
    end_idx = None
    for idx in range(1, len(lines)):
        if lines[idx].strip() == "---":
            end_idx = idx
            break
    if end_idx is None:
        return {}, text
    meta: dict[str, str] = {}
    for line in lines[1:end_idx]:
        if ":" in line:
            k, v = line.split(":", 1)
            meta[k.strip().lower()] = v.strip().strip('"').strip("'")
    body = "\n".join(lines[end_idx + 1 :]).lstrip("\n")
    return meta, body


def _extract_title_and_excerpt(slug: str, content_md: str) -> tuple[str, str]:
    meta, body = _strip_frontmatter(content_md)
    title = meta.get("title", "")
    body_lines = body.splitlines()
    if not title:
        for line in body_lines:
            s = line.strip()
            if s.startswith("# "):
                title = s[2:].strip()
                break
    if not title:
        title = slug.replace("-", " ").replace("_", " ").title()

    excerpt_parts: list[str] = []
    for line in body_lines:
        s = line.strip()
        if not s or s.startswith("#") or s.startswith("---"):
            continue
        excerpt_parts.append(s)
        if sum(len(p) for p in excerpt_parts) >= 200:
            break
    excerpt = " ".join(excerpt_parts)[:220]
    return title, excerpt


def _parse_wikilinks(content_md: str) -> list[str]:
    raw_links = re.findall(r"\[\[([^\[\]]+)\]\]", content_md or "")
    seen: list[str] = []
    for raw in raw_links:
        target = raw.split("|", 1)[0].split("#", 1)[0].strip()
        if "/" in target:
            target = target.rsplit("/", 1)[-1].strip()
        if target.endswith(".md"):
            target = target[:-3]
        if target and target not in seen:
            seen.append(target)
    return seen


def _parse_tags(content_md: str) -> list[str]:
    _, body = _strip_frontmatter(content_md or "")
    matches = re.findall(r"(?:^|[\s,(])#([A-Za-z][A-Za-z0-9_-]{1,40})\b", body)
    seen: list[str] = []
    for tag in matches:
        low = tag.lower()
        if low not in seen:
            seen.append(low)
    return seen


_GRAPHIFY_SLUG_PREFIXES = (
    "cognitive_router-_",
    "db-_",
    "main-_",
    "safety-_",
    "profiles-_",
    "missions-_",
    "integrations_router-_",
    "executor-_",
    "memory-_",
)


def _classify_note_origin(folder: str, slug: str, content_md: str) -> str:
    text = content_md or ""
    lower_text = text.lower()

    # 1. Check Graphify AST markers first
    if (
        "*Part of the graphify knowledge wiki" in text
        or "> God node ·" in text
        or "> Auto-generated by graphify" in text
        or re.search(r"^>\s*\d+\s+nodes\s+·\s+cohesion", text, re.M)
        or slug.startswith(_GRAPHIFY_SLUG_PREFIXES)
        or ("## Connections by Relation" in text and "`EXTRACTED`" in text)
    ):
        return "generated_ast"

    # 2. Check explicit AI-compiled / AI-generated markers
    if (
        "<!-- origin: ai_compiled -->" in lower_text
        or "origin: ai_compiled" in lower_text
        or "generated_by: llm_wiki_compiler" in lower_text
        or "ai_generated: true" in lower_text
        or re.search(r"(?im)^(?:origin|generated_by)\s*:\s*(?:ai|llm|agent)", text)
        or "Compiled from [[" in text
    ):
        return "ai_compiled"

    # 3. Check explicit verified human author metadata ONLY
    if (
        "<!-- origin: verified_human -->" in lower_text
        or re.search(r"(?im)^\s*verified_author\s*:\s*true\b", text)
        or re.search(r"(?im)^\s*authorship\s*:\s*verified_human\b", text)
    ):
        return "verified_human"

    # 4. Otherwise classify by folder
    if folder == "decisions":
        return "decision"
    if folder == "raw":
        return "raw_evidence"
    if folder == "daily":
        return "daily"
    return "curated_unverified"


def _scan_vault_notes(folder_filter: str = "all", profile_id: str | None = None) -> list[dict[str, Any]]:
    pid = _resolve_profile_id(profile_id)
    init_cognitive_storage(pid)
    vault = _vault_root(pid)
    ast_dir = _wiki_ast_dir(pid)
    notes: list[dict[str, Any]] = []
    seen_keys: set[tuple[str, str]] = set()
    max_mtime_ns = 0

    def _collect_md_file(folder: str, md_file: Path, forced_origin: str | None = None) -> None:
        nonlocal max_mtime_ns
        slug = md_file.stem
        key = (folder, slug)
        if key in seen_keys:
            return
        seen_keys.add(key)
        content_md = md_file.read_text(encoding="utf-8", errors="ignore")
        title, excerpt = _extract_title_and_excerpt(slug, content_md)
        links_out = _parse_wikilinks(content_md)
        tags = _parse_tags(content_md)
        origin_kind = forced_origin or _classify_note_origin(folder, slug, content_md)
        stat = md_file.stat()
        if stat.st_mtime_ns > max_mtime_ns:
            max_mtime_ns = stat.st_mtime_ns
        updated_at = datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat()
        notes.append(
            {
                "slug": slug,
                "folder": folder,
                "title": title,
                "content_md": content_md,
                "tags": tags,
                "links_out": links_out,
                "backlinks": [],
                "updated_at": updated_at,
                "excerpt": excerpt,
                "origin_kind": origin_kind,
            }
        )

    for folder in VAULT_FOLDERS:
        folder_dir = vault / folder
        if not folder_dir.exists():
            continue
        for md_file in sorted(folder_dir.glob("*.md")):
            _collect_md_file(folder, md_file)

    if ast_dir.exists():
        for md_file in sorted(ast_dir.glob("*.md")):
            _collect_md_file("wiki", md_file, forced_origin="generated_ast")

    # Index notes by slug and normalized title for reverse backlink resolution
    lookup: dict[str, list[dict[str, Any]]] = {}
    for n in notes:
        keys = {
            n["slug"].lower(),
            _slugify(n["slug"]),
            _slugify(n["title"]),
            n["title"].strip().lower(),
        }
        for k in keys:
            if k:
                lookup.setdefault(k, []).append(n)

    for src in notes:
        src_ref = {"slug": src["slug"], "folder": src["folder"], "title": src["title"]}
        for target_raw in src["links_out"]:
            t_keys = (target_raw.lower(), _slugify(target_raw))
            matched: list[dict[str, Any]] = []
            for k in t_keys:
                if k in lookup:
                    matched.extend(lookup[k])
                    break
            for tgt in matched:
                if tgt["slug"] == src["slug"] and tgt["folder"] == src["folder"]:
                    continue
                if src_ref not in tgt["backlinks"]:
                    tgt["backlinks"].append(src_ref)

    if folder_filter == "all":
        fts_cache_key = (pid, str(config.DB_PATH), str(vault), str(ast_dir), max_mtime_ns, len(notes))
        _sync_vault_fts(notes, pid, cache_key=fts_cache_key)
    if folder_filter and folder_filter != "all":
        notes = [n for n in notes if n["folder"] == folder_filter]
    notes.sort(key=lambda x: x["updated_at"], reverse=True)
    return notes


def _append_vault_log(action: str, detail: str, profile_id: str | None = None) -> None:
    log_path = _vault_root(profile_id) / "log.md"
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M")
    entry = f"\n## [{ts}] {action} | {detail}\n"
    existing = log_path.read_text(encoding="utf-8") if log_path.exists() else DEFAULT_LOG_MD
    log_path.write_text(existing.rstrip() + "\n" + entry, encoding="utf-8")


def _update_vault_index(pages: list[dict[str, Any]], profile_id: str | None = None) -> None:
    index_path = _vault_root(profile_id) / "index.md"
    existing = index_path.read_text(encoding="utf-8") if index_path.exists() else ""
    lines = existing.splitlines()
    for p in pages:
        slug = str(p.get("slug") or "").strip()
        if not slug:
            continue
        summary = str(p.get("summary_one_line") or p.get("title") or slug).strip()
        marker = f"[[{slug}]]"
        new_line = f"- {marker} — {summary}"
        replaced = False
        for i, ln in enumerate(lines):
            if marker in ln:
                lines[i] = new_line
                replaced = True
                break
        if not replaced:
            lines.append(new_line)
    index_path.write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")


def _parse_llm_json(raw: str) -> dict[str, Any]:
    txt = (raw or "").strip()
    if txt.startswith("```"):
        txt = re.sub(r"^```(?:json)?\s*", "", txt)
        txt = re.sub(r"\s*```$", "", txt)
    try:
        parsed = json.loads(txt)
        return parsed if isinstance(parsed, dict) else {"data": parsed}
    except Exception:
        match = re.search(r"\{.*\}", txt, flags=re.DOTALL)
        if match:
            try:
                parsed = json.loads(match.group(0))
                if isinstance(parsed, dict):
                    return parsed
            except Exception:
                pass
    return {}


# ---------------------------------------------------------------------------
# Request Schemas
# ---------------------------------------------------------------------------


class VaultNotePutRequest(BaseModel):
    title: str | None = None
    content_md: str


class WikiCompileRequest(BaseModel):
    title: str
    source_type: str = "note"
    raw_content: str
    source_url: str = ""


class GraphifyRunRequest(BaseModel):
    target: str = "command-engine"
    export_wiki: bool = False


class FlashcardGenerateRequest(BaseModel):
    deck: str = "Knowledge Vault"
    source_title: str
    source_text: str
    count: int = Field(default=6, ge=1, le=20)


class FlashcardReviewRequest(BaseModel):
    rating: int = Field(..., ge=1, le=4)


class AudioGenerateRequest(BaseModel):
    title: str = "Executive Audio Overview"
    mode: str = "morning_briefing"
    source_text: str = ""


class NotebookSynthesizeRequest(BaseModel):
    title: str
    format: str = "study_guide"
    source_slugs: list[str] = Field(default_factory=list)
    extra_context: str = ""


class JevTriageRequest(BaseModel):
    text: str


class CouncilRequest(BaseModel):
    prompt: str


class ResearchRequest(BaseModel):
    query: str
    file_to_wiki: bool = False


class HermesMemoryUpdateRequest(BaseModel):
    memory_md: str | None = None
    user_md: str | None = None


class HermesRuleCreateRequest(BaseModel):
    category: str
    rule_text: str


class DecisionCreateRequest(BaseModel):
    title: str
    decision: str
    alternatives_ruled_out: str = ""
    rationale: str = ""
    repo: str = ""


# ---------------------------------------------------------------------------
# 1. Overview
# ---------------------------------------------------------------------------


@router.get("/overview")
def get_cognitive_overview() -> dict[str, Any]:
    pid = _resolve_profile_id()
    init_cognitive_storage(pid)
    notes = _scan_vault_notes("all", profile_id=pid)
    wiki_pages = sum(1 for n in notes if n["folder"] == "wiki")
    raw_sources = sum(1 for n in notes if n["folder"] == "raw")

    now_iso = utc_now_iso()
    with db_session() as conn:
        total_flashcards = conn.execute(
            "SELECT COUNT(*) AS c FROM flashcards WHERE profile_id = ?",
            (pid,),
        ).fetchone()["c"]
        due_flashcards = conn.execute(
            "SELECT COUNT(*) AS c FROM flashcards WHERE profile_id = ? AND (due_at IS NULL OR due_at <= ?)",
            (pid, now_iso),
        ).fetchone()["c"]
        audio_count = conn.execute(
            "SELECT COUNT(*) AS c FROM audio_briefings WHERE profile_id = ?",
            (pid,),
        ).fetchone()["c"]
        decisions_count = conn.execute(
            "SELECT COUNT(*) AS c FROM decisions WHERE profile_id = ?",
            (pid,),
        ).fetchone()["c"]
        rules_count = conn.execute(
            "SELECT COUNT(*) AS c FROM learned_rules WHERE profile_id = ? AND active = 1",
            (pid,),
        ).fetchone()["c"]
        tensions_count = conn.execute(
            "SELECT COUNT(*) AS c FROM wiki_tensions WHERE profile_id = ? AND status = 'open'",
            (pid,),
        ).fetchone()["c"]

    graph_nodes = 0
    graph_edges = 0
    graph_path = _graphify_dir(pid) / "graph.json"
    if graph_path.exists():
        try:
            gdata = json.loads(graph_path.read_text(encoding="utf-8"))
            graph_nodes = len(gdata.get("nodes") or [])
            graph_edges = len(gdata.get("links") or gdata.get("edges") or [])
        except Exception:
            pass

    resurface = [
        {
            "slug": n["slug"],
            "folder": n["folder"],
            "title": n["title"],
            "excerpt": n["excerpt"],
            "updated_at": n["updated_at"],
            "origin_kind": n.get("origin_kind", "curated_unverified"),
        }
        for n in notes
        if n.get("origin_kind") != "generated_ast"
    ][:5]

    return {
        "stats": {
            "vault_notes": len(notes),
            "wiki_pages": wiki_pages,
            "raw_sources": raw_sources,
            "due_flashcards": due_flashcards,
            "total_flashcards": total_flashcards,
            "audio_briefings": audio_count,
            "decisions_count": decisions_count,
            "learned_rules": rules_count,
            "graph_nodes": graph_nodes,
            "graph_edges": graph_edges,
            "tensions_count": tensions_count,
        },
        "resurface_notes": resurface,
        "skills": ACTIVE_SKILLS,
    }


# ---------------------------------------------------------------------------
# 2. Knowledge Vault & Wiki Compiler
# ---------------------------------------------------------------------------


@router.get("/vault/notes")
def list_vault_notes(folder: str = Query(default="all")) -> dict[str, Any]:
    if folder != "all" and folder not in VAULT_FOLDERS:
        raise HTTPException(status_code=400, detail=f"Invalid folder '{folder}'.")
    pid = _resolve_profile_id()
    notes = _scan_vault_notes(folder, profile_id=pid)
    items = [
        {
            "slug": n["slug"],
            "folder": n["folder"],
            "title": n["title"],
            "tags": n["tags"],
            "links_out": n["links_out"],
            "backlinks": n["backlinks"],
            "updated_at": n["updated_at"],
            "excerpt": n["excerpt"],
            "origin_kind": n.get("origin_kind")
            or _classify_note_origin(n["folder"], n["slug"], n.get("content_md", "")),
        }
        for n in notes
    ]
    vault = _vault_root(pid)
    index_md = (vault / "index.md").read_text(encoding="utf-8") if (vault / "index.md").exists() else ""
    log_md = (vault / "log.md").read_text(encoding="utf-8") if (vault / "log.md").exists() else ""
    return {"items": items, "index_md": index_md, "log_md": log_md}


@router.get("/vault/note/{folder}/{slug}")
def get_vault_note(folder: str, slug: str) -> dict[str, Any]:
    folder, safe_slug = _validate_folder_and_slug(folder, slug)
    pid = _resolve_profile_id()
    notes = _scan_vault_notes("all", profile_id=pid)
    for n in notes:
        if n["folder"] == folder and n["slug"] == safe_slug:
            return {
                "slug": n["slug"],
                "folder": n["folder"],
                "title": n["title"],
                "content_md": n["content_md"],
                "tags": n["tags"],
                "links_out": n["links_out"],
                "backlinks": n["backlinks"],
                "updated_at": n["updated_at"],
                "origin_kind": n.get("origin_kind")
                or _classify_note_origin(n["folder"], n["slug"], n.get("content_md", "")),
            }
    raise HTTPException(status_code=404, detail=f"Vault note '{folder}/{safe_slug}' not found.")


@router.put("/vault/note/{folder}/{slug}")
def put_vault_note(folder: str, slug: str, req: VaultNotePutRequest) -> dict[str, Any]:
    from .safety import SafetyViolationError, resolve_safe_child

    pid = _resolve_profile_id()
    init_cognitive_storage(pid)
    folder, safe_slug = _validate_folder_and_slug(folder, slug)
    try:
        note_path = resolve_safe_child(_vault_root(pid) / folder, safe_slug, suffix=".md")
    except SafetyViolationError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    content_to_write = req.content_md
    if req.title and not content_to_write.lstrip().startswith("#") and not content_to_write.lstrip().startswith("---"):
        content_to_write = f"# {req.title.strip()}\n\n{content_to_write}"

    note_path.write_text(content_to_write, encoding="utf-8")
    _invalidate_vault_fts_cache()
    if folder == "wiki":
        title, _ = _extract_title_and_excerpt(safe_slug, content_to_write)
        _append_vault_log("edit", f"[[{safe_slug}]] ({title})", profile_id=pid)

    return get_vault_note(folder, safe_slug)


@router.delete("/vault/note/{folder}/{slug}")
def delete_vault_note(folder: str, slug: str) -> dict[str, Any]:
    from .safety import SafetyViolationError, resolve_safe_child

    pid = _resolve_profile_id()
    init_cognitive_storage(pid)
    folder, safe_slug = _validate_folder_and_slug(folder, slug)
    try:
        note_path = resolve_safe_child(_vault_root(pid) / folder, safe_slug, suffix=".md")
    except SafetyViolationError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    if not note_path.exists() and folder == "wiki":
        try:
            ast_candidate = resolve_safe_child(_wiki_ast_dir(pid), safe_slug, suffix=".md")
            if ast_candidate.exists():
                note_path = ast_candidate
        except SafetyViolationError:
            pass

    if not note_path.exists():
        raise HTTPException(status_code=404, detail=f"Vault note '{folder}/{safe_slug}' not found.")
    note_path.unlink()
    _invalidate_vault_fts_cache()
    _append_vault_log("delete", f"Removed {folder}/{safe_slug}.md", profile_id=pid)
    _scan_vault_notes("all", profile_id=pid)
    return {"deleted": True, "folder": folder, "slug": safe_slug}


@router.post("/wiki/compile")
async def compile_wiki_endpoint(req: WikiCompileRequest) -> dict[str, Any]:
    pid = _resolve_profile_id()
    init_cognitive_storage(pid)
    vault = _vault_root(pid)
    base_slug = _slugify(req.title, "source")
    raw_slug = base_slug
    raw_path = vault / "raw" / f"{raw_slug}.md"
    if raw_path.exists():
        ts_suffix = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
        raw_slug = f"{base_slug}-{ts_suffix}"
        raw_path = vault / "raw" / f"{raw_slug}.md"

    now_iso = utc_now_iso()
    raw_md = (
        f"---\n"
        f'title: "{req.title.replace(chr(34), "")}"\n'
        f"source_type: {req.source_type}\n"
        f"source_url: {req.source_url}\n"
        f"ingested_at: {now_iso}\n"
        f"---\n\n"
        f"# {req.title}\n\n"
        f"{req.raw_content.strip()}\n"
    )
    raw_path.write_text(raw_md, encoding="utf-8")

    existing_index = (vault / "index.md").read_text(encoding="utf-8") if (vault / "index.md").exists() else ""
    system_prompt = (
        "You are the Command Engine Knowledge Wiki Compiler. "
        "Synthesize raw source material into clean, atomic, densely interlinked Obsidian markdown wiki pages using `[[wikilinks]]` and `#tags`. "
        "Return STRICT JSON ONLY with schema:\n"
        '{"pages": [{"slug": "kebab-case-slug", "title": "Page Title", "summary_one_line": "Crisp 1-sentence summary", '
        '"content_md_with_wikilinks": "# Page Title\\n\\nMarkdown with [[wikilinks]] and #tags..."}], '
        '"key_takeaways": ["string"]}'
    )
    user_prompt = (
        f"Source Title: {req.title}\n"
        f"Source Type: {req.source_type}\n"
        f"Raw Slug: [[{raw_slug}]]\n"
        f"Source URL: {req.source_url}\n\n"
        f"Existing Vault Index:\n{existing_index[:3000]}\n\n"
        f"Raw Content:\n{req.raw_content[:20000]}"
    )

    llm = GatewayLLMClient()
    raw_resp = await llm.chief_of_staff_synthesize(system_prompt, user_prompt, json_mode=True)
    parsed = _parse_llm_json(raw_resp)
    pages_in = parsed.get("pages") or []
    key_takeaways = [str(x) for x in (parsed.get("key_takeaways") or [])]

    if not pages_in:
        pages_in = [
            {
                "slug": base_slug,
                "title": req.title,
                "summary_one_line": req.raw_content.strip().splitlines()[0][:140] if req.raw_content.strip() else req.title,
                "content_md_with_wikilinks": f"# {req.title}\n\nCompiled from [[{raw_slug}]].\n\n{req.raw_content.strip()}",
            }
        ]

    written_pages: list[dict[str, Any]] = []
    for p in pages_in:
        p_slug = _slugify(str(p.get("slug") or p.get("title") or base_slug), base_slug)
        p_title = str(p.get("title") or p_slug.replace("-", " ").title()).strip()
        p_summary = str(p.get("summary_one_line") or p_title).strip()
        p_content = str(p.get("content_md_with_wikilinks") or f"# {p_title}\n").strip()
        if f"[[{raw_slug}]]" not in p_content:
            p_content = f"{p_content}\n\n## Sources\n- [[{raw_slug}]]\n"
        if "<!-- origin: ai_compiled -->" not in p_content.lower():
            p_content = f"<!-- origin: ai_compiled -->\n\n{p_content.lstrip()}"
        wiki_path = vault / "wiki" / f"{p_slug}.md"
        wiki_path.write_text(p_content.rstrip() + "\n", encoding="utf-8")
        written_pages.append(
            {
                "slug": p_slug,
                "title": p_title,
                "summary_one_line": p_summary,
                "content_md_with_wikilinks": p_content,
            }
        )

    _invalidate_vault_fts_cache()
    _update_vault_index(written_pages, profile_id=pid)
    _append_vault_log("ingest", f"{req.title} (raw: [[{raw_slug}]], pages: {', '.join(p['slug'] for p in written_pages)})", profile_id=pid)

    return {
        "raw_slug": raw_slug,
        "pages": written_pages,
        "key_takeaways": key_takeaways,
    }


@router.post("/wiki/lint")
async def lint_wiki_endpoint() -> dict[str, Any]:
    pid = _resolve_profile_id()
    init_cognitive_storage(pid)
    all_notes = _scan_vault_notes("all", profile_id=pid)
    wiki_notes = [n for n in all_notes if n["folder"] == "wiki" and n.get("origin_kind") != "generated_ast"]

    known_targets: set[str] = set()
    for n in all_notes:
        known_targets.add(n["slug"].lower())
        known_targets.add(_slugify(n["slug"]))
        known_targets.add(_slugify(n["title"]))
        known_targets.add(n["title"].strip().lower())

    orphan_pages = [
        str(n["slug"])
        for n in wiki_notes
        if len(n["backlinks"]) == 0
    ]

    broken_links: list[dict[str, str]] = []
    for n in all_notes:
        for link in n["links_out"]:
            if link.lower() not in known_targets and _slugify(link) not in known_targets:
                broken_links.append({"source": f"{n['folder']}/{n['slug']}", "target": link})

    with db_session() as conn:
        decisions_rows = [
            row_to_dict(r)
            for r in conn.execute(
                "SELECT id, title, decision, rationale, repo, status FROM decisions WHERE profile_id = ? ORDER BY created_at DESC LIMIT 20",
                (pid,),
            ).fetchall()
        ]

    wiki_summaries = [
        {
            "slug": n["slug"],
            "title": n["title"],
            "excerpt": n["excerpt"],
            "links_out": n["links_out"],
            "content_preview": n["content_md"][:600],
        }
        for n in wiki_notes[:25]
    ]

    tensions: list[dict[str, Any]] = []
    suggested_bridges: list[str] = []
    if wiki_summaries or decisions_rows:
        system_prompt = (
            "You are the Knowledge Vault Tension & Contradiction Detector. "
            "Compare wiki pages and architectural decisions for contradictions, stale claims, or missing cross-links. "
            "Return STRICT JSON ONLY:\n"
            '{"tensions": [{"topic": "string", "page_a": "slug or decision", "page_b": "slug or decision", '
            '"conflict": "string", "suggested_resolution": "string"}], "suggested_bridges": ["string"]}'
        )
        user_prompt = (
            f"Wiki Pages:\n{json.dumps(wiki_summaries, indent=2)}\n\n"
            f"Architecture Decisions:\n{json.dumps(decisions_rows, indent=2)}\n\n"
            f"Orphan Pages: {json.dumps(orphan_pages)}\n"
            f"Broken Links: {json.dumps(broken_links)}"
        )
        llm = GatewayLLMClient()
        raw_resp = await llm.chief_of_staff_synthesize(system_prompt, user_prompt, json_mode=True)
        parsed = _parse_llm_json(raw_resp)
        tensions = list(parsed.get("tensions") or [])
        suggested_bridges = [str(b) for b in (parsed.get("suggested_bridges") or [])]

        now_iso = utc_now_iso()
        with db_session() as conn:
            for t in tensions:
                topic = str(t.get("topic") or "Vault Conflict").strip()
                page_a = str(t.get("page_a") or "").strip()
                page_b = str(t.get("page_b") or "").strip()
                conflict = str(t.get("conflict") or "").strip()
                resolution = str(t.get("suggested_resolution") or "").strip()
                if not conflict:
                    continue
                exists = conn.execute(
                    "SELECT id FROM wiki_tensions WHERE profile_id = ? AND topic = ? AND page_a = ? AND page_b = ? AND status = 'open'",
                    (pid, topic, page_a, page_b),
                ).fetchone()
                if not exists:
                    conn.execute(
                        """
                        INSERT INTO wiki_tensions(profile_id, topic, page_a, page_b, conflict, suggested_resolution, status, created_at)
                        VALUES (?, ?, ?, ?, ?, ?, 'open', ?)
                        """,
                        (pid, topic, page_a, page_b, conflict, resolution, now_iso),
                    )

    _append_vault_log(
        "lint",
        f"orphans={len(orphan_pages)}, broken_links={len(broken_links)}, tensions={len(tensions)}",
        profile_id=pid,
    )

    return {
        "orphan_pages": orphan_pages,
        "broken_links": broken_links,
        "tensions": tensions,
        "suggested_bridges": suggested_bridges,
    }


# ---------------------------------------------------------------------------
# 3. AST & Unified 3D Knowledge Graph
# ---------------------------------------------------------------------------


def _resolve_graphify_target(target: str, profile_id: str | None = None, profile: dict[str, Any] | None = None) -> Path:
    pid = _resolve_profile_id(profile_id)
    if profile is None:
        _, profile = _active_profile_context()
    key = (target or "command-engine").strip().lower()
    repos_cfg = profile.get("core_repos") if isinstance(profile.get("core_repos"), dict) else {}
    if not repos_cfg and pid == OWNER_PROFILE_ID:
        repos_cfg = config.CORE_REPOS
    if key == "command-engine":
        path = config.WORKSPACE_ROOT / "backend" / "app"
    elif key == "vault":
        path = _vault_root(pid)
    elif key in {k.lower(): k for k in repos_cfg}:
        matched_key = {k.lower(): k for k in repos_cfg}[key]
        local_path = str((repos_cfg[matched_key] or {}).get("local_path") or "").strip()
        if not local_path:
            raise HTTPException(status_code=404, detail=f"Repository '{target}' has no configured local_path.")
        root_dir = Path(local_path)
        candidates = [root_dir / "cli" / "src", root_dir / "api" / "src", root_dir / "src", root_dir / "cli", root_dir]
        path = next((cand for cand in candidates if cand.exists()), root_dir)
    else:
        allowed = ["command-engine", "vault", *repos_cfg.keys()]
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported graphify target '{target}'. Allowed: {', '.join(allowed)}.",
        )
    if not path.exists():
        raise HTTPException(status_code=404, detail=f"Target path does not exist: {path}")
    return path


def _derive_community_labels(G: Any, communities: dict[int, list[str]]) -> dict[int, str]:
    labels: dict[int, str] = {}
    for cid, node_ids in communities.items():
        if not node_ids:
            labels[cid] = f"Cluster {cid}"
            continue
        file_counts: dict[str, int] = {}
        top_node = node_ids[0]
        top_deg = -1
        for nid in node_ids:
            if nid in G:
                deg = int(G.degree(nid))
                if deg > top_deg:
                    top_deg = deg
                    top_node = nid
                sf = str(G.nodes[nid].get("source_file") or "")
                if sf:
                    stem = Path(sf).stem
                    file_counts[stem] = file_counts.get(stem, 0) + 1
        top_label = str(G.nodes[top_node].get("label") or top_node) if top_node in G else str(top_node)
        if file_counts:
            top_file = max(file_counts.items(), key=lambda kv: kv[1])[0]
            labels[cid] = f"{top_file}: {top_label}"[:48]
        else:
            labels[cid] = top_label[:48]
    return labels


def _run_graphify_pipeline(target: str, export_wiki: bool = False) -> dict[str, Any]:
    pid, profile = _active_profile_context()
    init_cognitive_storage(pid)
    target_path = _resolve_graphify_target(target, profile_id=pid, profile=profile)
    out_dir = _graphify_dir(pid)
    out_dir.mkdir(parents=True, exist_ok=True)

    excluded_parts = {".venv", "venv", "node_modules", "__pycache__", ".git", "dist", "build", ".pytest_cache"}
    all_files = [
        f for f in graphify_collect_files(target_path)
        if not any(part in excluded_parts for part in f.parts)
    ]
    files = all_files[:120]
    if not files:
        raise HTTPException(status_code=400, detail=f"No extractable code or markdown files found in {target_path}.")

    extraction = graphify_extract(files, root=target_path)
    G = graphify_build_from_json(extraction, root=target_path)
    communities = graphify_cluster(G) if G.number_of_nodes() > 0 else {}
    cohesion = graphify_score_all(G, communities) if communities else {}
    god_nodes_list = graphify_god_nodes(G) if G.number_of_nodes() > 0 else []
    surprises = graphify_surprising_connections(G, communities) if communities else []
    community_labels = _derive_community_labels(G, communities)
    questions = graphify_suggest_questions(G, communities, community_labels) if communities else []

    try:
        detection_result = graphify_detect(target_path)
    except Exception:
        detection_result = {
            "total_files": len(files),
            "total_words": 0,
            "warning": None,
            "unclassified": [],
        }
    token_cost = {
        "input": int(extraction.get("input_tokens", 0)),
        "output": int(extraction.get("output_tokens", 0)),
    }
    report_md = graphify_generate(
        G,
        communities,
        cohesion,
        community_labels,
        god_nodes_list,
        surprises,
        detection_result,
        token_cost,
        str(target_path),
        suggested_questions=questions,
    )

    graph_json_path = out_dir / "graph.json"
    canvas_path = out_dir / "graph.canvas"
    report_path = out_dir / "GRAPH_REPORT.md"
    meta_path = out_dir / "latest_meta.json"

    graphify_to_json(G, communities, str(graph_json_path), force=True, community_labels=community_labels)
    graphify_to_canvas(G, communities, str(canvas_path), community_labels=community_labels)
    report_path.write_text(report_md, encoding="utf-8")

    exported_wiki_count = 0
    if export_wiki and communities:
        wiki_stage_dir = out_dir / "wiki_staging"
        wiki_stage_dir.mkdir(parents=True, exist_ok=True)
        exported_wiki_count = graphify_to_wiki(
            G,
            communities,
            wiki_stage_dir,
            community_labels=community_labels,
            cohesion=cohesion,
            god_nodes_data=god_nodes_list,
        )
        wiki_ast_dest = _wiki_ast_dir(pid)
        wiki_ast_dest.mkdir(parents=True, exist_ok=True)
        for staged_md in wiki_stage_dir.glob("*.md"):
            dest_name = "graphify-ast-index.md" if staged_md.name == "index.md" else staged_md.name
            (wiki_ast_dest / dest_name).write_text(staged_md.read_text(encoding="utf-8"), encoding="utf-8")
        _invalidate_vault_fts_cache()

    normalized_questions = [
        str(q.get("question") if isinstance(q, dict) else q)
        for q in (questions or [])
        if (q.get("question") if isinstance(q, dict) else q)
    ]

    meta_payload = {
        "target": target,
        "target_path": str(target_path),
        "generated_at": utc_now_iso(),
        "files_scanned": len(files),
        "total_discovered_files": len(all_files),
        "nodes_count": G.number_of_nodes(),
        "edges_count": G.number_of_edges(),
        "communities_count": len(communities),
        "community_labels": {str(k): v for k, v in community_labels.items()},
        "god_nodes": god_nodes_list,
        "surprising_connections": surprises,
        "suggested_questions": normalized_questions,
        "exported_wiki_articles": exported_wiki_count,
        "report_md": report_md,
    }
    meta_path.write_text(json.dumps(meta_payload, indent=2), encoding="utf-8")
    return meta_payload


@router.post("/graphify/run")
async def run_graphify_endpoint(req: GraphifyRunRequest) -> dict[str, Any]:
    return await asyncio.to_thread(_run_graphify_pipeline, req.target, req.export_wiki)


@router.get("/graph")
def get_unified_knowledge_graph() -> dict[str, Any]:
    pid, profile = _active_profile_context()
    init_cognitive_storage(pid)
    out_dir = _graphify_dir(pid)
    graph_path = out_dir / "graph.json"
    meta_path = out_dir / "latest_meta.json"

    nodes_map: dict[str, dict[str, Any]] = {}
    links: list[dict[str, Any]] = []
    seen_links: set[tuple[str, str, str]] = set()

    def add_node(
        nid: str,
        label: str,
        domain: str,
        kind: str,
        val: float = 2.0,
        community: Any = 0,
        url: str = "",
        excerpt: str = "",
    ) -> None:
        if nid not in nodes_map:
            nodes_map[nid] = {
                "id": nid,
                "label": label,
                "domain": domain,
                "kind": kind,
                "val": val,
                "community": community,
                "url": url,
                "excerpt": excerpt,
            }

    def add_link(src: str, tgt: str, relation: str, confidence: str = "INFERRED") -> None:
        if not src or not tgt or src == tgt:
            return
        if src not in nodes_map or tgt not in nodes_map:
            return
        key = (src, tgt, relation)
        if key not in seen_links:
            seen_links.add(key)
            links.append(
                {
                    "source": src,
                    "target": tgt,
                    "relation": relation,
                    "confidence": confidence,
                }
            )

    # 1. Graphify AST nodes & edges (up to top 140 by degree)
    if graph_path.exists():
        try:
            gdata = json.loads(graph_path.read_text(encoding="utf-8"))
            raw_nodes = gdata.get("nodes") or []
            raw_links = gdata.get("links") or gdata.get("edges") or []
            deg_counts: dict[str, int] = {}
            for lk in raw_links:
                s = str(lk.get("source") or "")
                t = str(lk.get("target") or "")
                deg_counts[s] = deg_counts.get(s, 0) + 1
                deg_counts[t] = deg_counts.get(t, 0) + 1
            sorted_nodes = sorted(
                raw_nodes,
                key=lambda nd: deg_counts.get(str(nd.get("id") or ""), 0),
                reverse=True,
            )[:140]
            kept_ids: set[str] = set()
            for nd in sorted_nodes:
                raw_id = str(nd.get("id") or "")
                if not raw_id:
                    continue
                nid = f"ast:{raw_id}"
                kept_ids.add(raw_id)
                deg = deg_counts.get(raw_id, 1)
                add_node(
                    nid=nid,
                    label=str(nd.get("label") or raw_id),
                    domain="code",
                    kind=str(nd.get("node_kind") or nd.get("file_type") or "symbol"),
                    val=float(min(12.0, 2.0 + deg * 0.45)),
                    community=nd.get("community", 0),
                    url="",
                    excerpt=f"{nd.get('source_file', '')} {nd.get('source_location', '')}".strip(),
                )
            for lk in raw_links:
                s = str(lk.get("source") or "")
                t = str(lk.get("target") or "")
                if s in kept_ids and t in kept_ids:
                    conf = str(lk.get("confidence") or "EXTRACTED").upper()
                    if conf not in {"EXTRACTED", "INFERRED", "AMBIGUOUS"}:
                        conf = "INFERRED"
                    add_link(
                        f"ast:{s}",
                        f"ast:{t}",
                        str(lk.get("relation") or "references"),
                        conf,
                    )
        except Exception:
            pass

    # 2. Vault notes ([[wikilinks]] -> EXTRACTED)
    vault_notes = _scan_vault_notes("all", profile_id=pid)
    vault_slug_to_id: dict[str, str] = {}
    for n in vault_notes:
        nid = f"vault:{n['folder']}/{n['slug']}"
        vault_slug_to_id[n["slug"].lower()] = nid
        vault_slug_to_id[_slugify(n["title"])] = nid
        add_node(
            nid=nid,
            label=n["title"],
            domain="wiki",
            kind=n["folder"],
            val=float(3.5 + len(n["backlinks"]) * 1.2 + len(n["links_out"]) * 0.4),
            community=f"vault:{n['folder']}",
            url="",
            excerpt=n["excerpt"],
        )
    for n in vault_notes:
        src_id = f"vault:{n['folder']}/{n['slug']}"
        for target in n["links_out"]:
            tgt_id = vault_slug_to_id.get(target.lower()) or vault_slug_to_id.get(_slugify(target))
            if tgt_id:
                add_link(src_id, tgt_id, "wikilink", "EXTRACTED")

    # 3. Core Repos, Meetings, Tasks, Events from SQLite (profile-scoped)
    repo_nodes: dict[str, str] = {}
    profile_repos = profile.get("core_repos")
    if isinstance(profile_repos, dict):
        repos_cfg = profile_repos
    elif pid == OWNER_PROFILE_ID:
        repos_cfg = config.CORE_REPOS
    else:
        repos_cfg = {}
    for repo_key, meta in repos_cfg.items():
        if not isinstance(meta, dict):
            continue
        full_name = str(meta.get("full_name") or repo_key)
        rid = f"repo:{repo_key}"
        repo_nodes[repo_key.lower()] = rid
        repo_nodes[full_name.lower()] = rid
        add_node(
            nid=rid,
            label=full_name,
            domain="engineering",
            kind="repository",
            val=7.0,
            community="repos",
            url=f"https://github.com/{full_name}",
            excerpt=str(meta.get("local_path") or ""),
        )

    actor_nodes: dict[str, str] = {}

    def ensure_actor_node(actor_name: str) -> str | None:
        cleaned = (actor_name or "").strip()
        if not cleaned:
            return None
        key = _slugify(cleaned, "")
        if not key:
            return None
        aid = f"actor:{key}"
        if aid not in actor_nodes:
            actor_nodes[aid] = cleaned
            add_node(
                nid=aid,
                label=cleaned,
                domain="comms",
                kind="person",
                val=4.5,
                community="people",
                excerpt="Stakeholder / Counterparty",
            )
        return aid

    with db_session() as conn:
        meetings = [
            row_to_dict(r)
            for r in conn.execute(
                "SELECT id, title, start_at, meet_url, summary_md FROM meetings WHERE profile_id = ? ORDER BY start_at DESC LIMIT 12",
                (pid,),
            ).fetchall()
        ]
        tasks = [
            row_to_dict(r)
            for r in conn.execute(
                "SELECT id, bucket, priority, title, description, repo, counterparty, source_url, meeting_id FROM tasks WHERE profile_id = ? AND status NOT IN ('done', 'dismissed') ORDER BY priority ASC, updated_at DESC LIMIT 25",
                (pid,),
            ).fetchall()
        ]
        events = [
            row_to_dict(r)
            for r in conn.execute(
                "SELECT id, source, title, summary, actor, channel_or_repo, url, priority FROM events WHERE profile_id = ? ORDER BY occurred_at DESC LIMIT 30",
                (pid,),
            ).fetchall()
        ]

    for m in meetings:
        if not m:
            continue
        mid = f"meeting:{m['id']}"
        add_node(
            nid=mid,
            label=str(m["title"]),
            domain="meetings",
            kind="meeting",
            val=5.0,
            community="meetings",
            url=str(m.get("meet_url") or ""),
            excerpt=str(m.get("summary_md") or m.get("start_at") or "")[:180],
        )

    def match_repo_id(text: str) -> str | None:
        low = (text or "").lower()
        for k, rid in repo_nodes.items():
            if k in low:
                return rid
        return None

    for t in tasks:
        if not t:
            continue
        tid = f"task:{t['id']}"
        add_node(
            nid=tid,
            label=str(t["title"]),
            domain="tasks",
            kind=str(t.get("bucket") or "task"),
            val=4.5 if t.get("priority") == "P0" else 3.2,
            community=str(t.get("bucket") or "tasks"),
            url=str(t.get("source_url") or ""),
            excerpt=str(t.get("description") or "")[:180],
        )
        rid = match_repo_id(f"{t.get('repo', '')} {t.get('title', '')}")
        if rid:
            add_link(tid, rid, "targets_repo", "INFERRED")
        if t.get("meeting_id"):
            add_link(tid, f"meeting:{t['meeting_id']}", "extracted_from", "INFERRED")
        aid = ensure_actor_node(str(t.get("counterparty") or ""))
        if aid:
            add_link(tid, aid, "involves", "INFERRED")

    for e in events:
        if not e:
            continue
        eid = f"event:{e['id']}"
        src_name = str(e.get("source") or "comms")
        domain = "engineering" if src_name in {"github", "local", "gke"} else "comms"
        add_node(
            nid=eid,
            label=str(e["title"]),
            domain=domain,
            kind=src_name,
            val=3.0,
            community=src_name,
            url=str(e.get("url") or ""),
            excerpt=str(e.get("summary") or "")[:180],
        )
        rid = match_repo_id(f"{e.get('channel_or_repo', '')} {e.get('title', '')}")
        if rid:
            add_link(eid, rid, "mentions_repo", "INFERRED")
        aid = ensure_actor_node(str(e.get("actor") or ""))
        if aid:
            add_link(eid, aid, "authored_by", "INFERRED")

    # Keyword bridge links between vault wiki pages and engineering/tasks
    for n in vault_notes:
        v_id = f"vault:{n['folder']}/{n['slug']}"
        haystack = f"{n['title']} {n['content_md'][:600]}".lower()
        for k, rid in repo_nodes.items():
            if k in haystack:
                add_link(v_id, rid, "documents_repo", "INFERRED")

    meta: dict[str, Any] = {}
    if meta_path.exists():
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
        except Exception:
            meta = {}

    raw_questions = meta.get("suggested_questions") or []
    clean_questions = [
        str(q.get("question") if isinstance(q, dict) else q)
        for q in raw_questions
        if (q.get("question") if isinstance(q, dict) else q)
    ]

    return {
        "nodes": list(nodes_map.values()),
        "links": links,
        "god_nodes": meta.get("god_nodes") or [],
        "surprising_connections": meta.get("surprising_connections") or [],
        "suggested_questions": clean_questions,
        "report_md": meta.get("report_md") or "",
    }


# ---------------------------------------------------------------------------
# 4. Spaced Repetition (SM-2)
# ---------------------------------------------------------------------------


@router.get("/flashcards")
def list_flashcards(
    due_only: bool = False,
    deck: str = Query(default=""),
) -> dict[str, Any]:
    pid = _resolve_profile_id()
    init_cognitive_storage(pid)
    now_iso = utc_now_iso()
    with db_session() as conn:
        clauses = ["profile_id = ?"]
        params: list[Any] = [pid]
        if due_only:
            clauses.append("(due_at IS NULL OR due_at <= ?)")
            params.append(now_iso)
        if deck.strip():
            clauses.append("deck = ?")
            params.append(deck.strip())
        sql = f"SELECT * FROM flashcards WHERE {' AND '.join(clauses)} ORDER BY COALESCE(due_at, created_at) ASC"
        items = [row_to_dict(r) for r in conn.execute(sql, params).fetchall()]
        total = conn.execute(
            "SELECT COUNT(*) AS c FROM flashcards WHERE profile_id = ?",
            (pid,),
        ).fetchone()["c"]
        due_now = conn.execute(
            "SELECT COUNT(*) AS c FROM flashcards WHERE profile_id = ? AND (due_at IS NULL OR due_at <= ?)",
            (pid, now_iso),
        ).fetchone()["c"]
        decks = [
            r["deck"]
            for r in conn.execute(
                "SELECT DISTINCT deck FROM flashcards WHERE profile_id = ? ORDER BY deck ASC",
                (pid,),
            ).fetchall()
        ]
    return {
        "items": items,
        "stats": {
            "due_now": due_now,
            "total": total,
            "decks": decks,
        },
    }


@router.post("/flashcards/generate")
async def generate_flashcards_endpoint(req: FlashcardGenerateRequest) -> dict[str, Any]:
    pid = _resolve_profile_id()
    init_cognitive_storage(pid)
    system_prompt = (
        "You are a Spaced Repetition card author for a Principal AI Engineer. "
        "Generate concise, high-signal atomic flashcards testing architectural truths, edge cases, and commands. "
        "Return STRICT JSON ONLY:\n"
        '{"cards": [{"front": "Question?", "back": "Direct answer", "tags": ["tag1", "tag2"]}]}'
    )
    user_prompt = (
        f"Deck: {req.deck}\n"
        f"Source Title: {req.source_title}\n"
        f"Target Card Count: {req.count}\n\n"
        f"Source Material:\n{req.source_text[:18000]}"
    )
    llm = GatewayLLMClient()
    raw = await llm.worker_analyze(system_prompt, user_prompt, json_mode=True)
    parsed = _parse_llm_json(raw)
    cards_in = parsed.get("cards") or []
    now_iso = utc_now_iso()

    created: list[dict[str, Any]] = []
    with db_session() as conn:
        for card in cards_in[: req.count]:
            front = str(card.get("front") or "").strip()
            back = str(card.get("back") or "").strip()
            if not front or not back:
                continue
            tags = [str(t).strip() for t in (card.get("tags") or []) if str(t).strip()]
            cur = conn.execute(
                """
                INSERT INTO flashcards(
                    profile_id, deck, front, back, source_ref, tags_json,
                    ease_factor, interval_days, repetitions, due_at, created_at
                )
                VALUES (?, ?, ?, ?, ?, ?, 2.5, 0, 0, ?, ?)
                """,
                (pid, req.deck, front, back, req.source_title, json.dumps(tags), now_iso, now_iso),
            )
            row = row_to_dict(conn.execute("SELECT * FROM flashcards WHERE id = ?", (cur.lastrowid,)).fetchone())
            if row:
                created.append(row)
    return {"created": created, "count": len(created)}


def apply_sm2_review(
    ease_factor: float,
    interval_days: float,
    repetitions: int,
    rating: int,
    now: datetime | None = None,
) -> dict[str, Any]:
    """Compute next SM-2 scheduling state for ratings 1=Again, 2=Hard, 3=Good, 4=Easy."""
    ref_now = now or datetime.now(timezone.utc)
    ef = float(ease_factor or 2.5)
    iv = float(interval_days or 0.0)
    reps = int(repetitions or 0)

    if rating == 1:  # Again (15 min)
        reps = 0
        iv = 0.01
        ef = max(1.3, round(ef - 0.2, 4))
    elif rating == 2:  # Hard
        reps = max(1, reps)
        iv = round(max(0.5, iv * 1.2 if iv > 0 else 0.5), 2)
        ef = max(1.3, round(ef - 0.15, 4))
    elif rating == 3:  # Good
        if reps == 0:
            iv = 1.0
        elif reps == 1:
            iv = 6.0
        else:
            iv = round(iv * ef, 2)
        reps += 1
    elif rating == 4:  # Easy
        if reps == 0:
            iv = 4.0
        elif reps == 1:
            iv = 8.0
        else:
            iv = round(iv * ef * 1.3, 2)
        reps += 1
        ef = max(1.3, round(ef + 0.15, 4))
    else:
        raise ValueError("Rating must be 1..4")

    due_dt = ref_now + timedelta(days=iv)
    return {
        "ease_factor": ef,
        "interval_days": iv,
        "repetitions": reps,
        "due_at": due_dt.isoformat(),
        "last_reviewed_at": ref_now.isoformat(),
    }


@router.post("/flashcards/{card_id}/review")
def review_flashcard_endpoint(card_id: int, req: FlashcardReviewRequest) -> dict[str, Any]:
    pid = _resolve_profile_id()
    init_cognitive_storage(pid)
    with db_session() as conn:
        row = conn.execute("SELECT * FROM flashcards WHERE id = ? AND profile_id = ?", (card_id, pid)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail=f"Flashcard #{card_id} not found.")
        updated = apply_sm2_review(
            ease_factor=float(row["ease_factor"] or 2.5),
            interval_days=float(row["interval_days"] or 0.0),
            repetitions=int(row["repetitions"] or 0),
            rating=req.rating,
        )
        conn.execute(
            """
            UPDATE flashcards
            SET ease_factor = ?, interval_days = ?, repetitions = ?, due_at = ?, last_reviewed_at = ?
            WHERE id = ? AND profile_id = ?
            """,
            (
                updated["ease_factor"],
                updated["interval_days"],
                updated["repetitions"],
                updated["due_at"],
                updated["last_reviewed_at"],
                card_id,
                pid,
            ),
        )
        card = row_to_dict(conn.execute("SELECT * FROM flashcards WHERE id = ? AND profile_id = ?", (card_id, pid)).fetchone())
    return {"card": card}


# ---------------------------------------------------------------------------
# 5. Synthesis Studio & Two-Host Neural Audio
# ---------------------------------------------------------------------------


@router.get("/audio")
def list_audio_briefings() -> dict[str, Any]:
    pid = _resolve_profile_id()
    init_cognitive_storage(pid)
    with db_session() as conn:
        rows = [
            row_to_dict(r)
            for r in conn.execute(
                "SELECT * FROM audio_briefings WHERE profile_id = ? ORDER BY created_at DESC LIMIT 30",
                (pid,),
            ).fetchall()
        ]
    items = []
    for r in rows:
        if not r:
            continue
        r["audio_url"] = f"/api/cognitive/audio/{r['id']}/stream"
        items.append(r)
    return {"items": items}


@router.post("/audio/generate")
async def generate_audio_briefing_endpoint(req: AudioGenerateRequest) -> dict[str, Any]:
    pid = _resolve_profile_id()
    init_cognitive_storage(pid)
    source_context = (req.source_text or "").strip()
    if not source_context:
        with db_session() as conn:
            brief = row_to_dict(
                conn.execute(
                    "SELECT title, content_md FROM briefings WHERE profile_id = ? ORDER BY created_at DESC LIMIT 1",
                    (pid,),
                ).fetchone()
            )
            tasks = [
                row_to_dict(r)
                for r in conn.execute(
                    "SELECT priority, title, repo, counterparty FROM tasks WHERE profile_id = ? AND status NOT IN ('done', 'dismissed') AND priority IN ('P0', 'P1') ORDER BY priority ASC LIMIT 12",
                    (pid,),
                ).fetchall()
            ]
            events = [
                row_to_dict(r)
                for r in conn.execute(
                    "SELECT source, priority, title, summary, actor FROM events WHERE profile_id = ? ORDER BY occurred_at DESC LIMIT 12",
                    (pid,),
                ).fetchall()
            ]
        source_context = json.dumps(
            {
                "latest_briefing": brief,
                "open_p0_p1_tasks": tasks,
                "recent_events": events,
            },
            indent=2,
        )

    system_prompt = (
        "You are producing a crisp, warm, natural two-host executive engineering audio briefing. "
        "Hosts: 'Alex' (sharp principal architect) and 'Maya' (executive chief of staff). "
        "Write 6 to 10 conversational turns that sound genuinely spoken — use natural contractions (we're, that's, you'll), "
        "brief conversational reactions, zero markdown symbols, zero URLs, and zero bullet punctuation. "
        "Keep each turn concise (2 to 4 natural sentences) and write numbers/versions cleanly for speech. "
        "Return STRICT JSON ONLY:\n"
        '{"turns": [{"speaker": "Alex", "text": "..."}, {"speaker": "Maya", "text": "..."}]}'
    )
    user_prompt = (
        f"Title: {req.title}\nMode: {req.mode}\n\n"
        f"Source Material:\n{source_context[:18000]}"
    )

    llm = GatewayLLMClient()
    raw = await llm.chief_of_staff_synthesize(system_prompt, user_prompt, json_mode=True)
    parsed = _parse_llm_json(raw)
    turns_raw = parsed.get("turns") or []
    turns: list[dict[str, str]] = []
    for t in turns_raw[:12]:
        speaker = "Maya" if str(t.get("speaker") or "").strip().lower() == "maya" else "Alex"
        raw_text = str(t.get("text") or "").strip()
        clean_text = re.sub(r"[*_`#]+", "", raw_text)
        clean_text = re.sub(r"\s+", " ", clean_text).strip()
        if clean_text:
            turns.append({"speaker": speaker, "text": clean_text})
    if not turns:
        turns = [
            {"speaker": "Alex", "text": f"Welcome to {req.title}. Here's your fast engineering briefing."},
            {"speaker": "Maya", "text": "Let's walk through your highest-priority actions and open signals."},
        ]

    word_count = sum(len(t["text"].split()) for t in turns)
    duration_est_sec = max(10, int(round(word_count / 2.5)))

    now_iso = utc_now_iso()
    with db_session() as conn:
        cur = conn.execute(
            """
            INSERT INTO audio_briefings(profile_id, title, mode, script_json, mp3_path, duration_est_sec, created_at)
            VALUES (?, ?, ?, ?, '', ?, ?)
            """,
            (pid, req.title, req.mode, json.dumps(turns), duration_est_sec, now_iso),
        )
        audio_id = int(cur.lastrowid)

    mp3_path = _audio_dir(pid) / f"audio_{audio_id}.mp3"
    try:
        synth_result = await synthesize_dialogue_mp3(turns, mp3_path)
    except Exception as exc:
        with db_session() as conn:
            conn.execute("DELETE FROM audio_briefings WHERE id = ? AND profile_id = ?", (audio_id, pid))
        raise HTTPException(status_code=502, detail=f"Neural TTS failed to synthesize dialogue: {exc}") from exc

    duration_est_sec = max(1, int(synth_result.duration_sec or duration_est_sec))
    with db_session() as conn:
        conn.execute(
            "UPDATE audio_briefings SET mp3_path = ?, duration_est_sec = ? WHERE id = ? AND profile_id = ?",
            (str(mp3_path), duration_est_sec, audio_id, pid),
        )

    return {
        "id": audio_id,
        "title": req.title,
        "mode": req.mode,
        "audio_url": f"/api/cognitive/audio/{audio_id}/stream",
        "script": turns,
        "duration_est_sec": duration_est_sec,
        "tts_engine": synth_result.engine,
        "voices": synth_result.voices,
    }


@router.get("/audio/{audio_id}/stream")
def stream_audio_briefing(audio_id: int) -> FileResponse:
    pid = _resolve_profile_id()
    init_cognitive_storage(pid)
    with db_session() as conn:
        row = conn.execute(
            "SELECT mp3_path FROM audio_briefings WHERE id = ? AND profile_id = ?",
            (audio_id, pid),
        ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail=f"Audio briefing #{audio_id} not found.")
    mp3_path = Path(str(row["mp3_path"])).resolve()
    if not mp3_path.is_relative_to(_audio_dir(pid).resolve()):
        raise HTTPException(status_code=403, detail="Audio file path outside audio storage.")
    if not mp3_path.exists():
        raise HTTPException(status_code=404, detail="Audio MP3 file not found on disk.")
    return FileResponse(str(mp3_path), media_type="audio/mpeg", filename=mp3_path.name)


@router.post("/notebook/synthesize")
async def notebook_synthesize_endpoint(req: NotebookSynthesizeRequest) -> dict[str, Any]:
    init_cognitive_storage()
    all_notes = _scan_vault_notes("all")
    selected_notes: list[dict[str, Any]] = []
    if req.source_slugs:
        wanted = {s.strip().lower() for s in req.source_slugs if s.strip()}
        for n in all_notes:
            if n["slug"].lower() in wanted or f"{n['folder']}/{n['slug']}".lower() in wanted:
                selected_notes.append(n)
    else:
        selected_notes = [
            n for n in all_notes
            if n["folder"] == "wiki" and n.get("origin_kind") != "generated_ast"
        ][:6]

    sources_block = "\n\n".join(
        f"### Source [{idx + 1}]: [[{n['slug']}]] ({n['folder']})\n{n['content_md'][:3000]}"
        for idx, n in enumerate(selected_notes)
    )
    fmt = (req.format or "study_guide").strip().lower()
    format_instructions = {
        "study_guide": "Produce a comprehensive Study Guide with Key Concepts, Architecture Mechanics, Edge Cases, and Self-Test Questions.",
        "faq": "Produce a sharp Engineering FAQ with Q&A pairs grounded in the sources.",
        "mindmap_md": "Produce a hierarchical Markdown Mindmap tree (nested bullet outline + mermaid mindmap block).",
        "briefing_doc": "Produce a crisp Executive Briefing Document with TL;DR, Key Findings, Risks, and Next Actions.",
    }.get(fmt, "Produce a structured synthesis document grounded in the sources.")

    system_prompt = (
        "You are the Command Engine Synthesis Engine. "
        f"{format_instructions} "
        "Cite sources inline using [[slug]] and [1]..[N] markers."
    )
    user_prompt = (
        f"Title: {req.title}\nFormat: {fmt}\n\n"
        f"Vault Sources:\n{sources_block}\n\n"
        f"Extra Context:\n{req.extra_context[:12000]}"
    )

    llm = GatewayLLMClient()
    if llm._creds.configured:
        content_md = await llm.chief_of_staff_synthesize(system_prompt, user_prompt, json_mode=False)
    else:
        bullet_notes = "\n".join(
            f"- **[[{n['slug']}]]** — {n['title']}" for n in selected_notes
        ) or "- _(No vault notes selected)_"
        content_md = (
            f"# {req.title}\n\n"
            "_Generated in Key-Free Limited Mode using local Vault FTS5 records._\n\n"
            f"## Indexed Vault Sources\n{bullet_notes}\n"
        )
    return {
        "title": req.title,
        "format": fmt,
        "sources_used": [{"slug": n["slug"], "folder": n["folder"], "title": n["title"]} for n in selected_notes],
        "content_md": content_md,
    }


# ---------------------------------------------------------------------------
# 6. Fast Triage, Multi-Model Council, Deep Research, Profile Memory & Decisions
# ---------------------------------------------------------------------------


@router.post("/jev-triage")
async def jev_triage_endpoint(req: JevTriageRequest) -> dict[str, Any]:
    rt = resolve_active_llm_runtime()
    llm = GatewayLLMClient()
    configured_fast = str(rt.get("model_fast") or "").strip()
    configured_worker = str(rt.get("model_worker") or config.MODEL_WORKER).strip()
    triage_prompt = (
        "Classify the incoming engineering/executive signal into STRICT JSON ONLY with keys:\n"
        '{"urgency": "P0|P1|P2|P3", "domain": "engineering|comms|infra|meetings|knowledge", '
        '"intent": "action_request|review|incident|question|fyi", "action_required": true, '
        '"confidence": 0.92, "recommended_skill": "skill-id", "routing_note": "1-sentence rationale"}\n\n'
        f"Signal:\n{req.text[:6000]}"
    )
    model_used = configured_fast or config.MODEL_FAST
    raw = ""
    try:
        raw = await llm.chat(
            [
                {"role": "system", "content": "Fast System-1 typed triage classifier. Output strict JSON only."},
                {"role": "user", "content": triage_prompt},
            ],
            model=model_used,
            reasoning_effort=None,
            temperature=0.0,
            json_mode=True,
            timeout=20.0,
        )
    except Exception:
        model_used = configured_worker
        raw = await llm.chat(
            [
                {"role": "system", "content": "Fast System-1 typed triage classifier. Output strict JSON only."},
                {"role": "user", "content": triage_prompt},
            ],
            model=configured_worker,
            reasoning_effort=None,
            temperature=0.0,
            json_mode=True,
            timeout=30.0,
        )

    parsed = _parse_llm_json(raw)
    if not parsed:
        model_used = configured_worker
        raw = await llm.chat(
            [
                {"role": "system", "content": "Fast System-1 typed triage classifier. Output strict JSON only."},
                {"role": "user", "content": triage_prompt},
            ],
            model=configured_worker,
            reasoning_effort=None,
            temperature=0.0,
            json_mode=True,
            timeout=30.0,
        )
        parsed = _parse_llm_json(raw)

    urgency = str(parsed.get("urgency") or "P2").upper()
    if urgency not in {"P0", "P1", "P2", "P3"}:
        urgency = "P2"
    try:
        confidence = float(parsed.get("confidence", 0.8))
    except Exception:
        confidence = 0.8

    return {
        "urgency": urgency,
        "domain": str(parsed.get("domain") or "engineering"),
        "intent": str(parsed.get("intent") or "action_request"),
        "action_required": bool(parsed.get("action_required", True)),
        "confidence": max(0.0, min(1.0, confidence)),
        "recommended_skill": str(parsed.get("recommended_skill") or "karpathy-llm-wiki"),
        "routing_note": str(parsed.get("routing_note") or "Triaged via System-1 classifier."),
        "model_used": model_used,
    }


@router.post("/council")
async def multi_model_council_endpoint(req: CouncilRequest) -> dict[str, Any]:
    with db_session() as conn:
        active_profile = get_active_profile(conn)
    raw_council = active_profile.get("council_models") or []
    council_models = [str(m).strip() for m in raw_council if str(m).strip()] if isinstance(raw_council, list) else []
    if not council_models:
        orch = str(active_profile.get("model_orchestrator") or config.MODEL_ORCHESTRATOR).strip() or config.MODEL_ORCHESTRATOR
        council_models = [orch, config.MODEL_WORKER]

    principal_name = str(active_profile.get("display_name") or "the Principal")
    chair_model = str(active_profile.get("model_orchestrator") or council_models[0])

    llm = GatewayLLMClient()
    from .local_runtime import build_ai_capability_matrix

    cap = build_ai_capability_matrix(llm._runtime)
    council_cap = cap["features"]["multi_model_council"]
    chat_is_default = getattr(GatewayLLMClient.chat, "__qualname__", "") == "LLMProviderClient.chat"
    if not council_cap["available"] and chat_is_default:
        reason = str(
            council_cap.get("disabled_reason")
            or "3-Model Strategy Council requires a cloud or multi-model API gateway."
        )
        return {
            "disabled": True,
            "degraded": True,
            "ai_mode": cap["ai_mode"],
            "disabled_reason": reason,
            "panelists": [],
            "synthesis_md": (
                f"### 3-Model Strategy Council Unavailable in {cap['mode_label']}\n\n"
                f"{reason}\n\n"
                "Connect a multi-model API gateway or cloud API key in **System → AI & Models** "
                "to run parallel frontier model debate. Single-model Q&A, Vault FTS5 search, "
                "Tasks, and Approval Studio remain available."
            ),
        }

    panel_system = (
        f"You are a senior member of {principal_name}'s Engineering & Strategy Council. "
        "Provide a sharp, opinionated, technically grounded response with explicit trade-offs."
    )
    messages = [
        {"role": "system", "content": panel_system},
        {"role": "user", "content": req.prompt},
    ]

    async def query_panelist(model_name: str, reasoning_effort: str | None, fallback_model: str | None = None) -> dict[str, Any]:
        t0 = time.perf_counter()
        used_model = model_name
        try:
            txt = await llm.chat(
                messages,
                model=model_name,
                reasoning_effort=reasoning_effort,
                temperature=0.2,
                timeout=90.0,
            )
            if not txt:
                raise ValueError("Empty response")
        except Exception as exc:
            if fallback_model:
                used_model = fallback_model
                try:
                    txt = await llm.chat(
                        messages,
                        model=fallback_model,
                        reasoning_effort=None,
                        temperature=0.2,
                        timeout=90.0,
                    )
                except Exception as exc2:
                    txt = f"_Model `{model_name}` (and fallback `{fallback_model}`) failed: {exc2}_"
            else:
                txt = f"_Model `{model_name}` failed: {exc}_"
        latency_ms = int((time.perf_counter() - t0) * 1000)
        return {
            "model": used_model,
            "response_md": txt,
            "latency_ms": latency_ms,
        }

    tasks = [
        query_panelist(
            model_name,
            "high" if idx == 0 else None,
            fallback_model=config.MODEL_FAST if model_name == council_models[-1] else None,
        )
        for idx, model_name in enumerate(council_models)
    ]
    results = await asyncio.gather(*tasks, return_exceptions=True)

    panelists: list[dict[str, Any]] = []
    degraded = False
    for res in results:
        if isinstance(res, Exception):
            degraded = True
            panelists.append({"model": "unknown", "status": "failed", "response_md": f"_Error: {res}_", "latency_ms": 0})
        else:
            is_failed = str(res.get("response_md") or "").startswith("_Model `")
            if is_failed:
                degraded = True
            panelists.append({**res, "status": "failed" if is_failed else "ok"})

    synth_system = (
        f"You are the Chair of the Multi-Model Council (`{chair_model}`). "
        "Synthesize the panelists' answers into: 1) Points of Consensus, 2) Key Divergences, and 3) Final Recommended Decision. "
        "If any panelist failed or was unavailable, state that honestly and synthesize only from real responses."
    )
    synth_user = f"Prompt:\n{req.prompt}\n\nPanelist Responses:\n{json.dumps(panelists, indent=2)}"
    synthesis_md = await llm.chief_of_staff_synthesize(synth_system, synth_user, json_mode=False)

    return {
        "degraded": degraded,
        "panelists": panelists,
        "synthesis_md": synthesis_md,
    }


@router.post("/research")
async def deep_research_endpoint(req: ResearchRequest) -> dict[str, Any]:
    pid, profile = _active_profile_context()
    init_cognitive_storage(pid)
    hits = await hybrid_search(req.query, limit=15)

    vault = _vault_root(pid)
    index_md = (vault / "index.md").read_text(encoding="utf-8") if (vault / "index.md").exists() else ""
    q_tokens = [tok.lower() for tok in re.findall(r"[a-zA-Z0-9_-]{3,}", req.query)]
    vault_notes = _scan_vault_notes("all", profile_id=pid)

    scored_vault: list[tuple[int, dict[str, Any]]] = []
    for n in vault_notes:
        hay = f"{n['title']} {n['slug']} {n['content_md']}".lower()
        score = sum(hay.count(tok) for tok in q_tokens) if q_tokens else 1
        if score > 0:
            scored_vault.append((score, n))
    scored_vault.sort(key=lambda x: x[0], reverse=True)

    sources: list[dict[str, Any]] = []
    for h in hits:
        idx = len(sources) + 1
        sources.append(
            {
                "citation": f"[{idx}]",
                "kind": h.get("kind", "event"),
                "source": h.get("source", ""),
                "title": h.get("title", ""),
                "url": h.get("url", ""),
                "excerpt": h.get("summary", ""),
                "score": h.get("score", 0),
            }
        )
    for sc, n in scored_vault[:8]:
        idx = len(sources) + 1
        sources.append(
            {
                "citation": f"[{idx}]",
                "kind": f"vault:{n['folder']}",
                "source": f"vault/{n['folder']}/{n['slug']}.md",
                "title": n["title"],
                "url": f"vault://{n['folder']}/{n['slug']}",
                "excerpt": n["excerpt"],
                "score": float(sc),
            }
        )

    citation_table = "\n".join(
        f"{s['citation']} ({s['kind']} / {s['source']}) **{s['title']}** — {s['excerpt'][:180]} {s['url']}".strip()
        for s in sources
    )

    brand_name = str(profile.get("brand_display_name") or "Command Engine")
    system_prompt = (
        f"You are Deep Grounded Research Analyst for {brand_name}. "
        "Synthesize an exhaustive, strictly grounded technical report using ONLY the numbered sources below. "
        "Every factual claim MUST carry inline citations like [1], [2]. Note explicitly where evidence is missing."
    )
    user_prompt = (
        f"Research Query: {req.query}\n\n"
        f"Vault Index Snapshot:\n{index_md[:2000]}\n\n"
        f"Deterministic Citation Table:\n{citation_table or '(No indexed matches found; state gaps clearly.)'}"
    )

    llm = GatewayLLMClient()
    if llm._creds.configured:
        report_md = await llm.chief_of_staff_synthesize(system_prompt, user_prompt, json_mode=False)
    else:
        report_md = (
            f"## Grounded Search Digest: {req.query}\n\n"
            "_Synthesized deterministically in Key-Free Limited Mode via SQLite FTS5._\n\n"
            + (citation_table or "No local indexed matches found for this query.")
        )

    filed_wiki_slug: str | None = None
    if req.file_to_wiki:
        base = _slugify(f"research-{req.query}", "research-report")
        wiki_path = vault / "wiki" / f"{base}.md"
        if wiki_path.exists():
            base = f"{base}-{datetime.now(timezone.utc).strftime('%Y%m%d%H%M')}"
            wiki_path = vault / "wiki" / f"{base}.md"
        refs_md = "\n".join(f"- {s['citation']} {s['title']} ({s['source']})" for s in sources)
        full_md = f"# Research: {req.query}\n\n{report_md.strip()}\n\n## Citations\n{refs_md}\n"
        wiki_path.write_text(full_md, encoding="utf-8")
        _update_vault_index([{"slug": base, "title": f"Research: {req.query}", "summary_one_line": f"Deep grounded research on: {req.query}"}], profile_id=pid)
        _append_vault_log("research", f"Filed [[{base}]] ({len(sources)} citations)", profile_id=pid)
        _invalidate_vault_fts_cache()
        filed_wiki_slug = base

    return {
        "report_md": report_md,
        "sources": sources,
        "filed_wiki_slug": filed_wiki_slug,
    }


@router.get("/hermes")
def get_hermes_state() -> dict[str, Any]:
    pid = _resolve_profile_id()
    init_cognitive_storage(pid)
    vault = _vault_root(pid)
    memory_md = (vault / "MEMORY.md").read_text(encoding="utf-8") if (vault / "MEMORY.md").exists() else ""
    user_md = (vault / "USER.md").read_text(encoding="utf-8") if (vault / "USER.md").exists() else ""
    with db_session() as conn:
        rules = [
            row_to_dict(r)
            for r in conn.execute(
                "SELECT * FROM learned_rules WHERE profile_id = ? ORDER BY created_at DESC LIMIT 100",
                (pid,),
            ).fetchall()
        ]
        decisions = [
            row_to_dict(r)
            for r in conn.execute(
                "SELECT * FROM decisions WHERE profile_id = ? ORDER BY created_at DESC LIMIT 100",
                (pid,),
            ).fetchall()
        ]
    return {
        "memory_md": memory_md,
        "memory_chars": len(memory_md),
        "memory_limit": HERMES_MEMORY_LIMIT,
        "user_md": user_md,
        "user_chars": len(user_md),
        "user_limit": HERMES_USER_LIMIT,
        "learned_rules": rules,
        "decisions": decisions,
    }


@router.put("/hermes/memory")
def update_hermes_memory(req: HermesMemoryUpdateRequest) -> dict[str, Any]:
    pid = _resolve_profile_id()
    init_cognitive_storage(pid)
    vault = _vault_root(pid)
    if req.memory_md is not None:
        bounded_mem = req.memory_md[:HERMES_MEMORY_LIMIT]
        (vault / "MEMORY.md").write_text(bounded_mem, encoding="utf-8")
    if req.user_md is not None:
        bounded_usr = req.user_md[:HERMES_USER_LIMIT]
        (vault / "USER.md").write_text(bounded_usr, encoding="utf-8")
    return get_hermes_state()


@router.post("/hermes/rules")
def create_hermes_rule(req: HermesRuleCreateRequest) -> dict[str, Any]:
    pid = _resolve_profile_id()
    init_cognitive_storage(pid)
    now_iso = utc_now_iso()
    with db_session() as conn:
        cur = conn.execute(
            """
            INSERT INTO learned_rules(profile_id, category, rule_text, confidence, active, created_at)
            VALUES (?, ?, ?, 0.9, 1, ?)
            """,
            (pid, req.category.strip(), req.rule_text.strip(), now_iso),
        )
        rule = row_to_dict(conn.execute("SELECT * FROM learned_rules WHERE id = ?", (cur.lastrowid,)).fetchone())
    return {"rule": rule}


@router.post("/decisions")
def create_decision_endpoint(req: DecisionCreateRequest) -> dict[str, Any]:
    pid = _resolve_profile_id()
    init_cognitive_storage(pid)
    now_iso = utc_now_iso()
    with db_session() as conn:
        cur = conn.execute(
            """
            INSERT INTO decisions(profile_id, title, decision, alternatives_ruled_out, rationale, repo, status, created_at)
            VALUES (?, ?, ?, ?, ?, ?, 'active', ?)
            """,
            (
                pid,
                req.title.strip(),
                req.decision.strip(),
                req.alternatives_ruled_out.strip(),
                req.rationale.strip(),
                req.repo.strip(),
                now_iso,
            ),
        )
        dec_id = int(cur.lastrowid)
        dec_row = row_to_dict(conn.execute("SELECT * FROM decisions WHERE id = ?", (dec_id,)).fetchone())

    slug = f"{dec_id:03d}-{_slugify(req.title, 'decision')}"
    dec_path = _vault_root(pid) / "decisions" / f"{slug}.md"
    dec_md = (
        f"---\n"
        f"id: {dec_id}\n"
        f'title: "{req.title.replace(chr(34), "")}"\n'
        f"repo: {req.repo}\n"
        f"status: active\n"
        f"created_at: {now_iso}\n"
        f"---\n\n"
        f"# ADR-{dec_id:03d}: {req.title}\n\n"
        f"## Decision\n{req.decision.strip()}\n\n"
        f"## Alternatives Ruled Out\n{req.alternatives_ruled_out.strip() or 'N/A'}\n\n"
        f"## Rationale\n{req.rationale.strip() or 'N/A'}\n\n"
        f"## Context\n- Repo: `{req.repo or 'command-engine'}`\n"
    )
    dec_path.write_text(dec_md, encoding="utf-8")
    _append_vault_log("decision", f"ADR-{dec_id:03d} [[{slug}]] — {req.title}", profile_id=pid)
    _invalidate_vault_fts_cache()

    return {"decision": dec_row, "decision_slug": slug}
