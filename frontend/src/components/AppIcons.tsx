import React from "react";
import { Icon } from "@iconify/react";
import {
  CalendarClock,
  CheckCircle2,
  Clock,
  Code2,
  Cpu,
  FolderGit2,
  Globe,
  Layers,
  Link2,
  MessageSquare,
  MousePointerClick,
  ShieldCheck,
  Terminal,
  Video,
  Wind,
} from "lucide-react";
import { ensureOfflineIconsRegistered } from "../lib/iconBundle";
import type { TaskKind } from "../types/api";

ensureOfflineIconsRegistered();

export function AppIcon({
  icon,
  className = "h-4 w-4",
  style,
}: {
  icon: string;
  className?: string;
  style?: React.CSSProperties;
}) {
  const key = (icon || "").toLowerCase();
  if (!key) {
    return <Layers className={className} style={style} strokeWidth={1.75} />;
  }
  // Authentic product brand marks (Google, Slack, GitHub, Claude, OpenAI, Notion, Linear, etc.)
  if (key === "logos:github-icon") {
    return <Icon icon={icon} className={`${className} ce-github-mark`} style={style} />;
  }
  if (key.startsWith("logos:")) {
    return <Icon icon={icon} className={className} style={style} />;
  }
  // Replace cartoon fluent-color / solar duotone icons with calm monochrome architectural Lucide glyphs
  if (key.includes("command") || key.includes("terminal")) {
    return <Terminal className={`${className} text-[var(--ink-secondary)]`} style={style} strokeWidth={1.75} />;
  }
  if (key.includes("code")) {
    return <Code2 className={`${className} text-[var(--accent)]`} style={style} strokeWidth={1.75} />;
  }
  if (key.includes("cursor")) {
    return <MousePointerClick className={`${className} text-[var(--ink-secondary)]`} style={style} strokeWidth={1.75} />;
  }
  if (key.includes("wind")) {
    return <Wind className={`${className} text-[var(--ink-secondary)]`} style={style} strokeWidth={1.75} />;
  }
  if (key.includes("shield")) {
    return <ShieldCheck className={`${className} text-[var(--accent)]`} style={style} strokeWidth={1.75} />;
  }
  if (key.includes("calendar")) {
    return <CalendarClock className={`${className} text-[var(--accent)]`} style={style} strokeWidth={1.75} />;
  }
  if (key.includes("globe")) {
    return <Globe className={`${className} text-[var(--ink-secondary)]`} style={style} strokeWidth={1.75} />;
  }
  if (key.includes("folder")) {
    return <FolderGit2 className={`${className} text-[var(--accent)]`} style={style} strokeWidth={1.75} />;
  }
  if (key.includes("link")) {
    return <Link2 className={`${className} text-[var(--accent)]`} style={style} strokeWidth={1.75} />;
  }
  if (key.includes("bot") || key.includes("sparkle") || key.includes("cpu")) {
    return <Cpu className={`${className} text-[var(--accent)]`} style={style} strokeWidth={1.75} />;
  }
  return <Icon icon={icon} className={className} style={style} />;
}

const SOURCE_META: Record<string, { icon?: string; label: string }> = {
  slack: {
    icon: "logos:slack-icon",
    label: "Slack",
  },
  gmail: {
    icon: "logos:google-gmail",
    label: "Gmail",
  },
  calendar: {
    icon: "logos:google-calendar",
    label: "Google Calendar",
  },
  meet: {
    icon: "logos:google-meet",
    label: "Google Meet",
  },
  transcript: {
    icon: "logos:google-meet",
    label: "Call Notes",
  },
  meeting: {
    icon: "logos:google-meet",
    label: "Meeting",
  },
  drive: {
    icon: "logos:google-drive",
    label: "Google Drive",
  },
  github: {
    icon: "logos:github-icon",
    label: "GitHub",
  },
  local: {
    label: "Local Repo",
  },
  gke: {
    icon: "logos:google-cloud",
    label: "Google Cloud",
  },
  infra: {
    icon: "logos:google-cloud",
    label: "Google Cloud",
  },
  manual: {
    label: "Direct",
  },
};

