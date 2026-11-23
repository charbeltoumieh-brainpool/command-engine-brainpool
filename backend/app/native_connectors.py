from __future__ import annotations

import asyncio
import base64
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage
import hashlib
import json
import os
import secrets
import threading
import time
from typing import Any
from urllib.parse import urlencode
import webbrowser

import httpx

from . import config
from .db import db_session, row_to_dict, utc_now_iso
from .profiles import OWNER_PROFILE_ID
from .safety import is_owned_github_item, redact_secrets

# ---------------------------------------------------------------------------
# OAuth2 + PKCE Provider Definitions & Ephemeral State Store
# ---------------------------------------------------------------------------

OAUTH_STATE_TTL_SEC = 900.0  # 15 minutes
_OAUTH_STATE_LOCK = threading.Lock()
_PENDING_OAUTH_STATES: dict[str, dict[str, Any]] = {}

INTEGRATION_TO_PROVIDER: dict[str, str] = {
    "github": "github",
    "slack": "slack",
    "gmail": "google",
    "google-calendar": "google",
    "google-drive": "google",
    "google-meet": "google",
    "google": "google",
    "linear": "linear",
    "notion": "notion",
}

OAUTH_PROVIDERS: dict[str, dict[str, Any]] = {
    "github": {
        "name": "GitHub",
        "authorize_url": "https://github.com/login/oauth/authorize",
        "token_url": "https://github.com/login/oauth/access_token",
        "scopes": "repo read:user notifications read:project",
        "env_client_id": "COMMAND_ENGINE_GITHUB_CLIENT_ID",
        "env_client_secret": "COMMAND_ENGINE_GITHUB_CLIENT_SECRET",
    },
    "slack": {
        "name": "Slack",
        "authorize_url": "https://slack.com/oauth/v2/authorize",
        "token_url": "https://slack.com/api/oauth.v2.access",
        "scopes": "channels:history,channels:read,im:history,im:read,mpim:history,mpim:read,users:read,chat:write",
        "user_scopes": "channels:history,channels:read,im:history,im:read,mpim:history,mpim:read,search:read,chat:write,users:read",
        "env_client_id": "COMMAND_ENGINE_SLACK_CLIENT_ID",
        "env_client_secret": "COMMAND_ENGINE_SLACK_CLIENT_SECRET",
    },
    "google": {
        "name": "Google Workspace",
        "authorize_url": "https://accounts.google.com/o/oauth2/v2/auth",
        "token_url": "https://oauth2.googleapis.com/token",
        "scopes": (
            "openid email profile "
            "https://www.googleapis.com/auth/gmail.readonly "
            "https://www.googleapis.com/auth/gmail.send "
            "https://www.googleapis.com/auth/calendar.readonly "
            "https://www.googleapis.com/auth/drive.readonly"
        ),
        "env_client_id": "COMMAND_ENGINE_GOOGLE_CLIENT_ID",
        "env_client_secret": "COMMAND_ENGINE_GOOGLE_CLIENT_SECRET",
    },
    "linear": {
        "name": "Linear",
        "authorize_url": "https://linear.app/oauth/authorize",
        "token_url": "https://api.linear.app/oauth/token",
        "scopes": "read",
        "env_client_id": "COMMAND_ENGINE_LINEAR_CLIENT_ID",
        "env_client_secret": "COMMAND_ENGINE_LINEAR_CLIENT_SECRET",
    },
    "notion": {
        "name": "Notion",
        "authorize_url": "https://api.notion.com/v1/oauth/authorize",
        "token_url": "https://api.notion.com/v1/oauth/token",
        "scopes": "",
        "env_client_id": "COMMAND_ENGINE_NOTION_CLIENT_ID",
        "env_client_secret": "COMMAND_ENGINE_NOTION_CLIENT_SECRET",
    },
}

_INTEGRATION_ENV_FALLBACKS: dict[str, tuple[str, ...]] = {
    "slack": ("SLACK_BOT_TOKEN", "SLACK_USER_TOKEN"),
    "github": ("GITHUB_TOKEN",),
    "linear": ("LINEAR_API_KEY",),
    "notion": ("NOTION_API_KEY",),
    "gmail": ("GOOGLE_ACCESS_TOKEN",),
    "google-calendar": ("GOOGLE_ACCESS_TOKEN",),
    "google-drive": ("GOOGLE_ACCESS_TOKEN",),
    "google-meet": ("GOOGLE_ACCESS_TOKEN",),
    "google": ("GOOGLE_ACCESS_TOKEN",),
}


def _prune_expired_oauth_states() -> None:
    cutoff = time.time() - OAUTH_STATE_TTL_SEC
    with _OAUTH_STATE_LOCK:
        expired = [k for k, v in _PENDING_OAUTH_STATES.items() if float(v.get("created_at") or 0) < cutoff]
        for k in expired:
            _PENDING_OAUTH_STATES.pop(k, None)
    try:
        with db_session() as conn:
            conn.execute("DELETE FROM oauth_pkce_states WHERE created_at_epoch < ?", (cutoff,))
    except Exception:
        pass


def _resolve_oauth_client_credentials(
    provider: str,
    integration_id: str,
    client_id_override: str = "",
    client_secret_override: str = "",
) -> tuple[str, str]:
    prov_meta = OAUTH_PROVIDERS.get(provider, {})
    client_id = client_id_override.strip()
    client_secret = client_secret_override.strip()

    if not client_id or not client_secret:
        try:
            with db_session() as conn:
                candidate_ids = [integration_id]
                if provider == "google":
                    for gid in ("gmail", "google-calendar", "google-drive", "google-meet"):
                        if gid not in candidate_ids:
                            candidate_ids.append(gid)
                for cid_row in candidate_ids:
                    row = conn.execute("SELECT config_json FROM integrations WHERE id = ?", (cid_row,)).fetchone()
                    if row and row["config_json"]:
                        cfg = json.loads(row["config_json"])
                        if isinstance(cfg, dict) and not client_id:
                            val = str(cfg.get("oauth_client_id") or "").strip()
                            if val:
                                client_id = val
                                break
        except Exception:
            pass

    if not client_secret:
        client_secret = config.read_secret(f"oauth-client-secret-{provider}")

    if not client_id and prov_meta.get("env_client_id"):
        client_id = os.environ.get(str(prov_meta["env_client_id"]), "").strip()
    if not client_secret and prov_meta.get("env_client_secret"):
        client_secret = os.environ.get(str(prov_meta["env_client_secret"]), "").strip()

    return client_id, client_secret


