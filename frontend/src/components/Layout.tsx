import { useEffect, useState } from "react";
import { ArrowLeft, Menu, Moon, PauseCircle, Sun, X } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import type {
  HealthResponse,
  OrbitResponse,
  UserProfile,
  WorkspaceId,
} from "../types/api";
import { PrismMark } from "./PrismMark";

const HORIZON_WORKSPACES: Array<{ id: WorkspaceId; label: string }> = [
  { id: "Approvals", label: "Approvals" },
  { id: "Work", label: "Work" },
  { id: "Missions", label: "Missions" },
  { id: "Changes", label: "Changes" },
  { id: "Meetings", label: "Meetings" },
  { id: "Memory", label: "Memory" },
  { id: "Studio", label: "Studio" },
  { id: "Engineering", label: "Engineering" },
];

interface LayoutProps {
  activeWorkspace: WorkspaceId;
  onNavigate: (ws: WorkspaceId) => void;
  activeProfile: UserProfile | null;
  orbit: OrbitResponse | null;
  health: HealthResponse | null;
  unreadDeltas: number;
  resolvedTheme: "dark" | "light";
  onQuickToggleTheme: () => void;
  children: React.ReactNode;
}

export function Layout({
  activeWorkspace,
  onNavigate,
  activeProfile,
  orbit,
  health,
  unreadDeltas,
  resolvedTheme,
  onQuickToggleTheme,
  children,
}: LayoutProps) {
  const prefersReducedMotion = useReducedMotion();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  useEffect(() => {
    setMobileMenuOpen(false);
  }, [activeWorkspace]);

  useEffect(() => {
    if (!mobileMenuOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setMobileMenuOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [mobileMenuOpen]);

  const brandName =
    activeProfile?.brand_display_name ||
    orbit?.profile.brand_display_name ||
    "Command Engine";

  const systemPaused = Boolean(
    orbit?.prism_core.system_paused ?? health?.system_paused
  );
  const coreState = orbit?.prism_core.state || "quiet";
  const pendingApprovals = orbit?.prism_core.pending_approvals ?? 0;
  const runningMissions = orbit?.prism_core.running_missions ?? 0;

  const renderThemeToggleButton = () => (
    <button
      type="button"
      onClick={onQuickToggleTheme}
      aria-label="Toggle color theme"
      title={`Switch to ${resolvedTheme === "dark" ? "Light" : "Dark"} mode`}
      className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 transition-colors hover:bg-[var(--ink)]/5 hover:text-[var(--ink)]"
    >
      {resolvedTheme === "dark" ? (
        <Sun className="h-3.5 w-3.5" />
      ) : (
        <Moon className="h-3.5 w-3.5" />
      )}
      <span className="hidden text-[11.5px] md:inline">
        {resolvedTheme === "dark" ? "Light" : "Dark"}
      </span>
    </button>
  );

  /* ==========================================================================
     POSTURE 1: Chromeless Spatial Command Stage (`Orbit`)
     ========================================================================== */
  if (activeWorkspace === "Orbit") {
    const orbitTextShadow =
      resolvedTheme === "dark"
        ? { textShadow: "0 1px 12px rgba(4, 5, 10, 0.8)" }
        : { textShadow: "0 1px 10px rgba(242, 236, 225, 0.72)" };

    return (
      <div className="relative h-screen w-screen overflow-hidden bg-[var(--bg)] text-[var(--ink)]">
        <div
          role="banner"
          style={orbitTextShadow}
          className="pointer-events-none absolute inset-x-0 top-0 z-30 flex h-12 items-center justify-between px-6"
        >
          <div className="pointer-events-auto flex items-center gap-2.5">
            <PrismMark
              size={18}
              state={systemPaused ? "paused" : coreState}
            />
            <span className="text-[12px] font-medium tracking-[0.02em] text-[var(--ink-secondary)]">
              {brandName}
            </span>

            {systemPaused && (
              <span className="inline-flex items-center gap-1 font-mono text-[10.5px] text-[var(--amber)]">
                <PauseCircle className="h-3 w-3" />
                <span>Paused</span>
              </span>
            )}
          </div>

          <div className="pointer-events-auto flex h-full items-center gap-1 text-[12px] text-[var(--muted)]">
            {renderThemeToggleButton()}
          </div>
        </div>

        <main className="h-full w-full overflow-hidden">{children}</main>
      </div>
    );
  }

  /* ==========================================================================
     POSTURE 2: Unified Orbit Spatial Stage (Weightless Top HUD + Bottom Horizon)
     ========================================================================== */
  return (
    <div className="ce-interior-stage relative flex h-screen w-screen flex-col overflow-hidden">
      {/* Subtle Ambient Cosmic Silk Folds */}
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-0 z-0 overflow-hidden"
      >
        <div
          className="absolute -bottom-32 -left-24 h-[420px] w-[55vw] rounded-full opacity-45 blur-[110px]"
          style={{
            background:
              resolvedTheme === "dark"
                ? "radial-gradient(circle, rgba(68, 38, 178, 0.42) 0%, rgba(22, 48, 142, 0.22) 55%, transparent 78%)"
                : "radial-gradient(circle, rgba(96, 76, 218, 0.14) 0%, rgba(56, 102, 224, 0.08) 55%, transparent 78%)",
          }}
        />
        <div
          className="absolute -right-24 -bottom-36 h-[380px] w-[48vw] rounded-full opacity-40 blur-[110px]"
          style={{
            background:
              resolvedTheme === "dark"
                ? "radial-gradient(circle, rgba(168, 66, 36, 0.34) 0%, rgba(92, 32, 118, 0.18) 55%, transparent 78%)"
                : "radial-gradient(circle, rgba(218, 108, 52, 0.12) 0%, rgba(146, 78, 198, 0.06) 55%, transparent 78%)",
          }}
        />
      </div>

      {/* Weightless Top HUD */}
      <header className="relative z-30 flex h-12 shrink-0 items-center justify-between px-6">
        <div className="flex min-w-0 items-center gap-2">
          <button
            type="button"
            onClick={() => setMobileMenuOpen(true)}
            className="ce-btn ce-btn-ghost h-7 w-7 shrink-0 p-0 md:hidden"
            aria-label="Open navigation menu"
          >
            <Menu className="h-4 w-4" />
          </button>

          <button
            type="button"
            onClick={() => onNavigate("Orbit")}
            aria-label="Return to Orbit"
            className="group inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-[12px] font-medium tracking-[0.02em] text-[var(--ink-secondary)] transition-colors hover:bg-[var(--ink)]/5 hover:text-[var(--ink)]"
          >
            <ArrowLeft className="h-3.5 w-3.5 text-[var(--muted)] transition-transform group-hover:-translate-x-0.5 group-hover:text-[var(--ink)]" />
            <PrismMark
              size={15}
              state={systemPaused ? "paused" : coreState}
            />
            <span>Orbit</span>
          </button>

          <span aria-hidden="true" className="text-[12px] text-[var(--subtle)]">
            /
          </span>

          <span className="truncate text-[12.5px] font-medium text-[var(--ink)]">
            {activeWorkspace}
          </span>

          {systemPaused && (
            <span className="ml-1 inline-flex items-center gap-1 font-mono text-[10.5px] text-[var(--amber)]">
              <PauseCircle className="h-3 w-3" />
              <span>Paused</span>
            </span>
          )}
        </div>

        <div className="flex h-full shrink-0 items-center gap-1 text-[12px] text-[var(--muted)]">
          {renderThemeToggleButton()}
        </div>
      </header>

      {/* Mobile Drawer (<768px) */}
      {mobileMenuOpen && (
        <div
          className="fixed inset-0 z-50 flex bg-black/60 backdrop-blur-xs md:hidden"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setMobileMenuOpen(false);
          }}
        >
          <aside
            role="dialog"
            aria-modal="true"
            aria-label="Workspace navigation"
            className="ce-spatial-capsule flex h-full w-64 flex-col border-r border-[var(--line)] p-4"
          >
            <div className="mb-4 flex items-center justify-between border-b border-[var(--line)] pb-3">
              <button
                type="button"
                onClick={() => {
                  setMobileMenuOpen(false);
                  onNavigate("Orbit");
                }}
                className="flex items-center gap-2 text-sm font-medium text-[var(--ink)]"
              >
                <PrismMark size={17} state={coreState} />
                <span>Orbit</span>
              </button>
              <button
                type="button"
                onClick={() => setMobileMenuOpen(false)}
                className="ce-btn ce-btn-ghost h-7 w-7 p-0"
                aria-label="Close navigation menu"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <nav aria-label="Compact workspace menu" className="space-y-1">
              {HORIZON_WORKSPACES.map((item) => {
                const active = activeWorkspace === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    aria-current={active ? "page" : undefined}
                    onClick={() => {
                      setMobileMenuOpen(false);
                      onNavigate(item.id);
                    }}
                    className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-xs font-medium transition ${
                      active
                        ? "bg-[var(--ink)]/10 text-[var(--ink)]"
                        : "text-[var(--muted)] hover:bg-[var(--ink)]/5 hover:text-[var(--ink)]"
                    }`}
                  >
                    <span>{item.label}</span>
                  </button>
                );
              })}
            </nav>
          </aside>
        </div>
      )}

      {/* Calm, Breathable Spatial Stage */}
      <main className="ce-contain-scroll relative z-10 min-h-0 flex-1 overflow-x-hidden overflow-y-auto pb-16">
        {children}
      </main>

      {/* Bottom Floating Workspace Horizon — Continuous with Orbit */}
      <div className="pointer-events-none fixed inset-x-0 bottom-3.5 z-30 hidden justify-center px-4 md:flex">
        <nav
          aria-label="Workspace horizon"
          className="ce-spatial-capsule pointer-events-auto flex items-center gap-0.5 rounded-full px-2 py-1"
        >
          <button
            type="button"
            onClick={() => onNavigate("Orbit")}
            className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11.5px] font-medium text-[var(--muted)] transition-colors hover:text-[var(--ink)]"
          >
            <PrismMark size={13} state={systemPaused ? "paused" : coreState} />
            <span>Orbit</span>
          </button>

          <span aria-hidden="true" className="mx-0.5 h-3.5 w-px bg-[var(--line)]" />

          {HORIZON_WORKSPACES.map((item) => {
            const active = activeWorkspace === item.id;
            const showAmberDot = item.id === "Approvals" && pendingApprovals > 0;
            const showBlueDot = item.id === "Missions" && runningMissions > 0;
            const showSageDot = item.id === "Changes" && unreadDeltas > 0;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onNavigate(item.id)}
                aria-current={active ? "page" : undefined}
                className={`relative inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11.5px] font-medium transition-colors ${
                  active
                    ? "text-[var(--ink)]"
                    : "text-[var(--muted)] hover:text-[var(--ink)]"
                }`}
              >
                {active && (
                  <motion.span
                    layoutId="ce-horizon-active-pill"
                    transition={
                      prefersReducedMotion
                        ? { duration: 0 }
                        : { type: "spring", bounce: 0, duration: 0.3 }
                    }
                    className="absolute inset-0 rounded-full bg-[var(--ink)]/[0.09] ring-1 ring-[var(--line-strong)]"
                  />
                )}
                <span className="relative z-10">{item.label}</span>
                {showAmberDot && (
                  <span
                    aria-hidden="true"
                    className="relative z-10 h-1.5 w-1.5 rounded-full bg-[var(--amber)]"
                  />
                )}
                {showBlueDot && (
                  <span
                    aria-hidden="true"
                    className="relative z-10 h-1.5 w-1.5 rounded-full bg-[var(--accent)]"
                  />
                )}
                {showSageDot && (
                  <span
                    aria-hidden="true"
                    className="relative z-10 h-1.5 w-1.5 rounded-full bg-[var(--sage)]"
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
