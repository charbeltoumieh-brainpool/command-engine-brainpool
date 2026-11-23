import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  CheckCheck,
  Copy,
  ExternalLink,
  FileText,
  Plus,
  Radar,
  Search,
  Send,
  Sparkles,
  X,
} from "lucide-react";
import { api } from "../lib/api";
import {
  formatDateTime,
  formatRelativeTime,
} from "../lib/format";
import { useListKeyboardNav } from "../lib/useListKeyboardNav";
import type {
  BriefingItem,
  BriefingKind,
  EventItem,
  EventWindow,
  TaskItem,
  WorkspaceId,
} from "../types/api";
import { getSourceMeta } from "../components/AppIcons";
import {
  EmptyState,
  ErrorBanner,
  SkeletonRows,
  SourceIcon,
} from "../components/Badges";
import { MarkdownRenderer } from "../components/MarkdownRenderer";
import { useToast } from "../components/ToastContext";
import { WorkspaceHeader } from "../components/WorkspaceHeader";

const TRIAGED_STORAGE_KEY = "ce.changes.triaged";

type WorkbenchTab = "inbox" | "briefings";
type DraftActionType =
  | "slack_send_external"
  | "gmail_send_external"
  | "github_pr_reply"
  | "drive_comment_or_edit";

interface DraftComposerState {
  actionType: DraftActionType;
  channelId: string;
  recipient: string;
  subject: string;
  repo: string;
  prNumber: string;
  driveFileId: string;
  message: string;
}

const WINDOWS: Array<{ id: EventWindow; label: string }> = [
  { id: "since_last_check", label: "New" },
  { id: "24h", label: "24h" },
  { id: "7d", label: "7d" },
  { id: "all", label: "All" },
];

const SOURCE_FILTERS: Array<{ id: string; label: string }> = [
  { id: "all", label: "All" },
  { id: "slack", label: "Slack" },
  { id: "gmail", label: "Gmail" },
  { id: "github", label: "GitHub" },
  { id: "drive", label: "Drive" },
  { id: "local", label: "Local" },
];

const BRIEFING_OPTIONS: Array<{ kind: BriefingKind; label: string }> = [
  { kind: "morning", label: "Morning Brief" },
  { kind: "eod", label: "End of Day" },
  { kind: "whats_new", label: "What's New" },
];

const DRAFT_ACTION_OPTIONS: Array<{
  value: DraftActionType;
  label: string;
  shortLabel: string;
}> = [
  {
    value: "slack_send_external",
    label: "Slack Message",
    shortLabel: "Slack",
  },
  {
    value: "gmail_send_external",
    label: "Email Reply",
    shortLabel: "Email",
  },
  {
    value: "github_pr_reply",
    label: "GitHub PR Reply",
    shortLabel: "PR Reply",
  },
  {
    value: "drive_comment_or_edit",
    label: "Drive Comment",
    shortLabel: "Drive Comment",
  },
];

const OWNED_REASONS = new Set([
  "authored_by_me",
  "assigned_to_me",
  "changes_requested",
  "local_dirty_repo",
  "local_wip",
  "committed_in_call",
  "meeting_action",
  "owner",
]);

function formatBriefingKind(kind: string): string {
  const map: Record<string, string> = {
    whats_new: "What's New",
    morning: "Morning Brief",
    eod: "End of Day",
    needed: "Needed From Me",
    post_call: "Post-Call",
  };
  return map[kind] ?? kind.replace(/_/g, " ");
}

function normalizePriority(priority?: string): string {
  const upper = (priority || "").toUpperCase();
  return ["P0", "P1", "P2", "P3"].includes(upper) ? upper : "P2";
}

function classifyInboxSection(
  ev: EventItem
): "needs_attention" | "mentions_reviews" | "updates" {
  const priority = normalizePriority(ev.priority);
  const reason = (ev.ownership_reason || "").trim().toLowerCase();
  const type = (ev.event_type || "").trim().toLowerCase();
  const isOwned = Boolean(ev.is_mine) || OWNED_REASONS.has(reason);

  if (
    Boolean(ev.requires_action) ||
    ((priority === "P0" || priority === "P1") && isOwned)
  ) {
    return "needs_attention";
  }

  const combined = `${reason} ${type}`;
  if (
    combined.includes("mention") ||
    combined.includes("review") ||
    combined.includes("requested_reviewer") ||
    combined.includes("slack_dm") ||
    combined.includes("direct_dm") ||
    combined.includes("drive_comment")
  ) {
    return "mentions_reviews";
  }

  return "updates";
}

function inferDraftActionType(ev: EventItem): DraftActionType {
  const s = (ev.source || "").toLowerCase();
  if (s.includes("gmail") || s.includes("email")) return "gmail_send_external";
  if (s.includes("github")) return "github_pr_reply";
  if (s.includes("drive")) return "drive_comment_or_edit";
  return "slack_send_external";
}

function extractPrNumber(ev: EventItem): string {
  const urlMatch = /\/pull\/(\d+)/i.exec(ev.url || "");
  if (urlMatch) return urlMatch[1];
  const titleMatch = /#(\d+)/.exec(ev.title || "");
  if (titleMatch) return titleMatch[1];
  if (/^\d+$/.test((ev.source_id || "").trim())) return ev.source_id.trim();
  return "";
}

function extractDriveFileId(ev: EventItem): string {
  const pathMatch = /\/d\/([a-zA-Z0-9_-]{8,})/.exec(ev.url || "");
  if (pathMatch) return pathMatch[1];
  const queryMatch = /[?&]id=([a-zA-Z0-9_-]{8,})/.exec(ev.url || "");
  if (queryMatch) return queryMatch[1];
  return ev.source_id || "";
}

