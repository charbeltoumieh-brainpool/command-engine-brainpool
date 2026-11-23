import { useEffect, useRef } from "react";
import {
  Activity,
  AlertCircle,
  CheckCircle2,
  Clock,
  CircleDot,
  Radar,
  ShieldCheck,
} from "lucide-react";

export type AgentBotState =
  | "working"
  | "needs_human"
  | "staged"
  | "scouting"
  | "waiting"
  | "alert"
  | "done";

export interface AgentBotProps {
  state: AgentBotState;
  size?: "xs" | "sm" | "md" | "lg";
  label?: string;
  className?: string;
}

export const AGENT_STATE_META: Record<
  AgentBotState,
  {
    shortLabel: string;
    pillClass: string;
    visorColor: string;
    glowColor: string;
  }
> = {
  working: {
    shortLabel: "Active",
    pillClass: "ce-pill-accent",
    visorColor: "var(--accent)",
    glowColor: "var(--accent-soft)",
  },
  needs_human: {
    shortLabel: "Needs You",
    pillClass: "ce-pill-amber",
    visorColor: "var(--amber)",
    glowColor: "var(--amber-soft)",
  },
  staged: {
    shortLabel: "Staged",
    pillClass: "ce-pill-accent",
    visorColor: "var(--accent)",
    glowColor: "var(--accent-soft)",
  },
  scouting: {
    shortLabel: "Syncing",
    pillClass: "ce-pill-accent",
    visorColor: "var(--accent)",
    glowColor: "var(--accent-soft)",
  },
  waiting: {
    shortLabel: "Waiting",
    pillClass: "",
    visorColor: "var(--muted)",
    glowColor: "var(--surface-raised)",
  },
  alert: {
    shortLabel: "Urgent",
    pillClass: "ce-pill-coral",
    visorColor: "var(--coral)",
    glowColor: "var(--coral-soft)",
  },
  done: {
    shortLabel: "Done",
    pillClass: "ce-pill-sage",
    visorColor: "var(--sage)",
    glowColor: "var(--sage-soft)",
  },
};

export function resolveTaskBotState(task: {
  status?: string;
  priority?: string;
  bucket?: string;
  approval_id?: number | null;
}): AgentBotState {
  const status = (task.status || "todo").toLowerCase();
  const priority = (task.priority || "P2").toUpperCase();
  const bucket = (task.bucket || "needed_from_me").toLowerCase();

  if (status === "done" || status === "completed") return "done";
  if (status === "in_progress" || status === "running") return "working";
  if (status === "agent_staged" || task.approval_id) return "staged";
  if (status === "blocked") return "alert";
  if (bucket === "waiting_on_others") return "waiting";
  if (priority === "P0") return "alert";
  if (status === "todo" && bucket === "needed_from_me") return "needs_human";
  return "waiting";
}

/**
 * Calm, natural architectural status emblem (replaces cartoon robot SVG).
 */
export function AgentBot({
  state,
  size = "md",
  label,
  className = "",
}: AgentBotProps) {
  const meta = AGENT_STATE_META[state];

  const boxCls =
    size === "xs"
      ? "h-6 w-6 rounded-md"
      : size === "sm"
      ? "h-7 w-7 rounded-lg"
      : size === "lg"
      ? "h-10 w-10 rounded-xl"
      : "h-8.5 w-8.5 rounded-lg";

  const iconCls =
    size === "xs"
      ? "h-3.5 w-3.5"
      : size === "sm"
      ? "h-3.5 w-3.5"
      : size === "lg"
      ? "h-5 w-5"
      : "h-4 w-4";

  const Glyph =
    state === "working"
      ? Activity
      : state === "staged"
      ? ShieldCheck
      : state === "scouting"
      ? Radar
      : state === "waiting"
      ? Clock
      : state === "alert"
      ? AlertCircle
      : state === "done"
      ? CheckCircle2
      : CircleDot;

  return (
    <span
      title={label || meta.shortLabel}
      aria-label={label || meta.shortLabel}
      className={`inline-flex shrink-0 items-center justify-center border border-[var(--line)] bg-[var(--surface)] shadow-2xs ${boxCls} ${className}`}
      style={{ color: meta.visorColor }}
    >
      <Glyph className={iconCls} strokeWidth={1.75} />
    </span>
  );
}

export interface TaskAgentPerchProps {
  state: AgentBotState;
  agentName?: string;
  statusText?: string;
  compact?: boolean;
  className?: string;
}

/**
 * Quiet, restrained status badge for task cards & approval items.
 */
export function TaskAgentPerch({
  state,
  agentName,
  statusText,
  className = "",
}: TaskAgentPerchProps) {
  const meta = AGENT_STATE_META[state];
  const resolvedLabel = statusText || meta.shortLabel;

  return (
    <div
      className={`inline-flex items-center gap-1.5 rounded-md border border-[var(--line)] bg-[var(--surface-raised)] px-2 py-0.5 text-[11px] leading-none ${className}`}
    >
      <span
        className="h-1.5 w-1.5 shrink-0 rounded-full"
        style={{ backgroundColor: meta.visorColor }}
      />
      {agentName && (
        <>
          <span className="font-medium text-[var(--ink-secondary)]">{agentName}</span>
          <span className="text-[var(--subtle)]">·</span>
        </>
      )}
      <span className="truncate font-medium text-[var(--ink-secondary)]">
        {resolvedLabel}
      </span>
    </div>
  );
}

export interface MiniMultispherePreviewProps {
  nodesCount: number;
  edgesCount: number;
  godNodesCount?: number;
  onOpen: () => void;
}

