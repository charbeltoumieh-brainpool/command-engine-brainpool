export type WorkspaceId =
  | "Orbit"
  | "Approvals"
  | "Work"
  | "Missions"
  | "Changes"
  | "Meetings"
  | "Memory"
  | "Studio"
  | "Engineering"
  | "System";

export type ViewId = WorkspaceId;

export interface JumpTarget {
  workspace: WorkspaceId;
  id?: string | number;
  query?: string;
}

export type ThemePreference = "dark" | "light" | "system";
export type DensityPreference = "comfortable" | "compact";

export type AutonomyPosture = "observe" | "prepare" | "autopilot";
export type ProactivityLevel = "strict" | "balanced" | "exploratory";

export type TaskKind = "code" | "call" | "review" | "reply" | "waiting";
export type Priority = "P0" | "P1" | "P2" | "P3";
export type TaskBucket = "needed_from_me" | "waiting_on_others";

export type TaskStatus =
  | "todo"
  | "in_progress"
  | "agent_staged"
  | "blocked"
  | "done"
  | "dismissed";

export type ApprovalStatus =
  | "pending"
  | "approved"
  | "executing"
  | "executed"
  | "rejected"
  | "failed";

export type AutonomyMode = "auto" | "ask_first" | "read_only_locked";
export type BriefingKind = "whats_new" | "morning" | "needed" | "eod" | "post_call";
export type EventWindow = "since_last_check" | "24h" | "7d" | "all";

export interface HealthResponse {
  ok: boolean;
  service: string;
  port: number;
  connectivity?: "online" | "degraded" | "offline" | string;
  connectivity_detail?: string;
  system_paused?: boolean;
  brand_display_name?: string;
  active_profile_id?: string;
  is_demo?: boolean;
  principal: {
    display_name?: string;
    github: string;
    email: string;
    slack_self_id: string;
    project_16_url: string;
  };
  models: {
    orchestrator: string;
    worker: string;
    embedding: string;
  };
}

export interface CoreRepoConfig {
  full_name: string;
  local_path: string;
  default_test_cmd: string;
  dev_vm_path: string;
}

export interface UserProfile {
  id: string;
  slug: string;
  display_name: string;
  role_title: string;
  org_name: string;
  brand_display_name: string;
  timezone: string;
  working_hours?: { start: string; end: string; days: number[] };
  quiet_hours?: { enabled: boolean; start: string; end: string };
  greeting_enabled: boolean;
  default_home_mode: "orbit" | "focus_list" | string;
  email: string;
  github_login: string;
  github_org: string;
  github_project_number?: number | null;
  github_project_view_url: string;
  slack_user_id: string;
  dev_vm_ssh_host: string;
  workspace_root: string;
  gateway_base_url: string;
  gateway_locked: boolean;
  model_orchestrator: string;
  model_worker: string;
  model_fast: string;
  model_embedding: string;
  council_models?: string[];
  offline_local_runner_enabled: boolean;
  offline_local_runner_url: string;
  offline_local_model: string;
  autonomy_posture: AutonomyPosture | string;
  proactivity_level: ProactivityLevel | string;
  daily_budget_usd: number;
  core_repos: Record<string, CoreRepoConfig>;
  gke_contexts: string[];
  gcp_projects: string[];
  vip_people: string[];
  voice_style: string;
  preferred_ide: string;
  personalization?: {
    adaptive_ui?: boolean;
    launch_on_login?: boolean;
    close_to_tray?: boolean;
    global_shortcut_enabled?: boolean;
    global_shortcut?: string;
    background_collectors?: boolean;
    desktop_notifications?: boolean;
  };
  onboarding_completed: boolean;
  is_demo: boolean;
  is_active: boolean;
  created_at?: string;
  updated_at?: string;
}

export interface OrbitPreviewItem {
  id: number | string;
  kind: "task" | "approval" | "meeting" | "mission" | "event" | string;
  title: string;
  meta: string;
  priority: string;
  status?: string;
}

