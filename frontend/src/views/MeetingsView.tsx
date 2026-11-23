import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Calendar,
  Check,
  ChevronDown,
  ChevronUp,
  Clock,
  Download,
  ExternalLink,
  ListPlus,
  Mic,
  Pause,
  Play,
  Plus,
  Radio,
  RefreshCw,
  Search,
  Send,
  Sparkles,
  Square,
  Upload,
  Users,
  X,
} from "lucide-react";
import { api } from "../lib/api";
import { formatDateTime } from "../lib/format";
import { useListKeyboardNav } from "../lib/useListKeyboardNav";
import type {
  MeetingDossierResponse,
  MeetingItem,
  UpcomingCallPrepItem,
  WorkspaceId,
} from "../types/api";
import { EmptyState, ErrorBanner, SkeletonRows } from "../components/Badges";
import { MarkdownRenderer } from "../components/MarkdownRenderer";
import { ModalDialog } from "../components/Overlays";
import { useToast } from "../components/ToastContext";
import { WorkspaceHeader } from "../components/WorkspaceHeader";

type DetailTab = "summary" | "dossier" | "live_notes" | "transcript";

interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
}

interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: ArrayLike<{
    isFinal: boolean;
    0: { transcript: string };
  }>;
}

export interface MeetingsViewProps {
  refreshSignal: number;
  initialMeetingId?: number | null;
  onNavigate: (ws: WorkspaceId) => void;
  onStateMutated: () => void;
}

function getSpeechRecognitionCtor(): (new () => SpeechRecognitionLike) | null {
  if (typeof window === "undefined") return null;
  const win = window as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  };
  return win.SpeechRecognition ?? win.webkitSpeechRecognition ?? null;
}

function formatTimerClock(totalSeconds: number): string {
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function isDateOnlyString(raw?: string | null): boolean {
  if (!raw) return false;
  return /^\d{4}-\d{2}-\d{2}$/.test(raw.trim());
}

function parseTimestamp(raw?: string | null): number | null {
  if (!raw || !raw.trim() || raw.startsWith("1970-01-01")) return null;
  const trimmed = raw.trim();
  if (isDateOnlyString(trimmed)) {
    const [y, m, d] = trimmed.split("-").map(Number);
    if (!y || !m || !d) return null;
    return new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
  }
  const ts = Date.parse(trimmed);
  return Number.isFinite(ts) ? ts : null;
}

function toLocalDayKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function getMeetingDayKey(m: MeetingItem): string | null {
  if (!m.start_at) return null;
  const trimmed = m.start_at.trim();
  if (isDateOnlyString(trimmed)) return trimmed;
  const ts = parseTimestamp(trimmed);
  if (ts === null) return null;
  return toLocalDayKey(new Date(ts));
}

function formatDayPillLabel(dayKey: string, todayKey: string): string {
  if (dayKey === todayKey) return "Today";
  const [y, m, d] = dayKey.split("-").map(Number);
  if (!y || !m || !d) return dayKey;
  const date = new Date(y, m - 1, d);
  return date.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function formatShortTime(m: MeetingItem): string {
  if (!m.start_at) return "—";
  if (isDateOnlyString(m.start_at)) return "All day";
  const ts = parseTimestamp(m.start_at);
  if (ts === null) return "—";
  return new Date(ts).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function formatHumanSubtitle(m: MeetingItem): string {
  const parts: string[] = [];
  const startTs = parseTimestamp(m.start_at);
  if (startTs !== null) {
    const startDate = new Date(startTs);
    if (isDateOnlyString(m.start_at)) {
      parts.push(
        startDate.toLocaleDateString(undefined, {
          weekday: "short",
          month: "short",
          day: "numeric",
        })
      );
    } else {
      const dateStr = startDate.toLocaleDateString(undefined, {
        weekday: "short",
        month: "short",
        day: "numeric",
      });
      const startTimeStr = startDate.toLocaleTimeString(undefined, {
        hour: "numeric",
        minute: "2-digit",
      });
      const endTs = parseTimestamp(m.end_at);
      if (endTs !== null && endTs > startTs) {
        const endTimeStr = new Date(endTs).toLocaleTimeString(undefined, {
          hour: "numeric",
          minute: "2-digit",
        });
        parts.push(`${dateStr} · ${startTimeStr} – ${endTimeStr}`);
      } else {
        parts.push(`${dateStr} · ${startTimeStr}`);
      }
    }
  }

  const attendees = (m.attendees ?? []).map((a) => a.trim()).filter(Boolean);
  if (attendees.length > 0) {
    const displayNames = attendees
      .slice(0, 4)
      .map((a) => (a.includes("@") ? a.split("@")[0] : a));
    const suffix = attendees.length > 4 ? ` +${attendees.length - 4}` : "";
    parts.push(`${displayNames.join(", ")}${suffix}`);
  }

  return parts.join(" · ") || "Unscheduled note";
}

function sanitizeHttpUrl(raw?: string | null): string | null {
  if (!raw || !raw.trim()) return null;
  try {
    const url = new URL(raw.trim());
    if (url.protocol === "http:" || url.protocol === "https:") {
      return url.toString();
    }
    return null;
  } catch {
    return null;
  }
}

function meetingHasTranscript(m: MeetingItem): boolean {
  const s = (m.transcript_status || "").toLowerCase();
  return Boolean(
    m.raw_transcript?.trim() ||
      m.transcript_url?.trim() ||
      s === "ready" ||
      s === "processed" ||
      s === "available"
  );
}

function meetingHasNotesOrSummary(m: MeetingItem): boolean {
  return Boolean(
    m.summary_md?.trim() ||
      m.raw_transcript?.trim() ||
      (m.my_todos?.length ?? 0) > 0 ||
      (m.waiting_on_others?.length ?? 0) > 0
  );
}

function normalizeMeetingTitleRoot(title: string): string {
  return title
    .split(/[—–-]\s*(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|\d{4})/i)[0]
    .trim()
    .toLowerCase();
}

function computeOverlappingMeetingIds(meetings: MeetingItem[]): Set<number> {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const startOfTodayMs = startOfToday.getTime();

  const windows: Array<{
    id: number;
    start: number;
    end: number;
    titleRoot: string;
  }> = [];
  for (const m of meetings) {
    if (!m.start_at || isDateOnlyString(m.start_at)) continue;
    const start = parseTimestamp(m.start_at);
    if (start === null) continue;
    const rawEnd = !isDateOnlyString(m.end_at) ? parseTimestamp(m.end_at) : null;
    if (rawEnd === null || rawEnd <= start) continue;
    if (rawEnd < startOfTodayMs) continue;
    windows.push({
      id: m.id,
      start,
      end: rawEnd,
      titleRoot: normalizeMeetingTitleRoot(m.title || ""),
    });
  }
  const conflicts = new Set<number>();
  for (let i = 0; i < windows.length; i++) {
    for (let j = i + 1; j < windows.length; j++) {
      const a = windows[i];
      const b = windows[j];
      if (a.titleRoot && a.titleRoot === b.titleRoot) continue;
      if (a.start < b.end && b.start < a.end) {
        conflicts.add(a.id);
        conflicts.add(b.id);
      }
    }
  }
  return conflicts;
}

function slugifyFilename(input: string): string {
  return (
    input
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "meeting-note"
  );
}

function buildMeetingFollowupDraft(meeting: MeetingItem): string {
  const myTodos = meeting.my_todos ?? [];
  const waiting = meeting.waiting_on_others ?? [];
  const lines: string[] = [`Follow-up from "${meeting.title}"`, ""];

  if (meeting.summary_md?.trim()) {
    lines.push(meeting.summary_md.trim().slice(0, 480), "");
  }

  if (myTodos.length > 0) {
    lines.push("Next steps on my end:");
    for (const td of myTodos) {
      lines.push(`- ${td.title}`);
    }
    lines.push("");
  }

  if (waiting.length > 0) {
    lines.push("Open items from others:");
    for (const wt of waiting) {
      lines.push(`- ${wt.counterparty ? `${wt.counterparty}: ` : ""}${wt.title}`);
    }
    lines.push("");
  }

  if (myTodos.length === 0 && waiting.length === 0) {
    lines.push("Thanks for the call — sharing a quick recap and next steps.");
  }

  return lines.join("\n").trim();
}

function loadSavedLiveNote(meetingId: number): string {
  try {
    return localStorage.getItem(`ce:meeting_live_note:${meetingId}`) ?? "";
  } catch {
    return "";
  }
}

function persistLiveNote(meetingId: number, content: string): void {
  try {
    if (content.trim()) {
      localStorage.setItem(`ce:meeting_live_note:${meetingId}`, content);
    } else {
      localStorage.removeItem(`ce:meeting_live_note:${meetingId}`);
    }
  } catch {
    // ignore storage errors
  }
}

type StudioCaptureState = "idle" | "recording" | "paused";

interface StudioDraft {
  title: string;
  attendees: string;
  liveNotes: string;
  transcript: string;
  meetingId: number | null;
}

const STUDIO_DRAFT_KEY = "ce:zero_bot_studio_draft";
const IDLE_MIC_BARS: number[] = [0.14, 0.18, 0.14, 0.2, 0.16, 0.18, 0.14, 0.16];

function loadStudioDraft(): StudioDraft {
  try {
    const raw = localStorage.getItem(STUDIO_DRAFT_KEY);
    if (!raw) {
      return { title: "", attendees: "", liveNotes: "", transcript: "", meetingId: null };
    }
    const parsed = JSON.parse(raw) as Partial<StudioDraft>;
    return {
      title: typeof parsed.title === "string" ? parsed.title : "",
      attendees: typeof parsed.attendees === "string" ? parsed.attendees : "",
      liveNotes: typeof parsed.liveNotes === "string" ? parsed.liveNotes : "",
      transcript: typeof parsed.transcript === "string" ? parsed.transcript : "",
      meetingId: typeof parsed.meetingId === "number" ? parsed.meetingId : null,
    };
  } catch {
    return { title: "", attendees: "", liveNotes: "", transcript: "", meetingId: null };
  }
}

function persistStudioDraft(draft: StudioDraft): void {
  try {
    if (
      draft.title.trim() ||
      draft.attendees.trim() ||
      draft.liveNotes.trim() ||
      draft.transcript.trim() ||
      draft.meetingId !== null
    ) {
      localStorage.setItem(STUDIO_DRAFT_KEY, JSON.stringify(draft));
    } else {
      localStorage.removeItem(STUDIO_DRAFT_KEY);
    }
  } catch {
    // ignore storage errors
  }
}

function getAudioContextCtor(): (new () => AudioContext) | null {
  if (typeof window === "undefined") return null;
  const win = window as unknown as {
    AudioContext?: new () => AudioContext;
    webkitAudioContext?: new () => AudioContext;
  };
  return win.AudioContext ?? win.webkitAudioContext ?? null;
}

function blobToBase64(blob: Blob): Promise<{ base64: string; mime: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const commaIdx = result.indexOf(",");
      const base64 = commaIdx >= 0 ? result.slice(commaIdx + 1) : result;
      resolve({
        base64,
        mime: blob.type || "audio/webm",
      });
    };
    reader.onerror = () => reject(new Error("Failed to read recorded audio"));
    reader.readAsDataURL(blob);
  });
}

