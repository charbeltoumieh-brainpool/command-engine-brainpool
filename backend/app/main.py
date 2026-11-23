from __future__ import annotations

from contextlib import asynccontextmanager
from datetime import datetime, timezone
import base64
import json
import os
import uuid
from typing import Any

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from fastapi import FastAPI, Header, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
import httpx
from pydantic import BaseModel, Field

from . import config, memory
from .config import (
    BACKEND_PORT,
    CORE_REPOS,
    MODEL_EMBEDDING,
    MODEL_ORCHESTRATOR,
    MODEL_WORKER,
    STAFF_ROSTER,
    load_gateway_credentials,
)
from .db import (
    create_wal_backup,
    db_session,
    dismiss_task_durable,
    get_auth_alerts,
    get_settings_dict,
    init_db,
    list_wal_backups,
    record_llm_usage,
    restore_dismissed_task,
    restore_wal_backup,
    row_to_dict,
    set_watermark,
    upsert_meeting,
    upsert_task,
    utc_now_iso,
)
from .executor import (
    cancel_queued_approval_undo,
    execute_approved_action,
    recover_pending_undo_approvals,
    rewrite_approval_draft,
    schedule_approval_execution,
    stage_or_execute_action,
)
from .memory import (
    check_gateway_connectivity,
    hybrid_search,
    index_missing_embeddings,
)
from .missions import (
    STREAM_HUB,
    build_orbit_state,
    control_mission,
    dispatch_durable_mission,
    get_mission_detail,
    is_system_paused,
    list_missions,
    record_mission_event,
    seed_specialists_for_profile,
    set_system_paused,
)
from .orchestrator import (
    ask_chief_of_staff,
    ask_chief_of_staff_stream,
    generate_executive_briefing,
    ingest_batch_payload,
    process_meeting_transcript_intelligence,
    run_full_sweep,
)
from .profiles import (
    OWNER_PROFILE_ID,
    activate_user_profile,
    create_user_profile,
    get_active_profile,
    get_active_profile_id,
    list_profiles,
    update_user_profile,
)
from .safety import SafetyViolationError, redact_structure
from .cognitive_router import router as cognitive_router
from .integrations_router import ai_router, router as integrations_router

scheduler = AsyncIOScheduler()

ALLOWED_LOOPBACK_ORIGINS = list(
    dict.fromkeys(
        [
            "http://127.0.0.1:5179",
            "http://localhost:5179",
            "http://127.0.0.1:5173",
            "http://localhost:5173",
            "http://127.0.0.1:8085",
            "http://localhost:8085",
            f"http://127.0.0.1:{BACKEND_PORT}",
            f"http://localhost:{BACKEND_PORT}",
        ]
    )
)
ALLOWED_LOOPBACK_HOSTS = {
    f"127.0.0.1:{BACKEND_PORT}",
    f"localhost:{BACKEND_PORT}",
    "127.0.0.1:8085",
    "localhost:8085",
    "127.0.0.1",
    "localhost",
    "testserver",
}


async def _scheduled_delta_sync() -> None:
    with db_session() as conn:
        cfg = get_settings_dict(conn)
        if is_system_paused(conn):
            return
    if not cfg.get("schedules_enabled", True):
        return
    await run_full_sweep(trigger_source="scheduler_delta")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    STREAM_HUB.reset()
    init_db()
    recover_pending_undo_approvals()
    scheduler.add_job(
        _scheduled_delta_sync,
        "interval",
        minutes=30,
        id="delta_sync_30m",
        replace_existing=True,
    )
    scheduler.start()
    try:
        yield
    finally:
        STREAM_HUB.shutdown()
        scheduler.shutdown(wait=False)


app = FastAPI(
    title="Command Engine — Personal Intelligence OS API",
    version="2.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_LOOPBACK_ORIGINS,
    allow_credentials=False,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization", "X-Command-Engine-Token", "Last-Event-ID"],
)

# Cognitive OS (Memory & Studio workspaces) and Integrations/AI provider routers.
app.include_router(cognitive_router)
app.include_router(integrations_router)
app.include_router(ai_router)


@app.middleware("http")
async def loopback_security_middleware(request: Request, call_next: Any) -> Any:
    """Protect localhost API against DNS-rebinding and malicious cross-origin browser requests."""
    host = (request.headers.get("host") or "").lower().strip()
    if (
        host
        and host not in ALLOWED_LOOPBACK_HOSTS
        and not host.startswith("127.0.0.1:")
        and not host.startswith("localhost:")
    ):
        return JSONResponse(status_code=403, content={"detail": f"Blocked untrusted Host header '{host}'."})

    origin = (request.headers.get("origin") or "").strip()
    if (
        origin
        and origin not in ALLOWED_LOOPBACK_ORIGINS
        and not origin.startswith("http://127.0.0.1:")
        and not origin.startswith("http://localhost:")
    ):
        return JSONResponse(status_code=403, content={"detail": f"Blocked untrusted Origin '{origin}'."})

    expected_token = os.environ.get("COMMAND_ENGINE_API_TOKEN", "").strip()
    if expected_token and request.method != "OPTIONS" and request.url.path != "/api/health":
        supplied = (
            request.headers.get("x-command-engine-token")
            or request.query_params.get("token")
            or ""
        ).strip()
        if supplied != expected_token:
            return JSONResponse(status_code=401, content={"detail": "Missing or invalid desktop session token."})

    try:
        return await call_next(request)
    except SafetyViolationError as exc:
        return JSONResponse(status_code=403, content={"detail": str(exc)})


# ---------------------------------------------------------------------------
# Request Models
# ---------------------------------------------------------------------------


class IngestBatchRequest(BaseModel):
    events: list[dict[str, Any]] = Field(default_factory=list)
    tasks: list[dict[str, Any]] = Field(default_factory=list)
    meetings: list[dict[str, Any]] = Field(default_factory=list)
    approvals: list[dict[str, Any]] = Field(default_factory=list)
    synced_sources: list[str] = Field(default_factory=list)


class TaskCreateRequest(BaseModel):
    title: str
    description: str = ""
    bucket: str = "needed_from_me"
    priority: str = "P1"
    source: str = "manual"
    source_ref: str = ""
    source_url: str = ""
    repo: str = ""
    counterparty: str = ""
    due_at: str | None = None
    task_kind: str | None = None
    ownership_reason: str | None = None
    dedup_key: str | None = None