export type PrismDomainState =
  | "quiet"
  | "attention"
  | "running"
  | "awaiting_approval"
  | "blocked"
  | "degraded"
  | "paused"
  | "offline";

export interface OrbitDomainNode {
  id: string;
  label: string;
  subtitle: string;
  target_view: WorkspaceId;
  state: PrismDomainState | string;
  active_count: number;
  urgent_count: number;
  summary: string;
  last_updated: string;
  items: OrbitPreviewItem[];
}

export interface OrbitStrand {
  from: string;
  to: string;
  state: string;
  label: string;
}

export interface OrbitBlocker {
  id: string;
  kind: string;
  title: string;
  reason: string;
  priority: string;
  target_view: WorkspaceId;
}

export interface OrbitResponse {
  profile: {
    id: string;
    display_name: string;
    role_title: string;
    org_name: string;
    brand_display_name: string;
    timezone: string;
    greeting_enabled: boolean;
    default_home_mode: string;
    autonomy_posture: AutonomyPosture | string;
    proactivity_level: ProactivityLevel | string;
    is_demo: boolean;
    onboarding_completed: boolean;
  };
  prism_core: {
    state: PrismDomainState | string;
    health_status: "online" | "degraded" | "offline" | string;
    system_paused: boolean;
    running_missions: number;
    pending_approvals: number;
    needed_from_me: number;
    waiting_on_others: number;
    last_checked_at: string;
  };
  domains: OrbitDomainNode[];
  strands: OrbitStrand[];
  priorities: TaskItem[];
  schedule: MeetingItem[];
  active_missions: MissionItem[];
  pending_approvals: ApprovalItem[];
  blockers: OrbitBlocker[];
  auth_alerts_count: number;
  auth_alerts: AuthAlert[];
}

export interface MissionStep {
  id: string;
  mission_id: string;
  seq: number;
  parent_step_id: string;
  specialist_id: string;
  step_type: string;
  title: string;
  tool_name: string;
  status: "pending" | "running" | "completed" | "waiting_approval" | "paused" | "cancelled" | "failed" | string;
  started_at: string | null;
  finished_at: string | null;
  retries: number;
  input_summary: string;
  output_summary: string;
  evidence?: Array<{ ref: string; kind?: string; source?: string; title?: string; url?: string }>;
  redacted_log: string;
  approval_id: number | null;
}

export interface MissionEvent {
  id: number;
  profile_id: string;
  mission_id: string;
  step_id: string;
  source_agent: string;
  target_agent: string;
  event_type: string;
  domain: string;
  severity: "info" | "warning" | "error" | string;
  summary: string;
  payload?: Record<string, unknown>;
  occurred_at: string;
}

export interface MissionItem {
  id: string;
  profile_id: string;
  title: string;
  instruction: string;
  domain: string;
  priority: string;
  risk_level: string;
  status: "queued" | "running" | "awaiting_approval" | "paused" | "completed" | "cancelled" | "failed" | string;
  autonomy_mode: string;
  proactivity_level: string;
  initiator: string;
  linked_task_ids?: number[];
  plan?: Array<{ seq: number; step_type: string; specialist_id: string; title: string }>;
  current_step_id: string;
  elapsed_ms: number;
  model_route: string | Record<string, unknown>;
  result_summary: string;
  artifacts?: Array<{ kind: string; id: number | string; label: string }>;
  steps: MissionStep[];
  events?: MissionEvent[];
  dry_run?: boolean;
  specialist_id?: string;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}

export interface MissionSpecialist {
  profile_id: string;
  id: string;
  name: string;
  role: string;
  department: string;
  model_tier: string;
  capabilities?: string[];
  permission_scope: string;
  enabled: number | boolean;
  updated_at: string;
}

export interface MissionsResponse {
  system_paused: boolean;
  items: MissionItem[];
  specialists: MissionSpecialist[];
  recent_events: MissionEvent[];
}

