import { useEffect, useState } from 'react';
import { api } from './api';
import type { Actor, RosterMember } from './api';
import { useAsync } from './hooks';
import { Board } from './pages/Board';
import { Intake } from './pages/Intake';
import { Documents } from './pages/Documents';
import { Metrics } from './pages/Metrics';
import { WalkthroughPage } from './pages/Walkthrough';

type Tab = 'board' | 'intake' | 'documents' | 'walkthrough' | 'metrics';

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'board', label: 'Papan Tiket' },
  { id: 'intake', label: 'Arahan Pimpinan' },
  { id: 'documents', label: 'Memori Proyek' },
  { id: 'walkthrough', label: 'Laporan Harian' },
  { id: 'metrics', label: 'KPI & Audit' },
];

const ROLE_LABEL: Record<Actor['role'], string> = {
  commander: 'Pimpinan',
  technical: 'Tim Teknis',
  ops: 'Tim Operasional',
  admin: 'Administrator',
};

const STORAGE_KEY = 'execugate.actor';

export function App() {
  const [tab, setTab] = useState<Tab>('board');
  const [actorId, setActorId] = useState(() => localStorage.getItem(STORAGE_KEY) ?? '');
  const [roster, setRoster] = useState<RosterMember[]>([]);
  const [me, setMe] = useState<Actor | null>(null);

  const health = useAsync(() => api.health(), []);
  const runtime = useAsync(() => api.ready(), []);

  // Roster loads without an actor header, so the "act as" switcher can be populated
  // before anyone is selected.
  useEffect(() => {
    api.roster().then(setRoster).catch(() => setRoster([]));
  }, []);

  // Identity is fetched before any page is rendered, so a child component can never
  // issue a request with no actor.
  const identity = useAsync(
    () => (actorId ? api.me(actorId) : Promise.resolve(null)),
    [actorId],
  );

  useEffect(() => {
    setMe(identity.data as Actor | null);
  }, [identity.data]);

  useEffect(() => {
    if (actorId) localStorage.setItem(STORAGE_KEY, actorId);
    else localStorage.removeItem(STORAGE_KEY);
  }, [actorId]);

  const degraded = runtime.data?.status === 'degraded';
  const ready = Boolean(actorId && me);

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          ExecuGate.ai
          <small>Control Center</small>
        </div>

        {TABS.map((t) => (
          <button
            key={t.id}
            className={`nav-item ${tab === t.id ? 'active' : ''}`}
            onClick={() => setTab(t.id)}
            disabled={!ready}
          >
            {t.label}
          </button>
        ))}

        <div className="sidebar-foot">
          <label className="small muted" htmlFor="actor">Bertindak sebagai</label>
          <select id="actor" value={actorId} onChange={(e) => setActorId(e.target.value)}>
            <option value="">— pilih akun —</option>
            {roster.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name} · {ROLE_LABEL[r.role]}
              </option>
            ))}
          </select>
          {me && (
            <div className="small">
              {me.name}<br />
              <span className="muted">{ROLE_LABEL[me.role]} · {me.org}</span>
            </div>
          )}

          <div className="row tight" style={{ marginTop: 6 }}>
            <span className={`badge ${health.data ? 'ok' : 'muted'}`}>{health.data ? 'API ok' : 'API?'}</span>
            <span className={`badge ${degraded ? 'warn' : runtime.data ? 'ok' : 'muted'}`}>
              {runtime.data?.status ?? '...'}
            </span>
          </div>
        </div>
      </aside>

      <main className="main">
        {!ready ? (
          <div className="panel">
            <h2>Pilih akun terlebih dahulu</h2>
            <p className="muted small">
              Dashboard ini tidak memiliki sesi login sendiri. Server yang menentukan siapa
              yang berwenang, jadi pilih akun yang mewakili Anda — setiap aksi akan dicatat
              atas nama tersebut pada jejak audit.
            </p>
            {identity.loading && actorId && <div className="loading">Memuat identitas…</div>}
            {identity.error && <div className="notice err">{identity.error}</div>}
            {roster.length === 0 && !identity.loading && (
              <p className="muted small">
                Belum ada personel. Jalankan <span className="mono">npm run setup</span>.
              </p>
            )}
          </div>
        ) : tab === 'board' ? (
          <Board actor={actorId} role={me!.role} />
        ) : tab === 'intake' ? (
          <Intake actor={actorId} role={me!.role} onNavigate={() => setTab('board')} />
        ) : tab === 'documents' ? (
          <Documents actor={actorId} role={me!.role} />
        ) : tab === 'walkthrough' ? (
          <WalkthroughPage actor={actorId} />
        ) : (
          <Metrics actor={actorId} />
        )}
      </main>
    </div>
  );
}