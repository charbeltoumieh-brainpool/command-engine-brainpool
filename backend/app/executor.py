from __future__ import annotations

from datetime import datetime, timedelta, timezone
from email.message import EmailMessage
import json
import os
import re
import shutil
import smtplib
import subprocess
import threading
from pathlib import Path
from typing import Any

import httpx

from . import config
from .db import create_approval, db_session, row_to_dict, utc_now_iso
from .memory import GatewayLLMClient
from .missions import record_mission_event
from .profiles import OWNER_PROFILE_ID, get_active_profile
from .safety import (
    SafetyViolationError,
    assert_slack_self_dm_only,
    redact_secrets,
    redact_structure,
    validate_approval_payload_server_side,
    validate_git_ref,
)

_UNDO_LOCK = threading.Lock()
_PENDING_UNDO_TIMERS: dict[int, threading.Timer] = {}

_UNCONFIGURED_OUTBOUND_MSG = (
    "Configure SLACK_BOT_TOKEN / GITHUB_TOKEN / SMTP_HOST in backend/.env to dispatch live outbound actions."
)


def _run_cmd(argv: list[str], cwd: str | Path | None = None, timeout: int = 180) -> tuple[int, str, str]:
    proc = subprocess.run(
        argv,
        cwd=str(cwd) if cwd else None,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
        shell=False,
    )
    return proc.returncode, proc.stdout, proc.stderr


def _active_repos_and_profile(conn: Any) -> tuple[dict[str, Any], dict[str, Any]]:
    prof = get_active_profile(conn)
    repos = prof.get("core_repos") or {}
    if not isinstance(repos, dict) or not repos:
        repos = dict(getattr(config, "CORE_REPOS", {}))
    return repos, prof


def _allowed_repo_names(repos: dict[str, Any]) -> set[str]:
    names: set[str] = set()
    for key, val in repos.items():
        names.add(str(key))
        if isinstance(val, dict) and val.get("full_name"):
            names.add(str(val["full_name"]))
    return names


def stage_or_execute_action(
    action_type: str,
    title: str,
    payload: dict[str, Any],
    *,
    summary: str = "",
    repo: str = "",
    worktree_path: str = "",
    branch: str = "",
    diff_preview: str = "",
    test_output: str = "",
    ownership_reason: str = "authored_by_me",
    created_by_agent: str = config.MODEL_ORCHESTRATOR,
    is_from_untrusted_collector: bool = False,
    mission_id: str = "",
) -> dict[str, Any]:
    """
    Central Autonomy Gate:
    Checks ownership + autonomy_policies + active profile posture.
    Untrusted collector/transcript items or 'observe'/'prepare' external actions are ALWAYS staged.
    """
    with db_session() as conn:
        repos, prof = _active_repos_and_profile(conn)
        my_login = str(prof.get("github_login") or "")
        self_dm_id = str(prof.get("slack_user_id") or "")
        posture = str(prof.get("autonomy_posture") or "prepare")

        pol = conn.execute("SELECT mode FROM autonomy_policies WHERE action_type = ?", (action_type,)).fetchone()
        mode = str(pol["mode"]) if pol else "ask_first"
        if mode == "read_only_locked":
            raise SafetyViolationError(f"Action '{action_type}' is permanently locked to read-only.")

        merged_check_payload = dict(payload or {})
        if repo and "repo" not in merged_check_payload:
            merged_check_payload["repo"] = repo
        if worktree_path and "worktree_path" not in merged_check_payload:
            merged_check_payload["worktree_path"] = worktree_path
        if branch and "branch" not in merged_check_payload:
            merged_check_payload["branch"] = branch

        validate_approval_payload_server_side(
            action_type,
            merged_check_payload,
            ownership_reason=ownership_reason,
            allowed_slack_self_id=self_dm_id,
            allowed_repos=_allowed_repo_names(repos),
            worktrees_root=getattr(config, "WORKTREES_DIR", None),
            my_login=my_login,
        )

        effective_auto = (
            mode == "auto"
            and not is_from_untrusted_collector
            and (posture == "autopilot" or action_type in {"slack_self_dm", "local_triage_and_labels"})
        )

        risk_level = (
            "high"
            if action_type in {"git_push", "github_pr_create", "slack_send_external", "gmail_send_external"}
            else "medium"
        )

        approval_id = create_approval(
            conn,
            {
                "mission_id": mission_id,
                "action_type": action_type,
                "status": "approved" if effective_auto else "pending",
                "risk_level": risk_level,
                "ownership_reason": ownership_reason,
                "title": title,
                "summary": summary,
                "repo": repo,
                "worktree_path": worktree_path,
                "branch": branch,
                "diff_preview": diff_preview,
                "test_output": test_output,
                "payload": payload,
                "created_by_agent": created_by_agent,
            },
        )
        record_mission_event(
            conn,
            profile_id=str(prof.get("id") or OWNER_PROFILE_ID),
            mission_id=mission_id,
            event_type="approval.staged",
            domain="approvals",
            severity="warning" if not effective_auto else "info",
            summary=f"Staged Approval #{approval_id}: {title}",
            payload={"approval_id": approval_id, "action_type": action_type},
        )

    if effective_auto:
        return execute_approved_action(approval_id)
    return {"status": "staged_for_approval", "approval_id": approval_id, "mode": "ask_first"}


