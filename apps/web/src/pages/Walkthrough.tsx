import { useState } from 'react';
import { api } from '../api';
import { useAsync } from '../hooks';

/**
 * Evening walkthrough (FR-06) plus the raw chat rendering, so the judges can see that
 * the Telegram message and this page come from the same aggregation.
 */
export function WalkthroughPage({ actor }: { actor: string }) {
  const [date, setDate] = useState('');
  const report = useAsync(() => api.walkthrough(actor, date || undefined), [actor, date]);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Laporan Harian</h1>
          <p>FR-06 agregasi perubahan status sepanjang hari, dengan tautan bukti artefak.</p>
        </div>
        <div className="row tight">
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={{ width: 'auto' }} />
          {date && <button className="ghost" onClick={() => setDate('')}>Hari ini</button>}
          <button onClick={() => void report.reload()}>Muat ulang</button>
        </div>
      </div>

      {report.error && <div className="notice err">{report.error}</div>}
      {report.loading && <div className="loading">Memuat…</div>}

      {report.data && (
        <>
          <div className="cards" style={{ marginBottom: 12 }}>
            <Stat label="Tuntas terverifikasi" value={report.data.counts.completed} tone="ok" />
            <Stat label="Perlu intervensi" value={report.data.counts.blocked} tone={report.data.counts.blocked ? 'bad' : 'muted'} />
            <Stat label="Masih terbuka" value={report.data.counts.open} />
            <Stat label="Lulus verifikasi" value={`${Math.round(report.data.counts.passRate * 100)}%`} />
          </div>

          <div className="panel">
            <h2>Pratinjau pesan Telegram</h2>
            <pre className="card-text">{report.data.rendered}</pre>
          </div>

          <div className="panel">
            <h2>Tuntas terverifikasi</h2>
            {report.data.completed.length === 0 && <div className="empty small">Belum ada tugas yang lolos verifikasi.</div>}
            {report.data.completed.map((c) => (
              <div key={c.code} className="stack" style={{ paddingBottom: 7, marginBottom: 7, borderBottom: '1px solid var(--border)' }}>
                <div className="row tight">
                  <span className="badge ok">{c.code}</span>
                  <span className="small">{c.title}</span>
                  <span className="muted small">{c.assignee}</span>
                </div>
                {c.evidenceUrls.map((u) => (
                  <a key={u} className="mono small" href={u} target="_blank" rel="noreferrer">{u}</a>
                ))}
              </div>
            ))}
          </div>

          <div className="panel">
            <h2>Tertunda / perlu intervensi</h2>
            {report.data.blocked.length === 0 && <div className="empty small">Tidak ada kendala tercatat.</div>}
            {report.data.blocked.map((b) => (
              <div key={b.code} className="stack" style={{ paddingBottom: 7 }}>
                <div className="row tight">
                  <span className="badge bad">{b.code}</span>
                  <span className="small">{b.title}</span>
                  <span className="muted small">{b.assignee}</span>
                </div>
                <div className="small muted">{b.blocker}</div>
              </div>
            ))}
          </div>

          <div className="panel">
            <h2>Proyeksi prioritas berikutnya</h2>
            {report.data.tomorrow.length === 0 && <div className="empty small">Antrean kosong.</div>}
            {report.data.tomorrow.length > 0 && (
              <table>
                <thead><tr><th>#</th><th>Kode</th><th>Pekerjaan</th><th>Prioritas</th><th>Tenggat</th></tr></thead>
                <tbody>
                  {report.data.tomorrow.map((t, i) => (
                    <tr key={t.code}>
                      <td>{i + 1}</td>
                      <td className="mono">{t.code}</td>
                      <td>{t.title}</td>
                      <td className={`status-${t.priority}`}>{t.priority}</td>
                      <td className="muted small">{t.dueAt ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </>
  );
}

function Stat({ label, value, tone }: { label: string; value: number | string; tone?: string }) {
  return (
    <div className="stat">
      <div className="label">{label}</div>
      <div className={`value ${tone === 'ok' ? 'status-P2' : tone === 'bad' ? 'status-P0' : ''}`}>{value}</div>
    </div>
  );
}