def _persist_oauth_client_credentials(
    integration_id: str,
    provider: str,
    client_id: str,
    client_secret: str,
) -> None:
    if client_id:
        now = utc_now_iso()
        with db_session() as conn:
            row = conn.execute("SELECT config_json FROM integrations WHERE id = ?", (integration_id,)).fetchone()
            cfg: dict[str, Any] = {}
            if row and row["config_json"]:
                try:
                    parsed = json.loads(row["config_json"])
                    if isinstance(parsed, dict):
                        cfg = parsed
                except Exception:
                    cfg = {}
            cfg["oauth_client_id"] = client_id
            conn.execute(
                "UPDATE integrations SET config_json = ?, updated_at = ? WHERE id = ?",
                (json.dumps(cfg), now, integration_id),
            )
    if client_secret:
        config.store_secret(f"oauth-client-secret-{provider}", client_secret)


def refresh_oauth_token_if_needed(
    integration_id: str,
    bundle: dict[str, Any],
    *,
    profile_id: str | None = None,
    secret_key: str | None = None,
) -> dict[str, Any]:
    """Refresh an OAuth2 token bundle if `expires_at` is within 60s and client credentials exist."""
    access_token = str(bundle.get("access_token") or "").strip()
    refresh_token = str(bundle.get("refresh_token") or "").strip()
    expires_at_raw = bundle.get("expires_at")
    if not refresh_token or expires_at_raw is None:
        return bundle

    try:
        expires_at = float(expires_at_raw)
    except (TypeError, ValueError):
        return bundle

    if time.time() < (expires_at - 60.0):
        return bundle

    provider = str(bundle.get("provider") or INTEGRATION_TO_PROVIDER.get(integration_id, "")).strip()
    prov_meta = OAUTH_PROVIDERS.get(provider)
    if not prov_meta:
        return bundle

    client_id, client_secret = _resolve_oauth_client_credentials(provider, integration_id)
    if not client_id:
        return bundle

    form_data: dict[str, str] = {
        "grant_type": "refresh_token",
        "refresh_token": refresh_token,
        "client_id": client_id,
    }
    if client_secret:
        form_data["client_secret"] = client_secret

    try:
        with httpx.Client(timeout=12.0) as client:
            resp = client.post(
                str(prov_meta["token_url"]),
                data=form_data,
                headers={"Accept": "application/json"},
            )
        if resp.status_code >= 400:
            return bundle
        data = resp.json()
        new_access = str(data.get("access_token") or "").strip()
        if not new_access:
            return bundle

        updated = dict(bundle)
        updated["access_token"] = new_access
        if data.get("refresh_token"):
            updated["refresh_token"] = str(data["refresh_token"]).strip()
        if data.get("expires_in"):
            updated["expires_at"] = time.time() + int(data["expires_in"])
        if data.get("token_type"):
            updated["token_type"] = str(data["token_type"])
        if data.get("scope"):
            updated["scope"] = str(data["scope"])

        serialized = json.dumps(updated)
        if profile_id:
            config.store_secret(f"{profile_id}-{integration_id}", serialized)
        config.store_secret(integration_id, serialized)
        if secret_key and secret_key not in {integration_id, f"{profile_id}-{integration_id}"}:
            config.store_secret(secret_key, serialized)
        return updated
    except Exception:
        return bundle


def resolve_integration_token(integration_id: str, profile_id: str | None = None) -> str:
    """
    Resolve an integration API token or OAuth access_token (auto-refreshing if needed).
    Order:
      1. Profile-scoped secret `{profile_id}-{integration_id}`
      2. Integration-scoped secret `{integration_id}`
      3. Shared Google secret (`{profile_id}-google` / `google`) for Google Workspace IDs
      4. Standard env vars ONLY for non-BYOK / owner fallback
    """
    candidate_keys: list[str] = []
    if profile_id:
        candidate_keys.append(f"{profile_id}-{integration_id}")
    candidate_keys.append(integration_id)

    if integration_id in {"gmail", "google-calendar", "google-drive", "google-meet"}:
        if profile_id:
            candidate_keys.append(f"{profile_id}-google")
        candidate_keys.append("google")

    raw_secret = ""
    matched_key = ""
    for skey in candidate_keys:
        val = config.read_secret(skey)
        if val:
            raw_secret = val
            matched_key = skey
            break

    if not raw_secret and (not profile_id or profile_id == OWNER_PROFILE_ID):
        for env_name in _INTEGRATION_ENV_FALLBACKS.get(integration_id, ()):
            env_val = os.environ.get(env_name, "").strip()
            if env_val:
                raw_secret = env_val
                break

    if not raw_secret:
        return ""

    if raw_secret.startswith("{"):
        try:
            parsed = json.loads(raw_secret)
            if isinstance(parsed, dict) and parsed.get("access_token"):
                refreshed = refresh_oauth_token_if_needed(
                    integration_id,
                    parsed,
                    profile_id=profile_id,
                    secret_key=matched_key or None,
                )
                return str(refreshed.get("access_token") or "").strip()
        except Exception:
            pass

    return raw_secret.strip()


