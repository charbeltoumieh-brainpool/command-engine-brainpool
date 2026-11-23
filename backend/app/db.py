from __future__ import annotations

import json
import os
import re
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Any, Iterator

from .config import (
    BACKEND_PORT,
    DB_PATH,
    DEFAULT_AUTONOMY_POLICIES,
    DEFAULT_VIP_PEOPLE,
    MODEL_EMBEDDING,
    MODEL_ORCHESTRATOR,
    ensure_directories,
)


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def get_connection() -> sqlite3.Connection:
    ensure_directories()
    conn = sqlite3.connect(str(DB_PATH), timeout=30.0, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA synchronous=NORMAL;")
    conn.execute("PRAGMA foreign_keys=ON;")
    return conn


@contextmanager
def db_session() -> Iterator[sqlite3.Connection]:
    conn = get_connection()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    source_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    title TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL DEFAULT '',
    actor TEXT NOT NULL DEFAULT '',
    url TEXT NOT NULL DEFAULT '',
    channel_or_repo TEXT NOT NULL DEFAULT '',
    priority TEXT NOT NULL DEFAULT 'P2',
    ownership_reason TEXT NOT NULL DEFAULT 'mine',
    is_mine INTEGER NOT NULL DEFAULT 1,
    requires_action INTEGER NOT NULL DEFAULT 0,
    occurred_at TEXT NOT NULL,
    ingested_at TEXT NOT NULL,
    seen_at TEXT,
    meta_json TEXT NOT NULL DEFAULT '{}',
    UNIQUE(source, source_id)
);

CREATE INDEX IF NOT EXISTS idx_events_occurred ON events(occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_source ON events(source, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_seen ON events(seen_at);

CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
    title,
    summary,
    body,
    actor,
    channel_or_repo,
    source,
    content='events',
    content_rowid='id'
);

CREATE TRIGGER IF NOT EXISTS events_ai AFTER INSERT ON events BEGIN
    INSERT INTO events_fts(rowid, title, summary, body, actor, channel_or_repo, source)
    VALUES (new.id, new.title, new.summary, new.body, new.actor, new.channel_or_repo, new.source);
END;

CREATE TRIGGER IF NOT EXISTS events_ad AFTER DELETE ON events BEGIN
    INSERT INTO events_fts(events_fts, rowid, title, summary, body, actor, channel_or_repo, source)
    VALUES ('delete', old.id, old.title, old.summary, old.body, old.actor, old.channel_or_repo, old.source);
END;

CREATE TRIGGER IF NOT EXISTS events_au AFTER UPDATE ON events BEGIN
    INSERT INTO events_fts(events_fts, rowid, title, summary, body, actor, channel_or_repo, source)
    VALUES ('delete', old.id, old.title, old.summary, old.body, old.actor, old.channel_or_repo, old.source);
    INSERT INTO events_fts(rowid, title, summary, body, actor, channel_or_repo, source)
    VALUES (new.id, new.title, new.summary, new.body, new.actor, new.channel_or_repo, new.source);
END;

CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dedup_key TEXT UNIQUE,
    bucket TEXT NOT NULL DEFAULT 'needed_from_me',
    status TEXT NOT NULL DEFAULT 'todo',
    priority TEXT NOT NULL DEFAULT 'P1',
    source TEXT NOT NULL DEFAULT 'manual',
    source_ref TEXT NOT NULL DEFAULT '',
    source_url TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    owner TEXT NOT NULL DEFAULT '',
    counterparty TEXT NOT NULL DEFAULT '',
    repo TEXT NOT NULL DEFAULT '',
    due_at TEXT,
    meeting_id INTEGER,
    approval_id INTEGER,
    task_kind TEXT NOT NULL DEFAULT 'code',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    meta_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_tasks_bucket_status ON tasks(bucket, status, priority);

CREATE TABLE IF NOT EXISTS approvals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action_type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    title TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    repo TEXT NOT NULL DEFAULT '',
    worktree_path TEXT NOT NULL DEFAULT '',
    branch TEXT NOT NULL DEFAULT '',
    diff_preview TEXT NOT NULL DEFAULT '',
    test_output TEXT NOT NULL DEFAULT '',
    payload_json TEXT NOT NULL DEFAULT '{}',
    baseline_draft TEXT NOT NULL DEFAULT '',
    execute_at TEXT,
    pending_edited_payload_json TEXT,
    execution_result_json TEXT NOT NULL DEFAULT '{}',
    created_by_agent TEXT NOT NULL DEFAULT 'orchestrator',
    created_at TEXT NOT NULL,
    decided_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status, created_at DESC);

