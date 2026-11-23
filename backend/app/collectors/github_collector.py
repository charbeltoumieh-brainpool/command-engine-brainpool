from __future__ import annotations

import os
from typing import Any

import httpx

from ..config import GITHUB_USER
from ..safety import is_owned_github_item


async def collect_github(trigger_source: str = "manual") -> dict[str, Any]:
    """
    Collect open pull requests and issues from configured GitHub repositories via REST API.
    Requires GITHUB_TOKEN and GITHUB_REPOS (comma-separated owner/repo list) in environment.
    """
    _ = trigger_source
    token = os.environ.get("GITHUB_TOKEN", "").strip()
    repos_raw = os.environ.get("GITHUB_REPOS", "").strip()
    repos = [r.strip() for r in repos_raw.split(",") if "/" in r.strip()]

    if not token or not repos:
        return {"events": [], "tasks": [], "configured": False}

    my_login = os.environ.get("GITHUB_USER", GITHUB_USER).strip()
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }

    events: list[dict[str, Any]] = []
    tasks: list[dict[str, Any]] = []

    async with httpx.AsyncClient(timeout=15.0) as client:
        for repo in repos:
            try:
                pr_resp = await client.get(
                    f"https://api.github.com/repos/{repo}/pulls",
                    headers=headers,
                    params={"state": "open", "per_page": 15},
                )
                if pr_resp.status_code == 200:
                    for pr in pr_resp.json() or []:
                        num = pr.get("number")
                        author = str((pr.get("user") or {}).get("login") or "")
                        assignees = [str(a.get("login") or "") for a in (pr.get("assignees") or [])]
                        reviewers = [str(r.get("login") or "") for r in (pr.get("requested_reviewers") or [])]
                        is_mine, reason = is_owned_github_item(
                            {
                                "author": author,
                                "assignees": assignees,
                                "requested_reviewers": reviewers,
                            },
                            my_login=my_login,
                        )
                        events.append(
                            {
                                "source": "github",
                                "source_id": f"{repo}#pr-{num}",
                                "event_type": "github_pr",
                                "title": f"[{repo}#{num}] {pr.get('title') or ''}",
                                "summary": str(pr.get("body") or "")[:240],
                                "actor": author,
                                "url": str(pr.get("html_url") or ""),
                                "channel_or_repo": repo,
                                "priority": "P1" if is_mine else "P2",
                                "ownership_reason": reason,
                                "is_mine": is_mine,
                                "requires_action": is_mine,
                                "occurred_at": str(pr.get("updated_at") or pr.get("created_at") or ""),
                            }
                        )
                        if is_mine:
                            tasks.append(
                                {
                                    "dedup_key": f"github:{repo}#pr-{num}",
                                    "bucket": "needed_from_me",
                                    "priority": "P1",
                                    "source": "github",
                                    "source_ref": f"{repo}#{num}",
                                    "source_url": str(pr.get("html_url") or ""),
                                    "title": f"PR #{num}: {pr.get('title') or ''}",
                                    "description": str(pr.get("body") or "")[:400],
                                    "owner": my_login,
                                    "counterparty": author,
                                    "repo": repo,
                                    "ownership_reason": reason,
                                }
                            )
            except Exception:
                continue

            try:
                issue_resp = await client.get(
                    f"https://api.github.com/repos/{repo}/issues",
                    headers=headers,
                    params={"state": "open", "per_page": 15},
                )
                if issue_resp.status_code == 200:
                    for issue in issue_resp.json() or []:
                        if "pull_request" in issue:
                            continue
                        num = issue.get("number")
                        author = str((issue.get("user") or {}).get("login") or "")
                        assignees = [str(a.get("login") or "") for a in (issue.get("assignees") or [])]
                        is_mine, reason = is_owned_github_item(
                            {
                                "author": author,
                                "assignees": assignees,
                                "requested_reviewers": [],
                            },
                            my_login=my_login,
                        )
                        events.append(
                            {
                                "source": "github",
                                "source_id": f"{repo}#issue-{num}",
                                "event_type": "github_issue",
                                "title": f"[{repo}#{num}] {issue.get('title') or ''}",
                                "summary": str(issue.get("body") or "")[:240],
                                "actor": author,
                                "url": str(issue.get("html_url") or ""),
                                "channel_or_repo": repo,
                                "priority": "P1" if is_mine else "P2",
                                "ownership_reason": reason,
                                "is_mine": is_mine,
                                "requires_action": is_mine,
                                "occurred_at": str(issue.get("updated_at") or issue.get("created_at") or ""),
                            }
                        )
                        if is_mine:
                            tasks.append(
                                {
                                    "dedup_key": f"github:{repo}#issue-{num}",
                                    "bucket": "needed_from_me",
                                    "priority": "P1",
                                    "source": "github",
                                    "source_ref": f"{repo}#{num}",
                                    "source_url": str(issue.get("html_url") or ""),
                                    "title": f"Issue #{num}: {issue.get('title') or ''}",
                                    "description": str(issue.get("body") or "")[:400],
                                    "owner": my_login,
                                    "counterparty": author,
                                    "repo": repo,
                                    "ownership_reason": reason,
                                }
                            )
            except Exception:
                continue

    return {"events": events, "tasks": tasks, "configured": True}
