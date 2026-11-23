from __future__ import annotations

import re
import shlex
from pathlib import Path
from typing import Any

from .config import GITHUB_USER, SLACK_SELF_USER_ID

# Strictly read-only kubectl and gcloud subcommands
ALLOWED_KUBECTL_VERBS = frozenset({"get", "describe", "logs", "top", "version", "config", "api-resources", "events"})
FORBIDDEN_INFRA_TOKENS = frozenset(
    {
        "apply",
        "delete",
        "patch",
        "edit",
        "replace",
        "create",
        "scale",
        "rollout",
        "cordon",
        "drain",
        "taint",
        "exec",
        "cp",
        "port-forward",
        "autoscale",
        "expose",
        "run",
        "set",
        "label",
        "annotate",
        "deploy",
        "destroy",
    }
)

WINDOWS_RESERVED_NAMES = frozenset(
    {
        "CON",
        "PRN",
        "AUX",
        "NUL",
        *(f"COM{i}" for i in range(1, 10)),
        *(f"LPT{i}" for i in range(1, 10)),
    }
)

ALLOWED_TEST_BINARIES = frozenset({"uv", "pytest", "python", "npm", "npx", "cargo", "git"})
SHELL_METACHAR_RE = re.compile(r"[;&|`$><\r\n]")
SAFE_GIT_REF_RE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,120}$")
SAFE_SLUG_ID_RE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9._-]{0,80}$")

SECRET_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"sk-[A-Za-z0-9_-]{14,}"), "[REDACTED:API_KEY]"),
    (re.compile(r"xox[baprs]-[A-Za-z0-9-]{10,}"), "[REDACTED:SLACK_TOKEN]"),
    (re.compile(r"gh[pousr]_[A-Za-z0-9_]{16,}"), "[REDACTED:GITHUB_TOKEN]"),
    (re.compile(r"github_pat_[A-Za-z0-9_]{16,}"), "[REDACTED:GITHUB_PAT]"),
    (re.compile(r"ya29\.[A-Za-z0-9_.-]{16,}"), "[REDACTED:GOOGLE_TOKEN]"),
    (re.compile(r"(?i)Bearer\s+[A-Za-z0-9._~+/=-]{14,}"), "Bearer [REDACTED:TOKEN]"),
]


class SafetyViolationError(PermissionError):
    """Raised whenever an agent or caller attempts an action violating safety/ownership rules."""


def redact_secrets(text: str) -> str:
    """Scrub secret tokens and bearer headers before persisting logs, traces, or diagnostic exports."""
    if not text:
        return ""
    cleaned = str(text)
    for pattern, replacement in SECRET_PATTERNS:
        cleaned = pattern.sub(replacement, cleaned)
    return cleaned


def redact_structure(value: Any) -> Any:
    """Recursively scrub secrets from dicts/lists before logging or diagnostic export."""
    if isinstance(value, str):
        return redact_secrets(value)
    if isinstance(value, dict):
        out: dict[str, Any] = {}
        for k, v in value.items():
            key_lower = str(k).lower()
            if any(tok in key_lower for tok in ("token", "secret", "api_key", "apikey", "password", "authorization")):
                out[k] = "[REDACTED]" if v else ""
            else:
                out[k] = redact_structure(v)
        return out
    if isinstance(value, list):
        return [redact_structure(item) for item in value]
    return value


def wrap_untrusted_content(source: str, text: str) -> str:
    """Isolate external Slack/email/Drive/GitHub/transcript content against indirect prompt injection."""
    safe_src = re.sub(r"[^a-zA-Z0-9_-]", "", source or "external")[:32] or "external"
    sanitized = (text or "").replace("</untrusted_external_content>", "[escaped-tag]")
    return (
        f'<untrusted_external_content source="{safe_src}">\n'
        f"{sanitized}\n"
        f"</untrusted_external_content>"
    )


def resolve_safe_child(base_dir: Path, *parts: str, suffix: str = "") -> Path:
    """Resolve child path inside base_dir, blocking traversal, reserved Windows names, and escaping symlinks."""
    base = base_dir.resolve()
    cleaned_parts: list[str] = []
    for part in parts:
        p = str(part or "").strip()
        if not p or "\x00" in p or "/" in p or "\\" in p or p in {".", ".."}:
            raise SafetyViolationError(f"Unsafe path segment rejected: {part!r}")
        stem = p.split(".")[0].upper()
        if stem in WINDOWS_RESERVED_NAMES:
            raise SafetyViolationError(f"Reserved Windows device filename rejected: {part!r}")
        cleaned_parts.append(p)

    target = base.joinpath(*cleaned_parts)
    if suffix and not target.name.endswith(suffix):
        target = target.with_name(target.name + suffix)
    resolved = target.resolve()

    if resolved != base and not resolved.is_relative_to(base):
        raise SafetyViolationError(f"Path traversal blocked: '{resolved}' escapes '{base}'.")

    for candidate in (target, *target.parents):
        if candidate == base or not candidate.exists():
            if candidate == base:
                break
            continue
        if candidate.is_symlink():
            link_target = candidate.resolve()
            if link_target != base and not link_target.is_relative_to(base):
                raise SafetyViolationError(f"Symlink escape blocked: '{candidate}'.")
    return resolved