def start_oauth_pkce_flow(
    integration_id: str,
    profile_id: str,
    client_id: str = "",
    client_secret: str = "",
    redirect_uri: str = "",
    open_browser: bool = False,
) -> dict[str, Any]:
    """Start an OAuth2 + RFC 7636 PKCE flow and return authorize_url + state (or setup_hint if unconfigured)."""
    _prune_expired_oauth_states()
    provider = INTEGRATION_TO_PROVIDER.get(integration_id, "")
    resolved_redirect = (
        redirect_uri.strip() or f"http://127.0.0.1:{config.BACKEND_PORT}/api/integrations/oauth/callback"
    )
    if not provider or provider not in OAUTH_PROVIDERS:
        return {
            "ok": False,
            "configured": False,
            "authorize_url": "",
            "state": "",
            "provider": "",
            "redirect_uri": resolved_redirect,
            "setup_hint": f"Integration '{integration_id}' uses direct API token or CLI authentication rather than OAuth2.",
        }

    prov_meta = OAUTH_PROVIDERS[provider]
    if client_id.strip() or client_secret.strip():
        _persist_oauth_client_credentials(
            integration_id,
            provider,
            client_id.strip(),
            client_secret.strip(),
        )

    resolved_client_id, resolved_client_secret = _resolve_oauth_client_credentials(
        provider,
        integration_id,
        client_id_override=client_id,
        client_secret_override=client_secret,
    )
    if not resolved_client_id:
        env_var = prov_meta["env_client_id"]
        return {
            "ok": False,
            "configured": False,
            "authorize_url": "",
            "state": "",
            "provider": provider,
            "redirect_uri": resolved_redirect,
            "setup_hint": (
                f"Enter your {prov_meta['name']} OAuth Client ID (or set {env_var}) "
                f"with callback URL {resolved_redirect}, or paste a Direct API Token."
            ),
        }

    # RFC 7636 S256 PKCE
    code_verifier = secrets.token_urlsafe(48)[:64]
    digest = hashlib.sha256(code_verifier.encode("ascii")).digest()
    code_challenge = base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")
    state = secrets.token_urlsafe(24)

    created_epoch = time.time()
    created_iso = utc_now_iso()
    resolved_pid = profile_id or OWNER_PROFILE_ID
    with _OAUTH_STATE_LOCK:
        _PENDING_OAUTH_STATES[state] = {
            "integration_id": integration_id,
            "profile_id": resolved_pid,
            "provider": provider,
            "code_verifier": code_verifier,
            "redirect_uri": resolved_redirect,
            "client_id": resolved_client_id,
            "client_secret": resolved_client_secret,
            "created_at": created_epoch,
        }
    with db_session() as conn:
        conn.execute(
            """
            INSERT INTO oauth_pkce_states(
                state, integration_id, profile_id, provider, code_verifier,
                redirect_uri, client_id, client_secret, created_at_epoch, created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(state) DO UPDATE SET
                integration_id=excluded.integration_id,
                profile_id=excluded.profile_id,
                provider=excluded.provider,
                code_verifier=excluded.code_verifier,
                redirect_uri=excluded.redirect_uri,
                client_id=excluded.client_id,
                client_secret=excluded.client_secret,
                created_at_epoch=excluded.created_at_epoch,
                created_at=excluded.created_at
            """,
            (
                state,
                integration_id,
                resolved_pid,
                provider,
                code_verifier,
                resolved_redirect,
                resolved_client_id,
                resolved_client_secret,
                created_epoch,
                created_iso,
            ),
        )

    params: dict[str, str] = {
        "client_id": resolved_client_id,
        "redirect_uri": resolved_redirect,
        "response_type": "code",
        "state": state,
        "code_challenge": code_challenge,
        "code_challenge_method": "S256",
    }
    if prov_meta.get("scopes"):
        params["scope"] = str(prov_meta["scopes"])
    if provider == "slack" and prov_meta.get("user_scopes"):
        params["user_scope"] = str(prov_meta["user_scopes"])
    if provider == "google":
        params["access_type"] = "offline"
        params["prompt"] = "consent"
        params["include_granted_scopes"] = "true"
    if provider == "notion":
        params["owner"] = "user"

    authorize_url = f"{prov_meta['authorize_url']}?{urlencode(params)}"
    if open_browser:
        try:
            webbrowser.open(authorize_url)
        except Exception:
            pass

    return {
        "ok": True,
        "configured": True,
        "authorize_url": authorize_url,
        "state": state,
        "provider": provider,
        "redirect_uri": resolved_redirect,
        "setup_hint": "",
    }


async def _fetch_oauth_account_label(
    client: httpx.AsyncClient,
    provider: str,
    access_token: str,
) -> str:
    try:
        if provider == "github":
            resp = await client.get(
                "https://api.github.com/user",
                headers={"Authorization": f"Bearer {access_token}", "Accept": "application/vnd.github+json"},
            )
            if resp.status_code < 400:
                login = str(resp.json().get("login") or "").strip()
                if login:
                    return f"@{login}"
        elif provider == "slack":
            resp = await client.post(
                "https://slack.com/api/auth.test",
                headers={"Authorization": f"Bearer {access_token}"},
            )
            if resp.status_code < 400 and resp.json().get("ok"):
                data = resp.json()
                user = str(data.get("user") or data.get("user_id") or "").strip()
                team = str(data.get("team") or "").strip()
                return f"{user} ({team})" if user and team else (user or "Slack OAuth")
        elif provider == "google":
            resp = await client.get(
                "https://www.googleapis.com/oauth2/v2/userinfo",
                headers={"Authorization": f"Bearer {access_token}"},
            )
            if resp.status_code < 400:
                email = str(resp.json().get("email") or "").strip()
                if email:
                    return email
        elif provider == "linear":
            resp = await client.post(
                "https://api.linear.app/graphql",
                headers={"Authorization": f"Bearer {access_token}"},
                json={"query": "{ viewer { name email } }"},
            )
            if resp.status_code < 400:
                viewer = (resp.json().get("data") or {}).get("viewer") or {}
                return str(viewer.get("email") or viewer.get("name") or "Linear OAuth")
        elif provider == "notion":
            resp = await client.get(
                "https://api.notion.com/v1/users/me",
                headers={"Authorization": f"Bearer {access_token}", "Notion-Version": "2022-06-28"},
            )
            if resp.status_code < 400:
                return str(resp.json().get("name") or "Notion OAuth")
    except Exception:
        pass
    return f"{OAUTH_PROVIDERS.get(provider, {}).get('name', provider.title())} OAuth"


