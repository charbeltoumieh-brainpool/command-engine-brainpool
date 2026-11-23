import type {
  AgentRun,
  AIProviderModelsResponse,
  AIProvidersResponse,
  AIProviderTestResponse,
  AIProviderUsageResponse,
  ApprovalContextResponse,
  ApprovalItem,
  ApprovalRewriteResponse,
  AskBotConnectorResponse,
  AudioBriefingItem,
  AutonomyPolicy,
  BackupItem,
  BriefingItem,
  BriefingKind,
  CognitiveGraphResponse,
  CognitiveOverviewResponse,
  CouncilResponse,
  DashboardSummary,
  DecisionLedgerItem,
  DiagnosticsBundle,
  EventItem,
  EventWindow,
  FlashcardsResponse,
  GraphifyTarget,
  HealthResponse,
  HermesResponse,
  IntegrationItem,
  IntegrationsResponse,
  JevTriageResponse,
  LearnedRuleItem,
  LiveCaptureMeetingResponse,
  LocalPullPlanResponse,
  LocalRuntimeDetectResponse,
  AICapabilitiesResponse,
  MeetingDossierResponse,
  MeetingItem,
  MissionItem,
  MissionsResponse,
  NotebookSynthesizeResponse,
  OAuthStartResponse,
  OrbitResponse,
  ResearchResponse,
  SearchHit,
  SettingsMap,
  StaffMember,
  StandaloneRuntimeConfig,
  TaskItem,
  UpcomingCallPrepItem,
  UserProfile,
  VaultFolder,
  VaultNoteDetail,
  VaultNotesResponse,
  VoiceProfileResponse,
  WikiLintResponse,
  WorktreeItem,
  WorktreesResponse,
} from "../types/api";

const getResponseCache = new Map<string, { ts: number; data: unknown }>();
const inFlightGetMap = new Map<string, Promise<unknown>>();
const GET_CACHE_TTL_MS = 12_000;

export function invalidateApiCache(): void {
  getResponseCache.clear();
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const method = (init?.method || "GET").toUpperCase();
  if (method !== "GET") {
    invalidateApiCache();
  } else {
    const cached = getResponseCache.get(path);
    if (cached && performance.now() - cached.ts < GET_CACHE_TTL_MS) {
      return cached.data as T;
    }
    const inflight = inFlightGetMap.get(path);
    if (inflight) {
      return (await inflight) as T;
    }
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...((init?.headers as Record<string, string>) ?? {}),
  };

  const fetchPromise = (async () => {
    const resp = await fetch(path, {
      ...init,
      headers,
    });

    if (!resp.ok) {
      let message = `HTTP ${resp.status} ${resp.statusText}`;
      try {
        const body = (await resp.json()) as { detail?: unknown; message?: string };
        if (typeof body.detail === "string") {
          message = body.detail;
        } else if (body.detail) {
          message = JSON.stringify(body.detail);
        } else if (body.message) {
          message = body.message;
        }
      } catch {
        const text = await resp.text().catch(() => "");
        if (text) message = text.slice(0, 300);
      }
      throw new Error(message);
    }

    const parsed = (await resp.json()) as T;
    if (method === "GET") {
      getResponseCache.set(path, { ts: performance.now(), data: parsed });
    } else {
      invalidateApiCache();
    }
    return parsed;
  })();

  if (method === "GET") {
    inFlightGetMap.set(path, fetchPromise);
    try {
      return await fetchPromise;
    } finally {
      inFlightGetMap.delete(path);
    }
  }

  return await fetchPromise;
}

