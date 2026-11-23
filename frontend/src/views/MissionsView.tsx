import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  ArrowRight,
  Bot,
  ChevronDown,
  ChevronRight,
  Clock,
  Pause,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Square,
  Terminal,
  Users,
  X,
} from "lucide-react";
import { api } from "../lib/api";
import {
  formatDurationMs,
  formatRelativeTime,
} from "../lib/format";
import { useListKeyboardNav } from "../lib/useListKeyboardNav";
import type {
  MissionItem,
  MissionSpecialist,
  MissionStep,
  WorkspaceId,
} from "../types/api";
import {
  EmptyState,
  ErrorBanner,
  SkeletonRows,
  StatusBadge,
} from "../components/Badges";
import { MarkdownRenderer } from "../components/MarkdownRenderer";
import { DrawerPanel } from "../components/Overlays";
import { useToast } from "../components/ToastContext";
import { WorkspaceHeader } from "../components/WorkspaceHeader";

interface MissionsViewProps {
  refreshSignal: number;
  initialMissionId?: string | null;
  onNavigate: (ws: WorkspaceId) => void;
  onStateMutated: () => void;
  onJumpToApproval?: (approvalId: number) => void;
}

const STATUS_FILTERS = [
  { id: "all", label: "All" },
  { id: "running", label: "Running" },
  { id: "awaiting_approval", label: "Awaiting Approval" },
  { id: "paused", label: "Paused" },
  { id: "completed", label: "Completed" },
] as const;

interface StarterCard {
  id: string;
  label: string;
  description: string;
  title: string;
  domain: string;
  instruction: string;
}

const STARTER_CARDS: StarterCard[] = [
  {
    id: "obligations-sweep",
    label: "Sweep Cross-Channel Obligations",
    description: "Reconcile Slack DMs, unread email, and Drive comments.",
    title: "Cross-channel obligations sweep",
    domain: "executive",
    instruction:
      "Sweep connected Slack, email, and document channels; organize action items into Needed From Me and Waiting On Others without sending external messages.",
  },
  {
    id: "pr-review-worktree",
    label: "Audit Open Pull Requests",
    description: "Summarize requested review changes, CI status, and follow-up plans.",
    title: "Audit open pull requests",
    domain: "engineering",
    instruction:
      "Inspect open pull requests across configured repositories, summarize requested review changes and CI status, and draft follow-up plans.",
  },
  {
    id: "pre-call-brief",
    label: "Prepare Next Meeting Brief",
    description: "Compile recent transcripts, threads, and open decisions.",
    title: "Pre-call intelligence brief",
    domain: "meetings",
    instruction:
      "Compile context for upcoming calls from recent transcripts, Gmail threads, Slack discussions, and open Work obligations; highlight decisions needed and unresolved action items.",
  },
  {
    id: "infra-health-check",
    label: "Check Cloud Health",
    description: "Read-only inspection of configured clusters and service logs.",
    title: "Read-only cloud health check",
    domain: "infrastructure",
    instruction:
      "Run read-only infrastructure and service log checks across configured clusters; summarize pod restarts, warnings, and anomalies.",
  },
];

const SPECIALIST_LABELS: Record<string, string> = {
  chief_of_staff: "Lead Orchestrator",
  lead_orchestrator: "Lead Orchestrator",
  engineering_scout: "Engineering Scout",
  comms_scout: "Communications Scout",
  communications_scout: "Communications Scout",
  inbox_scout: "Inbox Scout",
  schedule_scout: "Inbox & Schedule Scout",
  drive_scout: "Drive & Transcript Analyst",
  drive_analyst: "Drive & Transcript Analyst",
  transcript_analyst: "Drive & Transcript Analyst",
  meeting_analyst: "Meeting Analyst",
  sre_scout: "Cloud Observer",
  cloud_observer: "Cloud Observer",
  infra_scout: "Cloud Observer",
  local_archivist: "Workspace Archivist",
  workspace_archivist: "Workspace Archivist",
  knowledge_curator: "Knowledge Curator",
  approval_gate: "Approval Gate",
  system: "System",
  user: "Principal",
};

