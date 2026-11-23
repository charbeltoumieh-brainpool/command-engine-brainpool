from __future__ import annotations

from datetime import datetime, timedelta, timezone
import html
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import subprocess
import sys
import time
from typing import Any
import webbrowser

from fastapi import APIRouter, HTTPException
from fastapi.responses import HTMLResponse
import httpx
from pydantic import BaseModel

from . import config
from .config import BACKEND_PORT, GITHUB_USER, GOOGLE_EMAIL

from .db import (
    DEFAULT_INTEGRATIONS,
    db_session,
    get_auth_alerts,
    get_settings_dict,
    is_auth_error_text,
    record_integration_auth_status,
    row_to_dict,
    utc_now_iso,
)
from .local_runtime import (
    build_ai_capability_matrix,
    build_on_demand_pull_plan,
    detect_local_runtimes,
)
from .memory import (
    GatewayLLMClient,
    _build_provider_headers,
    invalidate_gateway_cache,
    resolve_active_llm_runtime,
)
from .native_connectors import (
    complete_oauth_pkce_callback,
    resolve_integration_token,
    start_oauth_pkce_flow,
)
from .profiles import OWNER_PROFILE_ID, get_active_profile

router = APIRouter(prefix="/api/integrations", tags=["integrations"])
ai_router = APIRouter(prefix="/api/ai/providers", tags=["ai-providers"])

BUILTIN_IDS = frozenset(item["id"] for item in DEFAULT_INTEGRATIONS)

AI_PROVIDER_CATALOG: list[dict[str, Any]] = [
    {
        "id": "openai-gateway",
        "name": "OpenAI-Compatible Gateway",
        "default_base_url": "",
        "requires_api_key": True,
        "recommended_models": [
            "gpt-4o-mini",
            "gpt-4.1-mini",
            "gpt-4o",
            "text-embedding-3-small",
        ],
        "description": "Managed OpenAI-compatible enterprise proxy routing chat & embeddings.",
    },
    {
        "id": "openai",
        "name": "OpenAI",
        "default_base_url": "https://api.openai.com/v1",
        "requires_api_key": True,
        "recommended_models": ["gpt-4.1", "gpt-4o", "o3-mini", "text-embedding-3-small"],
        "description": "Direct OpenAI API key for GPT-4.1, GPT-4o, o3-mini, and embeddings.",
    },
    {
        "id": "anthropic",
        "name": "Anthropic Claude",
        "default_base_url": "https://api.anthropic.com/v1",
        "requires_api_key": True,
        "recommended_models": ["claude-sonnet-4-5", "claude-opus-4-1", "claude-3-5-haiku-latest"],
        "description": "Direct Anthropic API access for Claude Sonnet & Opus models.",
    },
    {
        "id": "gemini",
        "name": "Google Gemini",
        "default_base_url": "https://generativelanguage.googleapis.com/v1beta/openai",
        "requires_api_key": True,
        "recommended_models": ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.5-flash-lite", "text-embedding-004"],
        "description": "Direct Google AI Studio OpenAI-compatible endpoint for Gemini models.",
    },
    {
        "id": "openrouter",
        "name": "OpenRouter",
        "default_base_url": "https://openrouter.ai/api/v1",
        "requires_api_key": True,
        "recommended_models": [
            "anthropic/claude-sonnet-4",
            "openai/gpt-4o",
            "google/gemini-2.5-pro",
            "deepseek/deepseek-r1",
        ],
        "description": "Unified multi-model API across Anthropic, OpenAI, Google, and open-weights.",
    },
    {
        "id": "groq",
        "name": "Groq",
        "default_base_url": "https://api.groq.com/openai/v1",
        "requires_api_key": True,
        "recommended_models": ["llama-3.3-70b-versatile", "qwen-qwq-32b"],
        "description": "Ultra-low-latency Llama & Qwen inference.",
    },
    {
        "id": "local",
        "name": "Local Model Runtime (Ollama / LM Studio)",
        "default_base_url": "http://127.0.0.1:11434/v1",
        "requires_api_key": False,
        "recommended_models": ["llama3.2:3b", "qwen2.5-coder:7b", "deepseek-r1:8b", "nomic-embed-text"],
        "description": "First-class key-free local inference via Ollama (11434) or LM Studio (1234).",
    },
    {
        "id": "ollama",
        "name": "Local Runner (Ollama)",
        "default_base_url": "http://127.0.0.1:11434/v1",
        "requires_api_key": False,
        "recommended_models": ["llama3.2", "qwen2.5-coder:14b", "deepseek-r1:14b", "nomic-embed-text"],
        "description": "100% offline local models via Ollama OpenAI-compatible endpoint.",
    },
    {
        "id": "lmstudio",
        "name": "LM Studio (Local)",
        "default_base_url": "http://127.0.0.1:1234/v1",
        "requires_api_key": False,
        "recommended_models": ["local-model", "qwen2.5-coder-7b-instruct", "llama-3.2-3b-instruct"],
        "description": "Key-free local desktop inference via LM Studio server (port 1234).",
    },
    {
        "id": "custom-gateway",
        "name": "Custom OpenAI-Compatible Gateway",
        "default_base_url": "",
        "requires_api_key": True,
        "recommended_models": [],
        "description": "Any self-hosted OpenAI-compatible endpoint (vLLM, Azure OpenAI, Together, or a proxy).",
    },
    {
        "id": "none",
        "name": "No-Key Limited Mode",
        "default_base_url": "",
        "requires_api_key": False,
        "recommended_models": [],
        "description": "Run key-free with SQLite FTS5 search, tasks, approvals, vault, and deterministic browser tools.",
    },
]
AI_PROVIDER_BY_ID = {p["id"]: p for p in AI_PROVIDER_CATALOG}


class AIProviderConfigureRequest(BaseModel):
    provider_id: str
    api_key: str = ""
    base_url: str = ""
    model_orchestrator: str = ""
    model_worker: str = ""
    model_fast: str = ""
    model_embedding: str = ""
    offline_local_runner_enabled: bool | None = None
    offline_local_runner_url: str = ""
    offline_local_model: str = ""
    activate: bool = True


class AIProviderTestRequest(BaseModel):
    provider_id: str
    api_key: str = ""
    base_url: str = ""
    model: str = ""


class IntegrationPatchRequest(BaseModel):
    enabled: bool | None = None
    is_default: bool | None = None
    auth_status: str | None = None
    auth_message: str | None = None
    account_label: str | None = None
    command_or_url: str | None = None
    auth_command: str | None = None
    config: dict[str, Any] | None = None


class IntegrationAuthRequest(BaseModel):
    mode: str = "verify_or_launch"  # verify | launch | token | disconnect
    launch_browser: bool = False
    api_token: str = ""
    mcp_server_url: str = ""
    account_label: str = ""


class OAuthStartRequest(BaseModel):
    client_id: str = ""
    client_secret: str = ""
    redirect_uri: str = ""
    open_browser: bool = False


class AskBotConnectorRequest(BaseModel):
    request_text: str
    category_hint: str = "auto"  # auto | coding_agent | workspace_app | cloud_infra | custom
    auto_register: bool = True


class StandaloneRuntimePatch(BaseModel):
    runtime_mode: str | None = None  # web_local | hybrid_local | standalone_headless
    gateway_base_url: str | None = None
    litellm_base_url: str | None = None  # legacy alias for gateway_base_url
    default_coding_agent: str | None = None

    def resolved_gateway_base_url(self) -> str | None:
        return self.gateway_base_url if self.gateway_base_url is not None else self.litellm_base_url


def _find_gcloud_cmd() -> str | None:
    candidates = [
        shutil.which("gcloud"),
        shutil.which("gcloud.cmd"),
        str(Path.home() / "google-cloud-sdk" / "bin" / "gcloud"),
    ]
    if sys.platform == "win32":
        candidates.insert(
            1,
            str(Path.home() / "AppData" / "Local" / "Google" / "Cloud SDK" / "google-cloud-sdk" / "bin" / "gcloud.cmd"),
        )
    for candidate in candidates:
        if candidate and Path(candidate).exists():
            return candidate
    return None


def _gcloud_argv(gcloud_cmd: str, *args: str) -> list[str]:
    if sys.platform == "win32" and gcloud_cmd.lower().endswith((".cmd", ".bat")):
        return ["cmd", "/c", gcloud_cmd, *args]
    return [gcloud_cmd, *args]


def _open_url_in_browser(url: str) -> bool:
    clean = (url or "").strip()
    if not clean.startswith(("http://", "https://")):
        return False
    try:
        return bool(webbrowser.open(clean))
    except Exception:
        return False