async def complete_oauth_pkce_callback(state: str, code: str) -> dict[str, Any]:
    """Exchange OAuth2 authorization code + PKCE code_verifier, persist encrypted bundle, and mark connected."""
    _prune_expired_oauth_states()
    clean_state = (state or "").strip()
    clean_code = (code or "").strip()
    if not clean_state or not clean_code:
        return {"ok": False, "error": "Missing OAuth state or authorization code."}

    with _OAUTH_STATE_LOCK:
        pending = _PENDING_OAUTH_STATES.pop(clean_state, None)
    try:
        with db_session() as conn:
            if pending is None:
                row = conn.execute(
                    "SELECT * FROM oauth_pkce_states WHERE state = ?",
                    (clean_state,),
                ).fetchone()
                if row and float(row["created_at_epoch"] or 0) >= (time.time() - OAUTH_STATE_TTL_SEC):
                    pending = {
                        "integration_id": str(row["integration_id"]),
                        "profile_id": str(row["profile_id"] or OWNER_PROFILE_ID),
                        "provider": str(row["provider"]),
                        "code_verifier": str(row["code_verifier"]),
                        "redirect_uri": str(row["redirect_uri"]),
                        "client_id": str(row["client_id"]),
                        "client_secret": str(row["client_secret"] or ""),
                        "created_at": float(row["created_at_epoch"]),
                    }
            conn.execute("DELETE FROM oauth_pkce_states WHERE state = ?", (clean_state,))
    except Exception:
        pass
    if not pending:
        return {"ok": False, "error": "OAuth state is invalid or expired (15-minute window). Please restart sign-in."}

    integration_id = str(pending["integration_id"])
    profile_id = str(pending["profile_id"] or OWNER_PROFILE_ID)
    provider = str(pending["provider"])
    prov_meta = OAUTH_PROVIDERS[provider]
    token_url = str(prov_meta["token_url"])
    client_id = str(pending["client_id"])
    client_secret = str(pending.get("client_secret") or "")

    form_data: dict[str, str] = {
        "grant_type": "authorization_code",
        "code": clean_code,
        "redirect_uri": str(pending["redirect_uri"]),
        "client_id": client_id,
        "code_verifier": str(pending["code_verifier"]),
    }
    if client_secret:
        form_data["client_secret"] = client_secret

    headers = {"Accept": "application/json"}
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            if provider == "notion":
                resp = await client.post(
                    token_url,
                    json={
                        "grant_type": "authorization_code",
                        "code": clean_code,
                        "redirect_uri": str(pending["redirect_uri"]),
                    },
                    auth=(client_id, client_secret),
                    headers={**headers, "Notion-Version": "2022-06-28"},
                )
            else:
                resp = await client.post(token_url, data=form_data, headers=headers)

            if resp.status_code >= 400:
                return {"ok": False, "error": f"Token exchange failed (HTTP {resp.status_code}): {redact_secrets(resp.text[:240])}"}

            payload = resp.json()
            if payload.get("error"):
                return {
                    "ok": False,
                    "error": f"OAuth provider error: {payload.get('error_description') or payload.get('error')}",
                }

            access_token = str(
                payload.get("access_token")
                or (payload.get("authed_user") or {}).get("access_token")
                or ""
            ).strip()
            if not access_token:
                return {"ok": False, "error": "OAuth token endpoint returned no access_token."}

            expires_in = payload.get("expires_in")
            bundle: dict[str, Any] = {
                "access_token": access_token,
                "refresh_token": str(payload.get("refresh_token") or "").strip(),
                "token_type": str(payload.get("token_type") or "Bearer"),
                "scope": str(payload.get("scope") or (payload.get("authed_user") or {}).get("scope") or ""),
                "expires_at": (time.time() + int(expires_in)) if expires_in else None,
                "provider": provider,
            }
            bundle_json = json.dumps(bundle)
            config.store_secret(f"{profile_id}-{integration_id}", bundle_json)
            config.store_secret(integration_id, bundle_json)

            account_label = await _fetch_oauth_account_label(client, provider, access_token)

        now = utc_now_iso()
        with db_session() as conn:
            row = conn.execute("SELECT config_json FROM integrations WHERE id = ?", (integration_id,)).fetchone()
            cfg: dict[str, Any] = {}
            if row and row["config_json"]:
                try:
                    parsed = json.loads(row["config_json"])
                    if isinstance(parsed, dict):
                        cfg = parsed
                except Exception:
                    cfg = {}
            cfg["oauth_connected"] = True
            cfg["oauth_provider"] = provider
            conn.execute(
                """
                UPDATE integrations
                SET enabled = 1,
                    auth_status = 'connected',
                    auth_message = ?,
                    account_label = ?,
                    config_json = ?,
                    last_checked_at = ?,
                    updated_at = ?
                WHERE id = ?
                """,
                (
                    f"Connected via OAuth2 PKCE ({account_label}).",
                    account_label,
                    json.dumps(cfg),
                    now,
                    now,
                    integration_id,
                ),
            )
        return {
            "ok": True,
            "integration_id": integration_id,
            "profile_id": profile_id,
            "account_label": account_label,
        }
    except Exception as exc:
        return {"ok": False, "error": f"OAuth callback error: {redact_secrets(str(exc))}"}


# ---------------------------------------------------------------------------
# Zero-CLI Native REST & GraphQL Collectors
# ---------------------------------------------------------------------------


def _enabled_integration_ids() -> set[str]:
    try:
        with db_session() as conn:
            rows = conn.execute("SELECT id, enabled FROM integrations").fetchall()
            if not rows:
                return set()
            return {str(r["id"]) for r in rows if int(r["enabled"]) == 1}
    except Exception:
        return set()


