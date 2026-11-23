import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  Check,
  Clock,
  ExternalLink,
  FileText,
  GitBranch,
  Loader2,
  Lock,
  RotateCcw,
  Search,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Undo2,
  Unlock,
  X,
  Zap,
} from "lucide-react";
import { api } from "../lib/api";
import {
  formatActionTypeLabel,
  formatDateTime,
  formatEventType,
  formatRelativeTime,
} from "../lib/format";
import { useListKeyboardNav } from "../lib/useListKeyboardNav";
import type {
  ApprovalContextResponse,
  ApprovalItem,
  AutonomyPolicy,
  WorkspaceId,
} from "../types/api";
import {
  ErrorBanner,
  PriorityBadge,
  SkeletonRows,
  SourceIcon,
  StatusBadge,
} from "../components/Badges";
import { DiffViewer } from "../components/DiffViewer";
import { MarkdownRenderer } from "../components/MarkdownRenderer";
import { ModalDialog } from "../components/Overlays";
import { useToast } from "../components/ToastContext";
import { WorkspaceHeader } from "../components/WorkspaceHeader";

export interface ApprovalsViewProps {
  refreshSignal: number;
  onNavigate: (ws: WorkspaceId) => void;
  onStateMutated: () => void;
  initialApprovalId?: number | null;
  onClearInitialApproval?: () => void;
}

type ApprovalStatusTab =
  | "pending"
  | "executed"
  | "rejected"
  | "all"
  | "policies";
type PayloadEditorMode = "structured" | "json";

const TONE_OPTIONS: Array<{ label: string; style: string }> = [
  { label: "Concise", style: "concise" },
  { label: "Direct", style: "firm" },
  { label: "Warm", style: "warm" },
  { label: "Executive", style: "executive" },
  { label: "Technical", style: "technical" },
];

const DRAFT_STORAGE_PREFIX = "ce.approval.draft.";

const SLACK_ACTIONS = new Set(["slack_send_external", "slack_reply", "slack_self_dm"]);
const EMAIL_ACTIONS = new Set([
  "gmail_send_external",
  "gmail_send",
  "gmail_draft",
  "email_send",
]);
const BOARD_MOVE_ACTIONS = new Set(["github_board_move", "github_project_move"]);
const DRIVE_ACTIONS = new Set(["drive_comment_or_edit", "drive_comment_resolve"]);
const GITHUB_CODE_ACTIONS = new Set([
  "github_pr_create",
  "github_pr_reply",
  "git_push",
]);

function parsePayloadObject(ap: ApprovalItem): Record<string, unknown> {
  if (ap.payload && typeof ap.payload === "object" && !Array.isArray(ap.payload)) {
    return { ...ap.payload };
  }
  if (ap.payload_json) {
    try {
      const parsed = JSON.parse(ap.payload_json) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return { ...(parsed as Record<string, unknown>) };
      }
    } catch {
      // Ignore malformed JSON fallback
    }
  }
  return {};
}

