import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowUpRight, Pause, Play, Sparkles, X } from "lucide-react";
import { LivingPrism } from "../components/LivingPrism";
import { OrchestratorBar } from "../components/OrchestratorBar";
import { PriorityBadge } from "../components/Badges";
import { useToast } from "../components/ToastContext";
import { api } from "../lib/api";
import type {
  ApprovalItem,
  OrbitDomainNode,
  OrbitPreviewItem,
  OrbitResponse,
  WorkspaceId,
} from "../types/api";

export interface OrbitJumpTarget {
  workspace: WorkspaceId;
  id?: string | number;
  query?: string;
}

interface OrbitViewProps {
  orbit: OrbitResponse | null;
  resolvedTheme: "dark" | "light";
  streamConnected: boolean;
  refreshSignal: number;
  transitioningOut?: boolean;
  onNavigate: (workspace: WorkspaceId) => void;
  onJumpToEntity?: (target: OrbitJumpTarget) => void;
  onJumpToApproval?: (approvalId: number) => void;
  onStateMutated: () => void;
}

const NUMBER_WORDS: Record<number, string> = {
  0: "zero",
  1: "one",
  2: "two",
  3: "three",
  4: "four",
  5: "five",
  6: "six",
  7: "seven",
  8: "eight",
  9: "nine",
  10: "ten",
  11: "eleven",
  12: "twelve",
};

function formatCountWord(n: number, capitalize = false): string {
  const w = NUMBER_WORDS[n] ?? String(n);
  if (!capitalize) return w;
  return w.charAt(0).toUpperCase() + w.slice(1);
}

function getTimeSalutation(displayName: string): string {
  const firstName = (displayName || "").trim().split(/\s+/)[0] || "";
  const hour = new Date().getHours();
  const greeting =
    hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  return firstName ? `${greeting}, ${firstName}` : greeting;
}