class TaskPatchRequest(BaseModel):
    status: str | None = None
    priority: str | None = None
    bucket: str | None = None
    title: str | None = None
    description: str | None = None
    task_kind: str | None = None
    snoozed_until: str | None = None


class ApprovalDecisionRequest(BaseModel):
    decision: str  # 'approve' | 'reject'
    edited_payload: dict[str, Any] | None = None
    undo_window_sec: float = 0.0


class ApprovalRewriteRequest(BaseModel):
    style: str = "concise"  # concise | direct | warm | executive | technical | custom
    custom_instruction: str = ""


class StageActionRequest(BaseModel):
    action_type: str
    title: str
    summary: str = ""
    repo: str = ""
    worktree_path: str = ""
    branch: str = ""
    diff_preview: str = ""
    test_output: str = ""
    ownership_reason: str = "authored_by_me"
    payload: dict[str, Any] = Field(default_factory=dict)


class AutonomyPolicyUpdate(BaseModel):
    mode: str  # 'auto' | 'ask_first'


class AskRequest(BaseModel):
    question: str


class BriefingRequest(BaseModel):
    kind: str = "whats_new"
    deliver_self_dm: bool = False
    since_last_check_only: bool = False


class SweepRequest(BaseModel):
    sources: list[str] | None = None


class MeetingIngestRequest(BaseModel):
    external_id: str
    title: str
    start_at: str = ""
    end_at: str = ""
    attendees: list[str] = Field(default_factory=list)
    meet_url: str = ""
    transcript_url: str = ""
    raw_transcript: str = ""
    auto_process: bool = True


class MeetingLiveCaptureRequest(BaseModel):
    title: str = ""
    meeting_id: int | None = None
    attendees: list[str] = Field(default_factory=list)
    live_notes: str = ""
    transcript_text: str = ""
    audio_base64: str = ""
    audio_mime: str = "audio/webm"
    duration_sec: int = 0
    auto_process: bool = True


class MissionDispatchRequest(BaseModel):
    instruction: str
    title: str = ""
    task_id: int | None = None
    domain: str | None = None
    priority: str = "P1"
    dry_run: bool = False
    stage_outbound_if_needed: bool = False
    idempotency_key: str | None = None


class ProfileCreateRequest(BaseModel):
    display_name: str
    role_title: str = ""
    org_name: str = ""
    brand_display_name: str = "Command Engine"
    timezone: str = "UTC"
    email: str = ""
    github_login: str = ""
    github_org: str = ""
    slack_user_id: str = ""
    autonomy_posture: str = "prepare"
    proactivity_level: str = "balanced"
    preferred_ide: str = "vscode"
    onboarding_completed: bool = True
    is_demo: bool = False
    activate: bool = True


class SystemPauseRequest(BaseModel):
    paused: bool


class BackupCreateRequest(BaseModel):
    label: str = "manual"


class BackupRestoreRequest(BaseModel):
    filename: str


# ---------------------------------------------------------------------------
# Health, Orbit & Real-Time SSE Stream
# ---------------------------------------------------------------------------


@app.get("/api/health")
async def health() -> dict[str, Any]:
    gw = await check_gateway_connectivity()
    with db_session() as conn:
        prof = get_active_profile(conn)
        paused = is_system_paused(conn)
    pid = str(prof.get("id") or OWNER_PROFILE_ID)
    return {
        "ok": True,
        "service": "command-engine",
        "port": BACKEND_PORT,
        "connectivity": gw["status"],  # 'online' | 'degraded' | 'offline'
        "connectivity_detail": gw["detail"],
        "system_paused": paused,
        "brand_display_name": prof.get("brand_display_name") or "Command Engine",
        "active_profile_id": pid,
        "is_demo": bool(prof.get("is_demo", False)),
        "principal": {
            "display_name": prof.get("display_name") or "",
            "github": prof.get("github_login") or "",
            "email": prof.get("email") or "",
            "slack_self_id": prof.get("slack_user_id") or "",
            "github_project_view_url": prof.get("github_project_view_url") or "",
        },
        "models": {
            "orchestrator": str(prof.get("model_orchestrator") or MODEL_ORCHESTRATOR),
            "worker": str(prof.get("model_worker") or MODEL_WORKER),
            "fast": str(prof.get("model_fast") or MODEL_WORKER),
            "embedding": str(prof.get("model_embedding") or MODEL_EMBEDDING),
        },
    }


@app.get("/api/orbit")
async def get_orbit_endpoint() -> dict[str, Any]:
    gw = await check_gateway_connectivity()
    with db_session() as conn:
        return build_orbit_state(conn, health_status=str(gw["status"]))