def validate_git_ref(ref: str, field_name: str = "branch") -> str:
    cleaned = (ref or "").strip()
    if (
        not cleaned
        or cleaned.startswith("-")
        or ".." in cleaned
        or "@{" in cleaned
        or not SAFE_GIT_REF_RE.match(cleaned)
    ):
        raise SafetyViolationError(f"Unsafe git {field_name} rejected: {ref!r}")
    return cleaned


def validate_worktree_test_command(cmd_str: str) -> list[str]:
    """Parse and allowlist worktree verification commands; blocks shell chaining and arbitrary binaries."""
    raw = (cmd_str or "").strip()
    if not raw:
        raise SafetyViolationError("Empty test command.")
    if SHELL_METACHAR_RE.search(raw):
        raise SafetyViolationError(
            "Test command contains disallowed shell metacharacters (;, &, |, `, $, >, <). "
            "Only single allowlisted verification commands are permitted."
        )
    try:
        argv = shlex.split(raw, posix=True)
    except ValueError as exc:
        raise SafetyViolationError(f"Invalid command quoting: {exc}") from exc

    if not argv:
        raise SafetyViolationError("Empty parsed test command.")
    exe = Path(argv[0]).stem.lower()
    if exe not in ALLOWED_TEST_BINARIES:
        raise SafetyViolationError(
            f"Executable '{argv[0]}' is not in the safe verification allowlist {sorted(ALLOWED_TEST_BINARIES)}."
        )
    if exe == "git":
        if len(argv) < 2 or argv[1] not in {"status", "diff", "log", "rev-parse"}:
            raise SafetyViolationError("Only read-only git subcommands (status, diff, log) are allowed in test runner.")
    if exe == "python":
        if len(argv) < 3 or argv[1] != "-m" or argv[2] not in {"pytest", "unittest", "ruff", "mypy"}:
            raise SafetyViolationError("Python test runner only allows '-m pytest|unittest|ruff|mypy'.")
    return argv


def assert_slack_self_dm_only(
    target_channel_or_user: str,
    allowed_self_id: str | None = None,
) -> None:
    """Hard guardrail: automated Slack alerts may ONLY go to the authenticated principal's own Slack user ID."""
    expected = (allowed_self_id if allowed_self_id is not None else SLACK_SELF_USER_ID).strip()
    cleaned = (target_channel_or_user or "").strip()
    if not expected or cleaned != expected:
        raise SafetyViolationError(
            f"Automated Slack send blocked: target '{cleaned}' is not the principal's Self-DM ({expected or 'unconfigured'}). "
            "All external/channel Slack messages must go through Approval Studio."
        )


def validate_readonly_infra_command(argv: list[str]) -> None:
    """Enforce 100% read-only guardrail on kubectl / gcloud commands."""
    if not argv:
        raise SafetyViolationError("Empty infrastructure command.")
    lowered = [tok.lower().strip() for tok in argv]
    exe = lowered[0]
    for tok in lowered[1:]:
        base_tok = tok.split("=", 1)[0]
        if tok in FORBIDDEN_INFRA_TOKENS or base_tok in FORBIDDEN_INFRA_TOKENS:
            raise SafetyViolationError(f"Blocked mutating/interactive infra token '{tok}' in read-only mode.")

    if "kubectl" in exe:
        idx = 1
        flags_with_arg = {
            "--context",
            "-n",
            "--namespace",
            "--kubeconfig",
            "-o",
            "--output",
            "--tail",
            "--since",
            "--selector",
            "-l",
            "--field-selector",
        }
        while idx < len(lowered):
            tok = lowered[idx]
            if tok in flags_with_arg:
                idx += 2
                continue
            if tok.startswith("-"):
                idx += 1
                continue
            if tok not in ALLOWED_KUBECTL_VERBS:
                raise SafetyViolationError(
                    f"kubectl verb '{tok}' is not in the strict read-only allowlist {sorted(ALLOWED_KUBECTL_VERBS)}."
                )
            return
        raise SafetyViolationError("Could not verify read-only kubectl verb.")

    if "gcloud" in exe:
        joined = " ".join(lowered[1:])
        allowed_prefixes = (
            "logging read",
            "config list",
            "projects list",
            "container clusters list",
            "container clusters describe",
        )
        if not any(joined.startswith(prefix) for prefix in allowed_prefixes):
            raise SafetyViolationError(
                f"gcloud command '{joined}' is not in the strict read-only allowlist {allowed_prefixes}."
            )
        return

    raise SafetyViolationError(f"Executable '{exe}' is not permitted in the read-only infra collector.")


