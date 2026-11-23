import { useMemo, useState } from "react";
import { Check, ChevronDown, ChevronRight, Copy, FileDiff, WrapText } from "lucide-react";

interface DiffLine {
  lineNumber: number;
  raw: string;
  isFileHeader: boolean;
  isHunk: boolean;
  isAdd: boolean;
  isDel: boolean;
}

interface DiffSection {
  id: number;
  fileName: string | null;
  additions: number;
  deletions: number;
  lines: DiffLine[];
}

function extractFileName(gitHeaderLine: string): string {
  const match = /^diff --git\s+a\/(.+?)\s+b\/(.+)$/.exec(gitHeaderLine);
  if (match) return match[2];
  return gitHeaderLine.replace(/^diff --git\s+/, "").trim() || "file";
}

function classifyLine(raw: string, lineNumber: number): DiffLine {
  const isFileHeader =
    raw.startsWith("diff --git") ||
    raw.startsWith("--- ") ||
    raw.startsWith("+++ ");
  const isHunk = raw.startsWith("@@");
  const isAdd = !isFileHeader && raw.startsWith("+");
  const isDel = !isFileHeader && raw.startsWith("-");
  return { lineNumber, raw, isFileHeader, isHunk, isAdd, isDel };
}

function parseDiffSections(diff: string): {
  totalLines: number;
  additions: number;
  deletions: number;
  hasGitSections: boolean;
  sections: DiffSection[];
} {
  const rawLines = diff.replace(/\r\n/g, "\n").split("\n");
  const hasGitSections = rawLines.some((l) => l.startsWith("diff --git"));
  const sections: DiffSection[] = [];

  let current: DiffSection = {
    id: 0,
    fileName: null,
    additions: 0,
    deletions: 0,
    lines: [],
  };
  let additions = 0;
  let deletions = 0;

  rawLines.forEach((raw, idx) => {
    const item = classifyLine(raw, idx + 1);
    if (raw.startsWith("diff --git")) {
      if (current.lines.length > 0 || current.fileName !== null) {
        sections.push(current);
      }
      current = {
        id: sections.length,
        fileName: extractFileName(raw),
        additions: 0,
        deletions: 0,
        lines: [item],
      };
      return;
    }

    if (item.isAdd) {
      additions++;
      current.additions++;
    } else if (item.isDel) {
      deletions++;
      current.deletions++;
    }
    current.lines.push(item);
  });

  if (current.lines.length > 0 || current.fileName !== null) {
    sections.push(current);
  }

  return {
    totalLines: rawLines.length,
    additions,
    deletions,
    hasGitSections,
    sections,
  };
}

