import React from "react";
import { AlertTriangle, BookOpen, FolderGit2, Layers, RotateCw } from "lucide-react";
import { AppIcon } from "./AppIcons";

export type BadgeVariant = "quiet" | "pill";

export function PriorityBadge({
  priority,
  variant = "quiet",
}: {
  priority: string;
  variant?: BadgeVariant;
}) {
  const p = (priority || "P2").toUpperCase();

  if (variant === "pill") {
    const pillTone =
      p === "P0"
        ? "ce-pill-coral"
        : p === "P1"
        ? "ce-pill-amber"
        : "";
    return (
      <span className={`ce-pill font-mono tabular-nums ${pillTone}`}>
        {p}
      </span>
    );
  }

  if (p === "P0") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-md border border-[var(--coral-border)] bg-[var(--coral-soft)] px-1.5 py-0.5 font-mono text-[10.5px] font-semibold leading-none tabular-nums text-[var(--coral)]">
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--coral)]" />
        {p}
      </span>
    );
  }

  if (p === "P1") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-md bg-[var(--amber-soft)] px-1.5 py-0.5 font-mono text-[10.5px] font-medium leading-none tabular-nums text-[var(--amber)]">
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--amber)]" />
        {p}
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1.5 font-mono text-[10.5px] font-medium leading-none tabular-nums text-[var(--muted)]">
      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--subtle)]" />
      {p}
    </span>
  );
}

