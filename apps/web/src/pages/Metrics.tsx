import { api } from '../api';
import { useAsync } from '../hooks';

/**
 * KPI and audit (PRD §10).
 *
 * The counters are computed from stored rows, not asserted in prose. The
 * false-completion counter is the one worth reading aloud: it counts COMPLETED tickets
 * with no passing verification, which must be zero.
 */
export function Metrics({ actor }: { actor: string }) {
  const metrics = useAsync(() => api.metrics(actor), [actor]);
  const audit = useAsync(() => api.audit(actor), [actor]);

  if (metrics.error) return <div className="notice err">{metrics.error}</div>;
  if (metrics.loading) return <div className="loading">Memuat…</div>;
  if (!metrics.data) return null;

  const k = metrics.data.kpis;
  const falseCompletion = k['kpi.false_completion_24h'] ?? 0;
  const passRate = k['gate.pass_rate_24h'] ?? 0;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>KPI &amp; Jejak Audit</h1>
          <p>Angka dihitung dari data tersimpan. PRD §10.</p>
        </div>
        <button onClick={() => { void metrics.reload(); void audit.reload(); }}>Muat ulang</button>
      </div>

      <div className="cards" style={{ marginBottom: 12 }}>
        <Stat label="Instruksi diterima" value={k['instructions.received'] ?? 0} />
        <Stat label="Tiket dibuat" value={k['tickets.created'] ?? 0} />
        <Stat label="Disetujui commanding" value={k['approvals.granted'] ?? 0} tone="ok" />
        <Stat label="Lulus verifikasi 24j" value={`${Math.round(passRate * 100)}%`} tone={passRate >= 0.9 ? 'ok' : 'warn'} />
        <Stat label="False completion 24j" value={falseCompletion} tone={falseCompletion === 0 ? 'ok' : 'bad'} />
        <Stat label="Klarifikasi bersumber" value={k['clarifications.grounded'] ?? 0} />
        <Stat label="Klarifikasi tanpa sumber" value={k['clarifications.ungrounded'] ?? 0} />
        <Stat label="Fallback heuristik LLM" value={k['llm.fallback_total'] ?? 0} />
        <Stat label="TTFT terakhir" value={`${k['llm.last_ttft_ms'] ?? 0} ms`} />
        <Stat label="Gatekeeper terakhir" value={`${k['gate.last_latency_ms'] ?? 0} ms`} />
      </div>

      <div className="panel">
        <h2>Status tiket</h2>
        <div className="row tight">
          {Object.entries(metrics.data.ticketStatus).map(([status, n]) => (
            <span key={status} className="chip">{status}: <strong>{n}</strong></span>
          ))}
          {Object.keys(metrics.data.ticketStatus).length === 0 && <span className="muted small">Belum ada tiket.</span>}
        </div>
      </div>

      <div className="panel">
        <h2>Antrean pekerjaan (ADR-5)</h2>
        <div className="row tight">
          {metrics.data.jobs.map((j) => <span key={j.status} className="chip">{j.status}: <strong>{j.n}</strong></span>)}
          {metrics.data.jobs.length === 0 && <span className="muted small">Antrean kosong.</span>}
        </div>
      </div>

      <div className="panel">
        <h2>Provider aktif</h2>
        <div className="row tight">
          {Object.entries(metrics.data.provider).map(([name, v]) => <span key={name} className="chip">{name}: <strong>{v}</strong></span>)}
        </div>
      </div>

      <div className="panel">
        <h2>Jejak audit terbaru</h2>
        {audit.loading && <div className="loading">Memuat…</div>}
        {audit.data && audit.data.length === 0 && <div className="empty small">Belum ada aktivitas.</div>}
        {audit.data && audit.data.length > 0 && (
          <table>
            <thead><tr><th>Waktu</th><th>Aksi</th><th>Entitas</th><th>Detail</th></tr></thead>
            <tbody>
              {audit.data.map((a) => (
                <tr key={a.id}>
                  <td className="muted small mono">{new Date(a.createdAt).toLocaleTimeString()}</td>
                  <td className="mono small">{a.action}</td>
                  <td className="muted small">{a.entity ?? '—'}</td>
                  <td className="small mono" style={{ maxWidth: 380, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {JSON.stringify(a.meta)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

function Stat({ label, value, tone }: { label: string; value: number | string; tone?: string }) {
  return (
    <div className="stat">
      <div className="label">{label}</div>
      <div className={`value ${tone === 'ok' ? 'status-P2' : tone === 'bad' ? 'status-P0' : tone === 'warn' ? 'status-P1' : ''}`}>{value}</div>
    </div>
  );
}