function humanizeToken(raw?: string | null, fallback = "—"): string {
  if (!raw || !raw.trim()) return fallback;
  return raw
    .trim()
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatSpecialistName(
  specialistId: string | undefined | null,
  specialists?: MissionSpecialist[]
): string {
  if (!specialistId || !specialistId.trim()) return "Lead Orchestrator";
  const key = specialistId.trim().toLowerCase();
  const registered = specialists?.find((s) => s.id.toLowerCase() === key);
  if (registered?.name) return registered.name;
  if (SPECIALIST_LABELS[key]) return SPECIALIST_LABELS[key];
  return humanizeToken(specialistId, "Specialist");
}

function formatStatusLabel(status?: string | null): string {
  if (!status) return "Unknown";
  const normalized = status.trim().toLowerCase();
  const map: Record<string, string> = {
    all: "All",
    queued: "Queued",
    running: "Running",
    in_progress: "Running",
    awaiting_approval: "Awaiting Approval",
    waiting_approval: "Awaiting Approval",
    paused: "Paused",
    completed: "Completed",
    done: "Completed",
    succeeded: "Completed",
    passed: "Passed",
    ready: "Ready",
    pending: "Pending",
    cancelled: "Cancelled",
    failed: "Failed",
    error: "Error",
  };
  return map[normalized] ?? humanizeToken(status);
}

function formatDomainLabel(domain?: string | null): string {
  if (!domain) return "Auto";
  const normalized = domain.trim().toLowerCase();
  const map: Record<string, string> = {
    auto: "Auto",
    executive: "Executive",
    engineering: "Engineering",
    communications: "Communications",
    meetings: "Meetings",
    knowledge: "Knowledge",
    infrastructure: "Infrastructure",
  };
  return map[normalized] ?? humanizeToken(domain);
}

function formatScopeLabel(scope?: string | null): string {
  if (!scope) return "Standard";
  const normalized = scope.trim().toLowerCase();
  const map: Record<string, string> = {
    read_only: "Read-Only",
    read_only_locked: "Read-Only",
    staged_write: "Staged Write",
    worktree_only: "Isolated Worktree",
    ask_first: "Approval Gated",
    self_dm: "Self-DM Only",
  };
  return map[normalized] ?? humanizeToken(scope);
}

function getStepDurationMs(step: MissionStep): number | null {
  const extra = step as MissionStep & {
    duration_ms?: number | null;
    elapsed_ms?: number | null;
  };
  if (
    typeof extra.duration_ms === "number" &&
    Number.isFinite(extra.duration_ms) &&
    extra.duration_ms >= 0
  ) {
    return extra.duration_ms;
  }
  if (
    typeof extra.elapsed_ms === "number" &&
    Number.isFinite(extra.elapsed_ms) &&
    extra.elapsed_ms >= 0
  ) {
    return extra.elapsed_ms;
  }
  if (!step.started_at) return null;
  const startMs = new Date(step.started_at).getTime();
  if (Number.isNaN(startMs)) return null;
  if (step.finished_at) {
    const endMs = new Date(step.finished_at).getTime();
    if (!Number.isNaN(endMs) && endMs >= startMs) {
      return endMs - startMs;
    }
  }
  const s = (step.status || "").toLowerCase();
  if (s === "running" || s === "in_progress") {
    return Math.max(0, Date.now() - startMs);
  }
  return null;
}

function getStepDotClass(status: string): string {
  const s = (status || "").toLowerCase();
  if (["completed", "done", "passed", "ready", "succeeded"].includes(s)) {
    return "border-[var(--sage-border)] bg-[var(--sage-soft)] text-[var(--sage)]";
  }
  if (["running", "in_progress"].includes(s)) {
    return "border-[var(--accent-border)] bg-[var(--accent-soft)] text-[var(--accent)]";
  }
  if (
    [
      "waiting_approval",
      "awaiting_approval",
      "pending",
      "paused",
      "queued",
    ].includes(s)
  ) {
    return "border-[var(--amber-border)] bg-[var(--amber-soft)] text-[var(--amber)]";
  }
  if (["failed", "error", "cancelled"].includes(s)) {
    return "border-[var(--coral-border)] bg-[var(--coral-soft)] text-[var(--coral)]";
  }
  return "border-[var(--line-strong)] bg-[var(--surface)] text-[var(--muted)]";
}

function extractMissionApprovalIds(
  mission: MissionItem,
  scopedSteps: MissionStep[]
): number[] {
  const seen = new Set<number>();
  for (const step of scopedSteps) {
    if (step.approval_id !== null && step.approval_id !== undefined) {
      const id = Number(step.approval_id);
      if (Number.isFinite(id) && id > 0) seen.add(id);
    }
  }
  for (const artifact of mission.artifacts ?? []) {
    if ((artifact.kind || "").toLowerCase().includes("approval")) {
      const id = Number(artifact.id);
      if (Number.isFinite(id) && id > 0) seen.add(id);
    }
  }
  return Array.from(seen);
}

export function MissionsView({
  refreshSignal,
  initialMissionId = null,
  onNavigate,
  onStateMutated,
  onJumpToApproval,
}: MissionsViewProps) {
  const { pushToast } = useToast();

  const [missions, setMissions] = useState<MissionItem[]>([]);
  const [specialists, setSpecialists] = useState<MissionSpecialist[]>([]);
  const [systemPaused, setSystemPaused] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);

  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(
    initialMissionId ?? null
  );
  const [rosterOpen, setRosterOpen] = useState(false);
  const [openLogByStep, setOpenLogByStep] = useState<Record<string, boolean>>({});

  // Composer state
  const [instruction, setInstruction] = useState("");
  const [missionTitle, setMissionTitle] = useState("");
  const [domain, setDomain] = useState<string>("auto");
  const [dryRun, setDryRun] = useState(true);
  const [dispatching, setDispatching] = useState(false);
  const [dryRunPreview, setDryRunPreview] = useState<MissionItem | null>(null);

  // Action busy states
  const [togglingGlobalPause, setTogglingGlobalPause] = useState(false);
  const [controllingAction, setControllingAction] = useState<string | null>(null);

  // Refs
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const launchpadTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const inlineInputRef = useRef<HTMLInputElement | null>(null);
  const hasLoadedOnceRef = useRef(false);
  const missionsCountRef = useRef(0);
  const selectedIdRef = useRef<string | null>(initialMissionId ?? null);
  const fetchedDetailIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    missionsCountRef.current = missions.length;
  }, [missions.length]);

  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  useEffect(() => {
    if (initialMissionId) {
      setSelectedId(initialMissionId);
      setStatusFilter("all");
      setSearchQuery("");
    }
  }, [initialMissionId]);

  const mergeIncomingMissions = useCallback((incomingList: MissionItem[]) => {
    setMissions((prev) => {
      const prevById = new Map(prev.map((m) => [m.id, m]));
      return incomingList.map((incoming) => {
        const existing = prevById.get(incoming.id);
        if (!existing) return incoming;
        const mergedSteps =
          incoming.steps && incoming.steps.length > 0
            ? incoming.steps
            : existing.steps ?? [];
        const mergedEvents =
          incoming.events && incoming.events.length > 0
            ? incoming.events
            : existing.events;
        return {
          ...incoming,
          steps: mergedSteps,
          events: mergedEvents,
        };
      });
    });
  }, []);

  const loadMissions = useCallback(
    async (silent = false) => {
      const isInitialEmpty =
        !hasLoadedOnceRef.current && missionsCountRef.current === 0;
      if (!silent && isInitialEmpty) {
        setLoading(true);
        setLoadError(null);
      } else if (!silent) {
        setRefreshing(true);
      }

      try {
        const res = await api.getMissions();
        hasLoadedOnceRef.current = true;
        mergeIncomingMissions(res.items);
        setSpecialists(res.specialists);
        setSystemPaused(res.system_paused);
        setLoadError(null);

        setSelectedId((prev) => {
          if (
            initialMissionId &&
            res.items.some((m) => m.id === initialMissionId)
          ) {
            return initialMissionId;
          }
          if (prev && res.items.some((m) => m.id === prev)) return prev;
          return res.items[0]?.id ?? null;
        });

        const currentSelectedId = selectedIdRef.current;
        if (
          currentSelectedId &&
          res.items.some((m) => m.id === currentSelectedId)
        ) {
          api
            .getMissionDetail(currentSelectedId)
            .then((detailRes) => {
              if (!detailRes.mission) return;
              if (selectedIdRef.current !== detailRes.mission.id) return;
              fetchedDetailIdsRef.current.add(detailRes.mission.id);
              setMissions((prev) =>
                prev.map((m) =>
                  m.id === detailRes.mission.id ? detailRes.mission : m
                )
              );
            })
            .catch(() => {
              // Ignore silent poll errors
            });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (missionsCountRef.current === 0) {
          setLoadError(msg);
        }
        if (!silent) {
          pushToast("error", "Failed to load missions", msg);
        }
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [initialMissionId, mergeIncomingMissions, pushToast]
  );

  useEffect(() => {
    const silent = hasLoadedOnceRef.current;
    void loadMissions(silent);
  }, [loadMissions, refreshSignal]);

  const filteredMissions = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return missions.filter((m) => {
      if (
        missions.length > 4 &&
        statusFilter !== "all" &&
        (m.status || "").toLowerCase() !== statusFilter
      ) {
        return false;
      }
      if (!q || missions.length <= 4) return true;
      return (
        m.title.toLowerCase().includes(q) ||
        m.domain.toLowerCase().includes(q) ||
        m.instruction.toLowerCase().includes(q)
      );
    });
  }, [missions, searchQuery, statusFilter]);

  const selectedMission = useMemo(() => {
    if (!selectedId) return filteredMissions[0] ?? null;
    return (
      missions.find((m) => m.id === selectedId) ??
      filteredMissions[0] ??
      null
    );
  }, [missions, filteredMissions, selectedId]);

  const selectedMissionId = selectedMission?.id ?? null;

  useEffect(() => {
    if (!selectedMissionId) {
      setLoadingDetail(false);
      return;
    }
    const target = missions.find((m) => m.id === selectedMissionId);
    if (target?.steps && target.steps.length > 0) {
      setLoadingDetail(false);
      return;
    }
    if (fetchedDetailIdsRef.current.has(selectedMissionId)) {
      setLoadingDetail(false);
      return;
    }
    fetchedDetailIdsRef.current.add(selectedMissionId);
    let cancelled = false;
    setLoadingDetail(true);
    api
      .getMissionDetail(selectedMissionId)
      .then((res) => {
        if (cancelled || !res.mission) return;
        if (selectedIdRef.current && selectedIdRef.current !== res.mission.id) {
          return;
        }
        setMissions((prev) =>
          prev.map((m) => (m.id === res.mission.id ? res.mission : m))
        );
      })
      .catch(() => {
        // Mission may have 0 recorded steps
      })
      .finally(() => {
        if (!cancelled) setLoadingDetail(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedMissionId, missions]);

  useEffect(() => {
    setOpenLogByStep({});
  }, [selectedMissionId]);

  useListKeyboardNav({
    items: filteredMissions,
    getId: (m) => m.id,
    selectedId: selectedMissionId,
    onSelect: (id: string) => setSelectedId(id),
    onEscape: () => {
      if (searchQuery) setSearchQuery("");
    },
    searchInputRef,
    enabled: missions.length > 0 && !rosterOpen,
  });

  const scopedSteps = useMemo(() => {
    if (!selectedMission) return [];
    return (selectedMission.steps ?? []).filter(
      (step) => !step.mission_id || step.mission_id === selectedMission.id
    );
  }, [selectedMission]);

  const scopedApprovalIds = useMemo(() => {
    if (!selectedMission) return [];
    return extractMissionApprovalIds(selectedMission, scopedSteps);
  }, [selectedMission, scopedSteps]);

  const handleJumpToApproval = useCallback(
    (approvalId?: number | null) => {
      if (
        approvalId !== null &&
        approvalId !== undefined &&
        Number.isFinite(Number(approvalId)) &&
        onJumpToApproval
      ) {
        onJumpToApproval(Number(approvalId));
        return;
      }
      onNavigate("Approvals");
    },
    [onJumpToApproval, onNavigate]
  );

  const handleToggleGlobalPause = async () => {
    if (togglingGlobalPause) return;
    setTogglingGlobalPause(true);
    try {
      const res = await api.setSystemPaused(!systemPaused);
      setSystemPaused(res.paused);
      pushToast(
        "info",
        res.paused ? "All agents paused" : "Agents resumed",
        res.paused
          ? `Halted ${res.halted_missions} active mission(s).`
          : "Mission orchestration active."
      );
      await loadMissions(true);
      onStateMutated();
    } catch (err) {
      pushToast(
        "error",
        "Failed to toggle pause",
        err instanceof Error ? err.message : String(err)
      );
    } finally {
      setTogglingGlobalPause(false);
    }
  };

  const handleControlMission = async (
    mission: MissionItem,
    action: "pause" | "resume" | "cancel" | "retry"
  ) => {
    if (controllingAction) return;
    setControllingAction(action);
    try {
      const res = await api.controlMission(mission.id, action);
      setMissions((prev) =>
        prev.map((m) => (m.id === mission.id ? res.mission : m))
      );
      pushToast(
        "success",
        `Mission ${action}d`,
        `${res.mission.title} · ${formatStatusLabel(res.mission.status)}`
      );
      await loadMissions(true);
      onStateMutated();
    } catch (err) {
      pushToast(
        "error",
        `Could not ${action} mission`,
        err instanceof Error ? err.message : String(err)
      );
    } finally {
      setControllingAction(null);
    }
  };

  const handleDispatch = async (
    e: React.FormEvent,
    overrideDryRun?: boolean
  ) => {
    e.preventDefault();
    const trimmed = instruction.trim();
    if (!trimmed || dispatching) return;

    const useDryRun =
      typeof overrideDryRun === "boolean" ? overrideDryRun : dryRun;
    setDispatching(true);
    try {
      const res = await api.dispatchMission({
        instruction: trimmed,
        title: missionTitle.trim() || undefined,
        domain: domain === "auto" ? null : domain,
        dry_run: useDryRun,
        stage_outbound_if_needed: !useDryRun,
      });

      if (useDryRun) {
        setDryRunPreview(res.mission);
        pushToast(
          "info",
          "Dry-run plan ready",
          `${
            res.mission.steps?.length || res.mission.plan?.length || 0
          } planned steps`
        );
      } else {
        setMissions((prev) => [
          res.mission,
          ...prev.filter((m) => m.id !== res.mission.id),
        ]);
        setSelectedId(res.mission.id);
        setStatusFilter("all");
        setInstruction("");
        setMissionTitle("");
        setDomain("auto");
        setDryRunPreview(null);
        pushToast("success", "Mission dispatched", res.mission.title);
        await loadMissions(true);
        onStateMutated();
      }
    } catch (err) {
      pushToast(
        "error",
        useDryRun ? "Dry-run failed" : "Mission dispatch failed",
        err instanceof Error ? err.message : String(err)
      );
    } finally {
      setDispatching(false);
    }
  };

  const handleStarterClick = (card: StarterCard) => {
    setMissionTitle(card.title);
    setDomain(card.domain);
    setInstruction(card.instruction);
    setDryRunPreview(null);
    launchpadTextareaRef.current?.focus();
  };

  const focusComposer = () => {
    if (missions.length === 0) {
      launchpadTextareaRef.current?.focus();
    } else {
      inlineInputRef.current?.focus();
    }
  };

  return (
    <div className="mx-auto w-full max-w-[1140px] space-y-5 px-6 pt-2 pb-8">
      <WorkspaceHeader
        title="Missions"
        actions={
          <div className="flex items-center gap-2">
            {missions.length > 0 && (
              <>
                <button
                  type="button"
                  onClick={focusComposer}
                  className="ce-btn ce-btn-primary h-8 px-3 text-xs"
                >
                  <Plus className="h-3.5 w-3.5" />
                  <span>New Mission</span>
                </button>
                <button
                  type="button"
                  onClick={() => void loadMissions(false)}
                  disabled={loading || refreshing}
                  className="ce-btn ce-btn-ghost h-8 px-2.5 text-xs"
                  aria-label="Refresh missions"
                >
                  <RefreshCw
                    className={`h-3.5 w-3.5 ${
                      loading || refreshing ? "animate-spin" : ""
                    }`}
                  />
                </button>
              </>
            )}

            <button
              type="button"
              onClick={() => setRosterOpen(true)}
              className="ce-btn ce-btn-ghost h-8 px-3 text-xs"
            >
              <Users className="h-3.5 w-3.5" />
              <span>Specialists</span>
            </button>
          </div>
        }
      />

      {loadError && (
        <ErrorBanner
          title="Unable to load missions"
          message={loadError}
          onRetry={() => void loadMissions(false)}
        />
      )}

      {loading && missions.length === 0 ? (
        <div className="mx-auto mt-10 max-w-2xl">
          <SkeletonRows rows={4} />
        </div>
      ) : missions.length === 0 ? (
        /* CASE A: Orbit-Style Serene Launchpad */
        <div className="mx-auto mt-8 max-w-2xl space-y-6">
          <div className="space-y-2 text-center">
            <h2 className="font-editorial text-center text-3xl text-[var(--ink)]">
              What should your specialists handle?
            </h2>
            <p className="text-sm text-[var(--muted)]">
              Delegate multi-step research, inbox sweeps, or isolated repo prep.
              Outbound actions stay gated.
            </p>
          </div>

          <form
            onSubmit={(e) => void handleDispatch(e)}
            className="ce-card space-y-3 p-3"
          >
            <textarea
              ref={launchpadTextareaRef}
              rows={2}
              value={instruction}
              onChange={(e) => {
                setInstruction(e.target.value);
                if (dryRunPreview) setDryRunPreview(null);
              }}
              placeholder="Describe what you want researched, prepared, or verified…"
              className="w-full resize-none bg-transparent px-2 pt-1 text-sm text-[var(--ink)] placeholder:text-[var(--subtle)] focus:outline-none"
            />

            <div className="flex items-center justify-between gap-2 border-t border-[var(--line)] pt-2.5">
              <button
                type="button"
                role="switch"
                aria-checked={dryRun}
                onClick={() => setDryRun((v) => !v)}
                className={`inline-flex cursor-pointer items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition ${
                  dryRun
                    ? "border-[var(--sage-border)] bg-[var(--sage-soft)]/50 text-[var(--sage)]"
                    : "border-[var(--line-strong)] bg-[var(--surface-sunken)] text-[var(--muted)] hover:text-[var(--ink)]"
                }`}
                title={
                  dryRun
                    ? "Dry-Run previews the execution plan without running tools"
                    : "Live execution will run tools and stage gated approvals"
                }
              >
                <ShieldCheck className="h-3.5 w-3.5" />
                <span>Dry-Run</span>
              </button>

              <button
                type="submit"
                disabled={!instruction.trim() || dispatching}
                className="ce-btn ce-btn-primary h-8 px-4 text-xs"
              >
                <Sparkles className="h-3.5 w-3.5" />
                <span>
                  {dispatching
                    ? dryRun
                      ? "Planning…"
                      : "Dispatching…"
                    : "Dispatch Mission"}
                </span>
              </button>
            </div>
          </form>

          {dryRunPreview && (
            <div className="ce-card space-y-3 p-4">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-[var(--accent)]">
                  Dry-Run Plan · {dryRunPreview.title}
                </span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={dispatching}
                    onClick={(e) => void handleDispatch(e, false)}
                    className="ce-btn ce-btn-primary h-7 px-3 text-xs"
                  >
                    <Play className="h-3 w-3" />
                    <span>Execute Live</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setDryRunPreview(null)}
                    aria-label="Dismiss preview"
                    className="ce-btn ce-btn-ghost h-7 w-7 p-0"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>

              {(dryRunPreview.plan?.length || dryRunPreview.steps?.length) ? (
                <div className="divide-y divide-[var(--line)] border-t border-[var(--line)]">
                  {(dryRunPreview.plan && dryRunPreview.plan.length > 0
                    ? dryRunPreview.plan
                    : dryRunPreview.steps
                  ).map((item, idx) => (
                    <div
                      key={`${item.seq}-${idx}`}
                      className="flex items-center justify-between gap-3 py-2 text-xs"
                    >
                      <span className="truncate text-[var(--ink)]">
                        {String(item.seq).padStart(2, "0")}. {item.title}
                      </span>
                      <span className="shrink-0 text-[var(--muted)]">
                        {formatSpecialistName(item.specialist_id, specialists)}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-[var(--muted)]">
                  Plan verified cleanly. Click Execute Live to run.
                </p>
              )}
            </div>
          )}

          {/* Clean 2x2 Grid of Quiet Starter Cards */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {STARTER_CARDS.map((card) => (
              <button
                key={card.id}
                type="button"
                onClick={() => handleStarterClick(card)}
                className="ce-card group flex cursor-pointer flex-col gap-1 p-4 text-left transition-colors hover:border-[var(--line-strong)] hover:bg-[var(--surface-raised)]/60"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[13.5px] font-medium text-[var(--ink)]">
                    {card.label}
                  </span>
                  <ArrowRight className="h-3.5 w-3.5 shrink-0 text-[var(--muted)] transition-transform group-hover:translate-x-0.5 group-hover:text-[var(--ink)]" />
                </div>
                <span className="text-xs text-[var(--muted)]">
                  {card.description}
                </span>
              </button>
            ))}
          </div>
        </div>
      ) : (
        /* CASE B: Clean Split Timeline */
        <div className="space-y-4">
          {/* Compact Top 1-Line Inline Dispatch Bar */}
          <form
            onSubmit={(e) => void handleDispatch(e)}
            className="ce-card flex flex-wrap items-center gap-2 p-2.5 sm:flex-nowrap"
          >
            <input
              ref={inlineInputRef}
              type="text"
              value={instruction}
              onChange={(e) => {
                setInstruction(e.target.value);
                if (dryRunPreview) setDryRunPreview(null);
              }}
              placeholder="Dispatch a new mission…"
              className="h-8 min-w-0 flex-1 bg-transparent px-2 text-xs text-[var(--ink)] placeholder:text-[var(--subtle)] focus:outline-none"
            />

            <button
              type="button"
              role="switch"
              aria-checked={dryRun}
              onClick={() => setDryRun((v) => !v)}
              className={`inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-full border px-2.5 text-[11px] font-medium transition ${
                dryRun
                  ? "border-[var(--sage-border)] bg-[var(--sage-soft)]/50 text-[var(--sage)]"
                  : "border-[var(--line-strong)] text-[var(--muted)] hover:text-[var(--ink)]"
              }`}
            >
              <ShieldCheck className="h-3 w-3" />
              <span>Dry-Run</span>
            </button>

            <button
              type="submit"
              disabled={!instruction.trim() || dispatching}
              className="ce-btn ce-btn-primary h-8 px-3.5 text-xs"
            >
              <Sparkles className="h-3.5 w-3.5" />
              <span>
                {dispatching
                  ? dryRun
                    ? "Planning…"
                    : "Dispatching…"
                  : "Dispatch"}
              </span>
            </button>
          </form>

          {dryRunPreview && (
            <div className="ce-card space-y-2.5 p-4">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-[var(--accent)]">
                  Dry-Run Plan · {dryRunPreview.title}
                </span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={dispatching}
                    onClick={(e) => void handleDispatch(e, false)}
                    className="ce-btn ce-btn-primary h-7 px-3 text-xs"
                  >
                    <Play className="h-3 w-3" />
                    <span>Execute Live</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setDryRunPreview(null)}
                    aria-label="Dismiss preview"
                    className="ce-btn ce-btn-ghost h-7 w-7 p-0"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
              {(dryRunPreview.plan?.length || dryRunPreview.steps?.length) ? (
                <div className="divide-y divide-[var(--line)] border-t border-[var(--line)]">
                  {(dryRunPreview.plan && dryRunPreview.plan.length > 0
                    ? dryRunPreview.plan
                    : dryRunPreview.steps
                  ).map((item, idx) => (
                    <div
                      key={`${item.seq}-${idx}`}
                      className="flex items-center justify-between gap-3 py-1.5 text-xs"
                    >
                      <span className="truncate text-[var(--ink)]">
                        {String(item.seq).padStart(2, "0")}. {item.title}
                      </span>
                      <span className="shrink-0 text-[var(--muted)]">
                        {formatSpecialistName(item.specialist_id, specialists)}
                      </span>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          )}

          {/* Clean 2-Pane Split */}
          <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-12">
            {/* Left (4 cols): Mission List */}
            <aside className="space-y-3 lg:col-span-4">
              {missions.length > 4 && (
                <div className="space-y-2">
                  <div className="relative">
                    <Search className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-[var(--muted)]" />
                    <input
                      ref={searchInputRef}
                      type="text"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      placeholder="Filter missions…"
                      className="ce-input h-8 pr-7 pl-8 text-xs"
                    />
                    {searchQuery && (
                      <button
                        type="button"
                        onClick={() => setSearchQuery("")}
                        aria-label="Clear filter"
                        className="absolute top-1/2 right-2 -translate-y-1/2 text-[var(--muted)] hover:text-[var(--ink)]"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    )}
                  </div>

                  <div
                    className="flex flex-wrap items-center gap-1"
                    role="group"
                    aria-label="Filter missions by status"
                  >
                    {STATUS_FILTERS.map((f) => {
                      const active = statusFilter === f.id;
                      return (
                        <button
                          key={f.id}
                          type="button"
                          aria-pressed={active}
                          onClick={() => setStatusFilter(f.id)}
                          className={`cursor-pointer rounded-full px-2.5 py-0.5 text-[11px] font-medium transition ${
                            active
                              ? "bg-[var(--surface-raised)] text-[var(--ink)] ring-1 ring-[var(--line-strong)]"
                              : "text-[var(--muted)] hover:text-[var(--ink)]"
                          }`}
                        >
                          {f.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              <div className="ce-card divide-y divide-[var(--line)] overflow-hidden">
                {filteredMissions.length === 0 ? (
                  <div className="p-6 text-center text-xs text-[var(--muted)]">
                    No matching missions.
                  </div>
                ) : (
                  filteredMissions.map((m) => {
                    const isSelected = selectedMissionId === m.id;
                    return (
                      <button
                        key={m.id}
                        type="button"
                        onClick={() => setSelectedId(m.id)}
                        className={`flex w-full cursor-pointer flex-col gap-1.5 px-4 py-3 text-left transition-colors ${
                          isSelected
                            ? "bg-[var(--surface-raised)]"
                            : "hover:bg-[var(--surface-raised)]/50"
                        }`}
                      >
                        <p className="line-clamp-2 text-[13.5px] font-medium leading-snug text-[var(--ink)] break-words">
                          {m.title}
                        </p>
                        <div className="flex items-center justify-between gap-2">
                          <StatusBadge status={m.status} variant="quiet" />
                          <span className="font-mono text-[11px] tabular-nums text-[var(--muted)]">
                            {formatRelativeTime(m.updated_at || m.created_at)}
                          </span>
                        </div>
                      </button>
                    );
                  })
                )}
              </div>
            </aside>

            {/* Right (8 cols): Selected Mission Sheet */}
            <section className="ce-card min-w-0 p-6 lg:col-span-8">
              {!selectedMission ? (
                <EmptyState
                  icon={Activity}
                  title="Select a mission"
                  description="Choose a mission from the list to review its progress and timeline."
                />
              ) : (
                <div key={selectedMission.id} className="space-y-5">
                  {/* Header + Lifecycle Actions */}
                  <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[var(--line)] pb-4">
                    <div className="min-w-0 flex-1 space-y-1.5">
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        <StatusBadge
                          status={selectedMission.status}
                          variant="pill"
                        />
                        {selectedMission.elapsed_ms > 0 && (
                          <span className="inline-flex items-center gap-1 font-mono text-[11px] tabular-nums text-[var(--muted)]">
                            <Clock className="h-3 w-3" />
                            <span>
                              {formatDurationMs(selectedMission.elapsed_ms)}
                            </span>
                          </span>
                        )}
                        <span className="font-mono text-[11px] tabular-nums text-[var(--muted)]">
                          {formatRelativeTime(
                            selectedMission.updated_at ||
                              selectedMission.created_at
                          )}
                        </span>
                      </div>

                      <h2 className="font-editorial text-2xl font-normal leading-snug text-[var(--ink)] break-words">
                        {selectedMission.title}
                      </h2>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      {scopedApprovalIds.map((approvalId) => (
                        <button
                          key={`mission-approval-${approvalId}`}
                          type="button"
                          onClick={() => handleJumpToApproval(approvalId)}
                          className="ce-btn ce-btn-sage h-8 px-3 text-xs"
                        >
                          <ShieldAlert className="h-3.5 w-3.5" />
                          <span>Review Approval #{approvalId}</span>
                          <ArrowRight className="h-3 w-3" />
                        </button>
                      ))}

                      {scopedApprovalIds.length === 0 &&
                        selectedMission.status === "awaiting_approval" && (
                          <button
                            type="button"
                            onClick={() => onNavigate("Approvals")}
                            className="ce-btn ce-btn-sage h-8 px-3 text-xs"
                          >
                            <ShieldAlert className="h-3.5 w-3.5" />
                            <span>Review Approval</span>
                            <ArrowRight className="h-3 w-3" />
                          </button>
                        )}

                      {(selectedMission.status === "running" ||
                        selectedMission.status === "queued") && (
                        <button
                          type="button"
                          disabled={controllingAction !== null}
                          onClick={() =>
                            void handleControlMission(selectedMission, "pause")
                          }
                          className="ce-btn h-8 px-3 text-xs"
                        >
                          <Pause className="h-3.5 w-3.5" />
                          <span>Pause</span>
                        </button>
                      )}

                      {selectedMission.status === "paused" && (
                        <button
                          type="button"
                          disabled={controllingAction !== null || systemPaused}
                          onClick={() =>
                            void handleControlMission(selectedMission, "resume")
                          }
                          className="ce-btn ce-btn-primary h-8 px-3 text-xs"
                        >
                          <Play className="h-3.5 w-3.5" />
                          <span>Resume</span>
                        </button>
                      )}

                      {(selectedMission.status === "running" ||
                        selectedMission.status === "queued" ||
                        selectedMission.status === "paused" ||
                        selectedMission.status === "awaiting_approval") && (
                        <button
                          type="button"
                          disabled={controllingAction !== null}
                          onClick={() =>
                            void handleControlMission(selectedMission, "cancel")
                          }
                          className="ce-btn ce-btn-ghost h-8 px-2.5 text-xs text-[var(--muted)] hover:text-[var(--coral)]"
                        >
                          <Square className="h-3 w-3" />
                          <span>Cancel</span>
                        </button>
                      )}

                      {(selectedMission.status === "failed" ||
                        selectedMission.status === "cancelled") && (
                        <button
                          type="button"
                          disabled={controllingAction !== null || systemPaused}
                          onClick={() =>
                            void handleControlMission(selectedMission, "retry")
                          }
                          className="ce-btn ce-btn-primary h-8 px-3 text-xs"
                        >
                          <RotateCcw className="h-3.5 w-3.5" />
                          <span>Retry</span>
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Synthesized Summary or Instruction */}
                  <div className="space-y-3">
                    {selectedMission.result_summary ? (
                      <>
                        <p className="text-xs leading-relaxed text-[var(--muted)]">
                          {selectedMission.instruction}
                        </p>
                        <div className="ce-prose-measure min-w-0 rounded-xl border border-[var(--line)] bg-[var(--surface-sunken)]/45 p-4 text-[13px] leading-relaxed text-[var(--ink-secondary)]">
                          <MarkdownRenderer
                            content={selectedMission.result_summary}
                          />
                        </div>
                      </>
                    ) : (
                      <p className="text-[13px] leading-relaxed text-[var(--ink-secondary)]">
                        {selectedMission.instruction}
                      </p>
                    )}
                  </div>

                  {/* Sleek Vertical Step Timeline */}
                  <div className="space-y-3 border-t border-[var(--line)] pt-4">
                    <h3 className="text-xs font-medium text-[var(--muted)]">
                      Timeline
                    </h3>

                    {loadingDetail && scopedSteps.length === 0 ? (
                      <SkeletonRows rows={3} />
                    ) : scopedSteps.length === 0 ? (
                      <p className="text-xs text-[var(--muted)]">
                        No steps recorded yet.
                      </p>
                    ) : (
                      <ol className="relative space-y-4 before:absolute before:top-2.5 before:bottom-2.5 before:left-[11px] before:w-px before:bg-[var(--line)]">
                        {scopedSteps.map((step) => {
                          const hasLog = Boolean(step.redacted_log?.trim());
                          const logOpen = openLogByStep[step.id] ?? false;
                          const stepDuration = getStepDurationMs(step);
                          const stepApprovalId =
                            step.approval_id !== null &&
                            step.approval_id !== undefined &&
                            Number.isFinite(Number(step.approval_id))
                              ? Number(step.approval_id)
                              : null;

                          return (
                            <li
                              key={step.id}
                              className="relative min-w-0 pl-8"
                            >
                              <span
                                className={`absolute top-0.5 left-0 flex h-6 w-6 items-center justify-center rounded-full border font-mono text-[10px] font-medium tabular-nums ${getStepDotClass(
                                  step.status
                                )}`}
                              >
                                {String(step.seq).padStart(2, "0")}
                              </span>

                              <div className="space-y-1">
                                <div className="flex flex-wrap items-center justify-between gap-2">
                                  <span className="text-[13px] font-medium text-[var(--ink)]">
                                    {step.title}
                                  </span>
                                  <div className="flex items-center gap-2.5 text-[11px] text-[var(--muted)]">
                                    <span>
                                      {formatSpecialistName(
                                        step.specialist_id,
                                        specialists
                                      )}
                                    </span>
                                    {stepDuration !== null && (
                                      <span className="font-mono tabular-nums">
                                        {formatDurationMs(stepDuration)}
                                      </span>
                                    )}
                                  </div>
                                </div>

                                {step.output_summary && (
                                  <p className="text-xs leading-relaxed text-[var(--ink-secondary)]">
                                    {step.output_summary}
                                  </p>
                                )}

                                {stepApprovalId !== null && (
                                  <div className="pt-1">
                                    <button
                                      type="button"
                                      onClick={() =>
                                        handleJumpToApproval(stepApprovalId)
                                      }
                                      className="inline-flex items-center gap-1 rounded-full border border-[var(--sage-border)] bg-[var(--sage-soft)]/45 px-2.5 py-0.5 text-[11px] font-medium text-[var(--sage)] transition hover:bg-[var(--sage-soft)]"
                                    >
                                      <ShieldAlert className="h-3 w-3" />
                                      <span>
                                        Review Approval #{stepApprovalId}
                                      </span>
                                    </button>
                                  </div>
                                )}

                                {hasLog && (
                                  <div className="pt-0.5">
                                    <button
                                      type="button"
                                      onClick={() =>
                                        setOpenLogByStep((prev) => ({
                                          ...prev,
                                          [step.id]: !logOpen,
                                        }))
                                      }
                                      className="inline-flex cursor-pointer items-center gap-1 font-mono text-[11px] text-[var(--muted)] transition hover:text-[var(--ink)]"
                                    >
                                      {logOpen ? (
                                        <ChevronDown className="h-3 w-3" />
                                      ) : (
                                        <ChevronRight className="h-3 w-3" />
                                      )}
                                      <Terminal className="h-3 w-3" />
                                      <span>{logOpen ? "Hide log" : "View log"}</span>
                                    </button>
                                    {logOpen && (
                                      <pre className="mt-2 max-h-44 overflow-auto rounded-lg border border-[var(--line)] bg-[var(--surface-sunken)] p-3 font-mono text-[11px] leading-relaxed text-[var(--ink-secondary)]">
                                        {step.redacted_log}
                                      </pre>
                                    )}
                                  </div>
                                )}
                              </div>
                            </li>
                          );
                        })}
                      </ol>
                    )}
                  </div>
                </div>
              )}
            </section>
          </div>
        </div>
      )}

      {/* Specialist Roster Drawer */}
      <DrawerPanel
        open={rosterOpen}
        onClose={() => setRosterOpen(false)}
        title="Specialists"
        subtitle={`${specialists.length} configured agent${
          specialists.length === 1 ? "" : "s"
        }`}
        widthClass="max-w-md"
        footer={
          <div className="flex w-full items-center justify-between">
            <span className="text-xs text-[var(--muted)]">
              {systemPaused ? "All agents paused" : "Orchestration active"}
            </span>
            <button
              type="button"
              disabled={togglingGlobalPause}
              onClick={() => void handleToggleGlobalPause()}
              className={`ce-btn h-8 px-3 text-xs ${
                systemPaused ? "ce-btn-primary" : "ce-btn-danger"
              }`}
            >
              {systemPaused ? (
                <>
                  <Play className="h-3.5 w-3.5" />
                  <span>Resume Agents</span>
                </>
              ) : (
                <>
                  <Pause className="h-3.5 w-3.5" />
                  <span>Pause All</span>
                </>
              )}
            </button>
          </div>
        }
      >
        {specialists.length === 0 ? (
          <EmptyState
            icon={Users}
            title="No specialists registered"
            description="No domain specialists are currently configured for this profile."
          />
        ) : (
          <div className="divide-y divide-[var(--line)]">
            {specialists.map((sp) => (
              <div
                key={sp.id}
                className="space-y-1.5 py-3.5 first:pt-0 last:pb-0"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <Bot className="h-3.5 w-3.5 shrink-0 text-[var(--accent)]" />
                    <span className="truncate text-[13px] font-medium text-[var(--ink)]">
                      {sp.name || formatSpecialistName(sp.id, specialists)}
                    </span>
                  </div>
                  <span className="font-mono text-[11px] text-[var(--muted)]">
                    {sp.model_tier}
                  </span>
                </div>
                <p className="text-xs leading-relaxed text-[var(--ink-secondary)]">
                  {sp.role}
                </p>
                <div className="flex items-center justify-between text-[11px] text-[var(--muted)]">
                  <span>{formatDomainLabel(sp.department)}</span>
                  <span>{formatScopeLabel(sp.permission_scope)}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </DrawerPanel>
    </div>
  );
}