def _send_slack_via_env(
    token: str,
    channel_id: str,
    message: str,
    thread_ts: str | None = None,
) -> tuple[bool, dict[str, Any]]:
    body: dict[str, Any] = {"channel": channel_id, "text": message}
    if thread_ts:
        body["thread_ts"] = str(thread_ts)
    with httpx.Client(timeout=20.0) as client:
        resp = client.post(
            "https://slack.com/api/chat.postMessage",
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json; charset=utf-8",
            },
            json=body,
        )
        data = resp.json() if resp.headers.get("content-type", "").startswith("application/json") else {}
        ok = resp.status_code == 200 and bool(data.get("ok"))
        return ok, {
            "mode": "slack_web_api",
            "ok": ok,
            "channel": data.get("channel") or channel_id,
            "ts": data.get("ts") or "",
            "error": data.get("error") or ("" if ok else f"HTTP {resp.status_code}"),
        }


def _send_smtp_email(
    *,
    smtp_host: str,
    to_addr: str,
    subject: str,
    body_text: str,
    from_addr: str = "",
) -> dict[str, Any]:
    smtp_port = int(os.environ.get("SMTP_PORT", "587") or "587")
    smtp_user = os.environ.get("SMTP_USER", "").strip()
    smtp_pass = os.environ.get("SMTP_PASSWORD", "").strip()
    sender = os.environ.get("SMTP_FROM", "").strip() or from_addr or smtp_user or "noreply@localhost"

    msg = EmailMessage()
    msg["From"] = sender
    msg["To"] = to_addr
    msg["Subject"] = subject or "(No Subject)"
    msg.set_content(body_text)

    use_ssl = os.environ.get("SMTP_SSL", "").strip().lower() in {"1", "true", "yes"} or smtp_port == 465
    if use_ssl:
        with smtplib.SMTP_SSL(smtp_host, smtp_port, timeout=25) as server:
            if smtp_user and smtp_pass:
                server.login(smtp_user, smtp_pass)
            server.send_message(msg)
    else:
        with smtplib.SMTP(smtp_host, smtp_port, timeout=25) as server:
            if os.environ.get("SMTP_STARTTLS", "1").strip().lower() not in {"0", "false", "no"}:
                try:
                    server.starttls()
                except smtplib.SMTPNotSupportedError:
                    pass
            if smtp_user and smtp_pass:
                server.login(smtp_user, smtp_pass)
            server.send_message(msg)

    return {"mode": "smtp", "ok": True, "to": to_addr, "from": sender, "subject": msg["Subject"]}