export function getSourceMeta(source: string) {
  const key = (source || "manual").toLowerCase();
  return (
    SOURCE_META[key] ?? {
      label: source || "System",
    }
  );
}

export function SourceBrandTile({
  source,
  size = "md",
  className = "",
}: {
  source: string;
  size?: "xs" | "sm" | "md" | "lg";
  className?: string;
}) {
  const key = (source || "manual").toLowerCase();
  const meta = getSourceMeta(key);

  const boxCls =
    size === "xs"
      ? "h-6 w-6 rounded-md"
      : size === "sm"
      ? "h-7 w-7 rounded-lg"
      : size === "lg"
      ? "h-9 w-9 rounded-xl"
      : "h-8 w-8 rounded-lg";
  const iconCls =
    size === "xs"
      ? "h-3.5 w-3.5"
      : size === "sm"
      ? "h-4 w-4"
      : size === "lg"
      ? "h-4.5 w-4.5"
      : "h-4 w-4";

  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center border border-[var(--line)] bg-[var(--surface)] text-[var(--ink-secondary)] shadow-2xs ${boxCls} ${className}`}
      title={meta.label}
    >
      {meta.icon ? (
        <Icon icon={meta.icon} className={iconCls} />
      ) : key === "local" ? (
        <FolderGit2 className={`${iconCls} text-[var(--accent)]`} strokeWidth={1.75} />
      ) : (
        <Layers className={`${iconCls} text-[var(--muted)]`} strokeWidth={1.75} />
      )}
    </span>
  );
}

export function TaskKindBadge({ kind }: { kind?: TaskKind | string }) {
  const k = (kind || "code").toLowerCase();
  if (k === "call") {
    return (
      <span className="ce-pill ce-pill-accent inline-flex items-center gap-1">
        <Video className="h-3 w-3" strokeWidth={1.8} />
        <span>Call · Attend</span>
      </span>
    );
  }
  if (k === "review") {
    return (
      <span className="ce-pill inline-flex items-center gap-1">
        <CheckCircle2 className="h-3 w-3 text-[var(--accent)]" strokeWidth={1.8} />
        <span>Review</span>
      </span>
    );
  }
  if (k === "reply") {
    return (
      <span className="ce-pill inline-flex items-center gap-1">
        <MessageSquare className="h-3 w-3 text-[var(--muted)]" strokeWidth={1.8} />
        <span>Reply</span>
      </span>
    );
  }
  if (k === "waiting") {
    return (
      <span className="ce-pill inline-flex items-center gap-1">
        <Clock className="h-3 w-3 text-[var(--muted)]" strokeWidth={1.8} />
        <span>Waiting</span>
      </span>
    );
  }
  return (
    <span className="ce-pill inline-flex items-center gap-1">
      <Code2 className="h-3 w-3 text-[var(--muted)]" strokeWidth={1.8} />
      <span>Task</span>
    </span>
  );
}

export function resolveTaskKind(task: {
  task_kind?: string;
  bucket?: string;
  title?: string;
  source?: string;
}): TaskKind {
  if (task.bucket === "waiting_on_others") return "waiting";
  const explicit = (task.task_kind || "").toLowerCase();
  if (
    explicit === "call" ||
    explicit === "review" ||
    explicit === "reply" ||
    explicit === "waiting" ||
    explicit === "code"
  ) {
    return explicit;
  }
  const t = (task.title || "").trim();
  if (
    /^(attend|join|dial into|hop on)\b|\b(on-?boarding call|rescheduled .* call|1:1 meeting|sync call|google meet)\b/i.test(
      t
    ) &&
    !/^(draft|write|implement|fix|bump|post|prepare|verify|review|check|build)/i.test(t)
  ) {
    return "call";
  }
  if (/^(post|reply|send|message|email|dm|share)\b/i.test(t)) return "reply";
  if (/^(review|verify|check|audit)\b/i.test(t) && task.source !== "local") return "review";
  return "code";
}
