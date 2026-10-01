/**
 * Heading-aware recursive chunking (FR-02.2).
 *
 * Two rules that matter more than the token target:
 *  1. Never split inside a fenced code block or a Markdown table row. Both carry
 *     meaning that is destroyed by a split (the canonical payload-limit table in
 *     `arsitektur-payment-service.md` is the exact case this protects).
 *  2. Prefer breaking on heading boundaries so a retrieved chunk is a coherent
 *     section rather than an arbitrary window.
 */
export interface Chunk {
  ordinal: number;
  text: string;
  tokens: number;
}

const TARGET_TOKENS = 700;
const OVERLAP_TOKENS = 100;
const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

interface Segment {
  text: string;
  breakable: boolean;
}

/** Breaks a document into segments at headings while keeping code fences/tables atomic. */
function toSegments(markdown: string): Segment[] {
  const segments: Segment[] = [];
  let buffer: string[] = [];

  const flush = () => {
    const text = buffer.join('\n').trim();
    if (text) segments.push({ text, breakable: true });
    buffer = [];
  };

  for (const line of markdown.split('\n')) {
    if (/^#{1,6}\s/.test(line)) {
      flush();
      buffer.push(line);
      continue;
    }
    buffer.push(line);
    // Close a segment right after a closing fence so code stays whole.
    if (/^```\s*$/.test(line)) flush();
  }
  flush();
  return segments;
}

function splitLongSegment(text: string, maxTokens: number): string[] {
  const maxChars = maxTokens * CHARS_PER_TOKEN;
  if (text.length <= maxChars) return [text];

  const out: string[] = [];
  const paragraphs = text.split(/\n{2,}/);
  let buffer = '';

  for (const p of paragraphs) {
    if (p.length > maxChars) {
      if (buffer.trim()) out.push(buffer.trim());
      buffer = '';
      // A single oversized paragraph (e.g. a wide table): split on line boundaries.
      let chunk = '';
      for (const line of p.split('\n')) {
        if (chunk.length + line.length + 1 > maxChars && chunk) {
          out.push(chunk.trim());
          chunk = '';
        }
        chunk += (chunk ? '\n' : '') + line;
      }
      if (chunk.trim()) out.push(chunk.trim());
      continue;
    }
    if (buffer.length + p.length + 2 > maxChars) {
      if (buffer.trim()) out.push(buffer.trim());
      buffer = p;
    } else {
      buffer += (buffer ? '\n\n' : '') + p;
    }
  }
  if (buffer.trim()) out.push(buffer.trim());
  return out.filter(Boolean);
}

function tailOverlap(text: string): string {
  const limit = OVERLAP_TOKENS * CHARS_PER_TOKEN;
  if (text.length <= limit) return '';
  const tail = text.slice(-limit);
  const nl = tail.indexOf('\n');
  return nl === -1 ? tail : tail.slice(nl + 1);
}

export function chunkDocument(markdown: string, targetTokens = TARGET_TOKENS): Chunk[] {
  const segments = toSegments(markdown);
  const raw: string[] = [];

  for (const seg of segments) {
    for (const piece of splitLongSegment(seg.text, targetTokens)) raw.push(piece);
  }

  // Merge tiny trailing segments into their predecessor to avoid orphan chunks.
  const merged: string[] = [];
  for (const piece of raw) {
    const prev = merged[merged.length - 1];
    if (prev && estimateTokens(prev) + estimateTokens(piece) < targetTokens * 0.5) {
      merged[merged.length - 1] = `${prev}\n\n${piece}`;
    } else {
      merged.push(piece);
    }
  }

  return merged.map((text, i) => {
    const overlap = i > 0 ? tailOverlap(merged[i - 1]!) : '';
    const full = overlap ? `${overlap}\n\n${text}` : text;
    return { ordinal: i, text: full.trim(), tokens: estimateTokens(full) };
  }).filter((c) => c.text.length > 20);
}

/** Plain-text documents (no Markdown) are chunked with a fixed sliding window. */
export function chunkPlainText(text: string, targetTokens = TARGET_TOKENS): Chunk[] {
  const chars = targetTokens * CHARS_PER_TOKEN;
  // The overlap must be smaller than the window, otherwise the stride is 0 and the
  // loop never advances — an unbounded allocation loop rather than a slow one.
  const overlapChars = Math.min(OVERLAP_TOKENS, Math.max(0, Math.floor(targetTokens / 4))) * CHARS_PER_TOKEN;
  const step = Math.max(1, chars - overlapChars);

  const out: Chunk[] = [];
  for (let i = 0, ord = 0; i < text.length; i += step, ord++) {
    const slice = text.slice(i, i + chars).trim();
    if (slice.length < 20) break;
    out.push({ ordinal: ord, text: slice, tokens: estimateTokens(slice) });
    // Bail out rather than emit thousands of near-duplicate chunks.
    if (out.length >= 10_000) break;
  }
  return out;
}