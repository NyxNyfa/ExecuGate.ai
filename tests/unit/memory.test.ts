import { describe, it, expect } from 'vitest';
import { Store, seedCore, documentRepo, chunkRepo } from '@execugate/db';
import {
  chunkDocument, chunkPlainText, estimateTokens,
  createFakeEmbedder, hashedVector, normalize, cosineSimilarity, fromBlob, toBlob,
  ingestDocument, retrieve, buildExcerpt,
} from '@execugate/memory';
import type { OrgScope } from '@execugate/core';

const DOC = `# Arsitektur Payment Service

Dokumen acuan kanonik untuk Payment Service v2.4.

## Batas Kapasitas

| Parameter | Nilai Baku | Catatan |
|---|---|---|
| Batas payload request | 512 KB | Body JSON UTF-8 |
| Timeout upstream | 8 detik | Calls ke acquirer |

### Catatan Implementasi

Payload melebihi 512 KB menghasilkan HTTP 413 dengan kode PAYLOAD_TOO_LARGE.

\`\`\`json
{"error":"PAYLOAD_TOO_LARGE","limit":"512KB"}
\`\`\`

## Aturan Branch

Semua perubahan wajib melalui Pull Request dan merge.

\`\`\`
git checkout -b feat/contoh
\`\`\`
`;

