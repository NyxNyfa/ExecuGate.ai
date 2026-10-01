import { useState } from 'react';
import { api } from '../api';
import type { Actor } from '../api';
import { useAsync, useAction } from '../hooks';

/**
 * Institutional project memory (FR-02): upload canonical documents, and search the
 * hybrid index showing which retriever matched. `matchedBy` is displayed because the
 * point of the hybrid design is that identifier-style queries are caught lexically and
 * paraphrases semantically — both happen, visibly.
 */
export function Documents({ actor, role }: { actor: string; role: Actor['role'] }) {
  const docs = useAsync(() => api.documents(actor), [actor]);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<Awaited<ReturnType<typeof api.search>> | null>(null);
  const upload = useAction();
  const search = useAction();
  const canUpload = role === 'admin' || role === 'commander';

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Memori Proyek</h1>
          <p>FR-02 dokumen acuan kanonik. Retrieved chunks di-inject ke penalaran sebagai konteks bersumber.</p>
        </div>
      </div>

      <div className="panel">
        <h2>Cari dalam memori (hybrid: vektor + leksikal)</h2>
        <div className="row tight">
          <input
            className="grow"
            placeholder="mis. batas payload request, criteria rekonsiliasi…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button disabled={search.busy || query.trim().length < 3} onClick={() => void search.run(async () => {
            const r = await api.search(actor, query.trim());
            setHits(r);
            return `${r.chunks.length} chunk ditemukan (vektor ${r.retrievers.vector}, leksikal ${r.retrievers.fts}).`;
          })}>Cari</button>
        </div>

        {search.result && (
          <div className={`notice ${search.result.kind === 'ok' ? 'ok' : 'err'}`} style={{ marginTop: 9 }}>{search.result.text}</div>
        )}

        {hits && hits.chunks.length === 0 && (
          <div className="empty small">Tidak ada chunk yang cocok. Memori proyek mungkin belum terisi.</div>
        )}

        {hits && hits.chunks.length > 0 && (
          <div className="stack" style={{ marginTop: 11 }}>
            {hits.chunks.map((c, i) => (
              <div key={i} style={{ borderBottom: '1px solid var(--border)', paddingBottom: 8 }}>
                <div className="row tight">
                  <span className="chip">{c.matchedBy}</span>
                  <span className="small">{c.docTitle} — bagian {c.ordinal + 1}</span>
                  <span className="muted small mono">score {c.score.toFixed(4)}</span>
                </div>
                <div className="small muted" style={{ whiteSpace: 'pre-wrap', marginTop: 3 }}>{c.excerpt}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="panel">
        <h2>Dokumen</h2>
        {docs.error && <div className="notice err">{docs.error}</div>}
        {docs.loading && <div className="loading">Memuat…</div>}
        {docs.data && docs.data.length === 0 && (
          <div className="empty small">Belum ada dokumen. Jalankan <span className="mono">npm run seed</span>.</div>
        )}
        {docs.data && docs.data.length > 0 && (
          <table>
            <thead>
              <tr><th>Judul</th><th>Status</th><th>Chunk</th><th>Model</th><th>Ukuran</th></tr>
            </thead>
            <tbody>
              {docs.data.map((d) => (
                <tr key={d.id}>
                  <td>{d.title}</td>
                  <td><span className={`badge ${d.state === 'ready' ? 'ok' : d.state === 'failed' ? 'bad' : 'warn'}`}>{d.state}</span></td>
                  <td>{d.chunks}</td>
                  <td className="muted small mono">{d.embedModel ?? '—'}</td>
                  <td className="muted small">{d.size} B</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="panel">
        <h2>Unggah dokumen acuan</h2>
        {canUpload ? (
          <>
            <input
              placeholder="Judul dokumen"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              style={{ marginBottom: 8 }}
            />
            <textarea
              placeholder="Isi dokumen (Markdown)…"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              style={{ minHeight: 130 }}
            />
            <div className="row tight" style={{ marginTop: 9 }}>
              <button
                className="primary"
                disabled={upload.busy || title.trim().length < 3 || body.trim().length < 10}
                onClick={() => void upload.run(async () => {
                  const r = await api.uploadDocument(actor, title.trim(), body);
                  setTitle(''); setBody('');
                  await docs.reload();
                  return r.deduplicated
                    ? `Dokumen sudah ada (${r.chunkCount} chunk). Ingest bersifat idempoten.`
                    : `${r.chunkCount} chunk dibuat.`;
                })}
              >
                Unggah &amp; Indeks
              </button>
            </div>
            {upload.result && (
              <div className={`notice ${upload.result.kind === 'ok' ? 'ok' : 'err'}`} style={{ marginTop: 9 }}>{upload.result.text}</div>
            )}
          </>
        ) : (
          <p className="muted small">
            Hanya commanding officer atau administrator yang dapat mengunggah dokumen.
            Peran Anda: <span className="mono">{role}</span>.
          </p>
        )}
      </div>
    </>
  );
}