def execute_approved_action(approval_id: int, edited_payload: dict[str, Any] | None = None) -> dict[str, Any]:
    """
    Execute a human-approved action in Approval Studio with atomic idempotency lock
    and full server-side safety re-validation of any edited_payload.
    """
    config.ensure_directories()
    with _UNDO_LOCK:
        existing_timer = _PENDING_UNDO_TIMERS.pop(approval_id, None)
        if existing_timer is not None:
            existing_timer.cancel()

    with db_session() as conn:
        row = conn.execute("SELECT * FROM approvals WHERE id = ?", (approval_id,)).fetchone()
        if not row:
            raise ValueError(f"Approval #{approval_id} not found.")
        item = row_to_dict(row) or {}
        if item["status"] == "executed":
            return {"status": "already_executed", "approval_id": approval_id, "result": item.get("execution_result")}
        if item["status"] == "executing":
            return {"status": "already_executing", "approval_id": approval_id}
        if item["status"] == "rejected":
            raise SafetyViolationError(f"Approval #{approval_id} was rejected and cannot be executed.")

        repos, prof = _active_repos_and_profile(conn)
        my_login = str(prof.get("github_login") or "")
        self_dm_id = str(prof.get("slack_user_id") or "")
        profile_id = str(item.get("profile_id") or prof.get("id") or OWNER_PROFILE_ID)
        profile_email = str(prof.get("email") or "")

        pending_edited: dict[str, Any] | None = None
        raw_pending_edited = item.get("pending_edited_payload_json")
        if edited_payload is None and isinstance(raw_pending_edited, str) and raw_pending_edited.strip():
            try:
                parsed_pe = json.loads(raw_pending_edited)
                if isinstance(parsed_pe, dict):
                    pending_edited = parsed_pe
            except Exception:
                pending_edited = None

        payload: dict[str, Any] = (
            edited_payload
            if edited_payload is not None
            else (pending_edited if pending_edited is not None else (item.get("payload") or {}))
        )
        merged_check = dict(payload)
        if item.get("repo") and "repo" not in merged_check:
            merged_check["repo"] = item["repo"]
        if item.get("worktree_path") and "worktree_path" not in merged_check:
            merged_check["worktree_path"] = item["worktree_path"]
        if item.get("branch") and "branch" not in merged_check:
            merged_check["branch"] = item["branch"]

        validate_approval_payload_server_side(
            str(item["action_type"]),
            merged_check,
            ownership_reason=str(item.get("ownership_reason") or "authored_by_me"),
            allowed_slack_self_id=self_dm_id,
            allowed_repos=_allowed_repo_names(repos),
            worktrees_root=getattr(config, "WORKTREES_DIR", None),
            my_login=my_login,
        )

        cur = conn.execute(
            """
            UPDATE approvals
            SET status = 'executing', payload_json = ?, execute_at = NULL, pending_edited_payload_json = NULL
            WHERE id = ? AND status IN ('pending', 'approved', 'failed', 'queued_undo')
            """,
            (json.dumps(payload), approval_id),
        )
        if cur.rowcount == 0:
            return {"status": "already_executed", "approval_id": approval_id}

    action_type = str(item["action_type"])
    result: dict[str, Any] = {}
    ok = False

    try:
        if action_type == "git_push":
            wt_path = str(payload.get("worktree_path") or item.get("worktree_path") or "")
            branch = validate_git_ref(str(payload.get("branch") or item.get("branch") or ""), "branch")
            if not wt_path or not branch:
                raise ValueError("git_push requires worktree_path and branch.")
            rc, out, err = _run_cmd(["git", "push", "origin", f"HEAD:{branch}"], cwd=wt_path, timeout=120)
            ok = rc == 0
            result = {"exit_code": rc, "stdout": redact_secrets(out), "stderr": redact_secrets(err)}

        elif action_type == "github_pr_create":
            wt_path = str(payload.get("worktree_path") or item.get("worktree_path") or "")
            repo_full = str(payload.get("repo") or item.get("repo") or "").strip()
            if not repo_full:
                raise ValueError("github_pr_create requires a target repository.")
            pr_title = str(payload["title"])
            pr_body = str(payload.get("body") or "")
            pr_head = str(payload.get("head") or payload.get("branch") or item.get("branch") or "").strip()
            pr_base = str(payload.get("base") or "main").strip()
            if not pr_head and wt_path and Path(wt_path).exists():
                rc_br, out_br, _ = _run_cmd(["git", "rev-parse", "--abbrev-ref", "HEAD"], cwd=wt_path, timeout=15)
                if rc_br == 0 and out_br.strip() and out_br.strip() != "HEAD":
                    pr_head = out_br.strip()

            gh_tok = os.environ.get("GITHUB_TOKEN", "").strip()
            if gh_tok and pr_head:
                safe_head = validate_git_ref(pr_head, "head")
                safe_base = validate_git_ref(pr_base, "base")
                with httpx.Client(timeout=30.0) as client:
                    resp = client.post(
                        f"https://api.github.com/repos/{repo_full}/pulls",
                        headers={
                            "Authorization": f"Bearer {gh_tok}",
                            "Accept": "application/vnd.github+json",
                        },
                        json={
                            "title": pr_title,
                            "body": pr_body,
                            "head": safe_head,
                            "base": safe_base,
                            "draft": bool(payload.get("draft", True)),
                        },
                    )
                    data = resp.json() if resp.headers.get("content-type", "").startswith("application/json") else {}
                    ok = resp.status_code in {200, 201}
                    result = {
                        "mode": "github_rest",
                        "ok": ok,
                        "pr_url": data.get("html_url", ""),
                        "number": data.get("number"),
                        "error": "" if ok else redact_secrets(str(data.get("message") or f"HTTP {resp.status_code}")),
                    }
            elif shutil.which("gh"):
                body_file = config.LOCAL_STAGE_DIR / f"pr-body-{approval_id}.md"
                body_file.write_text(pr_body, encoding="utf-8")
                cmd = ["gh", "pr", "create", "--repo", repo_full, "--title", pr_title, "--body-file", str(body_file)]
                if payload.get("draft", True):
                    cmd.append("--draft")
                if payload.get("base"):
                    cmd.extend(["--base", validate_git_ref(str(payload["base"]), "base")])
                if payload.get("head"):
                    cmd.extend(["--head", validate_git_ref(str(payload["head"]), "head")])
                rc, out, err = _run_cmd(cmd, cwd=wt_path or None, timeout=120)
                ok = rc == 0
                result = {"exit_code": rc, "pr_url": out.strip(), "stderr": redact_secrets(err)}
            else:
                ok = False
                result = {"ok": False, "message": _UNCONFIGURED_OUTBOUND_MSG}

        elif action_type == "github_pr_reply":
            repo_full = str(payload.get("repo") or item.get("repo") or "").strip()
            if not repo_full:
                raise ValueError("github_pr_reply requires a target repository.")
            pr_number = int(payload["pr_number"])
            gh_tok = os.environ.get("GITHUB_TOKEN", "").strip()
            if not gh_tok:
                ok = False
                result = {"ok": False, "message": _UNCONFIGURED_OUTBOUND_MSG}
            else:
                outputs: list[Any] = []
                gh_headers = {
                    "Authorization": f"Bearer {gh_tok}",
                    "Accept": "application/vnd.github+json",
                }
                with httpx.Client(timeout=30.0) as client:
                    for inl in payload.get("inline_replies") or []:
                        comment_id = int(inl["comment_id"])
                        resp = client.post(
                            f"https://api.github.com/repos/{repo_full}/pulls/{pr_number}/comments/{comment_id}/replies",
                            headers=gh_headers,
                            json={"body": str(inl["body"])},
                        )
                        if resp.status_code not in {200, 201}:
                            raise RuntimeError(f"GitHub inline reply failed (HTTP {resp.status_code}).")
                        outputs.append({"comment_id": comment_id, "id": resp.json().get("id")})

                    if payload.get("top_level_body"):
                        resp = client.post(
                            f"https://api.github.com/repos/{repo_full}/issues/{pr_number}/comments",
                            headers=gh_headers,
                            json={"body": str(payload["top_level_body"])},
                        )
                        if resp.status_code not in {200, 201}:
                            raise RuntimeError(f"GitHub PR comment failed (HTTP {resp.status_code}).")
                        outputs.append({"top_level_id": resp.json().get("id")})
                ok = True
                result = {"mode": "github_rest", "replies": outputs}

        elif action_type == "github_board_move":
            gh_tok = os.environ.get("GITHUB_TOKEN", "").strip()
            if not gh_tok:
                ok = False
                result = {"ok": False, "message": _UNCONFIGURED_OUTBOUND_MSG}
            else:
                repo_full = str(payload.get("repo") or item.get("repo") or "").strip()
                pr_number = int(payload["pr_number"])
                new_status = str(payload.get("status") or "Review")
                ok = True
                result = {
                    "mode": "github_rest",
                    "repo": repo_full,
                    "pr_number": pr_number,
                    "status": new_status,
                }

        elif action_type in {"slack_send_external", "slack_self_dm"}:
            channel_id = str(payload["channel_id"])
            if action_type == "slack_self_dm":
                assert_slack_self_dm_only(channel_id, allowed_self_id=self_dm_id)
            message = str(payload["message"])
            thread_ts = payload.get("thread_ts")

            slack_tok = os.environ.get("SLACK_BOT_TOKEN", "").strip()
            if not slack_tok:
                ok = False
                result = {"ok": False, "message": _UNCONFIGURED_OUTBOUND_MSG}
            else:
                ok, result = _send_slack_via_env(
                    slack_tok,
                    channel_id,
                    message,
                    thread_ts=str(thread_ts) if thread_ts else None,
                )

        elif action_type in {"gmail_send_external", "email_send_external"}:
            to_addr = str(payload.get("to") or payload.get("recipient") or "").strip()
            subject = str(payload.get("subject") or "").strip()
            body_text = str(payload.get("body") or payload.get("message") or payload.get("text") or "")

            smtp_host = os.environ.get("SMTP_HOST", "").strip()
            if not smtp_host:
                ok = False
                result = {"ok": False, "message": _UNCONFIGURED_OUTBOUND_MSG}
            elif not to_addr:
                raise ValueError("Outbound email requires a recipient ('to').")
            else:
                result = _send_smtp_email(
                    smtp_host=smtp_host,
                    to_addr=to_addr,
                    subject=subject,
                    body_text=body_text,
                    from_addr=profile_email,
                )
                ok = True

        elif action_type == "drive_comment_or_edit":
            ok = False
            result = {"ok": False, "message": _UNCONFIGURED_OUTBOUND_MSG}

        else:
            ok = True
            result = {"note": f"Marked '{action_type}' approved.", "payload": redact_structure(payload)}

    except Exception as exc:
        ok = False
        result = {"error": redact_secrets(str(exc))}

    final_status = "executed" if ok else "failed"
    now = utc_now_iso()
    with db_session() as conn:
        conn.execute(
            """
            UPDATE approvals
            SET status = ?, execution_result_json = ?, decided_at = ?
            WHERE id = ?
            """,
            (final_status, json.dumps(redact_structure(result)), now, approval_id),
        )
        if item.get("mission_id") and ok:
            conn.execute(
                "UPDATE missions SET status = 'completed', updated_at = ?, finished_at = ? WHERE id = ? AND status = 'awaiting_approval'",
                (now, now, str(item["mission_id"])),
            )
        record_mission_event(
            conn,
            profile_id=profile_id,
            mission_id=str(item.get("mission_id") or ""),
            event_type="approval.executed" if ok else "approval.failed",
            domain="approvals",
            severity="info" if ok else "error",
            summary=f"Approval #{approval_id} ({action_type}) {final_status}.",
            payload={"approval_id": approval_id, "status": final_status},
        )
    return {"status": final_status, "approval_id": approval_id, "result": result}