function buildDefaultDraftState(ev: EventItem): DraftComposerState {
  const actionType = inferDraftActionType(ev);
  const contextExcerpt = (ev.summary || ev.body || ev.title || "").trim();
  const shortContext =
    contextExcerpt.length > 180
      ? `${contextExcerpt.slice(0, 180)}…`
      : contextExcerpt;

  const actorGreeting = ev.actor
    ? `Hi ${ev.actor.split(/[\s@<]/)[0]},\n\n`
    : "";
  const prefilledMessage = `${actorGreeting}Following up on "${ev.title}":\n\n> ${shortContext}\n\n`;

  return {
    actionType,
    channelId: ev.channel_or_repo || ev.actor || "",
    recipient: ev.actor || "",
    subject: ev.title ? `Re: ${ev.title}` : "Follow-up",
    repo: ev.channel_or_repo || "repository",
    prNumber: extractPrNumber(ev),
    driveFileId: extractDriveFileId(ev),
    message: prefilledMessage,
  };
}

function loadTriagedIds(): Record<number, boolean> {
  try {
    const raw = localStorage.getItem(TRIAGED_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      const next: Record<number, boolean> = {};
      for (const id of parsed) {
        const num = Number(id);
        if (Number.isFinite(num)) next[num] = true;
      }
      return next;
    }
    if (parsed && typeof parsed === "object") {
      const next: Record<number, boolean> = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        const num = Number(k);
        if (Number.isFinite(num) && Boolean(v)) next[num] = true;
      }
      return next;
    }
  } catch {
    // Ignore malformed localStorage
  }
  return {};
}

function saveTriagedIds(map: Record<number, boolean>): void {
  try {
    const ids = Object.entries(map)
      .filter(([, v]) => v)
      .map(([k]) => Number(k));
    localStorage.setItem(TRIAGED_STORAGE_KEY, JSON.stringify(ids));
  } catch {
    // Ignore storage quota errors
  }
}

function isEditableElement(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return el instanceof HTMLElement && el.isContentEditable;
}

interface ChangesViewProps {
  refreshSignal: number;
  onNavigate: (ws: WorkspaceId) => void;
  onStateMutated: () => void;
}