export function DiffViewer({
  diff,
  title = "Unified Diff Preview",
  maxHeightClass = "max-h-96",
}: {
  diff: string;
  title?: string;
  maxHeightClass?: string;
}) {
  const [copied, setCopied] = useState(false);
  const [wrapLines, setWrapLines] = useState(false);
  const [collapsedSections, setCollapsedSections] = useState<Record<number, boolean>>({});

  const parsed = useMemo(() => {
    if (!diff || !diff.trim()) return null;
    return parseDiffSections(diff);
  }, [diff]);

  if (!parsed) {
    return (
      <div className="ce-well flex items-center gap-2 px-3.5 py-3 text-xs text-[var(--muted)]">
        <FileDiff className="h-4 w-4 shrink-0" />
        <span>No code diff attached to this item.</span>
      </div>
    );
  }

  const handleCopy = async () => {
    let ok = false;
    try {
      await navigator.clipboard.writeText(diff);
      ok = true;
    } catch {
      const ta = document.createElement("textarea");
      ta.value = diff;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        ok = document.execCommand("copy");
      } finally {
        document.body.removeChild(ta);
      }
    }
    if (ok) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    }
  };

  const toggleSection = (id: number) => {
    setCollapsedSections((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  return (
    <div className="ce-well overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--line)] bg-[var(--surface-raised)] px-3 py-1.5">
        <div className="flex min-w-0 items-center gap-2 font-mono text-[11px] text-[var(--muted)]">
          <FileDiff className="h-3.5 w-3.5 shrink-0 text-[var(--accent)]" />
          <span className="truncate">{title}</span>
          <span className="text-[var(--subtle)]">·</span>
          <span className="tabular-nums">{parsed.totalLines} lines</span>
          <span className="inline-flex items-center gap-1.5 rounded border border-[var(--line)] bg-[var(--surface)] px-1.5 py-0.5 text-[10.5px] tabular-nums">
            <span className="font-semibold text-[var(--sage)]">+{parsed.additions}</span>
            <span className="text-[var(--subtle)]">/</span>
            <span className="font-semibold text-[var(--coral)]">-{parsed.deletions}</span>
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setWrapLines((w) => !w)}
            aria-pressed={wrapLines}
            className={`ce-btn ce-btn-ghost h-6 px-2 text-[11px] ${
              wrapLines ? "bg-[var(--surface-sunken)] text-[var(--ink)]" : ""
            }`}
            title={wrapLines ? "Switch to horizontal scroll" : "Wrap long lines"}
          >
            <WrapText className="h-3 w-3" />
            <span>{wrapLines ? "Wrap" : "Scroll"}</span>
          </button>
          <button
            type="button"
            onClick={handleCopy}
            className="ce-btn ce-btn-ghost h-6 px-2 text-[11px]"
          >
            {copied ? (
              <>
                <Check className="h-3 w-3 text-[var(--sage)]" />
                Copied
              </>
            ) : (
              <>
                <Copy className="h-3 w-3" />
                Copy diff
              </>
            )}
          </button>
        </div>
      </div>
      <div className={`ce-contain-scroll overflow-auto font-mono text-[11.5px] leading-[1.55] ${maxHeightClass}`}>
        {parsed.sections.map((section) => {
          const isCollapsible = parsed.hasGitSections && section.fileName !== null;
          const isCollapsed = isCollapsible && Boolean(collapsedSections[section.id]);
          const linesToRender = isCollapsible
            ? section.lines.slice(1)
            : section.lines;

          return (
            <div key={section.id} className="border-b border-[var(--line)] last:border-b-0">
              {isCollapsible && (
                <button
                  type="button"
                  onClick={() => toggleSection(section.id)}
                  aria-expanded={!isCollapsed}
                  className="sticky top-0 z-10 flex w-full items-center justify-between gap-2 border-b border-[var(--line)] bg-[var(--surface-raised)] px-3 py-1.5 text-left text-[11px] font-medium text-[var(--ink)] transition hover:bg-[var(--surface)]"
                >
                  <span className="flex min-w-0 items-center gap-1.5">
                    {isCollapsed ? (
                      <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[var(--muted)]" />
                    ) : (
                      <ChevronDown className="h-3.5 w-3.5 shrink-0 text-[var(--muted)]" />
                    )}
                    <span className="truncate">{section.fileName}</span>
                  </span>
                  <span className="flex shrink-0 items-center gap-1.5 text-[10.5px] tabular-nums">
                    <span className="text-[var(--sage)]">+{section.additions}</span>
                    <span className="text-[var(--coral)]">-{section.deletions}</span>
                  </span>
                </button>
              )}
              {!isCollapsed &&
                linesToRender.map((item) => {
                  let rowCls = "text-[var(--ink-secondary)]";
                  let gutterChar = " ";
                  let gutterCls = "text-[var(--subtle)]";
                  let displayText = item.raw;

                  if (item.isFileHeader) {
                    rowCls = "bg-[var(--surface-raised)]/70 font-semibold text-[var(--ink)]";
                  } else if (item.isHunk) {
                    rowCls = "bg-[var(--accent-soft)] text-[var(--accent)]";
                  } else if (item.isAdd) {
                    rowCls = "bg-[var(--sage-soft)] text-[var(--sage)]";
                    gutterChar = "+";
                    gutterCls = "font-semibold text-[var(--sage)]";
                    displayText = item.raw.slice(1);
                  } else if (item.isDel) {
                    rowCls = "bg-[var(--coral-soft)] text-[var(--coral)]";
                    gutterChar = "-";
                    gutterCls = "font-semibold text-[var(--coral)]";
                    displayText = item.raw.slice(1);
                  } else if (item.raw.startsWith(" ")) {
                    displayText = item.raw.slice(1);
                  }

                  return (
                    <div
                      key={item.lineNumber}
                      className={`flex px-3 py-0.5 ${
                        wrapLines
                          ? "whitespace-pre-wrap [overflow-wrap:anywhere]"
                          : "whitespace-pre"
                      } ${rowCls}`}
                    >
                      <span className="w-9 shrink-0 select-none pr-2 text-right text-[10.5px] text-[var(--subtle)] tabular-nums">
                        {item.lineNumber}
                      </span>
                      <span
                        aria-hidden="true"
                        className={`w-4 shrink-0 select-none text-center ${gutterCls}`}
                      >
                        {gutterChar}
                      </span>
                      <span className="min-w-0 flex-1">{displayText || " "}</span>
                    </div>
                  );
                })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