@app.get("/api/stream")
async def sse_stream_endpoint(
    request: Request,
    last_event_id: str | None = Header(default=None, alias="Last-Event-ID"),
    cursor: int = Query(default=0, ge=0),
) -> StreamingResponse:
    parsed_cursor = cursor
    if last_event_id and last_event_id.isdigit():
        parsed_cursor = max(parsed_cursor, int(last_event_id))
    with db_session() as conn:
        pid = get_active_profile_id(conn)
    return StreamingResponse(
        STREAM_HUB.subscribe(pid, last_event_id=parsed_cursor, is_disconnected=request.is_disconnected),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


# ---------------------------------------------------------------------------
# Multi-User Profiles & Personalization
# ---------------------------------------------------------------------------


def _maybe_clear_gateway_cache() -> None:
    fn = getattr(memory, "invalidate_gateway_cache", None)
    if callable(fn):
        fn()


@app.get("/api/profiles")
def get_profiles_endpoint() -> dict[str, Any]:
    with db_session() as conn:
        return {
            "active": get_active_profile(conn),
            "items": list_profiles(conn),
        }


@app.post("/api/profiles")
def create_profile_endpoint(req: ProfileCreateRequest) -> dict[str, Any]:
    with db_session() as conn:
        created = create_user_profile(conn, req.model_dump())
        _maybe_clear_gateway_cache()
        return {"profile": created, "active": get_active_profile(conn)}


@app.patch("/api/profiles/{profile_id}")
def patch_profile_endpoint(profile_id: str, patch: dict[str, Any]) -> dict[str, Any]:
    with db_session() as conn:
        try:
            updated = update_user_profile(conn, profile_id, patch)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        _maybe_clear_gateway_cache()
        return {"profile": updated}


@app.post("/api/profiles/{profile_id}/activate")
def activate_profile_endpoint(profile_id: str) -> dict[str, Any]:
    with db_session() as conn:
        try:
            active = activate_user_profile(conn, profile_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        _maybe_clear_gateway_cache()
        return {"active": active, "items": list_profiles(conn)}


# ---------------------------------------------------------------------------
# Durable Missions, Specialists & Global Pause
# ---------------------------------------------------------------------------


@app.get("/api/specialists")
def list_specialists_endpoint() -> dict[str, Any]:
    with db_session() as conn:
        pid = get_active_profile_id(conn)
        seed_specialists_for_profile(conn, pid)
        specialists = [
            row_to_dict(r)
            for r in conn.execute(
                "SELECT * FROM agent_specialists WHERE profile_id = ? ORDER BY department ASC",
                (pid,),
            ).fetchall()
        ]
    return {"items": specialists, "specialists": specialists}


@app.get("/api/missions")
def list_missions_endpoint(status: str | None = None, limit: int = Query(default=40, le=100)) -> dict[str, Any]:
    with db_session() as conn:
        pid = get_active_profile_id(conn)
        seed_specialists_for_profile(conn, pid)
        specialists = [
            row_to_dict(r)
            for r in conn.execute(
                "SELECT * FROM agent_specialists WHERE profile_id = ? ORDER BY department ASC",
                (pid,),
            ).fetchall()
        ]
        recent_events = [
            row_to_dict(r)
            for r in conn.execute(
                "SELECT * FROM mission_events WHERE profile_id = ? ORDER BY id DESC LIMIT 40",
                (pid,),
            ).fetchall()
        ]
        return {
            "system_paused": is_system_paused(conn),
            "items": list_missions(conn, status=status, limit=limit),
            "specialists": specialists,
            "recent_events": recent_events,
        }


@app.post("/api/missions")
async def create_mission_endpoint(req: MissionDispatchRequest) -> dict[str, Any]:
    try:
        mission = await dispatch_durable_mission(
            instruction=req.instruction,
            title=req.title,
            task_id=req.task_id,
            domain_override=req.domain,
            priority=req.priority,
            dry_run=req.dry_run,
            stage_outbound_if_needed=req.stage_outbound_if_needed,
            idempotency_key=req.idempotency_key,
        )
        return {"mission": mission}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@app.get("/api/missions/{mission_id}")
def get_mission_endpoint(mission_id: str) -> dict[str, Any]:
    with db_session() as conn:
        detail = get_mission_detail(conn, mission_id)
    if not detail:
        raise HTTPException(status_code=404, detail=f"Mission '{mission_id}' not found.")
    return {"mission": detail}


@app.post("/api/missions/{mission_id}/{action}")
def control_mission_endpoint(mission_id: str, action: str) -> dict[str, Any]:
    with db_session() as conn:
        try:
            detail = control_mission(conn, mission_id, action)
            return {"mission": detail}
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/system/pause")
def system_pause_endpoint(req: SystemPauseRequest) -> dict[str, Any]:
    with db_session() as conn:
        return set_system_paused(conn, req.paused)


# ---------------------------------------------------------------------------
# Dashboard, Events, Tasks, Approvals, Autonomy & Meetings
# ---------------------------------------------------------------------------


@app.get("/api/dashboard")
def get_dashboard_summary() -> dict[str, Any]:
    with db_session() as conn:
        prof = get_active_profile(conn)
        pid = str(prof.get("id") or OWNER_PROFILE_ID)
        repos = prof.get("core_repos") or dict(CORE_REPOS)
        wm = conn.execute("SELECT timestamp_iso FROM watermarks WHERE key = 'user_last_checked'").fetchone()
        last_checked = str(wm["timestamp_iso"]) if wm else "1970-01-01T00:00:00+00:00"

        unread_events = conn.execute(
            "SELECT COUNT(*) AS c FROM events WHERE profile_id = ? AND ingested_at > ? AND seen_at IS NULL",
            (pid, last_checked),
        ).fetchone()["c"]
        total_events = conn.execute("SELECT COUNT(*) AS c FROM events WHERE profile_id = ?", (pid,)).fetchone()["c"]
        by_source = {
            r["source"]: r["c"]
            for r in conn.execute(
                "SELECT source, COUNT(*) AS c FROM events WHERE profile_id = ? GROUP BY source",
                (pid,),
            ).fetchall()
        }
        needed_open = conn.execute(
            "SELECT COUNT(*) AS c FROM tasks WHERE profile_id = ? AND bucket = 'needed_from_me' AND status NOT IN ('done', 'dismissed')",
            (pid,),
        ).fetchone()["c"]
        p0_needed = conn.execute(
            "SELECT COUNT(*) AS c FROM tasks WHERE profile_id = ? AND bucket = 'needed_from_me' AND priority = 'P0' AND status NOT IN ('done', 'dismissed')",
            (pid,),
        ).fetchone()["c"]
        waiting_open = conn.execute(
            "SELECT COUNT(*) AS c FROM tasks WHERE profile_id = ? AND bucket = 'waiting_on_others' AND status NOT IN ('done', 'dismissed')",
            (pid,),
        ).fetchone()["c"]
        pending_approvals = conn.execute(
            "SELECT COUNT(*) AS c FROM approvals WHERE profile_id = ? AND status IN ('pending', 'queued_undo')",
            (pid,),
        ).fetchone()["c"]
        embeddings_count = conn.execute(
            "SELECT COUNT(*) AS c FROM embeddings WHERE profile_id = ?",
            (pid,),
        ).fetchone()["c"]
        dirty_local = conn.execute(
            "SELECT COUNT(*) AS c FROM events WHERE profile_id = ? AND source = 'local' AND event_type = 'local_wip'",
            (pid,),
        ).fetchone()["c"]

        latest_briefing = row_to_dict(
            conn.execute("SELECT * FROM briefings WHERE profile_id = ? ORDER BY created_at DESC LIMIT 1", (pid,)).fetchone()
        )
        watermarks = {
            r["key"]: r["timestamp_iso"]
            for r in conn.execute("SELECT key, timestamp_iso FROM watermarks").fetchall()
        }
        recent_runs = [
            row_to_dict(r)
            for r in conn.execute(
                "SELECT * FROM agent_runs WHERE profile_id = ? ORDER BY started_at DESC LIMIT 12",
                (pid,),
            ).fetchall()
        ]
        auth_alerts = get_auth_alerts(conn)
        connected_tools = conn.execute(
            "SELECT COUNT(*) AS c FROM integrations WHERE enabled = 1 AND auth_status IN ('connected', 'available')"
        ).fetchone()["c"]
        scheduled_meetings = [
            row_to_dict(r)
            for r in conn.execute(
                """
                SELECT id, external_id, title, start_at, end_at, attendees_json, meet_url, transcript_status
                FROM meetings
                WHERE profile_id = ?
                ORDER BY start_at DESC
                LIMIT 8
                """,
                (pid,),
            ).fetchall()
        ]

    return {
        "kpis": {
            "unread_deltas": unread_events,
            "total_events": total_events,
            "needed_from_me": needed_open,
            "p0_urgent": p0_needed,
            "waiting_on_others": waiting_open,
            "pending_approvals": pending_approvals,
            "dirty_local_repos": dirty_local,
            "indexed_vectors": embeddings_count,
            "connected_tools": connected_tools,
        },
        "events_by_source": by_source,
        "last_checked_at": last_checked,
        "watermarks": watermarks,
        "latest_briefing": latest_briefing,
        "recent_agent_runs": recent_runs,
        "auth_alerts": auth_alerts,
        "upcoming_calls": scheduled_meetings,
        "core_repos": repos,
    }


@app.get("/api/events")
def list_events(
    source: str | None = None,
    window: str = Query(default="all"),  # since_last_check | 24h | 7d | all
    requires_action_only: bool = False,
    limit: int = Query(default=100, le=300),
) -> dict[str, Any]:
    with db_session() as conn:
        pid = get_active_profile_id(conn)
        wm = conn.execute("SELECT timestamp_iso FROM watermarks WHERE key = 'user_last_checked'").fetchone()
        last_checked = str(wm["timestamp_iso"]) if wm else "1970-01-01T00:00:00+00:00"

        clauses = ["profile_id = ?"]
        params: list[Any] = [pid]
        if source and source != "all":
            clauses.append("source = ?")
            params.append(source)
        if requires_action_only:
            clauses.append("requires_action = 1")
        if window == "since_last_check":
            clauses.append("(ingested_at > ? OR seen_at IS NULL)")
            params.append(last_checked)
        elif window == "24h":
            clauses.append("occurred_at >= datetime('now', '-1 day')")
        elif window == "7d":
            clauses.append("occurred_at >= datetime('now', '-7 days')")

        sql = f"SELECT * FROM events WHERE {' AND '.join(clauses)} ORDER BY occurred_at DESC LIMIT ?"
        params.append(limit)
        items = [row_to_dict(r) for r in conn.execute(sql, params).fetchall()]
    return {"items": items, "last_checked_at": last_checked}


@app.post("/api/events/mark-checked")
def mark_all_events_checked() -> dict[str, Any]:
    now = utc_now_iso()
    with db_session() as conn:
        pid = get_active_profile_id(conn)
        conn.execute("UPDATE events SET seen_at = ? WHERE profile_id = ? AND seen_at IS NULL", (now, pid))
        set_watermark(conn, "user_last_checked", now)
    return {"ok": True, "user_last_checked": now}


@app.get("/api/tasks")
def list_tasks(bucket: str | None = None, include_done: bool = False) -> dict[str, Any]:
    with db_session() as conn:
        pid = get_active_profile_id(conn)
        clauses = ["profile_id = ?"]
        params: list[Any] = [pid]
        if bucket:
            clauses.append("bucket = ?")
            params.append(bucket)
        if not include_done:
            clauses.append("status NOT IN ('done', 'dismissed')")
        sql = f"SELECT * FROM tasks WHERE {' AND '.join(clauses)} ORDER BY priority ASC, updated_at DESC"
        items = [row_to_dict(r) for r in conn.execute(sql, params).fetchall()]
    return {"items": items}


@app.post("/api/tasks")
async def create_task_endpoint(req: TaskCreateRequest) -> dict[str, Any]:
    payload = {k: v for k, v in req.model_dump().items() if v is not None}
    with db_session() as conn:
        tid = upsert_task(conn, payload)
        row = row_to_dict(conn.execute("SELECT * FROM tasks WHERE id = ?", (tid,)).fetchone())
    try:
        await index_missing_embeddings(limit=10)
    except Exception:
        pass
    return {"task": row}


@app.patch("/api/tasks/{task_id}")
def patch_task_endpoint(task_id: int, req: TaskPatchRequest) -> dict[str, Any]:
    updates = {k: v for k, v in req.model_dump().items() if v is not None}
    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update.")
    updates["updated_at"] = utc_now_iso()
    cols = ", ".join(f"{k} = ?" for k in updates.keys())
    vals = list(updates.values()) + [task_id]
    with db_session() as conn:
        conn.execute(f"UPDATE tasks SET {cols} WHERE id = ?", vals)
        row = row_to_dict(conn.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone())
    if not row:
        raise HTTPException(status_code=404, detail="Task not found.")
    return {"task": row}


@app.post("/api/tasks/{task_id}/dismiss")
def dismiss_task_endpoint(task_id: int) -> dict[str, Any]:
    """Durable 'Not Mine' action — suppresses future sweeps from recreating the same signature."""
    with db_session() as conn:
        row = dismiss_task_durable(conn, task_id, reason="not_mine")
    if not row:
        raise HTTPException(status_code=404, detail="Task not found.")
    return {"task": row}


@app.post("/api/tasks/{task_id}/restore")
def restore_task_endpoint(task_id: int) -> dict[str, Any]:
    with db_session() as conn:
        row = restore_dismissed_task(conn, task_id)
    if not row:
        raise HTTPException(status_code=404, detail="Task not found.")
    return {"task": row}


@app.get("/api/approvals")
def list_approvals(status: str | None = None) -> dict[str, Any]:
    with db_session() as conn:
        pid = get_active_profile_id(conn)
        if status == "pending":
            rows = conn.execute(
                "SELECT * FROM approvals WHERE profile_id = ? AND status IN ('pending', 'queued_undo') ORDER BY created_at DESC LIMIT 100",
                (pid,),
            ).fetchall()
        elif status and status != "all":
            rows = conn.execute(
                "SELECT * FROM approvals WHERE profile_id = ? AND status = ? ORDER BY created_at DESC LIMIT 100",
                (pid, status),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM approvals WHERE profile_id = ? ORDER BY created_at DESC LIMIT 100",
                (pid,),
            ).fetchall()
        items = [row_to_dict(r) for r in rows]
    return {"items": items}


@app.post("/api/approvals/stage")
def stage_approval_endpoint(req: StageActionRequest) -> dict[str, Any]:
    return stage_or_execute_action(
        req.action_type,
        req.title,
        req.payload,
        summary=req.summary,
        repo=req.repo,
        worktree_path=req.worktree_path,
        branch=req.branch,
        diff_preview=req.diff_preview,
        test_output=req.test_output,
        ownership_reason=req.ownership_reason,
    )


@app.post("/api/approvals/{approval_id}/decide")
def decide_approval_endpoint(approval_id: int, req: ApprovalDecisionRequest) -> dict[str, Any]:
    if req.decision == "reject":
        cancel_queued_approval_undo(approval_id)
        now = utc_now_iso()
        with db_session() as conn:
            pid = get_active_profile_id(conn)
            conn.execute(
                "UPDATE approvals SET status = 'rejected', decided_at = ? WHERE id = ?",
                (now, approval_id),
            )
            record_mission_event(
                conn,
                profile_id=pid,
                event_type="approval.rejected",
                domain="approvals",
                severity="info",
                summary=f"Rejected Approval #{approval_id}.",
                payload={"approval_id": approval_id},
            )
        return {"status": "rejected", "approval_id": approval_id}
    if req.decision == "approve":
        try:
            if req.undo_window_sec and req.undo_window_sec > 0:
                return schedule_approval_execution(
                    approval_id,
                    edited_payload=req.edited_payload,
                    delay_seconds=req.undo_window_sec,
                )
            return execute_approved_action(approval_id, edited_payload=req.edited_payload)
        except ValueError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
    raise HTTPException(status_code=400, detail="decision must be 'approve' or 'reject'.")


@app.post("/api/approvals/{approval_id}/undo")
def undo_approval_endpoint(approval_id: int) -> dict[str, Any]:
    try:
        return cancel_queued_approval_undo(approval_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.post("/api/approvals/{approval_id}/rewrite")
async def rewrite_approval_endpoint(approval_id: int, req: ApprovalRewriteRequest) -> dict[str, Any]:
    try:
        return await rewrite_approval_draft(
            approval_id,
            style=req.style,
            custom_instruction=req.custom_instruction,
        )
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.get("/api/approvals/{approval_id}/context")
def get_approval_context_endpoint(approval_id: int) -> dict[str, Any]:
    """Return related source thread events and tasks for the active profile so Approvals shows full context."""
    with db_session() as conn:
        pid = get_active_profile_id(conn)
        row = conn.execute(
            "SELECT * FROM approvals WHERE id = ? AND profile_id = ?",
            (approval_id, pid),
        ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail=f"Approval #{approval_id} not found.")
        item = row_to_dict(row) or {}
        payload = item.get("payload") or {}
        repo = str(item.get("repo") or payload.get("repo") or "").strip()
        channel_ref = str(
            payload.get("channel_id")
            or payload.get("channel")
            or payload.get("to")
            or repo
            or ""
        ).strip()
        pr_number = payload.get("pr_number")

        related_events: list[dict[str, Any]] = []
        if pr_number and repo:
            ev_rows = conn.execute(
                """
                SELECT id, source, event_type, title, summary, body, actor, url, channel_or_repo, occurred_at
                FROM events
                WHERE profile_id = ?
                  AND (channel_or_repo = ? OR title LIKE ? OR source_id LIKE ?)
                ORDER BY occurred_at DESC
                LIMIT 5
                """,
                (pid, repo, f"%#{pr_number}%", f"%{pr_number}%"),
            ).fetchall()
            related_events = [row_to_dict(r) or {} for r in ev_rows]
        elif channel_ref:
            ev_rows = conn.execute(
                """
                SELECT id, source, event_type, title, summary, body, actor, url, channel_or_repo, occurred_at
                FROM events
                WHERE profile_id = ?
                  AND (channel_or_repo = ? OR actor LIKE ? OR title LIKE ?)
                ORDER BY occurred_at DESC
                LIMIT 5
                """,
                (pid, channel_ref, f"%{channel_ref}%", f"%{channel_ref[:32]}%"),
            ).fetchall()
            related_events = [row_to_dict(r) or {} for r in ev_rows]

        related_tasks = [
            row_to_dict(r) or {}
            for r in conn.execute(
                """
                SELECT id, title, description, source, source_url, counterparty, priority, status
                FROM tasks
                WHERE profile_id = ? AND (approval_id = ? OR (? != '' AND repo = ?))
                ORDER BY updated_at DESC
                LIMIT 4
                """,
                (pid, approval_id, repo, repo),
            ).fetchall()
        ]
    return {
        "approval_id": approval_id,
        "related_events": related_events,
        "related_tasks": related_tasks,
    }


@app.get("/api/autonomy")
def list_autonomy_policies() -> dict[str, Any]:
    with db_session() as conn:
        prof = get_active_profile(conn)
        items = [
            row_to_dict(r)
            for r in conn.execute("SELECT * FROM autonomy_policies ORDER BY category, action_type").fetchall()
        ]
    return {
        "autonomy_posture": prof.get("autonomy_posture") or "prepare",
        "proactivity_level": prof.get("proactivity_level") or "balanced",
        "items": items,
    }


@app.patch("/api/autonomy/{action_type}")
def update_autonomy_policy(action_type: str, req: AutonomyPolicyUpdate) -> dict[str, Any]:
    if req.mode not in {"auto", "ask_first"}:
        raise HTTPException(status_code=400, detail="mode must be 'auto' or 'ask_first'.")
    with db_session() as conn:
        row = conn.execute("SELECT * FROM autonomy_policies WHERE action_type = ?", (action_type,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Policy not found.")
        if int(row["locked"]) == 1:
            raise HTTPException(status_code=403, detail=f"Policy '{action_type}' is permanently locked for safety.")
        conn.execute(
            "UPDATE autonomy_policies SET mode = ?, updated_at = ? WHERE action_type = ?",
            (req.mode, utc_now_iso(), action_type),
        )
        updated = row_to_dict(conn.execute("SELECT * FROM autonomy_policies WHERE action_type = ?", (action_type,)).fetchone())
    return {"policy": updated}


@app.get("/api/meetings")
def list_meetings() -> dict[str, Any]:
    with db_session() as conn:
        pid = get_active_profile_id(conn)
        items = [
            row_to_dict(r)
            for r in conn.execute(
                "SELECT * FROM meetings WHERE profile_id = ? ORDER BY start_at DESC LIMIT 50",
                (pid,),
            ).fetchall()
        ]
    return {"items": items}


@app.get("/api/meetings/upcoming-prep")
def get_upcoming_call_prep(within_minutes: int = Query(default=15, ge=1, le=240)) -> dict[str, Any]:
    now = datetime.now(timezone.utc)
    upcoming: list[dict[str, Any]] = []
    with db_session() as conn:
        pid = get_active_profile_id(conn)
        rows = conn.execute(
            "SELECT * FROM meetings WHERE profile_id = ? ORDER BY start_at ASC LIMIT 30",
            (pid,),
        ).fetchall()
    for r in rows:
        item = row_to_dict(r)
        raw_start = str(item.get("start_at") or "").strip()
        if not raw_start:
            continue
        try:
            dt = datetime.fromisoformat(raw_start.replace("Z", "+00:00"))
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            mins = int(round((dt - now).total_seconds() / 60.0))
        except ValueError:
            continue
        if 0 <= mins <= within_minutes:
            try:
                attendees = json.loads(item.get("attendees_json") or "[]")
            except Exception:
                attendees = []
            upcoming.append(
                {
                    "meeting_id": int(item["id"]),
                    "title": str(item.get("title") or "Meeting"),
                    "start_at": raw_start,
                    "minutes_until": mins,
                    "meet_url": str(item.get("meet_url") or ""),
                    "attendees": attendees if isinstance(attendees, list) else [],
                    "has_dossier": bool(item.get("summary")),
                    "one_line_brief": str(item.get("summary") or "")[:180],
                }
            )
    return {"items": upcoming}


@app.get("/api/meetings/{meeting_id}/dossier")
def get_meeting_dossier(meeting_id: int, refresh: bool = False) -> dict[str, Any]:
    with db_session() as conn:
        pid = get_active_profile_id(conn)
        row = conn.execute(
            "SELECT * FROM meetings WHERE id = ? AND profile_id = ?",
            (meeting_id, pid),
        ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Meeting not found.")
        item = row_to_dict(row)
        open_tasks = [
            row_to_dict(t)
            for t in conn.execute(
                "SELECT id, title, bucket, priority, status, counterparty FROM tasks WHERE profile_id = ? AND status != 'done' ORDER BY id DESC LIMIT 8",
                (pid,),
            ).fetchall()
        ]
    try:
        attendees = json.loads(item.get("attendees_json") or "[]")
    except Exception:
        attendees = []
    attendee_briefs = [
        {"name": str(a), "email": str(a) if "@" in str(a) else "", "open_items_count": 0}
        for a in (attendees if isinstance(attendees, list) else [])
    ]
    summary = str(item.get("summary") or "").strip()
    brief_md = summary or f"### {item.get('title') or 'Meeting'}\n\nAdd notes or process a transcript to populate structured meeting context."
    return {
        "meeting_id": int(item["id"]),
        "title": str(item.get("title") or "Meeting"),
        "generated_at": utc_now_iso(),
        "brief_md": brief_md,
        "attendee_briefs": attendee_briefs,
        "open_commitments": open_tasks,
        "related_threads": [],
        "suggested_talking_points": [],
        "cached": not refresh,
    }


@app.post("/api/meetings")
async def ingest_meeting_endpoint(req: MeetingIngestRequest) -> dict[str, Any]:
    with db_session() as conn:
        mid = upsert_meeting(
            conn,
            {
                "external_id": req.external_id,
                "title": req.title,
                "start_at": req.start_at or utc_now_iso(),
                "end_at": req.end_at or utc_now_iso(),
                "attendees": req.attendees,
                "meet_url": req.meet_url,
                "transcript_url": req.transcript_url,
                "raw_transcript": req.raw_transcript,
                "transcript_status": "ingested" if req.raw_transcript else "scheduled",
            },
        )
    proc = None
    if req.auto_process and req.raw_transcript.strip():
        proc = await process_meeting_transcript_intelligence(mid)
    return {"meeting_id": mid, "processed": proc}


async def _transcribe_audio_bytes(audio_bytes: bytes, mime_type: str) -> tuple[str, str]:
    """Attempt zero-bot audio transcription via OpenAI-compatible `/audio/transcriptions` or multimodal chat."""
    with db_session() as conn:
        prof = get_active_profile(conn)
    pid = str(prof.get("id") or OWNER_PROFILE_ID)
    custom_url = str(prof.get("gateway_base_url") or "").strip() or None
    creds = load_gateway_credentials(base_url_override=custom_url)
    if not creds.configured or not creds.base_url or not audio_bytes:
        return "", "notes_only"

    ext = "webm"
    low_mime = (mime_type or "").lower()
    if "wav" in low_mime:
        ext = "wav"
    elif "mp4" in low_mime or "m4a" in low_mime:
        ext = "m4a"
    elif "mpeg" in low_mime or "mp3" in low_mime:
        ext = "mp3"
    elif "ogg" in low_mime:
        ext = "ogg"

    auth_headers: dict[str, str] = {}
    if creds.api_key:
        auth_headers["Authorization"] = f"Bearer {creds.api_key}"

    try:
        async with httpx.AsyncClient(timeout=90.0) as client:
            resp = await client.post(
                f"{creds.base_url}/audio/transcriptions",
                headers=auth_headers,
                data={"model": "whisper-1"},
                files={"file": (f"call-capture.{ext}", audio_bytes, mime_type or "audio/webm")},
            )
            if resp.status_code == 200:
                body = resp.json()
                text = str(body.get("text") or "").strip()
                if text:
                    try:
                        with db_session() as conn:
                            record_llm_usage(
                                conn,
                                profile_id=pid,
                                provider_id="openai-gateway",
                                model="whisper-1",
                                operation="audio_transcription",
                                prompt_tokens=max(1, len(audio_bytes) // 1000),
                                completion_tokens=max(1, len(text) // 4),
                                cost_usd=round(max(0.001, (len(audio_bytes) / (1024 * 1024)) * 0.006), 6),
                            )
                    except Exception:
                        pass
                    return text, "whisper_api"
    except Exception:
        pass

    if len(audio_bytes) <= 12 * 1024 * 1024:
        try:
            b64 = base64.b64encode(audio_bytes).decode("ascii")
            fast_model = str(prof.get("model_fast") or prof.get("model_worker") or MODEL_WORKER)
            chat_headers = {"Content-Type": "application/json", **auth_headers}
            async with httpx.AsyncClient(timeout=90.0) as client:
                resp = await client.post(
                    f"{creds.base_url}/chat/completions",
                    headers=chat_headers,
                    json={
                        "model": fast_model,
                        "temperature": 0.1,
                        "messages": [
                            {
                                "role": "system",
                                "content": "Transcribe this call audio verbatim with speaker turns where discernible. Return plain transcript text only.",
                            },
                            {
                                "role": "user",
                                "content": [
                                    {"type": "text", "text": "Transcribe this recorded call audio accurately."},
                                    {"type": "input_audio", "input_audio": {"data": b64, "format": ext if ext in {"wav", "mp3"} else "wav"}},
                                ],
                            },
                        ],
                    },
                )
                if resp.status_code == 200:
                    data = resp.json()
                    text = str(data["choices"][0]["message"].get("content") or "").strip()
                    if text:
                        return text, "multimodal_llm"
        except Exception:
            pass

    return "", "local_saved_notes_fallback"


@app.post("/api/meetings/live-capture")
async def live_capture_meeting_endpoint(req: MeetingLiveCaptureRequest) -> dict[str, Any]:
    """
    Zero-Bot Live Call Copilot:
    Saves optional local microphone recording, transcribes audio if supported, fuses with live scratchpad notes,
    and extracts Summary + My Commitments (`needed_from_me`) + Waiting On Others (`waiting_on_others`).
    """
    now = utc_now_iso()
    audio_bytes = b""
    saved_audio_path = ""
    if req.audio_base64.strip():
        raw_b64 = req.audio_base64.strip()
        if "," in raw_b64 and raw_b64.startswith("data:"):
            raw_b64 = raw_b64.split(",", 1)[1]
        try:
            audio_bytes = base64.b64decode(raw_b64, validate=False)
        except Exception as exc:
            raise HTTPException(status_code=400, detail=f"Invalid base64 audio payload: {exc}") from exc

        if len(audio_bytes) > 35 * 1024 * 1024:
            raise HTTPException(status_code=413, detail="Audio capture exceeds 35MB single-upload limit.")

    with db_session() as conn:
        pid = get_active_profile_id(conn)

    if audio_bytes:
        rec_dir = (
            config.DATA_DIR / "call_captures"
            if pid == OWNER_PROFILE_ID
            else config.DATA_DIR / "workspaces" / pid / "call_captures"
        )
        rec_dir.mkdir(parents=True, exist_ok=True)
        ext = "webm" if "webm" in (req.audio_mime or "").lower() else "wav"
        fname = f"call-{uuid.uuid4().hex[:10]}.{ext}"
        fpath = rec_dir / fname
        fpath.write_bytes(audio_bytes)
        saved_audio_path = str(fpath)

    transcribed_audio, transcription_mode = await _transcribe_audio_bytes(audio_bytes, req.audio_mime)

    sections: list[str] = []
    if req.live_notes.strip():
        sections.append(f"## Live Call Scratchpad Notes\n{req.live_notes.strip()}")
    if req.transcript_text.strip():
        sections.append(f"## Live Speech Transcript\n{req.transcript_text.strip()}")
    if transcribed_audio.strip():
        sections.append(f"## Audio Model Transcript\n{transcribed_audio.strip()}")

    combined_transcript = "\n\n".join(sections).strip()
    if not combined_transcript and audio_bytes:
        combined_transcript = (
            f"[Zero-Bot Audio Capture saved locally ({len(audio_bytes) // 1024} KB, {req.duration_sec}s). "
            "Add scratchpad notes or connect an audio-capable model gateway to transcribe verbatim.]"
        )

    if not combined_transcript:
        raise HTTPException(
            status_code=400,
            detail="Provide live scratchpad notes, speech transcript, or recorded audio to capture a meeting.",
        )

    clean_title = req.title.strip() or f"Live Call Capture — {now[:16].replace('T', ' ')} UTC"

    with db_session() as conn:
        pid = get_active_profile_id(conn)
        if req.meeting_id:
            existing = conn.execute(
                "SELECT * FROM meetings WHERE id = ? AND profile_id = ?",
                (req.meeting_id, pid),
            ).fetchone()
            if not existing:
                raise HTTPException(status_code=404, detail=f"Meeting #{req.meeting_id} not found.")
            prev_raw = str(existing["raw_transcript"] or "").strip()
            merged_raw = f"{prev_raw}\n\n{combined_transcript}".strip() if prev_raw else combined_transcript
            conn.execute(
                """
                UPDATE meetings
                SET title = COALESCE(NULLIF(?, ''), title),
                    raw_transcript = ?,
                    transcript_url = CASE WHEN ? != '' THEN ? ELSE transcript_url END,
                    transcript_status = 'ingested',
                    updated_at = ?
                WHERE id = ? AND profile_id = ?
                """,
                (req.title.strip(), merged_raw, saved_audio_path, saved_audio_path, now, req.meeting_id, pid),
            )
            mid = int(req.meeting_id)
        else:
            mid = upsert_meeting(
                conn,
                {
                    "profile_id": pid,
                    "external_id": f"live-capture-{uuid.uuid4().hex[:12]}",
                    "title": clean_title,
                    "start_at": now,
                    "end_at": now,
                    "attendees": req.attendees,
                    "transcript_url": saved_audio_path,
                    "raw_transcript": combined_transcript,
                    "transcript_status": "ingested",
                },
            )
        record_mission_event(
            conn,
            profile_id=pid,
            event_type="meeting.live_captured",
            domain="meetings",
            severity="info",
            summary=f"Captured Call Notes: {clean_title}",
            payload={"meeting_id": mid, "transcription_mode": transcription_mode},
        )

    proc = None
    if req.auto_process:
        proc = await process_meeting_transcript_intelligence(mid)

    with db_session() as conn:
        updated_meeting = row_to_dict(conn.execute("SELECT * FROM meetings WHERE id = ?", (mid,)).fetchone())

    return {
        "ok": True,
        "meeting_id": mid,
        "transcription_mode": transcription_mode,
        "transcribed_text": transcribed_audio,
        "saved_audio_path": saved_audio_path,
        "processed": proc,
        "meeting": updated_meeting,
    }


@app.post("/api/meetings/{meeting_id}/process")
async def process_meeting_endpoint(meeting_id: int) -> dict[str, Any]:
    return await process_meeting_transcript_intelligence(meeting_id)


@app.get("/api/staff")
def get_staff_org_and_runs() -> dict[str, Any]:
    with db_session() as conn:
        prof = get_active_profile(conn)
        pid = str(prof.get("id") or OWNER_PROFILE_ID)
        orch = str(prof.get("model_orchestrator") or MODEL_ORCHESTRATOR)
        wrk = str(prof.get("model_worker") or MODEL_WORKER)
        runs = [
            row_to_dict(r)
            for r in conn.execute(
                "SELECT * FROM agent_runs WHERE profile_id = ? ORDER BY started_at DESC LIMIT 40",
                (pid,),
            ).fetchall()
        ]
    roster = []
    for member in STAFF_ROSTER:
        item = dict(member)
        item["model"] = orch if item.get("id") == "chief-of-staff" else wrk
        roster.append(item)
    return {"roster": roster, "runs": runs}


@app.get("/api/briefings")
def list_briefings() -> dict[str, Any]:
    with db_session() as conn:
        pid = get_active_profile_id(conn)
        items = [
            row_to_dict(r)
            for r in conn.execute(
                "SELECT * FROM briefings WHERE profile_id = ? ORDER BY created_at DESC LIMIT 25",
                (pid,),
            ).fetchall()
        ]
    return {"items": items}


@app.post("/api/briefings/generate")
async def generate_briefing_endpoint(req: BriefingRequest) -> dict[str, Any]:
    return await generate_executive_briefing(
        kind=req.kind,
        deliver_self_dm=req.deliver_self_dm,
        since_last_check_only=req.since_last_check_only,
    )


@app.post("/api/ask")
async def ask_endpoint(req: AskRequest) -> dict[str, Any]:
    return await ask_chief_of_staff(req.question)


@app.post("/api/ask/stream")
async def ask_stream_endpoint(req: AskRequest) -> StreamingResponse:
    return StreamingResponse(
        ask_chief_of_staff_stream(req.question),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@app.get("/api/search")
async def search_endpoint(
    q: str = Query(..., min_length=1),
    source: str | None = None,
    limit: int = Query(default=20, le=50),
) -> dict[str, Any]:
    hits = await hybrid_search(q, limit=limit, source_filter=source if source != "all" else None)
    search_mode = hits[0].get("search_mode", "fts5_offline") if hits else "fts5_offline"
    return {"query": q, "search_mode": search_mode, "items": hits}


@app.post("/api/sweep")
async def sweep_endpoint(req: SweepRequest | None = None) -> dict[str, Any]:
    del req
    return await run_full_sweep(trigger_source="web_ui")


@app.post("/api/ingest/batch")
async def ingest_batch_endpoint(req: IngestBatchRequest) -> dict[str, Any]:
    counts = ingest_batch_payload(req.model_dump())
    embedded = 0
    try:
        embedded = await index_missing_embeddings(limit=50)
    except Exception:
        pass
    return {"ok": True, "ingested": counts, "embedded": embedded}


@app.get("/api/settings")
def get_settings_endpoint() -> dict[str, Any]:
    with db_session() as conn:
        return {"settings": get_settings_dict(conn)}


@app.put("/api/settings")
def update_settings_endpoint(payload: dict[str, Any]) -> dict[str, Any]:
    now = utc_now_iso()
    with db_session() as conn:
        for k, v in payload.items():
            conn.execute(
                """
                INSERT INTO settings(key, value_json, updated_at)
                VALUES (?, ?, ?)
                ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at
                """,
                (str(k), json.dumps(v), now),
            )
        return {"settings": get_settings_dict(conn)}


# ---------------------------------------------------------------------------
# Backup, Restore & Redacted Diagnostics
# ---------------------------------------------------------------------------


@app.get("/api/system/backups")
def list_backups_endpoint() -> dict[str, Any]:
    return {"items": list_wal_backups()}


@app.post("/api/system/backup")
def create_backup_endpoint(req: BackupCreateRequest) -> dict[str, Any]:
    return {"backup": create_wal_backup(req.label)}


@app.post("/api/system/restore")
def restore_backup_endpoint(req: BackupRestoreRequest) -> dict[str, Any]:
    try:
        return {"restore": restore_wal_backup(req.filename)}
    except (FileNotFoundError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/api/system/diagnostics")
async def get_diagnostics_bundle() -> dict[str, Any]:
    """Secret-redacted local diagnostics bundle for System & Support."""
    gw = await check_gateway_connectivity()
    with db_session() as conn:
        pid = get_active_profile_id(conn)
        prof = redact_structure(get_active_profile(conn))
        settings = redact_structure(get_settings_dict(conn))
        missions_recent = [redact_structure(m) for m in list_missions(conn, limit=8)]
        counts = {
            "events": conn.execute("SELECT COUNT(*) AS c FROM events WHERE profile_id = ?", (pid,)).fetchone()["c"],
            "tasks": conn.execute("SELECT COUNT(*) AS c FROM tasks WHERE profile_id = ?", (pid,)).fetchone()["c"],
            "approvals_pending": conn.execute(
                "SELECT COUNT(*) AS c FROM approvals WHERE profile_id = ? AND status IN ('pending', 'queued_undo')",
                (pid,),
            ).fetchone()["c"],
            "missions": conn.execute("SELECT COUNT(*) AS c FROM missions WHERE profile_id = ?", (pid,)).fetchone()["c"],
            "embeddings": conn.execute("SELECT COUNT(*) AS c FROM embeddings WHERE profile_id = ?", (pid,)).fetchone()["c"],
        }
    return {
        "generated_at": utc_now_iso(),
        "gateway": gw,
        "counts": counts,
        "active_profile": prof,
        "settings": settings,
        "recent_missions": missions_recent,
        "backups": list_wal_backups()[:10],
    }