function stableStringify(val: unknown): string {
  if (val === null || typeof val !== "object") {
    return JSON.stringify(val);
  }
  if (Array.isArray(val)) {
    return `[${val.map(stableStringify).join(",")}]`;
  }
  const obj = val as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

function readLocalDraft(approvalId: number): Record<string, unknown> | null {
  try {
    const raw = localStorage.getItem(`${DRAFT_STORAGE_PREFIX}${approvalId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // ignore storage errors
  }
  return null;
}

function writeLocalDraft(
  approvalId: number,
  draft: Record<string, unknown>,
  original: Record<string, unknown>
): void {
  try {
    if (stableStringify(draft) === stableStringify(original)) {
      localStorage.removeItem(`${DRAFT_STORAGE_PREFIX}${approvalId}`);
    } else {
      localStorage.setItem(
        `${DRAFT_STORAGE_PREFIX}${approvalId}`,
        JSON.stringify(draft)
      );
    }
  } catch {
    // ignore storage errors
  }
}

function clearLocalDraft(approvalId: number): void {
  try {
    localStorage.removeItem(`${DRAFT_STORAGE_PREFIX}${approvalId}`);
  } catch {
    // ignore
  }
}

function strVal(
  obj: Record<string, unknown>,
  key: string,
  fallback = ""
): string {
  const val = obj[key];
  if (val === undefined || val === null) return fallback;
  return String(val);
}

function hydrateDraftFromItem(item: ApprovalItem): Record<string, unknown> {
  const raw = parsePayloadObject(item);
  const t = item.action_type;

  if (BOARD_MOVE_ACTIONS.has(t)) {
    const repo = strVal(raw, "repo", item.repo);
    const fromStatus =
      strVal(raw, "from_status") ||
      strVal(raw, "from_column") ||
      strVal(raw, "current_status");
    const toStatus =
      strVal(raw, "to_status") ||
      strVal(raw, "to_column") ||
      strVal(raw, "target_status") ||
      strVal(raw, "status");
    const hydrated: Record<string, unknown> = {
      ...raw,
      repo,
      from_status: fromStatus,
      to_status: toStatus,
    };
    if (
      raw.pr_number !== undefined &&
      raw.pr_number !== null &&
      raw.pr_number !== ""
    ) {
      hydrated.pr_number = raw.pr_number;
    } else if (!("item_title" in raw)) {
      hydrated.item_title = strVal(raw, "title", item.title);
    }
    return hydrated;
  }

  if (DRIVE_ACTIONS.has(t)) {
    const fileId = strVal(raw, "file_id") || strVal(raw, "document_id");
    const documentTitle = strVal(raw, "document_title") || strVal(raw, "title");
    const rawOp = (
      strVal(raw, "operation") ||
      strVal(raw, "action") ||
      "comment"
    ).toLowerCase();
    const operation =
      rawOp === "resolve" || rawOp === "suggest" || rawOp === "comment"
        ? rawOp
        : "comment";
    const commentText =
      strVal(raw, "comment_text") ||
      strVal(raw, "content") ||
      strVal(raw, "comment") ||
      strVal(raw, "text");

    const hydrated: Record<string, unknown> = {
      ...raw,
      operation,
    };
    if (fileId || !documentTitle) {
      hydrated.file_id = fileId;
    }
    if (documentTitle) {
      hydrated.document_title = documentTitle;
    }
    if ("content" in raw && !("comment_text" in raw)) {
      hydrated.content = commentText;
    } else {
      hydrated.comment_text = commentText;
    }
    return hydrated;
  }

  return raw;
}

function buildEditedPayload(
  item: ApprovalItem,
  draft: Record<string, unknown>
): Record<string, unknown> {
  const next = { ...draft };
  const t = item.action_type;

  if (BOARD_MOVE_ACTIONS.has(t)) {
    if (
      typeof next.pr_number === "string" &&
      /^\d+$/.test(next.pr_number.trim())
    ) {
      next.pr_number = Number(next.pr_number.trim());
    }
  } else if (DRIVE_ACTIONS.has(t)) {
    if ("comment_text" in next && "content" in next && !next.content) {
      next.content = next.comment_text;
    }
  }

  return next;
}

function getHeaderTargetPill(
  item: ApprovalItem,
  draft: Record<string, unknown>
): string {
  const t = item.action_type;
  if (SLACK_ACTIONS.has(t)) {
    const ch =
      strVal(draft, "channel_name") ||
      strVal(draft, "channel_id") ||
      strVal(draft, "channel") ||
      strVal(draft, "recipient");
    if (!ch) return "";
    if (ch.startsWith("#") || ch.startsWith("@")) return ch;
    return ch.startsWith("U") || ch.startsWith("D") ? `@${ch}` : `#${ch}`;
  }
  if (EMAIL_ACTIONS.has(t)) {
    return strVal(draft, "to") || strVal(draft, "recipient");
  }
  if (GITHUB_CODE_ACTIONS.has(t) || BOARD_MOVE_ACTIONS.has(t)) {
    const repo = strVal(draft, "repo", item.repo);
    const prNum = strVal(draft, "pr_number");
    if (repo && prNum) return `${repo} #${prNum}`;
    return repo || (prNum ? `#${prNum}` : "");
  }
  if (DRIVE_ACTIONS.has(t)) {
    return (
      strVal(draft, "document_title") ||
      strVal(draft, "title") ||
      strVal(draft, "file_id")
    );
  }
  return item.repo || strVal(draft, "repo") || strVal(draft, "target");
}

function buildDraftPreviewBody(
  item: ApprovalItem,
  draft: Record<string, unknown>
): string {
  const t = item.action_type;
  if (SLACK_ACTIONS.has(t)) {
    return strVal(draft, "message") || strVal(draft, "text") || item.summary || "";
  }
  if (EMAIL_ACTIONS.has(t)) {
    return strVal(draft, "body") || item.summary || "";
  }
  if (t === "github_pr_create") {
    return strVal(draft, "body") || item.summary || "";
  }
  if (t === "github_pr_reply") {
    const top = strVal(draft, "top_level_body") || strVal(draft, "body");
    if (top) return top;
    return "";
  }
  if (DRIVE_ACTIONS.has(t)) {
    return (
      strVal(draft, "comment_text") ||
      strVal(draft, "content") ||
      strVal(draft, "comment") ||
      strVal(draft, "text") ||
      item.summary ||
      ""
    );
  }
  return (
    strVal(draft, "message") ||
    strVal(draft, "body") ||
    strVal(draft, "comment") ||
    item.summary ||
    ""
  );
}

function hasEditableTextDraft(
  item: ApprovalItem,
  draft: Record<string, unknown>
): boolean {
  const t = item.action_type;
  if (
    SLACK_ACTIONS.has(t) ||
    EMAIL_ACTIONS.has(t) ||
    t === "github_pr_create" ||
    t === "github_pr_reply" ||
    DRIVE_ACTIONS.has(t)
  ) {
    return true;
  }
  const textKeys = [
    "message",
    "text",
    "body",
    "top_level_body",
    "comment_text",
    "content",
    "comment",
  ];
  return textKeys.some((k) => typeof draft[k] === "string");
}

function isEditableActiveElement(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return el instanceof HTMLElement && el.isContentEditable;
}

function buildConfirmationTarget(
  ap: ApprovalItem,
  payload: Record<string, unknown>
): { headline: string; detail?: string } {
  const t = ap.action_type;
  if (SLACK_ACTIONS.has(t)) {
    const channel =
      strVal(payload, "channel_name") ||
      strVal(payload, "channel_id") ||
      strVal(payload, "channel") ||
      strVal(payload, "recipient") ||
      "Slack";
    const msg = strVal(payload, "message") || strVal(payload, "text");
    return {
      headline: `Slack · ${channel}`,
      detail: msg ? msg.slice(0, 180) + (msg.length > 180 ? "…" : "") : undefined,
    };
  }
  if (EMAIL_ACTIONS.has(t)) {
    const to = strVal(payload, "to") || strVal(payload, "recipient") || "Recipient";
    const subject = strVal(payload, "subject");
    const body = strVal(payload, "body");
    return {
      headline: `To: ${to}${subject ? ` · ${subject}` : ""}`,
      detail: body ? body.slice(0, 180) + (body.length > 180 ? "…" : "") : undefined,
    };
  }
  if (GITHUB_CODE_ACTIONS.has(t)) {
    const repo = strVal(payload, "repo", ap.repo) || "repo";
    const prNum = strVal(payload, "pr_number");
    const branch = strVal(payload, "head", ap.branch) || strVal(payload, "branch");
    const body =
      strVal(payload, "top_level_body") ||
      strVal(payload, "body") ||
      strVal(payload, "title");
    return {
      headline: `${repo}${prNum ? ` #${prNum}` : branch ? ` · ${branch}` : ""}`,
      detail: body ? body.slice(0, 180) + (body.length > 180 ? "…" : "") : undefined,
    };
  }
  if (BOARD_MOVE_ACTIONS.has(t)) {
    const repo = strVal(payload, "repo", ap.repo) || "Board";
    const fromCol =
      strVal(payload, "from_status") || strVal(payload, "from_column") || "Current";
    const toCol =
      strVal(payload, "to_status") ||
      strVal(payload, "to_column") ||
      strVal(payload, "target_status") ||
      "Next";
    return {
      headline: `${repo} · ${fromCol} → ${toCol}`,
    };
  }
  if (DRIVE_ACTIONS.has(t)) {
    const doc =
      strVal(payload, "document_title") ||
      strVal(payload, "title") ||
      strVal(payload, "file_id") ||
      "Document";
    const text =
      strVal(payload, "comment_text") ||
      strVal(payload, "content") ||
      strVal(payload, "comment");
    return {
      headline: doc,
      detail: text ? text.slice(0, 180) + (text.length > 180 ? "…" : "") : undefined,
    };
  }
  return {
    headline: ap.repo || formatActionTypeLabel(t),
    detail: ap.summary || undefined,
  };
}

export function ApprovalsView({
  refreshSignal,
  onNavigate: _onNavigate,
  onStateMutated,
  initialApprovalId = null,
  onClearInitialApproval,
}: ApprovalsViewProps) {
  const { pushToast } = useToast();

  // Safety Lock starts ON so pending actions cannot fire accidentally
  const [previewLocked, setPreviewLocked] = useState<boolean>(true);
  const [undoSendEnabled, setUndoSendEnabled] = useState<boolean>(true);
  const [statusTab, setStatusTab] = useState<ApprovalStatusTab>("pending");
  const [searchQuery, setSearchQuery] = useState("");
  const [approvals, setApprovals] = useState<ApprovalItem[]>([]);
  const [policies, setPolicies] = useState<AutonomyPolicy[]>([]);
  const [autonomyPosture, setAutonomyPosture] = useState<string>("");
  const [togglingPolicy, setTogglingPolicy] = useState<string | null>(null);
  const [totalPendingCount, setTotalPendingCount] = useState<number>(0);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState<number | null>(
    initialApprovalId ?? null
  );
  const [isEditing, setIsEditing] = useState(false);
  const [payloadEditorMode, setPayloadEditorMode] =
    useState<PayloadEditorMode>("structured");
  const [draftsById, setDraftsById] = useState<
    Record<number, Record<string, unknown>>
  >({});
  const [rawJsonById, setRawJsonById] = useState<Record<number, string>>({});
  const [rawJsonErrorById, setRawJsonErrorById] = useState<
    Record<number, string | null>
  >({});

  // Feature 1: AI Draft Tone Rewriter
  const [rewritingId, setRewritingId] = useState<number | null>(null);
  const [rewritingStyle, setRewritingStyle] = useState<string | null>(null);
  const [customPolishById, setCustomPolishById] = useState<
    Record<number, string>
  >({});
  const [preRewriteDraftById, setPreRewriteDraftById] = useState<
    Record<number, Record<string, unknown>>
  >({});

  // Feature 2: Source Thread & Linked Obligation Context Strip (cached by approvalId)
  const [contextById, setContextById] = useState<
    Record<number, ApprovalContextResponse>
  >({});
  const contextFetchingRef = useRef<Set<number>>(new Set());

  // Feature 3: 10-Second Undo Send countdown tracking
  const [undoCountdowns, setUndoCountdowns] = useState<Record<number, number>>(
    {}
  );
  const [undoTotalById, setUndoTotalById] = useState<Record<number, number>>(
    {}
  );
  const [undoActionBusyId, setUndoActionBusyId] = useState<number | null>(null);
  const undoCountdownsRef = useRef<Record<number, number>>({});
  undoCountdownsRef.current = undoCountdowns;
  const completionTimersRef = useRef<Map<number, number>>(new Map());

  const [decidingId, setDecidingId] = useState<number | null>(null);
  const [validationErrorById, setValidationErrorById] = useState<
    Record<number, string>
  >({});
  const [confirmDecision, setConfirmDecision] = useState<{
    item: ApprovalItem;
    decision: "approve" | "reject";
    useEditedPayload: boolean;
  } | null>(null);

  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const cardRefs = useRef<Record<number, HTMLButtonElement | null>>({});

  const clearCompletionTimer = useCallback((approvalId: number) => {
    const t = completionTimersRef.current.get(approvalId);
    if (t !== undefined) {
      window.clearTimeout(t);
      completionTimersRef.current.delete(approvalId);
    }
  }, []);

  useEffect(() => {
    const timers = completionTimersRef.current;
    return () => {
      for (const t of timers.values()) {
        window.clearTimeout(t);
      }
      timers.clear();
    };
  }, []);

  const loadData = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true);
      setFetchError(null);
      try {
        if (statusTab === "policies") {
          const [polRes, pendingRes] = await Promise.all([
            api.getAutonomyPolicies(),
            api.getApprovals("pending"),
          ]);
          setPolicies(polRes.items);
          setAutonomyPosture(polRes.autonomy_posture ?? "");
          setTotalPendingCount(
            pendingRes.items.filter(
              (a) => a.status === "pending" || a.status === "queued_undo"
            ).length
          );
          return;
        }

        const [apRes, pendingRes] = await Promise.all([
          api.getApprovals(statusTab),
          statusTab === "pending"
            ? Promise.resolve(null)
            : api.getApprovals("pending"),
        ]);

        const activeCountdowns = undoCountdownsRef.current;
        setApprovals((prev) => {
          const incomingIds = new Set(apRes.items.map((a) => a.id));
          const preservedQueued = prev.filter(
            (a) =>
              !incomingIds.has(a.id) &&
              (a.status === "queued_undo" ||
                activeCountdowns[a.id] !== undefined)
          );
          return statusTab === "pending" || statusTab === "all"
            ? [...preservedQueued, ...apRes.items]
            : apRes.items;
        });

        // Initialize countdowns for any server-returned queued_undo items
        const queuedFromServer = apRes.items.filter(
          (a) => a.status === "queued_undo"
        );
        if (queuedFromServer.length > 0) {
          setUndoCountdowns((prev) => {
            const next = { ...prev };
            let changed = false;
            for (const q of queuedFromServer) {
              if (next[q.id] === undefined) {
                next[q.id] = 10;
                changed = true;
              }
            }
            return changed ? next : prev;
          });
          setUndoTotalById((prev) => {
            const next = { ...prev };
            let changed = false;
            for (const q of queuedFromServer) {
              if (next[q.id] === undefined) {
                next[q.id] = 10;
                changed = true;
              }
            }
            return changed ? next : prev;
          });
        }

        if (statusTab === "pending") {
          setTotalPendingCount(
            apRes.items.filter(
              (a) => a.status === "pending" || a.status === "queued_undo"
            ).length
          );
        } else if (pendingRes) {
          setTotalPendingCount(
            pendingRes.items.filter(
              (a) => a.status === "pending" || a.status === "queued_undo"
            ).length
          );
        }

        setDraftsById((prev) => {
          const next: Record<number, Record<string, unknown>> = { ...prev };
          for (const item of apRes.items) {
            if (!next[item.id]) {
              const stored = readLocalDraft(item.id);
              next[item.id] = stored ?? hydrateDraftFromItem(item);
            }
          }
          return next;
        });

        setSelectedId((prev) => {
          if (
            initialApprovalId &&
            apRes.items.some((a) => a.id === initialApprovalId)
          ) {
            return initialApprovalId;
          }
          if (
            prev &&
            (apRes.items.some((a) => a.id === prev) ||
              activeCountdowns[prev] !== undefined)
          ) {
            return prev;
          }
          return apRes.items[0]?.id ?? null;
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setFetchError(msg);
        pushToast("error", "Failed to load Approvals", msg);
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [statusTab, initialApprovalId, pushToast]
  );

  useEffect(() => {
    void loadData(false);
  }, [loadData, refreshSignal]);

  useEffect(() => {
    if (!initialApprovalId) return;
    if (approvals.some((a) => a.id === initialApprovalId)) {
      setSelectedId(initialApprovalId);
      setIsEditing(false);
      onClearInitialApproval?.();
    }
  }, [initialApprovalId, approvals, onClearInitialApproval]);

  // Countdown ticker for queued_undo approvals
  const activeCountdownCount = Object.keys(undoCountdowns).length;
  useEffect(() => {
    if (activeCountdownCount === 0) return;

    const timer = window.setInterval(() => {
      const finishedIds: number[] = [];
      setUndoCountdowns((prev) => {
        const next: Record<number, number> = {};
        let changed = false;
        for (const [idStr, sec] of Object.entries(prev)) {
          const id = Number(idStr);
          if (sec > 1) {
            next[id] = sec - 1;
            changed = true;
          } else if (sec === 1) {
            next[id] = 0;
            finishedIds.push(id);
            changed = true;
          } else {
            next[id] = 0;
          }
        }
        return changed ? next : prev;
      });

      for (const id of finishedIds) {
        if (!completionTimersRef.current.has(id)) {
          const timeoutId = window.setTimeout(() => {
            completionTimersRef.current.delete(id);
            setUndoCountdowns((prev) => {
              if (!(id in prev)) return prev;
              const copy = { ...prev };
              delete copy[id];
              return copy;
            });
            setUndoTotalById((prev) => {
              if (!(id in prev)) return prev;
              const copy = { ...prev };
              delete copy[id];
              return copy;
            });
            onStateMutated();
            void loadData(true);
          }, 600);
          completionTimersRef.current.set(id, timeoutId);
        }
      }
    }, 1000);

    return () => {
      window.clearInterval(timer);
    };
  }, [activeCountdownCount, loadData, onStateMutated]);

  const filteredApprovals = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return approvals;
    return approvals.filter((ap) => {
      const hay = [
        `#${ap.id}`,
        ap.title,
        ap.action_type,
        formatActionTypeLabel(ap.action_type),
        ap.repo,
        ap.branch,
        ap.summary,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [approvals, searchQuery]);

  const filteredPolicies = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return policies;
    return policies.filter((p) =>
      [p.label, p.action_type, p.category, p.description, p.mode]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(q)
    );
  }, [policies, searchQuery]);

  const selected = useMemo(() => {
    if (!filteredApprovals.length) return null;
    return (
      filteredApprovals.find((a) => a.id === selectedId) ??
      filteredApprovals[0] ??
      null
    );
  }, [filteredApprovals, selectedId]);

  const selectedIndex = useMemo(() => {
    if (!selected) return -1;
    return filteredApprovals.findIndex((a) => a.id === selected.id);
  }, [filteredApprovals, selected]);

  // Keep selected queue card scrolled into view during keyboard triage
  useEffect(() => {
    if (statusTab === "policies" || !selected) return;
    const el = cardRefs.current[selected.id];
    if (el && typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ block: "nearest" });
    }
  }, [selected?.id, statusTab]);

  // Fetch Originating Context when a pending/queued approval is selected (cached by approvalId)
  useEffect(() => {
    if (statusTab === "policies" || !selected) return;
    if (selected.status !== "pending" && selected.status !== "queued_undo") {
      return;
    }
    const id = selected.id;
    if (contextById[id] || contextFetchingRef.current.has(id)) return;

    contextFetchingRef.current.add(id);
    let cancelled = false;
    api
      .getApprovalContext(id)
      .then((ctx) => {
        if (cancelled) return;
        setContextById((prev) => ({ ...prev, [id]: ctx }));
      })
      .catch(() => {
        // Non-blocking: context strip simply stays hidden if unavailable
      })
      .finally(() => {
        contextFetchingRef.current.delete(id);
      });

    return () => {
      cancelled = true;
    };
  }, [selected, statusTab, contextById]);

  useEffect(() => {
    if (!selected) return;
    const id = selected.id;
    const currentDraft = draftsById[id] ?? hydrateDraftFromItem(selected);
    setRawJsonById((prev) => {
      if (rawJsonErrorById[id] && prev[id] !== undefined) {
        return prev;
      }
      return {
        ...prev,
        [id]: JSON.stringify(currentDraft, null, 2),
      };
    });
  }, [selected?.id, payloadEditorMode]); // eslint-disable-line react-hooks/exhaustive-deps

  useListKeyboardNav({
    items: filteredApprovals,
    getId: (a) => a.id,
    selectedId: selected?.id ?? null,
    onSelect: (id: number) => {
      setSelectedId(id);
      setIsEditing(false);
    },
    onEscape: () => {
      if (isEditing) {
        setIsEditing(false);
      } else if (searchQuery) {
        setSearchQuery("");
      }
    },
    searchInputRef,
    enabled: statusTab !== "policies",
  });

  const isItemDraftDirty = useCallback(
    (item: ApprovalItem): boolean => {
      const original = hydrateDraftFromItem(item);
      const draft = draftsById[item.id] ?? original;
      return (
        stableStringify(draft) !== stableStringify(original) ||
        Boolean(rawJsonErrorById[item.id])
      );
    },
    [draftsById, rawJsonErrorById]
  );

  const updateDraftField = (
    item: ApprovalItem,
    key: string,
    value: unknown
  ) => {
    const original = hydrateDraftFromItem(item);
    setDraftsById((prev) => {
      const nextDraft = {
        ...(prev[item.id] ?? original),
        [key]: value,
      };
      writeLocalDraft(item.id, nextDraft, original);
      return {
        ...prev,
        [item.id]: nextDraft,
      };
    });
    setValidationErrorById((prev) => {
      if (!prev[item.id]) return prev;
      const copy = { ...prev };
      delete copy[item.id];
      return copy;
    });
  };

  const handleRawJsonChange = (item: ApprovalItem, text: string) => {
    setRawJsonById((prev) => ({ ...prev, [item.id]: text }));
    try {
      const parsed = JSON.parse(text) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        setRawJsonErrorById((prev) => ({
          ...prev,
          [item.id]: "Payload must be a JSON object.",
        }));
        return;
      }
      setRawJsonErrorById((prev) => ({ ...prev, [item.id]: null }));
      const nextDraft = parsed as Record<string, unknown>;
      const original = hydrateDraftFromItem(item);
      writeLocalDraft(item.id, nextDraft, original);
      setDraftsById((prev) => ({ ...prev, [item.id]: nextDraft }));
    } catch (err) {
      setRawJsonErrorById((prev) => ({
        ...prev,
        [item.id]: err instanceof Error ? err.message : "Invalid JSON syntax",
      }));
    }
  };

  const resetDraft = (item: ApprovalItem) => {
    const original = hydrateDraftFromItem(item);
    clearLocalDraft(item.id);
    setDraftsById((prev) => ({ ...prev, [item.id]: original }));
    setRawJsonById((prev) => ({
      ...prev,
      [item.id]: JSON.stringify(original, null, 2),
    }));
    setRawJsonErrorById((prev) => ({ ...prev, [item.id]: null }));
    setPreRewriteDraftById((prev) => {
      if (!(item.id in prev)) return prev;
      const copy = { ...prev };
      delete copy[item.id];
      return copy;
    });
    setValidationErrorById((prev) => {
      const copy = { ...prev };
      delete copy[item.id];
      return copy;
    });
  };

  const handleRewriteTone = async (
    item: ApprovalItem,
    styleKey: string,
    customInstruction = ""
  ) => {
    if (rewritingId !== null) return;
    const currentDraft = draftsById[item.id] ?? hydrateDraftFromItem(item);
    setRewritingId(item.id);
    setRewritingStyle(styleKey);
    try {
      const res = await api.rewriteApprovalDraft(
        item.id,
        styleKey,
        customInstruction
      );
      const nextDraft: Record<string, unknown> = {
        ...currentDraft,
        ...(res.payload &&
        typeof res.payload === "object" &&
        !Array.isArray(res.payload)
          ? res.payload
          : {}),
      };
      if (res.field && typeof res.rewritten_text === "string") {
        nextDraft[res.field] = res.rewritten_text;
      }

      setPreRewriteDraftById((prev) =>
        prev[item.id] ? prev : { ...prev, [item.id]: currentDraft }
      );
      setDraftsById((prev) => ({ ...prev, [item.id]: nextDraft }));
      setRawJsonById((prev) => ({
        ...prev,
        [item.id]: JSON.stringify(nextDraft, null, 2),
      }));
      setRawJsonErrorById((prev) => ({ ...prev, [item.id]: null }));
      writeLocalDraft(item.id, nextDraft, hydrateDraftFromItem(item));

      setApprovals((prev) =>
        prev.map((a) =>
          a.id === item.id
            ? {
                ...(res.approval ?? a),
                payload: nextDraft,
                payload_json: JSON.stringify(nextDraft),
              }
            : a
        )
      );

      if (styleKey === "custom") {
        setCustomPolishById((prev) => ({ ...prev, [item.id]: "" }));
      }
      pushToast("success", "Draft polished", `Applied ${styleKey} tone`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      pushToast("error", "Tone polish failed", msg);
    } finally {
      setRewritingId(null);
      setRewritingStyle(null);
    }
  };

  const handleRevertTone = (item: ApprovalItem) => {
    const previousDraft = preRewriteDraftById[item.id];
    if (!previousDraft) return;
    setDraftsById((prev) => ({ ...prev, [item.id]: previousDraft }));
    setRawJsonById((prev) => ({
      ...prev,
      [item.id]: JSON.stringify(previousDraft, null, 2),
    }));
    setRawJsonErrorById((prev) => ({ ...prev, [item.id]: null }));
    writeLocalDraft(item.id, previousDraft, hydrateDraftFromItem(item));
    setPreRewriteDraftById((prev) => {
      const copy = { ...prev };
      delete copy[item.id];
      return copy;
    });
    pushToast("success", "Reverted draft", "Restored original text");
  };

  const handleUndoApproval = useCallback(
    async (item: ApprovalItem) => {
      if (undoActionBusyId !== null) return;
      clearCompletionTimer(item.id);
      setUndoActionBusyId(item.id);
      try {
        await api.undoApproval(item.id);
        setUndoCountdowns((prev) => {
          if (!(item.id in prev)) return prev;
          const copy = { ...prev };
          delete copy[item.id];
          return copy;
        });
        setUndoTotalById((prev) => {
          if (!(item.id in prev)) return prev;
          const copy = { ...prev };
          delete copy[item.id];
          return copy;
        });
        setApprovals((prev) =>
          prev.map((a) =>
            a.id === item.id ? { ...a, status: "pending" } : a
          )
        );
        pushToast("success", "Execution cancelled", "Restored to pending");
        onStateMutated();
        void loadData(true);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        pushToast("error", "Undo failed", msg);
      } finally {
        setUndoActionBusyId(null);
      }
    },
    [undoActionBusyId, clearCompletionTimer, pushToast, onStateMutated, loadData]
  );

  const handleExecuteNow = async (item: ApprovalItem) => {
    if (undoActionBusyId !== null || decidingId !== null) return;
    clearCompletionTimer(item.id);
    setUndoActionBusyId(item.id);

    const currentDraft = draftsById[item.id] ?? hydrateDraftFromItem(item);
    const editedPayload =
      isItemDraftDirty(item) || Boolean(preRewriteDraftById[item.id])
        ? buildEditedPayload(item, currentDraft)
        : null;

    try {
      const res = await api.decideApproval(item.id, "approve", editedPayload, 0);
      setUndoCountdowns((prev) => {
        if (!(item.id in prev)) return prev;
        const copy = { ...prev };
        delete copy[item.id];
        return copy;
      });
      setUndoTotalById((prev) => {
        if (!(item.id in prev)) return prev;
        const copy = { ...prev };
        delete copy[item.id];
        return copy;
      });
      clearLocalDraft(item.id);
      setPreRewriteDraftById((prev) => {
        if (!(item.id in prev)) return prev;
        const copy = { ...prev };
        delete copy[item.id];
        return copy;
      });
      if (statusTab === "pending") {
        setApprovals((prev) => prev.filter((a) => a.id !== item.id));
      } else {
        setApprovals((prev) =>
          prev.map((a) => (a.id === item.id ? { ...a, status: res.status } : a))
        );
      }
      pushToast(
        res.status === "failed" ? "error" : "success",
        "Approved & executed",
        item.title
      );
      onStateMutated();
      void loadData(true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setValidationErrorById((prev) => ({ ...prev, [item.id]: msg }));
      pushToast("error", `Approval #${item.id} blocked`, msg);
    } finally {
      setUndoActionBusyId(null);
    }
  };

  // Keyboard shortcut 'u' to immediately trigger Undo Send when selected card is in queued_undo
  useEffect(() => {
    if (statusTab === "policies") return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.isComposing) return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      if (isEditableActiveElement(document.activeElement)) return;

      if ((event.key === "u" || event.key === "U") && selected) {
        const isQueued =
          selected.status === "queued_undo" ||
          undoCountdownsRef.current[selected.id] !== undefined;
        if (isQueued) {
          event.preventDefault();
          void handleUndoApproval(selected);
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [statusTab, selected, handleUndoApproval]);

  const handleTogglePolicy = async (
    policy: AutonomyPolicy,
    mode: "auto" | "ask_first"
  ) => {
    if (
      policy.locked === 1 ||
      policy.mode === "read_only_locked" ||
      togglingPolicy !== null
    ) {
      return;
    }
    setTogglingPolicy(policy.action_type);
    try {
      const res = await api.updateAutonomyPolicy(policy.action_type, mode);
      setPolicies((prev) =>
        prev.map((p) =>
          p.action_type === policy.action_type ? res.policy : p
        )
      );
      pushToast(
        "success",
        "Autonomy policy updated",
        `${policy.label || formatActionTypeLabel(policy.action_type)} → ${
          mode === "auto" ? "Auto" : "Ask First"
        }`
      );
      onStateMutated();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      pushToast("error", "Policy update failed", msg);
    } finally {
      setTogglingPolicy(null);
    }
  };

  const requestDecisionConfirmation = (
    item: ApprovalItem,
    decision: "approve" | "reject",
    useEditedPayload: boolean
  ) => {
    if (previewLocked) return;
    const jsonErr = rawJsonErrorById[item.id];
    if (jsonErr && payloadEditorMode === "json" && decision === "approve") {
      pushToast("error", "Fix JSON syntax errors before approving", jsonErr);
      return;
    }
    setConfirmDecision({ item, decision, useEditedPayload });
  };

  const executeConfirmedDecision = async () => {
    if (!confirmDecision || decidingId !== null || previewLocked) return;
    const { item, decision, useEditedPayload } = confirmDecision;

    setDecidingId(item.id);
    setValidationErrorById((prev) => {
      const copy = { ...prev };
      delete copy[item.id];
      return copy;
    });

    const currentDraft = draftsById[item.id] ?? hydrateDraftFromItem(item);
    const editedPayload =
      decision === "approve" &&
      useEditedPayload &&
      (isItemDraftDirty(item) || Boolean(preRewriteDraftById[item.id]))
        ? buildEditedPayload(item, currentDraft)
        : null;
    const undoWindowSec = decision === "approve" && undoSendEnabled ? 10 : 0;

    try {
      const res = await api.decideApproval(
        item.id,
        decision,
        editedPayload,
        undoWindowSec
      );
      clearLocalDraft(item.id);
      setRawJsonById((prev) => {
        const copy = { ...prev };
        delete copy[item.id];
        return copy;
      });
      setRawJsonErrorById((prev) => {
        const copy = { ...prev };
        delete copy[item.id];
        return copy;
      });
      setPreRewriteDraftById((prev) => {
        if (!(item.id in prev)) return prev;
        const copy = { ...prev };
        delete copy[item.id];
        return copy;
      });
      setConfirmDecision(null);
      setIsEditing(false);

      if (res.status === "queued_undo") {
        const delay =
          typeof res.delay_seconds === "number" && res.delay_seconds > 0
            ? res.delay_seconds
            : 10;
        setUndoCountdowns((prev) => ({ ...prev, [item.id]: delay }));
        setUndoTotalById((prev) => ({ ...prev, [item.id]: delay }));
        setApprovals((prev) =>
          prev.map((a) =>
            a.id === item.id
              ? {
                  ...a,
                  status: "queued_undo",
                  ...(editedPayload
                    ? {
                        payload: editedPayload,
                        payload_json: JSON.stringify(editedPayload),
                      }
                    : {}),
                }
              : a
          )
        );
        pushToast(
          "success",
          `Queued · Executing in ${delay}s`,
          item.title
        );
      } else {
        pushToast(
          res.status === "failed" ? "error" : "success",
          decision === "approve" ? "Approved & executed" : "Action rejected",
          item.title
        );
        if (statusTab === "pending") {
          setApprovals((prev) => prev.filter((a) => a.id !== item.id));
        } else {
          setApprovals((prev) =>
            prev.map((a) => (a.id === item.id ? { ...a, status: res.status } : a))
          );
        }
        onStateMutated();
        void loadData(true);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setValidationErrorById((prev) => ({ ...prev, [item.id]: msg }));
      setConfirmDecision(null);
      pushToast("error", `Approval #${item.id} blocked`, msg);
    } finally {
      setDecidingId(null);
    }
  };

  const pendingCount = useMemo(
    () =>
      statusTab === "pending"
        ? approvals.filter(
            (a) => a.status === "pending" || a.status === "queued_undo"
          ).length
        : totalPendingCount,
    [approvals, statusTab, totalPendingCount]
  );

  const renderStructuredForm = (item: ApprovalItem) => {
    const isPending = item.status === "pending";
    const draft = draftsById[item.id] ?? hydrateDraftFromItem(item);
    const t = item.action_type;

    if (SLACK_ACTIONS.has(t)) {
      const msgKey = "message" in draft || !("text" in draft) ? "message" : "text";
      const channelKey =
        "channel_id" in draft || !("channel" in draft) ? "channel_id" : "channel";
      return (
        <div className="space-y-3.5">
          <div>
            <label
              htmlFor={`slack-channel-${item.id}`}
              className="mb-1 block text-xs font-medium text-[var(--ink-secondary)]"
            >
              Channel
            </label>
            <input
              id={`slack-channel-${item.id}`}
              type="text"
              disabled={!isPending || t === "slack_self_dm"}
              value={strVal(draft, "channel_id") || strVal(draft, "channel")}
              onChange={(e) =>
                updateDraftField(item, channelKey, e.target.value)
              }
              className="ce-input font-mono"
            />
          </div>
          <div>
            <label
              htmlFor={`slack-msg-${item.id}`}
              className="mb-1 block text-xs font-medium text-[var(--ink-secondary)]"
            >
              Message
            </label>
            <textarea
              id={`slack-msg-${item.id}`}
              rows={5}
              disabled={!isPending}
              value={strVal(draft, msgKey)}
              onChange={(e) => updateDraftField(item, msgKey, e.target.value)}
              className="ce-input resize-y leading-relaxed"
            />
          </div>
        </div>
      );
    }

    if (EMAIL_ACTIONS.has(t)) {
      return (
        <div className="space-y-3.5">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label
                htmlFor={`gmail-to-${item.id}`}
                className="mb-1 block text-xs font-medium text-[var(--ink-secondary)]"
              >
                To
              </label>
              <input
                id={`gmail-to-${item.id}`}
                type="text"
                disabled={!isPending}
                value={strVal(draft, "to") || strVal(draft, "recipient")}
                onChange={(e) => updateDraftField(item, "to", e.target.value)}
                className="ce-input"
              />
            </div>
            <div>
              <label
                htmlFor={`gmail-cc-${item.id}`}
                className="mb-1 block text-xs font-medium text-[var(--ink-secondary)]"
              >
                Cc
              </label>
              <input
                id={`gmail-cc-${item.id}`}
                type="text"
                disabled={!isPending}
                value={strVal(draft, "cc")}
                onChange={(e) => updateDraftField(item, "cc", e.target.value)}
                className="ce-input"
              />
            </div>
          </div>
          <div>
            <label
              htmlFor={`gmail-subject-${item.id}`}
              className="mb-1 block text-xs font-medium text-[var(--ink-secondary)]"
            >
              Subject
            </label>
            <input
              id={`gmail-subject-${item.id}`}
              type="text"
              disabled={!isPending}
              value={strVal(draft, "subject")}
              onChange={(e) => updateDraftField(item, "subject", e.target.value)}
              className="ce-input"
            />
          </div>
          <div>
            <label
              htmlFor={`gmail-body-${item.id}`}
              className="mb-1 block text-xs font-medium text-[var(--ink-secondary)]"
            >
              Body
            </label>
            <textarea
              id={`gmail-body-${item.id}`}
              rows={6}
              disabled={!isPending}
              value={strVal(draft, "body")}
              onChange={(e) => updateDraftField(item, "body", e.target.value)}
              className="ce-input resize-y leading-relaxed"
            />
          </div>
        </div>
      );
    }

    if (t === "github_pr_create") {
      return (
        <div className="space-y-3.5">
          <div>
            <label
              htmlFor={`pr-title-${item.id}`}
              className="mb-1 block text-xs font-medium text-[var(--ink-secondary)]"
            >
              Pull Request Title
            </label>
            <input
              id={`pr-title-${item.id}`}
              type="text"
              disabled={!isPending}
              value={strVal(draft, "title", item.title)}
              onChange={(e) => updateDraftField(item, "title", e.target.value)}
              className="ce-input"
            />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label
                htmlFor={`pr-head-${item.id}`}
                className="mb-1 block text-xs font-medium text-[var(--ink-secondary)]"
              >
                Head Branch
              </label>
              <input
                id={`pr-head-${item.id}`}
                type="text"
                disabled={!isPending}
                value={strVal(draft, "head", item.branch)}
                onChange={(e) => updateDraftField(item, "head", e.target.value)}
                className="ce-input font-mono"
              />
            </div>
            <div>
              <label
                htmlFor={`pr-base-${item.id}`}
                className="mb-1 block text-xs font-medium text-[var(--ink-secondary)]"
              >
                Base Branch
              </label>
              <input
                id={`pr-base-${item.id}`}
                type="text"
                disabled={!isPending}
                value={strVal(draft, "base", "main")}
                onChange={(e) => updateDraftField(item, "base", e.target.value)}
                className="ce-input font-mono"
              />
            </div>
          </div>
          <div>
            <label
              htmlFor={`pr-body-${item.id}`}
              className="mb-1 block text-xs font-medium text-[var(--ink-secondary)]"
            >
              Description
            </label>
            <textarea
              id={`pr-body-${item.id}`}
              rows={6}
              disabled={!isPending}
              value={strVal(draft, "body")}
              onChange={(e) => updateDraftField(item, "body", e.target.value)}
              className="ce-input resize-y leading-relaxed"
            />
          </div>
        </div>
      );
    }

    if (t === "github_pr_reply") {
      const inlineList = Array.isArray(draft.inline_replies)
        ? (draft.inline_replies as Array<Record<string, unknown>>)
        : Array.isArray(draft.replies)
        ? (draft.replies as Array<Record<string, unknown>>)
        : [];
      const inlineKey = Array.isArray(draft.inline_replies)
        ? "inline_replies"
        : "replies";
      const bodyKey =
        "top_level_body" in draft || !("body" in draft)
          ? "top_level_body"
          : "body";

      return (
        <div className="space-y-3.5">
          <div>
            <label
              htmlFor={`reply-top-${item.id}`}
              className="mb-1 block text-xs font-medium text-[var(--ink-secondary)]"
            >
              Summary Reply
            </label>
            <textarea
              id={`reply-top-${item.id}`}
              rows={4}
              disabled={!isPending}
              value={strVal(draft, bodyKey)}
              onChange={(e) => updateDraftField(item, bodyKey, e.target.value)}
              className="ce-input resize-y leading-relaxed"
            />
          </div>

          {inlineList.length > 0 && (
            <div className="space-y-2">
              <div className="text-xs font-medium text-[var(--ink-secondary)]">
                Inline Replies ({inlineList.length})
              </div>
              <div className="divide-y divide-[var(--line)] rounded-xl border border-[var(--line)]">
                {inlineList.map((rep, idx) => (
                  <div key={idx} className="space-y-1.5 p-3 text-xs">
                    <div className="font-mono text-[11px] text-[var(--muted)]">
                      {strVal(rep, "path", "comment")}
                      {rep.line ? `:${String(rep.line)}` : ""}
                    </div>
                    <textarea
                      rows={2}
                      disabled={!isPending}
                      value={strVal(rep, "body")}
                      onChange={(e) => {
                        const updated = inlineList.map((entry, i) =>
                          i === idx ? { ...entry, body: e.target.value } : entry
                        );
                        updateDraftField(item, inlineKey, updated);
                      }}
                      className="ce-input resize-y text-xs"
                    />
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      );
    }

    if (BOARD_MOVE_ACTIONS.has(t)) {
      return (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label
              htmlFor={`board-from-${item.id}`}
              className="mb-1 block text-xs font-medium text-[var(--ink-secondary)]"
            >
              From
            </label>
            <input
              id={`board-from-${item.id}`}
              type="text"
              disabled={!isPending}
              value={strVal(draft, "from_status") || strVal(draft, "from_column")}
              onChange={(e) =>
                updateDraftField(item, "from_status", e.target.value)
              }
              className="ce-input"
            />
          </div>
          <div>
            <label
              htmlFor={`board-to-${item.id}`}
              className="mb-1 block text-xs font-medium text-[var(--ink-secondary)]"
            >
              To
            </label>
            <input
              id={`board-to-${item.id}`}
              type="text"
              disabled={!isPending}
              value={
                strVal(draft, "to_status") ||
                strVal(draft, "to_column") ||
                strVal(draft, "status")
              }
              onChange={(e) =>
                updateDraftField(item, "to_status", e.target.value)
              }
              className="ce-input"
            />
          </div>
        </div>
      );
    }

    if (DRIVE_ACTIONS.has(t)) {
      const textKey =
        "content" in draft && !("comment_text" in draft)
          ? "content"
          : "comment_text";
      const opVal = strVal(draft, "operation", "comment");
      return (
        <div className="space-y-3.5">
          <div>
            <label
              htmlFor={`drive-op-${item.id}`}
              className="mb-1 block text-xs font-medium text-[var(--ink-secondary)]"
            >
              Operation
            </label>
            <select
              id={`drive-op-${item.id}`}
              disabled={!isPending}
              value={opVal}
              onChange={(e) =>
                updateDraftField(item, "operation", e.target.value)
              }
              className="ce-input"
            >
              <option value="comment">Comment</option>
              <option value="resolve">Resolve Thread</option>
              <option value="suggest">Suggest Edit</option>
            </select>
          </div>
          <div>
            <label
              htmlFor={`drive-text-${item.id}`}
              className="mb-1 block text-xs font-medium text-[var(--ink-secondary)]"
            >
              Comment
            </label>
            <textarea
              id={`drive-text-${item.id}`}
              rows={5}
              disabled={!isPending}
              value={
                strVal(draft, textKey) ||
                strVal(draft, "comment") ||
                strVal(draft, "text")
              }
              onChange={(e) => updateDraftField(item, textKey, e.target.value)}
              className="ce-input resize-y leading-relaxed"
            />
          </div>
        </div>
      );
    }

    const entries = Object.entries(draft);
    if (entries.length === 0) {
      return (
        <p className="text-xs text-[var(--muted)]">
          No editable parameters for this action.
        </p>
      );
    }

    return (
      <div className="space-y-3">
        {entries.map(([key, val]) => {
          const inputId = `gen-${item.id}-${key}`;
          const isLong = typeof val === "string" && val.length > 80;
          return (
            <div key={key}>
              <label
                htmlFor={inputId}
                className="mb-1 block font-mono text-[11px] font-medium text-[var(--ink-secondary)]"
              >
                {key}
              </label>
              {isLong ? (
                <textarea
                  id={inputId}
                  rows={4}
                  disabled={!isPending}
                  value={String(val)}
                  onChange={(e) => updateDraftField(item, key, e.target.value)}
                  className="ce-input resize-y"
                />
              ) : (
                <input
                  id={inputId}
                  type={typeof val === "number" ? "number" : "text"}
                  disabled={!isPending}
                  value={
                    typeof val === "object" && val !== null
                      ? JSON.stringify(val)
                      : String(val ?? "")
                  }
                  onChange={(e) =>
                    updateDraftField(
                      item,
                      key,
                      typeof val === "number"
                        ? Number(e.target.value)
                        : e.target.value
                    )
                  }
                  className="ce-input font-mono text-xs"
                />
              )}
            </div>
          );
        })}
      </div>
    );
  };

  const renderOutboundPreview = (
    item: ApprovalItem,
    draft: Record<string, unknown>
  ) => {
    const t = item.action_type;
    const previewBody = buildDraftPreviewBody(item, draft);
    const payloadDiff = strVal(draft, "diff") || strVal(draft, "patch");

    if (SLACK_ACTIONS.has(t)) {
      const senderLabel =
        strVal(draft, "sender") || item.created_by_agent || "You";
      return (
        <div className="space-y-2.5 rounded-xl border border-[var(--line)] bg-[var(--surface-sunken)]/45 p-4">
          <div className="flex items-center justify-between gap-2 text-xs text-[var(--muted)]">
            <span className="font-medium text-[var(--ink-secondary)]">
              {senderLabel}
            </span>
            <span className="font-mono text-[11px] tabular-nums">
              {formatDateTime(item.created_at)}
            </span>
          </div>
          <div className="min-w-0 text-[13.5px] leading-relaxed text-[var(--ink)]">
            <MarkdownRenderer content={previewBody || "_Empty message_"} />
          </div>
        </div>
      );
    }

    if (EMAIL_ACTIONS.has(t)) {
      const to = strVal(draft, "to") || strVal(draft, "recipient") || "—";
      const cc = strVal(draft, "cc");
      const subject = strVal(draft, "subject") || item.title;
      return (
        <div className="overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--surface-sunken)]/35">
          <div className="divide-y divide-[var(--line)] border-b border-[var(--line)] bg-[var(--surface)]/60 text-xs">
            <div className="flex items-baseline gap-3 px-4 py-2">
              <span className="w-14 shrink-0 font-mono text-[11px] text-[var(--muted)]">
                To
              </span>
              <span className="min-w-0 break-all font-medium text-[var(--ink)]">
                {to}
              </span>
            </div>
            {cc && (
              <div className="flex items-baseline gap-3 px-4 py-2">
                <span className="w-14 shrink-0 font-mono text-[11px] text-[var(--muted)]">
                  Cc
                </span>
                <span className="min-w-0 break-all text-[var(--ink-secondary)]">
                  {cc}
                </span>
              </div>
            )}
            <div className="flex items-baseline gap-3 px-4 py-2.5">
              <span className="w-14 shrink-0 font-mono text-[11px] text-[var(--muted)]">
                Subject
              </span>
              <span className="min-w-0 break-words font-semibold text-[var(--ink)]">
                {subject}
              </span>
            </div>
          </div>
          <div className="min-w-0 p-4 text-[13.5px] leading-relaxed text-[var(--ink)]">
            <MarkdownRenderer content={previewBody || "_Empty email body_"} />
          </div>
        </div>
      );
    }

    if (GITHUB_CODE_ACTIONS.has(t)) {
      const head = strVal(draft, "head", item.branch) || strVal(draft, "branch");
      const base = strVal(draft, "base");
      const isDraftPr = Boolean(draft.draft);
      const inlineList = Array.isArray(draft.inline_replies)
        ? (draft.inline_replies as Array<Record<string, unknown>>)
        : Array.isArray(draft.replies)
        ? (draft.replies as Array<Record<string, unknown>>)
        : [];
      const diffToRender = payloadDiff.trim() || item.diff_preview?.trim() || "";

      return (
        <div className="space-y-3.5">
          {(head || isDraftPr) && (
            <div className="flex flex-wrap items-center gap-2">
              {head && (
                <span className="ce-pill font-mono text-[11px]">
                  <GitBranch className="h-3 w-3 text-[var(--accent)]" />
                  <span>{base ? `${head} → ${base}` : head}</span>
                </span>
              )}
              {isDraftPr && (
                <span className="ce-pill ce-pill-amber font-mono">Draft PR</span>
              )}
            </div>
          )}

          {previewBody.trim() && (
            <div className="min-w-0 rounded-xl border border-[var(--line)] bg-[var(--surface-sunken)]/40 p-4 text-[13.5px] leading-relaxed text-[var(--ink)]">
              <MarkdownRenderer content={previewBody} />
            </div>
          )}

          {inlineList.length > 0 && (
            <div className="divide-y divide-[var(--line)] rounded-xl border border-[var(--line)] bg-[var(--surface-sunken)]/30">
              {inlineList.map((rep, idx) => (
                <div key={idx} className="space-y-1.5 p-3.5 text-xs">
                  <div className="font-mono text-[11px] text-[var(--muted)]">
                    {strVal(rep, "path", "comment")}
                    {rep.line ? `:${String(rep.line)}` : ""}
                  </div>
                  <MarkdownRenderer content={strVal(rep, "body")} />
                </div>
              ))}
            </div>
          )}

          {diffToRender && <DiffViewer diff={diffToRender} />}
        </div>
      );
    }

    if (BOARD_MOVE_ACTIONS.has(t)) {
      const fromCol =
        strVal(draft, "from_status") ||
        strVal(draft, "from_column") ||
        strVal(draft, "current_status") ||
        "Current";
      const toCol =
        strVal(draft, "to_status") ||
        strVal(draft, "to_column") ||
        strVal(draft, "target_status") ||
        strVal(draft, "status") ||
        "Target";

      return (
        <div className="space-y-3.5">
          {item.summary && item.summary.trim() !== item.title.trim() && (
            <div className="text-[13.5px] leading-relaxed text-[var(--ink-secondary)]">
              <MarkdownRenderer content={item.summary} />
            </div>
          )}
          <div className="flex flex-wrap items-center gap-3 rounded-xl border border-[var(--line)] bg-[var(--surface-sunken)]/40 p-4">
            <span className="inline-flex items-center rounded-lg border border-[var(--line-strong)] bg-[var(--surface)] px-3 py-1.5 text-xs font-medium text-[var(--ink-secondary)]">
              {fromCol}
            </span>
            <ArrowRight className="h-4 w-4 shrink-0 text-[var(--muted)]" />
            <span className="inline-flex items-center rounded-lg border border-[var(--sage-border)] bg-[var(--sage-soft)] px-3 py-1.5 text-xs font-semibold text-[var(--sage)]">
              {toCol}
            </span>
          </div>
        </div>
      );
    }

    if (DRIVE_ACTIONS.has(t)) {
      const op = (
        strVal(draft, "operation") ||
        strVal(draft, "action") ||
        "comment"
      ).toLowerCase();
      const anchor =
        strVal(draft, "quoted_text") ||
        strVal(draft, "anchor_text") ||
        strVal(draft, "quote") ||
        strVal(draft, "selection");

      return (
        <div className="space-y-3 rounded-xl border border-[var(--line)] bg-[var(--surface-sunken)]/40 p-4">
          <div className="flex items-center justify-between gap-2 text-xs text-[var(--muted)]">
            <span className="inline-flex items-center gap-1.5 font-medium text-[var(--ink-secondary)]">
              <FileText className="h-3.5 w-3.5 text-[var(--accent)]" />
              <span className="capitalize">{op}</span>
            </span>
          </div>

          {anchor && (
            <blockquote className="rounded-r-lg border-l-2 border-[var(--line-strong)] bg-[var(--surface)]/75 px-3 py-2 text-xs italic text-[var(--ink-secondary)]">
              “{anchor}”
            </blockquote>
          )}

          <div className="min-w-0 text-[13.5px] leading-relaxed text-[var(--ink)]">
            <MarkdownRenderer content={previewBody || "_No comment text_"} />
          </div>
        </div>
      );
    }

    return (
      <div className="space-y-3.5">
        {previewBody.trim() && (
          <div className="min-w-0 rounded-xl border border-[var(--line)] bg-[var(--surface-sunken)]/40 p-4 text-[13.5px] leading-relaxed text-[var(--ink)]">
            <MarkdownRenderer content={previewBody} />
          </div>
        )}
        {item.diff_preview && item.diff_preview.trim() !== "" && (
          <DiffViewer diff={item.diff_preview} />
        )}
      </div>
    );
  };

  return (
    <div className="mx-auto w-full max-w-[1160px] space-y-4 px-6 pt-2 pb-8">
      <WorkspaceHeader
        title="Approvals"
        tabs={[
          {
            id: "pending",
            label: "Pending",
            count: pendingCount,
            dot: pendingCount > 0 ? "amber" : undefined,
          },
          { id: "executed", label: "Approved" },
          { id: "rejected", label: "Rejected" },
          { id: "all", label: "All" },
          { id: "policies", label: "Policies" },
        ]}
        activeTab={statusTab}
        onTabChange={(id) => {
          setStatusTab(id as ApprovalStatusTab);
          setIsEditing(false);
        }}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative w-44 sm:w-52">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-[var(--muted)]" />
              <input
                ref={searchInputRef}
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search… (/)"
                aria-label="Search approvals"
                className="ce-input h-8 rounded-full pr-7 pl-8 text-xs"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery("")}
                  aria-label="Clear search"
                  className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-0.5 text-[var(--muted)] hover:text-[var(--ink)]"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>

            {statusTab !== "policies" && (
              <button
                type="button"
                data-testid="undo-send-toggle"
                aria-pressed={undoSendEnabled}
                onClick={() => setUndoSendEnabled((v) => !v)}
                className={`ce-btn h-8 rounded-full px-3 text-xs ${
                  undoSendEnabled ? "ce-btn-accent" : ""
                }`}
              >
                <Clock className="h-3.5 w-3.5" />
                <span>10s Undo Send: {undoSendEnabled ? "ON" : "OFF"}</span>
              </button>
            )}

            <button
              type="button"
              aria-pressed={previewLocked}
              onClick={() => setPreviewLocked((v) => !v)}
              className={`ce-btn h-8 rounded-full px-3 text-xs ${
                previewLocked ? "ce-btn-sage" : "ce-btn-danger"
              }`}
            >
              {previewLocked ? (
                <>
                  <Lock className="h-3.5 w-3.5" />
                  <span>Safety Lock: On</span>
                </>
              ) : (
                <>
                  <Unlock className="h-3.5 w-3.5" />
                  <span>Safety Lock: Armed</span>
                </>
              )}
            </button>
          </div>
        }
      />

      {fetchError && (
        <ErrorBanner
          title="Unable to load approvals"
          message={fetchError}
          onRetry={() => void loadData(false)}
        />
      )}

      {statusTab === "policies" ? (
        loading && policies.length === 0 ? (
          <div className="ce-card p-5">
            <SkeletonRows rows={5} />
          </div>
        ) : (
          <div className="ce-card overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--line)] px-5 py-3.5">
              <div>
                <h2 className="text-sm font-semibold text-[var(--ink)]">
                  Autonomy Policies
                </h2>
                <p className="mt-0.5 text-xs text-[var(--muted)]">
                  Control which actions require human sign-off before execution.
                </p>
              </div>
              {autonomyPosture && (
                <span className="ce-pill ce-pill-accent capitalize">
                  Posture: {autonomyPosture}
                </span>
              )}
            </div>

            {filteredPolicies.length === 0 ? (
              <div className="px-6 py-10 text-center text-xs text-[var(--muted)]">
                No autonomy policies match your search.
              </div>
            ) : (
              <div className="divide-y divide-[var(--line)]">
                {filteredPolicies.map((policy) => {
                  const isLocked =
                    policy.locked === 1 || policy.mode === "read_only_locked";
                  const busy = togglingPolicy === policy.action_type;
                  return (
                    <div
                      key={policy.action_type}
                      className="flex flex-wrap items-center justify-between gap-4 px-5 py-3.5"
                    >
                      <div className="min-w-0 flex-1 space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-[13px] font-medium text-[var(--ink)]">
                            {policy.label ||
                              formatActionTypeLabel(policy.action_type)}
                          </span>
                          <span className="ce-pill font-mono text-[10.5px]">
                            {policy.category}
                          </span>
                          <span className="font-mono text-[11px] text-[var(--muted)]">
                            {policy.action_type}
                          </span>
                        </div>
                        {policy.description && (
                          <p className="text-xs leading-relaxed text-[var(--muted)]">
                            {policy.description}
                          </p>
                        )}
                      </div>

                      <div className="shrink-0">
                        {isLocked ? (
                          <span className="ce-pill">
                            <Lock className="h-3 w-3" />
                            <span>Read-Only Locked</span>
                          </span>
                        ) : (
                          <div className="inline-flex items-center rounded-lg border border-[var(--line)] bg-[var(--surface-sunken)] p-0.5">
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() =>
                                void handleTogglePolicy(policy, "ask_first")
                              }
                              className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                                policy.mode === "ask_first"
                                  ? "bg-[var(--amber-soft)] text-[var(--amber)] ring-1 ring-[var(--amber-border)]"
                                  : "text-[var(--muted)] hover:text-[var(--ink)]"
                              }`}
                            >
                              Ask First
                            </button>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() =>
                                void handleTogglePolicy(policy, "auto")
                              }
                              className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                                policy.mode === "auto"
                                  ? "bg-[var(--sage-soft)] text-[var(--sage)] ring-1 ring-[var(--sage-border)]"
                                  : "text-[var(--muted)] hover:text-[var(--ink)]"
                              }`}
                            >
                              Auto
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )
      ) : loading && approvals.length === 0 ? (
        <div className="ce-card p-5">
          <SkeletonRows rows={5} />
        </div>
      ) : (
        <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-12">
          {/* Left: Queue List */}
          <aside className="ce-card max-h-[74vh] divide-y divide-[var(--line)] overflow-y-auto lg:col-span-4">
            {filteredApprovals.length === 0 ? (
              <div className="flex min-h-[260px] flex-col items-center justify-center px-6 py-10 text-center">
                <ShieldCheck className="h-6 w-6 text-[var(--sage)]" />
                <p className="mt-3 text-[13.5px] font-medium text-[var(--ink)]">
                  {searchQuery.trim()
                    ? `No matches for "${searchQuery.trim()}"`
                    : statusTab === "pending"
                    ? "All caught up — 0 actions waiting"
                    : statusTab === "executed"
                    ? "No approved actions yet"
                    : statusTab === "rejected"
                    ? "No rejected actions"
                    : "No approval records found"}
                </p>
              </div>
            ) : (
              filteredApprovals.map((item, idx) => {
                const active = selected?.id === item.id;
                const dirty = isItemDraftDirty(item);
                const itemQueued =
                  item.status === "queued_undo" ||
                  undoCountdowns[item.id] !== undefined;
                const itemRemaining =
                  undoCountdowns[item.id] ??
                  (item.status === "queued_undo" ? 10 : 0);

                return (
                  <button
                    key={item.id}
                    ref={(el) => {
                      cardRefs.current[item.id] = el;
                    }}
                    type="button"
                    data-selected={active ? "true" : "false"}
                    data-index={idx}
                    onClick={() => {
                      setSelectedId(item.id);
                      setIsEditing(false);
                    }}
                    className={`w-full px-4 py-3.5 text-left transition-colors ${
                      active
                        ? "bg-[var(--accent-soft)]/65 ring-1 ring-inset ring-[var(--accent-border)]"
                        : "hover:bg-[var(--surface-raised)]/45"
                    }`}
                  >
                    <p className="line-clamp-2 text-[13px] font-medium leading-snug text-[var(--ink)]">
                      {item.title}
                    </p>
                    <p className="mt-1 flex items-center gap-1.5 text-[11.5px] text-[var(--muted)]">
                      <span className="truncate">
                        {formatActionTypeLabel(item.action_type)}
                      </span>
                      <span>·</span>
                      <span className="shrink-0 font-mono text-[11px] tabular-nums">
                        {formatRelativeTime(item.created_at)}
                      </span>
                      {itemQueued ? (
                        <span className="ce-pill ce-pill-amber ml-auto shrink-0 font-mono text-[10px] tabular-nums">
                          {itemRemaining}s
                        </span>
                      ) : (
                        dirty && (
                          <span
                            title="Edited locally"
                            className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--amber)]"
                          />
                        )
                      )}
                    </p>
                  </button>
                );
              })
            )}
          </aside>

          {/* Right: Clean Sign-Off Sheet */}
          <section className="ce-card flex flex-col overflow-hidden lg:col-span-8">
            {selected ? (
              (() => {
                const isPending = selected.status === "pending";
                const isQueuedUndo =
                  selected.status === "queued_undo" ||
                  undoCountdowns[selected.id] !== undefined;
                const remainingUndoSec =
                  undoCountdowns[selected.id] ??
                  (selected.status === "queued_undo" ? 10 : 0);
                const totalUndoSec = undoTotalById[selected.id] || 10;
                const undoProgressPct = Math.max(
                  0,
                  Math.min(100, (remainingUndoSec / totalUndoSec) * 100)
                );

                const currentDraft =
                  draftsById[selected.id] ?? hydrateDraftFromItem(selected);
                const draftDirty = isItemDraftDirty(selected);
                const targetPill = getHeaderTargetPill(selected, currentDraft);
                const rawJsonText =
                  rawJsonById[selected.id] ??
                  JSON.stringify(currentDraft, null, 2);
                const rawJsonError = rawJsonErrorById[selected.id] ?? null;

                const showToneBar =
                  isPending && hasEditableTextDraft(selected, currentDraft);
                const hasRewriteSnapshot = Boolean(
                  preRewriteDraftById[selected.id]
                );
                const customPolishText = customPolishById[selected.id] ?? "";
                const isRewritingThis = rewritingId === selected.id;

                const selectedContext = contextById[selected.id];
                const hasContext = Boolean(
                  selectedContext &&
                    (selectedContext.related_events.length > 0 ||
                      selectedContext.related_tasks.length > 0)
                );

                return (
                  <>
                    {/* Clean Header */}
                    <header className="border-b border-[var(--line)] px-6 py-4">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex min-w-0 flex-wrap items-center gap-2">
                          <span className="ce-pill ce-pill-accent">
                            {formatActionTypeLabel(selected.action_type)}
                          </span>
                          {targetPill && (
                            <span className="ce-pill max-w-[260px] truncate font-mono text-[11px]">
                              {targetPill}
                            </span>
                          )}
                          {draftDirty && isPending && (
                            <span className="ce-pill ce-pill-amber font-mono text-[10.5px]">
                              Edited
                            </span>
                          )}
                        </div>
                        <div className="flex shrink-0 items-center gap-2.5 font-mono text-[11px] text-[var(--muted)] tabular-nums">
                          {selectedIndex >= 0 && (
                            <span>
                              {selectedIndex + 1}/{filteredApprovals.length}
                            </span>
                          )}
                          <span>{formatRelativeTime(selected.created_at)}</span>
                        </div>
                      </div>

                      <h2 className="mt-1.5 text-[17px] font-semibold leading-snug text-[var(--ink)]">
                        {selected.title}
                      </h2>
                    </header>

                    {/* Body */}
                    <div className="ce-contain-scroll max-h-[62vh] flex-1 space-y-4 overflow-y-auto p-6">
                      {validationErrorById[selected.id] && (
                        <div className="flex items-start gap-2 rounded-xl border border-[var(--coral-border)] bg-[var(--coral-soft)] px-4 py-3 text-xs text-[var(--coral)]">
                          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                          <p className="min-w-0 break-words">
                            {validationErrorById[selected.id]}
                          </p>
                        </div>
                      )}

                      {/* Feature 3: 10-Second Undo Send Banner */}
                      {isQueuedUndo && (
                        <div
                          data-testid="undo-send-banner"
                          className="overflow-hidden rounded-xl border border-[var(--amber-border)] bg-gradient-to-r from-[var(--amber-soft)] via-[var(--accent-soft)] to-[var(--surface-raised)]"
                        >
                          <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                            <div className="flex min-w-0 items-center gap-2.5">
                              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-[var(--amber-border)] bg-[var(--amber-soft)] text-[var(--amber)]">
                                <Clock className="h-3.5 w-3.5" />
                              </span>
                              <div className="min-w-0">
                                <p className="text-xs font-semibold text-[var(--ink)]">
                                  Outbound action queued · Executing in{" "}
                                  <span className="font-mono tabular-nums text-[var(--amber)]">
                                    {remainingUndoSec}s
                                  </span>
                                  …
                                </p>
                                <p className="text-[11px] text-[var(--muted)]">
                                  Press{" "}
                                  <kbd className="rounded border border-[var(--line-strong)] bg-[var(--surface)] px-1 py-0.5 font-mono text-[10px]">
                                    u
                                  </kbd>{" "}
                                  or click Undo Send to cancel before dispatch.
                                </p>
                              </div>
                            </div>

                            <div className="flex shrink-0 items-center gap-2">
                              <button
                                type="button"
                                data-testid="undo-send-btn"
                                disabled={undoActionBusyId !== null}
                                onClick={() => void handleUndoApproval(selected)}
                                className="ce-btn h-8 border-[var(--amber-border)] bg-[var(--surface)] px-3 text-xs font-semibold text-[var(--amber)] hover:bg-[var(--amber-soft)]"
                              >
                                <Undo2 className="h-3.5 w-3.5" />
                                <span>Undo Send</span>
                              </button>
                              <button
                                type="button"
                                disabled={undoActionBusyId !== null}
                                onClick={() => void handleExecuteNow(selected)}
                                className="ce-btn ce-btn-primary h-8 px-3 text-xs"
                              >
                                <Zap className="h-3.5 w-3.5" />
                                <span>Execute Now</span>
                              </button>
                            </div>
                          </div>

                          <div className="h-1 w-full bg-[var(--surface-sunken)]">
                            <div
                              className="h-full bg-gradient-to-r from-[var(--amber)] to-[var(--accent)] transition-[width] duration-1000 ease-linear"
                              style={{ width: `${undoProgressPct}%` }}
                            />
                          </div>
                        </div>
                      )}

                      {/* Feature 2: Source Thread & Linked Obligation Context Strip */}
                      {hasContext && selectedContext && (
                        <div
                          data-testid="approval-source-context"
                          className="rounded-xl border border-[var(--line)] bg-[var(--surface-sunken)]/55 p-3.5"
                        >
                          <div className="mb-2 flex items-center justify-between gap-2">
                            <span className="ce-kicker">
                              Originating Context
                            </span>
                            <span className="font-mono text-[10.5px] text-[var(--muted)] tabular-nums">
                              {selectedContext.related_events.length +
                                selectedContext.related_tasks.length}{" "}
                              linked
                            </span>
                          </div>

                          <div className="space-y-2">
                            {selectedContext.related_events.map((ev) => (
                              <div
                                key={`ev-${ev.id}`}
                                className="flex items-start justify-between gap-3 rounded-lg border border-[var(--line)] bg-[var(--surface)]/75 px-3 py-2"
                              >
                                <div className="flex min-w-0 items-start gap-2.5">
                                  <span className="mt-0.5 shrink-0">
                                    <SourceIcon
                                      source={ev.source}
                                      className="h-3.5 w-3.5"
                                    />
                                  </span>
                                  <div className="min-w-0 space-y-0.5">
                                    <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-[var(--muted)]">
                                      <span className="font-mono font-medium text-[var(--ink-secondary)]">
                                        {ev.channel_or_repo ||
                                          formatEventType(ev.event_type)}
                                      </span>
                                      {ev.actor && (
                                        <>
                                          <span>·</span>
                                          <span>{ev.actor}</span>
                                        </>
                                      )}
                                      <span>·</span>
                                      <span className="font-mono tabular-nums">
                                        {formatRelativeTime(ev.occurred_at)}
                                      </span>
                                    </div>
                                    <p className="truncate text-xs font-medium text-[var(--ink)]">
                                      {ev.title}
                                    </p>
                                    {(ev.summary || ev.body) && (
                                      <p className="line-clamp-2 text-[11.5px] leading-relaxed text-[var(--ink-secondary)]">
                                        {ev.summary || ev.body}
                                      </p>
                                    )}
                                  </div>
                                </div>

                                {ev.url && (
                                  <a
                                    href={ev.url}
                                    target="_blank"
                                    rel="noreferrer"
                                    aria-label={`Open source link for ${ev.title}`}
                                    className="ce-btn ce-btn-ghost h-7 shrink-0 px-2 text-[11px]"
                                  >
                                    <ExternalLink className="h-3 w-3" />
                                  </a>
                                )}
                              </div>
                            ))}

                            {selectedContext.related_tasks.map((task) => (
                              <div
                                key={`task-${task.id}`}
                                className="flex items-start justify-between gap-3 rounded-lg border border-[var(--line)] bg-[var(--surface)]/75 px-3 py-2"
                              >
                                <div className="flex min-w-0 items-start gap-2.5">
                                  <span className="mt-0.5 shrink-0">
                                    <SourceIcon
                                      source={task.source}
                                      className="h-3.5 w-3.5"
                                    />
                                  </span>
                                  <div className="min-w-0 space-y-0.5">
                                    <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-[var(--muted)]">
                                      <PriorityBadge priority={task.priority} />
                                      <span className="font-mono font-medium text-[var(--ink-secondary)]">
                                        {task.repo || task.source}
                                      </span>
                                      {(task.counterparty || task.owner) && (
                                        <>
                                          <span>·</span>
                                          <span>
                                            {task.counterparty || task.owner}
                                          </span>
                                        </>
                                      )}
                                      <span>·</span>
                                      <span className="font-mono tabular-nums">
                                        {formatRelativeTime(
                                          task.updated_at || task.created_at
                                        )}
                                      </span>
                                    </div>
                                    <p className="truncate text-xs font-medium text-[var(--ink)]">
                                      {task.title}
                                    </p>
                                    {task.description && (
                                      <p className="line-clamp-2 text-[11.5px] leading-relaxed text-[var(--ink-secondary)]">
                                        {task.description}
                                      </p>
                                    )}
                                  </div>
                                </div>

                                {task.source_url && (
                                  <a
                                    href={task.source_url}
                                    target="_blank"
                                    rel="noreferrer"
                                    aria-label={`Open task link for ${task.title}`}
                                    className="ce-btn ce-btn-ghost h-7 shrink-0 px-2 text-[11px]"
                                  >
                                    <ExternalLink className="h-3 w-3" />
                                  </a>
                                )}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Feature 1: AI Draft Tone Rewriter Bar */}
                      {showToneBar && (
                        <div
                          data-testid="approval-tone-bar"
                          className="flex flex-col gap-2 rounded-xl border border-[var(--line)] bg-[var(--surface-raised)]/55 px-3.5 py-2.5"
                        >
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className="mr-1 inline-flex items-center gap-1 text-[11px] font-medium text-[var(--accent)]">
                                {isRewritingThis ? (
                                  <Loader2 className="h-3 w-3 animate-spin" />
                                ) : (
                                  <Sparkles className="h-3 w-3" />
                                )}
                                <span>AI Tone Polish</span>
                              </span>

                              {TONE_OPTIONS.map((tone) => {
                                const isActiveTone =
                                  isRewritingThis &&
                                  rewritingStyle === tone.style;
                                return (
                                  <button
                                    key={tone.style}
                                    type="button"
                                    disabled={rewritingId !== null}
                                    onClick={() =>
                                      void handleRewriteTone(
                                        selected,
                                        tone.style
                                      )
                                    }
                                    className={`ce-pill cursor-pointer transition-colors hover:border-[var(--accent-border)] hover:bg-[var(--accent-soft)] hover:text-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-50 ${
                                      isActiveTone
                                        ? "ce-pill-accent"
                                        : ""
                                    }`}
                                  >
                                    {tone.label}
                                  </button>
                                );
                              })}

                              {hasRewriteSnapshot && (
                                <button
                                  type="button"
                                  disabled={rewritingId !== null}
                                  onClick={() => handleRevertTone(selected)}
                                  className="ce-pill ce-pill-amber cursor-pointer transition-opacity hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-50"
                                >
                                  <RotateCcw className="h-2.5 w-2.5" />
                                  <span>Revert</span>
                                </button>
                              )}
                            </div>

                            <form
                              onSubmit={(e) => {
                                e.preventDefault();
                                if (!customPolishText.trim()) return;
                                void handleRewriteTone(
                                  selected,
                                  "custom",
                                  customPolishText.trim()
                                );
                              }}
                              className="flex min-w-[200px] flex-1 items-center gap-1.5 sm:max-w-[260px]"
                            >
                              <input
                                type="text"
                                value={customPolishText}
                                disabled={rewritingId !== null}
                                onChange={(e) =>
                                  setCustomPolishById((prev) => ({
                                    ...prev,
                                    [selected.id]: e.target.value,
                                  }))
                                }
                                placeholder="Custom polish…"
                                aria-label="Custom polish instruction"
                                className="ce-input h-7 rounded-full px-2.5 text-[11px]"
                              />
                              <button
                                type="submit"
                                disabled={
                                  rewritingId !== null ||
                                  !customPolishText.trim()
                                }
                                className="ce-btn h-7 rounded-full px-2.5 text-[11px]"
                              >
                                Polish
                              </button>
                            </form>
                          </div>
                        </div>
                      )}

                      {!isEditing ? (
                        <>
                          {renderOutboundPreview(selected, currentDraft)}

                          {selected.execution_result &&
                            Object.keys(selected.execution_result).length > 0 && (
                              <div className="divide-y divide-[var(--line)] rounded-xl border border-[var(--line)] bg-[var(--surface-sunken)]/35 text-xs">
                                {Object.entries(selected.execution_result).map(
                                  ([k, v]) => (
                                    <div
                                      key={k}
                                      className="flex items-baseline justify-between gap-3 px-3.5 py-2"
                                    >
                                      <span className="font-mono text-[11px] text-[var(--muted)]">
                                        {k}
                                      </span>
                                      <span className="font-mono text-[11.5px] break-all text-[var(--ink)]">
                                        {typeof v === "string"
                                          ? v
                                          : JSON.stringify(v)}
                                      </span>
                                    </div>
                                  )
                                )}
                              </div>
                            )}
                        </>
                      ) : (
                        <div className="space-y-4">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-xs font-medium text-[var(--ink-secondary)]">
                              Edit Draft
                            </span>
                            <div className="flex items-center gap-2">
                              {isPending && draftDirty && (
                                <button
                                  type="button"
                                  onClick={() => resetDraft(selected)}
                                  className="ce-btn ce-btn-ghost h-7 px-2 text-xs text-[var(--amber)]"
                                >
                                  <RotateCcw className="h-3 w-3" />
                                  <span>Reset</span>
                                </button>
                              )}
                              <button
                                type="button"
                                onClick={() =>
                                  setPayloadEditorMode((m) =>
                                    m === "structured" ? "json" : "structured"
                                  )
                                }
                                className="ce-btn ce-btn-ghost h-7 px-2 text-[11px] text-[var(--muted)]"
                              >
                                {payloadEditorMode === "structured"
                                  ? "Raw JSON"
                                  : "Form View"}
                              </button>
                            </div>
                          </div>

                          {payloadEditorMode === "structured" ? (
                            renderStructuredForm(selected)
                          ) : (
                            <div className="space-y-2">
                              <textarea
                                rows={10}
                                disabled={!isPending}
                                value={rawJsonText}
                                onChange={(e) =>
                                  handleRawJsonChange(selected, e.target.value)
                                }
                                aria-label="Raw payload JSON"
                                className="ce-input resize-y font-mono text-xs leading-relaxed"
                              />
                              {rawJsonError && (
                                <p className="font-mono text-[11px] text-[var(--coral)]">
                                  {rawJsonError}
                                </p>
                              )}
                            </div>
                          )}
                        </div>
                      )}
                    </div>

                    {/* Clean Footer Action Bar */}
                    <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--line)] bg-[var(--surface-sunken)]/50 px-6 py-3.5">
                      <div className="flex flex-wrap items-center gap-2.5">
                        {isQueuedUndo ? (
                          <span className="ce-pill ce-pill-amber font-mono tabular-nums">
                            Queued · {remainingUndoSec}s
                          </span>
                        ) : isPending ? (
                          previewLocked ? (
                            <button
                              type="button"
                              onClick={() => setPreviewLocked(false)}
                              className="ce-btn ce-btn-primary"
                            >
                              <Unlock className="h-3.5 w-3.5" />
                              <span>Unlock Safety Lock to Approve</span>
                            </button>
                          ) : (
                            <>
                              <button
                                type="button"
                                disabled={decidingId !== null}
                                onClick={() =>
                                  requestDecisionConfirmation(
                                    selected,
                                    "approve",
                                    true
                                  )
                                }
                                className="ce-btn ce-btn-primary"
                              >
                                <Check className="h-3.5 w-3.5" />
                                <span>
                                  {decidingId === selected.id
                                    ? "Executing…"
                                    : "Approve & Execute"}
                                </span>
                              </button>
                              <button
                                type="button"
                                disabled={decidingId !== null}
                                onClick={() =>
                                  requestDecisionConfirmation(
                                    selected,
                                    "reject",
                                    false
                                  )
                                }
                                className="ce-btn ce-btn-danger"
                              >
                                <X className="h-3.5 w-3.5" />
                                <span>Reject</span>
                              </button>
                            </>
                          )
                        ) : (
                          <StatusBadge status={selected.status} variant="pill" />
                        )}
                      </div>

                      {isPending && !isQueuedUndo && (
                        <button
                          type="button"
                          onClick={() => setIsEditing((v) => !v)}
                          className="ce-btn"
                        >
                          <span>{isEditing ? "Preview" : "Edit Draft"}</span>
                        </button>
                      )}
                    </footer>
                  </>
                );
              })()
            ) : (
              <div className="flex min-h-[260px] items-center justify-center p-8 text-xs text-[var(--muted)]">
                Select an action to review.
              </div>
            )}
          </section>
        </div>
      )}

      {/* Confirmation Modal */}
      <ModalDialog
        open={confirmDecision !== null}
        onClose={() => {
          if (decidingId === null) setConfirmDecision(null);
        }}
        title={
          confirmDecision?.decision === "approve"
            ? undoSendEnabled
              ? "Confirm Queued Execution (10s Undo)"
              : "Confirm Execution"
            : "Confirm Rejection"
        }
        footer={
          <>
            <button
              type="button"
              disabled={decidingId !== null}
              onClick={() => setConfirmDecision(null)}
              className="ce-btn ce-btn-ghost"
            >
              Cancel
            </button>
            {confirmDecision && (
              <button
                type="button"
                disabled={decidingId !== null || previewLocked}
                onClick={() => void executeConfirmedDecision()}
                className={`ce-btn ${
                  confirmDecision.decision === "approve"
                    ? "ce-btn-primary"
                    : "ce-btn-danger"
                }`}
              >
                {confirmDecision.decision === "approve" ? (
                  <Check className="h-3.5 w-3.5" />
                ) : (
                  <X className="h-3.5 w-3.5" />
                )}
                <span>
                  {decidingId !== null
                    ? "Committing…"
                    : confirmDecision.decision === "approve"
                    ? undoSendEnabled
                      ? "Queue (10s Undo)"
                      : "Execute"
                    : "Reject"}
                </span>
              </button>
            )}
          </>
        }
      >
        {confirmDecision &&
          (() => {
            const { item, decision, useEditedPayload } = confirmDecision;
            const payload =
              decision === "approve" && useEditedPayload
                ? draftsById[item.id] ?? hydrateDraftFromItem(item)
                : parsePayloadObject(item);
            const target = buildConfirmationTarget(item, payload);

            return (
              <div className="space-y-3 text-xs">
                <div className="flex items-start gap-2.5 rounded-xl border border-[var(--line)] bg-[var(--surface-sunken)] p-3">
                  <ShieldAlert
                    className={`mt-0.5 h-4 w-4 shrink-0 ${
                      decision === "approve"
                        ? "text-[var(--amber)]"
                        : "text-[var(--coral)]"
                    }`}
                  />
                  <div className="min-w-0 space-y-0.5">
                    <p className="font-semibold text-[var(--ink)]">
                      {item.title}
                    </p>
                    <p className="font-mono text-[11px] text-[var(--muted)]">
                      {target.headline}
                    </p>
                  </div>
                </div>

                {target.detail && (
                  <p className="rounded-xl border border-[var(--line)] bg-[var(--surface-sunken)]/50 p-3 text-[12px] leading-relaxed text-[var(--ink-secondary)]">
                    {target.detail}
                  </p>
                )}
              </div>
            );
          })()}
      </ModalDialog>
    </div>
  );
}