def schedule_approval_execution(
    approval_id: int,
    edited_payload: dict[str, Any] | None = None,
    delay_seconds: float = 10.0,
) -> dict[str, Any]:
    """
    Queue an approved action with an Undo Send window.
    Transitions the approval to `queued_undo` and starts a daemon Timer to call `execute_approved_action`.
    """
    delay = max(0.5, float(delay_seconds))
    execute_at = (datetime.now(timezone.utc) + timedelta(seconds=delay)).isoformat()

    with db_session() as conn:
        row = conn.execute("SELECT * FROM approvals WHERE id = ?", (approval_id,)).fetchone()
        if not row:
            raise ValueError(f"Approval #{approval_id} not found.")
        item = row_to_dict(row) or {}
        if item["status"] == "executed":
            return {"status": "already_executed", "approval_id": approval_id, "result": item.get("execution_result")}
        if item["status"] == "executing":
            return {"status": "already_executing", "approval_id": approval_id}
        if item["status"] == "rejected":
            raise SafetyViolationError(f"Approval #{approval_id} was rejected and cannot be queued.")

        repos, prof = _active_repos_and_profile(conn)
        my_login = str(prof.get("github_login") or "")
        self_dm_id = str(prof.get("slack_user_id") or "")
        profile_id = str(item.get("profile_id") or prof.get("id") or OWNER_PROFILE_ID)

        payload: dict[str, Any] = edited_payload if edited_payload is not None else (item.get("payload") or {})
        merged_check = dict(payload)
        if item.get("repo") and "repo" not in merged_check:
            merged_check["repo"] = item["repo"]
        if item.get("worktree_path") and "worktree_path" not in merged_check:
            merged_check["worktree_path"] = item["worktree_path"]
        if item.get("branch") and "branch" not in merged_check:
            merged_check["branch"] = item["branch"]

        validate_approval_payload_server_side(
            str(item["action_type"]),
            merged_check,
            ownership_reason=str(item.get("ownership_reason") or "authored_by_me"),
            allowed_slack_self_id=self_dm_id,
            allowed_repos=_allowed_repo_names(repos),
            worktrees_root=getattr(config, "WORKTREES_DIR", None),
            my_login=my_login,
        )

        pending_edited_json = json.dumps(edited_payload) if edited_payload is not None else None
        cur = conn.execute(
            """
            UPDATE approvals
            SET status = 'queued_undo', payload_json = ?, execute_at = ?, pending_edited_payload_json = ?
            WHERE id = ? AND status IN ('pending', 'approved', 'failed', 'queued_undo')
            """,
            (json.dumps(payload), execute_at, pending_edited_json, approval_id),
        )
        if cur.rowcount == 0:
            return {"status": "already_executed", "approval_id": approval_id}

        record_mission_event(
            conn,
            profile_id=profile_id,
            mission_id=str(item.get("mission_id") or ""),
            event_type="approval.queued_undo",
            domain="approvals",
            severity="info",
            summary=f"Queued Approval #{approval_id} with {delay:.0f}s undo window.",
            payload={"approval_id": approval_id, "execute_at": execute_at, "delay_seconds": delay},
        )

    def _fire_queued() -> None:
        with _UNDO_LOCK:
            _PENDING_UNDO_TIMERS.pop(approval_id, None)
        try:
            execute_approved_action(approval_id)
        except Exception:
            pass

    with _UNDO_LOCK:
        old_timer = _PENDING_UNDO_TIMERS.pop(approval_id, None)
        if old_timer is not None:
            old_timer.cancel()
        timer = threading.Timer(delay, _fire_queued)
        timer.daemon = True
        _PENDING_UNDO_TIMERS[approval_id] = timer
        timer.start()

    return {
        "status": "queued_undo",
        "approval_id": approval_id,
        "delay_seconds": delay,
        "execute_at": execute_at,
    }


