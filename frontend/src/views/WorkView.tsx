import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArchiveRestore,
  ArrowRightLeft,
  Check,
  ChevronDown,
  Clock,
  ExternalLink,
  EyeOff,
  ListChecks,
  MessageSquarePlus,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  Save,
  Search,
  Send,
  ShieldCheck,
  Users,
  X,
} from "lucide-react";
import { api } from "../lib/api";
import { formatDateTime, formatRelativeTime } from "../lib/format";
import { useListKeyboardNav } from "../lib/useListKeyboardNav";
import type {
  Priority,
  TaskBucket,
  TaskItem,
  TaskStatus,
  UserProfile,
  WorkspaceId,
} from "../types/api";
import {
  EmptyState,
  ErrorBanner,
  PriorityBadge,
  SkeletonRows,
  StatusBadge,
} from "../components/Badges";
import { DrawerPanel, ModalDialog } from "../components/Overlays";
import { useToast } from "../components/ToastContext";
import { WorkspaceHeader } from "../components/WorkspaceHeader";

type WorkTab = "queue" | "waiting" | "board" | "done";
type PriorityFilter = "All" | "P0" | "P1" | "P2";
type SnoozePreset = "3h" | "tomorrow" | "next_week" | "clear";
type SafeDraftActionType =
  | "slack_send_external"
  | "gmail_send_external"
  | "github_pr_reply";

const PRIORITY_RANK: Record<string, number> = {
  P0: 0,
  P1: 1,
  P2: 2,
  P3: 3,
};

function isRawIdentifier(value?: string | null): boolean {
  if (!value) return false;
  const v = value.trim();
  if (!v) return false;
  if (/^[CDUG][A-Z0-9]{7,}(?::[0-9.]+)?$/i.test(v)) return true;
  if (/^[A-Z0-9]{8,}:\d{6,}/i.test(v)) return true;
  if (/^\d{9,}\.\d+$/.test(v)) return true;
  return false;
}

function formatShortRepo(repo?: string | null): string {
  if (!repo) return "";
  const trimmed = repo.trim();
  if (!trimmed || isRawIdentifier(trimmed)) return "";
  if (trimmed.includes("/")) {
    return trimmed.split("/").pop() || trimmed;
  }
  return trimmed;
}

function formatFirstName(counterparty?: string | null): string {
  if (!counterparty) return "";
  let cleaned = counterparty.trim().replace(/^@/, "");
  if (!cleaned || isRawIdentifier(cleaned)) return "";
  if (cleaned.includes("<")) {
    cleaned = cleaned.split("<")[0].trim();
  }
  if (cleaned.includes("@")) {
    const local = cleaned.split("@")[0];
    const part = local.split(/[._-]/)[0] || local;
    return part.charAt(0).toUpperCase() + part.slice(1);
  }
  const firstWord = cleaned.split(/\s+/)[0] || cleaned;
  if (isRawIdentifier(firstWord)) return "";
  return firstWord;
}