export function MeetingsView({
  refreshSignal,
  initialMeetingId,
  onNavigate,
  onStateMutated,
}: MeetingsViewProps) {
  const { pushToast } = useToast();
  const [meetings, setMeetings] = useState<MeetingItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [searchQuery, setSearchQuery] = useState("");
  const [selectedDayKey, setSelectedDayKey] = useState<string>("all");
  const [selectedId, setSelectedId] = useState<number | null>(
    initialMeetingId ?? null
  );
  const [detailTab, setDetailTab] = useState<DetailTab>("summary");
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  // Zero-Bot Live Call Copilot Studio state
  const initialStudioDraft = useMemo(() => loadStudioDraft(), []);
  const [studioExpanded, setStudioExpanded] = useState<boolean>(() =>
    Boolean(
      initialStudioDraft.title.trim() ||
        initialStudioDraft.liveNotes.trim() ||
        initialStudioDraft.transcript.trim() ||
        initialStudioDraft.meetingId !== null
    )
  );
  const [studioTitle, setStudioTitle] = useState(initialStudioDraft.title);
  const [studioAttendees, setStudioAttendees] = useState(initialStudioDraft.attendees);
  const [studioLiveNotes, setStudioLiveNotes] = useState(initialStudioDraft.liveNotes);
  const [studioTranscript, setStudioTranscript] = useState(initialStudioDraft.transcript);
  const [studioInterimTranscript, setStudioInterimTranscript] = useState("");
  const [studioMeetingId, setStudioMeetingId] = useState<number | null>(
    initialStudioDraft.meetingId
  );
  const [studioCaptureState, setStudioCaptureState] =
    useState<StudioCaptureState>("idle");
  const [studioSeconds, setStudioSeconds] = useState(0);
  const [studioMicStatus, setStudioMicStatus] = useState<
    "ready" | "active" | "paused" | "unavailable"
  >("ready");
  const [studioMicBars, setStudioMicBars] = useState<number[]>(IDLE_MIC_BARS);
  const [studioAudioUrl, setStudioAudioUrl] = useState<string | null>(null);
  const [finishingCapture, setFinishingCapture] = useState(false);

  // Up Next Call Prep & Pre-Call Dossier state
  const [upcomingPrep, setUpcomingPrep] = useState<UpcomingCallPrepItem[]>([]);
  const [prepBarDismissedId, setPrepBarDismissedId] = useState<number | null>(null);
  const [dossierByMeetingId, setDossierByMeetingId] = useState<
    Record<number, MeetingDossierResponse>
  >({});
  const [dossierLoadingId, setDossierLoadingId] = useState<number | null>(null);
  const [dossierErrorById, setDossierErrorById] = useState<Record<number, string>>({});

  const studioCardRef = useRef<HTMLElement | null>(null);
  const studioScratchpadRef = useRef<HTMLTextAreaElement | null>(null);
  const studioRecorderRef = useRef<MediaRecorder | null>(null);
  const studioStreamRef = useRef<MediaStream | null>(null);
  const studioSpeechRef = useRef<SpeechRecognitionLike | null>(null);
  const studioChunksRef = useRef<Blob[]>([]);
  const studioRecordedBlobRef = useRef<Blob | null>(null);
  const studioAudioCtxRef = useRef<AudioContext | null>(null);
  const studioAnalyserRef = useRef<AnalyserNode | null>(null);
  const studioRafRef = useRef<number | null>(null);
  const studioCaptureStateRef = useRef<StudioCaptureState>("idle");
  const studioStopResolverRef = useRef<((blob: Blob | null) => void) | null>(null);

  // Action states
  const [processingId, setProcessingId] = useState<number | null>(null);
  const [addedWorkKeys, setAddedWorkKeys] = useState<Record<string, boolean>>({});

  // Live notes scratchpad per selected meeting
  const [liveNotesText, setLiveNotesText] = useState("");
  const [savingLiveNotes, setSavingLiveNotes] = useState(false);
  const [liveNoteSavedAt, setLiveNoteSavedAt] = useState<string | null>(null);

  // Audio recording + optional Web Speech live dictation
  const [isRecording, setIsRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const [recordedAudioUrl, setRecordedAudioUrl] = useState<string | null>(null);
  const [interimTranscript, setInterimTranscript] = useState("");
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const speechRef = useRef<SpeechRecognitionLike | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  // Ingest / New Note Modal
  const [ingestOpen, setIngestOpen] = useState(false);
  const [ingestTitle, setIngestTitle] = useState("");
  const [ingestAttendees, setIngestAttendees] = useState("");
  const [ingestTranscript, setIngestTranscript] = useState("");
  const [ingestAutoProcess, setIngestAutoProcess] = useState(true);
  const [ingesting, setIngesting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Follow-up staging modal
  const [followupOpen, setFollowupOpen] = useState(false);
  const [followupChannel, setFollowupChannel] = useState<"slack" | "gmail">("slack");
  const [followupTarget, setFollowupTarget] = useState("");
  const [followupSubject, setFollowupSubject] = useState("");
  const [followupBody, setFollowupBody] = useState("");
  const [stagingFollowup, setStagingFollowup] = useState(false);

  const loadUpcomingPrep = useCallback(async () => {
    try {
      const res = await api.getUpcomingCallPrep(60);
      setUpcomingPrep(res.items ?? []);
    } catch {
      setUpcomingPrep([]);
    }
  }, []);

  const loadDossier = useCallback(async (meetingId: number, refresh = false) => {
    setDossierLoadingId(meetingId);
    setDossierErrorById((prev) => {
      if (!prev[meetingId]) return prev;
      const copy = { ...prev };
      delete copy[meetingId];
      return copy;
    });
    try {
      const res = await api.getMeetingDossier(meetingId, refresh);
      setDossierByMeetingId((prev) => ({ ...prev, [meetingId]: res }));
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : "Failed to load pre-call dossier";
      setDossierErrorById((prev) => ({ ...prev, [meetingId]: msg }));
    } finally {
      setDossierLoadingId((curr) => (curr === meetingId ? null : curr));
    }
  }, []);

  const loadMeetings = useCallback(async () => {
    setError(null);
    try {
      const res = await api.getMeetings();
      const items = res.items ?? [];
      setMeetings(items);
      setSelectedId((prev) => {
        if (initialMeetingId && items.some((m) => m.id === initialMeetingId)) {
          return initialMeetingId;
        }
        if (prev && items.some((m) => m.id === prev)) return prev;
        return items[0]?.id ?? null;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load meetings");
    } finally {
      setLoading(false);
    }
  }, [initialMeetingId]);

  useEffect(() => {
    void loadMeetings();
    void loadUpcomingPrep();
  }, [loadMeetings, loadUpcomingPrep, refreshSignal]);

  useEffect(() => {
    if (initialMeetingId && meetings.some((m) => m.id === initialMeetingId)) {
      setSelectedId(initialMeetingId);
    }
  }, [initialMeetingId, meetings]);

  const todayKey = useMemo(() => toLocalDayKey(new Date()), []);

  const dayPills = useMemo(() => {
    const keys = new Set<string>();
    for (const m of meetings) {
      const k = getMeetingDayKey(m);
      if (k) keys.add(k);
    }
    return Array.from(keys).sort();
  }, [meetings]);

  const overlappingIds = useMemo(
    () => computeOverlappingMeetingIds(meetings),
    [meetings]
  );

  const filteredMeetings = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return meetings
      .filter((m) => {
        if (selectedDayKey !== "all") {
          const day = getMeetingDayKey(m);
          if (day !== selectedDayKey) return false;
        }
        if (!q) return true;
        return (
          m.title.toLowerCase().includes(q) ||
          (m.attendees ?? []).some((a) => a.toLowerCase().includes(q)) ||
          (m.summary_md ?? "").toLowerCase().includes(q)
        );
      })
      .sort((a, b) => {
        const ta = parseTimestamp(a.start_at) ?? Number.MAX_SAFE_INTEGER;
        const tb = parseTimestamp(b.start_at) ?? Number.MAX_SAFE_INTEGER;
        return ta - tb;
      });
  }, [meetings, searchQuery, selectedDayKey]);

  const selectedMeeting = useMemo(
    () =>
      filteredMeetings.find((m) => m.id === selectedId) ??
      meetings.find((m) => m.id === selectedId) ??
      filteredMeetings[0] ??
      null,
    [filteredMeetings, meetings, selectedId]
  );

  useListKeyboardNav({
    items: filteredMeetings,
    getId: (m) => m.id,
    selectedId: selectedMeeting?.id ?? null,
    onSelect: (id) => setSelectedId(Number(id)),
    searchInputRef,
  });

  // Auto-load Pre-Call Dossier when dossier tab is opened
  useEffect(() => {
    if (detailTab !== "dossier" || !selectedMeeting) return;
    if (
      !dossierByMeetingId[selectedMeeting.id] &&
      dossierLoadingId !== selectedMeeting.id &&
      !dossierErrorById[selectedMeeting.id]
    ) {
      void loadDossier(selectedMeeting.id, false);
    }
  }, [
    detailTab,
    selectedMeeting,
    dossierByMeetingId,
    dossierLoadingId,
    dossierErrorById,
    loadDossier,
  ]);

  // Sync live notes buffer when selected meeting changes
  useEffect(() => {
    if (!selectedMeeting) {
      setLiveNotesText("");
      return;
    }
    const saved = loadSavedLiveNote(selectedMeeting.id);
    setLiveNotesText(saved);
    setLiveNoteSavedAt(null);
  }, [selectedMeeting?.id]);

  // Auto-save live notes softly
  useEffect(() => {
    if (!selectedMeeting) return;
    const handle = window.setTimeout(() => {
      persistLiveNote(selectedMeeting.id, liveNotesText);
      if (liveNotesText.trim()) {
        setLiveNoteSavedAt(
          new Date().toLocaleTimeString(undefined, {
            hour: "2-digit",
            minute: "2-digit",
          })
        );
      }
    }, 350);
    return () => window.clearTimeout(handle);
  }, [liveNotesText, selectedMeeting]);

  // Recording clock
  useEffect(() => {
    if (!isRecording) return;
    const id = window.setInterval(() => {
      setRecordSeconds((s) => s + 1);
    }, 1000);
    return () => window.clearInterval(id);
  }, [isRecording]);

  const stopRecording = useCallback(() => {
    try {
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
        mediaRecorderRef.current.stop();
      }
    } catch {
      // ignore
    }
    if (mediaStreamRef.current) {
      for (const track of mediaStreamRef.current.getTracks()) {
        track.stop();
      }
      mediaStreamRef.current = null;
    }
    try {
      speechRef.current?.stop();
    } catch {
      // ignore
    }
    speechRef.current = null;
    setInterimTranscript("");
    setIsRecording(false);
  }, []);

  useEffect(() => {
    return () => {
      stopRecording();
    };
  }, [stopRecording]);

  const startRecording = useCallback(async () => {
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      pushToast("error", "Microphone unavailable in this environment");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;
      chunksRef.current = [];
      if (recordedAudioUrl) {
        URL.revokeObjectURL(recordedAudioUrl);
        setRecordedAudioUrl(null);
      }

      const recorder = new MediaRecorder(stream);
      recorder.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) {
          chunksRef.current.push(ev.data);
        }
      };
      recorder.onstop = () => {
        if (chunksRef.current.length > 0) {
          const blob = new Blob(chunksRef.current, {
            type: recorder.mimeType || "audio/webm",
          });
          setRecordedAudioUrl(URL.createObjectURL(blob));
        }
      };
      mediaRecorderRef.current = recorder;
      recorder.start(1000);
      setRecordSeconds(0);
      setIsRecording(true);
      setDetailTab("live_notes");

      const SpeechCtor = getSpeechRecognitionCtor();
      if (SpeechCtor) {
        try {
          const sr = new SpeechCtor();
          sr.continuous = true;
          sr.interimResults = true;
          sr.lang = "en-US";
          sr.onresult = (event) => {
            let finalAdd = "";
            let interim = "";
            for (let i = event.resultIndex; i < event.results.length; i++) {
              const res = event.results[i];
              const chunk = res[0]?.transcript ?? "";
              if (res.isFinal) {
                finalAdd += `${chunk.trim()} `;
              } else {
                interim += chunk;
              }
            }
            if (finalAdd.trim()) {
              setLiveNotesText((prev) =>
                prev.trim() ? `${prev.trimEnd()}\n${finalAdd.trim()}` : finalAdd.trim()
              );
            }
            setInterimTranscript(interim);
          };
          sr.onerror = () => {
            setInterimTranscript("");
          };
          sr.start();
          speechRef.current = sr;
        } catch {
          // Audio recording still continues cleanly without Web Speech
        }
      }
      pushToast("info", "Recording started", "Capturing audio into Live Notes");
    } catch (err) {
      pushToast(
        "error",
        "Could not access microphone",
        err instanceof Error ? err.message : String(err)
      );
    }
  }, [pushToast, recordedAudioUrl]);

  const handleToggleRecord = () => {
    if (isRecording) {
      stopRecording();
      pushToast("success", "Recording stopped");
    } else {
      void startRecording();
    }
  };

  // Keep studioCaptureStateRef synced
  useEffect(() => {
    studioCaptureStateRef.current = studioCaptureState;
  }, [studioCaptureState]);

  // Persist Zero-Bot Studio draft softly
  useEffect(() => {
    persistStudioDraft({
      title: studioTitle,
      attendees: studioAttendees,
      liveNotes: studioLiveNotes,
      transcript: studioTranscript,
      meetingId: studioMeetingId,
    });
  }, [studioTitle, studioAttendees, studioLiveNotes, studioTranscript, studioMeetingId]);

  // Live Call 1s elapsed timer (pauses cleanly when paused)
  useEffect(() => {
    if (studioCaptureState !== "recording") return;
    const id = window.setInterval(() => {
      setStudioSeconds((s) => s + 1);
    }, 1000);
    return () => window.clearInterval(id);
  }, [studioCaptureState]);

  const stopStudioMeter = useCallback(() => {
    if (studioRafRef.current !== null) {
      window.cancelAnimationFrame(studioRafRef.current);
      studioRafRef.current = null;
    }
    studioAnalyserRef.current = null;
    if (studioAudioCtxRef.current) {
      const ctx = studioAudioCtxRef.current;
      studioAudioCtxRef.current = null;
      void ctx.close().catch(() => {});
    }
    setStudioMicBars(IDLE_MIC_BARS);
  }, []);

  const startStudioMeter = useCallback(
    (stream: MediaStream) => {
      stopStudioMeter();
      const AudioCtx = getAudioContextCtor();
      if (!AudioCtx) return;
      try {
        const ctx = new AudioCtx();
        if (ctx.state === "suspended") {
          void ctx.resume().catch(() => {});
        }
        const source = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 64;
        analyser.smoothingTimeConstant = 0.78;
        source.connect(analyser);

        studioAudioCtxRef.current = ctx;
        studioAnalyserRef.current = analyser;

        const bins = new Uint8Array(analyser.frequencyBinCount);
        let lastUiUpdate = 0;

        const tick = (now: number) => {
          const activeAnalyser = studioAnalyserRef.current;
          if (!activeAnalyser) return;
          if (studioCaptureStateRef.current === "recording" && now - lastUiUpdate >= 60) {
            lastUiUpdate = now;
            activeAnalyser.getByteFrequencyData(bins);
            const nextBars: number[] = [];
            const bandSize = Math.max(1, Math.floor(Math.min(16, bins.length) / 8));
            for (let b = 0; b < 8; b++) {
              let sum = 0;
              for (let k = 0; k < bandSize; k++) {
                sum += bins[b * bandSize + k] ?? 0;
              }
              const avg = sum / bandSize;
              nextBars.push(Math.max(0.14, Math.min(1, avg / 165)));
            }
            setStudioMicBars(nextBars);
          }
          studioRafRef.current = window.requestAnimationFrame(tick);
        };

        studioRafRef.current = window.requestAnimationFrame(tick);
      } catch {
        // AudioContext unavailable or blocked; recording still proceeds cleanly
      }
    },
    [stopStudioMeter]
  );

  const stopStudioSpeech = useCallback(() => {
    const sr = studioSpeechRef.current;
    studioSpeechRef.current = null;
    if (sr) {
      sr.onend = null;
      sr.onerror = null;
      sr.onresult = null;
      try {
        sr.stop();
      } catch {
        // ignore
      }
    }
    setStudioInterimTranscript("");
  }, []);

  const startStudioSpeech = useCallback(() => {
    stopStudioSpeech();
    const SpeechCtor = getSpeechRecognitionCtor();
    if (!SpeechCtor) return;
    try {
      const sr = new SpeechCtor();
      sr.continuous = true;
      sr.interimResults = true;
      sr.lang = "en-US";
      sr.onresult = (event) => {
        let finalAdd = "";
        let interim = "";
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const res = event.results[i];
          const chunk = res[0]?.transcript ?? "";
          if (res.isFinal) {
            finalAdd += `${chunk.trim()} `;
          } else {
            interim += chunk;
          }
        }
        if (finalAdd.trim()) {
          setStudioTranscript((prev) =>
            prev.trim() ? `${prev.trimEnd()}\n${finalAdd.trim()}` : finalAdd.trim()
          );
        }
        setStudioInterimTranscript(interim);
      };
      sr.onerror = () => {
        setStudioInterimTranscript("");
      };
      sr.onend = () => {
        setStudioInterimTranscript("");
        if (studioCaptureStateRef.current === "recording" && studioSpeechRef.current === sr) {
          try {
            sr.start();
          } catch {
            // ignore restart errors
          }
        }
      };
      sr.start();
      studioSpeechRef.current = sr;
    } catch {
      // Web Speech optional; continue without blocking
    }
  }, [stopStudioSpeech]);

  const stopStudioCapture = useCallback(async (): Promise<Blob | null> => {
    stopStudioSpeech();
    stopStudioMeter();

    const recorder = studioRecorderRef.current;
    let finalBlob: Blob | null = studioRecordedBlobRef.current;

    if (recorder && recorder.state !== "inactive") {
      finalBlob = await new Promise<Blob | null>((resolve) => {
        let settled = false;
        const finish = (blob: Blob | null) => {
          if (settled) return;
          settled = true;
          studioStopResolverRef.current = null;
          resolve(blob);
        };
        studioStopResolverRef.current = finish;
        window.setTimeout(() => {
          if (!settled) {
            const fallback =
              studioChunksRef.current.length > 0
                ? new Blob(studioChunksRef.current, {
                    type: recorder.mimeType || "audio/webm",
                  })
                : studioRecordedBlobRef.current;
            finish(fallback);
          }
        }, 1200);
        try {
          recorder.stop();
        } catch {
          finish(studioRecordedBlobRef.current);
        }
      });
    }

    studioRecorderRef.current = null;

    if (studioStreamRef.current) {
      for (const track of studioStreamRef.current.getTracks()) {
        track.stop();
      }
      studioStreamRef.current = null;
    }

    studioCaptureStateRef.current = "idle";
    setStudioCaptureState("idle");
    setStudioMicStatus((prev) => (prev === "unavailable" ? "unavailable" : "ready"));
    return finalBlob;
  }, [stopStudioMeter, stopStudioSpeech]);

  // Clean unmount disposal for all Live Call media resources
  useEffect(() => {
    return () => {
      stopStudioSpeech();
      stopStudioMeter();
      try {
        if (studioRecorderRef.current && studioRecorderRef.current.state !== "inactive") {
          studioRecorderRef.current.stop();
        }
      } catch {
        // ignore
      }
      studioRecorderRef.current = null;
      if (studioStreamRef.current) {
        for (const track of studioStreamRef.current.getTracks()) {
          track.stop();
        }
        studioStreamRef.current = null;
      }
    };
  }, [stopStudioMeter, stopStudioSpeech]);

  // Revoke object URLs on change/unmount
  useEffect(() => {
    return () => {
      if (studioAudioUrl) {
        URL.revokeObjectURL(studioAudioUrl);
      }
    };
  }, [studioAudioUrl]);

  // Deep-Link Listener: command-engine:navigate
  useEffect(() => {
    const handleNavigateEvent = (ev: Event) => {
      const customEv = ev as CustomEvent<{
        view?: string;
        action?: string;
        title?: string;
        meetingId?: number;
      }>;
      const detail = customEv.detail;
      if (
        String(detail?.view ?? "").toLowerCase() === "meetings" &&
        detail?.action === "start-recording"
      ) {
        setStudioExpanded(true);
        if (typeof detail?.title === "string" && detail.title.trim()) {
          setStudioTitle(detail.title.trim());
        }
        if (typeof detail?.meetingId === "number") {
          setStudioMeetingId(detail.meetingId);
        }
        window.setTimeout(() => {
          studioCardRef.current?.scrollIntoView({
            behavior: "smooth",
            block: "nearest",
          });
          studioScratchpadRef.current?.focus();
        }, 60);
      }
    };
    window.addEventListener("command-engine:navigate", handleNavigateEvent);
    return () => {
      window.removeEventListener("command-engine:navigate", handleNavigateEvent);
    };
  }, []);

  const startStudioCapture = useCallback(async () => {
    setStudioExpanded(true);

    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setStudioMicStatus("unavailable");
      studioScratchpadRef.current?.focus();
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      studioStreamRef.current = stream;
      studioChunksRef.current = [];
      studioRecordedBlobRef.current = null;
      if (studioAudioUrl) {
        URL.revokeObjectURL(studioAudioUrl);
        setStudioAudioUrl(null);
      }

      const recorder = new MediaRecorder(stream);
      recorder.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) {
          studioChunksRef.current.push(ev.data);
        }
      };
      recorder.onstop = () => {
        const blob =
          studioChunksRef.current.length > 0
            ? new Blob(studioChunksRef.current, {
                type: recorder.mimeType || "audio/webm",
              })
            : null;
        studioRecordedBlobRef.current = blob;
        if (blob) {
          setStudioAudioUrl(URL.createObjectURL(blob));
        }
        if (studioStopResolverRef.current) {
          studioStopResolverRef.current(blob);
        }
      };

      studioRecorderRef.current = recorder;
      recorder.start(1000);
      setStudioSeconds(0);
      studioCaptureStateRef.current = "recording";
      setStudioCaptureState("recording");
      setStudioMicStatus("active");

      startStudioMeter(stream);
      startStudioSpeech();
      studioScratchpadRef.current?.focus();
    } catch {
      // Never block user when mic is denied or unavailable
      setStudioMicStatus("unavailable");
      studioCaptureStateRef.current = "idle";
      setStudioCaptureState("idle");
      studioScratchpadRef.current?.focus();
    }
  }, [startStudioMeter, startStudioSpeech, studioAudioUrl]);

  const pauseStudioCapture = useCallback(() => {
    const recorder = studioRecorderRef.current;
    if (recorder && recorder.state === "recording" && typeof recorder.pause === "function") {
      try {
        recorder.pause();
      } catch {
        // ignore
      }
    }
    stopStudioSpeech();
    studioCaptureStateRef.current = "paused";
    setStudioCaptureState("paused");
    setStudioMicStatus("paused");
    setStudioMicBars(IDLE_MIC_BARS);
  }, [stopStudioSpeech]);

  const resumeStudioCapture = useCallback(() => {
    const recorder = studioRecorderRef.current;
    if (recorder && recorder.state === "paused" && typeof recorder.resume === "function") {
      try {
        recorder.resume();
      } catch {
        // ignore
      }
    }
    if (studioAudioCtxRef.current && studioAudioCtxRef.current.state === "suspended") {
      void studioAudioCtxRef.current.resume().catch(() => {});
    }
    studioCaptureStateRef.current = "recording";
    setStudioCaptureState("recording");
    setStudioMicStatus("active");
    startStudioSpeech();
  }, [startStudioSpeech]);

  const focusScratchpadIfUnfocused = useCallback(() => {
    const active = document.activeElement;
    if (
      active instanceof HTMLElement &&
      studioCardRef.current?.contains(active) &&
      (active.tagName === "INPUT" ||
        active.tagName === "TEXTAREA" ||
        active.tagName === "SELECT")
    ) {
      return;
    }
    studioScratchpadRef.current?.focus();
  }, []);

  const handleOpenStudio = useCallback(() => {
    setStudioExpanded(true);
    window.setTimeout(() => {
      focusScratchpadIfUnfocused();
    }, 40);
  }, [focusScratchpadIfUnfocused]);

  const handleCaptureLiveForMeeting = useCallback((meeting: MeetingItem) => {
    setStudioExpanded(true);
    setStudioMeetingId(meeting.id);
    setStudioTitle(meeting.title || "");
    setStudioAttendees((meeting.attendees ?? []).join(", "));
    const existingSavedNote = loadSavedLiveNote(meeting.id);
    if (existingSavedNote.trim()) {
      setStudioLiveNotes((prev) => (prev.trim() ? prev : existingSavedNote));
    }
    window.setTimeout(() => {
      studioCardRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
      focusScratchpadIfUnfocused();
    }, 50);
  }, [focusScratchpadIfUnfocused]);

  const handleClearStudioDraft = useCallback(() => {
    setStudioTitle("");
    setStudioAttendees("");
    setStudioLiveNotes("");
    setStudioTranscript("");
    setStudioInterimTranscript("");
    setStudioMeetingId(null);
    setStudioSeconds(0);
    studioRecordedBlobRef.current = null;
    studioChunksRef.current = [];
    if (studioAudioUrl) {
      URL.revokeObjectURL(studioAudioUrl);
      setStudioAudioUrl(null);
    }
    setStudioMicStatus("ready");
    try {
      localStorage.removeItem(STUDIO_DRAFT_KEY);
    } catch {
      // ignore
    }
  }, [studioAudioUrl]);

  const handleFinishLiveCapture = async () => {
    setFinishingCapture(true);
    try {
      const stoppedBlob = await stopStudioCapture();
      const audioBlob = stoppedBlob ?? studioRecordedBlobRef.current;

      const hasNotes = studioLiveNotes.trim().length > 0;
      const hasTranscript = studioTranscript.trim().length > 0;
      const hasAudio = Boolean(audioBlob && audioBlob.size > 0);

      if (!hasNotes && !hasTranscript && !hasAudio) {
        pushToast("info", "Add live notes or record audio before finishing");
        setFinishingCapture(false);
        return;
      }

      let audioBase64: string | undefined;
      let audioMime: string | undefined;
      if (audioBlob && audioBlob.size > 0) {
        const converted = await blobToBase64(audioBlob);
        if (converted.base64) {
          audioBase64 = converted.base64;
          audioMime = converted.mime;
        }
      }

      const attendees = studioAttendees
        .split(",")
        .map((a) => a.trim())
        .filter(Boolean);

      const res = await api.liveCaptureMeeting({
        title: studioTitle.trim() || "Live Call Notes",
        meeting_id: studioMeetingId,
        attendees: attendees.length > 0 ? attendees : undefined,
        live_notes: studioLiveNotes.trim() || undefined,
        transcript_text: studioTranscript.trim() || undefined,
        audio_base64: audioBase64,
        audio_mime: audioMime,
        duration_sec: studioSeconds > 0 ? studioSeconds : undefined,
        auto_process: true,
      });

      handleClearStudioDraft();
      setStudioExpanded(false);

      pushToast(
        "success",
        "Call captured & commitments extracted",
        res.meeting?.title || studioTitle.trim() || undefined
      );
      onStateMutated();
      await loadMeetings();
      if (res.meeting_id) {
        setSelectedId(res.meeting_id);
        setDetailTab("summary");
      }
    } catch (err) {
      pushToast(
        "error",
        "Live capture failed",
        err instanceof Error ? err.message : String(err)
      );
    } finally {
      setFinishingCapture(false);
    }
  };

  const handleProcessMeeting = async (meetingId: number) => {
    setProcessingId(meetingId);
    try {
      await api.processMeeting(meetingId);
      pushToast("success", "Summary & action items extracted");
      onStateMutated();
      await loadMeetings();
    } catch (err) {
      pushToast(
        "error",
        "Extraction failed",
        err instanceof Error ? err.message : String(err)
      );
    } finally {
      setProcessingId(null);
    }
  };

  const handleSaveLiveNotesAndExtract = async () => {
    if (!selectedMeeting) return;
    const text = liveNotesText.trim();
    if (!text) {
      pushToast("info", "Write some notes first");
      return;
    }
    setSavingLiveNotes(true);
    try {
      const combinedTranscript = selectedMeeting.raw_transcript?.trim()
        ? `${selectedMeeting.raw_transcript.trim()}\n\n--- Live Notes ---\n${text}`
        : text;
      const res = await api.ingestMeeting({
        external_id: selectedMeeting.external_id || `meeting-${selectedMeeting.id}`,
        title: selectedMeeting.title,
        start_at: selectedMeeting.start_at || undefined,
        end_at: selectedMeeting.end_at || undefined,
        attendees: selectedMeeting.attendees,
        meet_url: selectedMeeting.meet_url || undefined,
        raw_transcript: combinedTranscript,
        auto_process: true,
      });
      if (res.meeting_id && !res.processed) {
        await api.processMeeting(res.meeting_id);
      }
      pushToast("success", "Notes saved & extracted");
      setDetailTab("summary");
      onStateMutated();
      await loadMeetings();
    } catch (err) {
      pushToast(
        "error",
        "Failed to save & extract",
        err instanceof Error ? err.message : String(err)
      );
    } finally {
      setSavingLiveNotes(false);
    }
  };

  const handleAddWorkItem = async (
    key: string,
    payload: {
      title: string;
      description?: string;
      priority?: string;
      bucket: "needed_from_me" | "waiting_on_others";
      repo?: string;
      counterparty?: string;
    }
  ) => {
    if (!selectedMeeting) return;
    try {
      await api.createTask({
        title: payload.title,
        description: payload.description || `From meeting: ${selectedMeeting.title}`,
        priority: payload.priority || (payload.bucket === "needed_from_me" ? "P1" : "P2"),
        bucket: payload.bucket,
        source: "meeting_transcript",
        repo: payload.repo,
        counterparty: payload.counterparty,
      });
      setAddedWorkKeys((prev) => ({ ...prev, [key]: true }));
      pushToast("success", "Added to Work", payload.title);
      onStateMutated();
    } catch (err) {
      pushToast(
        "error",
        "Failed to add task",
        err instanceof Error ? err.message : String(err)
      );
    }
  };

  const openFollowupModal = (
    meeting: MeetingItem,
    prefillTitle?: string,
    counterparty?: string
  ) => {
    setFollowupChannel("slack");
    setFollowupTarget(counterparty || "");
    setFollowupSubject(`Follow-up: ${meeting.title}`);
    setFollowupBody(
      prefillTitle
        ? `Quick follow-up from "${meeting.title}":\n\n- ${prefillTitle}`
        : buildMeetingFollowupDraft(meeting)
    );
    setFollowupOpen(true);
  };

  const handleStageFollowup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedMeeting) return;
    if (!followupBody.trim()) {
      pushToast("error", "Follow-up message cannot be empty");
      return;
    }
    setStagingFollowup(true);
    try {
      const actionType = followupChannel === "slack" ? "slack_send" : "gmail_send";
      const payload =
        followupChannel === "slack"
          ? {
              channel: followupTarget.trim() || "DM / Thread",
              text: followupBody.trim(),
              meeting_id: selectedMeeting.id,
            }
          : {
              to: followupTarget.trim() || "(recipient)",
              subject: followupSubject.trim() || `Follow-up: ${selectedMeeting.title}`,
              body: followupBody.trim(),
              meeting_id: selectedMeeting.id,
            };

      const res = await api.stageApproval({
        action_type: actionType,
        title: `Follow-up: ${selectedMeeting.title}`,
        summary: `${followupChannel === "slack" ? "Slack" : "Email"} follow-up staged from meeting`,
        payload,
      });
      setFollowupOpen(false);
      pushToast(
        "success",
        "Follow-up staged in Approvals",
        res.approval_id ? `Approval #${res.approval_id}` : undefined
      );
      onStateMutated();
    } catch (err) {
      pushToast(
        "error",
        "Failed to stage follow-up",
        err instanceof Error ? err.message : String(err)
      );
    } finally {
      setStagingFollowup(false);
    }
  };

  const handleIngestSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ingestTitle.trim() || !ingestTranscript.trim()) {
      pushToast("error", "Title and transcript/notes are required");
      return;
    }
    setIngesting(true);
    try {
      const attendees = ingestAttendees
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const res = await api.ingestMeeting({
        external_id: `manual-${Date.now()}`,
        title: ingestTitle.trim(),
        start_at: new Date().toISOString(),
        attendees,
        raw_transcript: ingestTranscript.trim(),
        auto_process: ingestAutoProcess,
      });
      setIngestOpen(false);
      setIngestTitle("");
      setIngestAttendees("");
      setIngestTranscript("");
      pushToast("success", "Meeting note saved");
      onStateMutated();
      await loadMeetings();
      if (res.meeting_id) {
        setSelectedId(res.meeting_id);
        setDetailTab("summary");
      }
    } catch (err) {
      pushToast(
        "error",
        "Failed to save meeting",
        err instanceof Error ? err.message : String(err)
      );
    } finally {
      setIngesting(false);
    }
  };

  const handleUploadTranscriptFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      setIngestTranscript(text);
      if (!ingestTitle.trim()) {
        setIngestTitle(file.name.replace(/\.[^.]+$/, ""));
      }
    } catch {
      pushToast("error", "Could not read file");
    } finally {
      e.target.value = "";
    }
  };

  const selectedMeetUrl = sanitizeHttpUrl(selectedMeeting?.meet_url);
  const myTodos = selectedMeeting?.my_todos ?? [];
  const waitingOnOthers = selectedMeeting?.waiting_on_others ?? [];
  const hasActionItems = myTodos.length > 0 || waitingOnOthers.length > 0;
  const canExtractSummary = Boolean(
    selectedMeeting &&
      (meetingHasTranscript(selectedMeeting) || liveNotesText.trim().length > 0) &&
      !selectedMeeting.summary_md?.trim()
  );

  const nextUpcomingCall = useMemo(() => {
    const candidate = upcomingPrep.find(
      (item) => item.meeting_id !== prepBarDismissedId && item.minutes_until <= 60
    );
    return candidate ?? null;
  }, [upcomingPrep, prepBarDismissedId]);

  const nextUpcomingMeetUrl = sanitizeHttpUrl(nextUpcomingCall?.meet_url);
  const selectedDossier = selectedMeeting
    ? dossierByMeetingId[selectedMeeting.id] ?? null
    : null;
  const isDossierLoading = Boolean(
    selectedMeeting && dossierLoadingId === selectedMeeting.id
  );
  const selectedDossierError = selectedMeeting
    ? dossierErrorById[selectedMeeting.id] ?? null
    : null;

  return (
    <div className="mx-auto w-full max-w-[1160px] space-y-4 px-6 pt-2 pb-8">
      <WorkspaceHeader
        title="Meetings"
        actions={
          <>
            <div className="relative">
              <Search
                className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-[var(--muted)]"
                strokeWidth={1.75}
              />
              <input
                ref={searchInputRef}
                type="search"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search meetings…"
                className="ce-input w-48 py-1.5 pl-8 text-[12.5px]"
              />
            </div>
            <button
              type="button"
              onClick={() => setIngestOpen(true)}
              className="ce-btn ce-btn-primary"
            >
              <Plus className="h-3.5 w-3.5" strokeWidth={2} />
              New Note / Transcript
            </button>
          </>
        }
      />

      {error && <ErrorBanner message={error} onRetry={() => void loadMeetings()} />}

      {/* Up Next Call Prep Bar (starting within 60m) */}
      {nextUpcomingCall && (
        <section
          data-testid="ce-upcoming-call-prep"
          className="ce-card flex flex-wrap items-center justify-between gap-3 border-[var(--accent-border)] bg-[color-mix(in_srgb,var(--accent-soft)_55%,var(--surface))] px-4 py-3"
        >
          <div className="flex min-w-0 flex-1 items-start gap-3">
            <span className="ce-pill ce-pill-accent mt-0.5 shrink-0 font-mono text-[11px] tabular-nums">
              <Clock className="h-3 w-3" />
              {nextUpcomingCall.minutes_until <= 0
                ? "Starting now"
                : `Up Next · ${Math.round(nextUpcomingCall.minutes_until)}m`}
            </span>
            <div className="min-w-0 flex-1 space-y-0.5">
              <p className="truncate text-[13.5px] font-semibold text-[var(--ink)]">
                {nextUpcomingCall.title}
              </p>
              {nextUpcomingCall.one_line_brief ? (
                <p className="line-clamp-1 text-[12px] text-[var(--ink-secondary)]">
                  {nextUpcomingCall.one_line_brief}
                </p>
              ) : nextUpcomingCall.attendees && nextUpcomingCall.attendees.length > 0 ? (
                <p className="truncate text-[12px] text-[var(--muted)]">
                  With {nextUpcomingCall.attendees.slice(0, 4).join(", ")}
                </p>
              ) : null}
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={() => {
                setSelectedId(nextUpcomingCall.meeting_id);
                setDetailTab("dossier");
                void loadDossier(nextUpcomingCall.meeting_id, false);
              }}
              className="ce-btn ce-btn-accent py-1 text-[12px]"
            >
              <Sparkles className="h-3.5 w-3.5" />
              Open Dossier
            </button>
            {nextUpcomingMeetUrl && (
              <a
                href={nextUpcomingMeetUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="ce-btn ce-btn-primary py-1 text-[12px]"
              >
                <ExternalLink className="h-3.5 w-3.5" />
                Join Call
              </a>
            )}
            <button
              type="button"
              aria-label="Dismiss upcoming call prep"
              onClick={() => setPrepBarDismissedId(nextUpcomingCall.meeting_id)}
              className="ce-btn ce-btn-ghost p-1 text-[var(--muted)]"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </section>
      )}

      {/* Zero-Bot Live Call Copilot Studio */}
      <section
        ref={studioCardRef}
        data-testid="zero-bot-call-studio"
        className="ce-card overflow-hidden transition-colors"
      >
        <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5">
          <div className="flex min-w-0 flex-wrap items-center gap-2.5">
            <span
              className={`h-2.5 w-2.5 shrink-0 rounded-full ${
                studioCaptureState === "recording"
                  ? "animate-pulse bg-[var(--coral)] shadow-[0_0_10px_var(--coral)]"
                  : studioCaptureState === "paused"
                    ? "bg-[var(--amber)]"
                    : studioExpanded
                      ? "bg-[var(--sage)]"
                      : "bg-[var(--muted)]"
              }`}
            />
            <span className="text-[13.5px] font-semibold text-[var(--ink)]">
              Live Call Copilot
            </span>
            <span className="ce-pill text-[11px] text-[var(--ink-secondary)]">
              Zero-Bot Local Capture · No call bots join your meeting
            </span>
            {studioCaptureState !== "idle" && (
              <span
                className={`ce-pill font-mono tabular-nums text-[11px] ${
                  studioCaptureState === "recording"
                    ? "ce-pill-coral"
                    : "ce-pill-amber"
                }`}
              >
                {studioCaptureState === "recording" ? "REC" : "PAUSED"}{" "}
                {formatTimerClock(studioSeconds)}
              </span>
            )}
          </div>

          <div className="flex shrink-0 items-center gap-2">
            {!studioExpanded ? (
              <button
                type="button"
                onClick={handleOpenStudio}
                data-testid="start-live-call-notes-btn"
                className="ce-btn ce-btn-primary"
              >
                <Radio className="h-3.5 w-3.5" strokeWidth={1.85} />
                Start Live Call Notes
                <ChevronDown className="h-3.5 w-3.5 opacity-75" />
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setStudioExpanded(false)}
                className="ce-btn ce-btn-ghost py-1 text-[12px]"
              >
                Collapse
                <ChevronUp className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>

        {studioExpanded && (
          <div className="space-y-4 border-t border-[var(--line)] bg-[color-mix(in_srgb,var(--surface-sunken)_45%,transparent)] px-5 py-4">
            {studioMeetingId !== null && (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--accent-border)] bg-[var(--accent-soft)] px-3 py-1.5 text-[12px]">
                <span className="text-[var(--ink)]">
                  Linked to scheduled meeting{" "}
                  <strong className="font-semibold">
                    {studioTitle.trim() || `#${studioMeetingId}`}
                  </strong>
                </span>
                <button
                  type="button"
                  onClick={() => setStudioMeetingId(null)}
                  className="inline-flex items-center gap-1 text-[11.5px] font-medium text-[var(--accent)] hover:underline"
                >
                  <X className="h-3 w-3" />
                  Unlink
                </button>
              </div>
            )}

            {/* Call Metadata Row */}
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <div className="space-y-1">
                <label
                  htmlFor="studio-call-title"
                  className="text-[11.5px] font-medium text-[var(--muted)]"
                >
                  Call Title
                </label>
                <input
                  id="studio-call-title"
                  type="text"
                  value={studioTitle}
                  onChange={(e) => setStudioTitle(e.target.value)}
                  placeholder="Product Sync with Andrew"
                  data-testid="live-call-title-input"
                  className="ce-input"
                />
              </div>

              <div className="space-y-1">
                <label
                  htmlFor="studio-call-attendees"
                  className="text-[11.5px] font-medium text-[var(--muted)]"
                >
                  Attendees (optional, comma-separated)
                </label>
                <input
                  id="studio-call-attendees"
                  type="text"
                  value={studioAttendees}
                  onChange={(e) => setStudioAttendees(e.target.value)}
                  placeholder="Andrew Norris, Sam"
                  data-testid="live-call-attendees-input"
                  className="ce-input"
                />
              </div>
            </div>

            {/* Dual-Capture Engine Controls */}
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--line)] bg-[var(--surface-sunken)] px-3.5 py-2.5">
              <div className="flex flex-wrap items-center gap-2.5">
                {studioCaptureState === "idle" ? (
                  <button
                    type="button"
                    disabled={finishingCapture}
                    onClick={() => void startStudioCapture()}
                    data-testid="record-mic-notes-btn"
                    className="ce-btn ce-btn-accent"
                  >
                    <Mic className="h-3.5 w-3.5" strokeWidth={1.85} />
                    Record Mic + Notes
                  </button>
                ) : (
                  <>
                    <span
                      className={`inline-flex items-center gap-2 rounded-full border px-2.5 py-1 text-[11.5px] font-medium ${
                        studioCaptureState === "recording"
                          ? "border-[var(--coral-border)] bg-[var(--coral-soft)] text-[var(--coral)]"
                          : "border-[var(--amber-border)] bg-[var(--amber-soft)] text-[var(--amber)]"
                      }`}
                    >
                      <span
                        className={`h-2 w-2 rounded-full ${
                          studioCaptureState === "recording"
                            ? "animate-pulse bg-[var(--coral)]"
                            : "bg-[var(--amber)]"
                        }`}
                      />
                      <span className="font-mono tabular-nums">
                        {formatTimerClock(studioSeconds)}
                      </span>
                    </span>

                    {/* 8-bar live mic audio level meter */}
                    <div
                      aria-label="Live microphone level"
                      className="flex h-6 items-end gap-0.5 rounded-md border border-[var(--line)] bg-[var(--surface)] px-2 py-1"
                    >
                      {studioMicBars.map((level, idx) => (
                        <span
                          key={idx}
                          style={{ height: `${Math.round(level * 100)}%` }}
                          className={`w-1 rounded-full transition-[height] duration-75 ${
                            studioCaptureState === "recording"
                              ? "bg-[var(--sage)]"
                              : "bg-[var(--muted)] opacity-50"
                          }`}
                        />
                      ))}
                    </div>

                    {studioCaptureState === "recording" ? (
                      <button
                        type="button"
                        onClick={pauseStudioCapture}
                        className="ce-btn py-1 text-[12px]"
                      >
                        <Pause className="h-3.5 w-3.5" />
                        Pause
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={resumeStudioCapture}
                        className="ce-btn ce-btn-sage py-1 text-[12px]"
                      >
                        <Play className="h-3.5 w-3.5" />
                        Resume
                      </button>
                    )}

                    <button
                      type="button"
                      onClick={() => void stopStudioCapture()}
                      className="ce-btn ce-btn-danger py-1 text-[12px]"
                    >
                      <Square className="h-3 w-3 fill-current" />
                      Stop
                    </button>
                  </>
                )}

                {studioMicStatus === "unavailable" && (
                  <span className="ce-pill ce-pill-amber text-[11px]">
                    Mic unavailable — capturing Scratchpad Notes mode
                  </span>
                )}
              </div>

              {studioAudioUrl && studioCaptureState === "idle" && (
                <div className="flex items-center gap-2">
                  <span className="text-[11.5px] text-[var(--sage)]">
                    Audio ready ({formatTimerClock(studioSeconds)})
                  </span>
                  <audio controls src={studioAudioUrl} className="h-7 max-w-[220px]" />
                </div>
              )}
            </div>

            {/* Optional Web Speech Live Captions Preview */}
            {(studioTranscript.trim() || studioInterimTranscript.trim()) && (
              <div className="space-y-1 rounded-xl border border-[var(--line)] bg-[var(--surface-sunken)] px-3.5 py-2.5">
                <div className="flex items-center justify-between">
                  <span className="ce-kicker">Live Speech Captions</span>
                  {studioCaptureState === "recording" && (
                    <span className="text-[11px] text-[var(--sage)]">Listening…</span>
                  )}
                </div>
                <p className="max-h-24 overflow-y-auto whitespace-pre-wrap text-[12.5px] leading-relaxed text-[var(--ink-secondary)] ce-contain-scroll">
                  {studioTranscript}
                  {studioInterimTranscript && (
                    <span className="text-[var(--muted)] italic">
                      {studioTranscript ? " " : ""}
                      {studioInterimTranscript}
                    </span>
                  )}
                </p>
              </div>
            )}

            {/* Principal Live Scratchpad */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <label
                  htmlFor="zero-bot-scratchpad"
                  className="text-[12px] font-medium text-[var(--ink-secondary)]"
                >
                  Principal Live Scratchpad
                </label>
                <span className="text-[11px] text-[var(--muted)]">
                  Shorthand bullets, commitments &amp; decisions
                </span>
              </div>
              <textarea
                id="zero-bot-scratchpad"
                ref={studioScratchpadRef}
                data-testid="live-call-scratchpad"
                rows={5}
                value={studioLiveNotes}
                onChange={(e) => setStudioLiveNotes(e.target.value)}
                placeholder={`- I'll ship API retry PR today\n- Sam to share Q4 customer shortlist by Friday`}
                className="ce-input min-h-[124px] resize-y bg-[var(--surface-sunken)] p-3.5 font-sans text-[13.5px] leading-relaxed"
              />
            </div>

            {/* Finish & Extract Commitments Footer */}
            <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
              <span className="text-[12px] text-[var(--muted)]">
                {finishingCapture
                  ? "Synthesizing summary & splitting My Commitments vs Waiting On Others…"
                  : "Audio stays local; notes + transcript extract straight into Work & Summary."}
              </span>
              <div className="flex items-center gap-2">
                {studioCaptureState === "idle" &&
                  (studioTitle.trim() ||
                    studioAttendees.trim() ||
                    studioLiveNotes.trim() ||
                    studioTranscript.trim() ||
                    studioAudioUrl) && (
                    <button
                      type="button"
                      disabled={finishingCapture}
                      onClick={handleClearStudioDraft}
                      className="ce-btn ce-btn-ghost"
                    >
                      Clear
                    </button>
                  )}
                <button
                  type="button"
                  data-testid="finish-live-capture-btn"
                  disabled={
                    finishingCapture ||
                    (studioCaptureState === "idle" &&
                      !studioLiveNotes.trim() &&
                      !studioTranscript.trim() &&
                      !studioAudioUrl)
                  }
                  onClick={() => void handleFinishLiveCapture()}
                  className="ce-btn ce-btn-primary"
                >
                  {finishingCapture ? (
                    <>
                      <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                      Synthesizing summary &amp; splitting My Commitments vs Waiting On Others…
                    </>
                  ) : (
                    <>
                      <Sparkles className="h-3.5 w-3.5" />
                      Finish &amp; Extract Commitments
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        )}
      </section>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-12">
        {/* Left Pane: Calm Date Pills + Hairline Meeting List */}
        <section className="ce-card flex max-h-[300px] flex-col overflow-hidden lg:col-span-4 lg:max-h-[calc(100vh-11rem)]">
          <div className="flex items-center gap-1.5 overflow-x-auto border-b border-[var(--line)] px-3 py-2.5 ce-contain-scroll">
            <button
              type="button"
              onClick={() => setSelectedDayKey("all")}
              className={`shrink-0 rounded-full px-2.5 py-1 text-[11.5px] font-medium transition-colors ${
                selectedDayKey === "all"
                  ? "bg-[var(--surface-raised)] text-[var(--ink)] ring-1 ring-[var(--line-strong)]"
                  : "text-[var(--muted)] hover:text-[var(--ink)]"
              }`}
            >
              All
            </button>
            {dayPills.map((dayKey) => {
              const active = selectedDayKey === dayKey;
              return (
                <button
                  key={dayKey}
                  type="button"
                  onClick={() => setSelectedDayKey(dayKey)}
                  className={`shrink-0 rounded-full px-2.5 py-1 text-[11.5px] font-medium transition-colors ${
                    active
                      ? "bg-[var(--surface-raised)] text-[var(--ink)] ring-1 ring-[var(--line-strong)]"
                      : "text-[var(--muted)] hover:text-[var(--ink)]"
                  }`}
                >
                  {formatDayPillLabel(dayKey, todayKey)}
                </button>
              );
            })}
          </div>

          <div className="flex-1 divide-y divide-[var(--line)] overflow-y-auto ce-contain-scroll">
            {loading ? (
              <div className="p-4">
                <SkeletonRows rows={5} />
              </div>
            ) : filteredMeetings.length === 0 ? (
              <div className="p-6">
                <EmptyState
                  icon={Calendar}
                  title="No meetings found"
                  description={
                    searchQuery.trim()
                      ? "Try clearing your search or switching day filters."
                      : "Sync calendar or add a manual meeting note."
                  }
                />
              </div>
            ) : (
              filteredMeetings.map((m) => {
                const isSelected = selectedMeeting?.id === m.id;
                const hasNotes = meetingHasNotesOrSummary(m);
                const hasConflict = overlappingIds.has(m.id);
                const attendeeCount = (m.attendees ?? []).length;

                return (
                  <div
                    key={m.id}
                    className={`group flex items-start justify-between gap-2 px-4 py-3 transition-colors ${
                      isSelected
                        ? "bg-[var(--surface-raised)]"
                        : "hover:bg-[color-mix(in_srgb,var(--ink)_3%,transparent)]"
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => setSelectedId(m.id)}
                      className="min-w-0 flex-1 text-left"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono text-[11.5px] tabular-nums text-[var(--muted)]">
                          {formatShortTime(m)}
                        </span>
                        <div className="flex items-center gap-2">
                          {hasConflict && (
                            <span className="ce-pill ce-pill-amber text-[10px]">
                              Conflict
                            </span>
                          )}
                          {hasNotes && (
                            <span className="inline-flex items-center gap-1 text-[11px] text-[var(--sage)]">
                              <span className="h-1.5 w-1.5 rounded-full bg-[var(--sage)]" />
                              Notes
                            </span>
                          )}
                        </div>
                      </div>
                      <p className="mt-1 line-clamp-1 text-[13.5px] font-medium text-[var(--ink)]">
                        {m.title}
                      </p>
                      {attendeeCount > 0 && (
                        <p className="mt-0.5 text-[11.5px] text-[var(--muted)]">
                          {attendeeCount === 1
                            ? "1 attendee"
                            : `${attendeeCount} attendees`}
                        </p>
                      )}
                    </button>

                    <button
                      type="button"
                      onClick={() => {
                        setSelectedId(m.id);
                        handleCaptureLiveForMeeting(m);
                      }}
                      title="Open Live Call Copilot for this meeting"
                      className="ce-btn ce-btn-ghost shrink-0 px-2 py-1 text-[11px] opacity-80 transition-opacity group-hover:opacity-100"
                    >
                      <Radio className="h-3 w-3 text-[var(--accent)]" />
                      Capture Live
                    </button>
                  </div>
                );
              })
            )}
          </div>
        </section>

        {/* Right Pane: Granola Editorial Workspace */}
        <section className="ce-card p-6 lg:col-span-8">
          {!selectedMeeting ? (
            <EmptyState
              icon={Calendar}
              title="Select a meeting"
              description="Choose a call from the list or create a new note / transcript."
              action={
                <button
                  type="button"
                  onClick={() => setIngestOpen(true)}
                  className="ce-btn ce-btn-primary"
                >
                  <Plus className="h-3.5 w-3.5" />
                  New Note / Transcript
                </button>
              }
            />
          ) : (
            <div className="space-y-5">
              {/* Editorial Meeting Header */}
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0 flex-1 space-y-1">
                  <h2 className="font-editorial text-[26px] leading-tight text-[var(--ink)]">
                    {selectedMeeting.title}
                  </h2>
                  <p className="text-[13px] text-[var(--muted)]">
                    {formatHumanSubtitle(selectedMeeting)}
                  </p>
                </div>

                <div className="flex shrink-0 flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => handleCaptureLiveForMeeting(selectedMeeting)}
                    className="ce-btn ce-btn-accent"
                    title="Open Zero-Bot Live Call Copilot pre-filled for this meeting"
                  >
                    <Radio className="h-3.5 w-3.5" strokeWidth={1.75} />
                    Capture Live
                  </button>

                  {selectedMeetUrl ? (
                    <a
                      href={selectedMeetUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="ce-btn ce-btn-primary"
                    >
                      <ExternalLink className="h-3.5 w-3.5" strokeWidth={1.75} />
                      Join Call
                    </a>
                  ) : (
                    <button
                      type="button"
                      disabled
                      className="ce-btn opacity-45"
                      title="No meeting link attached"
                    >
                      No link
                    </button>
                  )}

                  <button
                    type="button"
                    onClick={handleToggleRecord}
                    className={`ce-btn ${
                      isRecording ? "ce-btn-danger" : ""
                    }`}
                  >
                    {isRecording ? (
                      <>
                        <Square className="h-3.5 w-3.5 fill-current" />
                        <span className="font-mono tabular-nums">
                          {formatTimerClock(recordSeconds)}
                        </span>
                      </>
                    ) : (
                      <>
                        <Mic className="h-3.5 w-3.5" strokeWidth={1.75} />
                        Record
                      </>
                    )}
                  </button>
                </div>
              </div>

              {/* Active Recording Strip */}
              {(isRecording || recordedAudioUrl) && (
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--line)] bg-[var(--surface-sunken)] px-3.5 py-2.5 text-[12px]">
                  {isRecording ? (
                    <div className="flex min-w-0 flex-1 items-center gap-2.5">
                      <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-[var(--coral)]" />
                      <span className="font-mono tabular-nums text-[var(--ink)]">
                        Recording {formatTimerClock(recordSeconds)}
                      </span>
                      {interimTranscript && (
                        <span className="truncate text-[var(--muted)]">
                          “{interimTranscript}”
                        </span>
                      )}
                    </div>
                  ) : (
                    <div className="flex flex-1 items-center gap-3">
                      <span className="text-[var(--muted)]">Latest capture</span>
                      {recordedAudioUrl && (
                        <audio
                          controls
                          src={recordedAudioUrl}
                          className="h-7 max-w-xs"
                        />
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* Calm Sub-tabs */}
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--line)]">
                <div className="flex items-center gap-1" role="tablist">
                  {(
                    [
                      { id: "summary", label: "Summary" },
                      { id: "dossier", label: "Pre-Call Dossier" },
                      { id: "live_notes", label: "Live Notes" },
                      { id: "transcript", label: "Transcript" },
                    ] as Array<{ id: DetailTab; label: string }>
                  ).map((tab) => {
                    const active = detailTab === tab.id;
                    return (
                      <button
                        key={tab.id}
                        type="button"
                        role="tab"
                        aria-selected={active}
                        onClick={() => setDetailTab(tab.id)}
                        className={`ce-tab-underline ${active ? "is-active" : ""}`}
                      >
                        {tab.label}
                      </button>
                    );
                  })}
                </div>

                <div className="flex items-center gap-1.5 pb-1">
                  {canExtractSummary && (
                    <button
                      type="button"
                      disabled={processingId === selectedMeeting.id}
                      onClick={() => void handleProcessMeeting(selectedMeeting.id)}
                      className="ce-btn ce-btn-accent py-1 text-[11.5px]"
                    >
                      {processingId === selectedMeeting.id ? (
                        <RefreshCw className="h-3 w-3 animate-spin" />
                      ) : (
                        <Sparkles className="h-3 w-3" />
                      )}
                      Extract Summary & Actions
                    </button>
                  )}
                </div>
              </div>

              {/* Tab 1: Summary + Action Items */}
              {detailTab === "summary" && (
                <div className="space-y-6">
                  {selectedMeeting.summary_md?.trim() ? (
                    <div className="ce-prose-editorial ce-prose-measure">
                      <MarkdownRenderer
                        content={selectedMeeting.summary_md}
                        className="ce-prose"
                      />
                    </div>
                  ) : selectedMeeting.prep_brief_md?.trim() ? (
                    <div className="ce-prose-editorial ce-prose-measure">
                      <MarkdownRenderer
                        content={selectedMeeting.prep_brief_md}
                        className="ce-prose"
                      />
                    </div>
                  ) : (
                    <div className="rounded-xl border border-dashed border-[var(--line-strong)] px-5 py-6 text-center">
                      <p className="text-[13.5px] font-medium text-[var(--ink)]">
                        No summary yet
                      </p>
                      <p className="mt-1 text-[12.5px] text-[var(--muted)]">
                        {meetingHasTranscript(selectedMeeting)
                          ? "Extract a clean summary and action items from the attached transcript."
                          : "Jot down notes in Live Notes or attach a transcript to generate a summary."}
                      </p>
                      <div className="mt-4 flex flex-wrap justify-center gap-2">
                        {meetingHasTranscript(selectedMeeting) ? (
                          <button
                            type="button"
                            disabled={processingId === selectedMeeting.id}
                            onClick={() => void handleProcessMeeting(selectedMeeting.id)}
                            className="ce-btn ce-btn-primary"
                          >
                            <Sparkles className="h-3.5 w-3.5" />
                            Extract Summary & Actions
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setDetailTab("live_notes")}
                            className="ce-btn ce-btn-primary"
                          >
                            Open Live Notes
                          </button>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Clean Action Items */}
                  {(hasActionItems || selectedMeeting.summary_md?.trim()) && (
                    <div className="space-y-3 border-t border-[var(--line)] pt-5">
                      <div className="flex items-center justify-between gap-2">
                        <h3 className="text-[13px] font-semibold text-[var(--ink)]">
                          Action Items
                        </h3>
                        <button
                          type="button"
                          onClick={() => openFollowupModal(selectedMeeting)}
                          className="ce-btn ce-btn-ghost py-1 text-[12px]"
                        >
                          <Send className="h-3.5 w-3.5" strokeWidth={1.75} />
                          Draft Follow-Up
                        </button>
                      </div>

                      {!hasActionItems ? (
                        <p className="text-[12.5px] text-[var(--muted)]">
                          No action items extracted from this call.
                        </p>
                      ) : (
                        <div className="space-y-4">
                          {myTodos.length > 0 && (
                            <div className="space-y-2">
                              <div className="flex items-center gap-2">
                                <span className="ce-kicker">My Commitments</span>
                                <span className="ce-pill ce-pill-accent text-[10.5px]">
                                  {myTodos.length}
                                </span>
                              </div>
                              <div className="divide-y divide-[var(--line)] rounded-xl border border-[var(--line)] bg-[var(--surface-sunken)]">
                                {myTodos.map((td, idx) => {
                                  const key = `me-${selectedMeeting.id}-${idx}`;
                                  const added = Boolean(addedWorkKeys[key]);
                                  return (
                                    <div
                                      key={key}
                                      className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
                                    >
                                      <div className="min-w-0 flex-1">
                                        <p className="text-[13px] font-medium text-[var(--ink)]">
                                          {td.title}
                                        </p>
                                        {td.description && (
                                          <p className="mt-0.5 text-[12px] text-[var(--muted)]">
                                            {td.description}
                                          </p>
                                        )}
                                      </div>
                                      <div className="flex shrink-0 items-center gap-1.5">
                                        <button
                                          type="button"
                                          disabled={added}
                                          onClick={() =>
                                            void handleAddWorkItem(key, {
                                              title: td.title,
                                              description: td.description,
                                              priority: td.priority,
                                              bucket: "needed_from_me",
                                              repo: td.repo,
                                            })
                                          }
                                          className="ce-btn py-1 text-[11.5px]"
                                        >
                                          {added ? (
                                            <>
                                              <Check className="h-3 w-3 text-[var(--sage)]" />
                                              Added
                                            </>
                                          ) : (
                                            <>
                                              <ListPlus className="h-3 w-3" />
                                              + Work
                                            </>
                                          )}
                                        </button>
                                        <button
                                          type="button"
                                          onClick={() =>
                                            openFollowupModal(selectedMeeting, td.title)
                                          }
                                          className="ce-btn ce-btn-ghost py-1 text-[11.5px]"
                                        >
                                          Draft Follow-Up
                                        </button>
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          )}

                          {waitingOnOthers.length > 0 && (
                            <div className="space-y-2">
                              <div className="flex items-center gap-2">
                                <span className="ce-kicker">Waiting On Others</span>
                                <span className="ce-pill ce-pill-amber text-[10.5px]">
                                  {waitingOnOthers.length}
                                </span>
                              </div>
                              <div className="divide-y divide-[var(--line)] rounded-xl border border-[var(--line)] bg-[var(--surface-sunken)]">
                                {waitingOnOthers.map((wt, idx) => {
                                  const key = `wait-${selectedMeeting.id}-${idx}`;
                                  const added = Boolean(addedWorkKeys[key]);
                                  return (
                                    <div
                                      key={key}
                                      className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
                                    >
                                      <div className="min-w-0 flex-1">
                                        <p className="text-[13px] font-medium text-[var(--ink)]">
                                          {wt.counterparty ? `${wt.counterparty}: ` : ""}
                                          {wt.title}
                                        </p>
                                        {wt.description && (
                                          <p className="mt-0.5 text-[12px] text-[var(--muted)]">
                                            {wt.description}
                                          </p>
                                        )}
                                      </div>
                                      <div className="flex shrink-0 items-center gap-1.5">
                                        <button
                                          type="button"
                                          disabled={added}
                                          onClick={() =>
                                            void handleAddWorkItem(key, {
                                              title: wt.title,
                                              description: wt.description,
                                              priority: wt.priority,
                                              bucket: "waiting_on_others",
                                              counterparty: wt.counterparty,
                                            })
                                          }
                                          className="ce-btn py-1 text-[11.5px]"
                                        >
                                          {added ? (
                                            <>
                                              <Check className="h-3 w-3 text-[var(--sage)]" />
                                              Tracked
                                            </>
                                          ) : (
                                            <>
                                              <ListPlus className="h-3 w-3" />
                                              + Work
                                            </>
                                          )}
                                        </button>
                                        <button
                                          type="button"
                                          onClick={() =>
                                            openFollowupModal(
                                              selectedMeeting,
                                              wt.title,
                                              wt.counterparty
                                            )
                                          }
                                          className="ce-btn ce-btn-ghost py-1 text-[11.5px]"
                                        >
                                          Draft Follow-Up
                                        </button>
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* Tab 2: Pre-Call Dossier */}
              {detailTab === "dossier" && (
                <div className="space-y-5" data-testid="ce-meeting-dossier">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="ce-kicker">Pre-Call Intelligence</span>
                      {selectedDossier?.generated_at && (
                        <span className="font-mono text-[11px] text-[var(--muted)]">
                          {formatDateTime(selectedDossier.generated_at)}
                        </span>
                      )}
                      {selectedDossier?.cached && (
                        <span className="ce-pill text-[10.5px]">Cached</span>
                      )}
                    </div>
                    <button
                      type="button"
                      disabled={isDossierLoading}
                      onClick={() => void loadDossier(selectedMeeting.id, true)}
                      className="ce-btn py-1 text-[11.5px]"
                    >
                      <RefreshCw
                        className={`h-3.5 w-3.5 ${isDossierLoading ? "animate-spin" : ""}`}
                      />
                      Refresh Dossier
                    </button>
                  </div>

                  {isDossierLoading && !selectedDossier ? (
                    <SkeletonRows rows={5} />
                  ) : selectedDossierError && !selectedDossier ? (
                    <ErrorBanner
                      title="Could not build pre-call dossier"
                      message={selectedDossierError}
                      onRetry={() => void loadDossier(selectedMeeting.id, true)}
                    />
                  ) : selectedDossier ? (
                    <div className="space-y-5">
                      {(selectedDossier.brief_md || selectedDossier.talking_points_md)?.trim() && (
                        <div className="ce-prose-editorial ce-prose-measure rounded-xl border border-[var(--line)] bg-[var(--surface-sunken)]/45 p-4">
                          <MarkdownRenderer
                            content={(selectedDossier.brief_md || selectedDossier.talking_points_md) ?? ""}
                            className="ce-prose"
                          />
                        </div>
                      )}

                      {selectedDossier.attendee_briefs.length > 0 && (
                        <div className="space-y-2.5">
                          <div className="flex items-center gap-2">
                            <Users className="h-3.5 w-3.5 text-[var(--accent)]" />
                            <span className="ce-kicker">Attendee Briefs</span>
                          </div>
                          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                            {selectedDossier.attendee_briefs.map((ab, idx) => (
                              <div
                                key={`${ab.email || ab.name}-${idx}`}
                                className="space-y-1.5 rounded-xl border border-[var(--line)] bg-[var(--surface-sunken)]/50 p-3.5"
                              >
                                <div className="flex items-start justify-between gap-2">
                                  <div className="min-w-0">
                                    <p className="truncate text-[13px] font-semibold text-[var(--ink)]">
                                      {ab.name}
                                    </p>
                                    {(ab.role || ab.relationship || ab.email) && (
                                      <p className="truncate text-[11.5px] text-[var(--muted)]">
                                        {[ab.role, ab.relationship, ab.email]
                                          .filter(Boolean)
                                          .join(" · ")}
                                      </p>
                                    )}
                                  </div>
                                  {typeof ab.open_tasks_count === "number" &&
                                    ab.open_tasks_count > 0 && (
                                      <span className="ce-pill ce-pill-amber shrink-0 font-mono text-[10.5px]">
                                        {ab.open_tasks_count} open
                                      </span>
                                    )}
                                </div>
                                {ab.notes && (
                                  <p className="text-[12px] leading-relaxed text-[var(--ink-secondary)]">
                                    {ab.notes}
                                  </p>
                                )}
                                {ab.recent_interactions &&
                                  ab.recent_interactions.length > 0 && (
                                    <ul className="list-disc space-y-0.5 pl-4 text-[11.5px] text-[var(--muted)]">
                                      {ab.recent_interactions.slice(0, 3).map((ri, rIdx) => (
                                        <li key={rIdx}>{ri}</li>
                                      ))}
                                    </ul>
                                  )}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {selectedDossier.suggested_talking_points &&
                        selectedDossier.suggested_talking_points.length > 0 && (
                          <div className="space-y-2">
                            <span className="ce-kicker">Suggested Talking Points</span>
                            <ul className="space-y-1.5 rounded-xl border border-[var(--line)] bg-[var(--surface-sunken)]/45 p-4 text-[13px] text-[var(--ink-secondary)]">
                              {selectedDossier.suggested_talking_points.map((pt, idx) => (
                                <li key={idx} className="flex items-start gap-2">
                                  <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--accent)]" />
                                  <span>{pt}</span>
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}

                      {selectedDossier.open_commitments &&
                        selectedDossier.open_commitments.length > 0 && (
                          <div className="space-y-2">
                            <span className="ce-kicker">Open Commitments</span>
                            <div className="divide-y divide-[var(--line)] rounded-xl border border-[var(--line)] bg-[var(--surface-sunken)]/45">
                              {selectedDossier.open_commitments.map((oc, idx) => (
                                <div
                                  key={oc.id ?? idx}
                                  className="flex flex-wrap items-center justify-between gap-2 px-3.5 py-2.5 text-[12.5px]"
                                >
                                  <span className="font-medium text-[var(--ink)]">
                                    {oc.counterparty ? `${oc.counterparty}: ` : ""}
                                    {oc.title}
                                  </span>
                                  <div className="flex items-center gap-1.5">
                                    {oc.priority && (
                                      <span className="ce-pill font-mono text-[10.5px]">
                                        {oc.priority}
                                      </span>
                                    )}
                                    {oc.bucket && (
                                      <span className="ce-pill text-[10.5px]">
                                        {oc.bucket === "needed_from_me"
                                          ? "My End"
                                          : "Waiting"}
                                      </span>
                                    )}
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                      {selectedDossier.related_threads &&
                        selectedDossier.related_threads.length > 0 && (
                          <div className="space-y-2">
                            <span className="ce-kicker">Related Threads</span>
                            <div className="divide-y divide-[var(--line)] rounded-xl border border-[var(--line)] bg-[var(--surface-sunken)]/45">
                              {selectedDossier.related_threads.map((th, idx) => {
                                const safeUrl = sanitizeHttpUrl(th.url);
                                return (
                                  <div
                                    key={th.id ?? idx}
                                    className="flex items-start justify-between gap-3 px-3.5 py-2.5"
                                  >
                                    <div className="min-w-0 space-y-0.5">
                                      <div className="flex items-center gap-2 text-[11px] text-[var(--muted)]">
                                        <span className="ce-pill font-mono text-[10px]">
                                          {th.source}
                                        </span>
                                        {th.occurred_at && (
                                          <span>{formatDateTime(th.occurred_at)}</span>
                                        )}
                                      </div>
                                      <p className="text-[12.5px] font-medium text-[var(--ink)]">
                                        {th.title}
                                      </p>
                                      {th.summary && (
                                        <p className="line-clamp-2 text-[11.5px] text-[var(--ink-secondary)]">
                                          {th.summary}
                                        </p>
                                      )}
                                    </div>
                                    {safeUrl && (
                                      <a
                                        href={safeUrl}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="ce-btn ce-btn-ghost shrink-0 px-2 py-1 text-[11px]"
                                      >
                                        <ExternalLink className="h-3 w-3" />
                                      </a>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        )}
                    </div>
                  ) : (
                    <div className="rounded-xl border border-dashed border-[var(--line-strong)] px-5 py-8 text-center">
                      <p className="text-[13px] text-[var(--muted)]">
                        Click Refresh Dossier to assemble attendee context, open commitments, and talking points.
                      </p>
                    </div>
                  )}
                </div>
              )}

              {/* Tab 3: Distraction-free Live Notes Scratchpad */}
              {detailTab === "live_notes" && (
                <div className="space-y-3">
                  <textarea
                    value={liveNotesText}
                    onChange={(e) => setLiveNotesText(e.target.value)}
                    rows={14}
                    placeholder="Jot down quick bullets, decisions, and open questions during the call…"
                    className="ce-input min-h-[300px] resize-y bg-[var(--surface-sunken)] p-4 font-sans text-[14px] leading-relaxed"
                  />
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-[11.5px] text-[var(--muted)]">
                      {liveNoteSavedAt
                        ? `Saved locally at ${liveNoteSavedAt}`
                        : "Auto-saves locally as you type"}
                    </span>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        disabled={savingLiveNotes || !liveNotesText.trim()}
                        onClick={() => void handleSaveLiveNotesAndExtract()}
                        className="ce-btn ce-btn-primary"
                      >
                        {savingLiveNotes ? (
                          <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Sparkles className="h-3.5 w-3.5" />
                        )}
                        Save & Extract
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {/* Tab 3: Readable Transcript */}
              {detailTab === "transcript" && (
                <div className="space-y-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-[12px] text-[var(--muted)]">
                      {selectedMeeting.raw_transcript?.trim()
                        ? `${selectedMeeting.raw_transcript.trim().split(/\s+/).length} words`
                        : "No raw transcript attached yet"}
                    </span>
                    <div className="flex items-center gap-2">
                      {selectedMeeting.transcript_url && (
                        <a
                          href={sanitizeHttpUrl(selectedMeeting.transcript_url) ?? "#"}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="ce-btn py-1 text-[11.5px]"
                        >
                          <ExternalLink className="h-3.5 w-3.5" />
                          Source Doc
                        </a>
                      )}
                      {selectedMeeting.raw_transcript?.trim() && (
                        <button
                          type="button"
                          onClick={() => {
                            const blob = new Blob(
                              [selectedMeeting.raw_transcript ?? ""],
                              { type: "text/plain;charset=utf-8" }
                            );
                            const url = URL.createObjectURL(blob);
                            const a = document.createElement("a");
                            a.href = url;
                            a.download = `${slugifyFilename(selectedMeeting.title)}-transcript.txt`;
                            a.click();
                            window.setTimeout(() => URL.revokeObjectURL(url), 1000);
                          }}
                          className="ce-btn py-1 text-[11.5px]"
                        >
                          <Download className="h-3.5 w-3.5" />
                          Export
                        </button>
                      )}
                    </div>
                  </div>

                  {selectedMeeting.raw_transcript?.trim() ? (
                    <div className="max-h-[460px] overflow-y-auto rounded-xl border border-[var(--line)] bg-[var(--surface-sunken)] p-5 ce-contain-scroll">
                      <pre className="whitespace-pre-wrap font-sans text-[13.5px] leading-relaxed text-[var(--ink-secondary)]">
                        {selectedMeeting.raw_transcript}
                      </pre>
                    </div>
                  ) : (
                    <div className="rounded-xl border border-dashed border-[var(--line-strong)] px-5 py-8 text-center">
                      <p className="text-[13px] text-[var(--muted)]">
                        No transcript text attached yet. Paste a transcript via New Note / Transcript or capture notes in Live Notes.
                      </p>
                      <button
                        type="button"
                        onClick={() => {
                          setIngestTitle(selectedMeeting.title);
                          setIngestAttendees((selectedMeeting.attendees ?? []).join(", "));
                          setIngestOpen(true);
                        }}
                        className="ce-btn mt-3"
                      >
                        Attach Transcript
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </section>
      </div>

      {/* Modal: Ingest / New Meeting Note or Transcript */}
      <ModalDialog
        open={ingestOpen}
        onClose={() => setIngestOpen(false)}
        title="New Meeting Note / Transcript"
        subtitle="Paste a transcript or rough notes to extract summary & action items."
        maxWidthClass="max-w-xl"
      >
        <form onSubmit={handleIngestSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-[12px] font-medium text-[var(--ink-secondary)]">
              Title
            </label>
            <input
              type="text"
              required
              value={ingestTitle}
              onChange={(e) => setIngestTitle(e.target.value)}
              placeholder="e.g. Weekly Engineering Sync"
              className="ce-input"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-[12px] font-medium text-[var(--ink-secondary)]">
              Attendees (optional, comma-separated)
            </label>
            <input
              type="text"
              value={ingestAttendees}
              onChange={(e) => setIngestAttendees(e.target.value)}
              placeholder="Sam, Andrew, Alex"
              className="ce-input"
            />
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label className="text-[12px] font-medium text-[var(--ink-secondary)]">
                Transcript or Notes
              </label>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="ce-btn ce-btn-ghost py-0.5 text-[11.5px]"
              >
                <Upload className="h-3 w-3" />
                Upload .txt / .md
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".txt,.md,.vtt,.srt"
                onChange={handleUploadTranscriptFile}
                className="hidden"
              />
            </div>
            <textarea
              required
              rows={8}
              value={ingestTranscript}
              onChange={(e) => setIngestTranscript(e.target.value)}
              placeholder="Paste Gemini Notes, transcript, or raw bullet points…"
              className="ce-input resize-y"
            />
          </div>

          <label className="flex items-center gap-2 text-[12.5px] text-[var(--ink-secondary)]">
            <input
              type="checkbox"
              checked={ingestAutoProcess}
              onChange={(e) => setIngestAutoProcess(e.target.checked)}
              className="rounded border-[var(--line-strong)]"
            />
            Extract executive summary & action items immediately
          </label>

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={() => setIngestOpen(false)}
              className="ce-btn ce-btn-ghost"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={ingesting}
              className="ce-btn ce-btn-primary"
            >
              {ingesting ? (
                <RefreshCw className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Plus className="h-3.5 w-3.5" />
              )}
              Save Note
            </button>
          </div>
        </form>
      </ModalDialog>

      {/* Modal: Stage Follow-Up */}
      <ModalDialog
        open={followupOpen}
        onClose={() => setFollowupOpen(false)}
        title="Stage Follow-Up"
        subtitle="Stages an outbound draft in Approvals — nothing is sent without confirmation."
        maxWidthClass="max-w-lg"
      >
        <form onSubmit={handleStageFollowup} className="space-y-4">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setFollowupChannel("slack")}
              className={`ce-btn flex-1 ${
                followupChannel === "slack" ? "ce-btn-primary" : ""
              }`}
            >
              Slack
            </button>
            <button
              type="button"
              onClick={() => setFollowupChannel("gmail")}
              className={`ce-btn flex-1 ${
                followupChannel === "gmail" ? "ce-btn-primary" : ""
              }`}
            >
              Gmail
            </button>
          </div>

          <div className="space-y-1.5">
            <label className="text-[12px] font-medium text-[var(--ink-secondary)]">
              {followupChannel === "slack" ? "Channel or Person" : "Recipient"}
            </label>
            <input
              type="text"
              value={followupTarget}
              onChange={(e) => setFollowupTarget(e.target.value)}
              placeholder={
                followupChannel === "slack"
                  ? "#eng-sync or @alex"
                  : "alex@example.com"
              }
              className="ce-input"
            />
          </div>

          {followupChannel === "gmail" && (
            <div className="space-y-1.5">
              <label className="text-[12px] font-medium text-[var(--ink-secondary)]">
                Subject
              </label>
              <input
                type="text"
                value={followupSubject}
                onChange={(e) => setFollowupSubject(e.target.value)}
                className="ce-input"
              />
            </div>
          )}

          <div className="space-y-1.5">
            <label className="text-[12px] font-medium text-[var(--ink-secondary)]">
              Message
            </label>
            <textarea
              rows={7}
              required
              value={followupBody}
              onChange={(e) => setFollowupBody(e.target.value)}
              className="ce-input resize-y"
            />
          </div>

          <div className="flex items-center justify-between pt-2">
            <button
              type="button"
              onClick={() => {
                setFollowupOpen(false);
                onNavigate("Approvals");
              }}
              className="ce-btn ce-btn-ghost text-[12px]"
            >
              Open Approvals
            </button>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setFollowupOpen(false)}
                className="ce-btn ce-btn-ghost"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={stagingFollowup}
                className="ce-btn ce-btn-primary"
              >
                <Send className="h-3.5 w-3.5" />
                Stage Draft
              </button>
            </div>
          </div>
        </form>
      </ModalDialog>
    </div>
  );
}
