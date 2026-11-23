import React, { useEffect, useRef, useState } from "react";
import {
  ArrowUpRight,
  Compass,
  Eye,
  Loader2,
  Play,
  Sparkles,
  Square,
  X,
} from "lucide-react";
import { api } from "../lib/api";
import type { JumpTarget, MissionItem, SearchHit, WorkspaceId } from "../types/api";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { useToast } from "./ToastContext";

type CommandIntent = "ask" | "mission" | "dry_run";

const SPECIALIST_LABELS: Record<string, string> = {
  "chief-of-staff": "Chief of Staff",
  "memory-curator": "Memory Curator",
  "engineering-specialist": "Engineering",
  "comms-specialist": "Communications",
  "meetings-specialist": "Meetings",
  "sre-observer": "Infrastructure",
};

function formatSpecialistLabel(id?: string): string {
  if (!id) return "Orchestrator";
  if (SPECIALIST_LABELS[id]) return SPECIALIST_LABELS[id];
  return id
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (ch) => ch.toUpperCase());
}

function formatDomainLabel(domain?: string): string {
  if (!domain) return "Executive";
  return domain
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (ch) => ch.toUpperCase());
}

function formatAutonomyModeLabel(mode?: string): string {
  if (mode === "observe") return "Read-only";
  if (mode === "autopilot") return "Auto-execute";
  return "Approval-gated";
}

function formatRiskLabel(risk?: string): string {
  if (risk === "high") return "High risk";
  if (risk === "medium") return "Moderate risk";
  return "Low risk";
}