export function MiniMultispherePreview({
  nodesCount,
  edgesCount,
  onOpen,
}: MiniMultispherePreviewProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;

    const count = Math.min(Math.max(nodesCount || 32, 24), 48);
    const paletteDark = ["#82b8ff", "#b99eff", "#6fe3b5", "#9398a8"];
    const paletteLight = ["#2156c4", "#683eb8", "#116e4e", "#565b69"];
    const reducedMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");

    const pts = Array.from({ length: count }, (_, i) => {
      const phi = Math.acos(1 - (2 * (i + 0.5)) / count);
      const theta = Math.PI * (1 + Math.sqrt(5)) * i;
      const r = i % 7 === 0 ? 0.65 : 1;
      return {
        x: r * Math.sin(phi) * Math.cos(theta),
        y: r * Math.cos(phi),
        z: r * Math.sin(phi) * Math.sin(theta),
        colorIdx: i % 4,
        isHub: i < 4,
      };
    });

    const edges: Array<[number, number]> = [];
    for (let i = 0; i < count; i++) {
      edges.push([i, (i + 3) % count]);
      if (i % 2 === 0) edges.push([i, (i * 5 + 1) % count]);
    }

    let w = 260;
    let h = 156;
    const resize = () => {
      w = Math.max(180, wrap.clientWidth);
      h = Math.max(136, wrap.clientHeight);
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
    };
    resize();

    const ro = new ResizeObserver(resize);
    ro.observe(wrap);

    let angleY = 0.4;
    let raf = 0;

    const renderFrame = (advance: boolean) => {
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const isLight = document.documentElement.dataset.theme !== "dark";
      const colors = isLight ? paletteLight : paletteDark;

      ctx.save();
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, w, h);

      const cx = w * 0.5;
      const cy = h * 0.5;
      const radius = Math.min(w, h) * 0.36;

      ctx.strokeStyle = isLight
        ? "rgba(23, 25, 31, 0.1)"
        : "rgba(255, 255, 255, 0.08)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(cx, cy, radius * 1.04, 0, Math.PI * 2);
      ctx.stroke();

      if (advance) {
        angleY += 0.004;
      }
      const cosY = Math.cos(angleY);
      const sinY = Math.sin(angleY);
      const cosX = Math.cos(0.26);
      const sinX = Math.sin(0.26);

      const projected = pts.map((p) => {
        const x1 = p.x * cosY - p.z * sinY;
        const z1 = p.z * cosY + p.x * sinY;
        const y2 = p.y * cosX - z1 * sinX;
        const z2 = z1 * cosX + p.y * sinX;
        const persp = 2.6 / (2.6 - z2 * 0.82);
        return {
          sx: cx + x1 * radius * persp,
          sy: cy + y2 * radius * persp,
          z: z2,
          scale: persp,
          color: colors[p.colorIdx],
          isHub: p.isHub,
        };
      });

      edges.forEach(([aIdx, bIdx]) => {
        const a = projected[aIdx];
        const b = projected[bIdx];
        const depthAlpha = Math.max(0.05, ((a.z + b.z) * 0.5 + 1) * 0.14);
        ctx.strokeStyle = isLight
          ? `rgba(33, 86, 196, ${depthAlpha})`
          : `rgba(130, 184, 255, ${depthAlpha})`;
        ctx.lineWidth = 0.8;
        ctx.beginPath();
        ctx.moveTo(a.sx, a.sy);
        ctx.lineTo(b.sx, b.sy);
        ctx.stroke();
      });

      projected
        .slice()
        .sort((a, b) => a.z - b.z)
        .forEach((n) => {
          const alpha = Math.max(0.3, (n.z + 1.2) * 0.45);
          const r = (n.isHub ? 3.2 : 2.0) * n.scale;
          ctx.fillStyle = n.color;
          ctx.globalAlpha = Math.min(1, alpha + 0.12);
          ctx.beginPath();
          ctx.arc(n.sx, n.sy, r, 0, Math.PI * 2);
          ctx.fill();
        });

      ctx.restore();
    };

    const tick = () => {
      if (reducedMotionQuery.matches || document.hidden) {
        renderFrame(false);
        raf = 0;
        return;
      }
      renderFrame(true);
      raf = window.requestAnimationFrame(tick);
    };

    const startOrStop = () => {
      if (raf) {
        window.cancelAnimationFrame(raf);
        raf = 0;
      }
      if (reducedMotionQuery.matches || document.hidden) {
        renderFrame(false);
      } else {
        raf = window.requestAnimationFrame(tick);
      }
    };

    startOrStop();
    const onVisibilityChange = () => startOrStop();
    document.addEventListener("visibilitychange", onVisibilityChange);
    reducedMotionQuery.addEventListener("change", onVisibilityChange);

    return () => {
      window.cancelAnimationFrame(raf);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      reducedMotionQuery.removeEventListener("change", onVisibilityChange);
      ro.disconnect();
    };
  }, [nodesCount, edgesCount]);

  return (
    <div
      ref={wrapRef}
      onClick={onOpen}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      className="relative h-40 w-full cursor-pointer overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--graph-bg)]"
      title="Open Knowledge Graph"
    >
      <canvas ref={canvasRef} className="block h-full w-full" />
      <div className="pointer-events-none absolute right-2.5 bottom-2 left-2.5 flex items-center justify-between text-[11px]">
        <span className="rounded-md border border-[var(--line)] bg-[var(--graph-pill)] px-2 py-0.5 font-mono text-[10px] text-[var(--ink-secondary)]">
          {nodesCount} nodes · {edgesCount} edges
        </span>
        <span className="rounded-md border border-[var(--line)] bg-[var(--graph-pill)] px-2 py-0.5 font-medium text-[var(--accent)]">
          Open Graph →
        </span>
      </div>
    </div>
  );
}