export function ChangesView({
  refreshSignal,
  onNavigate,
  onStateMutated,
}: ChangesViewProps) {
  const { pushToast } = useToast();
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const rowRefs = useRef<Record<number, HTMLElement | null>>({});

  const [windowFilter, setWindowFilter] =
    useState<EventWindow>("since_last_check");
  const [sourceFilter, setSourceFilter] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [workbenchTab, setWorkbenchTab] = useState<WorkbenchTab>("inbox");

  const [events, setEvents] = useState<EventItem[]>([]);
  const [loadingEvents, setLoadingEvents] = useState(true);
  const [eventsError, setEventsError] = useState<string | null>(null);
  const [markingChecked, setMarkingChecked] = useState(false);

  const [selectedEventId, setSelectedEventId] = useState<number | null>(null);
  const [openedEventId, setOpenedEventId] = useState<number | null>(null);
  const [focusedIdx, setFocusedIdx] = useState<number>(-1);
  const [triagedIds, setTriagedIds] = useState<Record<number, boolean>>(() =>
    loadTriagedIds()
  );

  // Action states
  const [existingTasks, setExistingTasks] = useState<TaskItem[]>([]);
  const [promotingId, setPromotingId] = useState<number | null>(null);
  const [promotedById, setPromotedById] = useState<
    Record<number, { taskTitle: string; taskId?: number }>
  >({});

  const [draftOpen, setDraftOpen] = useState(false);
  const [draftState, setDraftState] = useState<DraftComposerState | null>(null);
  const [stagingDraft, setStagingDraft] = useState(false);
  const [stagedApprovalById, setStagedApprovalById] = useState<
    Record<number, { approvalId?: number; actionType: DraftActionType }>
  >({});

  // Briefings state
  const [briefings, setBriefings] = useState<BriefingItem[]>([]);
  const [selectedBriefingId, setSelectedBriefingId] = useState<number | null>(
    null
  );
  const [loadingBriefings, setLoadingBriefings] = useState(true);
  const [briefingsError, setBriefingsError] = useState<string | null>(null);
  const [generatingKind, setGeneratingKind] = useState<BriefingKind | null>(
    null
  );

  const loadEvents = useCallback(async () => {
    setLoadingEvents(true);
    setEventsError(null);
    try {
      const res = await api.getEvents({
        source: sourceFilter,
        window: windowFilter,
        requires_action_only: false,
        limit: 150,
      });
      setEvents(res.items);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setEventsError(message);
      pushToast("error", "Failed to load inbox", message);
    } finally {
      setLoadingEvents(false);
    }
  }, [sourceFilter, windowFilter, pushToast]);

  const loadBriefings = useCallback(async () => {
    setLoadingBriefings(true);
    setBriefingsError(null);
    try {
      const res = await api.getBriefings();
      setBriefings(res.items);
      setSelectedBriefingId((prev) => {
        if (prev && res.items.some((b) => b.id === prev)) return prev;
        return res.items[0]?.id ?? null;
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setBriefingsError(message);
      pushToast("error", "Failed to load briefings", message);
    } finally {
      setLoadingBriefings(false);
    }
  }, [pushToast]);

  const loadTasks = useCallback(async () => {
    try {
      const res = await api.getTasks({ include_done: true });
      setExistingTasks(res.items ?? []);
    } catch {
      // Best-effort duplicate guard
    }
  }, []);

  useEffect(() => {
    void loadEvents();
  }, [loadEvents, refreshSignal]);

  useEffect(() => {
    void loadTasks();
  }, [loadTasks, refreshSignal]);

  useEffect(() => {
    void loadBriefings();
  }, [loadBriefings, refreshSignal]);

  const isTrackedInWork = useCallback(
    (ev: EventItem): boolean => {
      if (promotedById[ev.id]) return true;

      const evSource = (ev.source || "").trim().toLowerCase();
      const evSourceId = (ev.source_id || "").trim();
      const evUrl = (ev.url || "").trim();
      const evFallbackRef = String(ev.id);
      const cleanTitle =
        (ev.title || "").trim() || `${ev.source} signal #${ev.id}`;

      return existingTasks.some((t) => {
        if ((t.status || "").toLowerCase() === "dismissed") return false;
        const tSource = (t.source || "").trim().toLowerCase();
        if (evSource && tSource && evSource !== tSource) return false;

        const tRef = (t.source_ref || "").trim();
        if (evSourceId && tRef && tRef === evSourceId) return true;
        if (tRef && tRef === evFallbackRef && evSource === tSource) return true;

        const tUrl = (t.source_url || "").trim();
        if (evUrl && tUrl && tUrl === evUrl) return true;

        return (t.title || "").trim() === cleanTitle && evSource === tSource;
      });
    },
    [existingTasks, promotedById]
  );

  const filteredEvents = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return events;
    return events.filter((ev) => {
      const haystack = [
        ev.title,
        ev.summary,
        ev.body,
        ev.actor,
        ev.channel_or_repo,
        ev.source,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [events, searchQuery]);

  const groupedEvents = useMemo(() => {
    const attention: EventItem[] = [];
    const mentions: EventItem[] = [];
    const updates: EventItem[] = [];

    for (const ev of filteredEvents) {
      const section = classifyInboxSection(ev);
      if (section === "needs_attention") attention.push(ev);
      else if (section === "mentions_reviews") mentions.push(ev);
      else updates.push(ev);
    }

    return [
      { key: "needs_attention", label: "Needs Attention", items: attention },
      { key: "mentions_reviews", label: "Mentions & Reviews", items: mentions },
      { key: "updates", label: "Updates", items: updates },
    ].filter((group) => group.items.length > 0);
  }, [filteredEvents]);

  const orderedVisibleEvents = useMemo(
    () => groupedEvents.flatMap((g) => g.items),
    [groupedEvents]
  );

  const flatIndexByEventId = useMemo(() => {
    const map = new Map<number, number>();
    orderedVisibleEvents.forEach((ev, idx) => map.set(ev.id, idx));
    return map;
  }, [orderedVisibleEvents]);

  const openedEvent = useMemo(
    () =>
      openedEventId !== null
        ? events.find((ev) => ev.id === openedEventId) ?? null
        : null,
    [events, openedEventId]
  );

  const activeBriefing = useMemo(
    () =>
      briefings.find((b) => b.id === selectedBriefingId) ?? briefings[0] ?? null,
    [briefings, selectedBriefingId]
  );

  const markTriagedLocal = useCallback((eventId: number) => {
    setTriagedIds((prev) => {
      if (prev[eventId]) return prev;
      const next = { ...prev, [eventId]: true };
      saveTriagedIds(next);
      return next;
    });
  }, []);

  const toggleTriageLocal = useCallback((eventId: number) => {
    setTriagedIds((prev) => {
      const next = { ...prev };
      if (next[eventId]) {
        delete next[eventId];
      } else {
        next[eventId] = true;
      }
      saveTriagedIds(next);
      return next;
    });
  }, []);

  const openEvent = useCallback(
    (eventId: number) => {
      const idx = flatIndexByEventId.get(eventId);
      if (idx !== undefined) setFocusedIdx(idx);
      setSelectedEventId(eventId);
      setOpenedEventId(eventId);
      setWorkbenchTab("inbox");
    },
    [flatIndexByEventId]
  );

  // Keep openedEventId and focusedIdx valid when filter changes
  useEffect(() => {
    if (
      openedEventId !== null &&
      !orderedVisibleEvents.some((ev) => ev.id === openedEventId)
    ) {
      setOpenedEventId(null);
    }
    if (
      selectedEventId !== null &&
      !orderedVisibleEvents.some((ev) => ev.id === selectedEventId)
    ) {
      setSelectedEventId(orderedVisibleEvents[0]?.id ?? null);
    }
    setFocusedIdx((prev) => {
      if (orderedVisibleEvents.length === 0) return -1;
      if (prev < 0) return -1;
      return Math.min(prev, orderedVisibleEvents.length - 1);
    });
  }, [orderedVisibleEvents, openedEventId, selectedEventId]);

  // Sync draft composer when switching opened event
  useEffect(() => {
    setDraftOpen(false);
    if (openedEvent) {
      setDraftState(buildDefaultDraftState(openedEvent));
    } else {
      setDraftState(null);
    }
  }, [openedEvent]);

  // Scroll focused/selected row into view on keyboard nav
  useEffect(() => {
    const focusedEv =
      focusedIdx >= 0 ? orderedVisibleEvents[focusedIdx] : undefined;
    const targetId = focusedEv?.id ?? selectedEventId;
    if (targetId === null || targetId === undefined) return;
    rowRefs.current[targetId]?.scrollIntoView({
      block: "nearest",
      behavior: "smooth",
    });
  }, [focusedIdx, orderedVisibleEvents, selectedEventId]);

  useListKeyboardNav<EventItem>({
    items: orderedVisibleEvents,
    getId: (ev) => ev.id,
    selectedId:
      openedEventId ??
      (focusedIdx >= 0 ? (orderedVisibleEvents[focusedIdx]?.id ?? null) : null),
    onSelect: (id: number) => {
      const idx = flatIndexByEventId.get(id);
      if (idx !== undefined) setFocusedIdx(idx);
      setSelectedEventId(id);
      if (openedEventId !== null) {
        setOpenedEventId(id);
      }
    },
    onEscape: () => {
      if (draftOpen) {
        setDraftOpen(false);
      } else if (openedEventId !== null) {
        setOpenedEventId(null);
      } else if (searchQuery) {
        setSearchQuery("");
      } else {
        setSelectedEventId(null);
        setFocusedIdx(-1);
      }
    },
    searchInputRef,
    enabled: workbenchTab === "inbox",
  });

  const handleMarkAllChecked = useCallback(async () => {
    if (markingChecked) return;
    setMarkingChecked(true);
    try {
      await api.markAllEventsChecked();
      pushToast("success", "Inbox marked read");
      await loadEvents();
      onStateMutated();
    } catch (err) {
      pushToast(
        "error",
        "Failed to mark read",
        err instanceof Error ? err.message : String(err)
      );
    } finally {
      setMarkingChecked(false);
    }
  }, [loadEvents, markingChecked, onStateMutated, pushToast]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (workbenchTab !== "inbox") return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.isComposing) return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      if (isEditableElement(document.activeElement)) return;

      const focusedEvent =
        (focusedIdx >= 0 ? orderedVisibleEvents[focusedIdx] : null) ??
        openedEvent ??
        null;
      const targetId = focusedEvent?.id ?? openedEventId ?? selectedEventId;

      if ((event.key === "m" || event.key === "x") && targetId !== null) {
        event.preventDefault();
        toggleTriageLocal(targetId);
        if (focusedEvent) {
          pushToast(
            "info",
            triagedIds[targetId] ? "Restored to inbox" : "Dismissed from inbox",
            focusedEvent.title
          );
        }
        return;
      }

      if (event.key === "e") {
        event.preventDefault();
        if (focusedEvent && !triagedIds[focusedEvent.id]) {
          markTriagedLocal(focusedEvent.id);
          pushToast("success", "Marked acknowledged", focusedEvent.title);
        } else {
          void handleMarkAllChecked();
        }
        return;
      }

      if (event.key === "Enter" && targetId !== null) {
        const activeEl = document.activeElement;
        const isInteractiveControl =
          activeEl instanceof HTMLElement &&
          (activeEl.tagName === "BUTTON" ||
            activeEl.tagName === "A" ||
            activeEl.getAttribute("role") === "tab" ||
            activeEl.getAttribute("role") === "button") &&
          activeEl.dataset.inboxRow !== "true";
        if (isInteractiveControl) return;

        if (openedEventId === null) {
          event.preventDefault();
          openEvent(targetId);
        } else if (openedEvent?.url) {
          event.preventDefault();
          window.open(openedEvent.url, "_blank", "noopener,noreferrer");
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    focusedIdx,
    handleMarkAllChecked,
    markTriagedLocal,
    openEvent,
    openedEvent,
    openedEventId,
    orderedVisibleEvents,
    pushToast,
    selectedEventId,
    toggleTriageLocal,
    triagedIds,
    workbenchTab,
  ]);

  const handleAddToWork = async (ev: EventItem) => {
    if (promotingId === ev.id || isTrackedInWork(ev)) return;
    setPromotingId(ev.id);
    try {
      const cleanTitle =
        (ev.title || "").trim() || `${ev.source} signal #${ev.id}`;
      const rawDesc = (ev.summary || ev.body || "").trim();
      const cleanDescription =
        rawDesc.length > 800 ? `${rawDesc.slice(0, 800)}…` : rawDesc;

      const taskPayload: Parameters<typeof api.createTask>[0] & {
        source_ref?: string;
        ownership_reason?: string;
      } = {
        title: cleanTitle,
        description: cleanDescription,
        bucket: "needed_from_me",
        priority: normalizePriority(ev.priority),
        source: ev.source,
        source_ref: ev.source_id || String(ev.id),
        source_url: ev.url,
        repo: ev.channel_or_repo,
        counterparty: ev.actor,
        ...(ev.ownership_reason
          ? { ownership_reason: ev.ownership_reason }
          : {}),
      };

      const created = await api.createTask(taskPayload);
      markTriagedLocal(ev.id);
      if (created?.task) {
        setExistingTasks((prev) => [
          created.task,
          ...prev.filter((t) => t.id !== created.task.id),
        ]);
      }
      setPromotedById((prev) => ({
        ...prev,
        [ev.id]: { taskTitle: cleanTitle, taskId: created?.task?.id },
      }));
      pushToast("success", "Added to My Queue", cleanTitle);
      onStateMutated();
    } catch (err) {
      pushToast(
        "error",
        "Failed to add to Work",
        err instanceof Error ? err.message : String(err)
      );
    } finally {
      setPromotingId(null);
    }
  };

  const handleStageSafeDraft = async (ev: EventItem) => {
    if (!draftState || stagingDraft) return;

    const actionType = draftState.actionType;
    const trimmedMessage = draftState.message.trim();
    if (!trimmedMessage) {
      pushToast("error", "Draft body required", "Enter a message before staging.");
      return;
    }

    let payload: Record<string, unknown> = {};
    if (actionType === "slack_send_external") {
      if (!draftState.channelId.trim()) {
        pushToast(
          "error",
          "Channel or User ID required",
          "Specify a Slack channel or recipient ID."
        );
        return;
      }
      payload = {
        channel_id: draftState.channelId.trim(),
        message: trimmedMessage,
        source_event_id: ev.id,
        source_url: ev.url || "",
      };
    } else if (actionType === "gmail_send_external") {
      if (!draftState.recipient.trim()) {
        pushToast(
          "error",
          "Recipient required",
          "Specify a recipient address or name."
        );
        return;
      }
      payload = {
        to: draftState.recipient.trim(),
        subject: draftState.subject.trim() || `Re: ${ev.title}`,
        body: trimmedMessage,
        mode: "send_message",
        source_event_id: ev.id,
      };
    } else if (actionType === "github_pr_reply") {
      const prNum = Number.parseInt(draftState.prNumber.trim(), 10);
      if (!Number.isFinite(prNum) || prNum <= 0) {
        pushToast(
          "error",
          "Valid PR number required",
          "Enter a positive integer PR number."
        );
        return;
      }
      payload = {
        repo: draftState.repo.trim() || ev.channel_or_repo || "",
        pr_number: prNum,
        top_level_body: trimmedMessage,
        source_event_id: ev.id,
      };
    } else if (actionType === "drive_comment_or_edit") {
      if (!draftState.driveFileId.trim()) {
        pushToast(
          "error",
          "Drive File ID required",
          "Enter the Google Drive file ID."
        );
        return;
      }
      payload = {
        fileId: draftState.driveFileId.trim(),
        comment: trimmedMessage,
        source_event_id: ev.id,
      };
    }

    setStagingDraft(true);
    try {
      const res = await api.stageApproval({
        action_type: actionType,
        title: `Draft ${
          DRAFT_ACTION_OPTIONS.find((o) => o.value === actionType)?.shortLabel ??
          actionType
        }: ${ev.title || `Signal #${ev.id}`}`,
        summary: `Staged from Changes (${getSourceMeta(ev.source).label}${
          ev.actor ? ` · ${ev.actor}` : ""
        }).`,
        repo:
          actionType === "github_pr_reply"
            ? draftState.repo.trim() || ev.channel_or_repo || ""
            : ev.channel_or_repo || "",
        ownership_reason: ev.ownership_reason || "authored_by_me",
        payload,
      });

      setStagedApprovalById((prev) => ({
        ...prev,
        [ev.id]: {
          approvalId: res.approval_id,
          actionType,
        },
      }));
      markTriagedLocal(ev.id);
      setDraftOpen(false);
      pushToast(
        "success",
        "Draft staged in Approvals",
        res.approval_id
          ? `Approval #${res.approval_id} awaiting sign-off.`
          : "Awaiting sign-off."
      );
      onStateMutated();
    } catch (err) {
      pushToast(
        "error",
        "Failed to stage draft",
        err instanceof Error ? err.message : String(err)
      );
    } finally {
      setStagingDraft(false);
    }
  };

  const handleGenerateBriefing = async (kind: BriefingKind) => {
    if (generatingKind !== null) return;
    setGeneratingKind(kind);
    try {
      const created = await api.generateBriefing({
        kind,
        deliver_self_dm: false,
        since_last_check_only: windowFilter === "since_last_check",
      });
      setBriefings((prev) => [
        created,
        ...prev.filter((b) => b.id !== created.id),
      ]);
      setSelectedBriefingId(created.id);
      pushToast("success", `${formatBriefingKind(kind)} ready`, created.title);
      onStateMutated();
    } catch (err) {
      pushToast(
        "error",
        "Briefing synthesis failed",
        err instanceof Error ? err.message : String(err)
      );
    } finally {
      setGeneratingKind(null);
    }
  };

  const handleCopyBriefing = async (brief: BriefingItem) => {
    const md = `# ${brief.title}\n\n${brief.content_md}`;
    try {
      await navigator.clipboard.writeText(md);
      pushToast("success", "Copied briefing Markdown");
    } catch {
      pushToast("error", "Clipboard access unavailable");
    }
  };

  const hasActiveFilters =
    windowFilter !== "all" ||
    sourceFilter !== "all" ||
    Boolean(searchQuery.trim());

  const resetFilters = () => {
    setWindowFilter("all");
    setSourceFilter("all");
    setSearchQuery("");
  };

  return (
    <div className="mx-auto w-full max-w-[1140px] space-y-4 px-6 pt-2 pb-8">
      <WorkspaceHeader
        title="Changes"
        tabs={[
          {
            id: "inbox",
            label: "Inbox",
            count: events.length,
          },
          {
            id: "briefings",
            label: "Briefings",
            count: briefings.length,
          },
        ]}
        activeTab={workbenchTab}
        onTabChange={(id) => setWorkbenchTab(id as WorkbenchTab)}
        actions={
          workbenchTab === "inbox" ? (
            <div className="flex flex-wrap items-center gap-2">
              <div
                className="inline-flex rounded-full border border-[var(--line-strong)] bg-[var(--surface-sunken)] p-0.5"
                role="group"
                aria-label="Time window"
              >
                {WINDOWS.map((w) => (
                  <button
                    key={w.id}
                    type="button"
                    onClick={() => setWindowFilter(w.id)}
                    className={`cursor-pointer rounded-full px-2.5 py-1 text-xs font-medium whitespace-nowrap transition-colors ${
                      windowFilter === w.id
                        ? "bg-[var(--surface)] text-[var(--ink)] shadow-sm"
                        : "text-[var(--muted)] hover:text-[var(--ink)]"
                    }`}
                  >
                    {w.label}
                  </button>
                ))}
              </div>

              <button
                type="button"
                disabled={markingChecked}
                onClick={() => void handleMarkAllChecked()}
                className="ce-btn h-8 px-3 text-xs"
              >
                <CheckCheck className="h-3.5 w-3.5" />
                <span>{markingChecked ? "Updating…" : "Mark All Read"}</span>
              </button>
            </div>
          ) : undefined
        }
      />

      {workbenchTab === "inbox" ? (
        <div className="min-w-0 space-y-4">
          {eventsError && (
            <ErrorBanner
              title="Inbox unavailable"
              message={eventsError}
              onRetry={() => void loadEvents()}
            />
          )}

          {/* Single Slim Source Bar */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div
              className="flex flex-wrap items-center gap-1"
              role="group"
              aria-label="Filter by source"
            >
              {SOURCE_FILTERS.map((src) => {
                const active = sourceFilter === src.id;
                return (
                  <button
                    key={src.id}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setSourceFilter(src.id)}
                    className={`inline-flex cursor-pointer items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                      active
                        ? "bg-[var(--surface-raised)] text-[var(--ink)] ring-1 ring-[var(--line-strong)]"
                        : "text-[var(--muted)] hover:bg-[var(--surface-raised)]/45 hover:text-[var(--ink)]"
                    }`}
                  >
                    {src.id !== "all" && (
                      <SourceIcon
                        source={src.id}
                        className="h-3.5 w-3.5 shrink-0"
                      />
                    )}
                    <span>{src.label}</span>
                  </button>
                );
              })}
            </div>

            <div className="relative w-48 sm:w-56">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-[var(--muted)]" />
              <input
                ref={searchInputRef}
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Filter inbox…"
                aria-label="Filter inbox"
                className="ce-input h-8 pr-7 pl-8 text-xs"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery("")}
                  aria-label="Clear filter"
                  className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-0.5 text-[var(--muted)] hover:text-[var(--ink)]"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
          </div>

          {loadingEvents ? (
            <div className="ce-card px-4 py-2">
              <SkeletonRows rows={6} />
            </div>
          ) : orderedVisibleEvents.length === 0 ? (
            <div className="ce-card p-6">
              <EmptyState
                icon={Radar}
                title="Inbox clear"
                description="No signals match the current window or filter."
                action={
                  hasActiveFilters ? (
                    <button
                      type="button"
                      onClick={resetFilters}
                      className="ce-btn h-8 px-3 text-xs"
                    >
                      Reset filters
                    </button>
                  ) : undefined
                }
              />
            </div>
          ) : (
            <>
            <div
              className={
                openedEvent
                  ? "grid grid-cols-1 items-start gap-5 lg:grid-cols-12"
                  : "min-w-0"
              }
            >
              {/* Superhuman-Clean Inbox List */}
              <div
                className={`ce-card min-w-0 divide-y divide-[var(--line)] overflow-hidden ${
                  openedEvent ? "lg:col-span-6 lg:max-h-[75vh] lg:overflow-y-auto" : ""
                }`}
              >
                {groupedEvents.map((group) => (
                  <section key={group.key} aria-label={group.label}>
                    <div className="border-b border-[var(--line)] bg-[var(--surface-sunken)]/35 px-4 py-2 text-[11px] font-medium text-[var(--muted)]">
                      {group.label}
                    </div>
                    <div className="divide-y divide-[var(--line)]">
                      {group.items.map((ev) => {
                        const idx = flatIndexByEventId.get(ev.id) ?? -1;
                        const isKbdFocused = idx !== -1 && idx === focusedIdx;
                        const priority = normalizePriority(ev.priority);
                        const isHighPriority =
                          priority === "P0" || priority === "P1";
                        const isSelected =
                          (openedEventId ?? selectedEventId) === ev.id;
                        const isTriaged = Boolean(triagedIds[ev.id]);
                        const tracked = isTrackedInWork(ev);
                        const snippet = ev.summary || ev.actor || "";

                        return (
                          <div
                            key={ev.id}
                            ref={(el) => {
                              rowRefs.current[ev.id] = el;
                            }}
                            data-inbox-row="true"
                            data-kbd-focused={isKbdFocused ? "true" : undefined}
                            tabIndex={0}
                            role="button"
                            aria-pressed={isSelected}
                            onClick={() => openEvent(ev.id)}
                            onKeyDown={(e) => {
                              if (e.key === " ") {
                                e.preventDefault();
                                openEvent(ev.id);
                              }
                            }}
                            style={
                              isKbdFocused
                                ? {
                                    boxShadow:
                                      "inset 2px 0 0 var(--accent-primary, var(--accent))",
                                    background:
                                      "var(--bg-hover, var(--surface-raised))",
                                  }
                                : undefined
                            }
                            className={`group flex cursor-pointer items-center gap-3 px-4 py-3 transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--accent)] ${
                              isSelected
                                ? "bg-[var(--surface-raised)]"
                                : "hover:bg-[var(--surface-raised)]/55"
                            } ${isTriaged ? "opacity-55" : ""}`}
                          >
                            {/* Left: Source Icon + Tiny P0/P1 Dot */}
                            <div className="relative flex shrink-0 items-center gap-1.5">
                              <SourceIcon
                                source={ev.source}
                                className="h-[15px] w-[15px]"
                              />
                              {isHighPriority && (
                                <span
                                  title={priority}
                                  className={`h-1.5 w-1.5 rounded-full ${
                                    priority === "P0"
                                      ? "bg-[var(--coral)]"
                                      : "bg-[var(--amber)]"
                                  }`}
                                />
                              )}
                            </div>

                            {/* Middle: Clean Title + 1-line Snippet */}
                            <div className="min-w-0 flex-1">
                              <div
                                className={`truncate text-[13.5px] font-medium text-[var(--ink)] ${
                                  isTriaged
                                    ? "line-through decoration-[var(--subtle)]"
                                    : ""
                                }`}
                              >
                                {ev.title}
                              </div>
                              {snippet && (
                                <div className="truncate text-[12px] text-[var(--muted)]">
                                  {snippet}
                                </div>
                              )}
                            </div>

                            {/* Right: Quiet Time + Hover Quick Actions */}
                            <div className="flex shrink-0 items-center gap-2">
                              <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                                <button
                                  type="button"
                                  disabled={tracked || promotingId === ev.id}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    void handleAddToWork(ev);
                                  }}
                                  title={
                                    tracked
                                      ? "Already in Work"
                                      : "Add to My Queue"
                                  }
                                  className={`inline-flex h-6 items-center gap-1 rounded-md px-2 text-[11px] font-medium transition-colors ${
                                    tracked
                                      ? "text-[var(--sage)]"
                                      : "text-[var(--muted)] hover:bg-[var(--surface)] hover:text-[var(--ink)]"
                                  }`}
                                >
                                  {tracked ? (
                                    <Check className="h-3 w-3" />
                                  ) : (
                                    <Plus className="h-3 w-3" />
                                  )}
                                  <span>{tracked ? "Work" : "Work"}</span>
                                </button>

                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    toggleTriageLocal(ev.id);
                                  }}
                                  title={
                                    isTriaged ? "Restore" : "Dismiss / mark read"
                                  }
                                  aria-label={
                                    isTriaged ? "Restore" : "Dismiss"
                                  }
                                  className={`inline-flex h-6 w-6 items-center justify-center rounded-md transition-colors ${
                                    isTriaged
                                      ? "text-[var(--sage)]"
                                      : "text-[var(--muted)] hover:bg-[var(--surface)] hover:text-[var(--ink)]"
                                  }`}
                                >
                                  <Check className="h-3.5 w-3.5" />
                                </button>
                              </div>

                              <span className="font-mono text-[11px] tabular-nums text-[var(--muted)]">
                                {formatRelativeTime(ev.occurred_at)}
                              </span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </section>
                ))}
              </div>

              {/* Clean Detail Pane */}
              {openedEvent && (
                <section className="ce-card min-w-0 space-y-4 p-5 lg:sticky lg:top-4 lg:col-span-6">
                  {/* Top Bar */}
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2 text-xs text-[var(--muted)]">
                      <SourceIcon
                        source={openedEvent.source}
                        className="h-4 w-4 shrink-0"
                      />
                      <span className="font-medium text-[var(--ink-secondary)]">
                        {getSourceMeta(openedEvent.source).label}
                      </span>
                      <span className="text-[var(--line-strong)]">·</span>
                      <span className="font-mono text-[11px] tabular-nums">
                        {formatRelativeTime(openedEvent.occurred_at)}
                      </span>
                    </div>

                    <button
                      type="button"
                      onClick={() => setOpenedEventId(null)}
                      aria-label="Close detail"
                      className="ce-btn ce-btn-ghost h-7 w-7 p-0"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>

                  {/* Title & Quiet Context */}
                  <div className="space-y-1">
                    <h2 className="text-[16px] font-semibold leading-snug text-[var(--ink)] break-words">
                      {openedEvent.title}
                    </h2>
                    {(openedEvent.actor || openedEvent.channel_or_repo) && (
                      <p className="truncate text-xs text-[var(--muted)]">
                        {[openedEvent.actor, openedEvent.channel_or_repo]
                          .filter(Boolean)
                          .join(" · ")}
                      </p>
                    )}
                  </div>

                  {/* Clean Readable Body */}
                  <div className="max-h-[42vh] overflow-y-auto border-y border-[var(--line)] py-4 text-[13px] leading-relaxed text-[var(--ink-secondary)]">
                    {openedEvent.summary && (
                      <MarkdownRenderer content={openedEvent.summary} />
                    )}
                    {openedEvent.body &&
                    openedEvent.body.trim() !== openedEvent.summary?.trim() ? (
                      <div className={openedEvent.summary ? "mt-3" : ""}>
                        <MarkdownRenderer content={openedEvent.body} />
                      </div>
                    ) : !openedEvent.summary ? (
                      <p className="text-xs text-[var(--muted)]">
                        No message body provided.
                      </p>
                    ) : null}
                  </div>

                  {/* Clean 1-Row Action Bar */}
                  <div className="flex flex-wrap items-center gap-2">
                    {(() => {
                      const tracked = isTrackedInWork(openedEvent);
                      const busy = promotingId === openedEvent.id;
                      return (
                        <button
                          type="button"
                          disabled={tracked || busy}
                          onClick={() => void handleAddToWork(openedEvent)}
                          className={
                            tracked
                              ? "ce-btn ce-btn-sage h-8 px-3 text-xs"
                              : "ce-btn ce-btn-primary h-8 px-3 text-xs"
                          }
                        >
                          {tracked ? (
                            <Check className="h-3.5 w-3.5" />
                          ) : (
                            <Plus className="h-3.5 w-3.5" />
                          )}
                          <span>
                            {busy
                              ? "Adding…"
                              : tracked
                                ? "Added to Work"
                                : "Add to My Queue"}
                          </span>
                        </button>
                      );
                    })()}

                    <button
                      type="button"
                      aria-expanded={draftOpen}
                      onClick={() => setDraftOpen((v) => !v)}
                      className={`ce-btn h-8 px-3 text-xs ${
                        draftOpen ? "ce-btn-accent" : ""
                      }`}
                    >
                      <Send className="h-3.5 w-3.5" />
                      <span>Draft Reply</span>
                    </button>

                    {openedEvent.url && (
                      <a
                        href={openedEvent.url}
                        target="_blank"
                        rel="noreferrer"
                        className="ce-btn ce-btn-ghost ml-auto h-8 px-2.5 text-xs"
                      >
                        <span>Open Original</span>
                        <ExternalLink className="h-3.5 w-3.5" />
                      </a>
                    )}
                  </div>

                  {/* Staged Approval Confirmation */}
                  {stagedApprovalById[openedEvent.id] && !draftOpen && (
                    <div className="flex items-center justify-between gap-2 rounded-lg border border-[var(--sage-border)] bg-[var(--sage-soft)]/35 px-3 py-2 text-xs text-[var(--sage)]">
                      <span>
                        Draft staged
                        {stagedApprovalById[openedEvent.id].approvalId
                          ? ` (#${stagedApprovalById[openedEvent.id].approvalId})`
                          : ""}{" "}
                        in Approvals.
                      </span>
                      <button
                        type="button"
                        onClick={() => onNavigate("Approvals")}
                        className="font-medium underline-offset-2 hover:underline"
                      >
                        Review
                      </button>
                    </div>
                  )}

                  {/* Clean Inline Draft Composer */}
                  {draftOpen && draftState && (
                    <div className="space-y-3 rounded-xl border border-[var(--line)] bg-[var(--surface-sunken)]/50 p-3.5">
                      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                        <select
                          aria-label="Reply channel"
                          value={draftState.actionType}
                          onChange={(e) =>
                            setDraftState((prev) =>
                              prev
                                ? {
                                    ...prev,
                                    actionType: e.target.value as DraftActionType,
                                  }
                                : prev
                            )
                          }
                          className="ce-input h-8 text-xs"
                        >
                          {DRAFT_ACTION_OPTIONS.map((opt) => (
                            <option key={opt.value} value={opt.value}>
                              {opt.label}
                            </option>
                          ))}
                        </select>

                        {draftState.actionType === "slack_send_external" && (
                          <input
                            type="text"
                            value={draftState.channelId}
                            onChange={(e) =>
                              setDraftState((prev) =>
                                prev
                                  ? { ...prev, channelId: e.target.value }
                                  : prev
                              )
                            }
                            placeholder="Slack channel or user ID"
                            className="ce-input h-8 font-mono text-xs"
                          />
                        )}

                        {draftState.actionType === "gmail_send_external" && (
                          <input
                            type="text"
                            value={draftState.recipient}
                            onChange={(e) =>
                              setDraftState((prev) =>
                                prev
                                  ? { ...prev, recipient: e.target.value }
                                  : prev
                              )
                            }
                            placeholder="Recipient email"
                            className="ce-input h-8 font-mono text-xs"
                          />
                        )}

                        {draftState.actionType === "github_pr_reply" && (
                          <div className="flex gap-2">
                            <input
                              type="text"
                              value={draftState.repo}
                              onChange={(e) =>
                                setDraftState((prev) =>
                                  prev ? { ...prev, repo: e.target.value } : prev
                                )
                              }
                              placeholder="owner/repo"
                              className="ce-input h-8 flex-1 font-mono text-xs"
                            />
                            <input
                              type="text"
                              inputMode="numeric"
                              value={draftState.prNumber}
                              onChange={(e) =>
                                setDraftState((prev) =>
                                  prev
                                    ? { ...prev, prNumber: e.target.value }
                                    : prev
                                )
                              }
                              placeholder="PR #"
                              className="ce-input h-8 w-20 font-mono text-xs"
                            />
                          </div>
                        )}

                        {draftState.actionType === "drive_comment_or_edit" && (
                          <input
                            type="text"
                            value={draftState.driveFileId}
                            onChange={(e) =>
                              setDraftState((prev) =>
                                prev
                                  ? { ...prev, driveFileId: e.target.value }
                                  : prev
                              )
                            }
                            placeholder="Google Drive File ID"
                            className="ce-input h-8 font-mono text-xs"
                          />
                        )}
                      </div>

                      {draftState.actionType === "gmail_send_external" && (
                        <input
                          type="text"
                          value={draftState.subject}
                          onChange={(e) =>
                            setDraftState((prev) =>
                              prev ? { ...prev, subject: e.target.value } : prev
                            )
                          }
                          placeholder="Subject"
                          className="ce-input h-8 text-xs"
                        />
                      )}

                      <textarea
                        rows={4}
                        value={draftState.message}
                        onChange={(e) =>
                          setDraftState((prev) =>
                            prev ? { ...prev, message: e.target.value } : prev
                          )
                        }
                        className="ce-input min-h-[88px] resize-y text-xs leading-relaxed"
                      />

                      <div className="flex items-center justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => setDraftOpen(false)}
                          className="ce-btn ce-btn-ghost h-7 px-2.5 text-xs"
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          disabled={stagingDraft}
                          onClick={() => void handleStageSafeDraft(openedEvent)}
                          className="ce-btn ce-btn-primary h-8 px-3.5 text-xs"
                        >
                          <Send className="h-3 w-3" />
                          <span>
                            {stagingDraft ? "Staging…" : "Stage in Approvals"}
                          </span>
                        </button>
                      </div>
                    </div>
                  )}
                </section>
              )}
            </div>
            <div className="flex items-center justify-end px-1 pt-1 text-[11px] text-[var(--muted)]">
              <span className="font-mono">J/K navigate · ? shortcuts</span>
            </div>
            </>
          )}
        </div>
      ) : (
        /* Clean Briefings Tab */
        <div className="ce-card min-w-0 space-y-5 p-6">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--line)] pb-4">
            <div className="flex flex-wrap items-center gap-2">
              {BRIEFING_OPTIONS.map((opt) => {
                const busy = generatingKind === opt.kind;
                return (
                  <button
                    key={opt.kind}
                    type="button"
                    disabled={generatingKind !== null}
                    onClick={() => void handleGenerateBriefing(opt.kind)}
                    className="ce-btn h-8 px-3 text-xs"
                  >
                    <Sparkles className="h-3.5 w-3.5 text-[var(--accent)]" />
                    <span>{busy ? "Synthesizing…" : opt.label}</span>
                  </button>
                );
              })}
            </div>

            {briefings.length > 0 && (
              <div className="flex items-center gap-2">
                {briefings.length > 1 && (
                  <select
                    aria-label="Select briefing"
                    value={activeBriefing?.id ?? ""}
                    onChange={(e) =>
                      setSelectedBriefingId(Number(e.target.value))
                    }
                    className="ce-input h-8 w-auto max-w-[260px] py-0 text-xs"
                  >
                    {briefings.map((b) => (
                      <option key={b.id} value={b.id}>
                        {formatBriefingKind(b.kind)} ·{" "}
                        {formatDateTime(b.created_at)}
                      </option>
                    ))}
                  </select>
                )}

                {activeBriefing && (
                  <button
                    type="button"
                    onClick={() => void handleCopyBriefing(activeBriefing)}
                    className="ce-btn ce-btn-ghost h-8 px-2.5 text-xs"
                  >
                    <Copy className="h-3.5 w-3.5" />
                    <span>Copy</span>
                  </button>
                )}
              </div>
            )}
          </div>

          {briefingsError && (
            <ErrorBanner
              title="Briefings unavailable"
              message={briefingsError}
              onRetry={() => void loadBriefings()}
            />
          )}

          {loadingBriefings ? (
            <SkeletonRows rows={5} />
          ) : !activeBriefing ? (
            <EmptyState
              icon={FileText}
              title="No briefings yet"
              description="Generate a Morning Brief, End of Day wrap-up, or What's New synthesis."
              action={
                <button
                  type="button"
                  disabled={generatingKind !== null}
                  onClick={() => void handleGenerateBriefing("whats_new")}
                  className="ce-btn ce-btn-primary"
                >
                  <Sparkles className="h-3.5 w-3.5" />
                  <span>Generate What&apos;s New</span>
                </button>
              }
            />
          ) : (
            <article className="mx-auto max-w-3xl space-y-4">
              <header className="space-y-1">
                <div className="flex items-center gap-2 text-xs text-[var(--muted)]">
                  <span>{formatBriefingKind(activeBriefing.kind)}</span>
                  {activeBriefing.created_at && (
                    <>
                      <span>·</span>
                      <span className="font-mono text-[11px] tabular-nums">
                        {formatDateTime(activeBriefing.created_at)}
                      </span>
                    </>
                  )}
                </div>
                <h2 className="font-editorial text-2xl font-normal text-[var(--ink)]">
                  {activeBriefing.title}
                </h2>
              </header>

              <div className="ce-prose-measure min-w-0 text-[13.5px] leading-relaxed text-[var(--ink-secondary)]">
                <MarkdownRenderer content={activeBriefing.content_md} />
              </div>
            </article>
          )}
        </div>
      )}
    </div>
  );
}
