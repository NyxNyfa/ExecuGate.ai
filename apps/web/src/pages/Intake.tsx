import { useState } from 'react';
import { api } from '../api';
import type { Actor, IntakeResult } from '../api';
import { useAction } from '../hooks';

const SAMPLE =
  'Besok pagi deploy payment service ya, sekalian update SOP reconciliation, Mas Budi yang infra, deadline Kamis.';

/**
 * Intake and the approval gate (FR-01 → FR-03).
 *
 * The card is shown exactly as Telegram renders it, because that is the artefact the
 * commander authorises. Approving here and approving there are the same operation.
 */
export function Intake({ actor, role, onNavigate }: {
  actor: string;
  role: Actor['role'];
  onNavigate: () => void;
}) {
  const [text, setText] = useState('');
  const [draft, setDraft] = useState<IntakeResult | null>(null);
  const action = useAction();
  const canApprove = role === 'commander' || role === 'admin';

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Arahan Pimpinan</h1>
          <p>FR-01.3 dekomposisi arahan → FR-03.1 tanpa distribusi otomatis sebelum otorisasi.</p>
        </div>
      </div>

      <div className="panel">
        <h2>Masukkan arahan (teks; suara masuk lewat kanal Telegram)</h2>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Tulis arahan bebas, dalam bahasa sehari-hari…"
        />
        <div className="row tight" style={{ marginTop: 9 }}>
          <button
            className="primary"
            disabled={action.busy || text.trim().length < 8}
            onClick={() => void action.run(async () => {
              const result = await api.intake(actor, text.trim());
              setDraft(result);
              return `${result.ticketIds.length} draf tiket dibuat dalam ${result.timing.totalMs}ms (TTFT ${result.timing.ttftMs}ms).`;
            })}
          >
            Urai jadi Tiket
          </button>
          <button className="ghost" onClick={() => setText(SAMPLE)}>Contoh arahan</button>
          {draft && <button className="ghost" onClick={() => { setDraft(null); setText(''); }}>Bersihkan</button>}
        </div>
      </div>

      {action.result && (
        <div className={`notice ${action.result.kind === 'ok' ? 'ok' : 'err'}`} style={{ marginTop: 10 }}>
          {action.result.text}
        </div>
      )}

      {draft && (
        <>
          <div className="panel">
            <h2>Kartu Otorisasi (FR-03.2)</h2>
            <pre className="card-text">{draft.approvalCard.text}</pre>

            <div className="row tight" style={{ marginTop: 11 }}>
              {canApprove ? (
                <>
                  <button
                    className="primary"
                    disabled={action.busy}
                    onClick={() => void action.run(async () => {
                      const r = await api.decide(actor, draft.instructionId, 'approve');
                      onNavigate();
                      return r.alreadyProcessed
                        ? 'Sudah diproses sebelumnya; tidak ada perubahan tambahan.'
                        : `${r.dispatched.length} tiket didistribusikan${r.skipped.length ? `, ${r.skipped.length} dilewati` : ''}.`;
                    })}
                  >
                    Setujui &amp; Distribusikan
                  </button>
                  <button
                    className="danger"
                    disabled={action.busy}
                    onClick={() => void action.run(async () => {
                      const r = await api.decide(actor, draft.instructionId, 'cancel', { reason: 'Dibatalkan dari Control Center' });
                      onNavigate();
                      return `${r.dispatched.length} tiket dibatalkan, tidak ada yang didistribusikan.`;
                    })}
                  >
                    Batalkan
                  </button>
                </>
              ) : (
                <span className="muted small">
                  Draf menunggu otorisasi commanding officer. Peran Anda: <span className="mono">{role}</span>.
                </span>
              )}
            </div>
          </div>

          <div className="panel">
            <h2>Rincian Draf</h2>
            <table>
              <thead>
                <tr><th>Kode</th><th>Pekerjaan</th><th>Status</th><th>Prioritas</th><th>Tenggat</th></tr>
              </thead>
              <tbody>
                {draft.tickets.map((t) => (
                  <tr key={t.id}>
                    <td className="mono">{t.code}</td>
                    <td>{t.title}</td>
                    <td><span className="badge warn">{t.status}</span></td>
                    <td className={`status-${t.priority}`}>{t.priority}</td>
                    <td className="muted small">{t.dueAt ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="muted small" style={{ marginTop: 8 }}>
              Semua tiket berstatus <span className="mono">PENDING_APPROVAL</span>. Distribusi hanya
              dapat terjadi melalui fungsi persetujuan — tidak ada jalur kode lain.
            </p>
          </div>

          {draft.ambiguities.length > 0 && (
            <div className="panel">
              <h2>Hal yang perlu dikonfirmasi</h2>
              <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
                {draft.ambiguities.map((a, i) => <li key={i}>{a}</li>)}
              </ul>
            </div>
          )}
        </>
      )}
    </>
  );
}