async def _collect_github_native(
    client: httpx.AsyncClient,
    token: str,
    profile: dict[str, Any],
) -> dict[str, Any]:
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    gh_login = str(profile.get("github_login") or "").strip()
    if not gh_login:
        me_resp = await client.get("https://api.github.com/user", headers=headers)
        if me_resp.status_code < 400:
            gh_login = str(me_resp.json().get("login") or "").strip()

    events: list[dict[str, Any]] = []
    tasks: list[dict[str, Any]] = []
    seen_pr_keys: set[str] = set()

    notif_resp = await client.get(
        "https://api.github.com/notifications",
        params={"participating": "true", "per_page": 25},
        headers=headers,
    )
    if notif_resp.status_code == 401:
        raise PermissionError("GitHub REST token unauthorized (401).")
    if notif_resp.status_code < 400:
        for n in notif_resp.json() or []:
            subj = n.get("subject") or {}
            repo_full = str((n.get("repository") or {}).get("full_name") or "")
            reason = str(n.get("reason") or "subscribed")
            title = str(subj.get("title") or "GitHub notification")
            nid = str(n.get("id") or "")
            api_url = str(subj.get("url") or "")
            html_url = api_url.replace("api.github.com/repos/", "github.com/").replace("/pulls/", "/pull/")
            unread = bool(n.get("unread"))
            prio = "P0" if reason in {"mention", "review_requested", "assign"} and unread else ("P1" if unread else "P2")
            events.append(
                {
                    "source": "github",
                    "source_id": f"gh-notif:{nid}",
                    "event_type": str(subj.get("type") or "notification").lower(),
                    "title": f"[{repo_full}] {title}" if repo_full else title,
                    "summary": f"Reason: {reason}" + (" · Unread" if unread else ""),
                    "actor": repo_full,
                    "url": html_url,
                    "channel_or_repo": repo_full,
                    "priority": prio,
                    "ownership_reason": reason,
                    "is_mine": True,
                    "requires_action": unread and reason in {"mention", "review_requested", "assign", "author"},
                    "occurred_at": str(n.get("updated_at") or utc_now_iso()),
                }
            )

    if gh_login:
        search_resp = await client.get(
            "https://api.github.com/search/issues",
            params={"q": f"is:open is:pr involves:{gh_login}", "per_page": 20},
            headers=headers,
        )
        if search_resp.status_code < 400:
            for item in (search_resp.json() or {}).get("items") or []:
                repo_url = str(item.get("repository_url") or "")
                repo_full = "/".join(repo_url.split("/")[-2:]) if "/" in repo_url else ""
                num = int(item.get("number") or 0)
                author = str((item.get("user") or {}).get("login") or "")
                assignees = [str(a.get("login") or "") for a in (item.get("assignees") or []) if isinstance(a, dict)]
                pr_url = str(item.get("html_url") or "")
                title = str(item.get("title") or f"PR #{num}")
                updated_at = str(item.get("updated_at") or utc_now_iso())

                # Fetch requested_reviewers accurately when not authored by me
                req_reviewers: list[str] = []
                if repo_full and num > 0 and author.lower() != gh_login.lower():
                    try:
                        pr_detail = await client.get(
                            f"https://api.github.com/repos/{repo_full}/pulls/{num}",
                            headers=headers,
                        )
                        if pr_detail.status_code < 400:
                            pd = pr_detail.json()
                            req_reviewers = [
                                str(r.get("login") or "")
                                for r in (pd.get("requested_reviewers") or [])
                                if isinstance(r, dict)
                            ]
                    except Exception:
                        pass

                is_mine, ownership_reason = is_owned_github_item(
                    {
                        "author": author,
                        "assignees": assignees,
                        "requested_reviewers": req_reviewers,
                        "mentioned_me": False,
                    },
                    my_login=gh_login,
                )
                dedup_key = f"gh:pr:{repo_full}#{num}"
                if dedup_key in seen_pr_keys:
                    continue
                seen_pr_keys.add(dedup_key)

                events.append(
                    {
                        "source": "github",
                        "source_id": f"pr:{repo_full}#{num}",
                        "event_type": "pull_request",
                        "title": f"PR #{num}: {title}",
                        "summary": f"Author: @{author} · Ownership: {ownership_reason}",
                        "body": str(item.get("body") or "")[:1200],
                        "actor": author,
                        "url": pr_url,
                        "channel_or_repo": repo_full,
                        "priority": "P1" if is_mine else "P2",
                        "ownership_reason": ownership_reason,
                        "is_mine": is_mine,
                        "requires_action": is_mine,
                        "occurred_at": updated_at,
                    }
                )

                if ownership_reason in {"authored_by_me", "assigned_to_me"}:
                    tasks.append(
                        {
                            "dedup_key": dedup_key,
                            "bucket": "needed_from_me",
                            "priority": "P1",
                            "source": "github",
                            "source_ref": f"{repo_full}#{num}",
                            "source_url": pr_url,
                            "title": f"PR #{num}: {title}",
                            "description": f"Owned PR ({ownership_reason}) in {repo_full}.",
                            "owner": gh_login,
                            "repo": repo_full,
                            "task_kind": "code",
                            "ownership_reason": ownership_reason,
                        }
                    )
                elif ownership_reason == "direct_review_requested_private_summary_only":
                    tasks.append(
                        {
                            "dedup_key": f"gh:review:{repo_full}#{num}",
                            "bucket": "needed_from_me",
                            "priority": "P2",
                            "source": "github",
                            "source_ref": f"{repo_full}#{num}",
                            "source_url": pr_url,
                            "title": f"[Private Review Summary Only] PR #{num}: {title}",
                            "description": f"Review requested by @{author} on {repo_full}. Read-only private summary only.",
                            "owner": gh_login,
                            "counterparty": author,
                            "repo": repo_full,
                            "task_kind": "review",
                            "ownership_reason": ownership_reason,
                        }
                    )
                else:
                    tasks.append(
                        {
                            "dedup_key": f"gh:wait:{repo_full}#{num}",
                            "bucket": "waiting_on_others",
                            "priority": "P2",
                            "source": "github",
                            "source_ref": f"{repo_full}#{num}",
                            "source_url": pr_url,
                            "title": f"PR #{num} by @{author}: {title}",
                            "description": f"Teammate PR in {repo_full}.",
                            "owner": author or "teammate",
                            "counterparty": author,
                            "repo": repo_full,
                            "task_kind": "waiting",
                            "ownership_reason": "teammate_commitment",
                        }
                    )

    return {"source": "github", "events": events, "tasks": tasks, "meetings": []}


async def _collect_slack_native(
    client: httpx.AsyncClient,
    token: str,
    profile: dict[str, Any],
) -> dict[str, Any]:
    headers = {"Authorization": f"Bearer {token}"}
    self_uid = str(profile.get("slack_user_id") or "").strip()
    events: list[dict[str, Any]] = []
    tasks: list[dict[str, Any]] = []
    seen_ts: set[str] = set()

    conv_resp = await client.get(
        "https://slack.com/api/conversations.list",
        params={"types": "im,mpim", "limit": 15},
        headers=headers,
    )
    conv_data = conv_resp.json() if conv_resp.status_code < 400 else {}
    if conv_data.get("error") in {"invalid_auth", "token_revoked", "not_authed"}:
        raise PermissionError(f"Slack auth failed: {conv_data.get('error')}")

    channels = conv_data.get("channels") or []
    for ch in channels[:15]:
        cid = str(ch.get("id") or "")
        if not cid:
            continue
        hist_resp = await client.get(
            "https://slack.com/api/conversations.history",
            params={"channel": cid, "limit": 5},
            headers=headers,
        )
        if hist_resp.status_code >= 400:
            continue
        hdata = hist_resp.json()
        if not hdata.get("ok"):
            continue
        for msg in hdata.get("messages") or []:
            ts = str(msg.get("ts") or "")
            text = str(msg.get("text") or "").strip()
            user = str(msg.get("user") or msg.get("bot_id") or "slack-user")
            if not ts or not text or (self_uid and user == self_uid):
                continue
            key = f"{cid}:{ts}"
            if key in seen_ts:
                continue
            seen_ts.add(key)
            try:
                occurred_at = datetime.fromtimestamp(float(ts), tz=timezone.utc).isoformat()
            except Exception:
                occurred_at = utc_now_iso()
            events.append(
                {
                    "source": "slack",
                    "source_id": f"slack:dm:{key}",
                    "event_type": "dm",
                    "title": f"Slack DM from {user}",
                    "summary": text[:280],
                    "body": text[:2000],
                    "actor": user,
                    "channel_or_repo": cid,
                    "priority": "P1",
                    "ownership_reason": "direct_dm",
                    "is_mine": True,
                    "requires_action": True,
                    "occurred_at": occurred_at,
                }
            )
            tasks.append(
                {
                    "dedup_key": f"slack:dm:{key}",
                    "bucket": "needed_from_me",
                    "priority": "P1",
                    "source": "slack",
                    "source_ref": key,
                    "title": f"Reply to Slack DM from {user}: {text[:72]}",
                    "description": text[:500],
                    "counterparty": user,
                    "task_kind": "reply",
                    "ownership_reason": "direct_dm",
                }
            )

    # Optional search.messages for @mentions (user tokens only; bot tokens return not_allowed_token_type)
    try:
        search_resp = await client.get(
            "https://slack.com/api/search.messages",
            params={"query": "to:me", "count": 10},
            headers=headers,
        )
        if search_resp.status_code < 400:
            sdata = search_resp.json()
            if sdata.get("ok"):
                matches = ((sdata.get("messages") or {}).get("matches")) or []
                for m in matches:
                    ts = str(m.get("ts") or "")
                    cid = str((m.get("channel") or {}).get("id") or "")
                    cname = str((m.get("channel") or {}).get("name") or cid)
                    key = f"{cid}:{ts}"
                    if not ts or key in seen_ts:
                        continue
                    seen_ts.add(key)
                    text = str(m.get("text") or "").strip()
                    user = str(m.get("username") or m.get("user") or "teammate")
                    permalink = str(m.get("permalink") or "")
                    events.append(
                        {
                            "source": "slack",
                            "source_id": f"slack:mention:{key}",
                            "event_type": "mention",
                            "title": f"Slack @mention in #{cname} by {user}",
                            "summary": text[:280],
                            "body": text[:2000],
                            "actor": user,
                            "url": permalink,
                            "channel_or_repo": cname,
                            "priority": "P1",
                            "ownership_reason": "direct_mention",
                            "is_mine": True,
                            "requires_action": True,
                            "occurred_at": utc_now_iso(),
                        }
                    )
    except Exception:
        pass

    return {"source": "slack", "events": events, "tasks": tasks, "meetings": []}


