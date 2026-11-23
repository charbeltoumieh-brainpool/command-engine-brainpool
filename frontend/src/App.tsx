import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { motion, useReducedMotion } from "motion/react";
import { Layout } from "./components/Layout";
import { ToastProvider, useToast } from "./components/ToastContext";
import { api, invalidateApiCache } from "./lib/api";
import { useEventStream } from "./lib/useEventStream";
import type {
  DensityPreference,
  HealthResponse,
  JumpTarget,
  OrbitResponse,
  ThemePreference,
  UserProfile,
  WorkspaceId,
} from "./types/api";
import { ApprovalsView } from "./views/ApprovalsView";
import { ChangesView } from "./views/ChangesView";
import { EngineeringView } from "./views/EngineeringView";
import { MeetingsView } from "./views/MeetingsView";
import { MemoryView } from "./views/MemoryView";
import { MissionsView } from "./views/MissionsView";
import { OrbitView } from "./views/OrbitView";
import { StudioView } from "./views/StudioView";
import { WorkView } from "./views/WorkView";

export type { JumpTarget };

const OrbitViewStage = OrbitView as React.ComponentType<
  React.ComponentProps<typeof OrbitView> & {
    onJumpToEntity?: (target: JumpTarget) => void;
    onJumpToApproval?: (approvalId: number) => void;
  }
>;

const WorkViewStage = WorkView as React.ComponentType<
  React.ComponentProps<typeof WorkView> & {
    onClearInitialTask?: () => void;
    onJumpToApproval?: (approvalId: number) => void;
  }
>;

const MissionsViewStage = MissionsView as React.ComponentType<
  React.ComponentProps<typeof MissionsView> & {
    onJumpToApproval?: (approvalId: number) => void;
  }
>;

const ApprovalsViewStage = ApprovalsView as React.ComponentType<
  React.ComponentProps<typeof ApprovalsView> & {
    onClearInitialApproval?: () => void;
  }
>;

const VALID_WORKSPACES: WorkspaceId[] = [
  "Orbit",
  "Approvals",
  "Work",
  "Missions",
  "Changes",
  "Meetings",
  "Memory",
  "Studio",
  "Engineering",
];

const FULL_HEIGHT_WORKSPACES = new Set<WorkspaceId>([
  "Orbit",
  "Work",
  "Approvals",
  "Missions",
  "Meetings",
]);

