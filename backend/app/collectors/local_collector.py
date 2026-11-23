from __future__ import annotations

import os
import subprocess
from pathlib import Path
from typing import Any


def collect_local(trigger_source: str = "manual") -> dict[str, Any]:
    """
    Inspect git repositories inside WORKSPACE_REPOS_DIR for uncommitted local work.
    Returns empty results with configured=False when WORKSPACE_REPOS_DIR is unset or missing.
    """
    _ = trigger_source
    raw_dir = os.environ.get("WORKSPACE_REPOS_DIR", "").strip()
    if not raw_dir:
        return {"events": [], "tasks": [], "configured": False}

    root = Path(raw_dir).expanduser()
    if not root.exists() or not root.is_dir():
        return {"events": [], "tasks": [], "configured": False}

    events: list[dict[str, Any]] = []
    tasks: list[dict[str, Any]] = []

    for child in sorted(root.iterdir()):
        if not child.is_dir() or not (child / ".git").exists():
            continue
        try:
            proc = subprocess.run(
                ["git", "-C", str(child), "status", "--short"],
                capture_output=True,
                text=True,
                check=False,
                timeout=5,
            )
        except Exception:
            continue
        if proc.returncode != 0:
            continue
        lines = [ln for ln in (proc.stdout or "").splitlines() if ln.strip()]
        if not lines:
            continue
        repo_name = child.name
        preview = "\n".join(lines[:10])
        events.append(
            {
                "source": "local",
                "source_id": f"local-wip:{repo_name}",
                "event_type": "local_wip",
                "title": f"Uncommitted changes in {repo_name} ({len(lines)} files)",
                "summary": preview,
                "body": "\n".join(lines),
                "actor": "local",
                "channel_or_repo": repo_name,
                "priority": "P2",
                "ownership_reason": "local_workspace",
                "is_mine": True,
                "requires_action": True,
            }
        )
        tasks.append(
            {
                "dedup_key": f"local-wip:{repo_name}",
                "bucket": "needed_from_me",
                "priority": "P2",
                "source": "local",
                "source_ref": repo_name,
                "title": f"Review/commit local WIP in {repo_name}",
                "description": preview,
                "repo": repo_name,
                "task_kind": "code",
                "ownership_reason": "local_workspace",
            }
        )

    return {"events": events, "tasks": tasks, "configured": True}


collect_local_workspace = collect_local
