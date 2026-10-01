import { useState } from 'react';
import { api } from '../api';
import type { Actor, Ticket, TicketDetail, TicketStatus } from '../api';
import { useAsync, useAction } from '../hooks';

const COLUMNS: Array<{ status: TicketStatus; label: string }> = [
  { status: 'PENDING_APPROVAL', label: 'Menunggu Otorisasi' },
  { status: 'ASSIGNED', label: 'Didistribusikan' },
  { status: 'IN_PROGRESS', label: 'Dikerjakan' },
  { status: 'QA_VERIFICATION', label: 'Verifikasi' },
  { status: 'REWORK_REQUIRED', label: 'Perlu Diperbaiki' },
  { status: 'COMPLETED', label: 'Selesai' },
];

const STATUS_TONE: Record<string, string> = {
  PENDING_APPROVAL: 'warn',
  ASSIGNED: '',
  IN_PROGRESS: '',
  QA_VERIFICATION: 'pending',
  REWORK_REQUIRED: 'bad',
  COMPLETED: 'ok',
  CANCELLED: 'muted',
  DRAFT: 'muted',
};

export function Board({ actor, role }: { actor: string; role: Actor['role'] }) {
  const [filter, setFilter] = useState<TicketStatus | ''>('');
  const [openId, setOpenId] = useState<string | null>(null);

  const tickets = useAsync(() => api.tickets(actor, filter || undefined), [actor, filter]);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Papan Tiket</h1>
          <p>Status mengikuti mesin state PRD §6. Klik tiket untuk melihat DoD, jejak audit, dan hasil verifikasi.</p>
        </div>
        <div className="row tight">
          <select value={filter} onChange={(e) => setFilter(e.target.value as TicketStatus | '')} style={{ width: 'auto' }}>
            <option value="">Semua status</option>
            {COLUMNS.map((c) => <option key={c.status} value={c.status}>{c.label}</option>)}
            <option value="CANCELLED">Dibatalkan</option>
          </select>
          <button onClick={() => void tickets.reload()}>Muat ulang</button>
        </div>
      </div>

      {tickets.error && <div className="notice err">Gagal memuat tiket: {tickets.error}</div>}
      {tickets.loading && <div className="loading">Memuat…</div>}

      {tickets.data && tickets.data.length === 0 && (
        <div className="panel empty">
          Belum ada tiket. Kirim arahan lewat tab <strong>Arahan Pimpinan</strong>.
        </div>
      )}

      {tickets.data && tickets.data.length > 0 && (
        <div className="panel" style={{ padding: 0 }}>
          <table>
            <thead>
              <tr>
                <th>Kode</th>
                <th>Pekerjaan</th>
                <th>Divisi</th>
                <th>Pelaksana</th>
                <th>Prioritas</th>
                <th>Tenggat</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {tickets.data.map((t) => (
                <tr key={t.id} className="clickable" onClick={() => setOpenId(t.id)}>
                  <td className="mono">{t.code}</td>
                  <td>
                    {t.title}
                    {t.verificationState === 'pending' && (
                      <span className="badge pending" style={{ marginLeft: 7 }}>menunggu verifikasi</span>
                    )}
                  </td>
                  <td className="muted">{t.divisionName ?? '—'}</td>
                  <td>{t.assigneeName ?? <span className="muted">belum ditentukan</span>}</td>
                  <td className={`status-${t.priority}`}>{t.priority}</td>
                  <td className="muted small">{t.dueAt ?? '—'}</td>
                  <td><span className={`badge ${STATUS_TONE[t.status] ?? ''}`}>{t.status}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {openId && <TicketDrawer actor={actor} role={role} id={openId} onClose={() => setOpenId(null)} />}
    </>
  );
}

function TicketDrawer({ actor, role, id, onClose }: { actor: string; role: Actor['role']; id: string; onClose: () => void }) {
  const detail = useAsync(() => api.ticket(actor, id), [actor, id]);
  const action = useAction();

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <div className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <div>
            <h2>{detail.data?.code ?? '…'}</h2>
            <div className="muted small">{detail.data?.title}</div>
          </div>
          <button className="ghost" onClick={onClose}>Tutup</button>
        </div>

        {detail.error && <div className="notice err">{detail.error}</div>}
        {detail.loading && <div className="loading">Memuat…</div>}

        {detail.data && (
          <>
            <div className="row tight" style={{ marginBottom: 12 }}>
              <span className={`badge ${STATUS_TONE[detail.data.status] ?? ''}`}>{detail.data.status}</span>
              <span className={`status-${detail.data.priority}`}>{detail.data.priority}</span>
              <span className="muted small">{detail.data.divisionName}</span>
              <span className="muted small">{detail.data.assigneeName ?? 'tanpa pelaksana'}</span>
              {detail.data.dueAt && <span className="muted small">tenggat {detail.data.dueAt}</span>}
            </div>

            <div className="panel">
              <h2>Deskripsi</h2>
              <p className="small">{detail.data.description}</p>
            </div>

            <div className="panel">
              <h2>Kriteria Selesai (Definition of Done)</h2>
              {detail.data.dod.map((d) => (
                <div key={d.id} className="row tight" style={{ padding: '3px 0' }}>
                  <span className="badge muted">{d.check.type}</span>
                  <span className="grow small">{d.label}</span>
                  {!d.required && <span className="badge muted">opsional</span>}
                </div>
              ))}
              {detail.data.dod.length === 0 && <div className="empty small">Tidak ada kriteria.</div>}
            </div>

            <ActionBar actor={actor} detail={detail.data} role={role} action={action} onDone={() => void detail.reload()} />

            {action.result && (
              <div className={`notice ${action.result.kind === 'ok' ? 'ok' : 'err'}`} style={{ marginTop: 10 }}>
                <pre className="card-text" style={{ maxHeight: 220, border: 'none', background: 'transparent', padding: 0 }}>
                  {action.result.text}
                </pre>
              </div>
            )}

            <div className="panel">
              <h2>Hasil Verifikasi (FR-05)</h2>
              {detail.data.verifications.length === 0 && <div className="empty small">Belum ada verifikasi.</div>}
              {detail.data.verifications.map((v) => (
                <div key={v.id} className="stack" style={{ paddingBottom: 9, marginBottom: 9, borderBottom: '1px solid var(--border)' }}>
                  <div className="row tight">
                    <span className={`badge ${v.verdict === 'pass' ? 'ok' : v.verdict === 'fail' ? 'bad' : 'pending'}`}>{v.verdict}</span>
                    <span className="muted small">{v.provider} · {v.lane} · {v.latencyMs}ms</span>
                    <span className="muted small">{new Date(v.createdAt).toLocaleString()}</span>
                  </div>
                  {v.outcomes.map((o, i) => (
                    <div key={i} className="small">
                      <span className={`badge ${o.ok ? 'ok' : o.unverifiable ? 'pending' : 'bad'}`}>
                        {o.ok ? 'lolos' : o.unverifiable ? 'tak terverifikasi' : 'gagal'}
                      </span>{' '}
                      {o.detail}
                      {o.evidenceUrl && (
                        <div><a className="mono" href={o.evidenceUrl} target="_blank" rel="noreferrer">{o.evidenceUrl}</a></div>
                      )}
                    </div>
                  ))}
                </div>
              ))}
            </div>

            {detail.data.thread.length > 0 && (
              <div className="panel">
                <h2>Klarifikasi Staf (FR-04)</h2>
                {detail.data.thread.map((t, i) => (
                  <div key={i} style={{ paddingBottom: 8 }}>
                    <div className="small"><strong>Tanya:</strong> {t.question}</div>
                    <div className="small"><strong>Jawab:</strong> {t.answer}</div>
                    <span className={`badge ${t.grounded ? 'ok' : 'warn'}`}>
                      {t.grounded ? 'bersumber dari memori' : 'tidak bersumber'}
                    </span>
                  </div>
                ))}
              </div>
            )}

            <div className="panel">
              <h2>Jejak Audit (PRD §6)</h2>
              <div className="timeline">
                {detail.data.events.map((e) => (
                  <div key={e.id} className="tl-item">
                    <div className={`tl-dot ${e.toStatus === 'COMPLETED' ? 'pass' : e.toStatus === 'REWORK_REQUIRED' ? 'fail' : ''}`} />
                    <div>
                      <div className="tl-title">{e.fromStatus ? `${e.fromStatus} → ` : ''}{e.toStatus}</div>
                      <div className="tl-meta">{e.reason}</div>
                      <div className="tl-meta">{new Date(e.createdAt).toLocaleString()}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Actions are gated by role here for usability only. The server re-authorises every
 * one of them, so hiding a button is a convenience, never the control.
 */
function ActionBar({ actor, detail, role, action, onDone }: {
  actor: string;
  detail: TicketDetail;
  role: Actor['role'];
  action: ReturnType<typeof useAction>;
  onDone: () => void;
}) {
  const [question, setQuestion] = useState('');
  const [reason, setReason] = useState('');
  const [evidenceUrl, setEvidenceUrl] = useState('');

  // Mirrors the server's RBAC matrix.
  const isStaff = role === 'technical' || role === 'ops' || role === 'admin';
  const canOverride = role === 'commander' || role === 'admin';

  return (
    <div className="panel">
      <h2>Aksi</h2>
      <div className="row tight">
        {detail.status === 'ASSIGNED' && isStaff && (
          <button disabled={action.busy} onClick={() => void action.run(async () => {
            const t = await api.ack(actor, detail.id);
            onDone();
            return `${t.code} dimulai.`;
          })}>Terima &amp; Mulai</button>
        )}

        {detail.status === 'IN_PROGRESS' && isStaff && (
          <>
            <input
              className="grow"
              placeholder="Tautan bukti (opsional) — mis. URL Pull Request"
              value={evidenceUrl}
              onChange={(e) => setEvidenceUrl(e.target.value)}
            />
            <button className="primary" disabled={action.busy} onClick={() => void action.run(async () => {
              const url = evidenceUrl.trim();
              const t = await api.submitEvidence(actor, detail.id, url || undefined, 'Dilaporkan selesai dari Control Center');
              setEvidenceUrl('');
              onDone();
              return `${t.code} -> QA_VERIFICATION. Gatekeeper akan memverifikasi otomatis.`;
            })}>Lapor Selesai</button>
          </>
        )}

        {detail.status === 'REWORK_REQUIRED' && isStaff && (
          <>
            <input
              className="grow"
              placeholder="Catatan perbaikan (opsional)"
              value={evidenceUrl}
              onChange={(e) => setEvidenceUrl(e.target.value)}
            />
            <button className="primary" disabled={action.busy} onClick={() => void action.run(async () => {
              const t = await api.resubmit(actor, detail.id, evidenceUrl.trim() || 'Diperbaiki');
              setEvidenceUrl('');
              onDone();
              return `${t.code} -> IN_PROGRESS. Laporkan selesai lagi setelah perbaikan.`;
            })}>Kirim Ulang</button>
          </>
        )}

        {detail.status === 'QA_VERIFICATION' && isStaff && (
          <button className="primary" disabled={action.busy} onClick={() => void action.run(async () => {
            const r = await api.verify(actor, detail.id);
            onDone();
            return `${r.verdict.toUpperCase()}\n\n${r.staffMessage}`;
          })}>Jalankan Gatekeeper</button>
        )}

        {detail.status === 'QA_VERIFICATION' && !isStaff && (
          <span className="muted small">
            Menunggu staf melaporkan selesai. Verifikasi berjalan otomatis.
          </span>
        )}

        {detail.status === 'PENDING_APPROVAL' && (
          <span className="muted small">Menunggu otorisasi commanding officer.</span>
        )}
      </div>

      <div className="stack" style={{ marginTop: 11 }}>
        <div className="row tight">
          <input
            className="grow"
            placeholder="Tanya konteks ke memori proyek…"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
          />
          <button disabled={action.busy || question.trim().length < 4} onClick={() => void action.run(async () => {
            const r = await api.clarify(actor, detail.id, question.trim());
            setQuestion('');
            onDone();
            const cites = r.citations.map((c, i) => `[${i + 1}] ${c.docTitle} bagian ${c.ordinal + 1}`).join('\n');
            return cites ? `${r.answer}\n\n${cites}` : r.answer;
          })}>Tanya</button>
        </div>

        <details>
          <summary className="muted small" style={{ cursor: 'pointer' }}>Verifikasi manual (DEV-4, commanding officer)</summary>
          {canOverride ? (
            <>
              <div className="row tight" style={{ marginTop: 8 }}>
                <input
                  className="grow"
                  placeholder="Alasan wajib diisi dan tercatat di audit…"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
                <button className="danger" disabled={action.busy || reason.trim().length < 5} onClick={() => void action.run(async () => {
                  const t = await api.manualVerification(actor, detail.id, true, reason.trim());
                  setReason('');
                  onDone();
                  return `${t.code} diselesaikan lewat verifikasi manual.`;
                })}>Setujui Manual</button>
              </div>
              <p className="muted small">
                Jalur ini hanya untuk ketika sistem eksternal tidak dapat diverifikasi setelah
                seluruh percobaan otomatis gagal. Setiap penggunaan dicatat atas nama Anda.
              </p>
            </>
          ) : (
            <p className="muted small" style={{ marginTop: 8 }}>
              Hanya commanding officer atau administrator yang dapat melakukan verifikasi manual.
              Peran Anda: <span className="mono">{role}</span>.
            </p>
          )}
        </details>
      </div>
    </div>
  );
}