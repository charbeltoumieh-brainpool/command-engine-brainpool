/**
 * Strips Markdown and Obsidian wikilink syntax from raw note/message content
 * so list previews and excerpts read as clean, natural prose.
 */
export function stripMarkdownExcerpt(
  raw: string | null | undefined,
  maxLen = 140,
): string {
  if (!raw || maxLen <= 0) return "";

  let text = raw.replace(/\r\n?/g, "\n");

  // Remove optional YAML frontmatter block at the top of a document
  text = text.replace(/^---\n[\s\S]*?\n---\n?/, "");

  // Remove reference-style link definitions: [id]: https://...
  text = text.replace(/^\s*\[[^\]]+\]:\s+\S+.*$/gm, "");

  // Replace fenced code block markers while preserving inner content
  text = text.replace(/^[ \t]*(?:```|~~~)[^\n]*$/gm, "");

  // Images: ![alt](url) -> alt
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");

  // Obsidian wikilinks: [[slug|label]] -> label, [[slug#heading|label]] -> label, [[slug]] -> slug
  text = text.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2");
  text = text.replace(/\[\[([^\]]+)\]\]/g, (_, inner: string) => {
    const hashIdx = inner.indexOf("#");
    return hashIdx > 0 ? inner.slice(0, hashIdx) : inner;
  });

  // Inline links: [label](url "title") -> label
  text = text.replace(/\[([^\]]+)\]\((?:[^()\s]+|\([^)]*\))*(?:\s+"[^"]*")?\)/g, "$1");

  // Reference links: [label][ref] -> label
  text = text.replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1");

  // Block-level markers (headings, blockquotes, horizontal rules, task/list markers)
  text = text.replace(/^[ \t]*[-*_](?:[ \t]*[-*_]){2,}[ \t]*$/gm, "");
  text = text.replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, "");
  text = text.replace(/[ \t]+#+[ \t]*$/gm, "");
  text = text.replace(/^[ \t]*(?:>[ \t]*)+/gm, "");
  text = text.replace(/^[ \t]*[-*+][ \t]+\[[ xX]\][ \t]+/gm, "");
  text = text.replace(/^[ \t]*[-*+][ \t]+/gm, "");
  text = text.replace(/^[ \t]*\d+[.)][ \t]+/gm, "");

  // Inline code and emphasis
  text = text.replace(/`+([^`]+)`+/g, "$1");
  text = text.replace(/`/g, "");
  text = text.replace(/~~([^~]+)~~/g, "$1");
  text = text.replace(/(\*\*\*|___)(.+?)\1/g, "$2");
  text = text.replace(/(\*\*|__)(.+?)\1/g, "$2");
  text = text.replace(/\*(.+?)\*/g, "$1");
  text = text.replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,!?;:]|$)/g, "$1$2");

  // Clean any stray unmatched emphasis/heading tokens at boundaries
  text = text.replace(/\*\*/g, "").replace(/~~/g, "");
  text = text.replace(/(^|\s)\*(?=\S)/g, "$1").replace(/(?<=\S)\*(?=\s|$)/g, "");

  // Collapse whitespace into natural single-line prose
  text = text.replace(/\s+/g, " ").trim();

  if (!text) return "";
  if (text.length <= maxLen) return text;

  const limit = Math.max(1, maxLen - 1);
  const slice = text.slice(0, limit);
  const lastSpace = slice.lastIndexOf(" ");
  const boundary = lastSpace > limit * 0.6 ? slice.slice(0, lastSpace) : slice;
  const cleaned = boundary.replace(/[.,;:\-–—\s]+$/, "");

  return `${cleaned || slice.trimEnd()}…`;
}
