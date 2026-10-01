import type { Store } from '../db.ts';
import { newId, sha256 } from '@execugate/core';
import type { OrgScope } from '@execugate/core';

const now = () => new Date().toISOString();

export interface DocumentRow {
  id: string; org_id: string; project_id: string; title: string; source_path: string | null;
  mime: string; size: number; checksum: string;
  ingest_state: 'pending' | 'embedding' | 'ready' | 'failed';
  embed_model: string | null; chunk_count: number; ingested_at: string | null; created_at: string;
}
export interface ChunkRow {
  id: string; org_id: string; project_id: string; doc_id: string; ordinal: number;
  text: string; embedding: Uint8Array | null; dims: number | null; tokens: number;
}

export function documentRepo(store: Store) {
  return {
    insert(scope: OrgScope, d: { projectId: string; title: string; body: string; mime?: string; sourcePath?: string | null }) {
      const checksum = sha256(d.body);
      const existing = store.get<DocumentRow>(
        'SELECT * FROM documents WHERE org_id = ? AND checksum = ?', scope.orgId, checksum,
      );
      // Re-uploading identical content is a no-op, which keeps ingest idempotent.
      if (existing) return { id: existing.id, chunkCount: existing.chunk_count, deduplicated: true };

      const id = newId('doc');
      store.run(
        `INSERT INTO documents (id, org_id, project_id, title, source_path, mime, size, checksum, ingest_state, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        id, scope.orgId, d.projectId, d.title, d.sourcePath ?? null,
        d.mime ?? 'text/markdown', Buffer.byteLength(d.body, 'utf8'), checksum, 'pending', now(),
      );
      return { id, chunkCount: 0, deduplicated: false };
    },

    setState(scope: OrgScope, id: string, state: DocumentRow['ingest_state'], extra: { embedModel?: string; chunkCount?: number } = {}) {
      store.run(
        `UPDATE documents SET ingest_state = ?, embed_model = COALESCE(?, embed_model),
           chunk_count = COALESCE(?, chunk_count),
           ingested_at = CASE WHEN ? = 'ready' THEN ? ELSE ingested_at END
         WHERE org_id = ? AND id = ?`,
        state, extra.embedModel ?? null, extra.chunkCount ?? null, state, now(), scope.orgId, id,
      );
    },

    get(scope: OrgScope, id: string) {
      return store.get<DocumentRow>('SELECT * FROM documents WHERE org_id = ? AND id = ?', scope.orgId, id);
    },
    byChecksum(scope: OrgScope, checksum: string) {
      return store.get<DocumentRow>('SELECT * FROM documents WHERE org_id = ? AND checksum = ?', scope.orgId, checksum);
    },
    list(scope: OrgScope, projectId?: string) {
      return projectId
        ? store.all<DocumentRow>('SELECT * FROM documents WHERE org_id = ? AND project_id = ? ORDER BY created_at DESC', scope.orgId, projectId)
        : store.all<DocumentRow>('SELECT * FROM documents WHERE org_id = ? ORDER BY created_at DESC', scope.orgId);
    },
  };
}

export function chunkRepo(store: Store) {
  return {
    /**
     * Inserts chunks and mirrors them into the FTS5 index. FTS5 is an external-content
     * table, so the mirror must be written explicitly rather than by trigger.
     */
    insertAll(scope: OrgScope, docId: string, projectId: string, chunks: Array<{ text: string; tokens: number }>) {
      store.transaction(() => {
        store.run('DELETE FROM doc_chunks WHERE org_id = ? AND doc_id = ?', scope.orgId, docId);
        store.run("DELETE FROM doc_fts WHERE rowid IN (SELECT rowid FROM doc_chunks WHERE org_id = ? AND doc_id = ?)", scope.orgId, docId);
        chunks.forEach((c, i) => {
          const id = newId('chk');
          store.run(
            'INSERT INTO doc_chunks (id, org_id, project_id, doc_id, ordinal, text, tokens) VALUES (?,?,?,?,?,?,?)',
            id, scope.orgId, projectId, docId, i, c.text, c.tokens,
          );
          store.run('INSERT INTO doc_fts (rowid, text) VALUES ((SELECT rowid FROM doc_chunks WHERE id = ?), ?)', id, c.text);
        });
      });
      return chunks.length;
    },

    setEmbeddings(scope: OrgScope, docId: string, dims: number, vectors: Map<string, Float32Array>) {
      store.transaction(() => {
        for (const [chunkId, vec] of vectors) {
          store.run(
            'UPDATE doc_chunks SET embedding = ?, dims = ? WHERE org_id = ? AND id = ?',
            Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength), dims, scope.orgId, chunkId,
          );
        }
      });
    },

    /**
     * ADR-2: a single scoped scan, scored in JS. At demo scale (<=10k chunks) this is
     * ~2-5 ms, faster than a round-trip to a dedicated vector database.
     */
    vectorsForProject(scope: OrgScope, projectId: string) {
      return store.all<ChunkRow>(
        'SELECT * FROM doc_chunks WHERE org_id = ? AND project_id = ? AND embedding IS NOT NULL',
        scope.orgId, projectId,
      );
    },

    allForProject(scope: OrgScope, projectId: string) {
      return store.all<ChunkRow>('SELECT * FROM doc_chunks WHERE org_id = ? AND project_id = ?', scope.orgId, projectId);
    },

    get(scope: OrgScope, id: string) {
      return store.get<ChunkRow>('SELECT * FROM doc_chunks WHERE org_id = ? AND id = ?', scope.orgId, id);
    },

    /**
     * Lexical half of hybrid retrieval. Tenant filter is applied in SQL, never after
     * the fact (BUILD_PLAN §11).
     */
    fts(scope: OrgScope, projectId: string, query: string, limit: number) {
      const match = buildFtsQuery(query);
      if (!match) return [];
      try {
        return store.all<{ id: string; doc_id: string; ordinal: number; text: string; rank: number }>(
          `SELECT c.id, c.doc_id, c.ordinal, c.text, bm25(doc_fts) AS rank
             FROM doc_fts
             JOIN doc_chunks c ON c.rowid = doc_fts.rowid
            WHERE doc_fts MATCH ? AND c.org_id = ? AND c.project_id = ?
            ORDER BY rank LIMIT ?`,
          match, scope.orgId, projectId, limit,
        );
      } catch {
        // A malformed MATCH expression must degrade to vector-only, never throw.
        return [];
      }
    },

    /** Used by the `fake` embedder: keyword-overlap similarity over stored text. */
    keywordOverlaps(scope: OrgScope, projectId: string, terms: string[], limit: number) {
      if (!terms.length) return [];
      const scored = this.allForProject(scope, projectId).map((c) => {
        const lower = c.text.toLowerCase();
        let score = 0;
        for (const t of terms) if (lower.includes(t)) score += 1;
        return { id: c.id, doc_id: c.doc_id, ordinal: c.ordinal, text: c.text, rank: -score };
      });
      return scored.filter((s) => s.rank < 0).sort((a, b) => a.rank - b.rank).slice(0, limit);
    },

    countForDoc(scope: OrgScope, docId: string) {
      return store.get<{ n: number }>('SELECT COUNT(*) AS n FROM doc_chunks WHERE org_id = ? AND doc_id = ?', scope.orgId, docId)?.n ?? 0;
    },
  };
}

/**
 * FTS5 query builder. Bare terms are quoted to avoid the MATCH parser choking on
 * punctuation from code identifiers and URLs found in architecture documents.
 */
export function buildFtsQuery(input: string): string | null {
  const terms = input
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3)
    .slice(0, 12);
  if (!terms.length) return null;
  return terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ');
}

export function termRepo(store: Store) {
  return {
    upsert(scope: OrgScope, projectId: string, t: { term: string; canonical: string; definition: string }) {
      store.run(
        `INSERT INTO doc_terms (id, org_id, project_id, term, canonical, definition) VALUES (?,?,?,?,?,?)
         ON CONFLICT (org_id, project_id, term) DO UPDATE SET canonical = excluded.canonical, definition = excluded.definition`,
        newId('trm'), scope.orgId, projectId, t.term, t.canonical, t.definition,
      );
    },
    list(scope: OrgScope, projectId: string) {
      return store.all<{ term: string; canonical: string; definition: string }>(
        'SELECT term, canonical, definition FROM doc_terms WHERE org_id = ? AND project_id = ? ORDER BY term',
        scope.orgId, projectId,
      );
    },
  };
}
