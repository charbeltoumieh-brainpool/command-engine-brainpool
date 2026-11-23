from __future__ import annotations

import ctypes
import os
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

try:
    import dotenv
except ImportError:
    dotenv = None  # type: ignore[assignment]


BACKEND_DIR = Path(__file__).resolve().parents[1]
PROJECT_ROOT = Path(__file__).resolve().parents[2]

if dotenv is not None:
    dotenv.load_dotenv(PROJECT_ROOT / ".env", override=False)
    dotenv.load_dotenv(BACKEND_DIR / ".env", override=False)


def _resolve_workspace_root() -> Path:
    env_root = os.environ.get("COMMAND_ENGINE_WORKSPACE")
    if env_root:
        return Path(env_root).expanduser().resolve()
    if getattr(sys, "frozen", False):
        if sys.platform == "darwin":
            return (Path.home() / "Library" / "Application Support" / "Command Engine").resolve()
        if sys.platform == "win32":
            local_app_data = os.environ.get("LOCALAPPDATA")
            base = Path(local_app_data) if local_app_data else (Path.home() / "AppData" / "Local")
            return (base / "Command Engine").resolve()
        xdg_data = os.environ.get("XDG_DATA_HOME")
        base = Path(xdg_data).expanduser() if xdg_data else (Path.home() / ".local" / "share")
        return (base / "command-engine").resolve()
    return PROJECT_ROOT


WORKSPACE_ROOT = _resolve_workspace_root()
DATA_DIR = WORKSPACE_ROOT / "data"
WORKTREES_DIR = WORKSPACE_ROOT / ".worktrees"
LOCAL_STAGE_DIR = WORKSPACE_ROOT / ".local"
_DEFAULT_LOCAL_STAGE_DIR = LOCAL_STAGE_DIR
DB_PATH = DATA_DIR / "command_engine.db"

USER_HOME = Path(os.environ.get("COMMAND_ENGINE_USER_HOME") or Path.home())
DESKTOP_DIR = USER_HOME / "Desktop"
DOCUMENTS_DIR = USER_HOME / "Documents"
DOWNLOADS_DIR = USER_HOME / "Downloads"
ONEDRIVE_DIR = USER_HOME / "OneDrive"

GITHUB_ORG = os.environ.get("GITHUB_ORG", "")
GITHUB_USER = os.environ.get("GITHUB_USER", "")
GOOGLE_EMAIL = os.environ.get("GOOGLE_EMAIL", "")
SLACK_SELF_USER_ID = os.environ.get("SLACK_SELF_USER_ID", "")
_proj_num_raw = os.environ.get("PRIMARY_GITHUB_PROJECT_NUMBER", "").strip()
PRIMARY_GITHUB_PROJECT_NUMBER: int | None = int(_proj_num_raw) if _proj_num_raw.isdigit() else None
PRIMARY_GITHUB_PROJECT_VIEW = os.environ.get("PRIMARY_GITHUB_PROJECT_VIEW", "")
DEV_VM_SSH_HOST = os.environ.get("DEV_VM_SSH_HOST", "")

CORE_REPOS: dict[str, dict[str, str]] = {}
READONLY_GKE_CONTEXTS: list[str] = []
READONLY_GCP_PROJECTS: list[str] = []
GKE_CONTEXTS: list[str] = READONLY_GKE_CONTEXTS
GCP_PROJECTS: list[str] = READONLY_GCP_PROJECTS
DEFAULT_VIP_PEOPLE: list[str] = []

MODEL_ORCHESTRATOR = os.environ.get("OPENAI_MODEL", "gpt-4o-mini")
MODEL_WORKER = os.environ.get("OPENAI_MODEL", "gpt-4o-mini")
MODEL_FAST = os.environ.get("OPENAI_MODEL", "gpt-4o-mini")
MODEL_EMBEDDING = os.environ.get("OPENAI_EMBEDDING_MODEL", "text-embedding-3-small")
WORKER_REASONING_EFFORT = os.environ.get("WORKER_REASONING_EFFORT", "medium")
DEFAULT_GATEWAY_BASE_URL = os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1").strip().rstrip("/") or "https://api.openai.com/v1"
WORKSPACE_REPOS_DIR = os.environ.get("WORKSPACE_REPOS_DIR", "")

