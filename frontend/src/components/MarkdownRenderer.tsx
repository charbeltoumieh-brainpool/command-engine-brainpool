import React from "react";
import { Check } from "lucide-react";

function sanitizeUrl(rawHref: string): string | null {
  const trimmed = rawHref.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("#") || (trimmed.startsWith("/") && !trimmed.startsWith("//"))) {
    return trimmed;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === "http:" || parsed.protocol === "https:" || parsed.protocol === "mailto:") {
      return trimmed;
    }
    return null;
  } catch {
    return null;
  }
}

function renderInline(
  text: string,
  onWikilinkClick?: (target: string) => void
): React.ReactNode[] {
  const tokenRegex =
    /(\[\[[^\]]+\]\]|\[[^\]]+\]\([^)]+\)|`[^`]+`|\*\*[^*]+\*\*|\*[^*\s](?:[^*\n]*[^*\s])?\*|https?:\/\/[^\s)]+)/g;
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;

  while ((match = tokenRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    const token = match[0];
    if (token.startsWith("[[") && token.endsWith("]]")) {
      const inner = token.slice(2, -2);
      const pipeIdx = inner.indexOf("|");
      const target = (pipeIdx >= 0 ? inner.slice(0, pipeIdx) : inner).trim();
      const label = (pipeIdx >= 0 ? inner.slice(pipeIdx + 1) : inner).trim();
      if (onWikilinkClick) {
        parts.push(
          <button
            key={key++}
            type="button"
            onClick={() => onWikilinkClick(target)}
            className="mx-0.5 cursor-pointer font-medium text-[var(--violet)] underline decoration-[var(--violet-border)] underline-offset-4 transition hover:decoration-[var(--violet)]"
          >
            [[{label}]]
          </button>
        );
      } else {
        parts.push(
          <span
            key={key++}
            className="mx-0.5 font-medium text-[var(--violet)] underline decoration-[var(--violet-border)] underline-offset-4"
          >
            [[{label}]]
          </span>
        );
      }
    } else if (token.startsWith("[") && token.includes("](")) {
      const splitIdx = token.indexOf("](");
      const label = token.slice(1, splitIdx);
      const rawHref = token.slice(splitIdx + 2, -1);
      const safeHref = sanitizeUrl(rawHref);
      if (safeHref) {
        parts.push(
          <a
            key={key++}
            href={safeHref}
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-[var(--accent)] underline decoration-[var(--accent-border)] underline-offset-3 transition hover:opacity-85"
          >
            {label}
          </a>
        );
      } else {
        parts.push(<span key={key++}>{label}</span>);
      }
    } else if (token.startsWith("`") && token.endsWith("`")) {
      parts.push(
        <code
          key={key++}
          className="rounded border border-[var(--line)] bg-[var(--surface-sunken)] px-1.5 py-0.5 font-mono text-[12px] text-[var(--ink)]"
        >
          {token.slice(1, -1)}
        </code>
      );
    } else if (token.startsWith("**") && token.endsWith("**")) {
      parts.push(
        <strong key={key++} className="font-semibold text-[var(--ink)]">
          {token.slice(2, -2)}
        </strong>
      );
    } else if (token.startsWith("*") && token.endsWith("*")) {
      parts.push(
        <em key={key++} className="italic text-[var(--ink)]">
          {token.slice(1, -1)}
        </em>
      );
    } else if (token.startsWith("http://") || token.startsWith("https://")) {
      parts.push(
        <a
          key={key++}
          href={token}
          target="_blank"
          rel="noreferrer"
          className="break-all text-[var(--accent)] underline decoration-[var(--accent-border)] underline-offset-3 transition hover:opacity-85"
        >
          {token}
        </a>
      );
    }
    lastIndex = match.index + token.length;
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }
  return parts;
}

function isTableSeparator(line: string): boolean {
  if (!line.includes("|")) return false;
  return /^\s*\|?(?:\s*:?-{2,}:?\s*\|)+(?:\s*:?-{2,}:?\s*)?\|?\s*$/.test(line);
}

function splitTableRow(line: string): string[] {
  let trimmed = line.trim();
  if (trimmed.startsWith("|")) trimmed = trimmed.slice(1);
  if (trimmed.endsWith("|")) trimmed = trimmed.slice(0, -1);
  return trimmed.split("|").map((cell) => cell.trim());
}

function parseAlignments(separatorLine: string): Array<"left" | "center" | "right"> {
  return splitTableRow(separatorLine).map((cell) => {
    const startsColon = cell.startsWith(":");
    const endsColon = cell.endsWith(":");
    if (startsColon && endsColon) return "center";
    if (endsColon) return "right";
    return "left";
  });
}

export function MarkdownRenderer({
  content,
  onWikilinkClick,
  className = "",
}: {
  content: string;
  onWikilinkClick?: (target: string) => void;
  className?: string;
}) {
  if (!content.trim()) {
    return (
      <p className={`text-xs italic text-[var(--muted)] ${className}`.trim()}>
        No content available.
      </p>
    );
  }

  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const blocks: React.ReactNode[] = [];
  let idx = 0;

  while (idx < lines.length) {
    const line = lines[idx];

    if (line.trim().startsWith("```")) {
      const lang = line.trim().slice(3).trim();
      const codeLines: string[] = [];
      idx++;
      while (idx < lines.length && !lines[idx].trim().startsWith("```")) {
        codeLines.push(lines[idx]);
        idx++;
      }
      idx++;
      blocks.push(
        <div key={blocks.length} className="ce-well my-3 overflow-hidden">
          {lang && (
            <div className="border-b border-[var(--line)] bg-[var(--surface-raised)] px-3 py-1 font-mono text-[11px] text-[var(--muted)]">
              {lang}
            </div>
          )}
          <pre className="overflow-x-auto p-3.5 font-mono text-xs leading-relaxed text-[var(--ink)]">
            {codeLines.join("\n")}
          </pre>
        </div>
      );
      continue;
    }

    if (
      line.includes("|") &&
      idx + 1 < lines.length &&
      isTableSeparator(lines[idx + 1])
    ) {
      const headers = splitTableRow(line);
      const alignments = parseAlignments(lines[idx + 1]);
      idx += 2;
      const rows: string[][] = [];
      while (idx < lines.length && lines[idx].trim() && lines[idx].includes("|")) {
        rows.push(splitTableRow(lines[idx]));
        idx++;
      }

      const alignClass = (colIdx: number) => {
        const align = alignments[colIdx] ?? "left";
        if (align === "center") return "text-center";
        if (align === "right") return "text-right";
        return "text-left";
      };

      blocks.push(
        <div
          key={blocks.length}
          className="my-3 overflow-x-auto rounded-lg border border-[var(--line)]"
        >
          <table className="w-full border-collapse text-xs">
            <thead className="bg-[var(--surface-raised)]/65 text-[var(--ink)]">
              <tr className="border-b border-[var(--line)]">
                {headers.map((header, colIdx) => (
                  <th
                    key={colIdx}
                    className={`border-r border-[var(--line)] px-3 py-2 font-semibold last:border-r-0 ${alignClass(colIdx)}`}
                  >
                    {renderInline(header, onWikilinkClick)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--line)]">
              {rows.map((row, rIdx) => (
                <tr key={rIdx} className="text-[var(--ink-secondary)]">
                  {headers.map((_, colIdx) => (
                    <td
                      key={colIdx}
                      className={`border-r border-[var(--line)] px-3 py-2 align-top last:border-r-0 ${alignClass(colIdx)}`}
                    >
                      {renderInline(row[colIdx] ?? "", onWikilinkClick)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
      continue;
    }

    if (/^#{1,4}\s+/.test(line)) {
      const level = Math.min(4, Math.max(1, line.match(/^#+/)?.[0].length ?? 2));
      const text = line.replace(/^#+\s+/, "");
      const contentNode = renderInline(text, onWikilinkClick);
      if (level === 1) {
        blocks.push(
          <h1
            key={blocks.length}
            className="mt-5 mb-2 text-lg font-semibold tracking-tight text-[var(--ink)]"
          >
            {contentNode}
          </h1>
        );
      } else if (level === 2) {
        blocks.push(
          <h2
            key={blocks.length}
            className="mt-5 mb-2 border-b border-[var(--line)] pb-1.5 text-[16px] font-semibold tracking-tight text-[var(--ink)]"
          >
            {contentNode}
          </h2>
        );
      } else if (level === 3) {
        blocks.push(
          <h3
            key={blocks.length}
            className="mt-3.5 mb-1 text-[14px] font-semibold text-[var(--ink)]"
          >
            {contentNode}
          </h3>
        );
      } else {
        blocks.push(
          <h4
            key={blocks.length}
            className="mt-3 mb-1 text-[13px] font-semibold text-[var(--ink)]"
          >
            {contentNode}
          </h4>
        );
      }
      idx++;
      continue;
    }

    if (/^---+$/.test(line.trim())) {
      blocks.push(<hr key={blocks.length} className="my-4 border-[var(--line)]" />);
      idx++;
      continue;
    }

    if (line.trim().startsWith(">")) {
      const quoteLines: string[] = [];
      while (idx < lines.length && lines[idx].trim().startsWith(">")) {
        quoteLines.push(lines[idx].replace(/^\s*>\s?/, ""));
        idx++;
      }
      blocks.push(
        <blockquote
          key={blocks.length}
          className="my-3 border-l-2 border-[var(--line-strong)] pl-4 italic text-[var(--ink-secondary)]"
        >
          {quoteLines.map((ql, i) => (
            <p key={i} className="my-1">
              {renderInline(ql, onWikilinkClick)}
            </p>
          ))}
        </blockquote>
      );
      continue;
    }

    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (idx < lines.length && /^\s*[-*]\s+/.test(lines[idx])) {
        items.push(lines[idx].replace(/^\s*[-*]\s+/, ""));
        idx++;
      }
      blocks.push(
        <ul key={blocks.length} className="my-2 space-y-1.5">
          {items.map((item, i) => {
            const taskMatch = /^\[([ xX])\]\s+(.*)$/.exec(item);
            if (taskMatch) {
              const checked = taskMatch[1].toLowerCase() === "x";
              const body = taskMatch[2];
              return (
                <li key={i} className="flex items-start gap-2.5 pl-0.5 leading-relaxed">
                  <span
                    aria-hidden="true"
                    className={`mt-[0.28em] flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[4px] border ${
                      checked
                        ? "border-[var(--sage-border)] bg-[var(--sage-soft)] text-[var(--sage)]"
                        : "border-[var(--line-strong)] bg-[var(--surface-sunken)] text-transparent"
                    }`}
                  >
                    <Check className="h-2.5 w-2.5" strokeWidth={2.5} />
                  </span>
                  <span className="sr-only">{checked ? "Completed:" : "Incomplete:"}</span>
                  <span className={checked ? "text-[var(--muted)]" : ""}>
                    {renderInline(body, onWikilinkClick)}
                  </span>
                </li>
              );
            }

            return (
              <li
                key={i}
                className="relative pl-4 leading-relaxed before:absolute before:left-1 before:top-[0.62em] before:h-1 before:w-1 before:rounded-full before:bg-[var(--muted)]"
              >
                {renderInline(item, onWikilinkClick)}
              </li>
            );
          })}
        </ul>
      );
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (idx < lines.length && /^\s*\d+\.\s+/.test(lines[idx])) {
        items.push(lines[idx].replace(/^\s*\d+\.\s+/, ""));
        idx++;
      }
      blocks.push(
        <ol key={blocks.length} className="my-2 list-decimal space-y-1.5 pl-5">
          {items.map((item, i) => (
            <li key={i} className="leading-relaxed">
              {renderInline(item, onWikilinkClick)}
            </li>
          ))}
        </ol>
      );
      continue;
    }

    if (!line.trim()) {
      idx++;
      continue;
    }

    blocks.push(
      <p key={blocks.length} className="my-2 leading-relaxed">
        {renderInline(line, onWikilinkClick)}
      </p>
    );
    idx++;
  }

  return <div className={`ce-prose ${className}`.trim()}>{blocks}</div>;
}
