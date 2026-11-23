from __future__ import annotations

import json
import os
import re
import sqlite3
import uuid
from datetime import datetime, timezone
from typing import Any

from . import config

PROFILES_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS profiles (
    id TEXT PRIMARY KEY,
    slug TEXT UNIQUE NOT NULL,
    display_name TEXT NOT NULL DEFAULT '',
    role_title TEXT NOT NULL DEFAULT '',
    org_name TEXT NOT NULL DEFAULT '',
    brand_display_name TEXT NOT NULL DEFAULT 'Command Engine',
    timezone TEXT NOT NULL DEFAULT 'UTC',
    working_hours_json TEXT NOT NULL DEFAULT '{"start":"09:00","end":"17:30","days":[1,2,3,4,5]}',
    quiet_hours_json TEXT NOT NULL DEFAULT '{"enabled":true,"start":"21:00","end":"07:30"}',
    greeting_enabled INTEGER NOT NULL DEFAULT 1,
    default_home_mode TEXT NOT NULL DEFAULT 'orbit',
    email TEXT NOT NULL DEFAULT '',
    github_login TEXT NOT NULL DEFAULT '',
    github_org TEXT NOT NULL DEFAULT '',
    github_project_number INTEGER,
    github_project_view_url TEXT NOT NULL DEFAULT '',
    slack_user_id TEXT NOT NULL DEFAULT '',
    dev_vm_ssh_host TEXT NOT NULL DEFAULT '',
    workspace_root TEXT NOT NULL DEFAULT '',
    gateway_base_url TEXT NOT NULL DEFAULT '',
    gateway_locked INTEGER NOT NULL DEFAULT 0,
    model_orchestrator TEXT NOT NULL DEFAULT 'gpt-4o-mini',
    model_worker TEXT NOT NULL DEFAULT 'gpt-4o-mini',
    model_fast TEXT NOT NULL DEFAULT 'gpt-4o-mini',
    model_embedding TEXT NOT NULL DEFAULT 'text-embedding-3-small',
    council_models_json TEXT NOT NULL DEFAULT '[]',
    offline_local_runner_enabled INTEGER NOT NULL DEFAULT 0,
    offline_local_runner_url TEXT NOT NULL DEFAULT 'http://127.0.0.1:11434/v1',
    offline_local_model TEXT NOT NULL DEFAULT '',
    autonomy_posture TEXT NOT NULL DEFAULT 'prepare',
    proactivity_level TEXT NOT NULL DEFAULT 'balanced',
    daily_budget_usd REAL NOT NULL DEFAULT 15.0,
    core_repos_json TEXT NOT NULL DEFAULT '{}',
    gke_contexts_json TEXT NOT NULL DEFAULT '[]',
    gcp_projects_json TEXT NOT NULL DEFAULT '[]',
    vip_people_json TEXT NOT NULL DEFAULT '[]',
    voice_style TEXT NOT NULL DEFAULT '',
    preferred_ide TEXT NOT NULL DEFAULT 'vscode',
    personalization_json TEXT NOT NULL DEFAULT '{"adaptive_ui":true,"background_collectors":false}',
    onboarding_completed INTEGER NOT NULL DEFAULT 1,
    is_demo INTEGER NOT NULL DEFAULT 0,
    is_active INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS dismissed_signatures (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id TEXT NOT NULL DEFAULT 'default',
    dedup_key TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT '',
    source_ref TEXT NOT NULL DEFAULT '',
    task_id INTEGER,
    reason TEXT NOT NULL DEFAULT 'not_mine',
    created_at TEXT NOT NULL,
    UNIQUE(profile_id, dedup_key)
);
CREATE INDEX IF NOT EXISTS idx_dismissed_profile_key ON dismissed_signatures(profile_id, dedup_key);
"""

OWNER_PROFILE_ID = "default"
DEMO_PROFILE_ID = "demo-sandbox"


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _ensure_column(conn: sqlite3.Connection, table: str, column: str, definition: str) -> None:
    cols = {str(r["name"]) for r in conn.execute(f"PRAGMA table_info({table})").fetchall()}
    if column not in cols:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")


def _decode_profile_row(row: sqlite3.Row | dict[str, Any] | None) -> dict[str, Any]:
    if row is None:
        return {}
    data = dict(row)
    for k in list(data.keys()):
        if k.endswith("_json") and isinstance(data[k], str):
            try:
                data[k[:-5]] = json.loads(data[k])
            except Exception:
                data[k[:-5]] = {} if "repos" in k or "hours" in k or "personalization" in k else []
    data["greeting_enabled"] = bool(data.get("greeting_enabled", 1))
    data["gateway_locked"] = bool(data.get("gateway_locked", 0))
    data["offline_local_runner_enabled"] = bool(data.get("offline_local_runner_enabled", 0))
    data["onboarding_completed"] = bool(data.get("onboarding_completed", 0))
    data["is_demo"] = bool(data.get("is_demo", 0))
    data["is_active"] = bool(data.get("is_active", 0))
    return data


def migrate_profiles_and_columns(conn: sqlite3.Connection) -> None:
    """Idempotently migrate SQLite schema to multi-profile & enriched ownership/approval columns."""
    conn.executescript(PROFILES_SCHEMA_SQL)
    _ensure_column(conn, "profiles", "gateway_base_url", "TEXT NOT NULL DEFAULT ''")

    for tbl in ("events", "tasks", "approvals", "meetings", "agent_runs", "briefings", "worktrees"):
        _ensure_column(conn, tbl, "profile_id", f"TEXT NOT NULL DEFAULT '{OWNER_PROFILE_ID}'")

    _ensure_column(conn, "tasks", "ownership_reason", "TEXT NOT NULL DEFAULT 'assigned_to_me'")
    _ensure_column(conn, "tasks", "confidence", "REAL NOT NULL DEFAULT 0.92")
    _ensure_column(conn, "tasks", "snoozed_until", "TEXT")
    _ensure_column(conn, "tasks", "mission_id", "TEXT NOT NULL DEFAULT ''")

    _ensure_column(conn, "approvals", "ownership_reason", "TEXT NOT NULL DEFAULT 'authored_by_me'")
    _ensure_column(conn, "approvals", "mission_id", "TEXT NOT NULL DEFAULT ''")
    _ensure_column(conn, "approvals", "risk_level", "TEXT NOT NULL DEFAULT 'medium'")

    now = _utc_now()
    existing_owner = conn.execute("SELECT id FROM profiles WHERE id = ?", (OWNER_PROFILE_ID,)).fetchone()
    if not existing_owner:
        default_gateway_url = os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1").strip().rstrip("/")
        conn.execute(
            """
            INSERT INTO profiles (
                id, slug, display_name, role_title, org_name, brand_display_name,
                timezone, email, github_login, github_org, github_project_number,
                github_project_view_url, slack_user_id, dev_vm_ssh_host, workspace_root,
                gateway_base_url, gateway_locked, model_orchestrator, model_worker,
                model_fast, model_embedding, autonomy_posture, proactivity_level,
                core_repos_json, gke_contexts_json, gcp_projects_json, vip_people_json,
                voice_style, preferred_ide, onboarding_completed, is_demo, is_active,
                created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                OWNER_PROFILE_ID,
                "default",
                "",
                "",
                "",
                "Command Engine",
                "UTC",
                "",
                "",
                "",
                None,
                "",
                "",
                "",
                "",
                default_gateway_url,
                0,
                config.MODEL_ORCHESTRATOR,
                config.MODEL_WORKER,
                config.MODEL_FAST,
                config.MODEL_EMBEDDING,
                "prepare",
                "balanced",
                json.dumps({}),
                json.dumps([]),
                json.dumps([]),
                json.dumps([]),
                "",
                "vscode",
                1,
                0,
                1,
                now,
                now,
            ),
        )

    # Guarantee exactly one active profile
    active_count = conn.execute("SELECT COUNT(*) AS c FROM profiles WHERE is_active = 1").fetchone()["c"]
    if int(active_count) == 0:
        conn.execute("UPDATE profiles SET is_active = 1 WHERE id = ?", (OWNER_PROFILE_ID,))