def is_owned_github_item(item: dict[str, Any], my_login: str = GITHUB_USER) -> tuple[bool, str]:
    """
    Enforce 'ONLY stuff on my end' ownership rules for GitHub PRs, Issues, and Project items.
    Returns (is_mine, ownership_reason).
    """
    me = (my_login or "").strip().lower()
    author = str(item.get("author") or "").lower()
    assignees = [str(a).lower() for a in (item.get("assignees") or [])]
    requested_reviewers = [str(r).lower() for r in (item.get("requested_reviewers") or [])]
    mentioned = bool(item.get("mentioned_me"))
    my_commitment = bool(item.get("from_my_commitment"))

    if me and author == me:
        return True, "authored_by_me"
    if me and me in assignees:
        return True, "assigned_to_me"
    if my_commitment:
        return True, "my_slack_or_call_commitment"
    if mentioned:
        return True, "direct_mention"
    if me and me in requested_reviewers:
        return True, "direct_review_requested_private_summary_only"

    return False, "not_mine"


def assert_can_modify_github_item(
    ownership_reason: str,
    action_type: str,
    my_login: str = GITHUB_USER,
) -> None:
    """Prevent modifying, pushing, or moving board cards on PRs/issues that belong to others."""
    if ownership_reason == "not_mine":
        raise SafetyViolationError(
            f"Blocked '{action_type}': item does not belong to {my_login or 'active principal'} ('only stuff on my end' policy)."
        )
    if ownership_reason == "direct_review_requested_private_summary_only" and action_type in {
        "git_push",
        "github_board_move",
        "worktree_code_edit",
    }:
        raise SafetyViolationError(
            f"Blocked '{action_type}': PR is authored by a teammate (only private review summary is allowed unless explicitly requested)."
        )


def validate_approval_payload_server_side(
    action_type: str,
    payload: dict[str, Any],
    *,
    ownership_reason: str = "authored_by_me",
    allowed_slack_self_id: str | None = None,
    allowed_repos: set[str] | None = None,
    worktrees_root: Path | None = None,
    my_login: str = GITHUB_USER,
) -> dict[str, Any]:
    """
    Server-side policy & integrity check run BOTH when staging AND after a human edits an approval payload.
    Blocks privilege escalation, read-only infra mutation, path escapes, and ownership violations.
    """
    if action_type == "gke_gcp_phoenix" or action_type.startswith("gke_mutate") or action_type.startswith("gcloud_mutate"):
        raise SafetyViolationError("Cloud/GKE/GCP infrastructure actions are permanently locked to read-only.")

    if not isinstance(payload, dict):
        raise SafetyViolationError("Approval payload must be a JSON object.")

    # Never allow raw shell commands to be smuggled through edited payloads
    for forbidden_key in ("raw_shell", "shell_cmd", "kubectl_apply"):
        if forbidden_key in payload:
            raise SafetyViolationError(f"Disallowed payload field '{forbidden_key}'.")

    if action_type in {"git_push", "github_pr_create", "github_pr_reply", "github_board_move"}:
        assert_can_modify_github_item(ownership_reason, action_type, my_login=my_login)
        repo_val = str(payload.get("repo") or "").strip()
        if repo_val and allowed_repos and repo_val not in allowed_repos:
            raise SafetyViolationError(
                f"Repository '{repo_val}' is outside this profile's configured repositories."
            )
        wt_val = str(payload.get("worktree_path") or "").strip()
        if wt_val and worktrees_root is not None:
            wt_resolved = Path(wt_val).resolve()
            root_resolved = worktrees_root.resolve()
            if not wt_resolved.is_relative_to(root_resolved):
                raise SafetyViolationError(
                    f"worktree_path '{wt_val}' must reside inside isolated worktrees root '{root_resolved}'."
                )
        if action_type == "git_push":
            validate_git_ref(str(payload.get("branch") or ""), "branch")
        if action_type in {"github_pr_reply", "github_board_move"}:
            pr_num = int(payload.get("pr_number") or 0)
            if pr_num <= 0:
                raise SafetyViolationError(f"{action_type} requires a positive integer pr_number.")

    elif action_type == "slack_self_dm":
        assert_slack_self_dm_only(str(payload.get("channel_id") or ""), allowed_self_id=allowed_slack_self_id)
        if not str(payload.get("message") or "").strip():
            raise SafetyViolationError("slack_self_dm requires a non-empty message.")

    elif action_type == "slack_send_external":
        channel_id = str(payload.get("channel_id") or "").strip()
        message = str(payload.get("message") or "").strip()
        if not channel_id or not message:
            raise SafetyViolationError("slack_send_external requires non-empty channel_id and message.")

    elif action_type == "gmail_send_external":
        recipient = str(payload.get("to") or payload.get("recipient") or "").strip()
        body = str(payload.get("body") or payload.get("message") or "").strip()
        if not recipient or not body:
            raise SafetyViolationError("gmail_send_external requires recipient ('to') and 'body'.")

    elif action_type == "drive_comment_or_edit":
        file_id = str(payload.get("fileId") or payload.get("file_id") or "").strip()
        if not file_id:
            raise SafetyViolationError("drive_comment_or_edit requires a target Drive fileId.")

    return payload