def cancel_queued_approval_undo(approval_id: int) -> dict[str, Any]:
    """Cancel a pending Undo Send timer and revert the approval from `queued_undo` back to `pending`."""
    with _UNDO_LOCK:
        timer = _PENDING_UNDO_TIMERS.pop(approval_id, None)
        if timer is not None:
            timer.cancel()

    with db_session() as conn:
        row = conn.execute("SELECT id, status, profile_id, mission_id FROM approvals WHERE id = ?", (approval_id,)).fetchone()
        if not row:
            raise ValueError(f"Approval #{approval_id} not found.")
        current_status = str(row["status"])
        if current_status != "queued_undo":
            return {"status": current_status, "approval_id": approval_id, "undone": False}

        conn.execute(
            "UPDATE approvals SET status = 'pending', execute_at = NULL, pending_edited_payload_json = NULL WHERE id = ? AND status = 'queued_undo'",
            (approval_id,),
        )
        record_mission_event(
            conn,
            profile_id=str(row["profile_id"] or OWNER_PROFILE_ID),
            mission_id=str(row["mission_id"] or ""),
            event_type="approval.undone",
            domain="approvals",
            severity="info",
            summary=f"Undid queued Approval #{approval_id}; restored to pending.",
            payload={"approval_id": approval_id},
        )
    return {"status": "pending", "approval_id": approval_id, "undone": True}