export interface DashboardKPIs {
  unread_deltas: number;
  total_events: number;
  needed_from_me: number;
  p0_urgent: number;
  waiting_on_others: number;
  pending_approvals: number;
  dirty_local_repos: number;
  indexed_vectors: number;
  connected_tools?: number;
}

export interface BriefingItem {
  id: number;
  kind: BriefingKind | string;
  title: string;
  content_md: string;
  stats_json?: string;
  stats?: {
    events_considered?: number;
    needed_from_me?: number;
    waiting_on_others?: number;
    pending_approvals?: number;
  };
  delivered_self_dm: number | boolean;
  created_at?: string;
}

export interface AgentRun {
  id: number;
  department: string;
  agent_name: string;
  model: string;
  status: string;
  trigger_source: string;
  items_processed: number;
  summary: string;
  started_at: string;
  finished_at: string | null;
  meta_json?: string;
  meta?: Record<string, unknown>;
}

export interface AuthAlert {
  id: string;
  category: string;
  name: string;
  provider: string;
  icon: string;
  accent_color: string;
  auth_status: string;
  auth_message: string;
  account_label: string;
  auth_command: string;
  updated_at?: string;
}

export interface UpcomingCallSummary {
  id: number;
  external_id: string;
  title: string;
  start_at: string;
  end_at: string;
  attendees?: string[];
  meet_url: string;
  transcript_status: string;
}

export interface DashboardSummary {
  kpis: DashboardKPIs;
  events_by_source: Record<string, number>;
  last_checked_at: string;
  watermarks: Record<string, string>;
  latest_briefing: BriefingItem | null;
  recent_agent_runs: AgentRun[];
  auth_alerts?: AuthAlert[];
  upcoming_calls?: UpcomingCallSummary[];
  core_repos: Record<string, CoreRepoConfig>;
}

export interface EventItem {
  id: number;
  source: string;
  source_id: string;
  event_type: string;
  title: string;
  summary: string;
  body: string;
  actor: string;
  url: string;
  channel_or_repo: string;
  priority: Priority | string;
  ownership_reason: string;
  is_mine: number;
  requires_action: number;
  occurred_at: string;
  ingested_at: string;
  seen_at: string | null;
  meta_json?: string;
  meta?: Record<string, unknown>;
}

export interface TaskItem {
  id: number;
  profile_id?: string;
  dedup_key: string;
  bucket: TaskBucket | string;
  status: TaskStatus | string;
  priority: Priority | string;
  source: string;
  source_ref: string;
  source_url: string;
  title: string;
  description: string;
  owner: string;
  counterparty: string;
  repo: string;
  due_at: string | null;
  meeting_id: number | null;
  approval_id: number | null;
  mission_id?: string;
  task_kind?: TaskKind | string;
  ownership_reason?: string;
  confidence?: number;
  snoozed_until?: string | null;
  created_at: string;
  updated_at: string;
  meta_json?: string;
  meta?: Record<string, unknown>;
}

export interface ApprovalItem {
  id: number;
  profile_id?: string;
  mission_id?: string;
  action_type: string;
  status: ApprovalStatus | string;
  risk_level?: "low" | "medium" | "high" | string;
  ownership_reason?: string;
  title: string;
  summary: string;
  repo: string;
  worktree_path: string;
  branch: string;
  diff_preview: string;
  test_output: string;
  payload_json?: string;
  payload?: Record<string, unknown>;
  execution_result_json?: string;
  execution_result?: Record<string, unknown>;
  created_by_agent: string;
  created_at: string;
  decided_at: string | null;
}

export interface AutonomyPolicy {
  action_type: string;
  label: string;
  category: string;
  mode: AutonomyMode;
  locked: number;
  description: string;
  updated_at: string;
}

export interface MeetingTodo {
  title: string;
  description?: string;
  priority?: string;
  repo?: string;
  suggested_followup_type?: string;
}

export interface MeetingWaitingItem {
  title: string;
  description?: string;
  counterparty?: string;
  priority?: string;
}