async def _collect_gmail_native(client: httpx.AsyncClient, token: str) -> dict[str, Any]:
    headers = {"Authorization": f"Bearer {token}"}
    list_resp = await client.get(
        "https://gmail.googleapis.com/gmail/v1/users/me/messages",
        params={"q": "is:inbox newer_than:3d", "maxResults": 15},
        headers=headers,
    )
    if list_resp.status_code == 401:
        raise PermissionError("Gmail OAuth token expired/unauthorized (401).")
    if list_resp.status_code >= 400:
        return {"source": "gmail", "events": [], "tasks": [], "meetings": []}

    msg_refs = (list_resp.json() or {}).get("messages") or []

    async def _fetch_msg(mid: str) -> dict[str, Any] | None:
        r = await client.get(
            f"https://gmail.googleapis.com/gmail/v1/users/me/messages/{mid}",
            params=[("format", "metadata"), ("metadataHeaders", "Subject"), ("metadataHeaders", "From"), ("metadataHeaders", "Date")],
            headers=headers,
        )
        if r.status_code >= 400:
            return None
        return r.json()

    details = await asyncio.gather(*(_fetch_msg(str(m["id"])) for m in msg_refs[:15] if m.get("id")), return_exceptions=True)
    events: list[dict[str, Any]] = []
    tasks: list[dict[str, Any]] = []
    for d in details:
        if not isinstance(d, dict):
            continue
        mid = str(d.get("id") or "")
        snippet = str(d.get("snippet") or "")
        hdrs = {
            str(h.get("name") or "").lower(): str(h.get("value") or "")
            for h in ((d.get("payload") or {}).get("headers") or [])
            if isinstance(h, dict)
        }
        subject = hdrs.get("subject") or "(No Subject)"
        sender = hdrs.get("from") or ""
        is_unread = "UNREAD" in (d.get("labelIds") or [])
        events.append(
            {
                "source": "gmail",
                "source_id": f"gmail:{mid}",
                "event_type": "email",
                "title": subject,
                "summary": snippet[:300],
                "actor": sender,
                "url": f"https://mail.google.com/mail/u/0/#inbox/{mid}",
                "channel_or_repo": "inbox",
                "priority": "P1" if is_unread else "P2",
                "ownership_reason": "inbox_recipient",
                "is_mine": True,
                "requires_action": is_unread,
                "occurred_at": utc_now_iso(),
            }
        )
        if is_unread and ("gemini" in subject.lower() or "notes" in subject.lower() or "action" in snippet.lower()):
            tasks.append(
                {
                    "dedup_key": f"gmail:{mid}",
                    "bucket": "needed_from_me",
                    "priority": "P1",
                    "source": "gmail",
                    "source_ref": mid,
                    "source_url": f"https://mail.google.com/mail/u/0/#inbox/{mid}",
                    "title": f"Review email: {subject[:80]}",
                    "description": snippet[:400],
                    "counterparty": sender,
                    "task_kind": "reply",
                    "ownership_reason": "inbox_recipient",
                }
            )
    return {"source": "gmail", "events": events, "tasks": tasks, "meetings": []}


async def _collect_calendar_native(client: httpx.AsyncClient, token: str) -> dict[str, Any]:
    headers = {"Authorization": f"Bearer {token}"}
    now = datetime.now(timezone.utc)
    time_min = (now - timedelta(hours=12)).isoformat()
    time_max = (now + timedelta(hours=48)).isoformat()
    resp = await client.get(
        "https://www.googleapis.com/calendar/v3/calendars/primary/events",
        params={
            "timeMin": time_min,
            "timeMax": time_max,
            "singleEvents": "true",
            "orderBy": "startTime",
            "maxResults": 20,
        },
        headers=headers,
    )
    if resp.status_code == 401:
        raise PermissionError("Google Calendar OAuth token expired/unauthorized (401).")
    if resp.status_code >= 400:
        return {"source": "google-calendar", "events": [], "tasks": [], "meetings": []}

    events: list[dict[str, Any]] = []
    meetings: list[dict[str, Any]] = []
    for item in (resp.json() or {}).get("items") or []:
        eid = str(item.get("id") or "")
        if not eid:
            continue
        title = str(item.get("summary") or "Untitled Meeting")
        start_at = str((item.get("start") or {}).get("dateTime") or (item.get("start") or {}).get("date") or now.isoformat())
        end_at = str((item.get("end") or {}).get("dateTime") or (item.get("end") or {}).get("date") or start_at)
        meet_url = str(item.get("hangoutLink") or "")
        if not meet_url:
            for ep in ((item.get("conferenceData") or {}).get("entryPoints") or []):
                if ep.get("entryPointType") == "video" and ep.get("uri"):
                    meet_url = str(ep["uri"])
                    break
        attendees = [
            str(a.get("displayName") or a.get("email") or "")
            for a in (item.get("attendees") or [])
            if isinstance(a, dict) and (a.get("displayName") or a.get("email"))
        ]
        meetings.append(
            {
                "external_id": f"gcal:{eid}",
                "title": title,
                "start_at": start_at,
                "end_at": end_at,
                "attendees": attendees,
                "meet_url": meet_url,
                "transcript_status": "scheduled",
            }
        )
        events.append(
            {
                "source": "calendar",
                "source_id": f"gcal:{eid}",
                "event_type": "meeting",
                "title": title,
                "summary": f"{start_at} · {len(attendees)} attendee(s)",
                "actor": ", ".join(attendees[:4]),
                "url": meet_url or str(item.get("htmlLink") or ""),
                "channel_or_repo": "calendar",
                "priority": "P1",
                "ownership_reason": "calendar_invitee",
                "is_mine": True,
                "requires_action": False,
                "occurred_at": start_at,
            }
        )
    return {"source": "google-calendar", "events": events, "tasks": [], "meetings": meetings}


