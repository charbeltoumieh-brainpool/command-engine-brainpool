import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  ChevronDown,
  ChevronRight,
  Cloud,
  Code2,
  FolderGit2,
  GitBranch,
  Laptop,
  Lock,
  Play,
  Plus,
  RefreshCw,
  Server,
  Terminal,
  UploadCloud,
} from "lucide-react";
import { api } from "../lib/api";
import { formatDurationMs, formatRelativeTime } from "../lib/format";
import { desktopBridge } from "../lib/platform";
import { useListKeyboardNav } from "../lib/useListKeyboardNav";
import type {
  CoreRepoConfig,
  EventItem,
  SettingsMap,
  UserProfile,
  WorktreeItem,
  WorkspaceId,
} from "../types/api";
import { ErrorBanner, SkeletonRows, StatusBadge } from "../components/Badges";
import { DiffViewer } from "../components/DiffViewer";
import { ModalDialog } from "../components/Overlays";
import { useToast } from "../components/ToastContext";
import { WorkspaceHeader } from "../components/WorkspaceHeader";

export interface EngineeringViewProps {
  refreshSignal: number;
  onNavigate: (ws: WorkspaceId) => void;
  onStateMutated: () => void;
  prefillWorktree?: { repoKey: string; branch: string } | null;
  onClearPrefill?: () => void;
}

type EngineeringTab = "repos_wip" | "worktrees" | "cloud_watch";

interface IdeDescriptor {
  id: string;
  label: string;
  cli: string;
}

function resolveIdeDescriptor(preferredIde?: string | null): IdeDescriptor {
  const raw = (preferredIde || "vscode").trim().toLowerCase();
  switch (raw) {
    case "cursor":
      return { id: "cursor", label: "Cursor", cli: "cursor" };
    case "zed":
      return { id: "zed", label: "Zed", cli: "zed" };
    case "windsurf":
      return { id: "windsurf", label: "Windsurf", cli: "windsurf" };
    case "antigravity":
      return { id: "antigravity", label: "Antigravity", cli: "antigravity" };
    case "t3-code":
    case "t3code":
    case "t3 code":
    case "t3":
      return { id: "t3-code", label: "T3 Code", cli: "t3" };
    case "opencode":
      return { id: "opencode", label: "OpenCode", cli: "opencode" };
    case "vscode":
    case "code":
    case "vs code":
    case "vs-code":
    case "":
      return { id: "vscode", label: "VS Code", cli: "code" };
    default: {
      const clean = raw.replace(/[^a-z0-9_-]/g, "") || "code";
      const label = clean.charAt(0).toUpperCase() + clean.slice(1);
      return { id: clean, label, cli: clean };
    }
  }
}