function parseWorkspaceFromHash(): WorkspaceId {
  const raw = window.location.hash.replace(/^#\/?/, "").trim().toLowerCase();
  if (!raw) return "Orbit";
  const found = VALID_WORKSPACES.find((w) => w.toLowerCase() === raw);
  return found ?? "Orbit";
}

function readInitialThemePref(): ThemePreference {
  try {
    const saved = localStorage.getItem("ce.theme.mode");
    if (saved === "dark" || saved === "light" || saved === "system") {
      return saved;
    }
  } catch {
    // ignore
  }
  return "dark";
}

function readInitialDensity(): DensityPreference {
  try {
    const saved = localStorage.getItem("ce.density");
    if (saved === "compact" || saved === "comfortable") return saved;
  } catch {
    // ignore
  }
  return "comfortable";
}

function CommandEngineShell() {
  const { pushToast } = useToast();
  const prefersReducedMotion = useReducedMotion();

  const [activeWorkspace, setActiveWorkspace] = useState<WorkspaceId>(
    parseWorkspaceFromHash
  );
  const [orbitWarpOut, setOrbitWarpOut] = useState(false);
  const warpTimerRef = useRef<number | null>(null);

  const [jumpTaskId, setJumpTaskId] = useState<number | null>(null);
  const [jumpApprovalId, setJumpApprovalId] = useState<number | null>(null);
  const [jumpMissionId, setJumpMissionId] = useState<string | null>(null);
  const [jumpMeetingId, setJumpMeetingId] = useState<number | null>(null);
  const [jumpNoteRef, setJumpNoteRef] = useState<{ folder?: string; slug: string } | null>(
    null
  );

  const [themePref, setThemePref] = useState<ThemePreference>(
    readInitialThemePref
  );
  const [systemPrefersLight, setSystemPrefersLight] = useState<boolean>(() =>
    typeof window !== "undefined"
      ? window.matchMedia("(prefers-color-scheme: light)").matches
      : false
  );
  const [density] = useState<DensityPreference>(readInitialDensity);

  const [activeProfile, setActiveProfile] = useState<UserProfile | null>(null);
  const [orbit, setOrbit] = useState<OrbitResponse | null>(null);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [unreadDeltas, setUnreadDeltas] = useState<number>(0);
  const [refreshSignal, setRefreshSignal] = useState(0);

  const resolvedTheme: "dark" | "light" = useMemo(() => {
    if (themePref === "system") {
      return systemPrefersLight ? "light" : "dark";
    }
    return themePref;
  }, [systemPrefersLight, themePref]);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const listener = (e: MediaQueryListEvent) => setSystemPrefersLight(e.matches);
    mq.addEventListener("change", listener);
    return () => mq.removeEventListener("change", listener);
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.add("ce-theme-switching");
    root.dataset.theme = resolvedTheme;
    const meta = document.getElementById("ce-theme-color");
    if (meta) {
      meta.setAttribute(
        "content",
        resolvedTheme === "light" ? "#f5f2eb" : "#05060a"
      );
    }
    try {
      localStorage.setItem("ce.theme.mode", themePref);
    } catch {
      // ignore
    }
    const raf = window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        root.classList.remove("ce-theme-switching");
      });
    });
    return () => window.cancelAnimationFrame(raf);
  }, [resolvedTheme, themePref]);

  useEffect(() => {
    document.documentElement.dataset.density = density;
    try {
      localStorage.setItem("ce.density", density);
    } catch {
      // ignore
    }
  }, [density]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void api.getApprovals("pending").catch(() => undefined);
      void api.getTasks({ bucket: "needed_from_me", include_done: false }).catch(() => undefined);
      void api.getMissions().catch(() => undefined);
    }, 180);
    return () => window.clearTimeout(timer);
  }, []);

  const navigateWorkspace = useCallback(
    (ws: WorkspaceId) => {
      if (warpTimerRef.current) {
        window.clearTimeout(warpTimerRef.current);
        warpTimerRef.current = null;
      }

      const commitNav = () => {
        setOrbitWarpOut(false);
        setActiveWorkspace(ws);
        const nextHash = `#${ws.toLowerCase()}`;
        if (window.location.hash !== nextHash) {
          window.history.replaceState(null, "", nextHash);
        }
      };

      if (
        activeWorkspace === "Orbit" &&
        ws !== "Orbit" &&
        !prefersReducedMotion
      ) {
        setOrbitWarpOut(true);
        warpTimerRef.current = window.setTimeout(commitNav, 95);
      } else {
        commitNav();
      }
    },
    [activeWorkspace, prefersReducedMotion]
  );

  const handleJumpToEntity = useCallback(
    (target: JumpTarget) => {
      if (target.workspace === "Work" && target.id != null) {
        const numericId = Number(target.id);
        if (!Number.isNaN(numericId)) setJumpTaskId(numericId);
      } else if (target.workspace === "Approvals" && target.id != null) {
        const numericId = Number(target.id);
        if (!Number.isNaN(numericId)) setJumpApprovalId(numericId);
      } else if (target.workspace === "Missions" && target.id != null) {
        setJumpMissionId(String(target.id));
      } else if (target.workspace === "Meetings" && target.id != null) {
        const numericId = Number(target.id);
        if (!Number.isNaN(numericId)) setJumpMeetingId(numericId);
      }
      navigateWorkspace(target.workspace);
    },
    [navigateWorkspace]
  );

  const handleJumpToApproval = useCallback(
    (approvalId: number) => {
      setJumpApprovalId(approvalId);
      navigateWorkspace("Approvals");
    },
    [navigateWorkspace]
  );

  useEffect(() => {
    return () => {
      if (warpTimerRef.current) window.clearTimeout(warpTimerRef.current);
    };
  }, []);

  useEffect(() => {
    const onHashChange = () => {
      setOrbitWarpOut(false);
      setActiveWorkspace(parseWorkspaceFromHash());
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const loadCoreState = useCallback(async () => {
    try {
      const [profRes, orbitRes, healthRes, dashRes] = await Promise.all([
        api.getProfiles().catch(() => null),
        api.getOrbit().catch(() => null),
        api.getHealth().catch(() => null),
        api.getDashboard().catch(() => null),
      ]);
      if (profRes?.active) {
        setActiveProfile(profRes.active);
        const brand = profRes.active.brand_display_name || "Command Engine";
        document.title = brand;
      }
      if (orbitRes) setOrbit(orbitRes);
      if (healthRes) setHealth(healthRes);
      if (dashRes) setUnreadDeltas(dashRes.kpis.unread_deltas || 0);
    } catch {
      // Handled gracefully by individual view states
    }
  }, []);

  useEffect(() => {
    void loadCoreState();
  }, [loadCoreState, refreshSignal]);

  const bumpState = useCallback(() => {
    invalidateApiCache();
    setRefreshSignal((s) => s + 1);
  }, []);

  const { streamConnected } = useEventStream((evt) => {
    bumpState();
    if (evt.event_type === "sweep.delta_completed") {
      const summary =
        evt.summary?.trim() || "New workspace signals synchronized.";
      pushToast("info", "Delta sync completed", summary);
    }
  });

  useEffect(() => {
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible" && !streamConnected) {
        invalidateApiCache();
        void loadCoreState();
      }
    }, 45000);
    return () => window.clearInterval(interval);
  }, [loadCoreState, streamConnected]);

  const handleQuickToggleTheme = useCallback(() => {
    setThemePref(resolvedTheme === "dark" ? "light" : "dark");
  }, [resolvedTheme]);

  return (
    <Layout
      activeWorkspace={activeWorkspace}
      onNavigate={navigateWorkspace}
      activeProfile={activeProfile}
      orbit={orbit}
      health={health}
      unreadDeltas={unreadDeltas}
      resolvedTheme={resolvedTheme}
      onQuickToggleTheme={handleQuickToggleTheme}
    >
      <motion.div
        key={activeWorkspace}
        initial={
          prefersReducedMotion
            ? false
            : { opacity: 0, scale: activeWorkspace === "Orbit" ? 1 : 0.994 }
        }
        animate={{ opacity: 1, scale: 1 }}
        transition={
          prefersReducedMotion
            ? { duration: 0 }
            : { duration: 0.22, ease: [0.22, 1, 0.36, 1] }
        }
        className={
          FULL_HEIGHT_WORKSPACES.has(activeWorkspace)
            ? "h-full w-full"
            : "min-h-full w-full"
        }
      >
        {activeWorkspace === "Orbit" && (
          <OrbitViewStage
            orbit={orbit}
            resolvedTheme={resolvedTheme}
            streamConnected={streamConnected}
            refreshSignal={refreshSignal}
            transitioningOut={orbitWarpOut}
            onNavigate={navigateWorkspace}
            onJumpToEntity={handleJumpToEntity}
            onJumpToApproval={handleJumpToApproval}
            onStateMutated={bumpState}
          />
        )}
        {activeWorkspace === "Work" && (
          <WorkViewStage
            refreshSignal={refreshSignal}
            initialTaskId={jumpTaskId}
            onClearInitialTask={() => setJumpTaskId(null)}
            onJumpToApproval={handleJumpToApproval}
            onNavigate={navigateWorkspace}
            onStateMutated={bumpState}
          />
        )}
        {activeWorkspace === "Changes" && (
          <ChangesView
            refreshSignal={refreshSignal}
            onNavigate={navigateWorkspace}
            onStateMutated={bumpState}
          />
        )}
        {activeWorkspace === "Meetings" && (
          <MeetingsView
            refreshSignal={refreshSignal}
            initialMeetingId={jumpMeetingId}
            onNavigate={navigateWorkspace}
            onStateMutated={bumpState}
          />
        )}
        {activeWorkspace === "Missions" && (
          <MissionsViewStage
            refreshSignal={refreshSignal}
            initialMissionId={jumpMissionId}
            onJumpToApproval={handleJumpToApproval}
            onNavigate={navigateWorkspace}
            onStateMutated={bumpState}
          />
        )}
        {activeWorkspace === "Approvals" && (
          <ApprovalsViewStage
            refreshSignal={refreshSignal}
            initialApprovalId={jumpApprovalId}
            onClearInitialApproval={() => setJumpApprovalId(null)}
            onNavigate={navigateWorkspace}
            onStateMutated={bumpState}
          />
        )}
        {activeWorkspace === "Memory" && (
          <MemoryView
            refreshSignal={refreshSignal}
            initialNoteRef={jumpNoteRef}
            onClearInitialNote={() => setJumpNoteRef(null)}
            onNavigate={navigateWorkspace}
            onStateMutated={bumpState}
          />
        )}
        {activeWorkspace === "Studio" && (
          <StudioView
            refreshSignal={refreshSignal}
            onOpenNote={(slug) => {
              setJumpNoteRef({ slug });
              navigateWorkspace("Memory");
            }}
            onStateMutated={bumpState}
          />
        )}
        {activeWorkspace === "Engineering" && (
          <EngineeringView
            refreshSignal={refreshSignal}
            onNavigate={navigateWorkspace}
            onStateMutated={bumpState}
          />
        )}
      </motion.div>
    </Layout>
  );
}

export default function App() {
  return (
    <ToastProvider>
      <CommandEngineShell />
    </ToastProvider>
  );
}
