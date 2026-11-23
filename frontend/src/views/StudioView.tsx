import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BookmarkPlus,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  ExternalLink,
  Headphones,
  Layers,
  Pause,
  Play,
  Plus,
  RefreshCw,
  RotateCw,
  Search,
  Sparkles,
} from "lucide-react";
import { api } from "../lib/api";
import { formatRelativeTime } from "../lib/format";
import { getApiBaseUrl } from "../lib/platform";
import type {
  AudioBriefingItem,
  CouncilResponse,
  DecisionLedgerItem,
  FlashcardItem,
  MeetingItem,
  ResearchResponse,
  VaultNoteSummary,
} from "../types/api";
import { EmptyState, ErrorBanner, SkeletonRows } from "../components/Badges";
import { MarkdownRenderer } from "../components/MarkdownRenderer";
import { ModalDialog } from "../components/Overlays";
import { useToast } from "../components/ToastContext";
import { WorkspaceHeader } from "../components/WorkspaceHeader";

export interface StudioViewProps {
  refreshSignal: number;
  onStateMutated: () => void;
  onOpenNote?: (slug: string) => void;
}

type StudioSubTab = "notebook" | "audio" | "council" | "flashcards" | "research";
type SynthFormat = "briefing_doc" | "study_guide" | "faq" | "mindmap_md";

const SYNTH_FORMATS: Array<{ id: SynthFormat; label: string }> = [
  { id: "briefing_doc", label: "Briefing" },
  { id: "study_guide", label: "Study Guide" },
  { id: "faq", label: "FAQ" },
  { id: "mindmap_md", label: "Mind-Map" },
];

const PLAYBACK_SPEEDS = [1, 1.25, 1.5, 2] as const;
const WAVEFORM_BAR_COUNT = 48;

function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9\-_]+/g, "-")
      .replace(/^-+|-+$/g, "") || `studio-${Date.now()}`
  );
}