export const api = {
  /* Health, Orbit & Profiles */
  getHealth: () => request<HealthResponse>("/api/health"),

  getOrbit: () => request<OrbitResponse>("/api/orbit"),

  getProfiles: () =>
    request<{ active: UserProfile; items: UserProfile[] }>("/api/profiles"),

  createProfile: (payload: {
    display_name: string;
    role_title?: string;
    org_name?: string;
    brand_display_name?: string;
    timezone?: string;
    email?: string;
    github_login?: string;
    github_org?: string;
    slack_user_id?: string;
    autonomy_posture?: string;
    proactivity_level?: string;
    preferred_ide?: string;
    onboarding_completed?: boolean;
    is_demo?: boolean;
    activate?: boolean;
  }) =>
    request<{ profile: UserProfile; active: UserProfile }>("/api/profiles", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  patchProfile: (profileId: string, patch: Partial<UserProfile>) =>
    request<{ profile: UserProfile }>(
      `/api/profiles/${encodeURIComponent(profileId)}`,
      {
        method: "PATCH",
        body: JSON.stringify(patch),
      }
    ),

  activateProfile: (profileId: string) =>
    request<{ active: UserProfile; items: UserProfile[] }>(
      `/api/profiles/${encodeURIComponent(profileId)}/activate`,
      { method: "POST" }
    ),

  /* Durable Missions & Global Pause */
  getMissions: (status?: string) => {
    const qs = status && status !== "all" ? `?status=${encodeURIComponent(status)}` : "";
    return request<MissionsResponse>(`/api/missions${qs}`);
  },

  getMissionDetail: (missionId: string) =>
    request<{ mission: MissionItem }>(
      `/api/missions/${encodeURIComponent(missionId)}`
    ),

  dispatchMission: (payload: {
    instruction: string;
    title?: string;
    task_id?: number | null;
    domain?: string | null;
    priority?: string;
    dry_run?: boolean;
    stage_outbound_if_needed?: boolean;
    idempotency_key?: string;
  }) =>
    request<{ mission: MissionItem }>("/api/missions", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  controlMission: (
    missionId: string,
    action: "pause" | "resume" | "cancel" | "retry"
  ) =>
    request<{ mission: MissionItem }>(
      `/api/missions/${encodeURIComponent(missionId)}/${action}`,
      { method: "POST" }
    ),

  stageMissionWorktreeDiff: (
    missionId: string,
    payload: {
      repo?: string;
      branch?: string;
      worktree_path?: string;
      diff_preview?: string;
      title?: string;
      summary?: string;
    }
  ) =>
    request<{ ok: boolean; approval_id?: number }>(
      `/api/missions/${encodeURIComponent(missionId)}/stage-worktree-diff`,
      {
        method: "POST",
        body: JSON.stringify(payload),
      }
    ),

  setSystemPaused: (paused: boolean) =>
    request<{ paused: boolean; halted_missions: number }>("/api/system/pause", {
      method: "POST",
      body: JSON.stringify({ paused }),
    }),

  /* Dashboard, Events & Tasks */
  getDashboard: () => request<DashboardSummary>("/api/dashboard"),

  sweep: (includeMcpHeadless: boolean, sources: string[] | null = null) =>
    request<Record<string, unknown>>("/api/sweep", {
      method: "POST",
      body: JSON.stringify({
        include_mcp_headless: includeMcpHeadless,
        sources,
      }),
    }),

  getEvents: (params: {
    source?: string;
    window?: EventWindow;
    requires_action_only?: boolean;
    limit?: number;
  }) => {
    const qs = new URLSearchParams();
    if (params.source && params.source !== "all") qs.set("source", params.source);
    if (params.window) qs.set("window", params.window);
    if (params.requires_action_only) qs.set("requires_action_only", "true");
    if (params.limit) qs.set("limit", String(params.limit));
    return request<{ items: EventItem[]; last_checked_at: string }>(
      `/api/events?${qs.toString()}`
    );
  },

  markAllEventsChecked: () =>
    request<{ ok: boolean; user_last_checked: string }>("/api/events/mark-checked", {
      method: "POST",
    }),

  getTasks: (params?: { bucket?: string; include_done?: boolean }) => {
    const qs = new URLSearchParams();
    if (params?.bucket) qs.set("bucket", params.bucket);
    if (params?.include_done) qs.set("include_done", "true");
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return request<{ items: TaskItem[] }>(`/api/tasks${suffix}`);
  },

  createTask: (payload: {
    title: string;
    description?: string;
    bucket?: string;
    priority?: string;
    source?: string;
    source_url?: string;
    repo?: string;
    counterparty?: string;
    due_at?: string | null;
  }) =>
    request<{ task: TaskItem }>("/api/tasks", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  patchTask: (
    taskId: number,
    payload: {
      status?: string;
      priority?: string;
      bucket?: string;
      title?: string;
      description?: string;
      task_kind?: string;
      snoozed_until?: string | null;
    }
  ) =>
    request<{ task: TaskItem }>(`/api/tasks/${taskId}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    }),

  dismissTask: (taskId: number) =>
    request<{ task: TaskItem }>(`/api/tasks/${taskId}/dismiss`, {
      method: "POST",
    }),

  restoreTask: (taskId: number) =>
    request<{ task: TaskItem }>(`/api/tasks/${taskId}/restore`, {
      method: "POST",
    }),

  /* Approvals & Autonomy */
  getApprovals: (status?: string) => {
    const qs = status && status !== "all" ? `?status=${encodeURIComponent(status)}` : "";
    return request<{ items: ApprovalItem[] }>(`/api/approvals${qs}`);
  },

  stageApproval: (payload: {
    action_type: string;
    title: string;
    summary?: string;
    repo?: string;
    worktree_path?: string;
    branch?: string;
    diff_preview?: string;
    test_output?: string;
    ownership_reason?: string;
    payload: Record<string, unknown>;
  }) =>
    request<{
      status: string;
      approval_id?: number;
      mode?: string;
      result?: Record<string, unknown>;
    }>("/api/approvals/stage", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  decideApproval: (
    approvalId: number,
    decision: "approve" | "reject",
    editedPayload?: Record<string, unknown> | null,
    undoWindowSec = 0
  ) =>
    request<{
      status: string;
      approval_id: number;
      delay_seconds?: number;
      execute_at?: string;
      result?: Record<string, unknown>;
      voice_learned?: {
        learned: boolean;
        rules_added?: Array<
          string | { id?: number; rule_text?: string; rule?: string; confidence?: number }
        >;
      };
    }>(`/api/approvals/${approvalId}/decide`, {
      method: "POST",
      body: JSON.stringify({
        decision,
        edited_payload: editedPayload ?? null,
        undo_window_sec: undoWindowSec,
      }),
    }),

  getVoiceProfile: () => request<VoiceProfileResponse>("/api/voice/profile"),

  learnVoice: (payload: {
    rule?: string;
    category?: string;
    original_text?: string;
    edited_text?: string;
    approval_id?: number;
  }) =>
    request<{
      ok: boolean;
      profile?: VoiceProfileResponse;
      rules_added?: string[];
    }>("/api/voice/learn", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  undoApproval: (approvalId: number) =>
    request<{ status: string; approval_id: number; undone: boolean }>(
      `/api/approvals/${approvalId}/undo`,
      { method: "POST" }
    ),
  rewriteApprovalDraft: (
    approvalId: number,
    style: string,
    customInstruction = ""
  ) =>
    request<ApprovalRewriteResponse>(`/api/approvals/${approvalId}/rewrite`, {
      method: "POST",
      body: JSON.stringify({
        style,
        custom_instruction: customInstruction,
      }),
    }),

  getApprovalContext: (approvalId: number) =>
    request<ApprovalContextResponse>(`/api/approvals/${approvalId}/context`),

  getAutonomyPolicies: () =>
    request<{
      autonomy_posture?: string;
      proactivity_level?: string;
      items: AutonomyPolicy[];
    }>("/api/autonomy"),

  updateAutonomyPolicy: (actionType: string, mode: "auto" | "ask_first") =>
    request<{ policy: AutonomyPolicy }>(
      `/api/autonomy/${encodeURIComponent(actionType)}`,
      {
        method: "PATCH",
        body: JSON.stringify({ mode }),
      }
    ),

  /* Meetings */
  getMeetings: () => request<{ items: MeetingItem[] }>("/api/meetings"),

  ingestMeeting: (payload: {
    external_id: string;
    title: string;
    start_at?: string;
    end_at?: string;
    attendees?: string[];
    meet_url?: string;
    transcript_url?: string;
    raw_transcript?: string;
    auto_process?: boolean;
  }) =>
    request<{ meeting_id: number; processed: Record<string, unknown> | null }>(
      "/api/meetings",
      {
        method: "POST",
        body: JSON.stringify(payload),
      }
    ),

  processMeeting: (meetingId: number) =>
    request<{
      meeting_id: number;
      my_todos?: unknown[];
      waiting_on_others?: unknown[];
      staged_approvals?: number;
      status?: string;
    }>(`/api/meetings/${meetingId}/process`, {
      method: "POST",
    }),

  liveCaptureMeeting: (payload: {
    title?: string;
    meeting_id?: number | null;
    attendees?: string[];
    live_notes?: string;
    transcript_text?: string;
    audio_base64?: string;
    audio_mime?: string;
    duration_sec?: number;
    auto_process?: boolean;
  }) =>
    request<LiveCaptureMeetingResponse>("/api/meetings/live-capture", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  getMeetingDossier: (meetingId: number, refresh = false) =>
    request<MeetingDossierResponse>(
      `/api/meetings/${meetingId}/dossier${refresh ? "?refresh=true" : ""}`
    ),

  getUpcomingCallPrep: (withinMinutes = 15) =>
    request<{ items: UpcomingCallPrepItem[] }>(
      `/api/meetings/upcoming-prep?within_minutes=${withinMinutes}`
    ),

  /* Engineering & Isolated Worktrees */
  getWorktrees: () => request<WorktreesResponse>("/api/worktrees"),

  createWorktree: (payload: {
    repo_key: string;
    branch: string;
    base_ref?: string;
    runner_mode?: string;
    pr_number?: number | null;
    issue_number?: number | null;
  }) =>
    request<{ worktree: WorktreeItem }>("/api/worktrees", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  testWorktree: (worktreeId: number, customCmd?: string | null) =>
    request<{
      worktree_id: number;
      status: string;
      exit_code: number;
      output: string;
    }>(`/api/worktrees/${worktreeId}/test`, {
      method: "POST",
      body: JSON.stringify({ custom_cmd: customCmd ?? null }),
    }),

  openInIde: (path: string, ide = "vscode") =>
    request<{ opened: boolean; ide?: string; path: string; reason?: string }>(
      "/api/engineering/open-ide",
      {
        method: "POST",
        body: JSON.stringify({ path, ide }),
      }
    ),

  /* Staff, Briefings & Ask */
  getStaff: () =>
    request<{ roster: StaffMember[]; runs: AgentRun[] }>("/api/staff"),

  getBriefings: () => request<{ items: BriefingItem[] }>("/api/briefings"),

  generateBriefing: (payload: {
    kind: BriefingKind;
    deliver_self_dm: boolean;
    since_last_check_only?: boolean;
  }) =>
    request<BriefingItem>("/api/briefings/generate", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  askChiefOfStaff: (question: string) =>
    request<{ answer_md: string; citations: SearchHit[]; mode?: string }>(
      "/api/ask",
      {
        method: "POST",
        body: JSON.stringify({ question }),
      }
    ),

  askStream: async (
    question: string,
    handlers: {
      onToken: (token: string) => void;
      onCitations?: (citations: SearchHit[]) => void;
      onDone?: (result: { answer_md: string; citations: SearchHit[]; mode?: string }) => void;
      onError?: (error: Error) => void;
      signal?: AbortSignal;
    }
  ): Promise<void> => {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    };

    try {
      const resp = await fetch("/api/ask/stream", {
        method: "POST",
        headers,
        body: JSON.stringify({ question }),
        signal: handlers.signal,
      });

      if (resp.status === 404 || resp.status === 405 || !resp.body) {
        const res = await api.askChiefOfStaff(question);
        if (handlers.signal?.aborted) return;
        if (res.citations?.length) handlers.onCitations?.(res.citations);
        if (res.answer_md) handlers.onToken(res.answer_md);
        handlers.onDone?.(res);
        return;
      }

      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
      }

      const contentType = resp.headers.get("content-type") ?? "";
      if (!contentType.includes("text/event-stream")) {
        const json = (await resp.json()) as {
          answer_md?: string;
          citations?: SearchHit[];
          mode?: string;
        };
        if (handlers.signal?.aborted) return;
        const citations = json.citations ?? [];
        const answer_md = json.answer_md ?? "";
        if (citations.length) handlers.onCitations?.(citations);
        if (answer_md) handlers.onToken(answer_md);
        handlers.onDone?.({ answer_md, citations, mode: json.mode });
        return;
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let buffer = "";
      let accumulated = "";
      let citations: SearchHit[] = [];
      let mode: string | undefined;
      let doneEmitted = false;

      const processLine = (rawLine: string) => {
        const line = rawLine.trim();
        if (!line || line.startsWith(":")) return;
        if (!line.startsWith("data:")) return;
        const dataStr = line.slice(5).trim();
        if (dataStr === "[DONE]") {
          if (!doneEmitted) {
            doneEmitted = true;
            handlers.onDone?.({ answer_md: accumulated, citations, mode });
          }
          return;
        }
        try {
          const parsed = JSON.parse(dataStr) as {
            type?: string;
            token?: string;
            delta?: string;
            text?: string;
            answer_md?: string;
            citations?: SearchHit[];
            mode?: string;
            error?: string;
            message?: string;
          };
          if (parsed.type === "error" || parsed.error) {
            throw new Error(parsed.error || parsed.message || "Streaming error");
          }
          if (Array.isArray(parsed.citations)) {
            citations = parsed.citations;
            handlers.onCitations?.(citations);
          }
          const chunk = parsed.token ?? parsed.delta ?? parsed.text;
          if (typeof chunk === "string" && chunk.length > 0) {
            accumulated += chunk;
            handlers.onToken(chunk);
          }
          if (parsed.mode) mode = parsed.mode;
          if (parsed.type === "done" || (typeof parsed.answer_md === "string" && parsed.type !== "token")) {
            const finalAnswer = parsed.answer_md ?? accumulated;
            if (!accumulated && finalAnswer) {
              accumulated = finalAnswer;
              handlers.onToken(finalAnswer);
            }
            if (!doneEmitted) {
              doneEmitted = true;
              handlers.onDone?.({ answer_md: finalAnswer, citations, mode });
            }
          }
        } catch (err) {
          if (err instanceof SyntaxError) {
            accumulated += dataStr;
            handlers.onToken(dataStr);
          } else {
            throw err;
          }
        }
      };

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (handlers.signal?.aborted) {
          await reader.cancel().catch(() => {});
          return;
        }
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          processLine(line);
        }
      }

      if (buffer.trim()) {
        processLine(buffer);
      }

      if (!doneEmitted && !handlers.signal?.aborted) {
        handlers.onDone?.({ answer_md: accumulated, citations, mode });
      }
    } catch (err) {
      if (handlers.signal?.aborted) return;
      const error = err instanceof Error ? err : new Error(String(err));
      handlers.onError?.(error);
      throw error;
    }
  },

  searchMemory: (q: string, source?: string, limit = 20) => {
    const qs = new URLSearchParams({ q, limit: String(limit) });
    if (source && source !== "all") qs.set("source", source);
    return request<{ query: string; search_mode?: string; items: SearchHit[] }>(
      `/api/search?${qs.toString()}`
    );
  },

  /* Settings, Backups & Diagnostics */
  getSettings: () => request<{ settings: SettingsMap }>("/api/settings"),

  updateSettings: (payload: Partial<SettingsMap>) =>
    request<{ settings: SettingsMap }>("/api/settings", {
      method: "PUT",
      body: JSON.stringify(payload),
    }),

  getBackups: () => request<{ items: BackupItem[] }>("/api/system/backups"),

  createBackup: (label = "manual") =>
    request<{ backup: BackupItem }>("/api/system/backup", {
      method: "POST",
      body: JSON.stringify({ label }),
    }),

  restoreBackup: (filename: string) =>
    request<{
      restore: {
        restored_from: string;
        pre_restore_backup: string;
        restored_at: string;
      };
    }>("/api/system/restore", {
      method: "POST",
      body: JSON.stringify({ filename }),
    }),

  getDiagnostics: () => request<DiagnosticsBundle>("/api/system/diagnostics"),

  /* Cognitive OS & Second Brain */
  getCognitiveOverview: () =>
    request<CognitiveOverviewResponse>("/api/cognitive/overview"),

  getCognitiveGraph: () =>
    request<CognitiveGraphResponse>("/api/cognitive/graph"),

  runGraphify: (payload: { target: GraphifyTarget; export_wiki?: boolean }) =>
    request<Record<string, unknown>>("/api/cognitive/graphify/run", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  getVaultNotes: (folder: VaultFolder = "all") =>
    request<VaultNotesResponse>(
      `/api/cognitive/vault/notes?folder=${encodeURIComponent(folder)}`
    ),

  getVaultNote: (folder: string, slug: string) =>
    request<VaultNoteDetail>(
      `/api/cognitive/vault/note/${encodeURIComponent(folder)}/${encodeURIComponent(slug)}`
    ),

  saveVaultNote: (
    folder: string,
    slug: string,
    payload: { title?: string; content_md: string }
  ) =>
    request<VaultNoteDetail>(
      `/api/cognitive/vault/note/${encodeURIComponent(folder)}/${encodeURIComponent(slug)}`,
      {
        method: "PUT",
        body: JSON.stringify(payload),
      }
    ),

  deleteVaultNote: (folder: string, slug: string) =>
    request<{ deleted: boolean; folder: string; slug: string }>(
      `/api/cognitive/vault/note/${encodeURIComponent(folder)}/${encodeURIComponent(slug)}`,
      { method: "DELETE" }
    ),

  compileWikiSource: (payload: {
    title: string;
    source_type: string;
    raw_content: string;
    source_url?: string;
  }) =>
    request<Record<string, unknown>>("/api/cognitive/wiki/compile", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  lintWiki: () =>
    request<WikiLintResponse>("/api/cognitive/wiki/lint", {
      method: "POST",
    }),

  getFlashcards: (params?: { due_only?: boolean; deck?: string }) => {
    const qs = new URLSearchParams();
    qs.set("due_only", params?.due_only ? "true" : "false");
    qs.set("deck", params?.deck ?? "");
    return request<FlashcardsResponse>(`/api/cognitive/flashcards?${qs.toString()}`);
  },

  generateFlashcards: (payload: {
    deck: string;
    source_title: string;
    source_text: string;
    count?: number;
  }) =>
    request<Record<string, unknown>>("/api/cognitive/flashcards/generate", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  reviewFlashcard: (cardId: number | string, rating: 1 | 2 | 3 | 4) =>
    request<Record<string, unknown>>(
      `/api/cognitive/flashcards/${encodeURIComponent(String(cardId))}/review`,
      {
        method: "POST",
        body: JSON.stringify({ rating }),
      }
    ),

  getAudioBriefings: () =>
    request<{ items: AudioBriefingItem[] }>("/api/cognitive/audio"),

  generateAudioBriefing: (payload: {
    title: string;
    mode: "morning_briefing" | "deep_dive";
    source_text?: string;
  }) =>
    request<AudioBriefingItem>("/api/cognitive/audio/generate", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  synthesizeNotebook: (payload: {
    title: string;
    format: "study_guide" | "faq" | "mindmap_md" | "briefing_doc";
    source_slugs: string[];
    extra_context?: string;
  }) =>
    request<NotebookSynthesizeResponse>("/api/cognitive/notebook/synthesize", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  jevTriage: (text: string) =>
    request<JevTriageResponse>("/api/cognitive/jev-triage", {
      method: "POST",
      body: JSON.stringify({ text }),
    }),

  conveneCouncil: (prompt: string) =>
    request<CouncilResponse>("/api/cognitive/council", {
      method: "POST",
      body: JSON.stringify({ prompt }),
    }),

  deepResearch: (payload: { query: string; file_to_wiki?: boolean }) =>
    request<ResearchResponse>("/api/cognitive/research", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  getHermes: () => request<HermesResponse>("/api/cognitive/hermes"),

  updateHermesMemory: (payload: { memory_md?: string; user_md?: string }) =>
    request<HermesResponse>("/api/cognitive/hermes/memory", {
      method: "PUT",
      body: JSON.stringify(payload),
    }),

  addHermesRule: (payload: { category: string; rule_text: string }) =>
    request<{ rule?: LearnedRuleItem; [key: string]: unknown }>(
      "/api/cognitive/hermes/rules",
      {
        method: "POST",
        body: JSON.stringify(payload),
      }
    ),

  addDecision: (payload: {
    title: string;
    decision: string;
    alternatives_ruled_out: string;
    rationale: string;
    repo?: string;
  }) =>
    request<{ decision?: DecisionLedgerItem; [key: string]: unknown }>(
      "/api/cognitive/decisions",
      {
        method: "POST",
        body: JSON.stringify(payload),
      }
    ),

  /* Integrations & Connectors */
  getIntegrations: () => request<IntegrationsResponse>("/api/integrations"),

  probeIntegrations: () =>
    request<IntegrationsResponse>("/api/integrations/probe", {
      method: "POST",
    }),

  patchIntegration: (
    integrationId: string,
    payload: Partial<
      Pick<
        IntegrationItem,
        | "enabled"
        | "is_default"
        | "auth_status"
        | "auth_message"
        | "account_label"
        | "command_or_url"
        | "auth_command"
        | "config"
      >
    >
  ) =>
    request<IntegrationsResponse>(
      `/api/integrations/${encodeURIComponent(integrationId)}`,
      {
        method: "PATCH",
        body: JSON.stringify(payload),
      }
    ),

  triggerIntegrationAuth: (
    integrationId: string,
    payload: {
      mode?: "verify" | "launch" | "token" | "disconnect" | "verify_or_launch";
      launch_browser?: boolean;
      api_token?: string;
      mcp_server_url?: string;
      account_label?: string;
    }
  ) =>
    request<IntegrationsResponse & { launched: boolean }>(
      `/api/integrations/${encodeURIComponent(integrationId)}/auth`,
      {
        method: "POST",
        body: JSON.stringify(payload),
      }
    ),

  askBotConnector: (payload: {
    request_text: string;
    category_hint?: string;
    auto_register?: boolean;
  }) =>
    request<AskBotConnectorResponse>("/api/integrations/ask-bot", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  patchStandaloneRuntime: (payload: Partial<StandaloneRuntimeConfig>) =>
    request<IntegrationsResponse>("/api/integrations/runtime", {
      method: "PATCH",
      body: JSON.stringify(payload),
    }),

  deleteIntegration: (integrationId: string) =>
    request<IntegrationsResponse>(
      `/api/integrations/${encodeURIComponent(integrationId)}`,
      {
        method: "DELETE",
      }
    ),

  startIntegrationOAuth: (
    integrationId: string,
    payload?: {
      client_id?: string;
      client_secret?: string;
      redirect_uri?: string;
      open_browser?: boolean;
    }
  ) =>
    request<OAuthStartResponse>(
      `/api/integrations/${encodeURIComponent(integrationId)}/oauth/start`,
      {
        method: "POST",
        body: JSON.stringify(payload ?? {}),
      }
    ),

  /* AI Provider Presets & Connection Testing */
  getAIProviders: () => request<AIProvidersResponse>("/api/ai/providers"),

  getAIProviderUsage: () =>
    request<AIProviderUsageResponse>("/api/ai/providers/usage"),

  getAIProviderModels: (params?: { provider_id?: string; refresh?: boolean }) => {
    const qs = new URLSearchParams();
    if (params?.provider_id) qs.set("provider_id", params.provider_id);
    if (params?.refresh) qs.set("refresh", "true");
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return request<AIProviderModelsResponse>(`/api/ai/providers/models${suffix}`);
  },

  configureAIProvider: (payload: {
    provider_id: string;
    base_url?: string;
    api_key?: string;
    model_orchestrator?: string;
    model_worker?: string;
    model_fast?: string;
    model_embedding?: string;
    offline_local_runner_enabled?: boolean;
    offline_local_runner_url?: string;
    offline_local_model?: string;
    activate?: boolean;
  }) =>
    request<AIProvidersResponse>("/api/ai/providers/configure", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  testAIProvider: (payload: {
    provider_id: string;
    base_url?: string;
    api_key?: string;
    model?: string;
  }) =>
    request<AIProviderTestResponse>("/api/ai/providers/test", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  detectLocalRuntimes: () =>
    request<LocalRuntimeDetectResponse>("/api/ai/providers/local/detect"),

  getLocalPullPlan: (payload: { model_id: string; runtime?: string }) =>
    request<LocalPullPlanResponse>("/api/ai/providers/local/pull-plan", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  getAICapabilities: () =>
    request<AICapabilitiesResponse>("/api/ai/providers/capabilities"),
};