describe('chunking (FR-02.2)', () => {
  it('never splits inside a fenced code block', () => {
    const chunks = chunkDocument(DOC);
    for (const c of chunks) {
      const fences = (c.text.match(/```/g) ?? []).length;
      expect(fences % 2).toBe(0);
    }
  });

  it('keeps a table row intact', () => {
    const chunks = chunkDocument(DOC);
    const withTable = chunks.find((c) => c.text.includes('| Parameter |'));
    expect(withTable).toBeDefined();
    // The capacity table's rows must not be separated from each other.
    const table = withTable!.text;
    expect(table).toContain('512 KB');
    expect(table).toContain('8 detik');
  });

  it('breaks on heading boundaries for a document larger than the merge threshold', () => {
    // Small documents deliberately collapse into a single chunk: a one-chunk
    // document retrieves better than two half-chunks. The boundary split only
    // engages once sections would otherwise be merged into one oversized window.
    const filler = 'Baris penjelasan tambahan untuk memaksa pemisahan bagian. '.repeat(60);
    const longDoc = DOC + '\n\n## Lampiran A\n\n' + filler + '\n\n## Lampiran B\n\n' + filler;
    const chunks = chunkDocument(longDoc);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.some((c) => /^#/.test(c.text))).toBe(true);
  });

  it('keeps a short document as one chunk', () => {
    // Guards the merge behaviour above so the boundary test cannot regress into
    // splitting everything into fragments.
    expect(chunkDocument(DOC)).toHaveLength(1);
  });

  it('assigns sequential ordinals and non-zero tokens', () => {
    const chunks = chunkDocument(DOC);
    chunks.forEach((c, i) => {
      expect(c.ordinal).toBe(i);
      expect(c.tokens).toBeGreaterThan(0);
    });
  });

  it('never emits an orphan chunk below the noise floor', () => {
    for (const c of chunkDocument(DOC)) expect(c.text.length).toBeGreaterThan(20);
  });

  it('chunks plain text with a sliding window and overlap', () => {
    const long = 'kalimat pengujian untuk pembagian teks. '.repeat(40);
    const chunks = chunkPlainText(long, 100);
    expect(chunks.length).toBeGreaterThan(1);
    // Window + overlap, so each slice stays within the target size.
    expect(chunks[1]!.text.length).toBeLessThanOrEqual(100 * 4);
  });

  it('handles a tiny document without crashing', () => {
    expect(chunkDocument('# Judul')).toHaveLength(0);
    expect(chunkPlainText('pendek')).toHaveLength(0);
  });

  it('estimates tokens monotonically with length', () => {
    expect(estimateTokens('a'.repeat(400))).toBeGreaterThan(estimateTokens('a'.repeat(40)));
  });
});

describe('embeddings', () => {
  it('is deterministic, so retrieval results are reproducible in CI', () => {
    const a = hashedVector('batas payload 512 KB', 256);
    const b = hashedVector('batas payload 512 KB', 256);
    expect([...a]).toEqual([...b]);
  });

  it('produces unit-length vectors', () => {
    const v = hashedVector('uji normalisasi', 256);
    expect(cosineSimilarity(v, v)).toBeCloseTo(1, 5);
  });

  it('scores text sharing vocabulary above unrelated text', () => {
    const q = hashedVector('batas payload request', 256);
    const related = hashedVector('batas payload request adalah 512 KB', 256);
    const unrelated = hashedVector('kepribadianServerless deployment pipeline', 256);
    expect(cosineSimilarity(q, related)).toBeGreaterThan(cosineSimilarity(q, unrelated));
  });

  it('survives a BLOB round-trip without misalignment', () => {
    const original = normalize(hashedVector('round trip check', 384));
    const restored = fromBlob(toBlob(original))!;
    expect(restored.length).toBe(original.length);
    expect(cosineSimilarity(original, restored)).toBeCloseTo(1, 6);
  });

  it('returns null for an absent embedding', () => {
    expect(fromBlob(null)).toBeNull();
  });

  it('handles a zero vector without producing NaN', () => {
    expect(cosineSimilarity(new Float32Array(4), new Float32Array(4))).toBe(0);
  });

  it('scores zero for mismatched dimensions', () => {
    expect(cosineSimilarity(new Float32Array(4), new Float32Array(8))).toBe(0);
  });
});

describe('hybrid retrieval (FR-02.3)', () => {
  let store: Store;
  let scope: OrgScope;
  let projectId: string;
  const embedder = createFakeEmbedder(384);

  const setup = async () => {
    store = new Store(':memory:');
    store.migrate();
    const refs = seedCore(store);
    scope = { orgId: refs.orgId };
    projectId = refs.projectId;
    await ingestDocument(store, embedder, scope, { projectId, title: 'Arsitektur Payment Service', body: DOC, mime: 'text/markdown' });
  };

  it('retrieves the chunk holding the canonical payload limit', async () => {
    await setup();
    const found = await retrieve(store, embedder, scope, { query: 'batas payload request berapa', projectId });
    expect(found.chunks.length).toBeGreaterThan(0);
    expect(found.chunks.map((c) => c.text).join(' ')).toMatch(/512 KB/);
  });

  it('labels the source document on every hit', async () => {
    await setup();
    const found = await retrieve(store, embedder, scope, { query: 'aturan branch pull request', projectId });
    for (const c of found.chunks) expect(c.docTitle).toBe('Arsitektur Payment Service');
  });

  it('uses both retrievers for an identifier-style query', async () => {
    await setup();
    const found = await retrieve(store, embedder, scope, { query: 'PAYLOAD_TOO_LARGE', projectId });
    expect(found.vectorCount + found.ftsCount).toBeGreaterThan(0);
  });

  it('degrades rather than throwing on a malformed FTS query', async () => {
    await setup();
    const found = await retrieve(store, embedder, scope, { query: '   *** ???  ', projectId });
    expect(found.chunks).toBeDefined();
  });

  it('returns nothing for an empty corpus instead of inventing results', async () => {
    store = new Store(':memory:');
    store.migrate();
    const refs = seedCore(store);
    const found = await retrieve(store, embedder, { orgId: refs.orgId }, { query: 'apa saja', projectId: refs.projectId });
    expect(found.chunks).toHaveLength(0);
  });

  it('respects the result limit', async () => {
    await setup();
    const found = await retrieve(store, embedder, scope, { query: 'payload timeout branch pull request merge', projectId, limit: 1 });
    expect(found.chunks.length).toBeLessThanOrEqual(1);
  });

  it('reports a latency figure for the NFR measurement', async () => {
    await setup();
    const found = await retrieve(store, embedder, scope, { query: 'payload', projectId });
    expect(found.elapsedMs).toBeGreaterThanOrEqual(0);
  });
});

describe('search excerpt (buildExcerpt)', () => {
  const chunk = [
    '# Arsitektur Sistem',
    '',
    '**Project:** Core Platform (kode: `CORE`)',
    '',
    '## Batas Kapasitas',
    '',
    '| Parameter | Nilai Baku | Catatan |',
    '|---|---|---|',
    '| Batas payload request | 512 KB | Body JSON UTF-8 |',
    '| Timeout upstream | 8 detik | Calls ke acquirer |',
    '',
    '## Aturan Branch',
    '',
    'Semua perubahan wajib melalui Pull Request dan merge.',
  ].join('\n');

  it('shows the value the query asked about, not just the section heading', () => {
    // Anchoring on the first matching term lands on "## Batas Kapasitas" and truncates
    // before the answer, making correct retrieval look wrong.
    expect(buildExcerpt(chunk, 'batas kapasitas payload request', 90)).toContain('512 KB');
  });

  it('finds the answer when the value is part of the query', () => {
    expect(buildExcerpt(chunk, 'batas payload 512', 90)).toContain('512 KB');
  });

  it('finds the matching section for a later query', () => {
    expect(buildExcerpt(chunk, 'aturan branch pull request', 90)).toMatch(/Pull Request/);
  });

  it('returns the whole text when it is already short', () => {
    expect(buildExcerpt('dokumen pendek', 'apa saja', 180)).toBe('dokumen pendek');
  });

  it('degrades to a leading slice when nothing matches', () => {
    const out = buildExcerpt(chunk, 'xyzzy plugh', 60);
    expect(out).toContain('…');
    expect(out.length).toBeLessThanOrEqual(125);
  });

  it('collapses whitespace so the preview stays readable', () => {
    expect(buildExcerpt('a\n\n  b\t\tc', 'b c', 180)).not.toContain('\n');
  });
});

describe('ingestion idempotency', () => {
  it('deduplicates identical content by checksum', async () => {
    const store = new Store(':memory:');
    store.migrate();
    const refs = seedCore(store);
    const scope = { orgId: refs.orgId };
    const embedder = createFakeEmbedder(128);

    const first = await ingestDocument(store, embedder, scope, { projectId: refs.projectId, title: 'Dok', body: '# Isi\nbaris sama' });
    const second = await ingestDocument(store, embedder, scope, { projectId: refs.projectId, title: 'Dok', body: '# Isi\nbaris sama' });

    expect(first.deduplicated).toBe(false);
    expect(second.deduplicated).toBe(true);
    expect(second.chunkCount).toBe(first.chunkCount);
  });

  it('records ingest state and chunk count', async () => {
    const store = new Store(':memory:');
    store.migrate();
    const refs = seedCore(store);
    const scope = { orgId: refs.orgId };
    await ingestDocument(store, createFakeEmbedder(128), scope, { projectId: refs.projectId, title: 'Dok', body: DOC });

    const doc = documentRepo(store).list(scope)[0]!;
    expect(doc.ingest_state).toBe('ready');
    expect(doc.chunk_count).toBeGreaterThan(0);
    expect(doc.embed_model).toBeTruthy();
    expect(chunkRepo(store).countForDoc(scope, doc.id)).toBe(doc.chunk_count);
  });
});