export interface MeetingItem {
  id: number;
  external_id: string;
  title: string;
  start_at: string;
  end_at: string;
  attendees_json?: string;
  attendees?: string[];
  meet_url: string;
  prep_brief_md: string;
  transcript_email_id?: string;
  transcript_drive_file_id?: string;
  transcript_url?: string;
  transcript_status: string;
  summary_md?: string;
  raw_transcript?: string;
  my_todos_json?: string;
  my_todos?: MeetingTodo[];
  waiting_on_others_json?: string;
  waiting_on_others?: MeetingWaitingItem[];
  created_at?: string;
  updated_at?: string;
}

export interface StaffMember {
  id: string;
  role: string;
  model: string;
  department: string;
  responsibilities: string;
}

export interface SearchHit {
  ref?: string;
  kind: "event" | "task" | "vault" | string;
  id: number;
  score: number;
  search_mode?: "hybrid" | "fts5_offline" | string;
  source: string;
  title: string;
  summary: string;
  snippet?: string;
  url: string;
  actor: string;
  priority: string;
  timestamp: string;
}

export interface SettingsMap {
  timezone: string;
  morning_briefing_time: string;
  eod_wrapup_time: string;
  delta_sync_minutes: number;
  post_meeting_delay_minutes: number;
  schedules_enabled: boolean;
  default_runner_mode: "local" | "dev_vm" | string;
  dev_vm_ssh: string;
  phoenix_url: string;
  vip_people: string[];
  voice_style: string;
  [key: string]: unknown;
}

export interface BackupItem {
  filename: string;
  size_bytes: number;
  updated_at?: string;
  created_at?: string;
  path?: string;
}

export interface DiagnosticsBundle {
  generated_at: string;
  gateway: { status: string; detail: string };
  counts: Record<string, number>;
  active_profile: Record<string, unknown>;
  settings: Record<string, unknown>;
  recent_missions: unknown[];
  backups: BackupItem[];
}

export type IntegrationCategory =
  | "coding_agent"
  | "workspace_app"
  | "cloud_infra"
  | "custom";

export interface IntegrationItem {
  id: string;
  category: IntegrationCategory | string;
  name: string;
  provider: string;
  icon: string;
  accent_color: string;
  enabled: boolean;
  is_default: boolean;
  is_builtin?: boolean;
  auth_status: "connected" | "available" | "needs_auth" | "disconnected" | string;
  auth_message: string;
  account_label: string;
  command_or_url: string;
  auth_command: string;
  scopes: string[];
  config: Record<string, unknown>;
  last_checked_at: string;
  updated_at: string;
}

export interface StandaloneRuntimeConfig {
  runtime_mode: "hybrid_t3_local" | "standalone_desktop" | "standalone_headless" | string;
  t3_bridge_active: boolean;
  standalone_port: number;
  standalone_auto_launch: boolean;
  gateway_base_url: string;
  default_coding_agent: string;
}

export interface IntegrationsResponse {
  items: IntegrationItem[];
  auth_alerts: AuthAlert[];
  runtime: StandaloneRuntimeConfig;
}

export interface BotConnectorPlan {
  id: string;
  name: string;
  provider: string;
  category: string;
  icon: string;
  accent_color: string;
  connection_method: string;
  command_or_url: string;
  auth_command: string;
  scopes: string[];
  summary: string;
  setup_steps: string[];
}

export interface AskBotConnectorResponse extends IntegrationsResponse {
  plan: BotConnectorPlan;
}

/* ================================
   AI Provider Configuration & Test
   ================================ */

export interface AIProviderPreset {
  id: string;
  name?: string;
  label: string;
  base_url: string;
  default_base_url?: string;
  default_orchestrator: string;
  default_worker: string;
  default_fast: string;
  default_embedding: string;
  recommended_models?: string[];
  requires_api_key: boolean;
  has_api_key?: boolean;
  api_key_masked?: string;
  configured?: boolean;
  is_active?: boolean;
  locked_out?: boolean;
  is_local?: boolean;
  description?: string;
  updated_at?: string;
}