export function OrchestratorBar({
  activeWorkspace,
  autonomyPosture,
  systemPaused,
  onNavigate,
  onJumpToEntity,
  onStateMutated,
  autoFocus = false,
  spatial = false,
  onClose,
}: {
  activeWorkspace: WorkspaceId;
  autonomyPosture: string;
  systemPaused: boolean;
  onNavigate: (ws: WorkspaceId) => void;
  onJumpToEntity?: (target: JumpTarget) => void;
  onStateMutated: () => void;
  autoFocus?: boolean;
  spatial?: boolean;
  onClose?: () => void;
}) {
  const { pushToast } = useToast();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const [mode, setMode] = useState<CommandIntent>("ask");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [streaming, setStreaming] = useState(false);

  const [answerResult, setAnswerResult] = useState<{
    answer_md: string;
    citations: SearchHit[];
    mode?: string;
  } | null>(null);
  const [missionResult, setMissionResult] = useState<MissionItem | null>(null);

  useEffect(() => {
    if (autoFocus) {
      const id = window.requestAnimationFrame(() => inputRef.current?.focus());
      return () => window.cancelAnimationFrame(id);
    }
  }, [autoFocus]);

  useEffect(() => {
    const focusCommandBar = () => {
      window.requestAnimationFrame(() => {
        const el = inputRef.current;
        if (!el) return;
        el.scrollIntoView({ behavior: "smooth", block: "nearest" });
        el.focus();
        el.select();
      });
    };
    window.addEventListener("command-engine:focus-command-bar", focusCommandBar);
    return () => {
      window.removeEventListener("command-engine:focus-command-bar", focusCommandBar);
    };
  }, []);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const stopStreaming = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setStreaming(false);
    setBusy(false);
  };

  useEffect(() => {
    if (!onClose && !streaming) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (streaming) {
          e.preventDefault();
          e.stopImmediatePropagation();
          stopStreaming();
          return;
        }
        if (onClose) {
          e.stopImmediatePropagation();
          onClose();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, streaming]);

  const workspacePlaceholders: Record<WorkspaceId, string> = {
    Orbit: "Ask anything across your workspace, preview a plan, or start a mission…",
    Approvals: "Ask about pending reviews, diffs, or outbound guardrails…",
    Work: "Triage tasks, delegate work safely, or ask what's blocking top priorities…",
    Missions: "Start a multi-step agent mission with approval guardrails…",
    Changes: "Summarize unread messages, emails, and code updates since your last check…",
    Meetings: "Prepare a call brief, extract action items, or draft follow-ups…",
    Memory: "Search your second brain, compile wiki pages, or ask a grounded question…",
    Studio: "Synthesize an audio briefing, run a council, or review flashcards…",
    Engineering: "Inspect worktrees, review a diff, or run tests on a repo…",
    System: "Ask about settings, integrations, providers, or local runtimes…",
  };

  const handleCitationClick = (hit: SearchHit) => {
    if (hit.kind === "task") {
      if (onJumpToEntity) onJumpToEntity({ workspace: "Work", id: hit.id });
      else onNavigate("Work");
      onClose?.();
      return;
    }
    if (hit.kind === "approval") {
      if (onJumpToEntity) onJumpToEntity({ workspace: "Approvals", id: hit.id });
      else onNavigate("Approvals");
      onClose?.();
      return;
    }
    if (hit.kind === "meeting") {
      if (onJumpToEntity) onJumpToEntity({ workspace: "Meetings", id: hit.id });
      else onNavigate("Meetings");
      onClose?.();
      return;
    }
    if (hit.kind === "mission") {
      if (onJumpToEntity) onJumpToEntity({ workspace: "Missions", id: String(hit.id) });
      else onNavigate("Missions");
      onClose?.();
      return;
    }
    if (hit.url && hit.url.startsWith("http")) {
      window.open(hit.url, "_blank", "noopener,noreferrer");
      return;
    }
    onNavigate("Changes");
    onClose?.();
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = prompt.trim();
    if (!trimmed || busy) return;

    if (mode === "ask") {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setBusy(true);
      setStreaming(true);
      setMissionResult(null);
      setAnswerResult({ answer_md: "", citations: [], mode: undefined });

      try {
        await api.askStream(trimmed, {
          signal: controller.signal,
          onToken: (token) => {
            setAnswerResult((prev) => ({
              answer_md: (prev?.answer_md ?? "") + token,
              citations: prev?.citations ?? [],
              mode: prev?.mode,
            }));
          },
          onCitations: (citations) => {
            setAnswerResult((prev) => ({
              answer_md: prev?.answer_md ?? "",
              citations,
              mode: prev?.mode,
            }));
          },
          onDone: (result) => {
            setAnswerResult({
              answer_md: result.answer_md,
              citations: result.citations,
              mode: result.mode,
            });
          },
        });
      } catch (err) {
        if (!controller.signal.aborted) {
          pushToast(
            "error",
            "Could not complete question",
            err instanceof Error ? err.message : String(err)
          );
          setAnswerResult((prev) =>
            prev && !prev.answer_md ? null : prev
          );
        }
      } finally {
        if (abortRef.current === controller) {
          abortRef.current = null;
        }
        setStreaming(false);
        setBusy(false);
      }
      return;
    }

    setBusy(true);
    try {
      const isDry = mode === "dry_run";
      const res = await api.dispatchMission({
        instruction: trimmed,
        dry_run: isDry,
        stage_outbound_if_needed: !isDry && autonomyPosture !== "observe",
      });
      setAnswerResult(null);
      setMissionResult(res.mission);
      if (!isDry) {
        onStateMutated();
        pushToast(
          "success",
          res.mission.status === "awaiting_approval"
            ? "Mission staged for approval"
            : "Mission completed",
          res.mission.title
        );
      }
    } catch (err) {
      pushToast(
        "error",
        "Request failed",
        err instanceof Error ? err.message : String(err)
      );
    } finally {
      setBusy(false);
    }
  };

  const executePreviewedPlan = async () => {
    if (!missionResult?.dry_run || !prompt.trim()) return;
    setBusy(true);
    try {
      const res = await api.dispatchMission({
        instruction: prompt.trim(),
        dry_run: false,
        stage_outbound_if_needed: autonomyPosture !== "observe",
      });
      setMissionResult(res.mission);
      onStateMutated();
      pushToast("success", "Mission started", res.mission.title);
    } catch (err) {
      pushToast(
        "error",
        "Could not start mission",
        err instanceof Error ? err.message : String(err)
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative z-30 mx-auto w-full max-w-3xl">
      {/* Inline expandable answer / mission preview drawer */}
      {(answerResult || missionResult) && (
        <div
          aria-live="polite"
          className={`${
            spatial ? "ce-spatial-capsule rounded-2xl" : "ce-card ce-float"
          } ce-contain-scroll mb-2.5 max-h-[50vh] overflow-y-auto p-4`}
        >
          <div className="mb-2.5 flex items-center justify-between gap-3 border-b border-[var(--line)] pb-2">
            <div className="flex items-center gap-2">
              <Sparkles
                className={`h-3.5 w-3.5 text-[var(--accent)] ${
                  streaming ? "animate-pulse" : ""
                }`}
              />
              <span className="text-xs font-semibold text-[var(--ink)]">
                {answerResult
                  ? streaming
                    ? "Thinking…"
                    : `Answer${
                        answerResult.mode === "fts5_offline"
                          ? " · Offline Search"
                          : ""
                      }`
                  : missionResult?.dry_run
                  ? `Action Plan Preview · ${formatDomainLabel(missionResult.domain)}`
                  : `Mission · ${formatDomainLabel(missionResult?.status)}`}
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              {streaming && (
                <button
                  type="button"
                  onClick={stopStreaming}
                  className="ce-btn ce-btn-coral h-6 px-2 text-[11px]"
                >
                  <Square className="h-2.5 w-2.5 fill-current" />
                  <span>Stop</span>
                </button>
              )}
              {missionResult && !missionResult.dry_run && (
                <button
                  type="button"
                  onClick={() => {
                    setMissionResult(null);
                    onClose?.();
                    onNavigate(
                      missionResult.status === "awaiting_approval"
                        ? "Approvals"
                        : "Missions"
                    );
                  }}
                  className="ce-btn ce-btn-accent h-6 px-2.5 text-[11px]"
                >
                  Open in{" "}
                  {missionResult.status === "awaiting_approval"
                    ? "Approvals"
                    : "Missions"}
                  <ArrowUpRight className="h-3 w-3" />
                </button>
              )}
              {missionResult?.dry_run && (
                <button
                  type="button"
                  disabled={busy || systemPaused}
                  onClick={executePreviewedPlan}
                  className="ce-btn ce-btn-primary h-6 px-2.5 text-[11px]"
                >
                  <Play className="h-3 w-3" />
                  Run This Plan
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  stopStreaming();
                  setAnswerResult(null);
                  setMissionResult(null);
                }}
                className="ce-btn ce-btn-ghost h-6 w-6 p-0"
                aria-label="Close response"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>

          {answerResult && (
            <div className="space-y-3">
              {answerResult.answer_md ? (
                <div className="ce-prose-measure text-[13px] text-[var(--ink)]">
                  <MarkdownRenderer content={answerResult.answer_md} />
                </div>
              ) : streaming ? (
                <div className="space-y-2 py-1">
                  <div className="ce-skeleton h-3.5 w-4/5" />
                  <div className="ce-skeleton h-3.5 w-3/5" />
                </div>
              ) : null}

              {answerResult.citations.length > 0 && (
                <div className="border-t border-[var(--line)] pt-2.5">
                  <p className="mb-1.5 text-[11px] font-medium text-[var(--muted)]">
                    Sources ({answerResult.citations.length})
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {answerResult.citations.slice(0, 6).map((c, i) => (
                      <button
                        key={`${c.kind}-${c.id}-${i}`}
                        type="button"
                        onClick={() => handleCitationClick(c)}
                        className="ce-pill cursor-pointer text-[11px] transition hover:border-[var(--accent-border)] hover:bg-[var(--accent-soft)] hover:text-[var(--ink)]"
                        title={c.summary || c.title}
                      >
                        <span className="font-mono text-[var(--accent)]">
                          [{c.ref || `S${i + 1}`}]
                        </span>
                        <span className="max-w-[200px] truncate">{c.title}</span>
                        <ArrowUpRight className="h-2.5 w-2.5 text-[var(--subtle)]" />
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {missionResult && (
            <div className="space-y-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                <span className="font-medium text-[var(--ink)]">
                  {missionResult.title}
                </span>
                <div className="flex flex-wrap items-center gap-1.5">
                  <span
                    className={`ce-pill ${
                      missionResult.risk_level === "high"
                        ? "ce-pill-coral"
                        : missionResult.risk_level === "medium"
                        ? "ce-pill-amber"
                        : ""
                    }`}
                  >
                    {formatRiskLabel(missionResult.risk_level)}
                  </span>
                  <span className="ce-pill">
                    {formatAutonomyModeLabel(missionResult.autonomy_mode)}
                  </span>
                  {(() => {
                    const mr = missionResult.model_route;
                    const modelLabel =
                      typeof mr === "string"
                        ? mr
                        : mr && typeof mr === "object" && typeof mr.model === "string"
                        ? mr.model
                        : "";
                    return modelLabel ? (
                      <span className="ce-pill font-mono text-[10.5px] text-[var(--muted)]">
                        {modelLabel}
                      </span>
                    ) : null;
                  })()}
                </div>
              </div>
              <div className="divide-y divide-[var(--line)] rounded-lg border border-[var(--line)] bg-[var(--surface-sunken)]">
                {(missionResult.steps?.length
                  ? missionResult.steps
                  : missionResult.plan || []
                ).map((step) => (
                  <div
                    key={step.seq}
                    className="flex items-center justify-between gap-3 px-3 py-2 text-xs"
                  >
                    <div className="flex items-center gap-2.5">
                      <span className="font-mono text-[11px] text-[var(--muted)] tabular-nums">
                        0{step.seq}
                      </span>
                      <span className="text-[var(--ink)]">{step.title}</span>
                    </div>
                    <span className="shrink-0 text-[11px] text-[var(--muted)]">
                      {formatSpecialistLabel(step.specialist_id)}
                    </span>
                  </div>
                ))}
              </div>
              {missionResult.result_summary && (
                <div className="ce-prose-measure pt-1 text-xs text-[var(--ink-secondary)]">
                  <MarkdownRenderer content={missionResult.result_summary} />
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Unified Command Bar */}
      <form
        onSubmit={handleSubmit}
        className={`${
          spatial ? "ce-spatial-capsule" : "ce-glass ce-float border"
        } flex items-center gap-2 rounded-2xl px-3 py-2 transition-[border-color,box-shadow] duration-150 focus-within:border-[var(--accent-border)] focus-within:ring-2 focus-within:ring-[var(--accent-soft)]`}
      >
        <div
          role="group"
          aria-label="Command mode"
          className="flex shrink-0 items-center rounded-lg border border-[var(--line)] bg-[var(--surface-sunken)] p-0.5"
        >
          {(
            [
              { id: "ask", label: "Ask", icon: Sparkles },
              { id: "mission", label: "Mission", icon: Compass },
              { id: "dry_run", label: "Plan", icon: Eye },
            ] as const
          ).map((tab) => {
            const Icon = tab.icon;
            const active = mode === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                aria-pressed={active}
                onClick={() => setMode(tab.id)}
                className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11.5px] font-medium transition ${
                  active
                    ? "bg-[var(--surface)] text-[var(--ink)] shadow-xs"
                    : "text-[var(--muted)] hover:text-[var(--ink)]"
                }`}
              >
                <Icon className="h-3 w-3" />
                <span>{tab.label}</span>
              </button>
            );
          })}
        </div>

        <input
          ref={inputRef}
          type="text"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder={workspacePlaceholders[activeWorkspace]}
          aria-label="Ask a question or start a mission"
          className="min-w-0 flex-1 bg-transparent px-2 py-1 text-[13px] text-[var(--ink)] placeholder:text-[var(--subtle)] focus:outline-none"
        />

        <span
          className="hidden shrink-0 text-[11px] capitalize text-[var(--muted)] sm:inline-block"
          title="Current approval posture"
        >
          {autonomyPosture}
        </span>

        {streaming ? (
          <button
            type="button"
            onClick={stopStreaming}
            className="ce-btn ce-btn-coral h-7 shrink-0 px-3 text-xs"
          >
            <Square className="h-3 w-3 fill-current" />
            <span>Stop</span>
          </button>
        ) : (
          <button
            type="submit"
            disabled={busy || !prompt.trim() || (mode === "mission" && systemPaused)}
            className="ce-btn ce-btn-primary h-7 shrink-0 px-3 text-xs"
          >
            {busy ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                <span>Working</span>
              </>
            ) : mode === "ask" ? (
              <span>Ask</span>
            ) : mode === "dry_run" ? (
              <span>Preview</span>
            ) : (
              <span>Start</span>
            )}
          </button>
        )}

        {onClose && (
          <button
            type="button"
            onClick={() => {
              stopStreaming();
              onClose();
            }}
            className="ce-btn ce-btn-ghost h-7 w-7 shrink-0 p-0"
            aria-label="Close command bar"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </form>
    </div>
  );
}