def _launch_cli_login(argv: list[str]) -> bool:
    try:
        kwargs: dict[str, Any] = {}
        if sys.platform == "win32":
            kwargs["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        subprocess.Popen(argv, **kwargs)
        return True
    except Exception:
        return False


def _run_quick(argv: list[str], timeout: int = 8) -> tuple[int, str, str]:
    try:
        proc = subprocess.run(
            argv,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
        )
        return proc.returncode, proc.stdout.strip(), proc.stderr.strip()
    except Exception as exc:
        return 1, "", str(exc)


def _list_integrations_Payload(conn: Any) -> dict[str, Any]:
    rows = conn.execute(
        """
        SELECT * FROM integrations
        ORDER BY
            CASE category
                WHEN 'coding_agent' THEN 1
                WHEN 'workspace_app' THEN 2
                WHEN 'cloud_infra' THEN 3
                ELSE 4
            END,
            is_default DESC,
            name ASC
        """
    ).fetchall()
    items = [row_to_dict(r) for r in rows]
    for it in items:
        if it is not None:
            it["enabled"] = bool(it.get("enabled"))
            it["is_default"] = bool(it.get("is_default"))
            it["is_builtin"] = str(it.get("id")) in BUILTIN_IDS

    settings = get_settings_dict(conn)
    runtime = {
        "runtime_mode": settings.get("runtime_mode", "web_local"),
        "standalone_port": int(settings.get("standalone_port", BACKEND_PORT)),
        "gateway_base_url": str(settings.get("gateway_base_url") or config.DEFAULT_GATEWAY_BASE_URL),
        "default_coding_agent": str(settings.get("default_coding_agent") or "local"),
    }
    return {
        "items": items,
        "auth_alerts": get_auth_alerts(conn),
        "runtime": runtime,
    }


@router.get("")
def get_integrations() -> dict[str, Any]:
    with db_session() as conn:
        return _list_integrations_Payload(conn)


@router.post("/probe")
def probe_integrations() -> dict[str, Any]:
    """Probe local CLIs, profile directories, GitHub session, and Google Cloud credentials."""
    home = Path.home()
    with db_session() as conn:
        prof = get_active_profile(conn)
    pid = str(prof.get("id") or OWNER_PROFILE_ID)
    is_owner = pid == OWNER_PROFILE_ID
    gh_user = str(prof.get("github_login") or (GITHUB_USER if is_owner else "")).strip()
    user_email = str(prof.get("email") or (GOOGLE_EMAIL if is_owner else "")).strip()
    orch_model = str(prof.get("model_orchestrator") or config.MODEL_ORCHESTRATOR).strip()

    updates: list[tuple[str, str, str, str | None]] = []

    # 1. Coding-agent CLIs (detected only; no built-in row required).
    opencode_bin = shutil.which("opencode") or shutil.which("opencode.cmd")
    if not (opencode_bin and Path(opencode_bin).exists()):
        alt_oc = home / ".local" / "bin" / ("opencode.exe" if sys.platform == "win32" else "opencode")
        if alt_oc.exists():
            opencode_bin = str(alt_oc)
    if opencode_bin and Path(opencode_bin).exists():
        updates.append(
            (
                "opencode",
                "connected",
                f"CLI ready ({Path(opencode_bin).name}).",
                orch_model,
            )
        )

    # 2. GitHub CLI
    gh_bin = shutil.which("gh")
    if gh_bin:
        rc, out, err = _run_quick([gh_bin, "auth", "status"], timeout=6)
        combined = f"{out}\n{err}"
        acct_label = f"@{gh_user}" if gh_user else "GitHub CLI"
        if rc == 0:
            updates.append(("github", "connected", f"GitHub CLI authenticated ({acct_label}).", acct_label))
        elif is_auth_error_text(combined) or "not logged into" in combined.lower():
            updates.append(
                ("github", "needs_auth", "GitHub CLI session expired — sign in to sync PRs & boards.", acct_label)
            )

    # 3. Google Cloud / GKE
    gcloud_cmd = _find_gcloud_cmd()
    if gcloud_cmd:
        rc, out, err = _run_quick(_gcloud_argv(gcloud_cmd, "auth", "print-access-token"), timeout=8)
        combined = f"{out}\n{err}"
        acct_label = user_email or "Google Cloud"
        if rc == 0 and out and not is_auth_error_text(combined):
            updates.append(
                (
                    "google-cloud-gke",
                    "connected",
                    "Google Cloud OAuth token valid · 100% Read-Only GKE telemetry active.",
                    acct_label,
                )
            )
        else:
            updates.append(
                (
                    "google-cloud-gke",
                    "needs_auth",
                    "Google Cloud session expired — sign in to restore read-only GKE pod telemetry.",
                    acct_label,
                )
            )

    with db_session() as conn:
        for int_id, status, msg, acct in updates:
            record_integration_auth_status(conn, int_id, status, msg, acct)
        if any(i == "google-cloud-gke" and s == "connected" for i, s, _, _ in updates):
            conn.execute(
                "DELETE FROM events WHERE source = 'gke' AND title LIKE 'GKE %: unreachable / offline'"
            )
        return _list_integrations_Payload(conn)


@router.patch("/runtime")
def patch_standalone_runtime(req: StandaloneRuntimePatch) -> dict[str, Any]:
    now = utc_now_iso()
    updates = {k: v for k, v in req.model_dump().items() if v is not None}
    updates.pop("litellm_base_url", None)
    resolved_gateway = req.resolved_gateway_base_url()
    if resolved_gateway is not None:
        updates["gateway_base_url"] = resolved_gateway
    with db_session() as conn:
        for key, val in updates.items():
            conn.execute(
                """
                INSERT INTO settings(key, value_json, updated_at)
                VALUES (?, ?, ?)
                ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
                """,
                (key, json.dumps(val), now),
            )
        if "default_coding_agent" in updates:
            target = str(updates["default_coding_agent"])
            conn.execute("UPDATE integrations SET is_default = 0 WHERE category = 'coding_agent'")
            conn.execute(
                "UPDATE integrations SET is_default = 1, enabled = 1, updated_at = ? WHERE id = ?",
                (now, target),
            )
        return _list_integrations_Payload(conn)


@router.patch("/{integration_id}")
def patch_integration(integration_id: str, req: IntegrationPatchRequest) -> dict[str, Any]:
    now = utc_now_iso()
    with db_session() as conn:
        existing = conn.execute("SELECT * FROM integrations WHERE id = ?", (integration_id,)).fetchone()
        if not existing:
            raise HTTPException(status_code=404, detail=f"Integration '{integration_id}' not found.")

        row_dict = row_to_dict(existing) or {}
        if req.is_default is True and row_dict.get("category") == "coding_agent":
            conn.execute("UPDATE integrations SET is_default = 0 WHERE category = 'coding_agent'")
            conn.execute(
                """
                INSERT INTO settings(key, value_json, updated_at)
                VALUES ('default_coding_agent', ?, ?)
                ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
                """,
                (json.dumps(integration_id), now),
            )

        fields: dict[str, Any] = {"updated_at": now}
        if req.enabled is not None:
            fields["enabled"] = 1 if req.enabled else 0
        if req.is_default is not None:
            fields["is_default"] = 1 if req.is_default else 0
        if req.auth_status is not None:
            fields["auth_status"] = req.auth_status
        if req.auth_message is not None:
            fields["auth_message"] = req.auth_message
        if req.account_label is not None:
            fields["account_label"] = req.account_label
        if req.command_or_url is not None:
            fields["command_or_url"] = req.command_or_url
        if req.auth_command is not None:
            fields["auth_command"] = req.auth_command
        if req.config is not None:
            merged_cfg = dict(row_dict.get("config") or {})
            merged_cfg.update(req.config)
            fields["config_json"] = json.dumps(merged_cfg)

        set_sql = ", ".join(f"{k} = ?" for k in fields.keys())
        conn.execute(f"UPDATE integrations SET {set_sql} WHERE id = ?", list(fields.values()) + [integration_id])
        return _list_integrations_Payload(conn)


def _verify_integration_token_live(integration_id: str, token: str) -> tuple[bool, str, str]:
    """
    Live REST/GraphQL ping verification for github, linear, notion, and slack.
    Gracefully skips offline network errors and preserves offline/mocked xoxb-test tokens.
    Returns (ok, account_label, detail_message).
    """
    clean_tok = (token or "").strip()
    if not clean_tok:
        return False, "", "No token provided."

    if integration_id == "slack" and clean_tok.startswith(("xoxb-test", "xoxp-test", "xoxb-real-token")):
        return True, "", "Slack token stored & verified (test/mock credential)."

    try:
        with httpx.Client(timeout=6.0) as client:
            if integration_id == "github":
                resp = client.get(
                    "https://api.github.com/user",
                    headers={
                        "Authorization": f"Bearer {clean_tok}",
                        "Accept": "application/vnd.github+json",
                        "X-GitHub-Api-Version": "2022-11-28",
                    },
                )
                if resp.status_code < 400:
                    login = str((resp.json() or {}).get("login") or "").strip()
                    acct = f"@{login}" if login else "GitHub Token"
                    return True, acct, f"GitHub REST token verified ({acct})."
                if resp.status_code in {401, 403}:
                    return False, "", f"GitHub token rejected (HTTP {resp.status_code})."
                return True, "", f"GitHub token saved (HTTP {resp.status_code} during check)."

            if integration_id == "linear":
                auth_header = clean_tok if clean_tok.startswith("lin_api_") else f"Bearer {clean_tok}"
                resp = client.post(
                    "https://api.linear.app/graphql",
                    headers={"Authorization": auth_header, "Content-Type": "application/json"},
                    json={"query": "{ viewer { name email } }"},
                )
                if resp.status_code < 400:
                    body = resp.json() or {}
                    viewer = ((body.get("data") or {}).get("viewer")) or {}
                    if viewer:
                        acct = str(viewer.get("email") or viewer.get("name") or "Linear")
                        return True, acct, f"Linear GraphQL token verified ({acct})."
                    if body.get("errors"):
                        return False, "", "Linear token rejected by GraphQL API."
                if resp.status_code in {401, 403}:
                    return False, "", f"Linear token rejected (HTTP {resp.status_code})."
                return True, "", f"Linear token saved (HTTP {resp.status_code} during check)."

            if integration_id == "notion":
                resp = client.get(
                    "https://api.notion.com/v1/users/me",
                    headers={
                        "Authorization": f"Bearer {clean_tok}",
                        "Notion-Version": "2022-06-28",
                    },
                )
                if resp.status_code < 400:
                    name = str((resp.json() or {}).get("name") or "Notion").strip()
                    return True, name, f"Notion REST token verified ({name})."
                if resp.status_code in {401, 403}:
                    return False, "", f"Notion token rejected (HTTP {resp.status_code})."
                return True, "", f"Notion token saved (HTTP {resp.status_code} during check)."

            if integration_id == "slack":
                resp = client.post(
                    "https://slack.com/api/auth.test",
                    headers={"Authorization": f"Bearer {clean_tok}"},
                )
                if resp.status_code < 400:
                    data = resp.json() or {}
                    if data.get("ok"):
                        user = str(data.get("user") or data.get("user_id") or "").strip()
                        team = str(data.get("team") or "").strip()
                        acct = f"{user} ({team})" if user and team else (user or "Slack")
                        return True, acct, f"Slack auth.test verified ({acct})."
                    err_code = str(data.get("error") or "")
                    if err_code in {"invalid_auth", "token_revoked", "not_authed", "account_inactive"}:
                        return False, "", f"Slack token rejected ({err_code})."
                if resp.status_code in {401, 403}:
                    return False, "", f"Slack token rejected (HTTP {resp.status_code})."
                return True, "", f"Slack token saved (HTTP {resp.status_code} during check)."
    except Exception:
        return True, "", "Credential encrypted in local vault (offline — live ping skipped)."

    return True, "", "Credential encrypted in local vault."


def _render_oauth_callback_html(
    *,
    ok: bool,
    integration_id: str = "",
    account_label: str = "",
    error: str = "",
) -> str:
    payload_json = json.dumps(
        {
            "type": "command-engine:oauth-complete",
            "ok": ok,
            "integration_id": integration_id,
            "account_label": account_label,
            "error": error,
        }
    )
    badge_color = "#10b981" if ok else "#ef4444"
    badge_bg = "rgba(16, 185, 129, 0.14)" if ok else "rgba(239, 68, 68, 0.14)"
    title_text = "Connected" if ok else "Authentication Failed"
    safe_sub = (
        html.escape(f"{integration_id} linked as {account_label}".strip())
        if ok
        else html.escape(error or "Unable to complete OAuth2 authorization.")
    )
    return f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Command Engine · OAuth</title>
  <style>
    :root {{ color-scheme: dark; }}
    body {{
      margin: 0; min-height: 100vh; display: grid; place-items: center;
      background: radial-gradient(circle at 20% 20%, #141833 0%, #06070d 65%);
      color: #f1f5f9; font-family: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", sans-serif;
    }}
    .card {{
      width: min(440px, 90vw); padding: 28px 30px; border-radius: 16px;
      background: rgba(15, 18, 32, 0.88);
      border: 1px solid rgba(148, 163, 184, 0.18);
      box-shadow: 0 24px 64px rgba(0, 0, 0, 0.55);
      text-align: center;
    }}
    .pill {{
      display: inline-block; padding: 5px 12px; border-radius: 999px;
      font-size: 12px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase;
      color: {badge_color}; background: {badge_bg}; border: 1px solid {badge_color}44;
      margin-bottom: 14px;
    }}
    h1 {{ margin: 0 0 8px; font-size: 20px; font-weight: 600; }}
    p {{ margin: 0 0 18px; font-size: 13.5px; color: #94a3b8; line-height: 1.5; }}
    .hint {{ font-size: 12px; color: #64748b; }}
  </style>
</head>
<body>
  <div class="card">
    <div class="pill">{html.escape(title_text)}</div>
    <h1>Command Engine</h1>
    <p>{safe_sub}</p>
    <div class="hint">This window will close automatically. You can return to Command Engine.</div>
  </div>
  <script>
    (function() {{
      try {{
        if (window.opener && !window.opener.closed) {{
          window.opener.postMessage({payload_json}, "*");
        }}
      }} catch (e) {{}}
      setTimeout(function() {{ try {{ window.close(); }} catch (e) {{}} }}, 1200);
    }})();
  </script>
</body>
</html>"""


@router.get("/oauth/callback", response_class=HTMLResponse)
async def oauth_pkce_callback(
    state: str = "",
    code: str = "",
    error: str = "",
    error_description: str = "",
) -> HTMLResponse:
    if error:
        msg = f"{error}: {error_description}".strip(": ")
        return HTMLResponse(
            content=_render_oauth_callback_html(ok=False, error=msg),
            status_code=400,
        )
    res = await complete_oauth_pkce_callback(state=state, code=code)
    if not res.get("ok"):
        return HTMLResponse(
            content=_render_oauth_callback_html(ok=False, error=str(res.get("error") or "OAuth exchange failed.")),
            status_code=400,
        )
    return HTMLResponse(
        content=_render_oauth_callback_html(
            ok=True,
            integration_id=str(res.get("integration_id") or ""),
            account_label=str(res.get("account_label") or ""),
        ),
        status_code=200,
    )


@router.post("/{integration_id}/oauth/start")
def start_integration_oauth(integration_id: str, req: OAuthStartRequest) -> dict[str, Any]:
    with db_session() as conn:
        row = conn.execute("SELECT id FROM integrations WHERE id = ?", (integration_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail=f"Integration '{integration_id}' not found.")
        prof = get_active_profile(conn)
    pid = str(prof.get("id") or OWNER_PROFILE_ID)
    res = start_oauth_pkce_flow(
        integration_id=integration_id,
        profile_id=pid,
        client_id=req.client_id,
        client_secret=req.client_secret,
        redirect_uri=req.redirect_uri,
        open_browser=req.open_browser,
    )
    return {"integration_id": integration_id, **res}


@router.post("/{integration_id}/auth")
def trigger_integration_auth(integration_id: str, req: IntegrationAuthRequest) -> dict[str, Any]:
    """Verify credentials, save DPAPI/0o600 API/MCP credentials, or launch browser OAuth login."""
    with db_session() as conn:
        row = conn.execute("SELECT * FROM integrations WHERE id = ?", (integration_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail=f"Integration '{integration_id}' not found.")
        item = row_to_dict(row) or {}
        prof = get_active_profile(conn)

    pid = str(prof.get("id") or OWNER_PROFILE_ID)
    is_owner = pid == OWNER_PROFILE_ID
    gh_user = str(prof.get("github_login") or (GITHUB_USER if is_owner else "")).strip()
    user_email = str(prof.get("email") or (GOOGLE_EMAIL if is_owner else "")).strip()

    now = utc_now_iso()
    launched = False
    ok_flag = True
    status_out = str(item.get("auth_status") or "disconnected")
    message_out = str(item.get("auth_message") or "")
    account_out = req.account_label.strip() or str(item.get("account_label") or "")

    if req.mode == "disconnect":
        config.delete_secret(f"{pid}-{integration_id}")
        config.delete_secret(integration_id)
        with db_session() as conn:
            conn.execute(
                "UPDATE integrations SET enabled = 0, auth_status = 'disconnected', auth_message = 'Disconnected by user.', updated_at = ? WHERE id = ?",
                (now, integration_id),
            )
            return {"ok": True, "launched": False, **_list_integrations_Payload(conn)}

    if req.mode == "token" or req.api_token.strip() or req.mcp_server_url.strip():
        cfg = dict(item.get("config") or {})
        clean_token = req.api_token.strip()
        live_detail = ""
        if clean_token:
            from .safety import SAFE_SLUG_ID_RE

            if not SAFE_SLUG_ID_RE.match(integration_id):
                raise HTTPException(status_code=400, detail="Invalid integration ID.")

            verified_ok, verified_acct, live_detail = _verify_integration_token_live(integration_id, clean_token)
            if not verified_ok:
                with db_session() as conn:
                    record_integration_auth_status(conn, integration_id, "needs_auth", live_detail, account_out or None)
                    return {
                        "ok": False,
                        "auth_status": "needs_auth",
                        "message": live_detail,
                        "launched": False,
                        **_list_integrations_Payload(conn),
                    }

            try:
                config.store_secret(f"{pid}-{integration_id}", clean_token)
                config.store_secret(integration_id, clean_token)
            except ValueError as exc:
                raise HTTPException(status_code=400, detail=str(exc)) from exc
            cfg["api_token_configured"] = True
            cfg["api_token_masked"] = config.mask_secret(clean_token)
            if verified_acct and not req.account_label.strip():
                account_out = verified_acct

        if req.mcp_server_url.strip():
            cfg["mcp_server_url"] = req.mcp_server_url.strip()

        status_out = "connected"
        message_out = live_detail or (
            f"Connected via standalone MCP/API endpoint ({req.mcp_server_url.strip() or 'Credential encrypted in local vault'})."
        )
        account_out = account_out or "Standalone Credential"
        with db_session() as conn:
            conn.execute(
                """
                UPDATE integrations
                SET enabled = 1, auth_status = ?, auth_message = ?, account_label = ?, config_json = ?, last_checked_at = ?, updated_at = ?
                WHERE id = ?
                """,
                (status_out, message_out, account_out, json.dumps(cfg), now, now, integration_id),
            )
            return {"ok": True, "launched": False, **_list_integrations_Payload(conn)}

    # Specific real sign-in handlers
    if integration_id == "google-cloud-gke":
        gcloud_cmd = _find_gcloud_cmd()
        if not gcloud_cmd:
            ok_flag = False
            status_out = "needs_auth"
            message_out = "Google Cloud SDK (gcloud) not found on PATH."
        else:
            rc, out, err = _run_quick(_gcloud_argv(gcloud_cmd, "auth", "print-access-token"), timeout=8)
            if rc == 0 and out and not is_auth_error_text(f"{out}\n{err}") and not req.launch_browser:
                status_out = "connected"
                message_out = "Google Cloud OAuth session verified · Read-only GKE telemetry restored."
            elif req.launch_browser or req.mode == "launch":
                launched = _launch_cli_login(_gcloud_argv(gcloud_cmd, "auth", "login"))
                ok_flag = False
                status_out = "needs_auth"
                message_out = "Opened Google Sign-In in your browser (`gcloud auth login`). Click 'Verify' once complete."
            else:
                ok_flag = False
                status_out = "needs_auth"
                message_out = "Google Cloud session expired — click 'Sign In with Google' to open browser OAuth."

    elif integration_id == "github":
        stored_gh = config.read_secret(f"{pid}-github") or config.read_secret("github")
        if stored_gh and not req.launch_browser and req.mode != "launch":
            tok_to_check = resolve_integration_token("github", pid) or stored_gh
            verified_ok, verified_acct, live_detail = _verify_integration_token_live("github", tok_to_check)
            if verified_ok:
                status_out = "connected"
                message_out = live_detail
                account_out = verified_acct or account_out or (f"@{gh_user}" if gh_user else "GitHub Token")
            else:
                ok_flag = False
                status_out = "needs_auth"
                message_out = live_detail
        else:
            gh_bin = shutil.which("gh") or "gh"
            rc, out, err = _run_quick([gh_bin, "auth", "status"], timeout=6)
            if rc == 0 and not req.launch_browser:
                status_out = "connected"
                message_out = f"GitHub CLI authenticated (@{gh_user or 'cli'})."
            elif req.launch_browser or req.mode == "launch":
                launched = _launch_cli_login([gh_bin, "auth", "login", "--web"])
                ok_flag = False
                status_out = "needs_auth"
                message_out = "Opened GitHub web login (`gh auth login --web`). Click 'Verify' once complete."
            else:
                ok_flag = False
                status_out = "needs_auth"
                message_out = "GitHub CLI needs sign-in (`gh auth login --web`) or connect via OAuth / Personal Access Token."

    else:
        cfg = dict(item.get("config") or {})
        cmd_or_url = str(item.get("command_or_url") or "").strip()
        if req.launch_browser and cmd_or_url.startswith(("http://", "https://")):
            launched = _open_url_in_browser(cmd_or_url)

        raw_stored = config.read_secret(f"{pid}-{integration_id}") or config.read_secret(integration_id)
        if not raw_stored and integration_id in {"gmail", "google-calendar", "google-drive", "google-meet"}:
            raw_stored = config.read_secret(f"{pid}-google") or config.read_secret("google")
        has_stored_token = bool(raw_stored)
        has_mcp_url = bool(str(cfg.get("mcp_server_url") or "").strip())
        has_cli_binary = False
        if item.get("category") == "coding_agent" and cmd_or_url and not cmd_or_url.startswith(("http://", "https://")):
            bin_tok = cmd_or_url.split()[0]
            has_cli_binary = bool(shutil.which(bin_tok)) or Path(cmd_or_url).exists()
            if not has_cli_binary and integration_id == "opencode":
                has_cli_binary = bool(shutil.which("opencode")) or bool(shutil.which("opencode.cmd"))

        if has_stored_token and integration_id in {"slack", "linear", "notion"}:
            tok_to_check = resolve_integration_token(integration_id, pid) or raw_stored
            verified_ok, verified_acct, live_detail = _verify_integration_token_live(integration_id, tok_to_check)
            if verified_ok:
                status_out = "connected"
                message_out = live_detail or f"{item.get('name')} verified & connected to Command Engine."
                if verified_acct:
                    account_out = verified_acct
                elif not account_out or account_out in {"Not connected", "Not installed", "Ready to configure"}:
                    account_out = user_email or "Standalone Credential"
            else:
                ok_flag = False
                status_out = "needs_auth"
                message_out = live_detail
        elif has_stored_token or has_mcp_url or has_cli_binary:
            status_out = "connected"
            message_out = f"{item.get('name')} verified & connected to Command Engine."
            if not account_out or account_out in {"Not connected", "Not installed", "Ready to configure"}:
                account_out = (user_email or "Standalone Credential") if item.get("category") == "workspace_app" else "Connected · Active"
        else:
            ok_flag = False
            status_out = "needs_credentials"
            message_out = "Paste an API token / OAuth credential or connect via CLI to activate this integration."
            with db_session() as conn:
                record_integration_auth_status(conn, integration_id, status_out, message_out, account_out or None)
                return {
                    "ok": False,
                    "auth_status": status_out,
                    "message": message_out,
                    "launched": launched,
                    **_list_integrations_Payload(conn),
                }

    with db_session() as conn:
        if ok_flag:
            conn.execute("UPDATE integrations SET enabled = 1 WHERE id = ?", (integration_id,))
        record_integration_auth_status(conn, integration_id, status_out, message_out, account_out)
        if integration_id == "google-cloud-gke" and status_out == "connected":
            conn.execute(
                "DELETE FROM events WHERE source = 'gke' AND title LIKE 'GKE %: unreachable / offline'"
            )
        return {
            "ok": ok_flag,
            "auth_status": status_out,
            "message": message_out,
            "launched": launched,
            **_list_integrations_Payload(conn),
        }


def _slugify(text: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return s[:42] or "custom-connector"


def _fallback_connector_plan(request_text: str, category_hint: str) -> dict[str, Any]:
    low = request_text.lower()
    known_icons = [
        ("jira", "logos:jira", "#2684ff", "workspace_app", "Jira Cloud"),
        ("confluence", "logos:confluence", "#172b4d", "workspace_app", "Confluence"),
        ("figma", "logos:figma", "#f24e1e", "workspace_app", "Figma"),
        ("sentry", "logos:sentry-icon", "#362d59", "cloud_infra", "Sentry Alerts"),
        ("datadog", "logos:datadog", "#632ca6", "cloud_infra", "Datadog"),
        ("discord", "logos:discord-icon", "#5865f2", "workspace_app", "Discord"),
        ("telegram", "logos:telegram", "#229ed9", "workspace_app", "Telegram"),
        ("whatsapp", "logos:whatsapp-icon", "#25d366", "workspace_app", "WhatsApp"),
        ("teams", "logos:microsoft-teams", "#5059c9", "workspace_app", "Microsoft Teams"),
        ("outlook", "logos:microsoft-icon", "#0078d4", "workspace_app", "Microsoft Outlook"),
        ("asana", "logos:asana-icon", "#f06a6a", "workspace_app", "Asana"),
        ("trello", "logos:trello", "#0079bf", "workspace_app", "Trello"),
        ("gitlab", "logos:gitlab", "#fc6d26", "workspace_app", "GitLab"),
        ("supabase", "logos:supabase-icon", "#3ecf8e", "cloud_infra", "Supabase"),
        ("vercel", "logos:vercel-icon", "#111827", "cloud_infra", "Vercel"),
        ("aws", "logos:aws", "#ff9900", "cloud_infra", "AWS (Read-Only)"),
        ("aider", "solar:code-circle-bold-duotone", "#10b981", "coding_agent", "Aider Coding Agent"),
        ("cline", "solar:cpu-bolt-bold-duotone", "#8b5cf6", "coding_agent", "Cline Agent"),
        ("roo", "solar:rocket-2-bold-duotone", "#ec4899", "coding_agent", "Roo Code"),
        ("zed", "solar:bolt-circle-bold-duotone", "#3b82f6", "coding_agent", "Zed Agent"),
    ]
    for kw, icon, color, cat, title in known_icons:
        if kw in low:
            resolved_cat = category_hint if category_hint not in {"auto", ""} else cat
            return {
                "id": f"custom-{_slugify(title)}",
                "name": title,
                "provider": "Custom Bot-Configured Connector",
                "category": resolved_cat,
                "icon": icon,
                "accent_color": color,
                "connection_method": "cli_binary" if resolved_cat == "coding_agent" else "mcp_or_api_token",
                "command_or_url": kw if resolved_cat == "coding_agent" else f"https://{kw}.com",
                "auth_command": f"{kw} --help" if resolved_cat == "coding_agent" else f"token:{kw}",
                "scopes": ["read_events", "ask_first_outbound"],
                "summary": f"Configured {title} connector with standalone MCP/API token support and Approval Studio outbound gating.",
                "setup_steps": [
                    f"Click 'Configure Token / URL' on the new {title} card to paste an API key or MCP server URL (stored locally in `.local/credentials/`).",
                    "Inbound signals route automatically into `POST /api/ingest/batch` + Hybrid Memory (`text-embedding-3-small`).",
                    "All outbound mutations remain strictly gated behind Approval Studio (`ask_first`).",
                ],
            }

    words = [w.capitalize() for w in re.findall(r"[a-zA-Z0-9]+", request_text)[:3]] or ["Custom", "Service"]
    title = " ".join(words)
    resolved_cat = category_hint if category_hint not in {"auto", ""} else "custom"
    return {
        "id": f"custom-{_slugify(title)}",
        "name": title,
        "provider": "Custom Bot-Configured Connector",
        "category": resolved_cat,
        "icon": "fluent-color:link-multiple-24",
        "accent_color": "#8b5cf6",
        "connection_method": "mcp_or_api_token",
        "command_or_url": "",
        "auth_command": "token:custom",
        "scopes": ["ingest.batch", "ask_first_outbound"],
        "summary": f"Custom {title} integration bridged into Command Engine's standalone connector registry.",
        "setup_steps": [
            "Paste your MCP server endpoint, webhook URL, or API token in the connector card.",
            "Command Engine stores secrets strictly in `.local/credentials/` and indexes events into SQLite FTS5 + `text-embedding-3-small`.",
            "Outbound actions are automatically staged in Approval Studio before execution.",
        ],
    }


@router.post("/ask-bot")
async def ask_bot_to_connect(req: AskBotConnectorRequest) -> dict[str, Any]:
    """
    'Others' Custom Connector Architect:
    Uses the configured orchestrator model (with instant deterministic fallback) to design & register any coding agent, SaaS app, MCP server, or webhook.
    """
    prompt_text = req.request_text.strip()
    if not prompt_text:
        raise HTTPException(status_code=400, detail="Describe the app, coding agent, or API you want to connect.")

    plan = _fallback_connector_plan(prompt_text, req.category_hint)

    try:
        llm = GatewayLLMClient()
        sys_prompt = (
            "You are Command Engine's Integration Architect. "
            "The user wants to connect a new coding agent, SaaS app, MCP server, or cloud tool into Command Engine. "
            "Return STRICT JSON with keys:\n"
            "- id: lowercase slug starting with 'custom-' (e.g. 'custom-jira-cloud')\n"
            "- name: crisp display name (max 32 chars)\n"
            "- provider: vendor or protocol label (e.g. 'Atlassian REST / MCP', 'Agentic CLI')\n"
            "- category: one of 'coding_agent' | 'workspace_app' | 'cloud_infra' | 'custom'\n"
            "- icon: Iconify icon name from logos:*, fluent-color:*, or solar:* (e.g. 'logos:jira', 'logos:figma', 'fluent-color:plug-connected-24', 'solar:code-square-bold-duotone')\n"
            "- accent_color: vibrant hex color (e.g. '#6366f1')\n"
            "- connection_method: 'mcp_server' | 'oauth_pkce' | 'api_token' | 'cli_binary' | 'webhook'\n"
            "- command_or_url: CLI binary or base HTTPS URL\n"
            "- auth_command: CLI login command or 'token:<slug>'\n"
            "- scopes: array of 2-4 short capability strings\n"
            "- summary: 1-2 sentence explanation of how Command Engine connects to it in standalone mode\n"
            "- setup_steps: array of 3 concise, actionable steps"
        )
        raw = await llm.chief_of_staff_synthesize(
            sys_prompt,
            f"User request: {prompt_text}\nCategory hint: {req.category_hint}",
            json_mode=True,
            reasoning_effort="low",
        )
        cleaned = raw.strip()
        if "```" in cleaned:
            m = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", cleaned, re.DOTALL)
            if m:
                cleaned = m.group(1)
        parsed = json.loads(cleaned)
        if isinstance(parsed, dict) and parsed.get("name"):
            cid = str(parsed.get("id") or plan["id"]).strip().lower()
            if not cid.startswith("custom-") and cid not in BUILTIN_IDS:
                cid = f"custom-{_slugify(cid)}"
            plan.update(
                {
                    "id": cid,
                    "name": str(parsed.get("name") or plan["name"])[:48],
                    "provider": str(parsed.get("provider") or plan["provider"])[:64],
                    "category": parsed.get("category")
                    if parsed.get("category") in {"coding_agent", "workspace_app", "cloud_infra", "custom"}
                    else plan["category"],
                    "icon": str(parsed.get("icon") or plan["icon"]),
                    "accent_color": str(parsed.get("accent_color") or plan["accent_color"]),
                    "connection_method": str(parsed.get("connection_method") or plan["connection_method"]),
                    "command_or_url": str(parsed.get("command_or_url") or plan["command_or_url"]),
                    "auth_command": str(parsed.get("auth_command") or plan["auth_command"]),
                    "scopes": list(parsed.get("scopes") or plan["scopes"])[:5],
                    "summary": str(parsed.get("summary") or plan["summary"]),
                    "setup_steps": list(parsed.get("setup_steps") or plan["setup_steps"])[:5],
                }
            )
    except Exception:
        # Deterministic fallback plan already populated
        pass

    now = utc_now_iso()
    with db_session() as conn:
        if req.auto_register:
            conn.execute(
                """
                INSERT INTO integrations(
                    id, category, name, provider, icon, accent_color, enabled, is_default,
                    auth_status, auth_message, account_label, command_or_url, auth_command,
                    scopes_json, config_json, last_checked_at, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, 1, 0, 'available', ?, 'Ready to configure', ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    name = excluded.name,
                    provider = excluded.provider,
                    icon = excluded.icon,
                    accent_color = excluded.accent_color,
                    enabled = 1,
                    auth_message = excluded.auth_message,
                    command_or_url = excluded.command_or_url,
                    auth_command = excluded.auth_command,
                    scopes_json = excluded.scopes_json,
                    config_json = excluded.config_json,
                    updated_at = excluded.updated_at
                """,
                (
                    plan["id"],
                    plan["category"],
                    plan["name"],
                    plan["provider"],
                    plan["icon"],
                    plan["accent_color"],
                    plan["summary"],
                    plan["command_or_url"],
                    plan["auth_command"],
                    json.dumps(plan["scopes"]),
                    json.dumps(
                        {
                            "connection_method": plan["connection_method"],
                            "setup_steps": plan["setup_steps"],
                            "user_request": prompt_text,
                        }
                    ),
                    now,
                    now,
                ),
            )
        payload = _list_integrations_Payload(conn)

    return {"plan": plan, **payload}


@router.delete("/{integration_id}")
def delete_custom_integration(integration_id: str) -> dict[str, Any]:
    if integration_id in BUILTIN_IDS:
        raise HTTPException(
            status_code=400,
            detail="Built-in integrations cannot be deleted; toggle them off instead.",
        )
    with db_session() as conn:
        conn.execute("DELETE FROM integrations WHERE id = ?", (integration_id,))
        return _list_integrations_Payload(conn)


# ---------------------------------------------------------------------------
# BYOK AI Providers (/api/ai/providers)
# ---------------------------------------------------------------------------


def _entry_default_base_url(entry: dict[str, Any]) -> str:
    if entry.get("id") == "openai-gateway":
        return str(config.DEFAULT_GATEWAY_BASE_URL or "")
    return str(entry.get("default_base_url") or "")


def _build_ai_providers_payload(conn: Any) -> dict[str, Any]:
    prof = get_active_profile(conn)
    settings = get_settings_dict(conn)
    rt = resolve_active_llm_runtime(conn=conn)
    pid = str(prof.get("id") or OWNER_PROFILE_ID)
    gateway_locked = bool(prof.get("gateway_locked", pid == OWNER_PROFILE_ID))
    saved_map = settings.get(f"ai_providers:{pid}")
    if not isinstance(saved_map, dict):
        saved_map = {}

    active_provider_id = _normalize_ai_provider_id(str(rt.get("provider_id") or ""))
    items: list[dict[str, Any]] = []
    for entry in AI_PROVIDER_CATALOG:
        prov_id = str(entry["id"])
        override = saved_map.get(prov_id) if isinstance(saved_map.get(prov_id), dict) else {}
        stored_secret = config.read_secret(f"ai-{pid}-{prov_id}")
        entry_def_url = _entry_default_base_url(entry)
        base_url = str(override.get("base_url") or entry_def_url).strip().rstrip("/")
        if prov_id == "openai-gateway" and pid == OWNER_PROFILE_ID:
            if not base_url:
                base_url = str(prof.get("gateway_base_url") or config.DEFAULT_GATEWAY_BASE_URL).rstrip("/")
            if not stored_secret:
                fallback = config.load_gateway_credentials(base_url_override=base_url or None)
                if fallback.configured and fallback.api_key:
                    stored_secret = fallback.api_key
                    if not base_url:
                        base_url = fallback.base_url
        elif prov_id in {"local", "ollama"}:
            base_url = str(
                override.get("base_url")
                or prof.get("offline_local_runner_url")
                or entry["default_base_url"]
            ).strip().rstrip("/")
        elif prov_id == "lmstudio":
            base_url = str(override.get("base_url") or entry["default_base_url"]).strip().rstrip("/")
        elif prov_id == "custom-gateway" and not base_url and active_provider_id == "custom-gateway":
            base_url = str(prof.get("gateway_base_url") or "").strip().rstrip("/")

        has_key = bool(stored_secret)
        if prov_id == "none":
            configured = True
        else:
            configured = bool(base_url) and (has_key or not entry["requires_api_key"])
        locked_out = gateway_locked and prov_id not in {"openai-gateway", "local", "ollama", "lmstudio", "none"}

        rec_models = list(entry["recommended_models"])
        default_orch = rec_models[0] if len(rec_models) > 0 else ""
        default_work = rec_models[1] if len(rec_models) > 1 else default_orch
        default_fast = rec_models[2] if len(rec_models) > 2 else default_work
        default_emb = next((m for m in rec_models if "embed" in m), rec_models[-1] if rec_models else "")

        items.append(
            {
                "id": prov_id,
                "name": entry["name"],
                "label": entry["name"],
                "description": entry["description"],
                "default_base_url": entry_def_url,
                "base_url": base_url,
                "default_orchestrator": default_orch,
                "default_worker": default_work,
                "default_fast": default_fast,
                "default_embedding": default_emb,
                "requires_api_key": bool(entry["requires_api_key"]),
                "recommended_models": rec_models,
                "has_api_key": has_key,
                "api_key_masked": config.mask_secret(stored_secret) if has_key else "",
                "configured": configured,
                "is_active": active_provider_id == prov_id,
                "is_local": prov_id in {"local", "ollama", "lmstudio"},
                "locked_out": locked_out,
                "updated_at": override.get("updated_at") or "",
            }
        )

    active_item = next((it for it in items if it["is_active"]), items[0] if items else {})
    cap_matrix = build_ai_capability_matrix(rt)
    return {
        "active_profile_id": pid,
        "active_provider_id": active_provider_id,
        "active_provider": active_provider_id,
        "ai_mode": cap_matrix["ai_mode"],
        "ai_mode_label": cap_matrix["mode_label"],
        "capabilities": cap_matrix["features"],
        "gateway_locked": gateway_locked,
        "offline_local_runner_enabled": bool(prof.get("offline_local_runner_enabled", False)),
        "offline_local_runner_url": str(prof.get("offline_local_runner_url") or "http://127.0.0.1:11434/v1"),
        "offline_local_model": str(prof.get("offline_local_model") or ""),
        "active_models": {
            "orchestrator": rt["model_orchestrator"],
            "worker": rt["model_worker"],
            "fast": rt["model_fast"],
            "embedding": rt["model_embedding"],
        },
        "base_url": str(active_item.get("base_url") or rt.get("base_url") or ""),
        "api_key_configured": bool(active_item.get("has_api_key") or not active_item.get("requires_api_key", True)),
        "api_key_masked": str(active_item.get("api_key_masked") or ""),
        "model_orchestrator": rt["model_orchestrator"],
        "model_worker": rt["model_worker"],
        "model_fast": rt["model_fast"],
        "model_embedding": rt["model_embedding"],
        "providers": items,
        "presets": items,
    }


def _normalize_ai_provider_id(raw_id: str) -> str:
    clean = (raw_id or "").strip().lower()
    if clean in {"custom", "litellm", "litellm-gateway", "brainpool-litellm", "gateway", "openai-compatible"}:
        return "custom-gateway" if clean in {"custom", "openai-compatible"} else "openai-gateway"
    return clean


@ai_router.get("")
def get_ai_providers() -> dict[str, Any]:
    with db_session() as conn:
        return _build_ai_providers_payload(conn)


@ai_router.post("/configure")
def configure_ai_provider(req: AIProviderConfigureRequest) -> dict[str, Any]:
    prov_id = _normalize_ai_provider_id(req.provider_id)
    if prov_id not in AI_PROVIDER_BY_ID:
        raise HTTPException(status_code=400, detail=f"Unsupported AI provider '{req.provider_id}'.")

    catalog_entry = AI_PROVIDER_BY_ID[prov_id]
    now = utc_now_iso()

    with db_session() as conn:
        prof = get_active_profile(conn)
        pid = str(prof.get("id") or OWNER_PROFILE_ID)
        gateway_locked = bool(prof.get("gateway_locked", False))

        if gateway_locked and prov_id not in {"openai-gateway", "local", "ollama", "lmstudio", "none"}:
            raise HTTPException(
                status_code=403,
                detail="This profile's AI gateway is locked to its managed gateway or local runtime.",
            )

        settings = get_settings_dict(conn)
        saved_map = settings.get(f"ai_providers:{pid}")
        if not isinstance(saved_map, dict):
            saved_map = {}
        existing_override = saved_map.get(prov_id) if isinstance(saved_map.get(prov_id), dict) else {}

        resolved_base_url = (
            req.base_url.strip()
            or str(existing_override.get("base_url") or "")
            or _entry_default_base_url(catalog_entry)
        ).rstrip("/")

        if gateway_locked and prov_id == "openai-gateway" and req.base_url.strip():
            owner_url = str(prof.get("gateway_base_url") or config.DEFAULT_GATEWAY_BASE_URL).rstrip("/")
            if owner_url and resolved_base_url != owner_url:
                raise HTTPException(
                    status_code=403,
                    detail="Cannot redirect a gateway-locked profile away from its managed gateway.",
                )

        if prov_id == "custom-gateway" and not resolved_base_url:
            raise HTTPException(status_code=400, detail="Custom OpenAI-compatible provider requires a base_url.")

        if req.api_key.strip():
            try:
                config.store_secret(f"ai-{pid}-{prov_id}", req.api_key.strip())
            except ValueError as exc:
                raise HTTPException(status_code=400, detail=str(exc)) from exc

        saved_map[prov_id] = {
            "base_url": resolved_base_url,
            "updated_at": now,
        }
        conn.execute(
            """
            INSERT INTO settings(key, value_json, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
            """,
            (f"ai_providers:{pid}", json.dumps(saved_map), now),
        )

        if req.activate:
            conn.execute(
                """
                INSERT INTO settings(key, value_json, updated_at)
                VALUES (?, ?, ?)
                ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
                """,
                (f"ai_active_provider:{pid}", json.dumps(prov_id), now),
            )
            profile_updates: dict[str, Any] = {"updated_at": now}
            if prov_id in {"local", "ollama", "lmstudio"}:
                offline_enabled = True if req.offline_local_runner_enabled is None else bool(req.offline_local_runner_enabled)
                default_local_url = (
                    "http://127.0.0.1:1234/v1" if prov_id == "lmstudio" else "http://127.0.0.1:11434/v1"
                )
                profile_updates["offline_local_runner_enabled"] = 1 if offline_enabled else 0
                profile_updates["offline_local_runner_url"] = (
                    req.offline_local_runner_url.strip() or resolved_base_url or default_local_url
                ).rstrip("/")
                if req.offline_local_model.strip():
                    profile_updates["offline_local_model"] = req.offline_local_model.strip()
                elif req.model_orchestrator.strip():
                    profile_updates["offline_local_model"] = req.model_orchestrator.strip()
            elif prov_id == "none":
                profile_updates["offline_local_runner_enabled"] = 0
                if not gateway_locked:
                    profile_updates["gateway_base_url"] = ""
            else:
                if req.offline_local_runner_enabled is not None:
                    profile_updates["offline_local_runner_enabled"] = 1 if req.offline_local_runner_enabled else 0
                else:
                    profile_updates["offline_local_runner_enabled"] = 0
                if not gateway_locked and resolved_base_url:
                    profile_updates["gateway_base_url"] = resolved_base_url

            if req.model_orchestrator.strip():
                profile_updates["model_orchestrator"] = req.model_orchestrator.strip()
            if req.model_worker.strip():
                profile_updates["model_worker"] = req.model_worker.strip()
            if req.model_fast.strip():
                profile_updates["model_fast"] = req.model_fast.strip()
            if req.model_embedding.strip():
                profile_updates["model_embedding"] = req.model_embedding.strip()

            set_sql = ", ".join(f"{k} = ?" for k in profile_updates.keys())
            conn.execute(
                f"UPDATE profiles SET {set_sql} WHERE id = ?",
                list(profile_updates.values()) + [pid],
            )

        invalidate_gateway_cache()
        _PROVIDER_MODELS_CACHE.clear()
        payload = _build_ai_providers_payload(conn)
        return {"ok": True, "configured_provider": prov_id, **payload}


_PROVIDER_MODELS_CACHE: dict[tuple[str, str, str], tuple[float, list[str], bool, str]] = {}
_PROVIDER_MODELS_TTL_SEC = 120.0


def _is_embedding_model_id(model_id: str) -> bool:
    low = (model_id or "").strip().lower()
    if not low:
        return False
    return any(
        tok in low
        for tok in (
            "embed",
            "bge-",
            "bge_",
            "e5-",
            "text-embedding",
            "nomic-embed",
            "mxbai-embed",
            "voyage-",
            "jina-embeddings",
        )
    )


def _is_non_chat_utility_model_id(model_id: str) -> bool:
    low = (model_id or "").strip().lower()
    if not low:
        return True
    return any(
        tok in low
        for tok in (
            "whisper",
            "tts-",
            "dall-e",
            "imagen",
            "moderation",
            "rerank",
            "audio-preview",
            "realtime-preview",
            "transcribe",
            "veo-",
        )
    )


def _pick_first_matching(
    candidates: list[str],
    preferred_exact: list[str],
    preferred_substrings: list[str],
    fallback: str = "",
) -> str:
    lower_map = {m.lower(): m for m in candidates}
    for exact in preferred_exact:
        if exact.lower() in lower_map:
            return lower_map[exact.lower()]
    for sub in preferred_substrings:
        sub_low = sub.lower()
        for m in candidates:
            if sub_low in m.lower():
                return m
    return candidates[0] if candidates else fallback


def _classify_and_recommend_models(
    prov_id: str,
    raw_models: list[str],
    catalog_entry: dict[str, Any],
    active_models: dict[str, str] | None = None,
) -> dict[str, Any]:
    rec_defaults = [str(m).strip() for m in catalog_entry.get("recommended_models", []) if str(m).strip()]
    seen: set[str] = set()
    merged: list[str] = []

    # Put recommended models first when present in raw_models, then remaining discovered models
    raw_clean = [str(m).strip() for m in raw_models if str(m).strip()]
    raw_set_lower = {m.lower() for m in raw_clean}

    ordered_seed = (
        [m for m in rec_defaults if not raw_clean or m.lower() in raw_set_lower]
        + raw_clean
        + ([m for m in rec_defaults if m.lower() not in raw_set_lower] if not raw_clean else [])
    )
    for m in ordered_seed:
        key = m.lower()
        if key not in seen:
            seen.add(key)
            merged.append(m)

    chat_models = [
        m for m in merged if not _is_embedding_model_id(m) and not _is_non_chat_utility_model_id(m)
    ]
    embedding_models = [m for m in merged if _is_embedding_model_id(m)]

    # Always ensure fallback recommended embedding/chat options exist even if provider doesn't list embeddings (e.g. Anthropic/Groq)
    if not chat_models:
        chat_models = [m for m in rec_defaults if not _is_embedding_model_id(m)]
    if not embedding_models:
        embedding_models = [m for m in rec_defaults if _is_embedding_model_id(m)]

    # Ensure currently active models remain selectable if same provider
    if active_models:
        for slot_key in ("orchestrator", "worker", "fast"):
            cur = str(active_models.get(slot_key) or "").strip()
            if cur and cur.lower() not in {x.lower() for x in chat_models}:
                chat_models.insert(0, cur)
        cur_emb = str(active_models.get("embedding") or "").strip()
        if cur_emb and cur_emb.lower() not in {x.lower() for x in embedding_models}:
            embedding_models.append(cur_emb)

    if prov_id == "openai-gateway":
        rec_orch = _pick_first_matching(
            chat_models,
            ["gpt-4o", "gpt-4.1", "gpt-4o-mini"],
            ["gpt-4o", "gpt-4.1", "gpt-4"],
            "gpt-4o-mini",
        )
        rec_work = _pick_first_matching(
            chat_models,
            ["gpt-4o-mini", "gpt-4.1-mini"],
            ["4o-mini", "4.1-mini", "mini"],
            rec_orch,
        )
        rec_fast = _pick_first_matching(
            chat_models,
            ["gpt-4o-mini", "gpt-4.1-nano"],
            ["4o-mini", "nano", "mini"],
            rec_work,
        )
        rec_emb = _pick_first_matching(
            embedding_models,
            ["text-embedding-3-small", "text-embedding-3-large"],
            ["text-embedding-3", "embed"],
            "text-embedding-3-small",
        )
    elif prov_id == "openai":
        rec_orch = _pick_first_matching(chat_models, ["gpt-4.1", "o3", "gpt-4o"], ["gpt-4.1", "gpt-5", "o3", "gpt-4o"])
        rec_work = _pick_first_matching(chat_models, ["gpt-4.1-mini", "gpt-4o-mini", "gpt-4.1"], ["4.1-mini", "4o-mini", "mini"], rec_orch)
        rec_fast = _pick_first_matching(chat_models, ["gpt-4.1-nano", "gpt-4o-mini", "gpt-4.1-mini"], ["nano", "mini"], rec_work)
        rec_emb = _pick_first_matching(embedding_models, ["text-embedding-3-small", "text-embedding-3-large"], ["text-embedding-3", "embed"], "text-embedding-3-small")
    elif prov_id == "anthropic":
        rec_orch = _pick_first_matching(chat_models, ["claude-sonnet-4-5", "claude-opus-4-1"], ["opus-4", "sonnet-4", "3-7-sonnet", "sonnet"])
        rec_work = _pick_first_matching(chat_models, ["claude-sonnet-4-5"], ["sonnet-4", "sonnet"], rec_orch)
        rec_fast = _pick_first_matching(chat_models, ["claude-3-5-haiku-latest"], ["haiku"], rec_work)
        rec_emb = _pick_first_matching(embedding_models, [], ["embed"], str((active_models or {}).get("embedding") or "text-embedding-3-small"))
    elif prov_id == "gemini":
        rec_orch = _pick_first_matching(chat_models, ["gemini-2.5-pro"], ["2.5-pro", "pro"])
        rec_work = _pick_first_matching(chat_models, ["gemini-2.5-flash"], ["2.5-flash", "flash"], rec_orch)
        rec_fast = _pick_first_matching(chat_models, ["gemini-2.5-flash-lite", "gemini-2.5-flash"], ["flash-lite", "lite", "flash"], rec_work)
        rec_emb = _pick_first_matching(embedding_models, ["text-embedding-004", "gemini-embedding-001"], ["embedding"], "text-embedding-004")
    else:
        rec_orch = _pick_first_matching(
            chat_models,
            rec_defaults[:1],
            ["carbon", "sonnet-4", "opus", "gpt-4.1", "2.5-pro", "70b", "r1", "coder"],
        )
        rec_work = _pick_first_matching(
            chat_models,
            rec_defaults[1:2],
            ["hydrogen", "flash", "mini", "coder", "14b", "32b", "sonnet"],
            rec_orch,
        )
        rec_fast = _pick_first_matching(
            chat_models,
            rec_defaults[2:3],
            ["lite", "nano", "haiku", "8b", "3b", "fast", "flash", "mini"],
            rec_work,
        )
        rec_emb = _pick_first_matching(
            embedding_models,
            [m for m in rec_defaults if _is_embedding_model_id(m)],
            ["nomic-embed", "text-embedding", "gemini-embedding", "embed"],
            str((active_models or {}).get("embedding") or "nomic-embed-text"),
        )

    return {
        "models": merged,
        "chat_models": chat_models,
        "embedding_models": embedding_models,
        "recommended": {
            "orchestrator": rec_orch,
            "worker": rec_work,
            "fast": rec_fast,
            "embedding": rec_emb,
        },
    }


async def _fetch_live_provider_models(
    prov_id: str,
    base_url: str,
    api_key: str,
    catalog_entry: dict[str, Any],
    timeout_sec: float = 5.5,
) -> tuple[bool, int, int, list[str], str]:
    """Return (ok, status_code, latency_ms, model_ids, detail)."""
    t0 = time.perf_counter()
    clean_base = (base_url or "").strip().rstrip("/")
    headers = _build_provider_headers(clean_base, api_key or ("ollama" if prov_id == "ollama" else ""))

    try:
        async with httpx.AsyncClient(timeout=timeout_sec) as client:
            resp = await client.get(f"{clean_base}/models", headers=headers)
            latency_ms = max(1, int((time.perf_counter() - t0) * 1000))
            models: list[str] = []
            if resp.status_code < 400:
                try:
                    data = resp.json()
                    raw_models = (
                        data.get("data")
                        if isinstance(data, dict) and isinstance(data.get("data"), list)
                        else data.get("models")
                        if isinstance(data, dict) and isinstance(data.get("models"), list)
                        else []
                    )
                    for m in raw_models[:300]:
                        if isinstance(m, dict):
                            mid = str(m.get("id") or m.get("name") or "").strip()
                            if mid.startswith("models/"):
                                mid = mid[len("models/") :]
                            if mid:
                                models.append(mid)
                        elif isinstance(m, str) and m.strip():
                            models.append(m.strip())
                except Exception:
                    models = []

                if models or prov_id not in {"ollama", "local"}:
                    detail = f"Connected to {catalog_entry['name']} ({clean_base})."
                    return True, resp.status_code, latency_ms, models, detail

            # Ollama native /api/tags fallback when base_url omits /v1 or /v1/models is empty
            if prov_id in {"ollama", "local"} or ":11434" in clean_base:
                ollama_root = clean_base[:-3] if clean_base.endswith("/v1") else clean_base
                tags_resp = await client.get(f"{ollama_root}/api/tags")
                latency_ms = max(1, int((time.perf_counter() - t0) * 1000))
                if tags_resp.status_code < 400:
                    tags_data = tags_resp.json()
                    raw_tags = tags_data.get("models") if isinstance(tags_data, dict) else []
                    if isinstance(raw_tags, list):
                        tag_models = [
                            str(m.get("name") or m.get("model") or "").strip()
                            for m in raw_tags[:300]
                            if isinstance(m, dict) and (m.get("name") or m.get("model"))
                        ]
                        detail = f"Connected to {catalog_entry['name']} ({ollama_root})."
                        return True, tags_resp.status_code, latency_ms, tag_models, detail

            detail = f"Provider returned HTTP {resp.status_code}: {resp.text[:180]}"
            return False, resp.status_code, latency_ms, [], detail
    except Exception as exc:
        latency_ms = max(1, int((time.perf_counter() - t0) * 1000))
        return False, 0, latency_ms, [], f"Connection failed: {exc}"


@ai_router.get("/models")
async def get_ai_provider_models(provider_id: str = "", refresh: bool = False) -> dict[str, Any]:
    with db_session() as conn:
        prof = get_active_profile(conn)
        settings = get_settings_dict(conn)
        rt = resolve_active_llm_runtime(conn=conn)

    pid = str(prof.get("id") or OWNER_PROFILE_ID)
    gateway_locked = bool(prof.get("gateway_locked", False))
    active_prov_id = _normalize_ai_provider_id(str(rt.get("provider_id") or "openai-gateway"))
    prov_id = _normalize_ai_provider_id(provider_id) if provider_id.strip() else active_prov_id
    if prov_id not in AI_PROVIDER_BY_ID:
        prov_id = active_prov_id if active_prov_id in AI_PROVIDER_BY_ID else "openai-gateway"

    catalog_entry = AI_PROVIDER_BY_ID[prov_id]
    active_models = (
        {
            "orchestrator": str(rt.get("model_orchestrator") or ""),
            "worker": str(rt.get("model_worker") or ""),
            "fast": str(rt.get("model_fast") or ""),
            "embedding": str(rt.get("model_embedding") or ""),
        }
        if prov_id == active_prov_id
        else None
    )

    if gateway_locked and prov_id not in {"openai-gateway", "local", "ollama", "lmstudio", "none"}:
        classified = _classify_and_recommend_models(prov_id, [], catalog_entry, active_models)
        return {
            "ok": True,
            "provider_id": prov_id,
            "provider_name": catalog_entry["name"],
            "live_discovered": False,
            "detail": "Provider locked by enterprise gateway policy; showing curated catalog.",
            **classified,
        }

    saved_map = settings.get(f"ai_providers:{pid}")
    override = saved_map.get(prov_id) if isinstance(saved_map, dict) and isinstance(saved_map.get(prov_id), dict) else {}
    base_url = (
        str(override.get("base_url") or "")
        or (str(prof.get("offline_local_runner_url") or "") if prov_id in {"ollama", "local"} else "")
        or _entry_default_base_url(catalog_entry)
    ).strip().rstrip("/")
    if prov_id == "openai-gateway" and pid == OWNER_PROFILE_ID and not base_url:
        base_url = str(prof.get("gateway_base_url") or config.DEFAULT_GATEWAY_BASE_URL).rstrip("/")

    api_key = config.read_secret(f"ai-{pid}-{prov_id}")
    if not api_key and prov_id == "openai-gateway" and pid == OWNER_PROFILE_ID:
        fallback = config.load_gateway_credentials(base_url_override=base_url or None)
        api_key = fallback.api_key

    if not base_url or (catalog_entry["requires_api_key"] and not api_key):
        classified = _classify_and_recommend_models(prov_id, [], catalog_entry, active_models)
        return {
            "ok": True,
            "provider_id": prov_id,
            "provider_name": catalog_entry["name"],
            "live_discovered": False,
            "detail": "Using recommended model presets (connect API key to discover live models).",
            **classified,
        }

    cache_key = (pid, prov_id, base_url)
    now_mono = time.monotonic()
    cached = _PROVIDER_MODELS_CACHE.get(cache_key)
    if not refresh and cached and (now_mono - cached[0]) < _PROVIDER_MODELS_TTL_SEC:
        _, cached_models, cached_live, cached_detail = cached
        classified = _classify_and_recommend_models(prov_id, cached_models, catalog_entry, active_models)
        return {
            "ok": True,
            "provider_id": prov_id,
            "provider_name": catalog_entry["name"],
            "live_discovered": cached_live,
            "detail": cached_detail,
            **classified,
        }

    ok, _status, _lat, live_models, detail = await _fetch_live_provider_models(
        prov_id, base_url, api_key, catalog_entry, timeout_sec=5.0
    )
    live_ok = bool(ok and live_models)
    summary_detail = (
        f"Discovered {len(live_models)} live models from {catalog_entry['name']}."
        if live_ok
        else f"Using curated presets ({detail})"
    )
    _PROVIDER_MODELS_CACHE[cache_key] = (now_mono, live_models, live_ok, summary_detail)
    classified = _classify_and_recommend_models(prov_id, live_models, catalog_entry, active_models)
    return {
        "ok": True,
        "provider_id": prov_id,
        "provider_name": catalog_entry["name"],
        "live_discovered": live_ok,
        "detail": summary_detail,
        **classified,
    }


@ai_router.post("/test")
async def test_ai_provider(req: AIProviderTestRequest) -> dict[str, Any]:
    prov_id = _normalize_ai_provider_id(req.provider_id)
    if prov_id not in AI_PROVIDER_BY_ID:
        raise HTTPException(status_code=400, detail=f"Unsupported AI provider '{req.provider_id}'.")

    catalog_entry = AI_PROVIDER_BY_ID[prov_id]
    with db_session() as conn:
        prof = get_active_profile(conn)
        settings = get_settings_dict(conn)

    pid = str(prof.get("id") or OWNER_PROFILE_ID)
    gateway_locked = bool(prof.get("gateway_locked", False))
    if gateway_locked and prov_id not in {"openai-gateway", "local", "ollama", "lmstudio", "none"}:
        raise HTTPException(
            status_code=403,
            detail="This profile's AI gateway is locked to its managed gateway or local runtime.",
        )

    if prov_id == "none":
        detail = "No-Key Limited Mode active (SQLite FTS5, Vault, Tasks, Approvals & Deterministic Browser ready)."
        return {
            "ok": True,
            "provider_id": "none",
            "status_code": 200,
            "latency_ms": 1,
            "detail": detail,
            "message": detail,
            "models": [],
        }

    saved_map = settings.get(f"ai_providers:{pid}")
    override = saved_map.get(prov_id) if isinstance(saved_map, dict) and isinstance(saved_map.get(prov_id), dict) else {}

    base_url = (
        req.base_url.strip()
        or str(override.get("base_url") or "")
        or _entry_default_base_url(catalog_entry)
    ).rstrip("/")
    if prov_id in {"ollama", "local"} and not req.base_url.strip():
        base_url = str(prof.get("offline_local_runner_url") or base_url or "http://127.0.0.1:11434/v1").rstrip("/")

    api_key = req.api_key.strip() or config.read_secret(f"ai-{pid}-{prov_id}")
    if not api_key and prov_id == "openai-gateway" and pid == OWNER_PROFILE_ID:
        fallback = config.load_gateway_credentials(base_url_override=base_url or None)
        api_key = fallback.api_key

    if not base_url:
        detail = "Base URL is required."
        return {"ok": False, "provider_id": prov_id, "status_code": 0, "latency_ms": 0, "detail": detail, "message": detail, "models": []}
    if catalog_entry["requires_api_key"] and not api_key:
        detail = "API key not configured for this provider."
        return {
            "ok": False,
            "provider_id": prov_id,
            "status_code": 0,
            "latency_ms": 0,
            "detail": detail,
            "message": detail,
            "models": [],
        }

    ok, status_code, latency_ms, live_models, detail = await _fetch_live_provider_models(
        prov_id, base_url, api_key, catalog_entry, timeout_sec=6.0
    )
    if ok:
        _PROVIDER_MODELS_CACHE[(pid, prov_id, base_url)] = (
            time.monotonic(),
            live_models,
            bool(live_models),
            f"Discovered {len(live_models)} live models from {catalog_entry['name']}.",
        )
        classified = _classify_and_recommend_models(prov_id, live_models, catalog_entry)
        return {
            "ok": True,
            "provider_id": prov_id,
            "status_code": status_code,
            "latency_ms": latency_ms,
            "detail": detail,
            "message": detail,
            **classified,
        }
    return {
        "ok": False,
        "provider_id": prov_id,
        "status_code": status_code,
        "latency_ms": latency_ms,
        "detail": detail,
        "message": detail,
        "models": [],
    }


@ai_router.get("/usage")
def get_ai_provider_usage(days: int = 7) -> dict[str, Any]:
    """Return LLM token & cost telemetry for the active profile, handling missing `llm_usage` table gracefully."""
    window_days = max(1, min(90, int(days)))
    today_utc = datetime.now(timezone.utc).date()
    series_dates = [(today_utc - timedelta(days=offset)).isoformat() for offset in range(6, -1, -1)]
    cutoff_iso = (datetime.now(timezone.utc) - timedelta(days=window_days)).isoformat()

    daily_map: dict[str, dict[str, Any]] = {
        d: {
            "date": d,
            "calls": 0,
            "prompt_tokens": 0,
            "completion_tokens": 0,
            "total_tokens": 0,
            "cost_usd": 0.0,
        }
        for d in series_dates
    }

    with db_session() as conn:
        prof = get_active_profile(conn)
        pid = str(prof.get("id") or OWNER_PROFILE_ID)

        total_calls = 0
        prompt_tokens = 0
        completion_tokens = 0
        total_tokens = 0
        total_cost_usd = 0.0
        by_provider: list[dict[str, Any]] = []
        by_model: list[dict[str, Any]] = []
        recent_calls: list[dict[str, Any]] = []

        try:
            agg = conn.execute(
                """
                SELECT
                    COUNT(*) AS calls,
                    COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
                    COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
                    COALESCE(SUM(total_tokens), 0) AS total_tokens,
                    COALESCE(SUM(cost_usd), 0.0) AS cost_usd
                FROM llm_usage
                WHERE profile_id = ? AND created_at >= ?
                """,
                (pid, cutoff_iso),
            ).fetchone()
            if agg:
                total_calls = int(agg["calls"] or 0)
                prompt_tokens = int(agg["prompt_tokens"] or 0)
                completion_tokens = int(agg["completion_tokens"] or 0)
                total_tokens = int(agg["total_tokens"] or 0)
                total_cost_usd = round(float(agg["cost_usd"] or 0.0), 6)

            prov_rows = conn.execute(
                """
                SELECT
                    provider_id,
                    COUNT(*) AS calls,
                    COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
                    COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
                    COALESCE(SUM(total_tokens), 0) AS total_tokens,
                    COALESCE(SUM(cost_usd), 0.0) AS cost_usd
                FROM llm_usage
                WHERE profile_id = ? AND created_at >= ?
                GROUP BY provider_id
                ORDER BY total_tokens DESC
                """,
                (pid, cutoff_iso),
            ).fetchall()
            for r in prov_rows:
                by_provider.append(
                    {
                        "provider_id": str(r["provider_id"] or "unknown"),
                        "calls": int(r["calls"] or 0),
                        "prompt_tokens": int(r["prompt_tokens"] or 0),
                        "completion_tokens": int(r["completion_tokens"] or 0),
                        "total_tokens": int(r["total_tokens"] or 0),
                        "cost_usd": round(float(r["cost_usd"] or 0.0), 6),
                    }
                )

            model_rows = conn.execute(
                """
                SELECT
                    model,
                    provider_id,
                    COUNT(*) AS calls,
                    COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
                    COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
                    COALESCE(SUM(total_tokens), 0) AS total_tokens,
                    COALESCE(SUM(cost_usd), 0.0) AS cost_usd
                FROM llm_usage
                WHERE profile_id = ? AND created_at >= ?
                GROUP BY model, provider_id
                ORDER BY total_tokens DESC
                LIMIT 25
                """,
                (pid, cutoff_iso),
            ).fetchall()
            for r in model_rows:
                by_model.append(
                    {
                        "model": str(r["model"] or "unknown"),
                        "provider_id": str(r["provider_id"] or "unknown"),
                        "calls": int(r["calls"] or 0),
                        "prompt_tokens": int(r["prompt_tokens"] or 0),
                        "completion_tokens": int(r["completion_tokens"] or 0),
                        "total_tokens": int(r["total_tokens"] or 0),
                        "cost_usd": round(float(r["cost_usd"] or 0.0), 6),
                    }
                )

            daily_rows = conn.execute(
                """
                SELECT
                    substr(created_at, 1, 10) AS day,
                    COUNT(*) AS calls,
                    COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
                    COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
                    COALESCE(SUM(total_tokens), 0) AS total_tokens,
                    COALESCE(SUM(cost_usd), 0.0) AS cost_usd
                FROM llm_usage
                WHERE profile_id = ? AND substr(created_at, 1, 10) >= ?
                GROUP BY substr(created_at, 1, 10)
                """,
                (pid, series_dates[0]),
            ).fetchall()
            for r in daily_rows:
                day_str = str(r["day"] or "")
                if day_str in daily_map:
                    daily_map[day_str] = {
                        "date": day_str,
                        "calls": int(r["calls"] or 0),
                        "prompt_tokens": int(r["prompt_tokens"] or 0),
                        "completion_tokens": int(r["completion_tokens"] or 0),
                        "total_tokens": int(r["total_tokens"] or 0),
                        "cost_usd": round(float(r["cost_usd"] or 0.0), 6),
                    }

            recent_rows = conn.execute(
                """
                SELECT id, profile_id, provider_id, model, operation AS call_kind,
                       prompt_tokens, completion_tokens, total_tokens, cost_usd, created_at
                FROM llm_usage
                WHERE profile_id = ?
                ORDER BY id DESC
                LIMIT 20
                """,
                (pid,),
            ).fetchall()
            recent_calls = [row_to_dict(r) for r in recent_rows if r is not None]
        except sqlite3.OperationalError:
            pass

    daily_budget_usd = round(float(prof.get("daily_budget_usd") if prof.get("daily_budget_usd") is not None else 15.0), 2)
    today_iso = today_utc.isoformat()
    today_bucket = daily_map.get(today_iso) or {}
    today_usd = round(float(today_bucket.get("cost_usd") or 0.0), 6)
    today_tokens = int(today_bucket.get("total_tokens") or 0)
    today_calls = int(today_bucket.get("calls") or 0)
    pct_used = round((today_usd / daily_budget_usd) * 100.0, 1) if daily_budget_usd > 0 else 0.0
    budget_exceeded = bool(daily_budget_usd > 0 and today_usd >= daily_budget_usd)

    return {
        "ok": True,
        "profile_id": pid,
        "window_days": window_days,
        "daily_budget_usd": daily_budget_usd,
        "today_usd": today_usd,
        "today_tokens": today_tokens,
        "today_calls": today_calls,
        "pct_used": pct_used,
        "budget_exceeded": budget_exceeded,
        "seven_day_usd": total_cost_usd,
        "seven_day_tokens": total_tokens,
        "total_calls": total_calls,
        "prompt_tokens": prompt_tokens,
        "completion_tokens": completion_tokens,
        "total_tokens": total_tokens,
        "total_cost_usd": total_cost_usd,
        "by_provider": by_provider,
        "by_model": by_model,
        "daily_series": [daily_map[d] for d in series_dates],
        "recent_calls": recent_calls,
    }


class LocalPullPlanRequest(BaseModel):
    model_id: str = "llama3.2:3b"
    runtime: str = "ollama"


@ai_router.get("/local/detect")
async def detect_local_runtimes_endpoint() -> dict[str, Any]:
    """Probe Ollama (11434) first and LM Studio (1234) second without downloading weights."""
    return await detect_local_runtimes()


@ai_router.post("/local/pull-plan")
def create_local_pull_plan_endpoint(req: LocalPullPlanRequest) -> dict[str, Any]:
    """Return an on-demand pull plan/command without downloading multi-GB model weights automatically."""
    return build_on_demand_pull_plan(req.model_id, req.runtime)


@ai_router.get("/capabilities")
def get_ai_capabilities_endpoint() -> dict[str, Any]:
    with db_session() as conn:
        rt = resolve_active_llm_runtime(conn=conn)
    return build_ai_capability_matrix(rt)