async def _collect_drive_native(client: httpx.AsyncClient, token: str) -> dict[str, Any]:
    headers = {"Authorization": f"Bearer {token}"}
    resp = await client.get(
        "https://www.googleapis.com/drive/v3/files",
        params={
            "pageSize": 15,
            "orderBy": "modifiedTime desc",
            "fields": "files(id,name,mimeType,webViewLink,modifiedTime,owners)",
        },
        headers=headers,
    )
    if resp.status_code == 401:
        raise PermissionError("Google Drive OAuth token expired/unauthorized (401).")
    if resp.status_code >= 400:
        return {"source": "google-drive", "events": [], "tasks": [], "meetings": []}

    events: list[dict[str, Any]] = []
    for f in (resp.json() or {}).get("files") or []:
        fid = str(f.get("id") or "")
        if not fid:
            continue
        owners = [str(o.get("displayName") or o.get("emailAddress") or "") for o in (f.get("owners") or []) if isinstance(o, dict)]
        events.append(
            {
                "source": "drive",
                "source_id": f"drive:{fid}",
                "event_type": "document",
                "title": str(f.get("name") or "Drive Document"),
                "summary": f"Modified {f.get('modifiedTime', '')} · {f.get('mimeType', '')}",
                "actor": ", ".join(o for o in owners if o),
                "url": str(f.get("webViewLink") or ""),
                "channel_or_repo": "google-drive",
                "priority": "P2",
                "ownership_reason": "shared_drive_file",
                "is_mine": True,
                "requires_action": False,
                "occurred_at": str(f.get("modifiedTime") or utc_now_iso()),
            }
        )
    return {"source": "google-drive", "events": events, "tasks": [], "meetings": []}


async def _collect_linear_native(client: httpx.AsyncClient, token: str) -> dict[str, Any]:
    auth_header = token if token.startswith("lin_api_") else f"Bearer {token}"
    query = """
    {
      viewer {
        id
        name
        email
        assignedIssues(first: 25, filter: { state: { type: { nin: ["completed", "canceled"] } } }) {
          nodes {
            id
            identifier
            title
            description
            priority
            url
            updatedAt
            state { name }
            team { key }
          }
        }
      }
    }
    """
    resp = await client.post(
        "https://api.linear.app/graphql",
        headers={"Authorization": auth_header, "Content-Type": "application/json"},
        json={"query": query},
    )
    if resp.status_code == 401:
        raise PermissionError("Linear API token unauthorized (401).")
    if resp.status_code >= 400:
        return {"source": "linear", "events": [], "tasks": [], "meetings": []}

    data = resp.json()
    viewer = ((data.get("data") or {}).get("viewer")) or {}
    nodes = ((viewer.get("assignedIssues") or {}).get("nodes")) or []
    viewer_name = str(viewer.get("name") or viewer.get("email") or "me")

    events: list[dict[str, Any]] = []
    tasks: list[dict[str, Any]] = []
    for issue in nodes:
        iid = str(issue.get("id") or "")
        ident = str(issue.get("identifier") or iid)
        title = str(issue.get("title") or "Linear Issue")
        desc = str(issue.get("description") or "")
        lin_prio = int(issue.get("priority") or 2)
        prio = "P0" if lin_prio == 1 else ("P1" if lin_prio == 2 else "P2")
        state_name = str((issue.get("state") or {}).get("name") or "Open")
        team_key = str((issue.get("team") or {}).get("key") or "linear")
        url = str(issue.get("url") or "")
        updated_at = str(issue.get("updatedAt") or utc_now_iso())

        events.append(
            {
                "source": "linear",
                "source_id": f"linear:{iid}",
                "event_type": "issue",
                "title": f"[{ident}] {title}",
                "summary": f"State: {state_name} · Team: {team_key}",
                "body": desc[:1000],
                "actor": viewer_name,
                "url": url,
                "channel_or_repo": team_key,
                "priority": prio,
                "ownership_reason": "assigned_to_me",
                "is_mine": True,
                "requires_action": True,
                "occurred_at": updated_at,
            }
        )
        tasks.append(
            {
                "dedup_key": f"linear:{iid}",
                "bucket": "needed_from_me",
                "priority": prio,
                "source": "linear",
                "source_ref": ident,
                "source_url": url,
                "title": f"[{ident}] {title}",
                "description": desc[:600] or f"Linear issue in {team_key} ({state_name}).",
                "owner": viewer_name,
                "repo": team_key,
                "task_kind": "code",
                "ownership_reason": "assigned_to_me",
            }
        )
    return {"source": "linear", "events": events, "tasks": tasks, "meetings": []}


def _extract_notion_title(page_obj: dict[str, Any]) -> str:
    props = page_obj.get("properties") or {}
    if isinstance(props, dict):
        for prop_val in props.values():
            if isinstance(prop_val, dict) and prop_val.get("type") == "title":
                parts = prop_val.get("title") or []
                txt = "".join(str(p.get("plain_text") or "") for p in parts if isinstance(p, dict)).strip()
                if txt:
                    return txt
    title_arr = page_obj.get("title") or []
    if isinstance(title_arr, list):
        txt = "".join(str(p.get("plain_text") or "") for p in title_arr if isinstance(p, dict)).strip()
        if txt:
            return txt
    return "Untitled Notion Page"


async def _collect_notion_native(client: httpx.AsyncClient, token: str) -> dict[str, Any]:
    resp = await client.post(
        "https://api.notion.com/v1/search",
        headers={
            "Authorization": f"Bearer {token}",
            "Notion-Version": "2022-06-28",
            "Content-Type": "application/json",
        },
        json={"sort": {"direction": "descending", "timestamp": "last_edited_time"}, "page_size": 15},
    )
    if resp.status_code == 401:
        raise PermissionError("Notion API token unauthorized (401).")
    if resp.status_code >= 400:
        return {"source": "notion", "events": [], "tasks": [], "meetings": []}

    events: list[dict[str, Any]] = []
    for item in (resp.json() or {}).get("results") or []:
        nid = str(item.get("id") or "")
        if not nid:
            continue
        title = _extract_notion_title(item)
        obj_type = str(item.get("object") or "page")
        edited = str(item.get("last_edited_time") or utc_now_iso())
        events.append(
            {
                "source": "notion",
                "source_id": f"notion:{nid}",
                "event_type": obj_type,
                "title": title,
                "summary": f"Notion {obj_type} updated {edited}",
                "actor": "Notion",
                "url": str(item.get("url") or ""),
                "channel_or_repo": "notion",
                "priority": "P2",
                "ownership_reason": "workspace_doc",
                "is_mine": True,
                "requires_action": False,
                "occurred_at": edited,
            }
        )
    return {"source": "notion", "events": events, "tasks": [], "meetings": []}