function formatStateLabel(state?: string | null): string {
  const s = (state || "quiet").trim().toLowerCase();
  const map: Record<string, string> = {
    quiet: "Quiet",
    attention: "Needs attention",
    running: "In flight",
    awaiting_approval: "Awaiting sign-off",
    blocked: "Blocked",
    degraded: "Degraded",
    paused: "Paused",
    offline: "Offline",
  };
  if (map[s]) return map[s];
  return s.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

const FLOATING_HORIZON_LINKS: Array<{
  ws: WorkspaceId;
  label: string;
  domainId: string;
}> = [
  { ws: "Approvals", label: "Approvals", domainId: "approvals" },
  { ws: "Work", label: "Work", domainId: "engineering" },
  { ws: "Missions", label: "Missions", domainId: "executive" },
  { ws: "Changes", label: "Changes", domainId: "communications" },
  { ws: "Meetings", label: "Meetings", domainId: "meetings" },
  { ws: "Memory", label: "Memory", domainId: "memory" },
  { ws: "Studio", label: "Studio", domainId: "studio" },
  { ws: "Engineering", label: "Engineering", domainId: "engineering" },
];

export function OrbitView({
  orbit: parentOrbit,
  resolvedTheme,
  streamConnected,
  refreshSignal,
  transitioningOut = false,
  onNavigate,
  onJumpToEntity,
  onJumpToApproval,
  onStateMutated,
}: OrbitViewProps) {
  const { pushToast } = useToast();
  const [localOrbit, setLocalOrbit] = useState<OrbitResponse | null>(parentOrbit);
  const [approvalsList, setApprovalsList] = useState<ApprovalItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [externalHighlightId, setExternalHighlightId] = useState<string | null>(null);
  const [commandOpen, setCommandOpen] = useState(false);

  useEffect(() => {
    if (parentOrbit) {
      setLocalOrbit(parentOrbit);
    }
  }, [parentOrbit]);

  // Clear hover highlight whenever a node inspector is open to prevent tooltip/inspector collision
  useEffect(() => {
    if (selectedId) {
      setExternalHighlightId(null);
    }
  }, [selectedId]);

  const refreshOrbitExtras = useCallback(async () => {
    try {
      const orb = parentOrbit ?? (await api.getOrbit());
      setLocalOrbit(orb);
      if (Array.isArray(orb.pending_approvals) && orb.pending_approvals.length > 0) {
        setApprovalsList(orb.pending_approvals);
      } else {
        const res = await api
          .getApprovals("pending")
          .catch(() => ({ items: [] as ApprovalItem[] }));
        setApprovalsList(Array.isArray(res.items) ? res.items : []);
      }
    } catch {
      // Keep calm existing state if offline
    }
  }, [parentOrbit]);

  useEffect(() => {
    void refreshOrbitExtras();
  }, [refreshOrbitExtras, refreshSignal]);

  // Close spatial inspector on Escape (only when command bar is closed)
  useEffect(() => {
    if (!selectedId || commandOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setSelectedId(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedId, commandOpen]);

  const orbit = parentOrbit ?? localOrbit;
  const core = orbit?.prism_core;
  const profile = orbit?.profile;
  const domains = orbit?.domains ?? [];
  const strands = orbit?.strands ?? [];
  const schedule = orbit?.schedule ?? [];
  const focusNow = orbit?.priorities ?? [];

  const pendingApprovals = core?.pending_approvals ?? approvalsList.length;
  const runningMissions = core?.running_missions ?? 0;
  const neededFromMe = core?.needed_from_me ?? 0;
  const waitingOnOthers = core?.waiting_on_others ?? 0;
  const systemPaused = Boolean(core?.system_paused);
  const healthStatus = core?.health_status ?? "online";
  const brandName = profile?.brand_display_name || "Command Engine";
  const autonomyPosture = (profile?.autonomy_posture || "prepare").replace(/_/g, " ");

  const headlineParts = useMemo((): { lead: string; accent: string } => {
    if (!orbit) {
      return { lead: "Aligning field.", accent: "Reading your operational orbit." };
    }
    if (systemPaused) {
      return { lead: "Execution paused.", accent: "Autonomous specialists on standby." };
    }
    if (pendingApprovals > 0 && runningMissions > 0) {
      return {
        lead: `${formatCountWord(runningMissions, true)} mission${
          runningMissions === 1 ? "" : "s"
        } in flight.`,
        accent: `${formatCountWord(pendingApprovals, true)} awaiting your sign-off.`,
      };
    }
    if (pendingApprovals > 0) {
      return {
        lead: `${formatCountWord(pendingApprovals, true)} gated action${
          pendingApprovals === 1 ? "" : "s"
        }`,
        accent: `${pendingApprovals === 1 ? "awaits" : "await"} your sign-off.`,
      };
    }
    if (runningMissions > 0) {
      return {
        lead: `${formatCountWord(runningMissions, true)} specialist mission${
          runningMissions === 1 ? "" : "s"
        }`,
        accent: "actively in flight.",
      };
    }
    if (neededFromMe > 0) {
      return {
        lead: `${formatCountWord(neededFromMe, true)} owned commitment${
          neededFromMe === 1 ? "" : "s"
        }`,
        accent: "in calm orbit.",
      };
    }
    return { lead: "Operational field", accent: "clear and synchronized." };
  }, [neededFromMe, orbit, pendingApprovals, runningMissions, systemPaused]);

  const selectedDomain: OrbitDomainNode | null = useMemo(() => {
    if (!selectedId || selectedId === "core") return null;
    return domains.find((d) => d.id === selectedId) ?? null;
  }, [domains, selectedId]);

  const handleActivateDomain = useCallback(
    (domain: OrbitDomainNode) => {
      onNavigate(domain.target_view);
    },
    [onNavigate]
  );

  const handleJumpItem = useCallback(
    (item: OrbitPreviewItem, fallbackView: WorkspaceId) => {
      const kind = (item.kind || "").toLowerCase();
      if (kind === "approval") {
        const numericId = Number(item.id);
        if (onJumpToApproval && !Number.isNaN(numericId)) {
          onJumpToApproval(numericId);
          return;
        }
        if (onJumpToEntity) {
          onJumpToEntity({ workspace: "Approvals", id: item.id });
          return;
        }
        onNavigate("Approvals");
        return;
      }
      if (kind === "task") {
        if (onJumpToEntity) {
          onJumpToEntity({ workspace: "Work", id: item.id });
          return;
        }
        onNavigate("Work");
        return;
      }
      if (kind === "meeting") {
        if (onJumpToEntity) {
          onJumpToEntity({ workspace: "Meetings", id: item.id });
          return;
        }
        onNavigate("Meetings");
        return;
      }
      if (kind === "mission") {
        if (onJumpToEntity) {
          onJumpToEntity({ workspace: "Missions", id: item.id });
          return;
        }
        onNavigate("Missions");
        return;
      }
      if (onJumpToEntity && item.id !== undefined && item.id !== null) {
        onJumpToEntity({ workspace: fallbackView, id: item.id });
        return;
      }
      onNavigate(fallbackView);
    },
    [onJumpToApproval, onJumpToEntity, onNavigate]
  );

  const handleHighlight = useCallback(
    (id: string | null) => {
      if (selectedId) {
        setExternalHighlightId(null);
        return;
      }
      setExternalHighlightId(id);
    },
    [selectedId]
  );

  const handleTogglePause = async () => {
    try {
      await api.setSystemPaused(!systemPaused);
      onStateMutated();
      pushToast(
        "info",
        !systemPaused ? "Autonomous execution paused" : "Autonomous execution resumed"
      );
    } catch (err) {
      pushToast(
        "error",
        "Could not update pause state",
        err instanceof Error ? err.message : String(err)
      );
    }
  };

  const nextMeeting = schedule[0];
  const textShadowStyle =
    resolvedTheme === "dark"
      ? { textShadow: "0 2px 18px rgba(4, 5, 10, 0.85)" }
      : { textShadow: "0 1px 14px rgba(243, 244, 247, 0.86)" };

  const activeHoverHighlight = selectedId ? null : externalHighlightId;

  return (
    <div className="relative h-full w-full overflow-hidden select-none">
      {/* 100vw × 100vh Real-Time Three.js WebGL Spatial Stage */}
      <div className="absolute inset-0">
        <LivingPrism
          coreState={core?.state || "quiet"}
          systemPaused={systemPaused}
          healthStatus={healthStatus}
          brandName={brandName}
          runningMissions={runningMissions}
          pendingApprovals={pendingApprovals}
          neededFromMe={neededFromMe}
          resolvedTheme={resolvedTheme}
          domains={domains}
          strands={strands}
          approvalsList={approvalsList}
          scheduleList={schedule}
          selectedId={selectedId}
          externalHighlightId={activeHoverHighlight}
          transitioningOut={transitioningOut}
          onSelect={setSelectedId}
          onActivateDomain={handleActivateDomain}
          onOpenApprovals={() => onNavigate("Approvals")}
        />
      </div>

      {/* Upper-Center Editorial Spatial Anchor (Two-voice sans + italic serif contrast) */}
      <div
        style={textShadowStyle}
        className="pointer-events-none absolute inset-x-0 top-[7.2%] z-20 flex flex-col items-center px-6 text-center"
      >
        {profile?.greeting_enabled !== false && profile?.display_name && (
          <p className="font-mono text-[10px] tracking-[0.26em] text-[var(--muted)] uppercase">
            {getTimeSalutation(profile.display_name)}
          </p>
        )}

        <h1 className="mt-2.5 max-w-3xl text-[clamp(2.05rem,3.35vw,3.05rem)] leading-[1.06] tracking-[-0.03em] text-[var(--ink)]">
          <span className="block font-semibold">{headlineParts.lead}</span>{" "}
          <span className="font-editorial mt-0.5 block font-normal text-[var(--ink-secondary)] italic">
            {headlineParts.accent}
          </span>
        </h1>

        {/* Live typographic whisper — zero borders, zero pills, zero card grids */}
        <div className="pointer-events-auto mt-3 flex flex-wrap items-center justify-center gap-x-3.5 gap-y-1 text-[12.5px] text-[var(--ink-secondary)]">
          <button
            type="button"
            onMouseEnter={() => handleHighlight("approvals")}
            onMouseLeave={() => handleHighlight(null)}
            onFocus={() => handleHighlight("approvals")}
            onBlur={() => handleHighlight(null)}
            onClick={() => onNavigate("Approvals")}
            className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 transition-opacity hover:text-[var(--ink)]"
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                pendingApprovals > 0 ? "bg-[var(--amber)]" : "bg-[var(--sage)]"
              }`}
            />
            <span className="font-mono text-[11.5px] tabular-nums">
              {pendingApprovals}
            </span>
            <span>
              {pendingApprovals === 1 ? "gated approval" : "gated approvals"}
            </span>
          </button>

          <span aria-hidden="true" className="text-[var(--subtle)]">
            ·
          </span>

          <button
            type="button"
            onMouseEnter={() => handleHighlight("engineering")}
            onMouseLeave={() => handleHighlight(null)}
            onFocus={() => handleHighlight("engineering")}
            onBlur={() => handleHighlight(null)}
            onClick={() => onNavigate("Work")}
            className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 transition-opacity hover:text-[var(--ink)]"
          >
            <span className="font-mono text-[11.5px] tabular-nums">
              {neededFromMe}
            </span>
            <span>owned obligations</span>
          </button>

          <span aria-hidden="true" className="text-[var(--subtle)]">
            ·
          </span>

          {runningMissions > 0 ? (
            <button
              type="button"
              onMouseEnter={() => handleHighlight("executive")}
              onMouseLeave={() => handleHighlight(null)}
              onFocus={() => handleHighlight("executive")}
              onBlur={() => handleHighlight(null)}
              onClick={() => onNavigate("Missions")}
              className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[var(--accent)] transition-opacity hover:opacity-85"
            >
              <span className="h-1.5 w-1.5 rounded-full bg-[var(--accent)]" />
              <span className="font-mono text-[11.5px] tabular-nums">
                {runningMissions}
              </span>
              <span>{runningMissions === 1 ? "active mission" : "active missions"}</span>
            </button>
          ) : nextMeeting ? (
            <button
              type="button"
              onMouseEnter={() => handleHighlight("meetings")}
              onMouseLeave={() => handleHighlight(null)}
              onFocus={() => handleHighlight("meetings")}
              onBlur={() => handleHighlight(null)}
              onClick={() =>
                onJumpToEntity
                  ? onJumpToEntity({ workspace: "Meetings", id: nextMeeting.id })
                  : onNavigate("Meetings")
              }
              className="inline-flex max-w-[260px] items-center gap-1.5 truncate rounded-md px-1.5 py-0.5 text-[var(--muted)] transition-colors hover:text-[var(--ink)]"
            >
              <span>next:</span>
              <span className="truncate text-[var(--ink-secondary)]">
                {nextMeeting.title}
              </span>
            </button>
          ) : (
            <button
              type="button"
              onMouseEnter={() => handleHighlight("infrastructure")}
              onMouseLeave={() => handleHighlight(null)}
              onFocus={() => handleHighlight("infrastructure")}
              onBlur={() => handleHighlight(null)}
              onClick={() => onNavigate("Missions")}
              className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[var(--muted)] transition-colors hover:text-[var(--ink)]"
            >
              <span
                className={`h-1.5 w-1.5 rounded-full ${
                  healthStatus === "offline"
                    ? "bg-[var(--amber)]"
                    : streamConnected
                    ? "bg-[var(--sage)]"
                    : "bg-[var(--accent)]"
                }`}
              />
              <span>
                {healthStatus === "offline" ? "offline local" : "live field"} ·{" "}
                {autonomyPosture}
              </span>
            </button>
          )}
        </div>
      </div>

      {/* Click-Revealed Spatial Inspector Capsule (Hidden at rest; appears when clicking a 3D node) */}
      {selectedId && (
        <aside
          aria-label="Selected orbital node inspector"
          className="ce-spatial-capsule ce-contain-scroll pointer-events-auto absolute top-1/2 right-7 z-30 max-h-[calc(100vh-11rem)] w-[336px] max-w-[calc(100vw-3rem)] -translate-y-1/2 overflow-y-auto rounded-2xl p-4"
        >
          {selectedId === "core" ? (
            <div className="space-y-3.5">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-mono text-[10px] tracking-[0.14em] text-[var(--muted)] uppercase">
                    Focus Capsule · {formatStateLabel(core?.state)}
                  </p>
                  <h2 className="font-editorial mt-0.5 text-xl text-[var(--ink)]">
                    {systemPaused ? "Execution Paused" : "Operational Pulse"}
                  </h2>
                </div>
                <button
                  type="button"
                  onClick={() => setSelectedId(null)}
                  className="ce-btn ce-btn-ghost h-7 w-7 shrink-0 p-0"
                  aria-label="Close inspector"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>

              <p className="border-t border-[var(--line)] pt-2.5 font-mono text-[11.5px] text-[var(--ink-secondary)] tabular-nums">
                {neededFromMe} owned · {pendingApprovals} gated · {waitingOnOthers} waiting on team
              </p>

              {focusNow.length > 0 && (
                <div className="divide-y divide-[var(--line)] border-y border-[var(--line)]">
                  {focusNow.slice(0, 3).map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() =>
                        onJumpToEntity
                          ? onJumpToEntity({ workspace: "Work", id: item.id })
                          : onNavigate("Work")
                      }
                      className="flex w-full items-center justify-between gap-2.5 py-2 text-left transition hover:opacity-85"
                    >
                      <span className="line-clamp-1 min-w-0 flex-1 text-xs text-[var(--ink)]">
                        {item.title}
                      </span>
                      <PriorityBadge priority={item.priority} />
                    </button>
                  ))}
                </div>
              )}

              <div className="flex items-center justify-between gap-2 pt-0.5">
                <button
                  type="button"
                  onClick={() => void handleTogglePause()}
                  className="ce-btn h-8 px-3 text-xs"
                >
                  {systemPaused ? (
                    <>
                      <Play className="h-3.5 w-3.5" />
                      <span>Resume Agents</span>
                    </>
                  ) : (
                    <>
                      <Pause className="h-3.5 w-3.5" />
                      <span>Pause Agents</span>
                    </>
                  )}
                </button>

                <button
                  type="button"
                  onClick={() =>
                    onNavigate(pendingApprovals > 0 ? "Approvals" : "Work")
                  }
                  className="ce-btn ce-btn-primary h-8 px-3.5 text-xs"
                >
                  <span>
                    {pendingApprovals > 0 ? "Open Approvals" : "Open Work"}
                  </span>
                  <ArrowUpRight className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          ) : selectedDomain ? (
            <div className="space-y-3.5">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-mono text-[10px] tracking-[0.14em] text-[var(--muted)] uppercase">
                    {formatStateLabel(selectedDomain.state)}
                  </p>
                  <h2 className="font-editorial mt-0.5 text-xl text-[var(--ink)]">
                    {selectedDomain.label}
                  </h2>
                </div>
                <button
                  type="button"
                  onClick={() => setSelectedId(null)}
                  className="ce-btn ce-btn-ghost h-7 w-7 shrink-0 p-0"
                  aria-label="Close inspector"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>

              <p className="border-t border-[var(--line)] pt-2.5 font-mono text-[11.5px] text-[var(--ink-secondary)] tabular-nums">
                {selectedDomain.summary ||
                  (selectedDomain.id === "approvals"
                    ? `${pendingApprovals} waiting sign-off`
                    : `${selectedDomain.active_count} active · ${selectedDomain.urgent_count} urgent`)}
              </p>

              {selectedDomain.items.length > 0 && (
                <div className="divide-y divide-[var(--line)] border-y border-[var(--line)]">
                  {selectedDomain.items.slice(0, 3).map((item) => (
                    <button
                      key={`${item.kind}-${item.id}`}
                      type="button"
                      onClick={() =>
                        handleJumpItem(item, selectedDomain.target_view)
                      }
                      className="flex w-full items-center justify-between gap-2.5 py-2 text-left transition hover:opacity-85"
                    >
                      <div className="min-w-0 flex-1">
                        <span className="line-clamp-1 block text-xs text-[var(--ink)]">
                          {item.title}
                        </span>
                        {item.meta && (
                          <span className="line-clamp-1 block font-mono text-[10px] text-[var(--muted)]">
                            {item.meta}
                          </span>
                        )}
                      </div>
                      {item.priority ? (
                        <PriorityBadge priority={item.priority} />
                      ) : item.status ? (
                        <span className="shrink-0 font-mono text-[10px] text-[var(--muted)]">
                          {item.status.replace(/_/g, " ")}
                        </span>
                      ) : null}
                    </button>
                  ))}
                </div>
              )}

              <button
                type="button"
                onClick={() => onNavigate(selectedDomain.target_view)}
                className="ce-btn ce-btn-primary h-8 w-full justify-center text-xs"
              >
                <span>Open {selectedDomain.label}</span>
                <ArrowUpRight className="h-3.5 w-3.5" />
              </button>
            </div>
          ) : null}
        </aside>
      )}

      {/* Bottom Unobtrusive Whisper Command & Unboxed Typographic Horizon */}
      <div className="pointer-events-none absolute inset-x-0 bottom-5 z-20 flex flex-col items-center gap-3 px-6">
        {commandOpen ? (
          <div className="pointer-events-auto w-full max-w-2xl">
            <OrchestratorBar
              spatial
              autoFocus
              activeWorkspace="Orbit"
              autonomyPosture={autonomyPosture}
              systemPaused={systemPaused}
              onNavigate={onNavigate}
              onJumpToEntity={onJumpToEntity}
              onStateMutated={onStateMutated}
              onClose={() => setCommandOpen(false)}
            />
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setCommandOpen(true)}
            aria-label="Ask across your workspace or dispatch a mission"
            className="ce-spatial-capsule pointer-events-auto inline-flex items-center gap-2.5 rounded-full px-4 py-1.5 text-xs text-[var(--muted)] transition hover:text-[var(--ink)]"
          >
            <Sparkles className="h-3 w-3 text-[var(--accent)]" />
            <span>Ask or dispatch a mission…</span>
          </button>
        )}

        {/* Pure floating typographic workspace horizon — NO pill boxes, NO tab strips, NO badge counters */}
        <nav
          aria-label="Spatial workspace horizon"
          style={textShadowStyle}
          className="pointer-events-auto flex flex-wrap items-center justify-center gap-x-5 gap-y-1.5"
        >
          {FLOATING_HORIZON_LINKS.map((entry) => {
            const hasAmber = entry.ws === "Approvals" && pendingApprovals > 0;
            const hasBlue = entry.ws === "Missions" && runningMissions > 0;
            return (
              <button
                key={entry.ws}
                type="button"
                onMouseEnter={() => handleHighlight(entry.domainId)}
                onMouseLeave={() => handleHighlight(null)}
                onFocus={() => handleHighlight(entry.domainId)}
                onBlur={() => handleHighlight(null)}
                onClick={() => onNavigate(entry.ws)}
                className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[12px] tracking-[0.03em] text-[var(--ink-secondary)] opacity-80 transition-all duration-150 hover:text-[var(--ink)] hover:opacity-100"
              >
                <span>{entry.label}</span>
                {hasAmber && (
                  <span
                    aria-hidden="true"
                    className="h-1.5 w-1.5 rounded-full bg-[var(--amber)]"
                  />
                )}
                {hasBlue && (
                  <span
                    aria-hidden="true"
                    className="h-1.5 w-1.5 rounded-full bg-[var(--accent)]"
                  />
                )}
              </button>
            );
          })}
        </nav>
      </div>
    </div>
  );
}