export interface AIProvidersResponse {
  active_profile_id?: string;
  active_provider_id?: string;
  active_provider: string;
  gateway_locked?: boolean;
  offline_local_runner_enabled?: boolean;
  offline_local_runner_url?: string;
  offline_local_model?: string;
  active_models?: {
    orchestrator: string;
    worker: string;
    fast: string;
    embedding: string;
  };
  base_url: string;
  api_key_configured: boolean;
  api_key_masked?: string;
  model_orchestrator: string;
  model_worker: string;
  model_fast: string;
  model_embedding: string;
  providers?: AIProviderPreset[];
  presets: AIProviderPreset[];
}

export interface AIProviderTestResponse {
  ok: boolean;
  provider_id?: string;
  provider?: string;
  status_code?: number;
  model?: string;
  latency_ms?: number;
  detail?: string;
  message: string;
  models?: string[];
  chat_models?: string[];
  embedding_models?: string[];
  recommended?: {
    orchestrator: string;
    worker: string;
    fast: string;
    embedding: string;
  };
}

export interface AIProviderModelsResponse {
  ok: boolean;
  provider_id: string;
  provider_name?: string;
  live_discovered: boolean;
  detail?: string;
  models: string[];
  chat_models: string[];
  embedding_models: string[];
  recommended: {
    orchestrator: string;
    worker: string;
    fast: string;
    embedding: string;
  };
}

export interface AIUsageModelBreakdown {
  model: string;
  provider_id: string;
  calls: number;
  total_tokens: number;
  cost_usd: number;
}

export interface AIUsageDailyPoint {
  date: string;
  cost_usd: number;
  total_tokens: number;
  calls: number;
}

export interface AIProviderUsageResponse {
  profile_id: string;
  daily_budget_usd: number;
  today_usd: number;
  today_tokens: number;
  today_calls: number;
  pct_used: number;
  budget_exceeded: boolean;
  seven_day_usd: number;
  seven_day_tokens: number;
  by_model: AIUsageModelBreakdown[];
  daily_series: AIUsageDailyPoint[];
}

export interface OAuthStartResponse {
  ok: boolean;
  configured: boolean;
  authorize_url: string;
  state: string;
  provider: string;
  redirect_uri: string;
  setup_hint: string;
  launched?: boolean;
}

export interface ApprovalRewriteResponse {
  ok: boolean;
  approval_id: number;
  style: string;
  field: string;
  original_text: string;
  rewritten_text: string;
  payload: Record<string, unknown>;
  mode: string;
  approval?: ApprovalItem;
}

export interface ApprovalContextResponse {
  approval_id: number;
  related_events: EventItem[];
  related_tasks: TaskItem[];
}

export interface LiveCaptureMeetingResponse {
  ok: boolean;
  meeting_id: number;
  transcription_mode: string;
  transcribed_text: string;
  saved_audio_path: string;
  processed: Record<string, unknown> | null;
  meeting: MeetingItem;
}

export interface AttendeeBrief {
  name: string;
  email?: string;
  role?: string;
  relationship?: string;
  open_tasks_count?: number;
  recent_interactions?: string[];
  notes?: string;
}

export interface MeetingDossierResponse {
  meeting_id: number;
  title?: string;
  generated_at?: string;
  brief_md: string;
  talking_points_md?: string;
  attendee_briefs: AttendeeBrief[];
  open_commitments?: Array<{
    id?: number;
    title: string;
    bucket?: string;
    priority?: string;
    status?: string;
    counterparty?: string;
  }>;
  related_threads?: Array<{
    id?: number;
    source: string;
    title: string;
    summary?: string;
    url?: string;
    occurred_at?: string;
  }>;
  suggested_talking_points?: string[];
  cached?: boolean;
}