async def collect_native_integrations(profile: dict[str, Any]) -> dict[str, Any]:
    """
    Zero-CLI native REST/GraphQL collector sweep across GitHub, Slack, Gmail, Calendar, Drive, Linear, and Notion.
    Cleanly skips any integration without stored credentials or disabled in Settings.
    """
    pid = str(profile.get("id") or OWNER_PROFILE_ID)
    enabled_ids = _enabled_integration_ids()

    def _is_enabled(int_id: str) -> bool:
        return not enabled_ids or int_id in enabled_ids

    all_events: list[dict[str, Any]] = []
    all_tasks: list[dict[str, Any]] = []
    all_meetings: list[dict[str, Any]] = []
    synced_sources: list[str] = []
    errors: dict[str, str] = {}

    async with httpx.AsyncClient(timeout=15.0) as client:
        coros: list[tuple[str, Any]] = []

        gh_tok = resolve_integration_token("github", pid) if _is_enabled("github") else ""
        if gh_tok:
            coros.append(("github", _collect_github_native(client, gh_tok, profile)))

        slack_tok = resolve_integration_token("slack", pid) if _is_enabled("slack") else ""
        if slack_tok:
            coros.append(("slack", _collect_slack_native(client, slack_tok, profile)))

        gmail_tok = resolve_integration_token("gmail", pid) if _is_enabled("gmail") else ""
        if gmail_tok:
            coros.append(("gmail", _collect_gmail_native(client, gmail_tok)))

        cal_tok = resolve_integration_token("google-calendar", pid) if _is_enabled("google-calendar") else ""
        if cal_tok:
            coros.append(("google-calendar", _collect_calendar_native(client, cal_tok)))

        drive_tok = resolve_integration_token("google-drive", pid) if _is_enabled("google-drive") else ""
        if drive_tok:
            coros.append(("google-drive", _collect_drive_native(client, drive_tok)))

        lin_tok = resolve_integration_token("linear", pid) if _is_enabled("linear") else ""
        if lin_tok:
            coros.append(("linear", _collect_linear_native(client, lin_tok)))

        not_tok = resolve_integration_token("notion", pid) if _is_enabled("notion") else ""
        if not_tok:
            coros.append(("notion", _collect_notion_native(client, not_tok)))

        if coros:
            results = await asyncio.gather(*(c for _, c in coros), return_exceptions=True)
            for (src_name, _), res in zip(coros, results):
                if isinstance(res, Exception):
                    errors[src_name] = redact_secrets(str(res))
                    continue
                all_events.extend(res.get("events") or [])
                all_tasks.extend(res.get("tasks") or [])
                all_meetings.extend(res.get("meetings") or [])
                synced_sources.append(src_name)

    return {
        "events": all_events,
        "tasks": all_tasks,
        "meetings": all_meetings,
        "synced_sources": synced_sources,
        "errors": errors,
    }


# ---------------------------------------------------------------------------
# Native Outbound Senders (Synchronous httpx for Approval Studio & Self-DM)
# ---------------------------------------------------------------------------


def send_slack_message_native(
    token: str,
    channel_id: str,
    text: str,
    thread_ts: str | None = None,
) -> dict[str, Any]:
    body: dict[str, Any] = {"channel": channel_id, "text": text}
    if thread_ts:
        body["thread_ts"] = str(thread_ts)
    with httpx.Client(timeout=20.0) as client:
        resp = client.post(
            "https://slack.com/api/chat.postMessage",
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            json=body,
        )
    data = resp.json() if resp.content else {}
    ok = resp.status_code < 400 and bool(data.get("ok"))
    return {
        "ok": ok,
        "status_code": resp.status_code,
        "channel": data.get("channel") or channel_id,
        "ts": data.get("ts") or "",
        "error": "" if ok else str(data.get("error") or resp.text[:240]),
    }


def post_github_pr_comment_native(
    token: str,
    repo_full: str,
    pr_number: int,
    body: str,
    comment_id: int | None = None,
) -> dict[str, Any]:
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    if comment_id is not None:
        url = f"https://api.github.com/repos/{repo_full}/pulls/{pr_number}/comments/{int(comment_id)}/replies"
    else:
        url = f"https://api.github.com/repos/{repo_full}/issues/{pr_number}/comments"

    with httpx.Client(timeout=20.0) as client:
        resp = client.post(url, headers=headers, json={"body": body})
    data = resp.json() if resp.content else {}
    ok = resp.status_code < 400
    return {
        "ok": ok,
        "status_code": resp.status_code,
        "id": data.get("id"),
        "html_url": data.get("html_url") or "",
        "error": "" if ok else redact_secrets(resp.text[:300]),
    }


def create_github_pr_native(
    token: str,
    repo_full: str,
    title: str,
    body: str,
    head: str,
    base: str = "main",
    draft: bool = False,
) -> dict[str, Any]:
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    with httpx.Client(timeout=25.0) as client:
        resp = client.post(
            f"https://api.github.com/repos/{repo_full}/pulls",
            headers=headers,
            json={
                "title": title,
                "body": body,
                "head": head,
                "base": base,
                "draft": bool(draft),
            },
        )
    data = resp.json() if resp.content else {}
    ok = resp.status_code < 400
    return {
        "ok": ok,
        "status_code": resp.status_code,
        "number": data.get("number"),
        "pr_url": data.get("html_url") or "",
        "error": "" if ok else redact_secrets(resp.text[:300]),
    }


def send_gmail_message_native(
    token: str,
    to_addr: str,
    subject: str,
    body_text: str,
    thread_id: str | None = None,
) -> dict[str, Any]:
    msg = EmailMessage()
    msg["To"] = to_addr
    msg["Subject"] = subject
    msg.set_content(body_text)
    raw_b64 = base64.urlsafe_b64encode(msg.as_bytes()).decode("ascii")
    payload: dict[str, Any] = {"raw": raw_b64}
    if thread_id:
        payload["threadId"] = str(thread_id)

    with httpx.Client(timeout=20.0) as client:
        resp = client.post(
            "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            json=payload,
        )
    data = resp.json() if resp.content else {}
    ok = resp.status_code < 400
    return {
        "ok": ok,
        "status_code": resp.status_code,
        "id": data.get("id") or "",
        "threadId": data.get("threadId") or "",
        "error": "" if ok else redact_secrets(resp.text[:300]),
    }
