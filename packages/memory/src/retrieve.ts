import type { Store } from '@execugate/db';
import { documentRepo, chunkRepo } from '@execugate/db';
import type { OrgScope, RetrievedChunk } from '@execugate/core';
import type { EmbeddingProvider } from './embed.ts';
import { cosineSimilarity, fromBlob, toBlob } from './embed.ts';
import { chunkDocument, chunkPlainText, estimateTokens } from './chunk.ts';
import { startTimer, createLogger } from '@execugate/observability';

const log = createLogger('memory');

/** Reciprocal rank fusion constant. 60 is the value from the original RRF paper. */
const RRF_K = 60;

export interface IngestResult {
  documentId: string;
  chunkCount: number;
  deduplicated: boolean;
  elapsedMs: number;
}

/**
 * FR-02.1/2.3. Idempotent via content checksum: re-ingesting the same document is a
 * no-op, so operators can re-run ingest freely after a model change.
 */
export async function ingestDocument(
  store: Store,
  embedder: EmbeddingProvider,
  scope: OrgScope,
  doc: { projectId: string; title: string; body: string; mime?: string; sourcePath?: string | null },
): Promise<IngestResult> {
  const done = startTimer();
  const docs = documentRepo(store);
  const chunks = chunkRepo(store);

  const inserted = docs.insert(scope, doc);
  if (inserted.deduplicated) {
    log.info('document already ingested; skipping', { title: doc.title, documentId: inserted.id });
    return { documentId: inserted.id, chunkCount: inserted.chunkCount, deduplicated: true, elapsedMs: done() };
  }

  docs.setState(scope, inserted.id, 'embedding');

  const parts = (doc.mime ?? 'text/markdown').includes('markdown')
    ? chunkDocument(doc.body)
    : chunkPlainText(doc.body);

  chunks.insertAll(scope, inserted.id, doc.projectId, parts.map((c) => ({ text: c.text, tokens: c.tokens })));

  const rows = chunks.allForProject(scope, doc.projectId).filter((c) => c.doc_id === inserted.id);
  const vectors = await embedder.embed(rows.map((r) => r.text));
  chunks.setEmbeddings(
    scope,
    inserted.id,
    embedder.dims,
    new Map(rows.map((r, i) => [r.id, vectors[i]!])),
  );

  docs.setState(scope, inserted.id, 'ready', { embedModel: embedder.model, chunkCount: parts.length });
  log.info('document ingested', { title: doc.title, chunks: parts.length, dims: embedder.dims, elapsedMs: done() });

  return { documentId: inserted.id, chunkCount: parts.length, deduplicated: false, elapsedMs: done() };
}

export interface RetrieveOptions {
  /** Natural-language query or instruction. */
  query: string;
  projectId: string;
  limit?: number;
  /** Candidates pulled from each retriever before fusion. */
  candidateK?: number;
}

export interface RetrieveOutcome {
  chunks: RetrievedChunk[];
  vectorCount: number;
  ftsCount: number;
  elapsedMs: number;
  degraded: 'none' | 'vector_only' | 'fts_only';
}

/**
 * ADR-3 hybrid retrieval: cosine over float32 BLOB + FTS5 BM25, fused with RRF.
 *
 * Indonesian organisational text is identifier-heavy ("batch-4471", "SOP Q3",
 * "core-gateway"). Vector-only retrieval misses those; BM25-only misses paraphrase.
 * Fusion gets both without a vector database.
 */
