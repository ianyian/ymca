// Extract readable plain text from a TipTap/ProseMirror document (stored as JSONB
// in Page.content). We denormalise this into Page.contentText so search can match
// page *body* text and build snippets without loading the (potentially huge, with
// embedded images) content JSON on every query.

// Cap the stored text so a page full of pasted content can't bloat the column or
// slow down ILIKE scans. 20k characters comfortably covers normal documents.
const MAX_CONTENT_TEXT = 20_000;

// Node types that represent a block break — we insert a space so words from
// adjacent blocks don't run together in snippets/search.
export function extractPlainText(content: unknown): string {
  const parts: string[] = [];

  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const n = node as { text?: unknown; content?: unknown };
    if (typeof n.text === "string") {
      parts.push(n.text);
    }
    if (Array.isArray(n.content)) {
      for (const child of n.content) walk(child);
      // block boundary
      parts.push(" ");
    }
  };

  walk(content);

  const text = parts.join(" ").replace(/\s+/g, " ").trim();
  return text.length > MAX_CONTENT_TEXT ? text.slice(0, MAX_CONTENT_TEXT) : text;
}

// Build a short excerpt around the first matched token, with an ellipsis on each
// side when truncated. The frontend highlights the query terms within it.
export function buildSnippet(
  text: string,
  tokens: string[],
  radius = 60,
): string | null {
  if (!text) return null;
  const lower = text.toLowerCase();
  let idx = -1;
  for (const tok of tokens) {
    const i = lower.indexOf(tok.toLowerCase());
    if (i !== -1 && (idx === -1 || i < idx)) idx = i;
  }
  if (idx === -1) return null;

  const start = Math.max(0, idx - radius);
  const end = Math.min(text.length, idx + radius * 2);
  let snippet = text.slice(start, end).trim();
  if (start > 0) snippet = `…${snippet}`;
  if (end < text.length) snippet = `${snippet}…`;
  return snippet;
}