function triggerMarkdownDownload(filename: string, content: string) {
  const safeName = filename.endsWith(".md") ? filename : `${filename}.md`;
  const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = safeName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function formatAudioSeconds(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "0:00";
  const total = Math.floor(sec);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function resolveMediaUrl(url: string): string {
  if (!url) return "";
  if (url.startsWith("http://") || url.startsWith("https://")) return url;
  const base = getApiBaseUrl();
  if (!base) return url;
  return `${base}${url.startsWith("/") ? url : `/${url}`}`;
}

function normalizeHostLabel(rawSpeaker: string): {
  label: string;
  isSecondHost: boolean;
} {
  const clean = rawSpeaker.trim();
  if (/alba|aria|maya|host\s*b|speaker\s*2/i.test(clean)) {
    return { label: "Host B", isSecondHost: true };
  }
  if (/marius|guy|alex|host\s*a|speaker\s*1/i.test(clean)) {
    return { label: "Host A", isSecondHost: false };
  }
  if (!clean || /^narrator$/i.test(clean)) {
    return { label: "Host A", isSecondHost: false };
  }
  return { label: clean, isSecondHost: false };
}

function computeWaveformBars(
  seedKey: string,
  count = WAVEFORM_BAR_COUNT
): number[] {
  let hash = 2166136261;
  for (let i = 0; i < seedKey.length; i++) {
    hash ^= seedKey.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const bars: number[] = [];
  for (let i = 0; i < count; i++) {
    hash ^= i * 31 + 7;
    hash = Math.imul(hash, 16777619);
    const norm = (Math.abs(hash) % 100) / 100;
    const envelope = Math.sin(((i + 1) / (count + 1)) * Math.PI);
    const height = Math.round(22 + (norm * 54 + envelope * 24));
    bars.push(Math.min(100, Math.max(18, height)));
  }
  return bars;
}

function parseDialogueLines(
  script: unknown
): Array<{ speaker: string; text: string }> {
  if (Array.isArray(script)) {
    return script
      .map((entry) => {
        if (entry && typeof entry === "object") {
          const rec = entry as Record<string, unknown>;
          const rawSpeaker = String(rec.speaker ?? rec.host ?? "Host A").trim();
          const text = String(rec.text ?? rec.line ?? rec.content ?? "").trim();
          return { speaker: normalizeHostLabel(rawSpeaker).label, text };
        }
        return { speaker: "Host A", text: String(entry ?? "").trim() };
      })
      .filter((turn) => turn.text.length > 0);
  }

  if (typeof script !== "string" || !script.trim()) return [];
  const trimmed = script.trim();

  if (trimmed.startsWith("[")) {
    try {
      const parsedJson = JSON.parse(trimmed) as unknown;
      if (Array.isArray(parsedJson)) return parseDialogueLines(parsedJson);
    } catch {
      // fall through
    }
  }

  const lines = trimmed
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const parsed: Array<{ speaker: string; text: string }> = [];
  for (const line of lines) {
    const m = line.match(
      /^(Marius|Alba|Alex|Maya|Host\s*[AB]|Guy|Aria|Speaker\s*[12])\s*[:\-–]\s*(.+)$/i
    );
    if (m) {
      parsed.push({
        speaker: normalizeHostLabel(m[1]).label,
        text: m[2].trim(),
      });
    } else if (parsed.length > 0) {
      parsed[parsed.length - 1].text += ` ${line}`;
    } else {
      parsed.push({ speaker: "Host A", text: line });
    }
  }
  return parsed;
}

export function StudioView({
  refreshSignal,
  onStateMutated,
  onOpenNote,
}: StudioViewProps) {
  const { pushToast } = useToast();
  const [activeTab, setActiveTab] = useState<StudioSubTab>("notebook");

  // Grounding Sources (accessible from header pill popover/modal)
  const [vaultNotes, setVaultNotes] = useState<VaultNoteSummary[]>([]);
  const [meetings, setMeetings] = useState<MeetingItem[]>([]);
  const [selectedSlugs, setSelectedSlugs] = useState<string[]>([]);
  const [selectedMeetingIds, setSelectedMeetingIds] = useState<number[]>([]);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [sourceSearch, setSourceSearch] = useState("");

  // Tab 1: Synthesize (notebook)
  const [synthFormat, setSynthFormat] = useState<SynthFormat>("briefing_doc");
  const [synthPrompt, setSynthPrompt] = useState("");
  const [synthesizing, setSynthesizing] = useState(false);
  const [synthOutput, setSynthOutput] = useState("");
  const [synthResultTitle, setSynthResultTitle] = useState("");
  const [copiedSynth, setCopiedSynth] = useState(false);
  const [savingSynthVault, setSavingSynthVault] = useState(false);

  // Tab 2: Audio
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [audioItems, setAudioItems] = useState<AudioBriefingItem[]>([]);
  const [loadingAudio, setLoadingAudio] = useState(true);
  const [audioError, setAudioError] = useState<string | null>(null);
  const [selectedAudioId, setSelectedAudioId] = useState<string | number | null>(
    null
  );
  const [audioTopic, setAudioTopic] = useState("");
  const [audioMode, setAudioMode] = useState<"morning_briefing" | "deep_dive">(
    "morning_briefing"
  );
  const [generatingAudio, setGeneratingAudio] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [speedIndex, setSpeedIndex] = useState(0);

  // Tab 3: Council & Decision Ledger
  const [councilPrompt, setCouncilPrompt] = useState("");
  const [convening, setConvening] = useState(false);
  const [councilRes, setCouncilRes] = useState<CouncilResponse | null>(null);
  const [expandedPanelists, setExpandedPanelists] = useState<
    Record<number, boolean>
  >({});
  const [decisions, setDecisions] = useState<DecisionLedgerItem[]>([]);
  const [decisionModalOpen, setDecisionModalOpen] = useState(false);
  const [decTitle, setDecTitle] = useState("");
  const [decDecision, setDecDecision] = useState("");
  const [decAlternatives, setDecAlternatives] = useState("");
  const [decRationale, setDecRationale] = useState("");
  const [decRepo, setDecRepo] = useState("");
  const [addingDecision, setAddingDecision] = useState(false);

  // Tab 4: Recall (flashcards)
  const [cards, setCards] = useState<FlashcardItem[]>([]);
  const [dueNow, setDueNow] = useState(0);
  const [dueOnly, setDueOnly] = useState(true);
  const [loadingCards, setLoadingCards] = useState(true);
  const [cardsError, setCardsError] = useState<string | null>(null);
  const [cardIndex, setCardIndex] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [reviewingCard, setReviewingCard] = useState(false);

  const [genModalOpen, setGenModalOpen] = useState(false);
  const [genDeck, setGenDeck] = useState("Knowledge Vault");
  const [genTitle, setGenTitle] = useState("");
  const [genText, setGenText] = useState("");
  const [genCount, setGenCount] = useState(5);
  const [generatingCards, setGeneratingCards] = useState(false);

  // Tab 5: Research
  const [researchQuery, setResearchQuery] = useState("");
  const [researching, setResearching] = useState(false);
  const [researchRes, setResearchRes] = useState<ResearchResponse | null>(null);
  const [savingResearchVault, setSavingResearchVault] = useState(false);

  const loadSources = useCallback(async () => {
    try {
      const [notesRes, meetingsRes] = await Promise.all([
        api.getVaultNotes("all"),
        api.getMeetings(),
      ]);
      setVaultNotes(
        (notesRes.items ?? []).filter((n) => n.origin_kind !== "generated_ast")
      );
      setMeetings(meetingsRes.items ?? []);
    } catch {
      // keep silent; individual tabs handle their own errors
    }
  }, []);

  const loadDecisions = useCallback(async () => {
    try {
      const res = await api.getHermes();
      setDecisions(res.decisions ?? []);
    } catch {
      // ignore
    }
  }, []);

  const loadAudio = useCallback(async () => {
    setLoadingAudio(true);
    setAudioError(null);
    try {
      const res = await api.getAudioBriefings();
      const items = res.items ?? [];
      setAudioItems(items);
      if (items.length > 0) {
        setSelectedAudioId((prev) => prev ?? items[0].id);
      }
    } catch (err) {
      setAudioError(
        err instanceof Error ? err.message : "Failed to load audio briefings"
      );
    } finally {
      setLoadingAudio(false);
    }
  }, []);

  const loadFlashcards = useCallback(async () => {
    setLoadingCards(true);
    setCardsError(null);
    try {
      const res = await api.getFlashcards({ due_only: dueOnly });
      setCards(res.items ?? []);
      setDueNow(res.stats?.due_now ?? 0);
      setCardIndex(0);
      setFlipped(false);
    } catch (err) {
      setCardsError(
        err instanceof Error ? err.message : "Failed to load flashcards"
      );
    } finally {
      setLoadingCards(false);
    }
  }, [dueOnly]);

  useEffect(() => {
    void loadSources();
    void loadDecisions();
    void loadAudio();
  }, [loadSources, loadDecisions, loadAudio, refreshSignal]);

  useEffect(() => {
    void loadFlashcards();
  }, [loadFlashcards, refreshSignal]);

  const selectedMeetingsList = useMemo(
    () => meetings.filter((m) => selectedMeetingIds.includes(m.id)),
    [meetings, selectedMeetingIds]
  );

  const buildGroundingContext = useCallback((): string => {
    const parts: string[] = [];
    if (selectedMeetingsList.length > 0) {
      for (const m of selectedMeetingsList) {
        const body = m.summary_md?.trim() || m.prep_brief_md?.trim() || "";
        if (body) parts.push(`### Meeting: ${m.title}\n${body}`);
      }
    }
    return parts.join("\n\n");
  }, [selectedMeetingsList]);

  const totalSelectedSources = selectedSlugs.length + selectedMeetingIds.length;
  const sourcesButtonLabel =
    totalSelectedSources === 0
      ? "Sources: All Vault"
      : `Sources: ${totalSelectedSources} selected`;

  // Synthesize handler
  const handleSynthesize = async (e: React.FormEvent) => {
    e.preventDefault();
    const slugsToUse =
      selectedSlugs.length > 0
        ? selectedSlugs
        : vaultNotes.slice(0, 10).map((n) => n.slug);

    if (slugsToUse.length === 0 && selectedMeetingsList.length === 0) {
      pushToast("error", "No vault notes or meetings available to synthesize");
      return;
    }

    const focus = synthPrompt.trim();
    const formatLabel =
      SYNTH_FORMATS.find((f) => f.id === synthFormat)?.label ?? "Briefing";
    const title = focus || `${formatLabel} Synthesis`;
    const grounding = buildGroundingContext();
    const extraContext = [focus, grounding].filter(Boolean).join("\n\n");

    setSynthesizing(true);
    try {
      const res = await api.synthesizeNotebook({
        title,
        format: synthFormat,
        source_slugs: slugsToUse,
        extra_context: extraContext || undefined,
      });
      const md = res.content_md || res.output_md || res.result_md || "";
      setSynthOutput(md);
      setSynthResultTitle(res.title || title);
      pushToast("success", "Synthesis ready");
    } catch (err) {
      pushToast(
        "error",
        "Synthesis failed",
        err instanceof Error ? err.message : String(err)
      );
    } finally {
      setSynthesizing(false);
    }
  };

  const handleSaveSynthToMemory = async () => {
    if (!synthOutput.trim()) return;
    setSavingSynthVault(true);
    try {
      const slug = slugify(synthResultTitle || `synthesis-${Date.now()}`);
      await api.saveVaultNote("wiki", slug, {
        title: synthResultTitle || "Studio Synthesis",
        content_md: synthOutput,
      });
      pushToast("success", "Saved to Memory", `wiki/${slug}`);
      onStateMutated();
      await loadSources();
    } catch (err) {
      pushToast(
        "error",
        "Could not save note",
        err instanceof Error ? err.message : String(err)
      );
    } finally {
      setSavingSynthVault(false);
    }
  };

  // Audio handlers
  const activeAudio = useMemo(
    () =>
      audioItems.find((item) => item.id === selectedAudioId) ??
      audioItems[0] ??
      null,
    [audioItems, selectedAudioId]
  );

  const waveformBars = useMemo(
    () =>
      computeWaveformBars(
        activeAudio ? `${activeAudio.id}-${activeAudio.title}` : "default"
      ),
    [activeAudio]
  );

  const dialogueLines = useMemo(
    () => parseDialogueLines(activeAudio?.script),
    [activeAudio]
  );

  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    el.pause();
    el.currentTime = 0;
    setIsPlaying(false);
    setCurrentTime(0);
    setDuration(activeAudio?.duration_est_sec ?? 0);
  }, [activeAudio?.id]);

  const handleToggleAudioPlay = async () => {
    const el = audioRef.current;
    if (!el) return;
    if (el.paused) {
      try {
        el.playbackRate = PLAYBACK_SPEEDS[speedIndex];
        await el.play();
        setIsPlaying(true);
      } catch (err) {
        pushToast(
          "error",
          "Audio playback failed",
          err instanceof Error ? err.message : String(err)
        );
      }
    } else {
      el.pause();
      setIsPlaying(false);
    }
  };

  const handleCycleSpeed = (idx: number) => {
    setSpeedIndex(idx);
    if (audioRef.current) {
      audioRef.current.playbackRate = PLAYBACK_SPEEDS[idx];
    }
  };

  const handleSeekRatio = (ratio: number) => {
    const el = audioRef.current;
    const total = duration || activeAudio?.duration_est_sec || 0;
    if (!el || total <= 0) return;
    const next = Math.max(0, Math.min(total, ratio * total));
    el.currentTime = next;
    setCurrentTime(next);
  };

  const handleGenerateAudio = async (e: React.FormEvent) => {
    e.preventDefault();
    setGeneratingAudio(true);
    try {
      const grounding = buildGroundingContext();
      const notesSnippet = vaultNotes
        .filter((n) => selectedSlugs.includes(n.slug))
        .map((n) => `${n.title}: ${n.excerpt}`)
        .join("\n\n");
      const sourceText = [audioTopic.trim(), grounding, notesSnippet]
        .filter(Boolean)
        .join("\n\n");

      const item = await api.generateAudioBriefing({
        title:
          audioTopic.trim() ||
          (audioMode === "morning_briefing"
            ? "Executive Morning Briefing"
            : "Deep Dive Briefing"),
        mode: audioMode,
        source_text: sourceText || undefined,
      });
      setAudioTopic("");
      setAudioItems((prev) => [item, ...prev.filter((p) => p.id !== item.id)]);
      setSelectedAudioId(item.id);
      pushToast("success", "Audio briefing generated");
      onStateMutated();
    } catch (err) {
      pushToast(
        "error",
        "Audio generation failed",
        err instanceof Error ? err.message : String(err)
      );
    } finally {
      setGeneratingAudio(false);
    }
  };

  // Council handlers
  const handleConveneCouncil = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!councilPrompt.trim()) return;
    setConvening(true);
    try {
      const grounding = buildGroundingContext();
      const prompt = grounding
        ? `${councilPrompt.trim()}\n\nContext:\n${grounding}`
        : councilPrompt.trim();
      const res = await api.conveneCouncil(prompt);
      setCouncilRes(res);
      setExpandedPanelists({});
      if (res.disabled) {
        pushToast("info", "Council unavailable in current AI mode", res.disabled_reason);
      } else {
        pushToast("success", "Council deliberation complete");
      }
    } catch (err) {
      pushToast(
        "error",
        "Council failed",
        err instanceof Error ? err.message : String(err)
      );
    } finally {
      setConvening(false);
    }
  };

  const handleAddDecision = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!decTitle.trim() || !decDecision.trim()) return;
    setAddingDecision(true);
    try {
      await api.addDecision({
        title: decTitle.trim(),
        decision: decDecision.trim(),
        alternatives_ruled_out: decAlternatives.trim(),
        rationale: decRationale.trim(),
        repo: decRepo.trim() || undefined,
      });
      setDecisionModalOpen(false);
      setDecTitle("");
      setDecDecision("");
      setDecAlternatives("");
      setDecRationale("");
      pushToast("success", "Decision logged");
      await loadDecisions();
      onStateMutated();
    } catch (err) {
      pushToast(
        "error",
        "Failed to log decision",
        err instanceof Error ? err.message : String(err)
      );
    } finally {
      setAddingDecision(false);
    }
  };

  // Flashcards handlers
  const activeCard = cards[cardIndex] ?? null;

  const handleReviewCard = async (rating: 1 | 2 | 3 | 4) => {
    if (!activeCard) return;
    setReviewingCard(true);
    try {
      await api.reviewFlashcard(activeCard.id, rating);
      setFlipped(false);
      if (cardIndex + 1 < cards.length) {
        setCardIndex((i) => i + 1);
      } else {
        await loadFlashcards();
      }
      onStateMutated();
    } catch (err) {
      pushToast(
        "error",
        "Review failed",
        err instanceof Error ? err.message : String(err)
      );
    } finally {
      setReviewingCard(false);
    }
  };

  const handleGenerateCards = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!genTitle.trim() || !genText.trim()) return;
    setGeneratingCards(true);
    try {
      await api.generateFlashcards({
        deck: genDeck.trim() || "general",
        source_title: genTitle.trim(),
        source_text: genText.trim(),
        count: genCount,
      });
      setGenModalOpen(false);
      setGenTitle("");
      setGenText("");
      pushToast("success", "Flashcards generated");
      await loadFlashcards();
      onStateMutated();
    } catch (err) {
      pushToast(
        "error",
        "Card generation failed",
        err instanceof Error ? err.message : String(err)
      );
    } finally {
      setGeneratingCards(false);
    }
  };

  // Research handler
  const handleRunResearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!researchQuery.trim()) return;
    setResearching(true);
    try {
      const res = await api.deepResearch({
        query: researchQuery.trim(),
        file_to_wiki: false,
      });
      setResearchRes(res);
      pushToast("success", "Research complete");
    } catch (err) {
      pushToast(
        "error",
        "Research failed",
        err instanceof Error ? err.message : String(err)
      );
    } finally {
      setResearching(false);
    }
  };

  const handleSaveResearchToMemory = async () => {
    if (!researchRes?.report_md) return;
    setSavingResearchVault(true);
    try {
      const slug = slugify(researchQuery || `research-${Date.now()}`);
      await api.saveVaultNote("wiki", slug, {
        title: researchQuery.trim() || "Deep Research Report",
        content_md: researchRes.report_md,
      });
      pushToast("success", "Saved to Memory", `wiki/${slug}`);
      onStateMutated();
      await loadSources();
    } catch (err) {
      pushToast(
        "error",
        "Failed to save report",
        err instanceof Error ? err.message : String(err)
      );
    } finally {
      setSavingResearchVault(false);
    }
  };

  const filteredModalNotes = useMemo(() => {
    const q = sourceSearch.trim().toLowerCase();
    return vaultNotes.filter(
      (n) =>
        !q ||
        n.title.toLowerCase().includes(q) ||
        n.folder.toLowerCase().includes(q)
    );
  }, [vaultNotes, sourceSearch]);

  const filteredModalMeetings = useMemo(() => {
    const q = sourceSearch.trim().toLowerCase();
    return meetings.filter(
      (m) => !q || m.title.toLowerCase().includes(q)
    );
  }, [meetings, sourceSearch]);

  const progressRatio = useMemo(() => {
    const total = duration || activeAudio?.duration_est_sec || 0;
    if (total <= 0) return 0;
    return Math.max(0, Math.min(1, currentTime / total));
  }, [currentTime, duration, activeAudio]);

  return (
    <div className="mx-auto w-full max-w-[1080px] space-y-5 px-6 pt-2 pb-8">
      <WorkspaceHeader
        title="Studio"
        tabs={[
          { id: "notebook", label: "Synthesize" },
          { id: "audio", label: "Audio", count: audioItems.length },
          { id: "council", label: "Council" },
          { id: "flashcards", label: "Recall", count: dueNow },
          { id: "research", label: "Research" },
        ]}
        activeTab={activeTab}
        onTabChange={(id) => setActiveTab(id as StudioSubTab)}
        actions={
          <button
            type="button"
            onClick={() => setSourcesOpen(true)}
            className={`ce-pill cursor-pointer px-3 py-1.5 text-[12px] transition hover:border-[var(--line-strong)] ${
              totalSelectedSources > 0 ? "ce-pill-accent" : ""
            }`}
          >
            <Layers className="h-3.5 w-3.5" strokeWidth={1.75} />
            {sourcesButtonLabel}
          </button>
        }
      />

      {/* Tab 1: Synthesize (notebook) */}
      {activeTab === "notebook" && (
        <div className="space-y-5">
          <form onSubmit={handleSynthesize} className="ce-card space-y-3 p-4">
            <div className="flex flex-wrap items-center gap-1.5">
              {SYNTH_FORMATS.map((fmt) => {
                const active = synthFormat === fmt.id;
                return (
                  <button
                    key={fmt.id}
                    type="button"
                    onClick={() => setSynthFormat(fmt.id)}
                    className={`rounded-full px-3 py-1 text-[12px] font-medium transition-colors ${
                      active
                        ? "bg-[var(--surface-raised)] text-[var(--ink)] ring-1 ring-[var(--line-strong)]"
                        : "text-[var(--muted)] hover:text-[var(--ink)]"
                    }`}
                  >
                    {fmt.label}
                  </button>
                );
              })}
            </div>

            <div className="flex flex-wrap gap-2.5">
              <input
                type="text"
                value={synthPrompt}
                onChange={(e) => setSynthPrompt(e.target.value)}
                placeholder="Focus or question across your selected sources (optional)…"
                className="ce-input min-w-[240px] flex-1"
              />
              <button
                type="submit"
                disabled={synthesizing}
                className="ce-btn ce-btn-primary"
              >
                {synthesizing ? (
                  <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Sparkles className="h-3.5 w-3.5" />
                )}
                Synthesize
              </button>
            </div>
          </form>

          {synthOutput ? (
            <section className="ce-card space-y-5 p-7 lg:p-9">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--line)] pb-4">
                <h2 className="font-editorial text-[24px] leading-tight text-[var(--ink)]">
                  {synthResultTitle}
                </h2>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => {
                      void navigator.clipboard.writeText(synthOutput);
                      setCopiedSynth(true);
                      window.setTimeout(() => setCopiedSynth(false), 1800);
                    }}
                    className="ce-btn ce-btn-ghost py-1 text-[12px]"
                  >
                    {copiedSynth ? (
                      <Check className="h-3.5 w-3.5 text-[var(--sage)]" />
                    ) : (
                      <Copy className="h-3.5 w-3.5" />
                    )}
                    Copy
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      triggerMarkdownDownload(
                        slugify(synthResultTitle || "synthesis"),
                        synthOutput
                      )
                    }
                    className="ce-btn ce-btn-ghost py-1 text-[12px]"
                  >
                    <Download className="h-3.5 w-3.5" />
                    Export
                  </button>
                  <button
                    type="button"
                    disabled={savingSynthVault}
                    onClick={() => void handleSaveSynthToMemory()}
                    className="ce-btn py-1 text-[12px]"
                  >
                    <BookmarkPlus className="h-3.5 w-3.5" />
                    Save to Memory
                  </button>
                </div>
              </div>

              <div className="ce-prose-editorial ce-prose-measure">
                <MarkdownRenderer
                  content={synthOutput}
                  className="ce-prose"
                  onWikilinkClick={(slug) => onOpenNote?.(slug)}
                />
              </div>
            </section>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-3 px-1">
              <p className="text-[12.5px] text-[var(--muted)]">
                Select a format and synthesize a cited document grounded in your selected notes.
              </p>
              <div className="flex flex-wrap items-center gap-1.5">
                {[
                  "Weekly executive summary & open decisions",
                  "Key architectural trade-offs & risks",
                  "Cross-project dependencies & blockers",
                ].map((suggestion) => (
                  <button
                    key={suggestion}
                    type="button"
                    onClick={() => setSynthPrompt(suggestion)}
                    className="rounded-full border border-[var(--line)] bg-[var(--surface)]/60 px-2.5 py-1 text-[11.5px] text-[var(--ink-secondary)] transition-colors hover:border-[var(--line-strong)] hover:text-[var(--ink)]"
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Tab 2: Audio Briefings */}
      {activeTab === "audio" && (
        <div className="space-y-5">
          <form
            onSubmit={handleGenerateAudio}
            className="ce-card flex flex-wrap items-center gap-2.5 p-4"
          >
            <input
              type="text"
              value={audioTopic}
              onChange={(e) => setAudioTopic(e.target.value)}
              placeholder="Topic or focus for your two-host audio briefing…"
              className="ce-input min-w-[220px] flex-1"
            />
            <select
              value={audioMode}
              onChange={(e) =>
                setAudioMode(
                  e.target.value as "morning_briefing" | "deep_dive"
                )
              }
              className="ce-input w-44"
            >
              <option value="morning_briefing">Morning Briefing</option>
              <option value="deep_dive">Deep Dive</option>
            </select>
            <button
              type="submit"
              disabled={generatingAudio}
              className="ce-btn ce-btn-primary"
            >
              {generatingAudio ? (
                <RefreshCw className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Sparkles className="h-3.5 w-3.5" />
              )}
              Generate Audio Briefing
            </button>
          </form>

          {audioError && (
            <ErrorBanner message={audioError} onRetry={() => void loadAudio()} />
          )}

          {loadingAudio ? (
            <div className="ce-card p-6">
              <SkeletonRows rows={4} />
            </div>
          ) : !activeAudio ? (
            <div className="ce-card p-8">
              <EmptyState
                icon={Headphones}
                title="No audio briefings yet"
                description="Generate a two-host neural MP3 briefing from your Vault and meetings."
              />
            </div>
          ) : (
            <div className="space-y-5">
              {/* Sleek Waveform Player */}
              <section className="ce-card space-y-5 p-6">
                <audio
                  ref={audioRef}
                  src={resolveMediaUrl(activeAudio.audio_url)}
                  onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
                  onLoadedMetadata={(e) =>
                    setDuration(
                      e.currentTarget.duration || activeAudio.duration_est_sec
                    )
                  }
                  onEnded={() => setIsPlaying(false)}
                />

                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div>
                    <h2 className="font-editorial text-[24px] leading-tight text-[var(--ink)]">
                      {activeAudio.title}
                    </h2>
                    <p className="mt-1 text-[12px] text-[var(--muted)]">
                      {activeAudio.mode.replace(/_/g, " ")} ·{" "}
                      {formatRelativeTime(activeAudio.created_at)}
                    </p>
                  </div>

                  <div className="flex items-center gap-1">
                    {PLAYBACK_SPEEDS.map((spd, idx) => (
                      <button
                        key={spd}
                        type="button"
                        onClick={() => handleCycleSpeed(idx)}
                        className={`rounded-lg px-2 py-1 font-mono text-[11px] transition-colors ${
                          speedIndex === idx
                            ? "bg-[var(--surface-raised)] text-[var(--ink)] ring-1 ring-[var(--line-strong)]"
                            : "text-[var(--muted)] hover:text-[var(--ink)]"
                        }`}
                      >
                        {spd}x
                      </button>
                    ))}
                  </div>
                </div>

                {/* Controls + 48-Bar Scrubber */}
                <div className="flex items-center gap-4">
                  <button
                    type="button"
                    onClick={() => void handleToggleAudioPlay()}
                    className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[var(--cta-bg)] text-[var(--cta-ink)] transition hover:bg-[var(--cta-hover)]"
                    aria-label={isPlaying ? "Pause" : "Play"}
                  >
                    {isPlaying ? (
                      <Pause className="h-4 w-4 fill-current" />
                    ) : (
                      <Play className="ml-0.5 h-4 w-4 fill-current" />
                    )}
                  </button>

                  <div className="flex flex-1 flex-col gap-1.5">
                    <div
                      className="flex h-10 cursor-pointer items-center gap-[3px]"
                      onClick={(e) => {
                        const rect = e.currentTarget.getBoundingClientRect();
                        const ratio = (e.clientX - rect.left) / rect.width;
                        handleSeekRatio(ratio);
                      }}
                    >
                      {waveformBars.map((h, i) => {
                        const barPos = (i + 1) / waveformBars.length;
                        const active = barPos <= progressRatio;
                        return (
                          <div
                            key={i}
                            className={`flex-1 rounded-full transition-colors ${
                              active
                                ? "bg-[var(--accent)]"
                                : "bg-[var(--line-strong)]"
                            }`}
                            style={{ height: `${h}%` }}
                          />
                        );
                      })}
                    </div>
                    <div className="flex justify-between font-mono text-[11px] tabular-nums text-[var(--muted)]">
                      <span>{formatAudioSeconds(currentTime)}</span>
                      <span>
                        {formatAudioSeconds(
                          duration || activeAudio.duration_est_sec
                        )}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Two-Host Transcript */}
                {dialogueLines.length > 0 && (
                  <div className="max-h-64 space-y-2.5 overflow-y-auto border-t border-[var(--line)] pt-4 ce-contain-scroll">
                    {dialogueLines.map((turn, idx) => (
                      <div key={idx} className="flex gap-3 text-[13px]">
                        <span
                          className={`w-14 shrink-0 font-mono text-[11px] font-medium ${
                            turn.speaker === "Host B"
                              ? "text-[var(--violet)]"
                              : "text-[var(--accent)]"
                          }`}
                        >
                          {turn.speaker}
                        </span>
                        <p className="leading-relaxed text-[var(--ink-secondary)]">
                          {turn.text}
                        </p>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              {/* Compact Track List */}
              {audioItems.length > 1 && (
                <section className="ce-card divide-y divide-[var(--line)] overflow-hidden">
                  {audioItems.map((item) => {
                    const selected = item.id === activeAudio.id;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => setSelectedAudioId(item.id)}
                        className={`flex w-full items-center justify-between gap-4 px-4 py-3 text-left transition-colors ${
                          selected
                            ? "bg-[var(--surface-raised)]"
                            : "hover:bg-[color-mix(in_srgb,var(--ink)_3%,transparent)]"
                        }`}
                      >
                        <div className="min-w-0">
                          <p className="truncate text-[13.5px] font-medium text-[var(--ink)]">
                            {item.title}
                          </p>
                          <p className="text-[11.5px] text-[var(--muted)]">
                            {formatRelativeTime(item.created_at)}
                          </p>
                        </div>
                        <span className="font-mono text-[11.5px] tabular-nums text-[var(--muted)]">
                          {formatAudioSeconds(item.duration_est_sec)}
                        </span>
                      </button>
                    );
                  })}
                </section>
              )}
            </div>
          )}
        </div>
      )}

      {/* Tab 3: Council */}
      {activeTab === "council" && (
        <div className="space-y-5">
          <form
            onSubmit={handleConveneCouncil}
            className="ce-card flex flex-wrap gap-2.5 p-4"
          >
            <input
              type="text"
              value={councilPrompt}
              onChange={(e) => setCouncilPrompt(e.target.value)}
              placeholder="Ask 3 models to deliberate on a trade-off, architecture choice, or strategy…"
              className="ce-input min-w-[240px] flex-1"
            />
            <button
              type="submit"
              disabled={convening || !councilPrompt.trim()}
              className="ce-btn ce-btn-primary"
            >
              {convening ? (
                <RefreshCw className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Sparkles className="h-3.5 w-3.5" />
              )}
              Convene Council
            </button>
          </form>

          {councilRes && (
            <section className="ce-card space-y-5 p-7">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--line)] pb-4">
                <div className="flex items-center gap-2.5">
                  <h2 className="font-editorial text-[24px] leading-tight text-[var(--ink)]">
                    {councilRes.disabled ? "Cloud Multi-Model Required" : "Synthesized Verdict"}
                  </h2>
                  {councilRes.disabled && (
                    <span className="ce-pill text-[11px] text-[var(--amber)]">
                      {councilRes.ai_mode === "local" ? "Local Runtime" : "Limited Mode"}
                    </span>
                  )}
                </div>
                {!councilRes.disabled && (
                  <button
                    type="button"
                    onClick={() => {
                      setDecTitle(councilPrompt.trim().slice(0, 80));
                      setDecDecision(councilRes.synthesis_md.slice(0, 500));
                      setDecisionModalOpen(true);
                    }}
                    className="ce-btn py-1 text-[12px]"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    Record Decision
                  </button>
                )}
              </div>

              <div className="ce-prose-editorial ce-prose-measure">
                <MarkdownRenderer
                  content={councilRes.synthesis_md}
                  className="ce-prose"
                />
              </div>

              {councilRes.panelists?.length > 0 && (
                <div className="space-y-2 border-t border-[var(--line)] pt-4">
                  <p className="text-[12px] font-medium text-[var(--muted)]">
                    Panelist Perspectives
                  </p>
                  <div className="divide-y divide-[var(--line)] rounded-xl border border-[var(--line)]">
                    {councilRes.panelists.map((p, idx) => {
                      const open = Boolean(expandedPanelists[idx]);
                      return (
                        <div key={idx}>
                          <button
                            type="button"
                            onClick={() =>
                              setExpandedPanelists((prev) => ({
                                ...prev,
                                [idx]: !prev[idx],
                              }))
                            }
                            className="flex w-full items-center justify-between px-4 py-3 text-left text-[13px] hover:bg-[var(--surface-raised)]"
                          >
                            <span className="font-medium text-[var(--ink)]">
                              {p.model}
                            </span>
                            <div className="flex items-center gap-3 text-[11.5px] text-[var(--muted)]">
                              <span className="font-mono tabular-nums">
                                {p.latency_ms}ms
                              </span>
                              {open ? (
                                <ChevronDown className="h-4 w-4" />
                              ) : (
                                <ChevronRight className="h-4 w-4" />
                              )}
                            </div>
                          </button>
                          {open && (
                            <div className="border-t border-[var(--line)] bg-[var(--surface-sunken)] px-4 py-4">
                              <MarkdownRenderer
                                content={p.response_md}
                                className="ce-prose text-[13.5px]"
                              />
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </section>
          )}

          {/* Calm Decision Ledger */}
          <section className="ce-card space-y-3 p-5">
            <div className="flex items-center justify-between">
              <h3 className="text-[14px] font-semibold text-[var(--ink)]">
                Decision Ledger
              </h3>
              <button
                type="button"
                onClick={() => setDecisionModalOpen(true)}
                className="ce-btn ce-btn-ghost py-1 text-[12px]"
              >
                <Plus className="h-3.5 w-3.5" />
                Log Decision
              </button>
            </div>

            {decisions.length === 0 ? (
              <p className="text-[12.5px] text-[var(--muted)]">
                No architectural decisions logged yet.
              </p>
            ) : (
              <div className="divide-y divide-[var(--line)]">
                {decisions.slice(0, 8).map((d, idx) => (
                  <div key={d.id ?? idx} className="py-3">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-[13.5px] font-medium text-[var(--ink)]">
                        {d.title}
                      </p>
                      {d.repo && (
                        <span className="font-mono text-[11px] text-[var(--muted)]">
                          {d.repo}
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-[12.5px] text-[var(--ink-secondary)]">
                      {d.decision}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      )}

      {/* Tab 4: Recall (flashcards) */}
      {activeTab === "flashcards" && (
        <div className="mx-auto max-w-xl space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setDueOnly((v) => !v)}
                className="ce-btn py-1 text-[12px]"
              >
                {dueOnly ? `Due Now (${dueNow})` : `All Cards (${cards.length})`}
              </button>
            </div>
            <button
              type="button"
              onClick={() => setGenModalOpen(true)}
              className="ce-btn ce-btn-primary py-1 text-[12px]"
            >
              <Plus className="h-3.5 w-3.5" />
              Generate Cards
            </button>
          </div>

          {cardsError && (
            <ErrorBanner
              message={cardsError}
              onRetry={() => void loadFlashcards()}
            />
          )}

          {loadingCards ? (
            <div className="ce-card p-6">
              <SkeletonRows rows={4} />
            </div>
          ) : !activeCard ? (
            <div className="ce-card p-8 text-center">
              <EmptyState
                icon={Layers}
                title="All caught up"
                description="No flashcards due right now."
                action={
                  <div className="flex gap-2">
                    {dueOnly && (
                      <button
                        type="button"
                        onClick={() => setDueOnly(false)}
                        className="ce-btn"
                      >
                        Browse All Cards
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => setGenModalOpen(true)}
                      className="ce-btn ce-btn-primary"
                    >
                      + Generate Cards
                    </button>
                  </div>
                }
              />
            </div>
          ) : (
            <div className="space-y-4">
              <div
                role="button"
                tabIndex={0}
                onClick={() => setFlipped((f) => !f)}
                onKeyDown={(e) => {
                  if (e.key === " " || e.key === "Enter") {
                    e.preventDefault();
                    setFlipped((f) => !f);
                  }
                }}
                className="ce-card flex min-h-[260px] cursor-pointer flex-col justify-between p-8 text-center transition hover:border-[var(--line-strong)]"
              >
                <div className="flex items-center justify-between text-[11.5px] text-[var(--muted)]">
                  <span>{activeCard.deck}</span>
                  <span className="font-mono tabular-nums">
                    {cardIndex + 1} / {cards.length}
                  </span>
                </div>

                <div className="my-6 space-y-4">
                  <p className="font-editorial text-[22px] leading-snug text-[var(--ink)]">
                    {flipped ? activeCard.back : activeCard.front}
                  </p>
                </div>

                <div className="flex items-center justify-center gap-1.5 text-[11.5px] text-[var(--muted)]">
                  <RotateCw className="h-3 w-3" />
                  {flipped ? "Answer shown · rate recall below" : "Tap to flip"}
                </div>
              </div>

              <div className="grid grid-cols-4 gap-2">
                {(
                  [
                    { rating: 1, label: "Again" },
                    { rating: 2, label: "Hard" },
                    { rating: 3, label: "Good" },
                    { rating: 4, label: "Easy" },
                  ] as const
                ).map((btn) => (
                  <button
                    key={btn.rating}
                    type="button"
                    disabled={reviewingCard || !flipped}
                    onClick={() => void handleReviewCard(btn.rating)}
                    className="ce-btn justify-center py-2.5"
                  >
                    {btn.label}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Tab 5: Deep Research */}
      {activeTab === "research" && (
        <div className="space-y-5">
          <form
            onSubmit={handleRunResearch}
            className="ce-card flex flex-wrap gap-2.5 p-4"
          >
            <input
              type="text"
              value={researchQuery}
              onChange={(e) => setResearchQuery(e.target.value)}
              placeholder="Ask a deep grounded research question across your memory and web…"
              className="ce-input min-w-[240px] flex-1"
            />
            <button
              type="submit"
              disabled={researching || !researchQuery.trim()}
              className="ce-btn ce-btn-primary"
            >
              {researching ? (
                <RefreshCw className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Search className="h-3.5 w-3.5" />
              )}
              Research
            </button>
          </form>

          {researchRes ? (
            <section className="ce-card space-y-5 p-7">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--line)] pb-4">
                <h2 className="font-editorial text-[24px] leading-tight text-[var(--ink)]">
                  Research Report
                </h2>
                <button
                  type="button"
                  disabled={savingResearchVault}
                  onClick={() => void handleSaveResearchToMemory()}
                  className="ce-btn py-1 text-[12px]"
                >
                  <BookmarkPlus className="h-3.5 w-3.5" />
                  Save to Memory
                </button>
              </div>

              <div className="ce-prose-editorial ce-prose-measure">
                <MarkdownRenderer
                  content={researchRes.report_md}
                  className="ce-prose"
                  onWikilinkClick={(slug) => onOpenNote?.(slug)}
                />
              </div>

              {(researchRes.sources?.length ?? 0) > 0 && (
                <div className="space-y-2 border-t border-[var(--line)] pt-4">
                  <p className="text-[12px] font-medium text-[var(--muted)]">
                    Cited Sources
                  </p>
                  <ul className="space-y-1.5 text-[12.5px] text-[var(--ink-secondary)]">
                    {researchRes.sources.map((src, idx) => {
                      if (typeof src === "string") {
                        return <li key={idx}>{src}</li>;
                      }
                      return (
                        <li key={idx} className="flex items-center gap-2">
                          <span>{src.title || src.source || "Source"}</span>
                          {src.url && (
                            <a
                              href={src.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 text-[var(--accent)] hover:underline"
                            >
                              <ExternalLink className="h-3 w-3" />
                            </a>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}
            </section>
          ) : (
            <p className="px-1 text-[12.5px] text-[var(--muted)]">
              Run deep research to synthesize cited findings and optionally save them to Memory.
            </p>
          )}
        </div>
      )}

      {/* Floating Grounding Sources Modal */}
      <ModalDialog
        open={sourcesOpen}
        onClose={() => setSourcesOpen(false)}
        title="Grounding Sources"
        subtitle="Leave unchecked to ground across your entire curated Vault."
        maxWidthClass="max-w-lg"
        footer={
          <div className="flex w-full items-center justify-between">
            <button
              type="button"
              onClick={() => {
                setSelectedSlugs([]);
                setSelectedMeetingIds([]);
              }}
              className="ce-btn ce-btn-ghost text-[12px]"
            >
              Reset (All Vault)
            </button>
            <button
              type="button"
              onClick={() => setSourcesOpen(false)}
              className="ce-btn ce-btn-primary"
            >
              Done
            </button>
          </div>
        }
      >
        <div className="space-y-4">
          <div className="relative">
            <Search
              className="pointer-events-none absolute top-1/2 left-3 h-3.5 w-3.5 -translate-y-1/2 text-[var(--muted)]"
              strokeWidth={1.75}
            />
            <input
              type="search"
              value={sourceSearch}
              onChange={(e) => setSourceSearch(e.target.value)}
              placeholder="Filter notes and meetings…"
              className="ce-input pl-8 text-[12.5px]"
            />
          </div>

          <div className="space-y-2">
            <p className="text-[11.5px] font-medium text-[var(--muted)]">
              Vault Notes ({filteredModalNotes.length})
            </p>
            <div className="max-h-48 divide-y divide-[var(--line)] overflow-y-auto rounded-xl border border-[var(--line)] ce-contain-scroll">
              {filteredModalNotes.map((n) => {
                const checked = selectedSlugs.includes(n.slug);
                return (
                  <label
                    key={`${n.folder}/${n.slug}`}
                    className="flex cursor-pointer items-center gap-3 px-3 py-2 text-[12.5px] hover:bg-[var(--surface-raised)]"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() =>
                        setSelectedSlugs((prev) =>
                          prev.includes(n.slug)
                            ? prev.filter((s) => s !== n.slug)
                            : [...prev, n.slug]
                        )
                      }
                    />
                    <span className="min-w-0 flex-1 truncate text-[var(--ink)]">
                      {n.title}
                    </span>
                    <span className="text-[11px] text-[var(--muted)]">
                      {n.folder}
                    </span>
                  </label>
                );
              })}
            </div>
          </div>

          {filteredModalMeetings.length > 0 && (
            <div className="space-y-2">
              <p className="text-[11.5px] font-medium text-[var(--muted)]">
                Meetings ({filteredModalMeetings.length})
              </p>
              <div className="max-h-36 divide-y divide-[var(--line)] overflow-y-auto rounded-xl border border-[var(--line)] ce-contain-scroll">
                {filteredModalMeetings.map((m) => {
                  const checked = selectedMeetingIds.includes(m.id);
                  return (
                    <label
                      key={m.id}
                      className="flex cursor-pointer items-center gap-3 px-3 py-2 text-[12.5px] hover:bg-[var(--surface-raised)]"
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() =>
                          setSelectedMeetingIds((prev) =>
                            prev.includes(m.id)
                              ? prev.filter((id) => id !== m.id)
                              : [...prev, m.id]
                          )
                        }
                      />
                      <span className="min-w-0 flex-1 truncate text-[var(--ink)]">
                        {m.title}
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </ModalDialog>

      {/* Modal: Generate Flashcards */}
      <ModalDialog
        open={genModalOpen}
        onClose={() => setGenModalOpen(false)}
        title="Generate Flashcards"
        maxWidthClass="max-w-lg"
      >
        <form onSubmit={handleGenerateCards} className="space-y-4">
          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2 space-y-1.5">
              <label className="text-[12px] font-medium text-[var(--ink-secondary)]">
                Deck
              </label>
              <input
                type="text"
                value={genDeck}
                onChange={(e) => setGenDeck(e.target.value)}
                className="ce-input"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-[12px] font-medium text-[var(--ink-secondary)]">
                Count
              </label>
              <input
                type="number"
                min={1}
                max={20}
                value={genCount}
                onChange={(e) => setGenCount(Number(e.target.value) || 5)}
                className="ce-input"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-[12px] font-medium text-[var(--ink-secondary)]">
              Topic / Source Title
            </label>
            <input
              type="text"
              required
              value={genTitle}
              onChange={(e) => setGenTitle(e.target.value)}
              placeholder="e.g. Cortex Memory Invariants"
              className="ce-input"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-[12px] font-medium text-[var(--ink-secondary)]">
              Source Material
            </label>
            <textarea
              required
              rows={6}
              value={genText}
              onChange={(e) => setGenText(e.target.value)}
              placeholder="Paste notes or text to turn into spaced-repetition cards…"
              className="ce-input resize-y"
            />
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={() => setGenModalOpen(false)}
              className="ce-btn ce-btn-ghost"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={generatingCards}
              className="ce-btn ce-btn-primary"
            >
              Generate
            </button>
          </div>
        </form>
      </ModalDialog>

      {/* Modal: Record Decision */}
      <ModalDialog
        open={decisionModalOpen}
        onClose={() => setDecisionModalOpen(false)}
        title="Record Decision"
        maxWidthClass="max-w-lg"
      >
        <form onSubmit={handleAddDecision} className="space-y-3.5">
          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2 space-y-1">
              <label className="text-[12px] font-medium text-[var(--ink-secondary)]">
                Title
              </label>
              <input
                type="text"
                required
                value={decTitle}
                onChange={(e) => setDecTitle(e.target.value)}
                className="ce-input"
              />
            </div>
            <div className="space-y-1">
              <label className="text-[12px] font-medium text-[var(--ink-secondary)]">
                Repo
              </label>
              <input
                type="text"
                value={decRepo}
                onChange={(e) => setDecRepo(e.target.value)}
                className="ce-input"
              />
            </div>
          </div>

          <div className="space-y-1">
            <label className="text-[12px] font-medium text-[var(--ink-secondary)]">
              Decision
            </label>
            <textarea
              required
              rows={3}
              value={decDecision}
              onChange={(e) => setDecDecision(e.target.value)}
              className="ce-input resize-y"
            />
          </div>

          <div className="space-y-1">
            <label className="text-[12px] font-medium text-[var(--ink-secondary)]">
              Alternatives Ruled Out
            </label>
            <input
              type="text"
              value={decAlternatives}
              onChange={(e) => setDecAlternatives(e.target.value)}
              className="ce-input"
            />
          </div>

          <div className="space-y-1">
            <label className="text-[12px] font-medium text-[var(--ink-secondary)]">
              Rationale
            </label>
            <textarea
              rows={2}
              value={decRationale}
              onChange={(e) => setDecRationale(e.target.value)}
              className="ce-input resize-y"
            />
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={() => setDecisionModalOpen(false)}
              className="ce-btn ce-btn-ghost"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={addingDecision}
              className="ce-btn ce-btn-primary"
            >
              Save Decision
            </button>
          </div>
        </form>
      </ModalDialog>
    </div>
  );
}