def get_active_profile(conn: sqlite3.Connection) -> dict[str, Any]:
    row = conn.execute("SELECT * FROM profiles WHERE is_active = 1 ORDER BY updated_at DESC LIMIT 1").fetchone()
    if not row:
        migrate_profiles_and_columns(conn)
        row = conn.execute("SELECT * FROM profiles WHERE is_active = 1 LIMIT 1").fetchone()
    return _decode_profile_row(row)


def get_active_profile_id(conn: sqlite3.Connection) -> str:
    prof = get_active_profile(conn)
    return str(prof.get("id") or OWNER_PROFILE_ID)


def list_profiles(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    rows = conn.execute("SELECT * FROM profiles ORDER BY is_active DESC, created_at ASC").fetchall()
    return [_decode_profile_row(r) for r in rows]


def create_user_profile(conn: sqlite3.Connection, payload: dict[str, Any]) -> dict[str, Any]:
    """
    Create a brand-new user profile OR a synthetic labeled Demo Sandbox profile when is_demo=True.
    """
    now = _utc_now()
    display_name = str(payload.get("display_name") or "Workspace Owner").strip()
    is_demo = bool(payload.get("is_demo", False))
    raw_slug = re.sub(r"[^a-z0-9-]+", "-", (payload.get("slug") or display_name).lower()).strip("-") or "user"

    if is_demo:
        profile_id = DEMO_PROFILE_ID
        slug = "demo-sandbox"
    else:
        suffix = uuid.uuid4().hex[:6]
        profile_id = f"profile-{raw_slug[:24]}-{suffix}"
        slug = f"{raw_slug[:24]}-{suffix}"

    activate = bool(payload.get("activate", False))
    if activate:
        conn.execute("UPDATE profiles SET is_active = 0")

    default_gateway_url = os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1").strip().rstrip("/")
    conn.execute(
        """
        INSERT INTO profiles (
            id, slug, display_name, role_title, org_name, brand_display_name,
            timezone, working_hours_json, quiet_hours_json, greeting_enabled,
            default_home_mode, email, github_login, github_org, github_project_number,
            github_project_view_url, slack_user_id, dev_vm_ssh_host, workspace_root,
            gateway_base_url, gateway_locked, model_orchestrator, model_worker,
            model_fast, model_embedding, council_models_json,
            offline_local_runner_enabled, offline_local_runner_url, offline_local_model,
            autonomy_posture, proactivity_level, daily_budget_usd,
            core_repos_json, gke_contexts_json, gcp_projects_json, vip_people_json,
            voice_style, preferred_ide, onboarding_completed, is_demo, is_active,
            created_at, updated_at
        )
        VALUES (
            ?, ?, ?, ?, ?, ?,
            ?, ?, ?, ?,
            ?, ?, ?, ?, ?,
            ?, ?, ?, ?,
            ?, ?, ?, ?,
            ?, ?, ?,
            ?, ?, ?,
            ?, ?, ?,
            ?, ?, ?, ?,
            ?, ?, ?, ?, ?,
            ?, ?
        )
        ON CONFLICT(id) DO UPDATE SET
            display_name=excluded.display_name,
            is_active=CASE WHEN excluded.is_active = 1 THEN 1 ELSE profiles.is_active END,
            updated_at=excluded.updated_at
        """,
        (
            profile_id,
            slug,
            f"{display_name} (Demo)" if is_demo and "(Demo)" not in display_name else display_name,
            str(payload.get("role_title") or ("Product & Systems Lead" if is_demo else "")),
            str(payload.get("org_name") or ("Synthetic Studio" if is_demo else "")),
            str(payload.get("brand_display_name") or "Command Engine"),
            str(payload.get("timezone") or "UTC"),
            json.dumps(payload.get("working_hours") or {"start": "09:00", "end": "17:30", "days": [1, 2, 3, 4, 5]}),
            json.dumps(payload.get("quiet_hours") or {"enabled": True, "start": "21:00", "end": "07:30"}),
            1 if payload.get("greeting_enabled", True) else 0,
            str(payload.get("default_home_mode") or "orbit"),
            str(payload.get("email") or ("demo@example.invalid" if is_demo else "")),
            str(payload.get("github_login") or ("demo-architect" if is_demo else "")),
            str(payload.get("github_org") or ("acme-demo" if is_demo else "")),
            payload.get("github_project_number"),
            str(payload.get("github_project_view_url") or ""),
            str(payload.get("slack_user_id") or ""),
            str(payload.get("dev_vm_ssh_host") or ""),
            str(payload.get("workspace_root") or ""),
            str(payload.get("gateway_base_url") or default_gateway_url),
            1 if payload.get("gateway_locked", False) else 0,
            str(payload.get("model_orchestrator") or config.MODEL_ORCHESTRATOR),
            str(payload.get("model_worker") or config.MODEL_WORKER),
            str(payload.get("model_fast") or config.MODEL_FAST),
            str(payload.get("model_embedding") or config.MODEL_EMBEDDING),
            json.dumps(payload.get("council_models") or [config.MODEL_ORCHESTRATOR]),
            1 if payload.get("offline_local_runner_enabled", False) else 0,
            str(payload.get("offline_local_runner_url") or "http://127.0.0.1:11434/v1"),
            str(payload.get("offline_local_model") or ""),
            str(payload.get("autonomy_posture") or "prepare"),
            str(payload.get("proactivity_level") or "balanced"),
            float(payload.get("daily_budget_usd") or 15.0),
            json.dumps(payload.get("core_repos") or {}),
            json.dumps(payload.get("gke_contexts") or []),
            json.dumps(payload.get("gcp_projects") or []),
            json.dumps(payload.get("vip_people") or []),
            str(payload.get("voice_style") or ""),
            str(payload.get("preferred_ide") or "vscode"),
            1 if payload.get("onboarding_completed", True) else 0,
            1 if is_demo else 0,
            1 if activate else 0,
            now,
            now,
        ),
    )

    if is_demo:
        _seed_synthetic_demo_data(conn, profile_id)

    row = conn.execute("SELECT * FROM profiles WHERE id = ?", (profile_id,)).fetchone()
    return _decode_profile_row(row)


def update_user_profile(conn: sqlite3.Connection, profile_id: str, patch: dict[str, Any]) -> dict[str, Any]:
    row = conn.execute("SELECT * FROM profiles WHERE id = ?", (profile_id,)).fetchone()
    if not row:
        raise KeyError(f"Profile '{profile_id}' not found.")

    scalar_fields = {
        "display_name",
        "role_title",
        "org_name",
        "brand_display_name",
        "timezone",
        "default_home_mode",
        "email",
        "github_login",
        "github_org",
        "github_project_number",
        "github_project_view_url",
        "slack_user_id",
        "dev_vm_ssh_host",
        "workspace_root",
        "gateway_base_url",
        "model_orchestrator",
        "model_worker",
        "model_fast",
        "model_embedding",
        "offline_local_runner_url",
        "offline_local_model",
        "autonomy_posture",
        "proactivity_level",
        "daily_budget_usd",
        "voice_style",
        "preferred_ide",
    }
    bool_fields = {
        "greeting_enabled",
        "gateway_locked",
        "offline_local_runner_enabled",
        "onboarding_completed",
    }
    json_fields = {
        "working_hours": "working_hours_json",
        "quiet_hours": "quiet_hours_json",
        "council_models": "council_models_json",
        "core_repos": "core_repos_json",
        "gke_contexts": "gke_contexts_json",
        "gcp_projects": "gcp_projects_json",
        "vip_people": "vip_people_json",
        "personalization": "personalization_json",
    }

    if patch.get("autonomy_posture") and patch["autonomy_posture"] not in {"observe", "prepare", "autopilot"}:
        raise ValueError("autonomy_posture must be 'observe', 'prepare', or 'autopilot'.")
    if patch.get("proactivity_level") and patch["proactivity_level"] not in {"strict", "balanced", "exploratory"}:
        raise ValueError("proactivity_level must be 'strict', 'balanced', or 'exploratory'.")

    assignments: list[str] = []
    values: list[Any] = []
    for k, v in patch.items():
        if k in scalar_fields and v is not None:
            assignments.append(f"{k} = ?")
            values.append(v)
        elif k in bool_fields and v is not None:
            assignments.append(f"{k} = ?")
            values.append(1 if v else 0)
        elif k in json_fields and v is not None:
            assignments.append(f"{json_fields[k]} = ?")
            values.append(json.dumps(v))

    if assignments:
        assignments.append("updated_at = ?")
        values.append(_utc_now())
        values.append(profile_id)
        conn.execute(f"UPDATE profiles SET {', '.join(assignments)} WHERE id = ?", values)

    updated = conn.execute("SELECT * FROM profiles WHERE id = ?", (profile_id,)).fetchone()
    return _decode_profile_row(updated)


def activate_user_profile(conn: sqlite3.Connection, profile_id: str) -> dict[str, Any]:
    row = conn.execute("SELECT * FROM profiles WHERE id = ?", (profile_id,)).fetchone()
    if not row:
        raise KeyError(f"Profile '{profile_id}' not found.")
    now = _utc_now()
    conn.execute("UPDATE profiles SET is_active = 0")
    conn.execute("UPDATE profiles SET is_active = 1, updated_at = ? WHERE id = ?", (now, profile_id))
    return _decode_profile_row(conn.execute("SELECT * FROM profiles WHERE id = ?", (profile_id,)).fetchone())


def _seed_synthetic_demo_data(conn: sqlite3.Connection, profile_id: str) -> None:
    """Seed strictly synthetic showcase fixtures for Demo Mode."""
    now = _utc_now()
    existing = conn.execute("SELECT COUNT(*) AS c FROM tasks WHERE profile_id = ?", (profile_id,)).fetchone()["c"]
    if int(existing) > 0:
        return

    demo_tasks = [
        (
            "demo:pr-review-412",
            "needed_from_me",
            "in_progress",
            "P0",
            "github",
            "acme-demo/orbital-runtime#412",
            "https://example.invalid/pr/412",
            "[DEMO] Verify connection pool backoff patch before release freeze",
            "Synthetic showcase item: Isolated worktree tests prepared; awaiting final diff sign-off.",
            "demo-architect",
            "Maya Lin",
            "acme-demo/orbital-runtime",
            "code",
            "assigned_to_me",
            0.98,
        ),
        (
            "demo:architecture-brief",
            "needed_from_me",
            "todo",
            "P1",
            "slack",
            "slack:demo-thread-1",
            "",
            "[DEMO] Confirm Q4 latency budget targets for edge gateway",
            "Synthetic showcase item: Direct request in #architecture-guild asking for your sign-off.",
            "demo-architect",
            "Jonas Weber",
            "acme-demo/edge-gateway",
            "reply",
            "direct_mention",
            0.94,
        ),
        (
            "demo:teammate-benchmark",
            "waiting_on_others",
            "todo",
            "P2",
            "transcript",
            "meet:demo-sync",
            "",
            "[DEMO] Elena to publish load-test flamegraphs",
            "Synthetic teammate commitment tracked passively (never placed in Needed From Me).",
            "Elena Rostova",
            "Elena Rostova",
            "acme-demo/orbital-runtime",
            "waiting",
            "teammate_commitment",
            0.96,
        ),
    ]
    for (
        dkey,
        bucket,
        status,
        prio,
        src,
        sref,
        surl,
        title,
        desc,
        owner,
        cp,
        repo,
        tkind,
        reason,
        conf,
    ) in demo_tasks:
        conn.execute(
            """
            INSERT OR IGNORE INTO tasks (
                profile_id, dedup_key, bucket, status, priority, source, source_ref, source_url,
                title, description, owner, counterparty, repo, task_kind, ownership_reason,
                confidence, created_at, updated_at, meta_json
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}')
            """,
            (profile_id, dkey, bucket, status, prio, src, sref, surl, title, desc, owner, cp, repo, tkind, reason, conf, now, now),
        )

    conn.execute(
        """
        INSERT OR IGNORE INTO meetings (
            profile_id, external_id, title, start_at, end_at, attendees_json, meet_url,
            prep_brief_md, transcript_status, summary_md, my_todos_json, waiting_on_others_json,
            created_at, updated_at
        )
        VALUES (?, 'demo-meeting-1', '[DEMO] Weekly Architecture & Reliability Sync', ?, ?, ?, '', ?, 'processed', ?, '[]', '[]', ?, ?)
        """,
        (
            profile_id,
            now,
            now,
            json.dumps(["Maya Lin", "Jonas Weber", "Elena Rostova"]),
            "Review synthetic retry backoff results and confirm latency SLO targets.",
            "Agreed to stage connection pool fix in isolated worktree before merging.",
            now,
            now,
        ),
    )