export function StatusBadge({
  status,
  variant = "quiet",
}: {
  status: string;
  variant?: BadgeVariant;
}) {
  const s = (status || "").toLowerCase();
  const label = (status || "unknown").replace(/_/g, " ");

  let tone: "sage" | "amber" | "coral" | "accent" | "muted" = "muted";
  if (["done", "executed", "passed", "completed", "ready", "auto", "clean", "verified"].includes(s)) {
    tone = "sage";
  } else if (["pending", "agent_staged", "ask_first", "scheduled", "dirty"].includes(s)) {
    tone = "amber";
  } else if (["blocked", "failed", "rejected", "error"].includes(s)) {
    tone = "coral";
  } else if (["in_progress", "running", "processed", "approved"].includes(s)) {
    tone = "accent";
  }

  if (variant === "pill") {
    const pillClass =
      tone === "sage"
        ? "ce-pill-sage"
        : tone === "amber"
        ? "ce-pill-amber"
        : tone === "coral"
        ? "ce-pill-coral"
        : tone === "accent"
        ? "ce-pill-accent"
        : "";
    return <span className={`ce-pill capitalize ${pillClass}`}>{label}</span>;
  }

  const dotClass =
    tone === "sage"
      ? "bg-[var(--sage)]"
      : tone === "amber"
      ? "bg-[var(--amber)]"
      : tone === "coral"
      ? "bg-[var(--coral)]"
      : tone === "accent"
      ? "bg-[var(--accent)]"
      : "bg-[var(--muted)]";

  const textClass =
    tone === "sage"
      ? "text-[var(--sage)]"
      : tone === "amber"
      ? "text-[var(--amber)]"
      : tone === "coral"
      ? "text-[var(--coral)]"
      : tone === "accent"
      ? "text-[var(--accent)]"
      : "text-[var(--muted)]";

  return (
    <span className={`inline-flex items-center gap-1.5 text-[11px] font-medium capitalize ${textClass}`}>
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dotClass}`} />
      <span>{label}</span>
    </span>
  );
}

export function SourceIcon({
  source,
  className = "h-3.5 w-3.5",
}: {
  source: string;
  className?: string;
}) {
  const s = (source || "").toLowerCase();
  if (s.includes("slack")) return <AppIcon icon="logos:slack-icon" className={className} />;
  if (s.includes("gmail") || s.includes("email"))
    return <AppIcon icon="logos:google-gmail" className={className} />;
  if (s.includes("calendar"))
    return <AppIcon icon="logos:google-calendar" className={className} />;
  if (s.includes("transcript") || s.includes("meeting") || s.includes("meet"))
    return <AppIcon icon="logos:google-meet" className={className} />;
  if (s.includes("drive"))
    return <AppIcon icon="logos:google-drive" className={className} />;
  if (s.includes("vault") || s.includes("wiki"))
    return <BookOpen className={`${className} text-[var(--muted)]`} strokeWidth={1.75} />;
  if (s.includes("github"))
    return <AppIcon icon="logos:github-icon" className={className} />;
  if (s.includes("local"))
    return <FolderGit2 className={`${className} text-[var(--muted)]`} strokeWidth={1.75} />;
  if (s.includes("gke") || s.includes("gcp") || s.includes("phoenix") || s.includes("infra"))
    return <AppIcon icon="logos:google-cloud" className={className} />;
  return <Layers className={`${className} text-[var(--muted)]`} strokeWidth={1.75} />;
}

export function SourceBadge({
  source,
  variant = "quiet",
}: {
  source: string;
  variant?: BadgeVariant;
}) {
  const label = source || "system";
  if (variant === "pill") {
    return (
      <span className="ce-pill">
        <SourceIcon source={label} className="h-3.5 w-3.5" />
        <span className="capitalize">{label}</span>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] text-[var(--muted)]">
      <SourceIcon source={label} className="h-3.5 w-3.5 shrink-0" />
      <span className="capitalize">{label}</span>
    </span>
  );
}

export function SkeletonCard({
  lines = 3,
  unboxed = false,
}: {
  lines?: number;
  unboxed?: boolean;
}) {
  return (
    <div
      aria-busy="true"
      className={
        unboxed
          ? "py-1 opacity-75"
          : "ce-card ce-skeleton p-4 opacity-75"
      }
    >
      <div className="h-3.5 w-1/3 rounded bg-[var(--surface-sunken)]" />
      <div className="mt-3 space-y-2">
        {Array.from({ length: lines }).map((_, idx) => (
          <div
            key={idx}
            className="h-2.5 rounded bg-[var(--surface-sunken)]"
            style={{ width: `${92 - idx * 14}%` }}
          />
        ))}
      </div>
    </div>
  );
}

export function SkeletonRows({
  rows = 5,
  className = "",
}: {
  rows?: number;
  className?: string;
}) {
  const widths = ["64%", "48%", "72%", "56%", "68%", "44%"];
  return (
    <div
      aria-busy="true"
      className={`divide-y divide-[var(--line)] ${className}`.trim()}
    >
      {Array.from({ length: rows }).map((_, idx) => (
        <div key={idx} className="flex items-center justify-between gap-4 py-3">
          <div className="min-w-0 flex-1 space-y-2">
            <div
              className="ce-skeleton h-3"
              style={{ width: widths[idx % widths.length] }}
            />
            <div
              className="ce-skeleton h-2 opacity-75"
              style={{ width: `${Math.max(24, 52 - (idx % 3) * 10)}%` }}
            />
          </div>
          <div className="ce-skeleton h-2.5 w-14 shrink-0" />
        </div>
      ))}
    </div>
  );
}

export function ErrorBanner({
  title = "Unable to load data",
  message,
  onRetry,
  className = "",
}: {
  title?: string;
  message: string;
  onRetry?: () => void;
  className?: string;
}) {
  return (
    <div
      role="alert"
      className={`flex items-start justify-between gap-3 rounded-lg border border-[var(--line)] border-l-2 border-l-[var(--coral)] bg-[var(--surface-raised)]/65 px-3.5 py-2.5 ${className}`.trim()}
    >
      <div className="flex min-w-0 items-start gap-2.5">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--coral)]" />
        <div className="min-w-0">
          <p className="text-xs font-semibold text-[var(--ink)]">{title}</p>
          <p className="mt-0.5 text-xs leading-relaxed text-[var(--muted)]">{message}</p>
        </div>
      </div>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="ce-btn shrink-0 px-2.5 py-1 text-[11px]"
        >
          <RotateCw className="h-3 w-3" />
          Retry
        </button>
      )}
    </div>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
      <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-[var(--line)] bg-[var(--surface-raised)] text-[var(--muted)]">
        <Icon className="h-4.5 w-4.5" />
      </div>
      <h3 className="mt-3.5 text-sm font-semibold text-[var(--ink)]">{title}</h3>
      <p className="mt-1 max-w-md text-xs leading-relaxed text-[var(--muted)]">
        {description}
      </p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