BACKEND_HOST = os.environ.get("BACKEND_HOST", "127.0.0.1")
BACKEND_PORT = int(os.environ.get("BACKEND_PORT", "8085"))
FRONTEND_ORIGIN = os.environ.get("FRONTEND_ORIGIN", "http://127.0.0.1:5179")
FRONTEND_PORT = int(os.environ.get("FRONTEND_PORT", "5179"))

STAFF_ROSTER: list[dict[str, str]] = [
    {
        "id": "chief-of-staff",
        "role": "Executive Chief of Staff & Lead Architect",
        "model": MODEL_ORCHESTRATOR,
        "department": "Executive Office",
        "responsibilities": "Cross-channel synthesis, priority ranking, architecture review, final verification, and Q&A",
    },
    {
        "id": "slack-scout",
        "role": "Communications & Thread Scout",
        "model": MODEL_WORKER,
        "department": "Communications",
        "responsibilities": "Direct messages, mentions, active threads, VIP prioritization, and draft replies",
    },
    {
        "id": "gmail-calendar-scout",
        "role": "Inbox, Schedule & Transcript Watcher",
        "model": MODEL_WORKER,
        "department": "Inbox & Calendar",
        "responsibilities": "Inbox triage, calendar prep briefs, and post-call meeting notes detection",
    },
    {
        "id": "drive-transcript-analyst",
        "role": "Docs & Call Transcripts Analyst",
        "model": MODEL_WORKER,
        "department": "Meetings & Docs",
        "responsibilities": "Document comments, separating personal action items from waiting items, and follow-up staging",
    },
    {
        "id": "github-staff-engineer",
        "role": "GitHub & Isolated Worktree Engineer",
        "model": MODEL_WORKER,
        "department": "Engineering",
        "responsibilities": "Owned PRs and issues, isolated worktree changes, allowlisted tests, and PR staging",
    },
    {
        "id": "local-archivist",
        "role": "Local Workspace & WIP Archivist",
        "model": MODEL_WORKER,
        "department": "Workspace",
        "responsibilities": "Uncommitted local branches, local staged drafts, and workspace indexing",
    },
    {
        "id": "sre-readonly-scout",
        "role": "Cloud & Cluster Observer (Read-Only)",
        "model": MODEL_WORKER,
        "department": "Infrastructure",
        "responsibilities": "Read-only cluster pod health, crash logs, cloud logs, and trace inspection",
    },
]

DEFAULT_AUTONOMY_POLICIES: list[tuple[str, str, str, str, int, str]] = [
    (
        "slack_self_dm",
        "Slack Self-DM Alerts",
        "Notifications",
        "auto",
        0,
        "Send briefings, post-call summaries, and urgent P0 alerts only to your configured Slack user ID.",
    ),
    (
        "local_triage_and_labels",
        "Auto-Organize, Label & Local Drafts",
        "Organization",
        "auto",
        0,
        "Apply safe triage labels, index memory vectors, and prepare local drafts without sending.",
    ),
    (
        "worktree_local_code",
        "Isolated Worktree Coding & Local Tests",
        "Engineering",
        "auto",
        0,
        "Create isolated git worktrees for owned PRs or issues and run allowlisted verification commands.",
    ),
    (
        "git_push",
        "Git Push to Remote Branches",
        "Engineering",
        "ask_first",
        0,
        "Push committed fixes from isolated worktrees to remote branches. Gated for approval.",
    ),
    (
        "github_pr_create",
        "Create New GitHub Pull Requests",
        "Engineering",
        "ask_first",
        0,
        "Open new draft or ready Pull Requests for assigned issues or commitments. Gated for approval.",
    ),
    (
        "github_pr_reply",
        "Post GitHub PR Replies & Resolve Threads",
        "Engineering",
        "ask_first",
        0,
        "Post drafted top-level and inline review replies on owned Pull Requests. Gated for approval.",
    ),
    (
        "github_board_move",
        "Move GitHub Project Board Status",
        "Engineering",
        "ask_first",
        0,
        "Update board status for owned PRs or issues on your configured GitHub project board. Gated for approval.",
    ),
    (
        "slack_send_external",
        "Send Slack Messages to Channels / Teammates",
        "Communications",
        "ask_first",
        0,
        "Send replies or post-meeting recaps to Slack channels or teammates. Strictly gated.",
    ),
    (
        "gmail_send_external",
        "Send / Reply to Emails in Gmail",
        "Communications",
        "ask_first",
        0,
        "Send outbound emails or replies from your configured email account. Strictly gated.",
    ),
    (
        "drive_comment_or_edit",
        "Reply to Google Drive Comments / Edit Docs",
        "Documents",
        "ask_first",
        0,
        "Post comment replies or resolve comment threads in Google Docs, Sheets, or Slides.",
    ),
    (
        "gke_gcp_phoenix",
        "GKE, GCP Logs & Trace Inspection (Read-Only)",
        "Infrastructure",
        "read_only_locked",
        1,
        "Read-only lock: inspect pod health, logs, and traces. Mutation commands are permanently blocked.",
    ),
]


