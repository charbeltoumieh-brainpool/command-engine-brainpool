function isAppleDevice(): boolean {
  if (typeof navigator === "undefined") return false;
  return /mac|iphone|ipad|ipod/i.test(navigator.userAgent ?? "");
}

export function formatModKey(key?: string): string {
  const mac = isAppleDevice();
  if (!key) return mac ? "⌘" : "Ctrl+";
  return mac ? `⌘${key}` : `Ctrl+${key}`;
}

export function formatDurationMs(ms?: number | null): string {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(sec < 10 ? 1 : 0)}s`;
  const min = Math.floor(sec / 60);
  const remSec = Math.round(sec % 60);
  if (min < 60) return remSec > 0 ? `${min}m ${remSec}s` : `${min}m`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return remMin > 0 ? `${hr}h ${remMin}m` : `${hr}h`;
}

export function formatOwnershipReason(reason?: string | null): string {
  if (!reason) return "";
  const normalized = reason.trim().toLowerCase();
  const map: Record<string, string> = {
    authored_by_me: "Authored by you",
    assigned_to_me: "Assigned to you",
    requested_reviewer: "Review requested",
    direct_mention: "Mentioned you",
    mentioned: "Mentioned you",
    direct_dm: "Direct message",
    vip_sender: "Priority contact",
    committed_in_call: "Committed in meeting",
    meeting_action: "Meeting action item",
    local_dirty_repo: "Local uncommitted work",
    pr_review_requested: "Review requested",
    changes_requested: "Changes requested on your PR",
    owner: "You own this",
  };
  if (map[normalized]) return map[normalized];
  return reason
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function formatEventType(eventType?: string | null): string {
  if (!eventType) return "Update";
  const normalized = eventType.trim().toLowerCase();
  const map: Record<string, string> = {
    slack_dm: "Direct Message",
    slack_mention: "Channel Mention",
    slack_thread: "Thread Reply",
    gmail_thread: "Email Thread",
    gmail_unread: "Unread Email",
    github_pr: "Pull Request",
    pr_review_requested: "Review Request",
    pr_changes_requested: "Changes Requested",
    github_issue: "Issue",
    drive_comment: "Document Comment",
    drive_share: "Shared Document",
    meeting_transcript: "Meeting Notes",
    meeting_upcoming: "Upcoming Meeting",
    dirty_repo: "Uncommitted Changes",
    unpushed_commits: "Unpushed Commits",
    gke_alert: "Cloud Health Alert",
  };
  if (map[normalized]) return map[normalized];
  return eventType
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function formatRelativeTime(iso?: string | null): string {
  if (!iso || iso.startsWith("1970-01-01")) return "Never";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const diffSec = Math.floor((Date.now() - date.getTime()) / 1000);
  if (diffSec < 0) {
    const absMin = Math.floor(Math.abs(diffSec) / 60);
    if (absMin < 60) return `in ${absMin}m`;
    const absHr = Math.floor(absMin / 60);
    if (absHr < 24) return `in ${absHr}h`;
    return `in ${Math.floor(absHr / 24)}d`;
  }
  if (diffSec < 45) return "just now";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 30) return `${diffDay}d ago`;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function formatDateTime(iso?: string | null): string {
  if (!iso || iso.startsWith("1970-01-01")) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatActionTypeLabel(actionType: string): string {
  const map: Record<string, string> = {
    git_push: "Push Branch",
    github_pr_create: "Open Pull Request",
    github_pr_reply: "Reply & Resolve Review",
    github_board_move: "Move Board Card",
    slack_send_external: "Send Slack Message",
    slack_self_dm: "Personal Briefing DM",
    gmail_send_external: "Send Email",
    drive_comment_or_edit: "Comment on Document",
    worktree_local_code: "Isolated Workspace Edit",
    local_triage_and_labels: "Organize & Label",
    gke_gcp_phoenix: "Cloud Inspection (Read-Only)",
  };
  return (
    map[actionType] ??
    actionType
      .replace(/[_-]+/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase())
  );
}