function formatCompactSource(source?: string | null): string {
  const s = (source || "").trim().toLowerCase();
  if (!s || s === "manual") return "Manual";
  if (s.includes("slack")) return "Slack";
  if (s.includes("gmail") || s.includes("email")) return "Gmail";
  if (s.includes("github")) return "GitHub";
  if (s.includes("meet") || s.includes("transcript")) return "Meet";
  if (s.includes("drive")) return "Drive";
  if (s.includes("calendar")) return "Calendar";
  if (s.includes("local")) return "Local";
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function formatCompactAge(iso?: string | null): string {
  if (!iso || iso.startsWith("1970-01-01")) return "";
  const rel = formatRelativeTime(iso);
  if (rel === "Never") return "";
  if (rel === "just now") return "now";
  return rel.replace(" ago", "");
}

function formatContextLabel(task: TaskItem): string {
  const repo = formatShortRepo(task.repo);
  if (repo) return repo;
  const person = formatFirstName(task.counterparty);
  if (person) return person;
  if (task.source && task.source.toLowerCase() !== "manual") {
    return formatCompactSource(task.source);
  }
  return "";
}

function extractPrNumberFromTask(task: TaskItem): string {
  const combined = `${task.source_ref || ""} ${task.source_url || ""} ${task.title || ""}`;
  const pullMatch =
    combined.match(/\/pull\/(\d+)/i) || combined.match(/#(\d{1,6})\b/);
  return pullMatch ? pullMatch[1] : "";
}

export interface WorkViewProps {
  refreshSignal: number;
  onNavigate: (ws: WorkspaceId) => void;
  onStateMutated: () => void;
  initialTaskId?: number | null;
  onClearInitialTask?: () => void;
  onJumpToApproval?: (approvalId: number) => void;
  onPrepareWorktree?: (repoKey: string, branch: string) => void;
}

export function WorkView({
  refreshSignal,
  onNavigate,
  onStateMutated,
  initialTaskId = null,
  onClearInitialTask,
  onJumpToApproval,
}: WorkViewProps) {
  const { pushToast } = useToast();

  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [activeProfile, setActiveProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);

  const [activeTab, setActiveTab] = useState<WorkTab>("queue");
  const [priorityFilter, setPriorityFilter] = useState<PriorityFilter>("All");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedTaskId, setSelectedTaskId] = useState<number | null>(
    initialTaskId ?? null
  );
  const [focusedIdx, setFocusedIdx] = useState<number>(-1);
  const [boardDrawerOpen, setBoardDrawerOpen] = useState(false);

  const [busyTaskId, setBusyTaskId] = useState<number | null>(null);

  // Inline quick-add row at top of list
  const [quickTitle, setQuickTitle] = useState("");
  const [quickCreating, setQuickCreating] = useState(false);

  // Detail card edit mode & unsaved draft preservation
  const [editingTaskId, setEditingTaskId] = useState<number | null>(null);
  const [titleDraft, setTitleDraft] = useState("");
  const [descDraft, setDescDraft] = useState("");
  const [unsavedDrafts, setUnsavedDrafts] = useState<
    Record<number, { title: string; description: string }>
  >({});
  const [savingEdits, setSavingEdits] = useState(false);

  // Snooze popover menu
  const [snoozeMenuOpen, setSnoozeMenuOpen] = useState(false);
  const snoozeMenuRef = useRef<HTMLDivElement | null>(null);

  // Inline follow-up nudge composer for Waiting
  const [nudgeTaskId, setNudgeTaskId] = useState<number | null>(null);
  const [nudgeChannel, setNudgeChannel] =
    useState<SafeDraftActionType>("slack_send_external");
  const [nudgeTarget, setNudgeTarget] = useState("");
  const [nudgeSubject, setNudgeSubject] = useState("");
  const [nudgeRepo, setNudgeRepo] = useState("");
  const [nudgePrNumber, setNudgePrNumber] = useState("");
  const [nudgeBody, setNudgeBody] = useState("");
  const [stagingNudge, setStagingNudge] = useState(false);

  // Safe Outbound Draft modal
  const [draftModalTask, setDraftModalTask] = useState<TaskItem | null>(null);
  const [draftActionType, setDraftActionType] =
    useState<SafeDraftActionType>("slack_send_external");
  const [draftTarget, setDraftTarget] = useState("");
  const [draftSubject, setDraftSubject] = useState("");
  const [draftRepo, setDraftRepo] = useState("");
  const [draftPrNumber, setDraftPrNumber] = useState("");
  const [draftBody, setDraftBody] = useState("");
  const [stagingDraft, setStagingDraft] = useState(false);
  const [stagedApprovalByTaskId, setStagedApprovalByTaskId] = useState<
    Record<number, number>
  >({});

  // New Task modal
  const [newModalOpen, setNewModalOpen] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [newBucket, setNewBucket] = useState<TaskBucket>("needed_from_me");
  const [newPriority, setNewPriority] = useState<Priority>("P1");
  const [newRepo, setNewRepo] = useState("");
  const [newCounterparty, setNewCounterparty] = useState("");
  const [newSourceUrl, setNewSourceUrl] = useState("");
  const [creating, setCreating] = useState(false);

  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const quickInputRef = useRef<HTMLInputElement | null>(null);
  const detailRef = useRef<HTMLDivElement | null>(null);
  const rowRefs = useRef<Record<number, HTMLElement | null>>({});

  const loadTasks = useCallback(async () => {
    setLoading(true);
    setFetchError(null);
    try {
      const res = await api.getTasks({ include_done: true });
      setTasks(res.items);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setFetchError(msg);
      pushToast("error", "Failed to load work obligations", msg);
    } finally {
      setLoading(false);
    }
  }, [pushToast]);

  useEffect(() => {
    void loadTasks();
  }, [loadTasks, refreshSignal]);

  useEffect(() => {
    let cancelled = false;
    api
      .getProfiles()
      .then((res) => {
        if (!cancelled && res?.active) {
          setActiveProfile(res.active);
        }
      })
      .catch(() => {
        // Ignore profile lookup errors gracefully
      });
    return () => {
      cancelled = true;
    };
  }, [refreshSignal]);

  // Close snooze dropdown on outside click
  useEffect(() => {
    if (!snoozeMenuOpen) return;
    const handlePointerDown = (e: MouseEvent) => {
      if (
        snoozeMenuRef.current &&
        !snoozeMenuRef.current.contains(e.target as Node)
      ) {
        setSnoozeMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [snoozeMenuOpen]);

  const repoSuggestions = useMemo(() => {
    const seen = new Set<string>();
    const add = (val?: string | null) => {
      const trimmed = (val || "").trim();
      if (trimmed && !isRawIdentifier(trimmed) && !seen.has(trimmed)) {
        seen.add(trimmed);
      }
    };
    if (activeProfile?.core_repos) {
      for (const [key, cfg] of Object.entries(activeProfile.core_repos)) {
        add(cfg?.full_name);
        add(key);
      }
    }
    for (const t of tasks) {
      add(t.repo);
    }
    return Array.from(seen);
  }, [activeProfile, tasks]);

  // Deep-link initialTaskId support
  useEffect(() => {
    if (!initialTaskId || tasks.length === 0) return;
    const match = tasks.find((t) => t.id === initialTaskId);
    if (!match) return;
    const st = (match.status || "todo").toLowerCase();
    if (st === "done" || st === "completed" || st === "dismissed") {
      setActiveTab("done");
    } else if (match.bucket === "waiting_on_others") {
      setActiveTab("waiting");
    } else {
      setActiveTab("queue");
    }
    setSelectedTaskId(match.id);
    onClearInitialTask?.();
  }, [initialTaskId, tasks, onClearInitialTask]);

  const { needsYouTasks, waitingTasks, doneTasks } = useMemo(() => {
    const sortByPrio = (arr: TaskItem[]) =>
      [...arr].sort((a, b) => {
        const ra = PRIORITY_RANK[(a.priority || "P2").toUpperCase()] ?? 9;
        const rb = PRIORITY_RANK[(b.priority || "P2").toUpperCase()] ?? 9;
        if (ra !== rb) return ra - rb;
        return (b.updated_at || "").localeCompare(a.updated_at || "");
      });

    const queue: TaskItem[] = [];
    const waiting: TaskItem[] = [];
    const done: TaskItem[] = [];

    for (const t of tasks) {
      const st = (t.status || "todo").toLowerCase();
      if (st === "done" || st === "completed" || st === "dismissed") {
        done.push(t);
      } else if (t.bucket === "waiting_on_others") {
        waiting.push(t);
      } else {
        queue.push(t);
      }
    }

    return {
      needsYouTasks: sortByPrio(queue),
      waitingTasks: sortByPrio(waiting),
      doneTasks: sortByPrio(done),
    };
  }, [tasks]);

  const matchesFilters = useCallback(
    (t: TaskItem) => {
      if (
        priorityFilter !== "All" &&
        (t.priority || "P2").toUpperCase() !== priorityFilter
      ) {
        return false;
      }
      const q = searchQuery.trim().toLowerCase();
      if (!q) return true;
      const hay = [
        t.title,
        t.description,
        t.repo,
        t.source,
        t.counterparty,
        formatContextLabel(t),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    },
    [priorityFilter, searchQuery]
  );

  const filteredTasks = useMemo(() => {
    const base =
      activeTab === "waiting"
        ? waitingTasks
        : activeTab === "done"
        ? doneTasks
        : needsYouTasks;
    return base.filter(matchesFilters);
  }, [activeTab, needsYouTasks, waitingTasks, doneTasks, matchesFilters]);

  const boardColumns = useMemo(() => {
    const qFilteredQueue = needsYouTasks.filter(matchesFilters);
    const todo = qFilteredQueue.filter(
      (t) => (t.status || "todo").toLowerCase() !== "in_progress"
    );
    const inProgress = qFilteredQueue.filter(
      (t) => (t.status || "todo").toLowerCase() === "in_progress"
    );
    const waiting = waitingTasks.filter(matchesFilters);
    return { todo, inProgress, waiting };
  }, [needsYouTasks, waitingTasks, matchesFilters]);

  const allBoardTasks = useMemo(
    () => [
      ...boardColumns.todo,
      ...boardColumns.inProgress,
      ...boardColumns.waiting,
    ],
    [boardColumns]
  );

  useEffect(() => {
    const list = activeTab === "board" ? allBoardTasks : filteredTasks;
    if (list.length === 0) {
      setSelectedTaskId(null);
      return;
    }
    setSelectedTaskId((prev) => {
      if (prev !== null && list.some((t) => t.id === prev)) return prev;
      return list[0].id;
    });
  }, [activeTab, filteredTasks, allBoardTasks]);

  const selectedTask = useMemo(() => {
    const list = activeTab === "board" ? allBoardTasks : filteredTasks;
    if (!list.length) return null;
    return list.find((t) => t.id === selectedTaskId) ?? list[0] ?? null;
  }, [activeTab, allBoardTasks, filteredTasks, selectedTaskId]);

  useEffect(() => {
    setSnoozeMenuOpen(false);
    if (!selectedTask) {
      setTitleDraft("");
      setDescDraft("");
      setEditingTaskId(null);
      setNudgeTaskId(null);
      return;
    }
    const savedDraft = unsavedDrafts[selectedTask.id];
    setTitleDraft(savedDraft ? savedDraft.title : selectedTask.title ?? "");
    setDescDraft(
      savedDraft ? savedDraft.description : selectedTask.description ?? ""
    );
    if (editingTaskId !== selectedTask.id) {
      setEditingTaskId(null);
    }
    if (nudgeTaskId !== selectedTask.id) {
      setNudgeTaskId(null);
    }
  }, [
    selectedTask?.id,
    selectedTask?.title,
    selectedTask?.description,
    unsavedDrafts,
    editingTaskId,
    nudgeTaskId,
  ]);

  const updateTaskDraft = useCallback(
    (task: TaskItem, nextTitle: string, nextDesc: string) => {
      setTitleDraft(nextTitle);
      setDescDraft(nextDesc);
      const isDirty =
        nextTitle !== (task.title ?? "") ||
        nextDesc !== (task.description ?? "");
      setUnsavedDrafts((prev) => {
        if (!isDirty) {
          if (!(task.id in prev)) return prev;
          const copy = { ...prev };
          delete copy[task.id];
          return copy;
        }
        return {
          ...prev,
          [task.id]: { title: nextTitle, description: nextDesc },
        };
      });
    },
    []
  );

  const selectTaskWithGuard = useCallback(
    (nextId: number) => {
      if (
        selectedTask &&
        selectedTask.id !== nextId &&
        (titleDraft !== (selectedTask.title ?? "") ||
          descDraft !== (selectedTask.description ?? ""))
      ) {
        pushToast(
          "info",
          `Unsaved edits preserved on #${selectedTask.id}`,
          "Switch back anytime to save or revert."
        );
      }
      setSelectedTaskId(nextId);
    },
    [selectedTask, titleDraft, descDraft, pushToast]
  );

  // Clamp focusedIdx to visible tasks and reset on board tab
  useEffect(() => {
    if (activeTab === "board") {
      setFocusedIdx(-1);
      return;
    }
    setFocusedIdx((prev) => {
      if (filteredTasks.length === 0) return -1;
      if (prev < 0) return -1;
      return Math.min(prev, filteredTasks.length - 1);
    });
  }, [activeTab, filteredTasks.length]);

  // Scroll focused task row into view
  useEffect(() => {
    if (focusedIdx < 0) return;
    const task = filteredTasks[focusedIdx];
    if (!task) return;
    rowRefs.current[task.id]?.scrollIntoView({
      block: "nearest",
      behavior: "smooth",
    });
  }, [focusedIdx, filteredTasks]);

  useListKeyboardNav({
    items: filteredTasks,
    getId: (t) => t.id,
    selectedId:
      focusedIdx >= 0 ? (filteredTasks[focusedIdx]?.id ?? null) : null,
    onSelect: (id: number) => {
      const idx = filteredTasks.findIndex((t) => t.id === id);
      if (idx !== -1) setFocusedIdx(idx);
      selectTaskWithGuard(id);
    },
    onActivate: () => {
      detailRef.current?.focus();
    },
    onEscape: () => {
      if (boardDrawerOpen) {
        setBoardDrawerOpen(false);
      } else if (searchQuery) {
        setSearchQuery("");
      } else {
        setFocusedIdx(-1);
      }
    },
    searchInputRef,
    enabled: activeTab !== "board",
  });

  const handlePatchTask = useCallback(
    async (
      task: TaskItem,
      patch: {
        status?: TaskStatus;
        priority?: Priority;
        bucket?: TaskBucket;
        title?: string;
        description?: string;
        snoozed_until?: string | null;
      },
      successLabel?: string
    ) => {
      if (busyTaskId === task.id) return;
      setBusyTaskId(task.id);
      try {
        const res = await api.patchTask(task.id, patch);
        setTasks((prev) => prev.map((t) => (t.id === task.id ? res.task : t)));
        if (successLabel) {
          pushToast("success", successLabel, res.task.title);
        }
        onStateMutated();
      } catch (err) {
        pushToast(
          "error",
          "Failed to update task",
          err instanceof Error ? err.message : String(err)
        );
      } finally {
        setBusyTaskId(null);
      }
    },
    [busyTaskId, pushToast, onStateMutated]
  );

  const handleToggleDone = useCallback(
    async (task: TaskItem) => {
      const st = (task.status || "todo").toLowerCase();
      const isClosed = st === "done" || st === "completed" || st === "dismissed";
      if (isClosed) {
        await handlePatchTask(task, { status: "todo" }, "Task reopened");
      } else {
        await handlePatchTask(
          task,
          { status: "done" },
          task.bucket === "waiting_on_others" ? "Marked received" : "Marked done"
        );
      }
    },
    [handlePatchTask]
  );

  const handleSnoozeTask = useCallback(
    async (task: TaskItem, preset: SnoozePreset) => {
      setSnoozeMenuOpen(false);
      let snoozedUntil: string | null = null;
      let label = "Snooze cleared";
      if (preset !== "clear") {
        const d = new Date();
        if (preset === "3h") {
          d.setTime(d.getTime() + 3 * 60 * 60 * 1000);
          label = "Snoozed +3h";
        } else if (preset === "tomorrow") {
          d.setDate(d.getDate() + 1);
          d.setHours(9, 0, 0, 0);
          label = "Snoozed until Tomorrow";
        } else {
          d.setDate(d.getDate() + 7);
          d.setHours(9, 0, 0, 0);
          label = "Snoozed until Next Week";
        }
        snoozedUntil = d.toISOString();
      }
      await handlePatchTask(task, { snoozed_until: snoozedUntil }, label);
    },
    [handlePatchTask]
  );

  const openCreateModal = useCallback(() => {
    setNewBucket(
      activeTab === "waiting" ? "waiting_on_others" : "needed_from_me"
    );
    setNewModalOpen(true);
  }, [activeTab]);

  const handleDismiss = useCallback(
    async (task: TaskItem) => {
      if (busyTaskId === task.id) return;
      setBusyTaskId(task.id);
      try {
        const res = await api.dismissTask(task.id);
        setTasks((prev) => prev.map((t) => (t.id === task.id ? res.task : t)));
        pushToast(
          "info",
          "Dismissed",
          `"${task.title}" moved to Done.`
        );
        onStateMutated();
      } catch (err) {
        pushToast(
          "error",
          "Failed to dismiss task",
          err instanceof Error ? err.message : String(err)
        );
      } finally {
        setBusyTaskId(null);
      }
    },
    [busyTaskId, onStateMutated, pushToast]
  );

  // Single-key shortcuts (`n`, `c`, `e`, `x`, `i`, `s`, `1`-`4`)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
      if (
        newModalOpen ||
        draftModalTask !== null ||
        document.querySelector('[role="dialog"][aria-modal="true"]')
      ) {
        return;
      }
      const activeEl = document.activeElement;
      if (
        activeEl &&
        (activeEl.tagName === "INPUT" ||
          activeEl.tagName === "TEXTAREA" ||
          activeEl.tagName === "SELECT" ||
          (activeEl instanceof HTMLElement && activeEl.isContentEditable))
      ) {
        return;
      }

      if (e.key === "n") {
        e.preventDefault();
        quickInputRef.current?.focus();
        return;
      }
      if (e.key === "c") {
        e.preventDefault();
        openCreateModal();
        return;
      }

      const targetTask =
        (focusedIdx >= 0 ? filteredTasks[focusedIdx] : null) ?? selectedTask;
      if (!targetTask) return;
      const st = (targetTask.status || "todo").toLowerCase();
      const isClosed = st === "done" || st === "completed" || st === "dismissed";

      if (e.key === "e" && !isClosed) {
        e.preventDefault();
        void handlePatchTask(
          targetTask,
          { status: "done" },
          targetTask.bucket === "waiting_on_others"
            ? "Marked received"
            : "Marked done"
        );
      } else if (e.key === "x" && !isClosed) {
        e.preventDefault();
        void handleDismiss(targetTask);
      } else if (e.key === "i" && !isClosed) {
        e.preventDefault();
        void handlePatchTask(
          targetTask,
          { status: "in_progress" },
          "Marked in progress"
        );
      } else if (e.key === "s" && !isClosed) {
        e.preventDefault();
        void handleSnoozeTask(targetTask, "tomorrow");
      } else if (e.key === "1") {
        e.preventDefault();
        void handlePatchTask(targetTask, { priority: "P0" }, "Priority P0");
      } else if (e.key === "2") {
        e.preventDefault();
        void handlePatchTask(targetTask, { priority: "P1" }, "Priority P1");
      } else if (e.key === "3") {
        e.preventDefault();
        void handlePatchTask(targetTask, { priority: "P2" }, "Priority P2");
      } else if (e.key === "4") {
        e.preventDefault();
        void handlePatchTask(targetTask, { priority: "P3" }, "Priority P3");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    newModalOpen,
    draftModalTask,
    focusedIdx,
    filteredTasks,
    selectedTask,
    openCreateModal,
    handlePatchTask,
    handleDismiss,
    handleSnoozeTask,
  ]);

  const handleSaveTaskEdits = async () => {
    if (!selectedTask || savingEdits) return;
    const cleanTitle = titleDraft.trim() || selectedTask.title;
    setSavingEdits(true);
    try {
      const res = await api.patchTask(selectedTask.id, {
        title: cleanTitle,
        description: descDraft,
      });
      setTasks((prev) =>
        prev.map((t) => (t.id === selectedTask.id ? res.task : t))
      );
      setUnsavedDrafts((prev) => {
        if (!(selectedTask.id in prev)) return prev;
        const copy = { ...prev };
        delete copy[selectedTask.id];
        return copy;
      });
      setEditingTaskId(null);
      pushToast("success", "Changes saved", res.task.title);
      onStateMutated();
    } catch (err) {
      pushToast(
        "error",
        "Failed to save changes",
        err instanceof Error ? err.message : String(err)
      );
    } finally {
      setSavingEdits(false);
    }
  };

  const handleRestore = async (task: TaskItem) => {
    if (busyTaskId === task.id) return;
    setBusyTaskId(task.id);
    try {
      const res = await api.restoreTask(task.id);
      setTasks((prev) => prev.map((t) => (t.id === task.id ? res.task : t)));
      pushToast("success", "Task restored", res.task.title);
      onStateMutated();
    } catch (err) {
      pushToast(
        "error",
        "Failed to restore task",
        err instanceof Error ? err.message : String(err)
      );
    } finally {
      setBusyTaskId(null);
    }
  };

  const handleQuickCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!quickTitle.trim() || quickCreating) return;
    setQuickCreating(true);
    try {
      const targetBucket: TaskBucket =
        activeTab === "waiting" ? "waiting_on_others" : "needed_from_me";
      const res = await api.createTask({
        title: quickTitle.trim(),
        bucket: targetBucket,
        priority: "P1",
        source: "manual",
      });
      setTasks((prev) => [
        res.task,
        ...prev.filter((t) => t.id !== res.task.id),
      ]);
      setQuickTitle("");
      if (activeTab === "done") {
        setActiveTab("queue");
      }
      setSelectedTaskId(res.task.id);
      pushToast("success", "Task added", res.task.title);
      onStateMutated();
    } catch (err) {
      pushToast(
        "error",
        "Failed to create task",
        err instanceof Error ? err.message : String(err)
      );
    } finally {
      setQuickCreating(false);
    }
  };

  const handleCreateTask = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTitle.trim() || creating) return;
    setCreating(true);
    try {
      const res = await api.createTask({
        title: newTitle.trim(),
        description: newDescription.trim(),
        bucket: newBucket,
        priority: newPriority,
        source: "manual",
        source_url: newSourceUrl.trim(),
        repo: newRepo.trim(),
        counterparty: newCounterparty.trim(),
      });
      setTasks((prev) => [
        res.task,
        ...prev.filter((t) => t.id !== res.task.id),
      ]);
      setNewTitle("");
      setNewDescription("");
      setNewRepo("");
      setNewCounterparty("");
      setNewSourceUrl("");
      setNewModalOpen(false);
      setActiveTab(newBucket === "waiting_on_others" ? "waiting" : "queue");
      setSelectedTaskId(res.task.id);
      pushToast("success", "Task created", res.task.title);
      onStateMutated();
    } catch (err) {
      pushToast(
        "error",
        "Failed to create task",
        err instanceof Error ? err.message : String(err)
      );
    } finally {
      setCreating(false);
    }
  };

  const openSafeDraftModal = (task: TaskItem) => {
    const src = (task.source || "").toLowerCase();
    const prNum = extractPrNumberFromTask(task);
    let defaultType: SafeDraftActionType = "slack_send_external";
    if (src.includes("github") || (task.repo && prNum)) {
      defaultType = "github_pr_reply";
    } else if (
      src.includes("gmail") ||
      (task.counterparty || "").includes("@")
    ) {
      defaultType = "gmail_send_external";
    }

    setDraftActionType(defaultType);
    setDraftTarget(
      task.counterparty ||
        (defaultType === "slack_send_external" ? task.source_ref || "" : "")
    );
    setDraftSubject(`Re: ${task.title}`);
    setDraftRepo(task.repo || "");
    setDraftPrNumber(prNum);
    setDraftBody(
      [
        `Following up on: ${task.title}`,
        task.description ? `\n${task.description}` : "",
        task.source_url ? `\nRef: ${task.source_url}` : "",
      ]
        .filter(Boolean)
        .join("")
    );
    setDraftModalTask(task);
  };

  const handleStageSafeDraft = async (e: React.FormEvent) => {
    e.preventDefault();
    const task = draftModalTask;
    if (!task || stagingDraft) return;
    setStagingDraft(true);

    let payload: Record<string, unknown> = {};
    let summary = "";

    if (draftActionType === "slack_send_external") {
      payload = {
        channel_id: draftTarget.trim(),
        message: draftBody.trim(),
        task_id: task.id,
      };
      summary = `Draft Slack reply for task #${task.id}.`;
    } else if (draftActionType === "gmail_send_external") {
      payload = {
        to: draftTarget.trim(),
        subject: draftSubject.trim(),
        body: draftBody.trim(),
        task_id: task.id,
      };
      summary = `Draft email reply for task #${task.id}.`;
    } else {
      payload = {
        repo: draftRepo.trim() || task.repo || "",
        pr_number: draftPrNumber ? Number(draftPrNumber) : undefined,
        top_level_body: draftBody.trim(),
        task_id: task.id,
      };
      summary = `Draft PR reply for task #${task.id}.`;
    }

    try {
      const res = await api.stageApproval({
        action_type: draftActionType,
        title: `Reply: ${task.title}`,
        summary,
        repo: draftRepo.trim() || task.repo || "",
        ownership_reason: task.ownership_reason || "work_task_safe_draft",
        payload,
      });

      if (res.approval_id) {
        setStagedApprovalByTaskId((prev) => ({
          ...prev,
          [task.id]: res.approval_id!,
        }));
      }
      setDraftModalTask(null);
      pushToast(
        "success",
        `Staged in Approvals (#${res.approval_id ?? "pending"})`,
        "Ready for sign-off."
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

  const openFollowUpNudge = (task: TaskItem) => {
    if (nudgeTaskId === task.id) {
      setNudgeTaskId(null);
      return;
    }
    const src = (task.source || "").toLowerCase();
    const prNum = extractPrNumberFromTask(task);
    let defaultType: SafeDraftActionType = "slack_send_external";
    if (src.includes("github") || (task.repo && prNum)) {
      defaultType = "github_pr_reply";
    } else if (
      src.includes("gmail") ||
      (task.counterparty || "").includes("@")
    ) {
      defaultType = "gmail_send_external";
    }
    const who = formatFirstName(task.counterparty);
    setNudgeChannel(defaultType);
    setNudgeTarget(
      task.counterparty ||
        (defaultType === "slack_send_external" ? task.source_ref || "" : "")
    );
    setNudgeSubject(`Follow-up: ${task.title}`);
    setNudgeRepo(task.repo || "");
    setNudgePrNumber(prNum);
    setNudgeBody(
      `Hi${who ? ` ${who}` : ""} — checking in on "${task.title}". Let me know if anything is needed from my end.`
    );
    setNudgeTaskId(task.id);
  };

  const handleStageFollowUpNudge = async (
    e: React.FormEvent,
    task: TaskItem
  ) => {
    e.preventDefault();
    if (stagingNudge || !nudgeBody.trim()) return;
    setStagingNudge(true);

    let payload: Record<string, unknown> = {};
    let summary = "";
    if (nudgeChannel === "slack_send_external") {
      payload = {
        channel_id: nudgeTarget.trim(),
        message: nudgeBody.trim(),
        task_id: task.id,
      };
      summary = `Follow-up Slack message for task #${task.id}.`;
    } else if (nudgeChannel === "gmail_send_external") {
      payload = {
        to: nudgeTarget.trim(),
        subject: nudgeSubject.trim(),
        body: nudgeBody.trim(),
        task_id: task.id,
      };
      summary = `Follow-up email for task #${task.id}.`;
    } else {
      payload = {
        repo: nudgeRepo.trim() || task.repo || "",
        pr_number: nudgePrNumber ? Number(nudgePrNumber) : undefined,
        top_level_body: nudgeBody.trim(),
        task_id: task.id,
      };
      summary = `Follow-up PR comment for task #${task.id}.`;
    }

    try {
      const res = await api.stageApproval({
        action_type: nudgeChannel,
        title: `Follow-up: ${task.title}`,
        summary,
        repo: nudgeRepo.trim() || task.repo || "",
        ownership_reason:
          task.ownership_reason || "waiting_on_others_followup",
        payload,
      });
      if (res.approval_id) {
        setStagedApprovalByTaskId((prev) => ({
          ...prev,
          [task.id]: res.approval_id!,
        }));
      }
      setNudgeTaskId(null);
      pushToast(
        "success",
        `Follow-up staged in Approvals (#${res.approval_id ?? "pending"})`,
        "Ready for sign-off."
      );
      onStateMutated();
    } catch (err) {
      pushToast(
        "error",
        "Failed to stage follow-up",
        err instanceof Error ? err.message : String(err)
      );
    } finally {
      setStagingNudge(false);
    }
  };

  const renderTaskDetail = (task: TaskItem, insideDrawer = false) => {
    const st = (task.status || "todo").toLowerCase();
    const isDismissed = st === "dismissed";
    const isDone = st === "done" || st === "completed";
    const isClosed = isDone || isDismissed;
    const isBusy = busyTaskId === task.id;
    const isEditing = editingTaskId === task.id;
    const isWaiting = task.bucket === "waiting_on_others";
    const isComposingNudge = nudgeTaskId === task.id;
    const stagedApprovalId =
      task.approval_id ?? stagedApprovalByTaskId[task.id] ?? null;

    const scheduledAt = task.snoozed_until || task.due_at;
    const contextName = formatContextLabel(task);
    const sourceLabel = formatCompactSource(task.source);
    const footerParts = [
      sourceLabel,
      contextName && contextName !== sourceLabel ? contextName : null,
      task.snoozed_until
        ? `Snoozed ${formatDateTime(task.snoozed_until)}`
        : task.due_at
        ? `Due ${formatDateTime(task.due_at)}`
        : null,
    ].filter(Boolean);

    const hasUnsavedEdits =
      titleDraft !== (task.title ?? "") ||
      descDraft !== (task.description ?? "");

    return (
      <div
        ref={insideDrawer ? undefined : detailRef}
        tabIndex={-1}
        className={`${
          insideDrawer ? "space-y-5" : "ce-card space-y-4 p-5"
        } focus:outline-none`}
      >
        {/* Top Pills + Edit Button */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <PriorityBadge priority={task.priority} variant="pill" />
            <StatusBadge status={task.status} variant="pill" />
            {scheduledAt && !isClosed && (
              <span className="ce-pill font-mono text-[11px]">
                <Clock className="h-3 w-3 text-[var(--accent)]" />
                <span>
                  {task.snoozed_until ? "Snoozed" : "Due"} ·{" "}
                  {formatDateTime(scheduledAt)}
                </span>
              </span>
            )}
          </div>

          {!isClosed && (
            <button
              type="button"
              onClick={() => {
                if (isEditing) {
                  setEditingTaskId(null);
                } else {
                  setEditingTaskId(task.id);
                }
              }}
              title={isEditing ? "Close editor" : "Edit task"}
              aria-label={isEditing ? "Close editor" : "Edit task"}
              className={`ce-btn ce-btn-ghost h-7 w-7 p-0 ${
                isEditing
                  ? "bg-[var(--accent-soft)] text-[var(--accent)]"
                  : "text-[var(--muted)] hover:text-[var(--ink)]"
              }`}
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        {/* Title & Description (or Clean Inline Editor) */}
        {isEditing ? (
          <div className="space-y-3">
            <div>
              <input
                type="text"
                aria-label="Task title"
                value={titleDraft}
                onChange={(e) =>
                  updateTaskDraft(task, e.target.value, descDraft)
                }
                className="ce-input text-[15px] font-semibold"
              />
            </div>

            <div className="grid grid-cols-2 gap-2">
              <select
                aria-label="Priority"
                disabled={isBusy}
                value={(task.priority || "P2").toUpperCase()}
                onChange={(e) =>
                  void handlePatchTask(
                    task,
                    { priority: e.target.value as Priority },
                    `Priority ${e.target.value}`
                  )
                }
                className="ce-input font-mono text-xs"
              >
                <option value="P0">P0 · Critical</option>
                <option value="P1">P1 · High</option>
                <option value="P2">P2 · Normal</option>
                <option value="P3">P3 · Low</option>
              </select>

              <select
                aria-label="Status"
                disabled={isBusy}
                value={st}
                onChange={(e) =>
                  void handlePatchTask(
                    task,
                    { status: e.target.value as TaskStatus },
                    "Status updated"
                  )
                }
                className="ce-input text-xs"
              >
                <option value="todo">To Do</option>
                <option value="in_progress">In Progress</option>
                <option value="blocked">Blocked</option>
                <option value="done">Done</option>
              </select>
            </div>

            <textarea
              rows={4}
              aria-label="Task description"
              value={descDraft}
              onChange={(e) =>
                updateTaskDraft(task, titleDraft, e.target.value)
              }
              placeholder="Add notes or acceptance criteria…"
              className="ce-input resize-y text-[13px] leading-relaxed"
            />

            <div className="flex items-center justify-end gap-2">
              {hasUnsavedEdits && (
                <button
                  type="button"
                  onClick={() => {
                    updateTaskDraft(
                      task,
                      task.title ?? "",
                      task.description ?? ""
                    );
                    setEditingTaskId(null);
                  }}
                  className="ce-btn ce-btn-ghost h-7 px-2.5 text-xs"
                >
                  Revert
                </button>
              )}
              <button
                type="button"
                disabled={savingEdits}
                onClick={() => void handleSaveTaskEdits()}
                className="ce-btn ce-btn-primary h-7 px-3 text-xs"
              >
                <Save className="h-3 w-3" />
                <span>{savingEdits ? "Saving…" : "Save"}</span>
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            <h2
              className={`text-[16px] font-semibold leading-snug tracking-[-0.015em] ${
                isClosed
                  ? "line-through text-[var(--muted)]"
                  : "text-[var(--ink)]"
              }`}
            >
              {titleDraft || task.title}
            </h2>
            {(descDraft || task.description) && (
              <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-[var(--ink-secondary)]">
                {descDraft || task.description}
              </p>
            )}
            {hasUnsavedEdits && (
              <div className="flex items-center gap-2 pt-1">
                <span className="font-mono text-[11px] text-[var(--amber)]">
                  Unsaved edits
                </span>
                <button
                  type="button"
                  disabled={savingEdits}
                  onClick={() => void handleSaveTaskEdits()}
                  className="ce-btn ce-btn-accent h-6 px-2 text-[11px]"
                >
                  Save
                </button>
              </div>
            )}
          </div>
        )}

        {/* Inline Follow-Up Composer (Waiting On Others) */}
        {isComposingNudge && isWaiting && !isClosed && (
          <form
            onSubmit={(e) => void handleStageFollowUpNudge(e, task)}
            className="space-y-2.5 rounded-xl border border-[var(--accent-border)] bg-[var(--surface-sunken)]/60 p-3.5 text-xs"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium text-[var(--accent)]">
                Stage Follow-Up in Approvals
              </span>
              <button
                type="button"
                onClick={() => setNudgeTaskId(null)}
                className="text-[11px] text-[var(--muted)] hover:text-[var(--ink)]"
              >
                Cancel
              </button>
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <select
                aria-label="Follow-up channel"
                value={nudgeChannel}
                onChange={(e) =>
                  setNudgeChannel(e.target.value as SafeDraftActionType)
                }
                className="ce-input text-xs"
              >
                <option value="slack_send_external">Slack</option>
                <option value="gmail_send_external">Gmail</option>
                <option value="github_pr_reply">GitHub PR</option>
              </select>
              {nudgeChannel === "github_pr_reply" ? (
                <input
                  type="text"
                  value={nudgeRepo}
                  onChange={(e) => setNudgeRepo(e.target.value)}
                  list="work-repo-suggestions"
                  placeholder="org/repository"
                  className="ce-input font-mono text-xs"
                />
              ) : (
                <input
                  type="text"
                  value={nudgeTarget}
                  onChange={(e) => setNudgeTarget(e.target.value)}
                  placeholder={
                    nudgeChannel === "gmail_send_external"
                      ? "teammate@company.com"
                      : "#channel or @person"
                  }
                  className="ce-input font-mono text-xs"
                />
              )}
            </div>
            <textarea
              rows={3}
              required
              value={nudgeBody}
              onChange={(e) => setNudgeBody(e.target.value)}
              placeholder="Write a polite follow-up…"
              className="ce-input resize-y text-xs leading-relaxed"
            />
            <div className="flex justify-end">
              <button
                type="submit"
                disabled={stagingNudge || !nudgeBody.trim()}
                className="ce-btn ce-btn-primary h-7 px-3 text-xs"
              >
                <ShieldCheck className="h-3.5 w-3.5" />
                <span>{stagingNudge ? "Staging…" : "Stage Draft"}</span>
              </button>
            </div>
          </form>
        )}

        {/* Primary Action Row */}
        <div className="flex flex-wrap items-center gap-2 pt-1">
          {!isClosed && !isWaiting && (
            <>
              {st === "todo" ? (
                <button
                  type="button"
                  disabled={isBusy}
                  onClick={() =>
                    void handlePatchTask(
                      task,
                      { status: "in_progress" },
                      "Started"
                    )
                  }
                  className="ce-btn ce-btn-primary"
                >
                  <Play className="h-3.5 w-3.5" />
                  <span>Start</span>
                </button>
              ) : null}

              <button
                type="button"
                disabled={isBusy}
                onClick={() =>
                  void handlePatchTask(task, { status: "done" }, "Marked done")
                }
                className={`ce-btn ${
                  st === "todo" ? "ce-btn-sage" : "ce-btn-primary"
                }`}
              >
                <Check className="h-3.5 w-3.5" />
                <span>Mark Done</span>
              </button>

              {/* Snooze Menu */}
              <div ref={snoozeMenuRef} className="relative">
                <button
                  type="button"
                  disabled={isBusy}
                  aria-expanded={snoozeMenuOpen}
                  onClick={() => setSnoozeMenuOpen((v) => !v)}
                  className="ce-btn"
                >
                  <Clock className="h-3.5 w-3.5 text-[var(--muted)]" />
                  <span>Snooze</span>
                  <ChevronDown className="h-3 w-3 text-[var(--muted)]" />
                </button>

                {snoozeMenuOpen && (
                  <div className="ce-card ce-float absolute left-0 z-20 mt-1.5 w-44 divide-y divide-[var(--line)] overflow-hidden py-1 text-xs">
                    <button
                      type="button"
                      onClick={() => void handleSnoozeTask(task, "3h")}
                      className="flex w-full items-center justify-between px-3 py-2 text-left text-[var(--ink)] hover:bg-[var(--surface-raised)]"
                    >
                      <span>Later today</span>
                      <span className="font-mono text-[11px] text-[var(--muted)]">
                        +3h
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleSnoozeTask(task, "tomorrow")}
                      className="flex w-full items-center justify-between px-3 py-2 text-left text-[var(--ink)] hover:bg-[var(--surface-raised)]"
                    >
                      <span>Tomorrow</span>
                      <span className="font-mono text-[11px] text-[var(--muted)]">
                        09:00
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleSnoozeTask(task, "next_week")}
                      className="flex w-full items-center justify-between px-3 py-2 text-left text-[var(--ink)] hover:bg-[var(--surface-raised)]"
                    >
                      <span>Next Week</span>
                      <span className="font-mono text-[11px] text-[var(--muted)]">
                        +7d
                      </span>
                    </button>
                    {task.snoozed_until && (
                      <button
                        type="button"
                        onClick={() => void handleSnoozeTask(task, "clear")}
                        className="flex w-full items-center px-3 py-2 text-left text-[var(--muted)] hover:bg-[var(--surface-raised)] hover:text-[var(--ink)]"
                      >
                        Clear snooze
                      </button>
                    )}
                  </div>
                )}
              </div>

              <button
                type="button"
                onClick={() => openSafeDraftModal(task)}
                className="ce-btn"
              >
                <Send className="h-3.5 w-3.5 text-[var(--muted)]" />
                <span>Draft Reply</span>
              </button>

              {stagedApprovalId && (
                <button
                  type="button"
                  onClick={() => {
                    if (onJumpToApproval) {
                      onJumpToApproval(stagedApprovalId);
                    } else {
                      onNavigate("Approvals");
                    }
                  }}
                  className="ce-btn ce-btn-accent"
                >
                  <ShieldCheck className="h-3.5 w-3.5" />
                  <span>Approval #{stagedApprovalId}</span>
                </button>
              )}
            </>
          )}

          {!isClosed && isWaiting && (
            <>
              <button
                type="button"
                onClick={() => openFollowUpNudge(task)}
                className="ce-btn ce-btn-primary"
              >
                <MessageSquarePlus className="h-3.5 w-3.5" />
                <span>Draft Follow-Up</span>
              </button>

              <button
                type="button"
                disabled={isBusy}
                onClick={() =>
                  void handlePatchTask(
                    task,
                    { bucket: "needed_from_me" },
                    "Moved to My Queue"
                  )
                }
                className="ce-btn"
              >
                <ArrowRightLeft className="h-3.5 w-3.5 text-[var(--muted)]" />
                <span>Move to My Queue</span>
              </button>

              <button
                type="button"
                disabled={isBusy}
                onClick={() =>
                  void handlePatchTask(
                    task,
                    { status: "done" },
                    "Marked done"
                  )
                }
                className="ce-btn ce-btn-sage"
              >
                <Check className="h-3.5 w-3.5" />
                <span>Mark Done</span>
              </button>

              {stagedApprovalId && (
                <button
                  type="button"
                  onClick={() => {
                    if (onJumpToApproval) {
                      onJumpToApproval(stagedApprovalId);
                    } else {
                      onNavigate("Approvals");
                    }
                  }}
                  className="ce-btn ce-btn-accent"
                >
                  <ShieldCheck className="h-3.5 w-3.5" />
                  <span>Approval #{stagedApprovalId}</span>
                </button>
              )}
            </>
          )}

          {isDismissed && (
            <button
              type="button"
              disabled={isBusy}
              onClick={() => void handleRestore(task)}
              className="ce-btn ce-btn-primary"
            >
              <ArchiveRestore className="h-3.5 w-3.5" />
              <span>Restore</span>
            </button>
          )}

          {isDone && (
            <button
              type="button"
              disabled={isBusy}
              onClick={() =>
                void handlePatchTask(task, { status: "todo" }, "Task reopened")
              }
              className="ce-btn"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              <span>Reopen</span>
            </button>
          )}

          {!isClosed && (
            <button
              type="button"
              disabled={isBusy}
              onClick={() => void handleDismiss(task)}
              title="Not Mine — dismiss from queue"
              className="ce-btn ce-btn-ghost ml-auto h-7 px-2 text-[11.5px] text-[var(--muted)] hover:text-[var(--coral)]"
            >
              <EyeOff className="h-3.5 w-3.5" />
              <span>Dismiss</span>
            </button>
          )}
        </div>

        {/* Quiet Single-Line Provenance Footer */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--line)] pt-3 text-[11.5px] text-[var(--muted)]">
          <span className="truncate">{footerParts.join(" · ")}</span>
          {task.source_url && (
            <a
              href={task.source_url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex shrink-0 items-center gap-1 font-medium text-[var(--accent)] hover:underline"
            >
              <span>Open Source</span>
              <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="mx-auto w-full max-w-[1160px] space-y-4 px-6 pt-2 pb-8">
      <datalist id="work-repo-suggestions">
        {repoSuggestions.map((repo) => (
          <option key={repo} value={repo} />
        ))}
      </datalist>

      <WorkspaceHeader
        title="Work"
        tabs={[
          { id: "queue", label: "My Queue", count: needsYouTasks.length },
          { id: "waiting", label: "Waiting", count: waitingTasks.length },
          { id: "board", label: "Board" },
          { id: "done", label: "Done" },
        ]}
        activeTab={activeTab}
        onTabChange={(id) => {
          setActiveTab(id as WorkTab);
          if (id !== "board") setBoardDrawerOpen(false);
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
                aria-label="Search tasks"
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

            <div
              className="inline-flex items-center rounded-lg border border-[var(--line)] bg-[var(--surface-sunken)] p-0.5"
              role="group"
              aria-label="Priority filter"
            >
              {(["All", "P0", "P1", "P2"] as const).map((prio) => (
                <button
                  key={prio}
                  type="button"
                  onClick={() => setPriorityFilter(prio)}
                  className={`cursor-pointer rounded-md px-2 py-1 font-mono text-[11px] font-medium transition-colors ${
                    priorityFilter === prio
                      ? "bg-[var(--surface-raised)] text-[var(--ink)]"
                      : "text-[var(--muted)] hover:text-[var(--ink)]"
                  }`}
                >
                  {prio}
                </button>
              ))}
            </div>

            <button
              type="button"
              onClick={openCreateModal}
              className="ce-btn ce-btn-primary h-8 px-3 text-xs"
            >
              <Plus className="h-3.5 w-3.5" />
              <span>New Task</span>
            </button>
          </div>
        }
      />

      {fetchError && (
        <ErrorBanner
          title="Unable to load work queue"
          message={fetchError}
          onRetry={() => void loadTasks()}
        />
      )}

      {loading && tasks.length === 0 ? (
        <div className="ce-card p-5">
          <SkeletonRows rows={6} />
        </div>
      ) : activeTab === "board" ? (
        /* Clean 3-Column Kanban (No 4th panel underneath; clicking opens DrawerPanel) */
        <section className="grid grid-cols-1 gap-4 md:grid-cols-3">
          {(
            [
              { id: "todo", title: "To Do", items: boardColumns.todo },
              {
                id: "in_progress",
                title: "In Progress",
                items: boardColumns.inProgress,
              },
              { id: "waiting", title: "Waiting", items: boardColumns.waiting },
            ] as const
          ).map((col) => (
            <div
              key={col.id}
              className="ce-card flex min-h-[340px] flex-col overflow-hidden"
            >
              <div className="flex items-center justify-between border-b border-[var(--line)] px-4 py-3">
                <span className="text-[12.5px] font-semibold text-[var(--ink)]">
                  {col.title}
                </span>
                <span className="font-mono text-[11px] text-[var(--muted)] tabular-nums">
                  {col.items.length}
                </span>
              </div>

              {col.items.length === 0 ? (
                <div className="flex flex-1 items-center justify-center p-6 text-center text-xs text-[var(--subtle)]">
                  Empty
                </div>
              ) : (
                <div className="ce-contain-scroll flex-1 space-y-2 overflow-y-auto p-3">
                  {col.items.map((t) => {
                    const active = boardDrawerOpen && selectedTask?.id === t.id;
                    const context = formatContextLabel(t);
                    return (
                      <button
                        key={t.id}
                        type="button"
                        onClick={() => {
                          selectTaskWithGuard(t.id);
                          setBoardDrawerOpen(true);
                        }}
                        className={`block w-full rounded-xl border p-3 text-left transition ${
                          active
                            ? "border-[var(--accent)] bg-[var(--accent-soft)]/55"
                            : "border-[var(--line)] bg-[var(--surface-raised)]/45 hover:border-[var(--line-strong)]"
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <PriorityBadge priority={t.priority} variant="pill" />
                          {context && (
                            <span className="truncate text-[11px] text-[var(--muted)]">
                              {context}
                            </span>
                          )}
                        </div>
                        <p className="mt-2 line-clamp-2 text-[13px] font-medium leading-snug text-[var(--ink)]">
                          {t.title}
                        </p>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          ))}
        </section>
      ) : (
        /* Clean Linear Split View (My Queue / Waiting / Done) */
        <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-12">
          {/* Left: Calm Translucent List */}
          <section className="ce-card divide-y divide-[var(--line)] overflow-hidden lg:col-span-7">
            {activeTab !== "done" && (
              <form
                onSubmit={handleQuickCreate}
                className="flex items-center gap-2.5 px-4 py-2.5"
              >
                <Plus className="h-3.5 w-3.5 shrink-0 text-[var(--muted)]" />
                <input
                  ref={quickInputRef}
                  type="text"
                  value={quickTitle}
                  disabled={quickCreating}
                  onChange={(e) => setQuickTitle(e.target.value)}
                  placeholder={
                    activeTab === "waiting"
                      ? "+ Track something you're waiting on…"
                      : "+ Add a task…"
                  }
                  aria-label="Quick add task"
                  className="min-w-0 flex-1 bg-transparent text-[13px] text-[var(--ink)] placeholder:text-[var(--subtle)] focus:outline-none"
                />
                {quickTitle.trim() && (
                  <span className="font-mono text-[10.5px] text-[var(--muted)]">
                    ↵ Enter
                  </span>
                )}
              </form>
            )}

            {filteredTasks.length === 0 ? (
              <EmptyState
                icon={activeTab === "waiting" ? Users : ListChecks}
                title={
                  searchQuery.trim()
                    ? `No matches for "${searchQuery.trim()}"`
                    : activeTab === "done"
                    ? "Nothing completed yet"
                    : activeTab === "waiting"
                    ? "Not waiting on anyone"
                    : "Your queue is clear"
                }
                description={
                  activeTab === "done"
                    ? "Completed and dismissed tasks appear here."
                    : "Type above and press Enter to add a task."
                }
              />
            ) : (
              filteredTasks.map((t, idx) => {
                const active = selectedTask?.id === t.id;
                const isFocused = idx === focusedIdx;
                const st = (t.status || "todo").toLowerCase();
                const isClosed =
                  st === "done" || st === "completed" || st === "dismissed";
                const context = formatContextLabel(t);
                const age = formatCompactAge(t.updated_at);

                return (
                  <div
                    key={t.id}
                    ref={(el) => {
                      rowRefs.current[t.id] = el;
                    }}
                    role="button"
                    tabIndex={0}
                    data-kbd-focused={isFocused ? "true" : undefined}
                    style={
                      isFocused
                        ? {
                            boxShadow:
                              "inset 2px 0 0 var(--accent-primary, var(--accent))",
                          }
                        : undefined
                    }
                    onClick={() => {
                      setFocusedIdx(idx);
                      selectTaskWithGuard(t.id);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setFocusedIdx(idx);
                        selectTaskWithGuard(t.id);
                      }
                    }}
                    className={`flex cursor-pointer items-center justify-between gap-3 px-4 py-3 transition-colors ${
                      active
                        ? "bg-[var(--accent-soft)]/65"
                        : "hover:bg-[var(--surface-raised)]/45"
                    }`}
                  >
                    <div className="flex min-w-0 flex-1 items-center gap-2.5">
                      <button
                        type="button"
                        disabled={busyTaskId === t.id}
                        aria-label={
                          isClosed ? `Reopen ${t.title}` : `Mark ${t.title} done`
                        }
                        onClick={(e) => {
                          e.stopPropagation();
                          void handleToggleDone(t);
                        }}
                        className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition ${
                          isClosed
                            ? "border-[var(--sage)] bg-[var(--sage-soft)] text-[var(--sage)]"
                            : "border-[var(--line-strong)] hover:border-[var(--accent)] hover:bg-[var(--accent-soft)]"
                        }`}
                      >
                        {isClosed && <Check className="h-2.5 w-2.5" />}
                      </button>

                      <PriorityBadge priority={t.priority} />

                      <span
                        className={`line-clamp-1 min-w-0 text-[13.5px] font-medium ${
                          isClosed
                            ? "line-through text-[var(--muted)]"
                            : "text-[var(--ink)]"
                        }`}
                      >
                        {t.title}
                      </span>
                    </div>

                    <div className="flex shrink-0 items-center gap-2.5 text-[11.5px] text-[var(--muted)]">
                      {context && (
                        <span className="max-w-[120px] truncate">{context}</span>
                      )}
                      {age && (
                        <span className="font-mono text-[11px] tabular-nums">
                          {age}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })
            )}
            {filteredTasks.length > 0 && (
              <div className="flex items-center justify-end border-t border-[var(--line)] px-4 py-2 text-[11px] text-[var(--muted)]">
                <span className="font-mono">
                  J/K navigate · E done · X dismiss · ? shortcuts
                </span>
              </div>
            )}
          </section>

          {/* Right: Clean Task Detail Card */}
          <aside className="lg:sticky lg:top-4 lg:col-span-5">
            {selectedTask ? (
              renderTaskDetail(selectedTask)
            ) : (
              <div className="ce-card flex min-h-[240px] items-center justify-center p-6 text-center text-xs text-[var(--muted)]">
                Select a task to view details.
              </div>
            )}
          </aside>
        </div>
      )}

      {/* Board Detail Drawer (Never stacked underneath columns) */}
      <DrawerPanel
        open={activeTab === "board" && boardDrawerOpen && selectedTask !== null}
        onClose={() => setBoardDrawerOpen(false)}
        title={selectedTask?.title || "Task Details"}
        widthClass="max-w-md"
      >
        {selectedTask && renderTaskDetail(selectedTask, true)}
      </DrawerPanel>

      {/* Safe Outbound Draft Modal */}
      <ModalDialog
        open={draftModalTask !== null}
        onClose={() => {
          if (!stagingDraft) setDraftModalTask(null);
        }}
        title="Draft Reply"
        subtitle="Staged in Approvals for your sign-off before sending."
        footer={
          <>
            <button
              type="button"
              disabled={stagingDraft}
              onClick={() => setDraftModalTask(null)}
              className="ce-btn ce-btn-ghost"
            >
              Cancel
            </button>
            <button
              type="submit"
              form="work-safe-draft-form"
              disabled={stagingDraft || !draftBody.trim()}
              className="ce-btn ce-btn-primary"
            >
              <ShieldCheck className="h-3.5 w-3.5" />
              <span>{stagingDraft ? "Staging…" : "Stage in Approvals"}</span>
            </button>
          </>
        }
      >
        {draftModalTask && (
          <form
            id="work-safe-draft-form"
            onSubmit={handleStageSafeDraft}
            className="space-y-3.5 text-xs"
          >
            <div>
              <label
                htmlFor="safe-draft-action-type"
                className="mb-1 block text-xs font-medium text-[var(--ink-secondary)]"
              >
                Channel
              </label>
              <select
                id="safe-draft-action-type"
                value={draftActionType}
                onChange={(e) =>
                  setDraftActionType(e.target.value as SafeDraftActionType)
                }
                className="ce-input text-xs"
              >
                <option value="slack_send_external">Slack</option>
                <option value="gmail_send_external">Gmail</option>
                <option value="github_pr_reply">GitHub PR Comment</option>
              </select>
            </div>

            {draftActionType === "slack_send_external" && (
              <div>
                <label
                  htmlFor="safe-draft-slack-target"
                  className="mb-1 block text-xs font-medium text-[var(--ink-secondary)]"
                >
                  Channel / Recipient
                </label>
                <input
                  id="safe-draft-slack-target"
                  type="text"
                  value={draftTarget}
                  onChange={(e) => setDraftTarget(e.target.value)}
                  placeholder="#engineering or @teammate"
                  className="ce-input font-mono"
                />
              </div>
            )}

            {draftActionType === "gmail_send_external" && (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label
                    htmlFor="safe-draft-gmail-to"
                    className="mb-1 block text-xs font-medium text-[var(--ink-secondary)]"
                  >
                    To
                  </label>
                  <input
                    id="safe-draft-gmail-to"
                    type="text"
                    value={draftTarget}
                    onChange={(e) => setDraftTarget(e.target.value)}
                    placeholder="teammate@company.com"
                    className="ce-input"
                  />
                </div>
                <div>
                  <label
                    htmlFor="safe-draft-gmail-subject"
                    className="mb-1 block text-xs font-medium text-[var(--ink-secondary)]"
                  >
                    Subject
                  </label>
                  <input
                    id="safe-draft-gmail-subject"
                    type="text"
                    value={draftSubject}
                    onChange={(e) => setDraftSubject(e.target.value)}
                    className="ce-input"
                  />
                </div>
              </div>
            )}

            {draftActionType === "github_pr_reply" && (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label
                    htmlFor="safe-draft-pr-repo"
                    className="mb-1 block text-xs font-medium text-[var(--ink-secondary)]"
                  >
                    Repository
                  </label>
                  <input
                    id="safe-draft-pr-repo"
                    type="text"
                    list="work-repo-suggestions"
                    value={draftRepo}
                    onChange={(e) => setDraftRepo(e.target.value)}
                    placeholder={repoSuggestions[0] || "org/repository"}
                    className="ce-input font-mono"
                  />
                </div>
                <div>
                  <label
                    htmlFor="safe-draft-pr-number"
                    className="mb-1 block text-xs font-medium text-[var(--ink-secondary)]"
                  >
                    PR Number
                  </label>
                  <input
                    id="safe-draft-pr-number"
                    type="number"
                    value={draftPrNumber}
                    onChange={(e) => setDraftPrNumber(e.target.value)}
                    placeholder="142"
                    className="ce-input font-mono tabular-nums"
                  />
                </div>
              </div>
            )}

            <div>
              <label
                htmlFor="safe-draft-body"
                className="mb-1 block text-xs font-medium text-[var(--ink-secondary)]"
              >
                Message
              </label>
              <textarea
                id="safe-draft-body"
                rows={5}
                required
                value={draftBody}
                onChange={(e) => setDraftBody(e.target.value)}
                className="ce-input resize-y leading-relaxed"
              />
            </div>
          </form>
        )}
      </ModalDialog>

      {/* New Task Modal */}
      <ModalDialog
        open={newModalOpen}
        onClose={() => setNewModalOpen(false)}
        title="New Task"
        footer={
          <>
            <button
              type="button"
              onClick={() => setNewModalOpen(false)}
              className="ce-btn ce-btn-ghost"
            >
              Cancel
            </button>
            <button
              type="submit"
              form="new-work-task-form"
              disabled={creating || !newTitle.trim()}
              className="ce-btn ce-btn-primary"
            >
              <Plus className="h-3.5 w-3.5" />
              <span>{creating ? "Creating…" : "Create Task"}</span>
            </button>
          </>
        }
      >
        <form
          id="new-work-task-form"
          onSubmit={handleCreateTask}
          className="space-y-3.5"
        >
          <div>
            <label className="mb-1 block text-xs font-medium text-[var(--ink-secondary)]">
              Title
            </label>
            <input
              type="text"
              required
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              placeholder="e.g. Fix failing CI check on PR #142"
              className="ce-input"
            />
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs font-medium text-[var(--ink-secondary)]">
                Queue
              </label>
              <select
                value={newBucket}
                onChange={(e) => setNewBucket(e.target.value as TaskBucket)}
                className="ce-input"
              >
                <option value="needed_from_me">My Queue</option>
                <option value="waiting_on_others">Waiting</option>
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-[var(--ink-secondary)]">
                Priority
              </label>
              <select
                value={newPriority}
                onChange={(e) => setNewPriority(e.target.value as Priority)}
                className="ce-input font-mono"
              >
                <option value="P0">P0 · Critical</option>
                <option value="P1">P1 · High</option>
                <option value="P2">P2 · Normal</option>
                <option value="P3">P3 · Low</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs font-medium text-[var(--ink-secondary)]">
                Repo
              </label>
              <input
                type="text"
                list="work-repo-suggestions"
                value={newRepo}
                onChange={(e) => setNewRepo(e.target.value)}
                placeholder={repoSuggestions[0] || "org/repository"}
                className="ce-input font-mono"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-[var(--ink-secondary)]">
                Person
              </label>
              <input
                type="text"
                value={newCounterparty}
                onChange={(e) => setNewCounterparty(e.target.value)}
                placeholder="Teammate"
                className="ce-input"
              />
            </div>
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-[var(--ink-secondary)]">
              Link (optional)
            </label>
            <input
              type="url"
              value={newSourceUrl}
              onChange={(e) => setNewSourceUrl(e.target.value)}
              placeholder="https://github.com/..."
              className="ce-input font-mono"
            />
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-[var(--ink-secondary)]">
              Notes
            </label>
            <textarea
              rows={3}
              value={newDescription}
              onChange={(e) => setNewDescription(e.target.value)}
              placeholder="Context or acceptance criteria…"
              className="ce-input"
            />
          </div>
        </form>
      </ModalDialog>
    </div>
  );
}
