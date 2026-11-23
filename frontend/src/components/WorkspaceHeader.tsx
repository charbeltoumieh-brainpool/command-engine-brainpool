import { useId, type ReactNode } from "react";
import { motion, useReducedMotion } from "motion/react";

export interface WorkspaceTab {
  id: string;
  label: string;
  count?: number | string;
  dot?: "amber" | "accent" | "sage" | "coral";
}

export interface WorkspaceHeaderProps {
  eyebrow?: string;
  title: string;
  accent?: string;
  subtitle?: string;
  telemetry?: ReactNode;
  tabs?: WorkspaceTab[];
  activeTab?: string;
  onTabChange?: (id: string) => void;
  actions?: ReactNode;
  className?: string;
}

const DOT_CLASS: Record<NonNullable<WorkspaceTab["dot"]>, string> = {
  amber: "bg-[var(--amber)]",
  accent: "bg-[var(--accent)]",
  sage: "bg-[var(--sage)]",
  coral: "bg-[var(--coral)]",
};

/**
 * Calm, single-row architectural header.
 * Intentionally omits uppercase eyebrows, repetitive italic taglines, and verbose
 * telemetry walls so workspaces open immediately onto clean content.
 */
export function WorkspaceHeader({
  title,
  tabs,
  activeTab,
  onTabChange,
  actions,
  className = "",
}: WorkspaceHeaderProps) {
  const hasTabs = Boolean(tabs && tabs.length > 0);
  const pillId = useId();
  const prefersReducedMotion = useReducedMotion();

  return (
    <header
      className={`flex flex-wrap items-center justify-between gap-3 pb-3 ${className}`.trim()}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-4">
        <h1 className="text-[20px] font-semibold tracking-[-0.025em] text-[var(--ink)]">
          {title}
        </h1>

        {hasTabs && tabs && (
          <nav
            role="tablist"
            aria-label={`${title} views`}
            className="inline-flex flex-wrap items-center gap-0.5 rounded-xl border border-[var(--line)] bg-[var(--surface-sunken)] p-1"
          >
            {tabs.map((tab) => {
              const active = tab.id === activeTab;
              return (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => onTabChange?.(tab.id)}
                  className={`relative inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-[12px] font-medium transition-colors ${
                    active
                      ? "text-[var(--ink)]"
                      : "text-[var(--muted)] hover:text-[var(--ink)]"
                  }`}
                >
                  {active && (
                    <motion.span
                      layoutId={`ws-seg-${pillId}`}
                      transition={
                        prefersReducedMotion
                          ? { duration: 0 }
                          : { type: "spring", bounce: 0, duration: 0.28 }
                      }
                      className="absolute inset-0 rounded-lg bg-[var(--surface-raised)] ring-1 ring-[var(--line-strong)]"
                    />
                  )}
                  {tab.dot && (
                    <span
                      aria-hidden="true"
                      className={`relative z-10 h-1.5 w-1.5 rounded-full ${DOT_CLASS[tab.dot]}`}
                    />
                  )}
                  <span className="relative z-10">{tab.label}</span>
                  {tab.count !== undefined && Number(tab.count) > 0 && (
                    <span className="relative z-10 font-mono text-[10.5px] text-[var(--muted)] tabular-nums">
                      {tab.count}
                    </span>
                  )}
                </button>
              );
            })}
          </nav>
        )}
      </div>

      {actions && (
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {actions}
        </div>
      )}
    </header>
  );
}