export interface UpcomingCallPrepItem {
  meeting_id: number;
  title: string;
  start_at: string;
  minutes_until: number;
  meet_url?: string;
  attendees?: string[];
  has_dossier?: boolean;
  one_line_brief?: string;
}

/* ================================
   Cognitive OS & Second Brain Types
   ================================ */

export type VaultFolder = "all" | "wiki" | "raw" | "daily" | "decisions";

export type VaultOriginKind =
  | "curated_unverified"
  | "ai_compiled"
  | "verified_human"
  | "decision"
  | "raw_evidence"
  | "daily"
  | "generated_ast";

export interface CognitiveOverviewStats {
  vault_notes: number;
  wiki_pages: number;
  raw_sources: number;
  due_flashcards: number;
  total_flashcards: number;
  audio_briefings: number;
  decisions_count: number;
  learned_rules: number;
  graph_nodes: number;
  graph_edges: number;
  tensions_count: number;
}

export interface ResurfaceNote {
  slug: string;
  folder: string;
  title: string;
  excerpt: string;
  updated_at: string;
}

export interface CognitiveSkill {
  id: string;
  name: string;
  category: string;
  engine: string;
  description: string;
  status: string;
}

export interface CognitiveOverviewResponse {
  stats: CognitiveOverviewStats;
  resurface_notes: ResurfaceNote[];
  skills: CognitiveSkill[];
}

export interface GraphNode {
  id: string;
  label: string;
  domain: string;
  kind: string;
  val: number;
  community: number | string;
  url?: string;
  excerpt?: string;
}

export interface GraphLink {
  source: string;
  target: string;
  relation: string;
  confidence: string | number;
}

export interface GraphGodNode {
  id: string;
  label: string;
  degree: number;
  domain: string;
}

export interface GraphSurprisingConnection {
  source: string;
  target: string;
  why: string;
}

export interface CognitiveGraphResponse {
  nodes: GraphNode[];
  links: GraphLink[];
  god_nodes: GraphGodNode[];
  surprising_connections: GraphSurprisingConnection[];
  suggested_questions: string[];
  report_md: string;
}

export type GraphifyTarget = "command-engine" | "vault" | (string & {});

export interface VaultNoteSummary {
  slug: string;
  folder: string;
  title: string;
  tags: string[];
  links_out: string[];
  backlinks: string[];
  updated_at: string;
  excerpt: string;
  origin_kind?: VaultOriginKind;
}

export interface VaultNotesResponse {
  items: VaultNoteSummary[];
  index_md: string;
  log_md: string;
}

export interface VaultNoteDetail {
  slug: string;
  folder: string;
  title: string;
  content_md: string;
  tags: string[];
  links_out: string[];
  backlinks: string[];
  updated_at: string;
  origin_kind?: VaultOriginKind;
}

export interface WikiTension {
  topic: string;
  page_a: string;
  page_b: string;
  conflict: string;
  suggested_resolution: string;
}

export interface WikiLintResponse {
  orphan_pages: string[];
  broken_links: Array<{ source?: string; target?: string; [key: string]: unknown } | string>;
  tensions: WikiTension[];
  suggested_bridges: string[];
}

export interface FlashcardItem {
  id: number | string;
  deck: string;
  front: string;
  back: string;
  source_ref: string;
  tags: string[];
  ease_factor: number;
  interval_days: number;
  repetitions: number;
  due_at: string;
}

export interface FlashcardsResponse {
  items: FlashcardItem[];
  stats: {
    due_now: number;
    total: number;
    decks: string[] | number;
  };
}

export interface AudioBriefingItem {
  id: number | string;
  title: string;
  mode: "morning_briefing" | "deep_dive" | string;
  script: string;
  audio_url: string;
  duration_est_sec: number;
  created_at: string;
}

export interface NotebookSynthesizeResponse {
  title?: string;
  format?: string;
  content_md?: string;
  output_md?: string;
  result_md?: string;
  [key: string]: unknown;
}

export interface JevTriageResponse {
  urgency: string;
  domain: string;
  intent: string;
  action_required: boolean;
  confidence: number;
  recommended_skill: string;
  routing_note: string;
  model_used: string;
}