CREATE TABLE IF NOT EXISTS autonomy_policies (
    action_type TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    category TEXT NOT NULL,
    mode TEXT NOT NULL,
    locked INTEGER NOT NULL DEFAULT 0,
    description TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS meetings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    external_id TEXT UNIQUE NOT NULL,
    title TEXT NOT NULL,
    start_at TEXT NOT NULL,
    end_at TEXT NOT NULL,
    attendees_json TEXT NOT NULL DEFAULT '[]',
    meet_url TEXT NOT NULL DEFAULT '',
    prep_brief_md TEXT NOT NULL DEFAULT '',
    transcript_email_id TEXT NOT NULL DEFAULT '',
    transcript_drive_file_id TEXT NOT NULL DEFAULT '',
    transcript_url TEXT NOT NULL DEFAULT '',
    transcript_status TEXT NOT NULL DEFAULT 'scheduled',
    summary_md TEXT NOT NULL DEFAULT '',
    raw_transcript TEXT NOT NULL DEFAULT '',
    my_todos_json TEXT NOT NULL DEFAULT '[]',
    waiting_on_others_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS embeddings (
    item_kind TEXT NOT NULL,
    item_id INTEGER NOT NULL,
    profile_id TEXT NOT NULL DEFAULT 'default',
    model TEXT NOT NULL,
    text_hash TEXT NOT NULL,
    dim INTEGER NOT NULL,
    vector_blob BLOB NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (item_kind, item_id)
);

CREATE TABLE IF NOT EXISTS llm_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id TEXT NOT NULL DEFAULT 'default',
    provider_id TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL,
    operation TEXT NOT NULL DEFAULT 'chat',
    prompt_tokens INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0.0,
    budget_throttled INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_llm_usage_profile_created ON llm_usage(profile_id, created_at DESC);

CREATE TABLE IF NOT EXISTS watermarks (
    key TEXT PRIMARY KEY,
    timestamp_iso TEXT NOT NULL,
    cursor_value TEXT NOT NULL DEFAULT '',
    meta_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS agent_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    department TEXT NOT NULL,
    agent_name TEXT NOT NULL,
    model TEXT NOT NULL,
    status TEXT NOT NULL,
    trigger_source TEXT NOT NULL DEFAULT 'manual',
    items_processed INTEGER NOT NULL DEFAULT 0,
    summary TEXT NOT NULL DEFAULT '',
    started_at TEXT NOT NULL,
    finished_at TEXT,
    meta_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS briefings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    content_md TEXT NOT NULL,
    stats_json TEXT NOT NULL DEFAULT '{}',
    delivered_self_dm INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS worktrees (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    repo_key TEXT NOT NULL,
    branch TEXT NOT NULL,
    path TEXT UNIQUE NOT NULL,
    runner_mode TEXT NOT NULL DEFAULT 'local',
    status TEXT NOT NULL DEFAULT 'ready',
    pr_number INTEGER,
    issue_number INTEGER,
    last_test_status TEXT NOT NULL DEFAULT 'not_run',
    last_test_output TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS integrations (
    id TEXT PRIMARY KEY,
    category TEXT NOT NULL,
    name TEXT NOT NULL,
    provider TEXT NOT NULL DEFAULT '',
    icon TEXT NOT NULL DEFAULT '',
    accent_color TEXT NOT NULL DEFAULT '#6366f1',
    enabled INTEGER NOT NULL DEFAULT 1,
    is_default INTEGER NOT NULL DEFAULT 0,
    auth_status TEXT NOT NULL DEFAULT 'needs_auth',
    auth_message TEXT NOT NULL DEFAULT '',
    account_label TEXT NOT NULL DEFAULT '',
    command_or_url TEXT NOT NULL DEFAULT '',
    auth_command TEXT NOT NULL DEFAULT '',
    scopes_json TEXT NOT NULL DEFAULT '[]',
    config_json TEXT NOT NULL DEFAULT '{}',
    last_checked_at TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_pkce_states (
    state TEXT PRIMARY KEY,
    integration_id TEXT NOT NULL,
    profile_id TEXT NOT NULL DEFAULT 'default',
    provider TEXT NOT NULL,
    code_verifier TEXT NOT NULL,
    redirect_uri TEXT NOT NULL DEFAULT '',
    client_id TEXT NOT NULL DEFAULT '',
    client_secret TEXT NOT NULL DEFAULT '',
    created_at_epoch REAL NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS voice_edit_samples (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id TEXT NOT NULL DEFAULT 'default',
    approval_id INTEGER,
    action_type TEXT NOT NULL DEFAULT '',
    original_draft TEXT NOT NULL,
    final_draft TEXT NOT NULL,
    diff_summary TEXT NOT NULL DEFAULT '',
    extracted_rules_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_voice_samples_profile ON voice_edit_samples(profile_id, created_at DESC);

CREATE TABLE IF NOT EXISTS meeting_dossiers (
    meeting_id INTEGER PRIMARY KEY,
    profile_id TEXT NOT NULL DEFAULT 'default',
    dossier_json TEXT NOT NULL DEFAULT '{}',
    talking_points_md TEXT NOT NULL DEFAULT '',
    generated_at TEXT NOT NULL
);
"""


DEFAULT_SETTINGS = {
    "timezone": "UTC",
    "morning_briefing_time": "08:30",
    "eod_wrapup_time": "18:00",
    "delta_sync_minutes": 30,
    "post_meeting_delay_minutes": 15,
    "schedules_enabled": False,
    "default_runner_mode": "local",
    "dev_vm_ssh": "",
    "phoenix_url": "",
    "vip_people": DEFAULT_VIP_PEOPLE,
    "voice_style": "Concise, direct, bullet-first executive & engineering tone.",
    "runtime_mode": "web_local",
    "standalone_port": BACKEND_PORT,
    "gateway_base_url": os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1"),
    "default_coding_agent": "local",
}


AI_PROVIDER_PRESETS: list[dict[str, Any]] = [
    {
        "id": "openai",
        "name": "OpenAI",
        "base_url": "https://api.openai.com/v1",
        "default_model": MODEL_ORCHESTRATOR,
        "embedding_model": MODEL_EMBEDDING,
        "requires_api_key": True,
    },
    {
        "id": "openrouter",
        "name": "OpenRouter",
        "base_url": "https://openrouter.ai/api/v1",
        "default_model": "openai/gpt-4o-mini",
        "embedding_model": "openai/text-embedding-3-small",
        "requires_api_key": True,
    },
    {
        "id": "ollama",
        "name": "Ollama (Local)",
        "base_url": "http://127.0.0.1:11434/v1",
        "default_model": "llama3.2",
        "embedding_model": "nomic-embed-text",
        "requires_api_key": False,
    },
    {
        "id": "custom-gateway",
        "name": "Custom OpenAI-Compatible Gateway",
        "base_url": "",
        "default_model": MODEL_ORCHESTRATOR,
        "embedding_model": MODEL_EMBEDDING,
        "requires_api_key": True,
    },
]


DEFAULT_INTEGRATIONS: list[dict[str, Any]] = [
    {
        "id": "google-calendar",
        "category": "workspace_app",
        "name": "Google Calendar",
        "provider": "Google Workspace",
        "icon": "logos:google-calendar",
        "accent_color": "#3b82f6",
        "enabled": 1,
        "is_default": 0,
        "auth_status": "needs_auth",
        "auth_message": "Configure credentials in backend/.env",
        "account_label": "Not configured",
        "command_or_url": "https://calendar.google.com",
        "auth_command": "",
        "scopes": ["calendar.readonly", "events.prep"],
        "config": {},
    },
    {
        "id": "gmail",
        "category": "workspace_app",
        "name": "Gmail",
        "provider": "Google Workspace",
        "icon": "logos:google-gmail",
        "accent_color": "#ef4444",
        "enabled": 1,
        "is_default": 0,
        "auth_status": "needs_auth",
        "auth_message": "Configure credentials in backend/.env",
        "account_label": "Not configured",
        "command_or_url": "https://mail.google.com",
        "auth_command": "",
        "scopes": ["gmail.readonly", "gmail.compose_staged"],
        "config": {},
    },
    {
        "id": "google-meet",
        "category": "workspace_app",
        "name": "Google Meet & Notes",
        "provider": "Google Workspace",
        "icon": "logos:google-meet",
        "accent_color": "#10b981",
        "enabled": 1,
        "is_default": 0,
        "auth_status": "needs_auth",
        "auth_message": "Configure credentials in backend/.env",
        "account_label": "Not configured",
        "command_or_url": "https://meet.google.com",
        "auth_command": "",
        "scopes": ["meet.transcripts"],
        "config": {},
    },
    {
        "id": "slack",
        "category": "workspace_app",
        "name": "Slack",
        "provider": "Slack Workspace",
        "icon": "logos:slack-icon",
        "accent_color": "#8b5cf6",
        "enabled": 1,
        "is_default": 0,
        "auth_status": "needs_auth",
        "auth_message": "Configure credentials in backend/.env",
        "account_label": "Not configured",
        "command_or_url": "https://app.slack.com",
        "auth_command": "",
        "scopes": ["dms.read", "mentions.read", "self_dm.send", "external.ask_first"],
        "config": {},
    },
    {
        "id": "google-drive",
        "category": "workspace_app",
        "name": "Google Drive & Docs",
        "provider": "Google Workspace",
        "icon": "logos:google-drive",
        "accent_color": "#f59e0b",
        "enabled": 1,
        "is_default": 0,
        "auth_status": "needs_auth",
        "auth_message": "Configure credentials in backend/.env",
        "account_label": "Not configured",
        "command_or_url": "https://drive.google.com",
        "auth_command": "",
        "scopes": ["drive.readonly", "comments.ask_first"],
        "config": {},
    },
    {
        "id": "github",
        "category": "workspace_app",
        "name": "GitHub",
        "provider": "GitHub REST API",
        "icon": "logos:github-icon",
        "accent_color": "#1e293b",
        "enabled": 1,
        "is_default": 0,
        "auth_status": "needs_auth",
        "auth_message": "Configure credentials in backend/.env",
        "account_label": "Not configured",
        "command_or_url": "https://api.github.com",
        "auth_command": "",
        "scopes": ["repo", "read:project", "owned_only_guardrail"],
        "config": {},
    },
    {
        "id": "google-cloud-gke",
        "category": "cloud_infra",
        "name": "Google Cloud & GKE (Read-Only)",
        "provider": "GCP · Read-Only",
        "icon": "logos:google-cloud",
        "accent_color": "#2563eb",
        "enabled": 0,
        "is_default": 0,
        "auth_status": "needs_auth",
        "auth_message": "Configure credentials in backend/.env",
        "account_label": "Not configured",
        "command_or_url": "gcloud",
        "auth_command": "",
        "scopes": ["gke.readonly_locked", "logging.read"],
        "config": {"readonly_locked": True},
    },
    {
        "id": "openai-gateway",
        "category": "cloud_infra",
        "name": "Model Gateway",
        "provider": "OpenAI-Compatible API",
        "icon": "fluent-color:bot-sparkle-24",
        "accent_color": "#ec4899",
        "enabled": 1,
        "is_default": 1,
        "auth_status": "needs_auth",
        "auth_message": "Configure credentials in backend/.env",
        "account_label": "Not configured",
        "command_or_url": os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1"),
        "auth_command": "",
        "scopes": ["chat.completions", "embeddings"],
        "config": {},
    },
]


_CALL_TITLE_RE = re.compile(
    r"^(attend|join|dial into|hop on)\b|\b(on-?boarding call|rescheduled .* call|1:1 meeting|one-on-one|stand\s*up call|sync call|video call|google meet)\b",
    re.IGNORECASE,
)
_CALL_EXCLUDE_RE = re.compile(
    r"^(draft|write|implement|fix|bump|post|prepare|verify|review|check|build|merge|create|update)\b",
    re.IGNORECASE,
)
_REPLY_RE = re.compile(
    r"^(post|reply|send|message|email|dm|share|announce)\b",
    re.IGNORECASE,
)
_REVIEW_RE = re.compile(
    r"^(review|verify|check|audit|inspect|confirm)\b|\[private review summary only\]",
    re.IGNORECASE,
)


def infer_task_kind(
    title: str,
    description: str = "",
    source: str = "",
    bucket: str = "needed_from_me",
    repo: str = "",
) -> str:
    """Classify a task semantically so calls, reviews, replies, waiting items, and coding tasks show appropriate actions."""
    b = (bucket or "needed_from_me").strip().lower()
    if b == "waiting_on_others":
        return "waiting"
    t = (title or "").strip()
    s = (source or "").strip().lower()
    if _CALL_TITLE_RE.search(t) and not _CALL_EXCLUDE_RE.search(t):
        return "call"
    if s == "calendar" and not _CALL_EXCLUDE_RE.search(t):
        return "call"
    if _REPLY_RE.search(t):
        return "reply"
    if _REVIEW_RE.search(t) and s not in {"local"} and not t.lower().startswith("review/commit local wip"):
        return "review"
    if repo or s in {"github", "local"} or _CALL_EXCLUDE_RE.search(t):
        return "code"
    return "code"


def is_auth_error_text(text: str) -> bool:
    """Detect OAuth / CLI sign-in / credential expiry output so it routes to top-right Sign-In instead of feed errors."""
    low = (text or "").lower()
    if not low:
        return False
    markers = (
        "cred.go",
        "print credential failed",
        "failed to retrieve access token",
        "gcloud auth login",
        "reauthentication",
        "oauth2: cannot fetch token",
        "invalid_grant",
        "token has been expired or revoked",
        "gh auth login",
        "authentication required",
        "please run `gcloud auth",
    )
    return any(m in low for m in markers)


def record_integration_auth_status(
    conn: sqlite3.Connection,
    integration_id: str,
    auth_status: str,
    auth_message: str = "",
    account_label: str | None = None,
) -> None:
    now = utc_now_iso()
    if account_label is not None:
        conn.execute(
            """
            UPDATE integrations
            SET auth_status = ?, auth_message = ?, account_label = ?, last_checked_at = ?, updated_at = ?
            WHERE id = ?
            """,
            (auth_status, auth_message, account_label, now, now, integration_id),
        )
    else:
        conn.execute(
            """
            UPDATE integrations
            SET auth_status = ?, auth_message = ?, last_checked_at = ?, updated_at = ?
            WHERE id = ?
            """,
            (auth_status, auth_message, now, now, integration_id),
        )


def get_auth_alerts(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    rows = conn.execute(
        """
        SELECT id, category, name, provider, icon, accent_color, auth_status, auth_message, account_label, auth_command, updated_at
        FROM integrations
        WHERE enabled = 1 AND auth_status = 'needs_auth'
        ORDER BY updated_at DESC
        """
    ).fetchall()
    return [dict(r) for r in rows]


def init_db() -> None:
    now = utc_now_iso()
    with db_session() as conn:
        conn.executescript(SCHEMA_SQL)

        task_cols = {
            str(r["name"])
            for r in conn.execute("PRAGMA table_info(tasks)").fetchall()
        }
        if "task_kind" not in task_cols:
            conn.execute("ALTER TABLE tasks ADD COLUMN task_kind TEXT NOT NULL DEFAULT 'code'")

        emb_cols = {
            str(r["name"])
            for r in conn.execute("PRAGMA table_info(embeddings)").fetchall()
        }
        if "profile_id" not in emb_cols:
            conn.execute("ALTER TABLE embeddings ADD COLUMN profile_id TEXT NOT NULL DEFAULT 'default'")
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_embeddings_profile ON embeddings(profile_id, item_kind, item_id)"
        )

        approval_cols = {
            str(r["name"])
            for r in conn.execute("PRAGMA table_info(approvals)").fetchall()
        }
        if "baseline_draft" not in approval_cols:
            conn.execute("ALTER TABLE approvals ADD COLUMN baseline_draft TEXT NOT NULL DEFAULT ''")
        if "execute_at" not in approval_cols:
            conn.execute("ALTER TABLE approvals ADD COLUMN execute_at TEXT")
        if "pending_edited_payload_json" not in approval_cols:
            conn.execute("ALTER TABLE approvals ADD COLUMN pending_edited_payload_json TEXT")

        usage_cols = {
            str(r["name"])
            for r in conn.execute("PRAGMA table_info(llm_usage)").fetchall()
        }
        if "budget_throttled" not in usage_cols:
            conn.execute("ALTER TABLE llm_usage ADD COLUMN budget_throttled INTEGER NOT NULL DEFAULT 0")

        for action_type, label, category, mode, locked, desc in DEFAULT_AUTONOMY_POLICIES:
            conn.execute(
                """
                INSERT INTO autonomy_policies(action_type, label, category, mode, locked, description, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(action_type) DO NOTHING
                """,
                (action_type, label, category, mode, locked, desc, now),
            )
        for key, value in DEFAULT_SETTINGS.items():
            conn.execute(
                """
                INSERT INTO settings(key, value_json, updated_at)
                VALUES (?, ?, ?)
                ON CONFLICT(key) DO NOTHING
                """,
                (key, json.dumps(value), now),
            )
        for item in DEFAULT_INTEGRATIONS:
            conn.execute(
                """
                INSERT INTO integrations(
                    id, category, name, provider, icon, accent_color, enabled, is_default,
                    auth_status, auth_message, account_label, command_or_url, auth_command,
                    scopes_json, config_json, last_checked_at, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO NOTHING
                """,
                (
                    item["id"],
                    item["category"],
                    item["name"],
                    item.get("provider", ""),
                    item.get("icon", ""),
                    item.get("accent_color", "#6366f1"),
                    int(item.get("enabled", 1)),
                    int(item.get("is_default", 0)),
                    item.get("auth_status", "needs_auth"),
                    item.get("auth_message", ""),
                    item.get("account_label", ""),
                    item.get("command_or_url", ""),
                    item.get("auth_command", ""),
                    json.dumps(item.get("scopes") or []),
                    json.dumps(item.get("config") or {}),
                    now,
                    now,
                ),
            )

        existing_tasks = conn.execute(
            "SELECT id, title, description, source, bucket, repo, task_kind FROM tasks"
        ).fetchall()
        for r in existing_tasks:
            inferred = infer_task_kind(
                title=str(r["title"] or ""),
                description=str(r["description"] or ""),
                source=str(r["source"] or ""),
                bucket=str(r["bucket"] or "needed_from_me"),
                repo=str(r["repo"] or ""),
            )
            if r["task_kind"] != inferred:
                conn.execute("UPDATE tasks SET task_kind = ? WHERE id = ?", (inferred, int(r["id"])))

        conn.execute(
            """
            INSERT INTO watermarks(key, timestamp_iso, cursor_value, meta_json)
            VALUES ('user_last_checked', ?, '', '{}')
            ON CONFLICT(key) DO NOTHING
            """,
            ("1970-01-01T00:00:00+00:00",),
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

        from .profiles import migrate_profiles_and_columns
        from .missions import init_missions_storage

        migrate_profiles_and_columns(conn)
        init_missions_storage(conn)


def row_to_dict(row: sqlite3.Row | None) -> dict[str, Any] | None:
    if row is None:
        return None
    data = dict(row)
    for key in list(data.keys()):
        if key.endswith("_json") and isinstance(data[key], str):
            try:
                data[key[:-5]] = json.loads(data[key])
            except Exception:
                data[key[:-5]] = data[key]
    return data


def upsert_event(conn: sqlite3.Connection, event: dict[str, Any]) -> int:
    from .profiles import get_active_profile_id

    now = utc_now_iso()
    profile_id = str(event.get("profile_id") or get_active_profile_id(conn))
    source_val = str(event["source"])
    raw_source_id = str(event["source_id"])
    effective_source_id = raw_source_id
    existing = conn.execute(
        "SELECT id, profile_id FROM events WHERE source = ? AND source_id = ?",
        (source_val, raw_source_id),
    ).fetchone()
    if existing and str(existing["profile_id"] or "") != profile_id:
        effective_source_id = f"{profile_id}::{raw_source_id}"

    meta_str = json.dumps(event.get("meta") or {})
    conn.execute(
        """
        INSERT INTO events(
            profile_id, source, source_id, event_type, title, summary, body, actor, url,
            channel_or_repo, priority, ownership_reason, is_mine, requires_action,
            occurred_at, ingested_at, meta_json
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source, source_id) DO UPDATE SET
            event_type=excluded.event_type,
            title=excluded.title,
            summary=excluded.summary,
            body=CASE WHEN excluded.body != '' THEN excluded.body ELSE events.body END,
            actor=excluded.actor,
            url=CASE WHEN excluded.url != '' THEN excluded.url ELSE events.url END,
            channel_or_repo=excluded.channel_or_repo,
            priority=excluded.priority,
            ownership_reason=excluded.ownership_reason,
            is_mine=excluded.is_mine,
            requires_action=excluded.requires_action,
            occurred_at=excluded.occurred_at,
            ingested_at=excluded.ingested_at,
            meta_json=excluded.meta_json
        """,
        (
            profile_id,
            source_val,
            effective_source_id,
            str(event.get("event_type") or "item"),
            str(event["title"]),
            str(event.get("summary") or ""),
            str(event.get("body") or ""),
            str(event.get("actor") or ""),
            str(event.get("url") or ""),
            str(event.get("channel_or_repo") or ""),
            str(event.get("priority") or "P2"),
            str(event.get("ownership_reason") or "mine"),
            1 if event.get("is_mine", True) else 0,
            1 if event.get("requires_action", False) else 0,
            str(event.get("occurred_at") or now),
            now,
            meta_str,
        ),
    )
    row = conn.execute(
        "SELECT id FROM events WHERE source = ? AND source_id = ? AND profile_id = ?",
        (source_val, effective_source_id, profile_id),
    ).fetchone()
    return int(row["id"])


def upsert_task(conn: sqlite3.Connection, task: dict[str, Any]) -> int:
    from .profiles import get_active_profile_id

    now = utc_now_iso()
    profile_id = str(task.get("profile_id") or get_active_profile_id(conn))
    raw_dedup_key = str(task.get("dedup_key") or f"{task.get('source', 'manual')}:{task.get('source_ref') or task['title']}")
    dedup_key = raw_dedup_key
    existing = conn.execute(
        "SELECT id, profile_id FROM tasks WHERE dedup_key = ?",
        (raw_dedup_key,),
    ).fetchone()
    if existing and str(existing["profile_id"] or "") != profile_id:
        dedup_key = f"{profile_id}::{raw_dedup_key}"

    meta_str = json.dumps(task.get("meta") or {})
    bucket_val = str(task.get("bucket") or "needed_from_me")
    source_val = str(task.get("source") or "manual")
    title_val = str(task["title"])
    desc_val = str(task.get("description") or "")
    repo_val = str(task.get("repo") or "")
    ownership_reason = str(task.get("ownership_reason") or ("teammate_commitment" if bucket_val == "waiting_on_others" else "assigned_to_me"))
    confidence = float(task.get("confidence") if task.get("confidence") is not None else 0.92)
    kind_val = str(
        task.get("task_kind")
        or infer_task_kind(
            title=title_val,
            description=desc_val,
            source=source_val,
            bucket=bucket_val,
            repo=repo_val,
        )
    )

    dismissed_sig = conn.execute(
        "SELECT id FROM dismissed_signatures WHERE profile_id = ? AND dedup_key IN (?, ?)",
        (profile_id, raw_dedup_key, dedup_key),
    ).fetchone()
    effective_status = "dismissed" if (dismissed_sig and not task.get("force_restore")) else str(task.get("status") or "todo")

    conn.execute(
        """
        INSERT INTO tasks(
            profile_id, dedup_key, bucket, status, priority, source, source_ref, source_url,
            title, description, owner, counterparty, repo, due_at, meeting_id,
            approval_id, task_kind, ownership_reason, confidence, created_at, updated_at, meta_json
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(dedup_key) DO UPDATE SET
            bucket=excluded.bucket,
            status=CASE
                WHEN tasks.status IN ('done', 'dismissed') AND excluded.status = 'todo' THEN tasks.status
                ELSE excluded.status
            END,
            priority=excluded.priority,
            source_url=CASE WHEN excluded.source_url != '' THEN excluded.source_url ELSE tasks.source_url END,
            title=excluded.title,
            description=CASE WHEN excluded.description != '' THEN excluded.description ELSE tasks.description END,
            counterparty=CASE WHEN excluded.counterparty != '' THEN excluded.counterparty ELSE tasks.counterparty END,
            repo=CASE WHEN excluded.repo != '' THEN excluded.repo ELSE tasks.repo END,
            due_at=COALESCE(excluded.due_at, tasks.due_at),
            meeting_id=COALESCE(excluded.meeting_id, tasks.meeting_id),
            approval_id=COALESCE(excluded.approval_id, tasks.approval_id),
            task_kind=excluded.task_kind,
            ownership_reason=excluded.ownership_reason,
            confidence=excluded.confidence,
            updated_at=excluded.updated_at,
            meta_json=excluded.meta_json
        """,
        (
            profile_id,
            dedup_key,
            bucket_val,
            effective_status,
            str(task.get("priority") or "P1"),
            source_val,
            str(task.get("source_ref") or ""),
            str(task.get("source_url") or ""),
            title_val,
            desc_val,
            str(task.get("owner") or ""),
            str(task.get("counterparty") or ""),
            repo_val,
            task.get("due_at"),
            task.get("meeting_id"),
            task.get("approval_id"),
            kind_val,
            ownership_reason,
            confidence,
            now,
            now,
            meta_str,
        ),
    )
    row = conn.execute(
        "SELECT id FROM tasks WHERE dedup_key = ? AND profile_id = ?",
        (dedup_key, profile_id),
    ).fetchone()
    return int(row["id"])


def dismiss_task_durable(conn: sqlite3.Connection, task_id: int, reason: str = "not_mine") -> dict[str, Any] | None:
    """Mark a task dismissed AND persist its dedup_key signature so sweeps never recreate it."""
    row = conn.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
    if not row:
        return None
    now = utc_now_iso()
    profile_id = str(row["profile_id"] or "default")
    dedup_key = str(row["dedup_key"] or f"task:{task_id}")
    conn.execute(
        """
        INSERT INTO dismissed_signatures(profile_id, dedup_key, source, source_ref, task_id, reason, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(profile_id, dedup_key) DO UPDATE SET reason=excluded.reason, created_at=excluded.created_at
        """,
        (profile_id, dedup_key, str(row["source"] or ""), str(row["source_ref"] or ""), task_id, reason, now),
    )
    conn.execute(
        "UPDATE tasks SET status = 'dismissed', updated_at = ? WHERE id = ?",
        (now, task_id),
    )
    return row_to_dict(conn.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone())


def restore_dismissed_task(conn: sqlite3.Connection, task_id: int) -> dict[str, Any] | None:
    """Explicitly restore a previously dismissed task back into the active queue."""
    row = conn.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
    if not row:
        return None
    now = utc_now_iso()
    profile_id = str(row["profile_id"] or "default")
    dedup_key = str(row["dedup_key"] or "")
    if dedup_key:
        conn.execute(
            "DELETE FROM dismissed_signatures WHERE profile_id = ? AND dedup_key = ?",
            (profile_id, dedup_key),
        )
    conn.execute(
        "UPDATE tasks SET status = 'todo', updated_at = ? WHERE id = ?",
        (now, task_id),
    )
    return row_to_dict(conn.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone())


def upsert_meeting(conn: sqlite3.Connection, meeting: dict[str, Any]) -> int:
    from .profiles import get_active_profile_id

    now = utc_now_iso()
    profile_id = str(meeting.get("profile_id") or get_active_profile_id(conn))
    raw_ext_id = str(meeting["external_id"])
    ext_id = raw_ext_id
    existing = conn.execute(
        "SELECT id, profile_id FROM meetings WHERE external_id = ?",
        (raw_ext_id,),
    ).fetchone()
    if existing and str(existing["profile_id"] or "") != profile_id:
        ext_id = f"{profile_id}::{raw_ext_id}"

    conn.execute(
        """
        INSERT INTO meetings(
            profile_id, external_id, title, start_at, end_at, attendees_json, meet_url,
            prep_brief_md, transcript_email_id, transcript_drive_file_id, transcript_url,
            transcript_status, summary_md, raw_transcript, my_todos_json,
            waiting_on_others_json, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(external_id) DO UPDATE SET
            title=excluded.title,
            start_at=excluded.start_at,
            end_at=excluded.end_at,
            attendees_json=CASE WHEN excluded.attendees_json != '[]' THEN excluded.attendees_json ELSE meetings.attendees_json END,
            meet_url=CASE WHEN excluded.meet_url != '' THEN excluded.meet_url ELSE meetings.meet_url END,
            prep_brief_md=CASE WHEN excluded.prep_brief_md != '' THEN excluded.prep_brief_md ELSE meetings.prep_brief_md END,
            transcript_email_id=CASE WHEN excluded.transcript_email_id != '' THEN excluded.transcript_email_id ELSE meetings.transcript_email_id END,
            transcript_drive_file_id=CASE WHEN excluded.transcript_drive_file_id != '' THEN excluded.transcript_drive_file_id ELSE meetings.transcript_drive_file_id END,
            transcript_url=CASE WHEN excluded.transcript_url != '' THEN excluded.transcript_url ELSE meetings.transcript_url END,
            transcript_status=excluded.transcript_status,
            summary_md=CASE WHEN excluded.summary_md != '' THEN excluded.summary_md ELSE meetings.summary_md END,
            raw_transcript=CASE WHEN excluded.raw_transcript != '' THEN excluded.raw_transcript ELSE meetings.raw_transcript END,
            my_todos_json=CASE WHEN excluded.my_todos_json != '[]' THEN excluded.my_todos_json ELSE meetings.my_todos_json END,
            waiting_on_others_json=CASE WHEN excluded.waiting_on_others_json != '[]' THEN excluded.waiting_on_others_json ELSE meetings.waiting_on_others_json END,
            updated_at=excluded.updated_at
        """,
        (
            profile_id,
            ext_id,
            str(meeting["title"]),
            str(meeting.get("start_at") or now),
            str(meeting.get("end_at") or now),
            json.dumps(meeting.get("attendees") or []),
            str(meeting.get("meet_url") or ""),
            str(meeting.get("prep_brief_md") or ""),
            str(meeting.get("transcript_email_id") or ""),
            str(meeting.get("transcript_drive_file_id") or ""),
            str(meeting.get("transcript_url") or ""),
            str(meeting.get("transcript_status") or "scheduled"),
            str(meeting.get("summary_md") or ""),
            str(meeting.get("raw_transcript") or ""),
            json.dumps(meeting.get("my_todos") or []),
            json.dumps(meeting.get("waiting_on_others") or []),
            now,
            now,
        ),
    )
    row = conn.execute(
        "SELECT id FROM meetings WHERE external_id = ? AND profile_id = ?",
        (ext_id, profile_id),
    ).fetchone()
    return int(row["id"])


def create_approval(conn: sqlite3.Connection, approval: dict[str, Any]) -> int:
    from .profiles import get_active_profile_id

    now = utc_now_iso()
    profile_id = str(approval.get("profile_id") or get_active_profile_id(conn))
    payload_dict = approval.get("payload") or {}
    baseline_draft = str(approval.get("baseline_draft") or "")
    if not baseline_draft and isinstance(payload_dict, dict):
        for key in ("message", "body", "top_level_body", "text"):
            val = payload_dict.get(key)
            if isinstance(val, str) and val.strip():
                baseline_draft = val
                break

    cur = conn.execute(
        """
        INSERT INTO approvals(
            profile_id, mission_id, action_type, status, risk_level, ownership_reason,
            title, summary, repo, worktree_path, branch,
            diff_preview, test_output, payload_json, baseline_draft, created_by_agent, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            profile_id,
            str(approval.get("mission_id") or ""),
            str(approval["action_type"]),
            str(approval.get("status") or "pending"),
            str(approval.get("risk_level") or "medium"),
            str(approval.get("ownership_reason") or "authored_by_me"),
            str(approval["title"]),
            str(approval.get("summary") or ""),
            str(approval.get("repo") or ""),
            str(approval.get("worktree_path") or ""),
            str(approval.get("branch") or ""),
            str(approval.get("diff_preview") or ""),
            str(approval.get("test_output") or ""),
            json.dumps(payload_dict),
            baseline_draft,
            str(approval.get("created_by_agent") or MODEL_ORCHESTRATOR),
            now,
        ),
    )
    return int(cur.lastrowid)


def create_wal_backup(label: str = "manual") -> dict[str, Any]:
    """Create an online WAL-safe SQLite snapshot using sqlite3.Connection.backup()."""
    from .safety import SAFE_SLUG_ID_RE

    safe_label = re.sub(r"[^a-zA-Z0-9_-]+", "-", label or "snapshot").strip("-")[:32] or "snapshot"
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backups_dir = DB_PATH.parent / "backups"
    backups_dir.mkdir(parents=True, exist_ok=True)
    dest_name = f"command_engine_{safe_label}_{stamp}.db"
    if not SAFE_SLUG_ID_RE.match(dest_name):
        raise ValueError("Invalid backup filename.")
    dest_path = backups_dir / dest_name

    src_conn = sqlite3.connect(str(DB_PATH), timeout=30.0)
    dst_conn = sqlite3.connect(str(dest_path), timeout=30.0)
    try:
        src_conn.backup(dst_conn)
    finally:
        dst_conn.close()
        src_conn.close()

    return {
        "filename": dest_name,
        "path": str(dest_path),
        "size_bytes": dest_path.stat().st_size,
        "created_at": utc_now_iso(),
    }


def list_wal_backups() -> list[dict[str, Any]]:
    backups_dir = DB_PATH.parent / "backups"
    if not backups_dir.exists():
        return []
    out: list[dict[str, Any]] = []
    for f in sorted(backups_dir.glob("*.db"), key=lambda p: p.stat().st_mtime, reverse=True):
        st = f.stat()
        out.append(
            {
                "filename": f.name,
                "size_bytes": st.st_size,
                "updated_at": datetime.fromtimestamp(st.st_mtime, tz=timezone.utc).isoformat(),
            }
        )
    return out


def restore_wal_backup(filename: str) -> dict[str, Any]:
    """Verify backup integrity, take an automatic pre-restore safety snapshot, and restore."""
    from .safety import resolve_safe_child

    backups_dir = DB_PATH.parent / "backups"
    src_backup = resolve_safe_child(backups_dir, filename)
    if not src_backup.exists() or src_backup.suffix != ".db":
        raise FileNotFoundError(f"Backup '{filename}' not found.")

    chk_conn = sqlite3.connect(str(src_backup))
    try:
        verdict = chk_conn.execute("PRAGMA integrity_check;").fetchone()[0]
        if str(verdict).lower() != "ok":
            raise ValueError(f"Backup failed SQLite integrity_check: {verdict}")
    finally:
        chk_conn.close()

    pre_snapshot = create_wal_backup("pre_restore_auto")

    src_conn = sqlite3.connect(str(src_backup), timeout=30.0)
    dst_conn = sqlite3.connect(str(DB_PATH), timeout=30.0)
    try:
        src_conn.backup(dst_conn)
    finally:
        dst_conn.close()
        src_conn.close()

    init_db()
    return {
        "restored_from": filename,
        "pre_restore_backup": pre_snapshot["filename"],
        "restored_at": utc_now_iso(),
    }


def start_agent_run(
    conn: sqlite3.Connection,
    department: str,
    agent_name: str,
    model: str,
    trigger_source: str = "manual",
    profile_id: str | None = None,
) -> int:
    from .profiles import get_active_profile_id

    now = utc_now_iso()
    pid = str(profile_id or get_active_profile_id(conn))
    cur = conn.execute(
        """
        INSERT INTO agent_runs(profile_id, department, agent_name, model, status, trigger_source, started_at)
        VALUES (?, ?, ?, ?, 'running', ?, ?)
        """,
        (pid, department, agent_name, model, trigger_source, now),
    )
    return int(cur.lastrowid)


def record_llm_usage(
    conn: sqlite3.Connection,
    *,
    profile_id: str,
    provider_id: str,
    model: str,
    operation: str = "chat",
    call_kind: str | None = None,
    prompt_tokens: int = 0,
    completion_tokens: int = 0,
    total_tokens: int = 0,
    cost_usd: float = 0.0,
    budget_throttled: bool = False,
) -> int:
    now = utc_now_iso()
    eff_op = str(call_kind or operation or "chat")
    p_tok = max(0, int(prompt_tokens or 0))
    c_tok = max(0, int(completion_tokens or 0))
    t_tok = max(0, int(total_tokens or (p_tok + c_tok)))
    cur = conn.execute(
        """
        INSERT INTO llm_usage(
            profile_id, provider_id, model, operation,
            prompt_tokens, completion_tokens, total_tokens,
            cost_usd, budget_throttled, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            str(profile_id or "default"),
            str(provider_id or ""),
            str(model or ""),
            eff_op,
            p_tok,
            c_tok,
            t_tok,
            max(0.0, float(cost_usd or 0.0)),
            1 if budget_throttled else 0,
            now,
        ),
    )
    return int(cur.lastrowid)


def finish_agent_run(
    conn: sqlite3.Connection,
    run_id: int,
    status: str,
    items_processed: int = 0,
    summary: str = "",
    meta: dict[str, Any] | None = None,
) -> None:
    now = utc_now_iso()
    conn.execute(
        """
        UPDATE agent_runs
        SET status = ?, items_processed = ?, summary = ?, finished_at = ?, meta_json = ?
        WHERE id = ?
        """,
        (status, items_processed, summary, now, json.dumps(meta or {}), run_id),
    )


def set_watermark(conn: sqlite3.Connection, key: str, timestamp_iso: str | None = None, cursor_value: str = "") -> None:
    ts = timestamp_iso or utc_now_iso()
    conn.execute(
        """
        INSERT INTO watermarks(key, timestamp_iso, cursor_value, meta_json)
        VALUES (?, ?, ?, '{}')
        ON CONFLICT(key) DO UPDATE SET
            timestamp_iso=excluded.timestamp_iso,
            cursor_value=CASE WHEN excluded.cursor_value != '' THEN excluded.cursor_value ELSE watermarks.cursor_value END
        """,
        (key, ts, cursor_value),
    )


def get_settings_dict(conn: sqlite3.Connection) -> dict[str, Any]:
    rows = conn.execute("SELECT key, value_json FROM settings").fetchall()
    out: dict[str, Any] = dict(DEFAULT_SETTINGS)
    for r in rows:
        try:
            out[r["key"]] = json.loads(r["value_json"])
        except Exception:
            out[r["key"]] = r["value_json"]
    return out