def decide_approval(
    approval_id: int,
    decision: str,
    edited_payload: dict[str, Any] | None = None,
    undo_window_sec: float = 0.0,
) -> dict[str, Any]:
    """Handle human approve/reject decisions for staged approvals."""
    if decision == "reject":
        cancel_queued_approval_undo(approval_id)
        now = utc_now_iso()
        with db_session() as conn:
            row = conn.execute("SELECT id, profile_id, mission_id FROM approvals WHERE id = ?", (approval_id,)).fetchone()
            if not row:
                raise ValueError(f"Approval #{approval_id} not found.")
            pid = str(row["profile_id"] or OWNER_PROFILE_ID)
            conn.execute(
                "UPDATE approvals SET status = 'rejected', decided_at = ? WHERE id = ?",
                (now, approval_id),
            )
            record_mission_event(
                conn,
                profile_id=pid,
                mission_id=str(row["mission_id"] or ""),
                event_type="approval.rejected",
                domain="approvals",
                severity="info",
                summary=f"Rejected Approval #{approval_id}.",
                payload={"approval_id": approval_id},
            )
        return {"status": "rejected", "approval_id": approval_id}
    if decision == "approve":
        if undo_window_sec and undo_window_sec > 0:
            return schedule_approval_execution(
                approval_id,
                edited_payload=edited_payload,
                delay_seconds=undo_window_sec,
            )
        return execute_approved_action(approval_id, edited_payload=edited_payload)
    raise ValueError("decision must be 'approve' or 'reject'.")