@dataclass(frozen=True)
class GatewayCredentials:
    base_url: str
    api_key: str
    configured: bool = False


def load_gateway_credentials(base_url_override: str | None = None) -> GatewayCredentials:
    """Load OpenAI-compatible gateway base URL and API key exclusively from environment variables."""
    base_url = (base_url_override or os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1")).strip().rstrip("/")
    if not base_url:
        base_url = "https://api.openai.com/v1"
    api_key = os.environ.get("OPENAI_API_KEY", "").strip()
    return GatewayCredentials(
        base_url=base_url,
        api_key=api_key,
        configured=bool(api_key),
    )


_SAFE_SECRET_ID_RE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9._-]{0,120}$")
_KEYCHAIN_SERVICE = "CommandEngine"


def _is_isolated_test_vault() -> bool:
    if os.environ.get("PYTEST_CURRENT_TEST"):
        return True
    try:
        return LOCAL_STAGE_DIR.resolve() != _DEFAULT_LOCAL_STAGE_DIR.resolve()
    except OSError:
        return True


def _os_keychain_store(sid: str, value: str) -> bool:
    if sys.platform == "darwin" and shutil.which("security"):
        try:
            proc = subprocess.run(
                [
                    "security",
                    "add-generic-password",
                    "-U",
                    "-a",
                    sid,
                    "-s",
                    _KEYCHAIN_SERVICE,
                    "-w",
                    value,
                ],
                capture_output=True,
                text=True,
                check=False,
                timeout=5,
            )
            return proc.returncode == 0
        except Exception:
            return False

    if sys.platform.startswith("linux"):
        try:
            import keyring  # type: ignore[import-not-found]

            keyring.set_password(_KEYCHAIN_SERVICE, sid, value)
            return True
        except Exception:
            pass
        if shutil.which("secret-tool"):
            try:
                proc = subprocess.run(
                    [
                        "secret-tool",
                        "store",
                        "--label=Command Engine Secret",
                        "service",
                        _KEYCHAIN_SERVICE,
                        "account",
                        sid,
                    ],
                    input=value,
                    capture_output=True,
                    text=True,
                    check=False,
                    timeout=5,
                )
                return proc.returncode == 0
            except Exception:
                return False
    return False


def _os_keychain_read(sid: str) -> str:
    if sys.platform == "darwin" and shutil.which("security"):
        try:
            proc = subprocess.run(
                [
                    "security",
                    "find-generic-password",
                    "-a",
                    sid,
                    "-s",
                    _KEYCHAIN_SERVICE,
                    "-w",
                ],
                capture_output=True,
                text=True,
                check=False,
                timeout=5,
            )
            if proc.returncode == 0:
                return (proc.stdout or "").strip()
        except Exception:
            return ""
        return ""

    if sys.platform.startswith("linux"):
        try:
            import keyring  # type: ignore[import-not-found]

            found = keyring.get_password(_KEYCHAIN_SERVICE, sid)
            if found:
                return str(found).strip()
        except Exception:
            pass
        if shutil.which("secret-tool"):
            try:
                proc = subprocess.run(
                    [
                        "secret-tool",
                        "lookup",
                        "service",
                        _KEYCHAIN_SERVICE,
                        "account",
                        sid,
                    ],
                    capture_output=True,
                    text=True,
                    check=False,
                    timeout=5,
                )
                if proc.returncode == 0:
                    return (proc.stdout or "").strip()
            except Exception:
                return ""
    return ""