function formatIdeCliCommand(cli: string, targetPath: string): string {
  const safePath = targetPath.replace(/"/g, '\\"');
  return `${cli} "${safePath}"`;
}

function worktreeStatusDotClass(status?: string, isTesting?: boolean): string {
  if (isTesting) return "bg-[var(--amber)] animate-pulse";
  const s = (status || "not_run").toLowerCase();
  if (s === "passed" || s === "ok" || s === "clean") return "bg-[var(--sage)]";
  if (s === "failed" || s === "error") return "bg-[var(--coral)]";
  if (s === "running") return "bg-[var(--amber)]";
  return "bg-[var(--subtle)]";
}

function friendlyClusterName(ctx: string): string {
  const trimmed = ctx.trim();
  if (trimmed.startsWith("gke_")) {
    const parts = trimmed.split("_");
    if (parts.length >= 4) {
      return parts.slice(3).join("_");
    }
  }
  if (trimmed.includes("/")) {
    const last = trimmed.split("/").pop();
    if (last) return last;
  }
  return trimmed;
}

function parseRepoDisplay(key: string, cfg: CoreRepoConfig): {
  shortName: string;
  orgPrefix: string;
} {
  const full = (cfg.full_name || "").trim();
  if (full.includes("/")) {
    const parts = full.split("/");
    const shortName = parts.pop() || key;
    const orgPrefix = parts.join("/");
    return { shortName, orgPrefix };
  }
  return { shortName: key, orgPrefix: "" };
}

function matchRepoWip(
  repoKey: string,
  cfg: CoreRepoConfig,
  wipItems: EventItem[]
): EventItem[] {
  const keyLower = repoKey.toLowerCase();
  const fullLower = (cfg.full_name || "").toLowerCase();
  const localLower = (cfg.local_path || "").toLowerCase();

  return wipItems.filter((item) => {
    const channel = (item.channel_or_repo || "").toLowerCase();
    const title = (item.title || "").toLowerCase();
    const sourceId = (item.source_id || "").toLowerCase();
    const body = (item.body || "").toLowerCase();

    if (
      channel &&
      (channel.includes(keyLower) || (fullLower && channel.includes(fullLower)))
    ) {
      return true;
    }
    if (title.includes(keyLower) || sourceId.includes(keyLower)) {
      return true;
    }
    if (localLower && body.includes(localLower)) {
      return true;
    }
    return false;
  });
}

function parseWipDetails(wip: EventItem): {
  branch: string | null;
  files: string[];
  dirtyCount: number | null;
  isDiffShaped: boolean;
  diffText: string;
} {
  const combined = `${wip.title || ""}\n${wip.summary || ""}\n${wip.body || ""}`;

  let branch: string | null = null;
  const branchPatterns = [
    /##\s+([^\s.]+)(?:\.\.\.[^\s]+)?/,
    /(?:on\s+branch|branch[:\s]+)\s*`?([A-Za-z0-9._/-]+)`?/i,
    /@\s*([A-Za-z0-9._/-]+)/,
  ];
  for (const re of branchPatterns) {
    const m = re.exec(combined);
    if (m && m[1] && m[1] !== "HEAD") {
      branch = m[1];
      break;
    }
  }

  const lines = (wip.body || "").replace(/\r\n/g, "\n").split("\n");
  const fileSet = new Set<string>();

  for (const line of lines) {
    const diffMatch = /^diff --git\s+a\/(.+?)\s+b\/(.+)$/.exec(line);
    if (diffMatch) {
      fileSet.add(diffMatch[2]);
      continue;
    }
    const statusMatch = /^\s*(?:M|A|D|R|C|U|\?\?)\s+(.+)$/.exec(line);
    if (statusMatch) {
      fileSet.add(statusMatch[1].trim());
    }
  }

  let dirtyCount: number | null = null;
  if (fileSet.size > 0) {
    dirtyCount = fileSet.size;
  } else {
    const countMatch = /(\d+)\s+(?:dirty|modified|changed|untracked)\s+files?/i.exec(
      combined
    );
    if (countMatch) {
      dirtyCount = Number(countMatch[1]);
    }
  }

  const diffStartIdx = lines.findIndex(
    (l) =>
      l.startsWith("diff --git") ||
      l.startsWith("--- ") ||
      l.startsWith("@@")
  );
  const hasHunkLines = lines.some(
    (l) =>
      l.startsWith("@@") ||
      (l.startsWith("+++ ") && lines.some((x) => x.startsWith("--- ")))
  );
  const isDiffShaped = diffStartIdx !== -1 || hasHunkLines;
  const diffText =
    diffStartIdx !== -1 ? lines.slice(diffStartIdx).join("\n").trim() : "";

  return {
    branch,
    files: Array.from(fileSet),
    dirtyCount,
    isDiffShaped,
    diffText,
  };
}

function summarizeRepoWip(wipItems: EventItem[]): {
  branch: string;
  modifiedCount: number;
  files: string[];
  diffText: string;
} {
  let detectedBranch: string | null = null;
  const files = new Set<string>();
  let fallbackCount = 0;
  const diffs: string[] = [];

  for (const item of wipItems) {
    const parsed = parseWipDetails(item);
    if (!detectedBranch && parsed.branch) {
      detectedBranch = parsed.branch;
    }
    for (const f of parsed.files) {
      files.add(f);
    }
    if (parsed.files.length === 0) {
      fallbackCount += parsed.dirtyCount ?? 1;
    }
    if (parsed.isDiffShaped && parsed.diffText) {
      diffs.push(parsed.diffText);
    }
  }

  const modifiedCount = files.size > 0 ? files.size : fallbackCount;
  return {
    branch: detectedBranch || "main",
    modifiedCount,
    files: Array.from(files),
    diffText: diffs.join("\n"),
  };
}

function extractDiffFromText(text?: string | null): string {
  if (!text) return "";
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const idx = lines.findIndex(
    (l) => l.startsWith("diff --git") || l.startsWith("--- ") || l.startsWith("@@")
  );
  if (idx === -1) return "";
  return lines.slice(idx).join("\n").trim();
}

export function EngineeringView({
  refreshSignal,
  onNavigate,
  onStateMutated,
  prefillWorktree = null,
  onClearPrefill,
}: EngineeringViewProps) {
  const { pushToast } = useToast();

  const [activeTab, setActiveTab] = useState<EngineeringTab>("repos_wip");
  const [worktrees, setWorktrees] = useState<WorktreeItem[]>([]);
  const [localWip, setLocalWip] = useState<EventItem[]>([]);
  const [coreRepos, setCoreRepos] = useState<Record<string, CoreRepoConfig>>({});
  const [gkeEvents, setGkeEvents] = useState<EventItem[]>([]);
  const [activeProfile, setActiveProfile] = useState<UserProfile | null>(null);
  const [settings, setSettings] = useState<SettingsMap | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);

  const [selectedWtId, setSelectedWtId] = useState<number | null>(null);
  const [expandedRepos, setExpandedRepos] = useState<Record<string, boolean>>({});
  const [expandedSignals, setExpandedSignals] = useState<Record<number, boolean>>({});

  // Create Sandbox Modal
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [repoKey, setRepoKey] = useState("");
  const [branch, setBranch] = useState("");
  const [baseRef, setBaseRef] = useState("origin/main");
  const [runnerMode, setRunnerMode] = useState<"local" | "dev_vm">("local");
  const [prNumber, setPrNumber] = useState("");
  const [issueNumber, setIssueNumber] = useState("");
  const [creating, setCreating] = useState(false);

  // Sandbox action states
  const [testingId, setTestingId] = useState<number | null>(null);
  const [runnerOverrideByWt, setRunnerOverrideByWt] = useState<
    Record<number, "local" | "dev_vm">
  >({});
  const [openingIdePath, setOpeningIdePath] = useState<string | null>(null);
  const [stagingPushId, setStagingPushId] = useState<number | null>(null);
  const [confirmPushWt, setConfirmPushWt] = useState<WorktreeItem | null>(null);
  const [stagedLinkReady, setStagedLinkReady] = useState<string | null>(null);
  const [openLogByWt, setOpenLogByWt] = useState<Record<number, boolean>>({});
  const [openDiffByWt, setOpenDiffByWt] = useState<Record<number, boolean>>({});
  const [lastDurationByWt, setLastDurationByWt] = useState<Record<number, number>>({});

  const ideSpec = useMemo(
    () => resolveIdeDescriptor(activeProfile?.preferred_ide),
    [activeProfile?.preferred_ide]
  );

  const sshHost = useMemo(() => {
    const fromProfile = activeProfile?.dev_vm_ssh_host?.trim();
    if (fromProfile) return fromProfile;
    const fromSettings =
      typeof settings?.dev_vm_ssh === "string" ? settings.dev_vm_ssh.trim() : "";
    return fromSettings;
  }, [activeProfile?.dev_vm_ssh_host, settings?.dev_vm_ssh]);

  const clusterContexts = useMemo(
    () => (activeProfile?.gke_contexts ?? []).filter((c) => Boolean(c?.trim())),
    [activeProfile?.gke_contexts]
  );

  const gcpProjects = useMemo(
    () => (activeProfile?.gcp_projects ?? []).filter((p) => Boolean(p?.trim())),
    [activeProfile?.gcp_projects]
  );

  const loadEngineering = useCallback(async () => {
    setLoading(true);
    setFetchError(null);
    try {
      const [wtRes, gkeRes, dashRes, profRes, settingsRes] = await Promise.all([
        api.getWorktrees(),
        api
          .getEvents({ source: "gke", limit: 20 })
          .catch(() => ({ items: [] as EventItem[] })),
        api.getDashboard().catch(() => null),
        api.getProfiles().catch(() => null),
        api.getSettings().catch(() => null),
      ]);

      const profile = profRes?.active ?? null;
      setActiveProfile(profile);
      setSettings(settingsRes?.settings ?? null);
      setWorktrees(wtRes.worktrees);
      setLocalWip(wtRes.local_desktop_wip);
      setGkeEvents(gkeRes.items);

      const profileRepos = profile?.core_repos;
      const dashRepos = dashRes?.core_repos;
      const wtRepos = wtRes.core_repos;

      let resolvedRepos: Record<string, CoreRepoConfig> = {};
      if (profileRepos && Object.keys(profileRepos).length > 0) {
        resolvedRepos = profileRepos;
      } else if (dashRepos && Object.keys(dashRepos).length > 0) {
        resolvedRepos = dashRepos;
      } else if (profile !== null && dashRes !== null) {
        resolvedRepos = {};
      } else {
        resolvedRepos = wtRepos ?? {};
      }

      setCoreRepos(resolvedRepos);

      const keys = Object.keys(resolvedRepos);
      if (!prefillWorktree) {
        setRepoKey((prev) => (prev && resolvedRepos[prev] ? prev : keys[0] ?? ""));
      }

      if (settingsRes?.settings?.default_runner_mode === "dev_vm") {
        setRunnerMode("dev_vm");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setFetchError(msg);
      pushToast("error", "Failed to load engineering data", msg);
    } finally {
      setLoading(false);
    }
  }, [prefillWorktree, pushToast]);

  useEffect(() => {
    void loadEngineering();
  }, [loadEngineering, refreshSignal]);

  // Honor prefillWorktree prop when navigating from WorkView
  useEffect(() => {
    if (!prefillWorktree) return;
    if (prefillWorktree.repoKey) {
      setRepoKey(prefillWorktree.repoKey);
    }
    if (prefillWorktree.branch) {
      setBranch(prefillWorktree.branch);
    }
    setActiveTab("worktrees");
    setCreateModalOpen(true);
  }, [prefillWorktree]);

  const repoEntries = useMemo(() => Object.entries(coreRepos), [coreRepos]);

  const selectableRepoKeys = useMemo(() => {
    const keys = repoEntries.map(([k]) => k);
    if (prefillWorktree?.repoKey && !keys.includes(prefillWorktree.repoKey)) {
      return [prefillWorktree.repoKey, ...keys];
    }
    return keys;
  }, [repoEntries, prefillWorktree?.repoKey]);

  useEffect(() => {
    if (worktrees.length === 0) {
      setSelectedWtId(null);
      return;
    }
    setSelectedWtId((prev) => {
      if (prev !== null && worktrees.some((w) => w.id === prev)) return prev;
      return worktrees[0].id;
    });
  }, [worktrees]);

  const selectedWorktree = useMemo(() => {
    if (!worktrees.length) return null;
    return worktrees.find((w) => w.id === selectedWtId) ?? worktrees[0] ?? null;
  }, [worktrees, selectedWtId]);

  useListKeyboardNav({
    items: worktrees,
    getId: (w) => w.id,
    selectedId: selectedWorktree?.id ?? null,
    onSelect: (id: number) => setSelectedWtId(id),
    enabled: activeTab === "worktrees",
  });

  const closeCreateModal = () => {
    setCreateModalOpen(false);
    onClearPrefill?.();
  };

  const openNewSandboxForRepo = (targetRepoKey?: string) => {
    if (targetRepoKey) {
      setRepoKey(targetRepoKey);
    } else if (!repoKey && selectableRepoKeys[0]) {
      setRepoKey(selectableRepoKeys[0]);
    }
    setCreateModalOpen(true);
  };

  const handleCreateWorktree = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!repoKey.trim() || !branch.trim() || creating) return;
    setCreating(true);
    try {
      const res = await api.createWorktree({
        repo_key: repoKey,
        branch: branch.trim(),
        base_ref: baseRef.trim() || "origin/main",
        runner_mode: runnerMode,
        pr_number: prNumber.trim() ? Number(prNumber) : null,
        issue_number: issueNumber.trim() ? Number(issueNumber) : null,
      });
      setWorktrees((prev) => [
        res.worktree,
        ...prev.filter((w) => w.id !== res.worktree.id),
      ]);
      setSelectedWtId(res.worktree.id);
      setBranch("");
      setPrNumber("");
      setIssueNumber("");
      setCreateModalOpen(false);
      onClearPrefill?.();
      setActiveTab("worktrees");
      pushToast(
        "success",
        "Sandbox created",
        `${res.worktree.repo_key} · ${res.worktree.branch}`
      );
      onStateMutated();
    } catch (err) {
      pushToast(
        "error",
        "Failed to create sandbox",
        err instanceof Error ? err.message : String(err)
      );
    } finally {
      setCreating(false);
    }
  };

  const handleOpenInIde = async (targetPath: string) => {
    if (!targetPath || openingIdePath) return;
    setOpeningIdePath(targetPath);
    const cliCommand = formatIdeCliCommand(ideSpec.cli, targetPath);

    try {
      const res = await api.openInIde(targetPath, ideSpec.id);
      if (res.opened) {
        pushToast("success", `Opened in ${ideSpec.label}`, res.path);
        return;
      }
    } catch {
      // Fall through to desktop reveal or clipboard copy
    } finally {
      setOpeningIdePath(null);
    }

    const bridge = desktopBridge as typeof desktopBridge & {
      revealPath?: (path: string) => Promise<boolean | void>;
    };
    if (typeof bridge.revealPath === "function") {
      try {
        const revealed = await bridge.revealPath(targetPath);
        if (revealed !== false) {
          pushToast("success", "Revealed in Explorer", targetPath);
          return;
        }
      } catch {
        // Fall through to clipboard copy
      }
    }

    const copied = await desktopBridge.copyText(cliCommand);
    pushToast(
      copied ? "info" : "error",
      copied ? `Copied ${ideSpec.label} command` : `Unable to open ${ideSpec.label}`,
      cliCommand
    );
  };

  const handleRunTests = async (wt: WorktreeItem) => {
    if (testingId !== null) return;
    setTestingId(wt.id);
    setOpenLogByWt((prev) => ({ ...prev, [wt.id]: true }));
    const startedAt = performance.now();
    try {
      const res = await api.testWorktree(wt.id, null);
      const durationMs = Math.max(1, Math.round(performance.now() - startedAt));
      setLastDurationByWt((prev) => ({ ...prev, [wt.id]: durationMs }));
      setWorktrees((prev) =>
        prev.map((w) =>
          w.id === wt.id
            ? {
                ...w,
                last_test_status: res.status,
                last_test_output: res.output,
              }
            : w
        )
      );
      pushToast(
        res.status === "passed" || res.status === "ok" ? "success" : "error",
        `Tests ${res.status} · ${formatDurationMs(durationMs)}`,
        `${wt.repo_key} · ${wt.branch}`
      );
      onStateMutated();
    } catch (err) {
      pushToast(
        "error",
        "Test run failed",
        err instanceof Error ? err.message : String(err)
      );
    } finally {
      setTestingId(null);
    }
  };

  const handleConfirmStageGitPush = async () => {
    const wt = confirmPushWt;
    if (!wt || stagingPushId !== null) return;
    setStagingPushId(wt.id);
    const fullRepo = coreRepos[wt.repo_key]?.full_name || wt.repo_key;
    try {
      const res = await api.stageApproval({
        action_type: "git_push",
        title: `Push ${wt.repo_key} (${wt.branch})`,
        summary: `Stage git push from branch sandbox (${wt.branch}).`,
        repo: fullRepo,
        worktree_path: wt.path,
        branch: wt.branch,
        test_output: wt.last_test_output || "",
        ownership_reason: "isolated_worktree_push",
        payload: {
          repo: fullRepo,
          branch: wt.branch,
          worktree_path: wt.path,
        },
      });

      setConfirmPushWt(null);
      if (res.status === "executed") {
        pushToast("success", "Push executed", `${fullRepo} · ${wt.branch}`);
      } else {
        setStagedLinkReady(`${fullRepo} · ${wt.branch}`);
        pushToast(
          "success",
          "Push staged in Approvals",
          `${fullRepo} · ${wt.branch}`
        );
      }
      onStateMutated();
    } catch (err) {
      pushToast(
        "error",
        "Failed to stage push",
        err instanceof Error ? err.message : String(err)
      );
    } finally {
      setStagingPushId(null);
    }
  };

  const renderSandboxDetail = (wt: WorktreeItem) => {
    const isTesting = testingId === wt.id;
    const isStaging = stagingPushId === wt.id;
    const effectiveRunner: "local" | "dev_vm" =
      runnerOverrideByWt[wt.id] ??
      (wt.runner_mode === "dev_vm" ? "dev_vm" : "local");
    const hasOutput = Boolean(wt.last_test_output?.trim());
    const isLogOpen = openLogByWt[wt.id] ?? hasOutput;
    const durationMs = lastDurationByWt[wt.id];

    const cfg = coreRepos[wt.repo_key];
    const matchingWip = cfg ? matchRepoWip(wt.repo_key, cfg, localWip) : [];
    const wipDiff = summarizeRepoWip(matchingWip).diffText;
    const outputDiff = extractDiffFromText(wt.last_test_output);
    const diffContent = wipDiff || outputDiff;
    const hasDiff = Boolean(diffContent);
    const isDiffOpen = openDiffByWt[wt.id] ?? false;

    return (
      <div className="ce-card space-y-4 p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2.5">
              <GitBranch className="h-4 w-4 shrink-0 text-[var(--accent)]" />
              <h2 className="truncate font-mono text-[15px] font-medium text-[var(--ink)]">
                {wt.branch}
              </h2>
              <StatusBadge
                status={isTesting ? "running" : wt.last_test_status || "not_run"}
              />
              {durationMs !== undefined && (
                <span className="font-mono text-[11px] text-[var(--muted)] tabular-nums">
                  {formatDurationMs(durationMs)}
                </span>
              )}
            </div>
            <p className="text-[12.5px] text-[var(--muted)]">
              {wt.repo_key}
              {wt.pr_number !== null ? ` · PR #${wt.pr_number}` : ""}
              {wt.issue_number !== null ? ` · Issue #${wt.issue_number}` : ""}
              {" · "}
              {formatRelativeTime(wt.updated_at || wt.created_at)}
            </p>
          </div>
        </div>

        {/* Actions + Runner Toggle */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--line)] pt-4">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={openingIdePath === wt.path}
              onClick={() => void handleOpenInIde(wt.path)}
              className="ce-btn h-8 px-3 text-xs"
            >
              <Code2 className="h-3.5 w-3.5" />
              <span>Open in {ideSpec.label}</span>
            </button>

            <button
              type="button"
              disabled={isTesting}
              onClick={() => void handleRunTests(wt)}
              className="ce-btn ce-btn-primary h-8 px-3.5 text-xs"
            >
              <Play className="h-3.5 w-3.5" />
              <span>{isTesting ? "Running…" : "Run Tests"}</span>
            </button>

            <button
              type="button"
              disabled={isStaging}
              onClick={() => setConfirmPushWt(wt)}
              className="ce-btn ce-btn-sage h-8 px-3 text-xs"
            >
              <UploadCloud className="h-3.5 w-3.5" />
              <span>{isStaging ? "Staging…" : "Stage Push"}</span>
            </button>
          </div>

          <div
            role="group"
            aria-label="Test runner target"
            className="inline-flex items-center rounded-lg border border-[var(--line)] bg-[var(--surface-sunken)] p-0.5 text-[11.5px]"
          >
            <button
              type="button"
              onClick={() =>
                setRunnerOverrideByWt((prev) => ({ ...prev, [wt.id]: "local" }))
              }
              className={`inline-flex items-center gap-1 rounded-md px-2.5 py-1 transition-colors ${
                effectiveRunner === "local"
                  ? "bg-[var(--surface-raised)] font-medium text-[var(--ink)]"
                  : "text-[var(--muted)] hover:text-[var(--ink)]"
              }`}
            >
              <Laptop className="h-3 w-3" />
              <span>Local</span>
            </button>
            <button
              type="button"
              onClick={() =>
                setRunnerOverrideByWt((prev) => ({ ...prev, [wt.id]: "dev_vm" }))
              }
              title={sshHost || "Remote Dev VM"}
              className={`inline-flex items-center gap-1 rounded-md px-2.5 py-1 transition-colors ${
                effectiveRunner === "dev_vm"
                  ? "bg-[var(--surface-raised)] font-medium text-[var(--ink)]"
                  : "text-[var(--muted)] hover:text-[var(--ink)]"
              }`}
            >
              <Server className="h-3 w-3" />
              <span>Remote</span>
            </button>
          </div>
        </div>

        {/* Collapsible Test Output (only when present) */}
        {hasOutput && (
          <div className="border-t border-[var(--line)] pt-3.5">
            <button
              type="button"
              onClick={() =>
                setOpenLogByWt((prev) => ({ ...prev, [wt.id]: !isLogOpen }))
              }
              className="inline-flex items-center gap-1.5 text-xs font-medium text-[var(--ink-secondary)] hover:text-[var(--ink)]"
            >
              {isLogOpen ? (
                <ChevronDown className="h-3.5 w-3.5" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5" />
              )}
              <Terminal className="h-3.5 w-3.5 text-[var(--accent)]" />
              <span>Test Output</span>
            </button>

            {isLogOpen && (
              <pre className="mt-2.5 max-h-64 max-w-full overflow-auto rounded-lg border border-[var(--line)] bg-[var(--surface-sunken)] p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words text-[var(--ink)]">
                {wt.last_test_output}
              </pre>
            )}
          </div>
        )}

        {/* Collapsible DiffViewer (only when present) */}
        {hasDiff && (
          <div className="border-t border-[var(--line)] pt-3.5">
            <button
              type="button"
              onClick={() =>
                setOpenDiffByWt((prev) => ({ ...prev, [wt.id]: !isDiffOpen }))
              }
              className="inline-flex items-center gap-1.5 text-xs font-medium text-[var(--ink-secondary)] hover:text-[var(--ink)]"
            >
              {isDiffOpen ? (
                <ChevronDown className="h-3.5 w-3.5" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5" />
              )}
              <span>Diff Preview</span>
            </button>

            {isDiffOpen && (
              <div className="mt-2.5">
                <DiffViewer
                  diff={diffContent}
                  title={`${wt.repo_key} · ${wt.branch}`}
                />
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="mx-auto w-full max-w-[1140px] space-y-5 px-6 pt-2 pb-8">
      <WorkspaceHeader
        title="Engineering"
        tabs={[
          {
            id: "repos_wip",
            label: "Repositories",
            count: repoEntries.length,
          },
          {
            id: "worktrees",
            label: "Sandboxes",
            count: worktrees.length,
          },
          {
            id: "cloud_watch",
            label: "Cloud",
            count: clusterContexts.length,
          },
        ]}
        activeTab={activeTab}
        onTabChange={(id) => setActiveTab(id as EngineeringTab)}
        actions={
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void loadEngineering()}
              disabled={loading}
              aria-label="Refresh"
              title="Refresh"
              className="ce-btn ce-btn-ghost h-8 w-8 p-0"
            >
              <RefreshCw
                className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`}
              />
            </button>

            <button
              type="button"
              onClick={() => openNewSandboxForRepo()}
              className="ce-btn ce-btn-primary h-8 px-3.5 text-xs"
            >
              <Plus className="h-3.5 w-3.5" />
              <span>New Sandbox</span>
            </button>
          </div>
        }
      />

      {fetchError && (
        <ErrorBanner
          title="Unable to load engineering workspace"
          message={fetchError}
          onRetry={() => void loadEngineering()}
        />
      )}

      {stagedLinkReady && (
        <div className="ce-card flex flex-wrap items-center justify-between gap-3 border-[var(--sage-border)] px-4 py-2.5 text-xs">
          <span className="text-[var(--ink-secondary)]">
            Push staged for{" "}
            <span className="font-mono font-medium text-[var(--ink)]">
              {stagedLinkReady}
            </span>
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => onNavigate("Approvals")}
              className="ce-btn ce-btn-sage h-7 px-2.5 text-xs"
            >
              <span>Review in Approvals</span>
              <ArrowRight className="h-3 w-3" />
            </button>
            <button
              type="button"
              onClick={() => setStagedLinkReady(null)}
              className="ce-btn ce-btn-ghost h-7 px-2 text-xs"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {/* Tab 1: Repositories (Default) */}
      {activeTab === "repos_wip" && (
        <div className="space-y-4">
          {worktrees.length > 0 && (
            <div className="ce-card flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 text-xs">
              <div className="flex items-center gap-2 text-[var(--ink-secondary)]">
                <span className="h-1.5 w-1.5 rounded-full bg-[var(--accent)]" />
                <span>
                  <strong className="font-medium text-[var(--ink)] tabular-nums">
                    {worktrees.length}
                  </strong>{" "}
                  active branch sandbox{worktrees.length === 1 ? "" : "es"}
                </span>
              </div>
              <button
                type="button"
                onClick={() => setActiveTab("worktrees")}
                className="ce-btn ce-btn-ghost h-7 px-2.5 text-xs text-[var(--accent)]"
              >
                <span>View Sandboxes</span>
                <ArrowRight className="h-3 w-3" />
              </button>
            </div>
          )}

          {loading && repoEntries.length === 0 ? (
            <div className="ce-card p-5">
              <SkeletonRows rows={4} />
            </div>
          ) : repoEntries.length === 0 ? (
            <div className="ce-card mx-auto my-8 max-w-md px-6 py-10 text-center">
              <div className="mx-auto mb-3.5 flex h-10 w-10 items-center justify-center rounded-xl border border-[var(--line)] bg-[var(--surface-raised)] text-[var(--muted)]">
                <FolderGit2 className="h-5 w-5" />
              </div>
              <h2 className="text-[15px] font-medium text-[var(--ink)]">
                No repositories configured
              </h2>
              <p className="mt-1.5 text-[13px] text-[var(--muted)]">
                Add your local checkouts in System to open them directly and track changes.
              </p>
              <button
                type="button"
                onClick={() => onNavigate("System")}
                className="ce-btn ce-btn-primary mt-5 h-8 px-4 text-xs"
              >
                <span>Configure Repositories</span>
                <ArrowRight className="h-3.5 w-3.5" />
              </button>
            </div>
          ) : (
            <div className="ce-card divide-y divide-[var(--line)] overflow-hidden">
              {repoEntries.map(([key, cfg]) => {
                const { shortName, orgPrefix } = parseRepoDisplay(key, cfg);
                const matchingWip = matchRepoWip(key, cfg, localWip);
                const wipSummary = summarizeRepoWip(matchingWip);
                const isDirty = matchingWip.length > 0;
                const isExpanded = Boolean(expandedRepos[key]);

                return (
                  <div key={key} className="px-5 py-4">
                    <div className="flex flex-wrap items-center justify-between gap-4">
                      {/* Left */}
                      <div className="flex min-w-0 flex-wrap items-center gap-2.5">
                        <FolderGit2 className="h-4 w-4 shrink-0 text-[var(--muted)]" />

                        <span className="text-[14.5px] font-medium text-[var(--ink)]">
                          {shortName}
                        </span>

                        {orgPrefix && (
                          <span className="text-[12.5px] text-[var(--muted)]">
                            {orgPrefix}
                          </span>
                        )}

                        <span className="inline-flex items-center gap-1 rounded-full border border-[var(--line)] bg-[var(--surface-sunken)] px-2 py-0.5 font-mono text-[11px] text-[var(--ink-secondary)]">
                          <GitBranch className="h-2.5 w-2.5 text-[var(--muted)]" />
                          <span>{wipSummary.branch}</span>
                        </span>

                        {isDirty ? (
                          <button
                            type="button"
                            onClick={() =>
                              setExpandedRepos((prev) => ({
                                ...prev,
                                [key]: !isExpanded,
                              }))
                            }
                            aria-expanded={isExpanded}
                            className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[12px] text-[var(--amber)] transition-colors hover:bg-[var(--amber-soft)]"
                          >
                            <span className="h-1.5 w-1.5 rounded-full bg-[var(--amber)]" />
                            <span className="tabular-nums">
                              {wipSummary.modifiedCount} modified
                            </span>
                            {isExpanded ? (
                              <ChevronDown className="h-3 w-3 opacity-80" />
                            ) : (
                              <ChevronRight className="h-3 w-3 opacity-80" />
                            )}
                          </button>
                        ) : (
                          <span className="inline-flex items-center gap-1.5 px-1 text-[12px] text-[var(--muted)]">
                            <span className="h-1.5 w-1.5 rounded-full bg-[var(--sage)]" />
                            <span>Clean</span>
                          </span>
                        )}
                      </div>

                      {/* Right */}
                      <div className="flex shrink-0 flex-wrap items-center gap-2">
                        <button
                          type="button"
                          disabled={!cfg.local_path || openingIdePath === cfg.local_path}
                          onClick={() => void handleOpenInIde(cfg.local_path)}
                          className="ce-btn h-8 px-3 text-xs"
                        >
                          <Code2 className="h-3.5 w-3.5" />
                          <span>Open in {ideSpec.label}</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => openNewSandboxForRepo(key)}
                          className="ce-btn h-8 px-3 text-xs"
                        >
                          <Plus className="h-3.5 w-3.5" />
                          <span>Sandbox</span>
                        </button>
                      </div>
                    </div>

                    {/* Quiet inline file preview (hidden by default) */}
                    {isDirty && isExpanded && (
                      <div className="mt-3.5 space-y-2.5 border-t border-[var(--line)] pt-3.5 pl-6">
                        {wipSummary.files.length > 0 ? (
                          <ul className="space-y-1 font-mono text-[11.5px] text-[var(--ink-secondary)]">
                            {wipSummary.files.slice(0, 14).map((filePath) => (
                              <li key={filePath} className="truncate">
                                {filePath}
                              </li>
                            ))}
                            {wipSummary.files.length > 14 && (
                              <li className="text-[var(--muted)]">
                                +{wipSummary.files.length - 14} more files
                              </li>
                            )}
                          </ul>
                        ) : (
                          <div className="space-y-1.5 text-xs text-[var(--ink-secondary)]">
                            {matchingWip.map((wip) => (
                              <p key={wip.id} className="leading-relaxed">
                                {wip.summary || wip.title}
                              </p>
                            ))}
                          </div>
                        )}

                        {wipSummary.diffText && (
                          <DiffViewer
                            diff={wipSummary.diffText}
                            title={`${shortName} · ${wipSummary.branch}`}
                            maxHeightClass="max-h-64"
                          />
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Tab 2: Sandboxes */}
      {activeTab === "worktrees" && (
        loading && worktrees.length === 0 ? (
          <div className="ce-card p-5">
            <SkeletonRows rows={4} />
          </div>
        ) : worktrees.length === 0 ? (
          <div className="mx-auto my-12 max-w-md text-center">
            <div className="mx-auto mb-4 flex h-11 w-11 items-center justify-center rounded-2xl border border-[var(--line)] bg-[var(--surface)] text-[var(--muted)]">
              <GitBranch className="h-5 w-5" />
            </div>
            <h2 className="text-[15.5px] font-medium text-[var(--ink)]">
              No active branch sandboxes
            </h2>
            <p className="mt-1.5 text-[13px] leading-relaxed text-[var(--muted)]">
              Create an isolated branch sandbox to run agent edits and tests safely away from your main checkouts.
            </p>
            <button
              type="button"
              onClick={() => openNewSandboxForRepo()}
              className="ce-btn ce-btn-primary mt-5 h-8 px-4 text-xs"
            >
              <Plus className="h-3.5 w-3.5" />
              <span>Create Sandbox</span>
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-12">
            {/* Left List */}
            <aside className="lg:col-span-4">
              <div className="ce-card divide-y divide-[var(--line)] overflow-hidden">
                {worktrees.map((wt) => {
                  const active = selectedWorktree?.id === wt.id;
                  const isTesting = testingId === wt.id;

                  return (
                    <button
                      key={wt.id}
                      type="button"
                      onClick={() => setSelectedWtId(wt.id)}
                      className={`flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors ${
                        active
                          ? "bg-[var(--accent-soft)]"
                          : "hover:bg-[var(--surface-raised)]/45"
                      }`}
                    >
                      <span
                        className={`h-2 w-2 shrink-0 rounded-full ${worktreeStatusDotClass(
                          wt.last_test_status,
                          isTesting
                        )}`}
                      />
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-mono text-[12.5px] font-medium text-[var(--ink)]">
                          {wt.branch}
                        </p>
                        <p className="mt-0.5 truncate text-[11.5px] text-[var(--muted)]">
                          {wt.repo_key}
                        </p>
                      </div>
                    </button>
                  );
                })}
              </div>
            </aside>

            {/* Right Detail */}
            <section className="min-w-0 lg:col-span-8">
              {selectedWorktree && renderSandboxDetail(selectedWorktree)}
            </section>
          </div>
        )
      )}

      {/* Tab 3: Cloud */}
      {activeTab === "cloud_watch" && (
        <div className="space-y-5">
          {clusterContexts.length === 0 && gcpProjects.length === 0 ? (
            <div className="ce-card mx-auto my-8 max-w-md px-6 py-10 text-center">
              <div className="mx-auto mb-3.5 flex h-10 w-10 items-center justify-center rounded-xl border border-[var(--line)] bg-[var(--surface-raised)] text-[var(--muted)]">
                <Cloud className="h-5 w-5" />
              </div>
              <h2 className="text-[15px] font-medium text-[var(--ink)]">
                No cloud contexts configured
              </h2>
              <p className="mt-1.5 text-[13px] text-[var(--muted)]">
                Add Kubernetes contexts or GCP projects in System for read-only cluster visibility.
              </p>
              <button
                type="button"
                onClick={() => onNavigate("System")}
                className="ce-btn mt-5 h-8 px-4 text-xs"
              >
                <span>Open System</span>
                <ArrowRight className="h-3.5 w-3.5" />
              </button>
            </div>
          ) : (
            <div className="ce-card divide-y divide-[var(--line)] overflow-hidden">
              {clusterContexts.map((ctx) => (
                <div
                  key={ctx}
                  className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5"
                >
                  <div className="flex min-w-0 items-center gap-2.5">
                    <Cloud className="h-4 w-4 shrink-0 text-[var(--muted)]" />
                    <span
                      title={ctx}
                      className="truncate text-[14px] font-medium text-[var(--ink)]"
                    >
                      {friendlyClusterName(ctx)}
                    </span>
                  </div>
                  <span className="ce-pill ce-pill-sage">
                    <Lock className="h-2.5 w-2.5" />
                    <span>Read-only</span>
                  </span>
                </div>
              ))}

              {gcpProjects.map((proj) => (
                <div
                  key={proj}
                  className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5"
                >
                  <div className="flex min-w-0 items-center gap-2.5">
                    <Server className="h-4 w-4 shrink-0 text-[var(--muted)]" />
                    <span className="truncate font-mono text-[13px] text-[var(--ink-secondary)]">
                      {proj}
                    </span>
                  </div>
                  <span className="ce-pill ce-pill-sage">
                    <Lock className="h-2.5 w-2.5" />
                    <span>Read-only</span>
                  </span>
                </div>
              ))}
            </div>
          )}

          {gkeEvents.length > 0 && (
            <div className="ce-card divide-y divide-[var(--line)] overflow-hidden">
              {gkeEvents.map((ev) => {
                const isOpen = Boolean(expandedSignals[ev.id]);
                const hasDetails = Boolean(ev.summary?.trim() || ev.body?.trim());

                return (
                  <div key={ev.id} className="px-5 py-3.5">
                    <button
                      type="button"
                      disabled={!hasDetails}
                      onClick={() =>
                        hasDetails &&
                        setExpandedSignals((prev) => ({
                          ...prev,
                          [ev.id]: !isOpen,
                        }))
                      }
                      className="flex w-full items-center justify-between gap-4 text-left"
                    >
                      <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-[var(--ink)]">
                        {ev.title}
                      </span>
                      <span className="shrink-0 font-mono text-[11px] text-[var(--muted)] tabular-nums">
                        {formatRelativeTime(ev.occurred_at)}
                      </span>
                    </button>

                    {isOpen && hasDetails && (
                      <div className="mt-2.5 space-y-2 border-t border-[var(--line)] pt-2.5">
                        {ev.summary && (
                          <p className="text-xs leading-relaxed text-[var(--ink-secondary)]">
                            {ev.summary}
                          </p>
                        )}
                        {ev.body?.trim() && (
                          <pre className="max-h-48 max-w-full overflow-auto rounded-lg border border-[var(--line)] bg-[var(--surface-sunken)] p-3 font-mono text-xs whitespace-pre-wrap break-words text-[var(--ink)]">
                            {ev.body}
                          </pre>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Stage Push Safety Confirmation Modal */}
      <ModalDialog
        open={confirmPushWt !== null}
        onClose={() => {
          if (stagingPushId === null) setConfirmPushWt(null);
        }}
        title="Stage Push for Approval"
        subtitle="Creates a pending push in Approval Studio before any remote change occurs."
        footer={
          <>
            <button
              type="button"
              disabled={stagingPushId !== null}
              onClick={() => setConfirmPushWt(null)}
              className="ce-btn ce-btn-ghost"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={stagingPushId !== null}
              onClick={() => void handleConfirmStageGitPush()}
              className="ce-btn ce-btn-sage"
            >
              <UploadCloud className="h-3.5 w-3.5" />
              <span>{stagingPushId !== null ? "Staging…" : "Stage Push"}</span>
            </button>
          </>
        }
      >
        {confirmPushWt && (
          <div className="space-y-3 text-xs">
            <dl className="divide-y divide-[var(--line)] rounded-lg border border-[var(--line)] bg-[var(--surface-sunken)]">
              <div className="flex items-center justify-between gap-3 px-3.5 py-2">
                <dt className="text-[var(--muted)]">Repository</dt>
                <dd className="font-mono font-medium text-[var(--ink)]">
                  {coreRepos[confirmPushWt.repo_key]?.full_name || confirmPushWt.repo_key}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-3 px-3.5 py-2">
                <dt className="text-[var(--muted)]">Branch</dt>
                <dd className="font-mono text-[var(--accent)]">
                  {confirmPushWt.branch}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-3 px-3.5 py-2">
                <dt className="text-[var(--muted)]">Latest Test</dt>
                <dd>
                  <StatusBadge status={confirmPushWt.last_test_status || "not_run"} />
                </dd>
              </div>
            </dl>
          </div>
        )}
      </ModalDialog>

      {/* New Sandbox Modal */}
      <ModalDialog
        open={createModalOpen}
        onClose={closeCreateModal}
        title="New Branch Sandbox"
        subtitle="Create an isolated sandbox without modifying your primary checkout."
        maxWidthClass="max-w-lg"
        footer={
          <>
            <button
              type="button"
              onClick={closeCreateModal}
              className="ce-btn h-8 px-3 text-xs"
            >
              Cancel
            </button>
            <button
              type="submit"
              form="create-worktree-form"
              disabled={creating || !repoKey.trim() || !branch.trim()}
              className="ce-btn ce-btn-primary h-8 px-3.5 text-xs"
            >
              <Plus className="h-3.5 w-3.5" />
              <span>{creating ? "Creating…" : "Create Sandbox"}</span>
            </button>
          </>
        }
      >
        <form
          id="create-worktree-form"
          onSubmit={handleCreateWorktree}
          className="space-y-3.5"
        >
          {selectableRepoKeys.length === 0 ? (
            <div className="rounded-lg border border-[var(--line)] bg-[var(--surface-sunken)] p-3.5 text-xs">
              <p className="font-medium text-[var(--ink)]">
                No repositories configured
              </p>
              <p className="mt-1 text-[var(--muted)]">
                Configure a repository in System before creating a sandbox.
              </p>
              <button
                type="button"
                onClick={() => {
                  closeCreateModal();
                  onNavigate("System");
                }}
                className="ce-btn ce-btn-primary mt-2.5 h-7 px-3 text-xs"
              >
                <span>Open System</span>
                <ArrowRight className="h-3 w-3" />
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label
                  htmlFor="modal-wt-repo"
                  className="mb-1 block text-xs font-medium text-[var(--ink-secondary)]"
                >
                  Repository
                </label>
                <select
                  id="modal-wt-repo"
                  value={repoKey}
                  onChange={(e) => setRepoKey(e.target.value)}
                  className="ce-input font-mono"
                >
                  {selectableRepoKeys.map((k) => (
                    <option key={k} value={k}>
                      {k}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label
                  htmlFor="modal-wt-runner"
                  className="mb-1 block text-xs font-medium text-[var(--ink-secondary)]"
                >
                  Runner
                </label>
                <select
                  id="modal-wt-runner"
                  value={runnerMode}
                  onChange={(e) =>
                    setRunnerMode(e.target.value as "local" | "dev_vm")
                  }
                  className="ce-input"
                >
                  <option value="local">Local</option>
                  <option value="dev_vm">
                    {sshHost ? `Remote (${sshHost})` : "Remote Dev VM"}
                  </option>
                </select>
              </div>
            </div>
          )}

          <div>
            <label
              htmlFor="modal-wt-branch"
              className="mb-1 block text-xs font-medium text-[var(--ink-secondary)]"
            >
              Branch Name
            </label>
            <input
              id="modal-wt-branch"
              type="text"
              required
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              placeholder="fix/review-followups"
              className="ce-input font-mono"
            />
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div>
              <label
                htmlFor="modal-wt-base"
                className="mb-1 block text-xs font-medium text-[var(--ink-secondary)]"
              >
                Base Ref
              </label>
              <input
                id="modal-wt-base"
                type="text"
                value={baseRef}
                onChange={(e) => setBaseRef(e.target.value)}
                placeholder="origin/main"
                className="ce-input font-mono"
              />
            </div>

            <div>
              <label
                htmlFor="modal-wt-pr"
                className="mb-1 block text-xs font-medium text-[var(--ink-secondary)]"
              >
                PR # (optional)
              </label>
              <input
                id="modal-wt-pr"
                type="number"
                value={prNumber}
                onChange={(e) => setPrNumber(e.target.value)}
                placeholder="142"
                className="ce-input font-mono tabular-nums"
              />
            </div>

            <div>
              <label
                htmlFor="modal-wt-issue"
                className="mb-1 block text-xs font-medium text-[var(--ink-secondary)]"
              >
                Issue # (optional)
              </label>
              <input
                id="modal-wt-issue"
                type="number"
                value={issueNumber}
                onChange={(e) => setIssueNumber(e.target.value)}
                placeholder="88"
                className="ce-input font-mono tabular-nums"
              />
            </div>
          </div>
        </form>
      </ModalDialog>
    </div>
  );
}