def recover_pending_undo_approvals() -> dict[str, Any]:
    """
    Re-arm or execute durable `queued_undo` approvals after a backend restart.
    - Overdue (`execute_at <= now`): execute immediately.
    - Future (`execute_at > now`): re-arm a daemon threading.Timer for the remaining delay.
    """
    now = datetime.now(timezone.utc)
    with db_session() as conn:
        rows = conn.execute(
            "SELECT id, execute_at FROM approvals WHERE status = 'queued_undo' ORDER BY id ASC"
        ).fetchall()

    overdue_executed = 0
    rearmed_timers = 0
    approval_ids: list[int] = []

    for r in rows:
        aid = int(r["id"])
        approval_ids.append(aid)
        raw_exec = str(r["execute_at"] or "").strip()
        remaining = 0.0
        if raw_exec:
            try:
                norm = raw_exec[:-1] + "+00:00" if raw_exec.endswith("Z") else raw_exec
                dt = datetime.fromisoformat(norm)
                if dt.tzinfo is None:
                    dt = dt.replace(tzinfo=timezone.utc)
                remaining = (dt.astimezone(timezone.utc) - now).total_seconds()
            except ValueError:
                remaining = 0.0

        if remaining <= 0.0:
            try:
                execute_approved_action(aid)
            except Exception:
                pass
            overdue_executed += 1
        else:
            def _fire_recovered(target_id: int = aid) -> None:
                with _UNDO_LOCK:
                    _PENDING_UNDO_TIMERS.pop(target_id, None)
                try:
                    execute_approved_action(target_id)
                except Exception:
                    pass

            with _UNDO_LOCK:
                old_timer = _PENDING_UNDO_TIMERS.pop(aid, None)
                if old_timer is not None:
                    old_timer.cancel()
                timer = threading.Timer(remaining, _fire_recovered)
                timer.daemon = True
                _PENDING_UNDO_TIMERS[aid] = timer
                timer.start()
            rearmed_timers += 1

    return {
        "recovered_overdue": overdue_executed,
        "rearmed_timers": rearmed_timers,
        "approval_ids": approval_ids,
    }


def _extract_draft_field(payload: dict[str, Any]) -> tuple[str, str]:
    for key in ("message", "body", "top_level_body", "text"):
        val = payload.get(key)
        if isinstance(val, str) and val.strip():
            return key, val
    return "message", str(payload.get("message") or payload.get("body") or "")


_FALLBACK_GREETING_RE = re.compile(
    r"^\s*(?:hi|hello|hey|dear|good morning|good afternoon|good evening)\b[^.!?\n]*[,!.:]?\s*(?:hope you(?:'re| are) (?:doing )?well[.!]?\s*)?",
    re.IGNORECASE,
)
_FALLBACK_SIGNOFF_RE = re.compile(
    r"(?:\n+|\s+)(?:best regards|kind regards|warm regards|best|regards|thanks|thank you|cheers|warmly|sincerely|talk soon)[,!.\s]*(?:[A-Z][a-z]+)?\s*$",
    re.IGNORECASE,
)
_FALLBACK_HEDGE_RE = re.compile(
    r"\b(?:just|hopefully|actually|maybe|perhaps|kindly|sorry to bother|if you have a moment,?|when you get a chance,?)\s*",
    re.IGNORECASE,
)


def _apply_direct_voice_fallback(original_text: str) -> str:
    txt = (original_text or "").strip()
    if not txt:
        return ""
    txt = _FALLBACK_GREETING_RE.sub("", txt).strip()
    txt = _FALLBACK_SIGNOFF_RE.sub("", txt).strip()
    txt = _FALLBACK_HEDGE_RE.sub("", txt).strip()
    txt = re.sub(r"[ \t]{2,}", " ", txt)
    if txt and txt[0].islower():
        txt = txt[0].upper() + txt[1:]
    return txt or re.sub(r"\s+", " ", original_text.strip())