def _os_keychain_delete(sid: str) -> None:
    if sys.platform == "darwin" and shutil.which("security"):
        try:
            subprocess.run(
                ["security", "delete-generic-password", "-a", sid, "-s", _KEYCHAIN_SERVICE],
                capture_output=True,
                text=True,
                check=False,
                timeout=5,
            )
        except Exception:
            pass
        return

    if sys.platform.startswith("linux"):
        try:
            import keyring  # type: ignore[import-not-found]

            keyring.delete_password(_KEYCHAIN_SERVICE, sid)
        except Exception:
            pass
        if shutil.which("secret-tool"):
            try:
                subprocess.run(
                    [
                        "secret-tool",
                        "clear",
                        "service",
                        _KEYCHAIN_SERVICE,
                        "account",
                        sid,
                    ],
                    capture_output=True,
                    text=True,
                    check=False,
                    timeout=5,
                )
            except Exception:
                pass


def credentials_dir() -> Path:
    """Return the workspace-local `.local/credentials` directory."""
    cred_dir = LOCAL_STAGE_DIR / "credentials"
    cred_dir.mkdir(parents=True, exist_ok=True)
    if os.name != "nt":
        try:
            os.chmod(cred_dir, 0o700)
        except OSError:
            pass
    return cred_dir


def _validate_secret_id(secret_id: str) -> str:
    cleaned = (secret_id or "").strip()
    if not cleaned or ".." in cleaned or not _SAFE_SECRET_ID_RE.match(cleaned):
        raise ValueError(f"Invalid secret identifier '{secret_id}'.")
    return cleaned


def _dpapi_protect(plaintext: bytes) -> bytes:
    if sys.platform != "win32":
        raise RuntimeError("DPAPI is only available on Windows.")
    from ctypes import wintypes

    class _DATA_BLOB(ctypes.Structure):
        _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_byte))]

    crypt32 = ctypes.windll.crypt32
    kernel32 = ctypes.windll.kernel32
    buf = ctypes.create_string_buffer(plaintext, len(plaintext))
    blob_in = _DATA_BLOB(len(plaintext), ctypes.cast(buf, ctypes.POINTER(ctypes.c_byte)))
    blob_out = _DATA_BLOB()
    ok = crypt32.CryptProtectData(
        ctypes.byref(blob_in),
        "CommandEngineSecret",
        None,
        None,
        None,
        0x01,
        ctypes.byref(blob_out),
    )
    if not ok:
        raise OSError("Windows DPAPI CryptProtectData failed.")
    try:
        return ctypes.string_at(blob_out.pbData, blob_out.cbData)
    finally:
        if blob_out.pbData:
            kernel32.LocalFree(blob_out.pbData)


def _dpapi_unprotect(ciphertext: bytes) -> bytes:
    if sys.platform != "win32":
        raise RuntimeError("DPAPI is only available on Windows.")
    from ctypes import wintypes

    class _DATA_BLOB(ctypes.Structure):
        _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_byte))]

    crypt32 = ctypes.windll.crypt32
    kernel32 = ctypes.windll.kernel32
    buf = ctypes.create_string_buffer(ciphertext, len(ciphertext))
    blob_in = _DATA_BLOB(len(ciphertext), ctypes.cast(buf, ctypes.POINTER(ctypes.c_byte)))
    blob_out = _DATA_BLOB()
    ok = crypt32.CryptUnprotectData(
        ctypes.byref(blob_in),
        None,
        None,
        None,
        None,
        0x01,
        ctypes.byref(blob_out),
    )
    if not ok:
        raise OSError("Windows DPAPI CryptUnprotectData failed.")
    try:
        return ctypes.string_at(blob_out.pbData, blob_out.cbData)
    finally:
        if blob_out.pbData:
            kernel32.LocalFree(blob_out.pbData)