export async function retrieve(
  store: Store,
  embedder: EmbeddingProvider,
  scope: OrgScope,
  opts: RetrieveOptions,
): Promise<RetrieveOutcome> {
  const done = startTimer();
  const limit = opts.limit ?? 6;
  const candidateK = opts.candidateK ?? 20;
  const chunks = chunkRepo(store);
  const docs = documentRepo(store);

  const [queryVec, stored] = await Promise.all([
    embedder.embed([opts.query]),
    Promise.resolve(chunks.vectorsForProject(scope, opts.projectId)),
  ]);
  const q = queryVec[0]!;

  const vectorHits = stored
    .map((row) => {
      const v = fromBlob(row.embedding);
      return { row, score: v ? cosineSimilarity(q, v) : 0 };
    })
    .filter((h) => h.score > 0.02)
    .sort((a, b) => b.score - a.score)
    .slice(0, candidateK);

  const ftsHits = chunks.fts(scope, opts.projectId, opts.query, candidateK);

  // Fusion. A chunk found by both retrievers ranks highest, which is the desired
  // behaviour for identifier-laden queries.
  const fused = new Map<string, RetrievedChunk>();
  vectorHits.forEach((h, i) => {
    fused.set(h.row.id, {
      chunkId: h.row.id, docId: h.row.doc_id, docTitle: '', ordinal: h.row.ordinal,
      text: h.row.text, score: 1 / (RRF_K + i + 1), matchedBy: 'vector',
    });
  });
  ftsHits.forEach((h, i) => {
    const existing = fused.get(h.id);
    if (existing) {
      existing.score += 1 / (RRF_K + i + 1);
      existing.matchedBy = 'both';
    } else {
      fused.set(h.id, {
        chunkId: h.id, docId: h.doc_id, docTitle: '', ordinal: h.ordinal,
        text: h.text, score: 1 / (RRF_K + i + 1), matchedBy: 'fts',
      });
    }
  });

  const titleCache = new Map<string, string>();
  const results = [...fused.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((c) => {
      if (!titleCache.has(c.docId)) {
        const d = docs.get(scope, c.docId);
        titleCache.set(c.docId, d?.title ?? 'Dokumen');
      }
      return { ...c, docTitle: titleCache.get(c.docId)! };
    });

  const degraded =
    vectorHits.length === 0 && ftsHits.length === 0 ? 'none'
      : vectorHits.length === 0 ? 'fts_only'
        : ftsHits.length === 0 ? 'vector_only'
          : 'none';

  return { chunks: results, vectorCount: vectorHits.length, ftsCount: ftsHits.length, elapsedMs: done(), degraded };
}

export { toBlob, fromBlob, cosineSimilarity, chunkDocument, chunkPlainText, estimateTokens };

/**
 * Builds a preview centred on the query.
 *
 * A fixed prefix, or anchoring on the *first* matching term, both fail on real
 * documents: the canonical capacity table has a "Batas Kapasitas" heading near the
 * top, so matching "batas" lands the window there and truncates before the value.
 * Instead, every term occurrence is a candidate anchor and the window covering the
 * most distinct query terms wins.
 */
export function buildExcerpt(text: string, query: string, radius = 180): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= radius * 2) return clean;

  const terms = [...new Set(
    query
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length >= 3),
  )];
  if (!terms.length) return `…${clean.slice(0, radius * 2)}…`;

  const lower = clean.toLowerCase();
  const positions: number[] = [];

  for (const term of terms) {
    let from = 0;
    while (positions.length < 200) {
      const idx = lower.indexOf(term, from);
      if (idx === -1) break;
      positions.push(idx);
      from = idx + term.length;
    }
  }
  if (!positions.length) return `…${clean.slice(0, radius * 2)}…`;

  let bestAnchor = positions[0]!;
  let bestScore = -1;
  let bestSpan = Number.POSITIVE_INFINITY;

  for (const pos of positions) {
    const start = Math.max(0, pos - radius);
    const end = Math.min(clean.length, pos + radius);
    const window = lower.slice(start, end);

    const covered = terms.filter((t) => window.includes(t)).length;
    if (covered < bestScore) continue;

    // Among equally-covered windows, prefer the densest cluster of matches, and anchor
    // on the midpoint of that cluster rather than on a single term. Anchoring on one
    // term lands the window at the section heading instead of the row that answers.
    const hits = positions.filter((p) => p >= start && p <= end);
    const span = hits.length ? hits[hits.length - 1]! - hits[0]! : Number.POSITIVE_INFINITY;

    if (covered > bestScore || span < bestSpan) {
      bestScore = covered;
      bestSpan = span;
      bestAnchor = hits.length ? (hits[0]! + hits[hits.length - 1]!) / 2 : pos;
    }
  }

  const best = bestAnchor;

  const start = Math.max(0, best - radius);
  const end = Math.min(clean.length, best + radius);
  return `${start > 0 ? '…' : ''}${clean.slice(start, end)}${end < clean.length ? '…' : ''}`;
}