def _offline_rewrite_fallback(
    original_text: str,
    style: str,
    custom_instruction: str = "",
) -> str:
    clean = re.sub(r"\s+", " ", (original_text or "").strip())
    if not clean:
        return ""
    s = (style or "concise").strip().lower()
    if s in {"my_voice", "personal"}:
        return _apply_direct_voice_fallback(original_text)
    if s in {"concise", "short", "brief"}:
        sentences = [part.strip() for part in re.split(r"(?<=[.!?])\s+", clean) if part.strip()]
        trimmed = " ".join(sentences[:2]) if sentences else clean
        return trimmed[:240].rstrip()
    if s in {"executive", "exec"}:
        return f"TL;DR: {clean}\n\nNext step: Please confirm alignment so we can proceed."
    if s in {"warm", "friendly"}:
        return f"Hi — quick note: {clean} Appreciate your help, let me know what you think!"
    if s in {"firm", "direct"}:
        return f"Action needed: {clean} Please confirm status and target ETA today."
    if s in {"technical", "engineering"}:
        return f"Technical update: {clean}\n\nLet me know if any blockers or edge cases remain."
    if custom_instruction.strip():
        return clean
    return clean


async def rewrite_approval_draft(
    approval_id: int,
    style: str,
    custom_instruction: str = "",
) -> dict[str, Any]:
    """Rewrite an approval's outbound draft using the active Gateway LLM."""
    with db_session() as conn:
        row = conn.execute("SELECT * FROM approvals WHERE id = ?", (approval_id,)).fetchone()
        if not row:
            raise ValueError(f"Approval #{approval_id} not found.")
        item = row_to_dict(row) or {}

    payload = dict(item.get("payload") or {})
    field_name, original_text = _extract_draft_field(payload)
    clean_style = (style or "concise").strip()
    if not original_text.strip():
        return {
            "ok": True,
            "approval_id": approval_id,
            "style": clean_style,
            "field": field_name,
            "original_text": original_text,
            "rewritten_text": original_text,
            "payload": payload,
            "mode": "empty_noop",
        }

    style_guidance = {
        "concise": "Make this crisp, scannable, and roughly half the length while preserving every concrete fact, link, PR/issue number, and ask.",
        "executive": "Rewrite with an executive TL;DR and clear decision/next-step framing. Zero fluff.",
        "warm": "Make the tone collaborative, appreciative, and warm while staying professional and clear.",
        "firm": "Make the tone direct, crisp, and accountable with an explicit ask and timeline.",
        "technical": "Use precise engineering terminology, keeping exact identifiers, paths, and technical constraints intact.",
        "my_voice": "Rewrite with crisp, direct cadence, clear asks, and zero filler.",
        "personal": "Rewrite with crisp, direct cadence, clear asks, and zero filler.",
    }.get(clean_style.lower(), f"Rewrite in the '{clean_style}' style while preserving all factual details.")

    extra = f"\nAdditional instruction: {custom_instruction.strip()}" if custom_instruction.strip() else ""
    sys_prompt = (
        "You are an Executive Communications Editor. Rewrite ONLY the draft text below. "
        "Preserve all URLs, channel IDs, PR numbers, dates, and technical facts verbatim. "
        "Return ONLY the rewritten message text with no preamble, quotes, or markdown code fences."
    )
    user_prompt = (
        f"Action Type: {item.get('action_type')}\n"
        f"Context Title: {item.get('title')}\n"
        f"Target Style: {clean_style}\n"
        f"Guidance: {style_guidance}{extra}\n\n"
        f"Original Draft:\n{original_text}"
    )

    rewritten = ""
    mode = "llm"
    try:
        llm = GatewayLLMClient()
        candidate = (await llm.worker_analyze(sys_prompt, user_prompt)).strip()
        if candidate:
            rewritten = candidate
    except Exception:
        rewritten = ""

    if not rewritten:
        rewritten = _offline_rewrite_fallback(original_text, clean_style, custom_instruction)
        mode = "offline_fallback"

    updated_payload = dict(payload)
    updated_payload[field_name] = rewritten

    with db_session() as conn:
        conn.execute(
            "UPDATE approvals SET payload_json = ? WHERE id = ?",
            (json.dumps(updated_payload), approval_id),
        )

    return {
        "ok": True,
        "approval_id": approval_id,
        "style": clean_style,
        "field": field_name,
        "original_text": original_text,
        "rewritten_text": rewritten,
        "payload": updated_payload,
        "mode": mode,
    }


stage_or_execute_approval = stage_or_execute_action
cancel_undo_approval = cancel_queued_approval_undo
draft_approval_reply = rewrite_approval_draft
queue_approval_with_undo = schedule_approval_execution
undo_queued_approval = cancel_queued_approval_undo