def store_secret(secret_id: str, plaintext: str) -> Path:
    """Encrypt and persist a secret locally using the best platform-native backend."""
    sid = _validate_secret_id(secret_id)
    value = (plaintext or "").strip()
    if not value:
        raise ValueError("Secret value cannot be empty.")

    cdir = credentials_dir()
    legacy_path = (cdir / f"{sid}.secret").resolve()
    dpapi_path = (cdir / f"{sid}.dpapi").resolve()
    keychain_path = (cdir / f"{sid}.keychain").resolve()
    cdir_resolved = cdir.resolve()
    if (
        not legacy_path.is_relative_to(cdir_resolved)
        or not dpapi_path.is_relative_to(cdir_resolved)
        or not keychain_path.is_relative_to(cdir_resolved)
    ):
        raise ValueError("Path traversal blocked.")

    if sys.platform == "win32":
        encrypted = _dpapi_protect(value.encode("utf-8"))
        dpapi_path.write_bytes(encrypted)
        if legacy_path.exists():
            try:
                legacy_path.unlink()
            except OSError:
                pass
        return dpapi_path

    if not _is_isolated_test_vault() and _os_keychain_store(sid, value):
        if legacy_path.exists():
            try:
                legacy_path.unlink()
            except OSError:
                pass
        keychain_path.write_text("keychain-managed\n", encoding="utf-8")
        try:
            os.chmod(keychain_path, 0o600)
        except OSError:
            pass
        return keychain_path

    legacy_path.write_text(value, encoding="utf-8")
    try:
        os.chmod(legacy_path, 0o600)
    except OSError:
        pass
    return legacy_path


def read_secret(secret_id: str) -> str:
    """Read a stored secret, transparently supporting DPAPI, OS Keychain/SecretService, and `.secret` fallback."""
    sid = _validate_secret_id(secret_id)
    if sys.platform != "win32" and not _is_isolated_test_vault():
        kc_val = _os_keychain_read(sid)
        if kc_val:
            return kc_val

    cdir = LOCAL_STAGE_DIR / "credentials"
    if not cdir.exists():
        return ""

    dpapi_path = (cdir / f"{sid}.dpapi").resolve()
    legacy_path = (cdir / f"{sid}.secret").resolve()
    cdir_resolved = cdir.resolve()
    if not dpapi_path.is_relative_to(cdir_resolved) or not legacy_path.is_relative_to(cdir_resolved):
        return ""

    if sys.platform == "win32" and dpapi_path.exists():
        try:
            raw = _dpapi_unprotect(dpapi_path.read_bytes())
            return raw.decode("utf-8", errors="replace").strip()
        except Exception:
            pass

    if legacy_path.exists():
        try:
            return legacy_path.read_text(encoding="utf-8").strip()
        except Exception:
            pass
    return ""


def delete_secret(secret_id: str) -> None:
    sid = _validate_secret_id(secret_id)
    if sys.platform != "win32" and not _is_isolated_test_vault():
        _os_keychain_delete(sid)
    cdir = LOCAL_STAGE_DIR / "credentials"
    if not cdir.exists():
        return
    for ext in (".dpapi", ".secret", ".keychain"):
        p = cdir / f"{sid}{ext}"
        if p.exists():
            try:
                p.unlink()
            except OSError:
                pass


def mask_secret(secret: str) -> str:
    s = (secret or "").strip()
    if not s:
        return ""
    if len(s) <= 8:
        return "••••••••"
    return f"{s[:4]}••••{s[-3:]}"


def ensure_directories() -> None:
    for directory in (DATA_DIR, WORKTREES_DIR, LOCAL_STAGE_DIR, DATA_DIR / "backups"):
        directory.mkdir(parents=True, exist_ok=True)