export interface CouncilPanelist {
  model: string;
  status?: "ok" | "failed" | string;
  response_md: string;
  latency_ms: number;
}

export interface CouncilResponse {
  disabled?: boolean;
  degraded?: boolean;
  ai_mode?: string;
  disabled_reason?: string;
  panelists: CouncilPanelist[];
  synthesis_md: string;
}

export interface ResearchResponse {
  report_md: string;
  sources: Array<{ title?: string; url?: string; snippet?: string; source?: string } | string>;
  filed_wiki_slug?: string;
}

export interface LearnedRuleItem {
  id?: number | string;
  category: string;
  rule_text: string;
  created_at?: string;
}

export interface DecisionLedgerItem {
  id?: number | string;
  title: string;
  decision: string;
  alternatives_ruled_out: string;
  rationale: string;
  repo?: string;
  created_at?: string;
}

export interface HermesResponse {
  memory_md: string;
  user_md: string;
  learned_rules: LearnedRuleItem[];
  decisions: DecisionLedgerItem[];
  tensions: WikiTension[];
}

/* ================================
   Worktrees & Local Runtime Types
   ================================ */

export interface WorktreeItem {
  id: number;
  repo_key: string;
  branch: string;
  path: string;
  runner_mode: "local" | "dev_vm" | string;
  status: string;
  pr_number: number | null;
  issue_number: number | null;
  last_test_status: string;
  last_test_output: string;
  created_at: string;
  updated_at: string;
}

export interface WorktreesResponse {
  worktrees: WorktreeItem[];
  local_desktop_wip: EventItem[];
  core_repos: Record<string, CoreRepoConfig>;
}

export interface LocalRuntimeInfo {
  id: "ollama" | "lmstudio" | string;
  name: string;
  priority: number;
  running: boolean;
  cli_installed: boolean;
  cli_path: string;
  base_url: string;
  models: string[];
  chat_models: string[];
  embedding_models: string[];
  recommended_chat_model: string;
  recommended_embedding_model: string;
  error: string | null;
}

export interface OnDemandModelCatalogItem {
  id: string;
  role: string;
  label: string;
  approx_size_gb: number;
  runtime: string;
  pull_command: string;
  description: string;
}

export interface LocalRuntimeDetectResponse {
  any_running: boolean;
  preferred_runtime: string | null;
  preferred_base_url: string;
  preferred_model: string;
  runtimes: LocalRuntimeInfo[];
  on_demand_catalog: OnDemandModelCatalogItem[];
  weights_bundled: boolean;
}

export interface LocalPullPlanResponse {
  ok: boolean;
  status: string;
  downloaded: boolean;
  runtime: string;
  model_id: string;
  approx_size_gb: number | null;
  cli_available: boolean;
  command: string;
  install_url: string;
  note: string;
}

export interface AICapabilitiesResponse {
  ai_mode: "cloud" | "local" | "limited_no_key" | string;
  mode_label: string;
  provider_id: string;
  configured: boolean;
  features: Record<
    string,
    {
      available: boolean;
      tier: string;
      detail: string;
      disabled_reason?: string;
    }
  >;
}

/* ================================
   Voice Profile (Style Learning)
   ================================ */

export interface VoiceRuleItem {
  id?: number | string;
  rule: string;
  rule_text?: string;
  category?: string;
  source?: "diff" | "explicit" | string;
  confidence?: number;
  created_at?: string;
}

export interface VoiceSampleItem {
  id?: number | string;
  approval_id?: number;
  action_type?: string;
  original_text: string;
  edited_text: string;
  rules_extracted?: string[];
  summary?: string;
  created_at?: string;
}

export interface VoiceProfileResponse {
  maturity_score: number;
  total_samples?: number;
  voice_summary?: string;
  rules: VoiceRuleItem[];
  recent_samples: VoiceSampleItem[];
  updated_at?: string;
}
