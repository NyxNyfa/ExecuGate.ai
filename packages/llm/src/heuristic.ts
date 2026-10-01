import type { ParsedTask } from './types.ts';
import type { DivisionKind, Priority } from '@execugate/core';

export interface RosterMember {
  name: string;
  role: 'commander' | 'technical' | 'ops' | 'admin';
  division: DivisionKind;
  specializations: string[];
}

export interface HeuristicContext {
  roster: RosterMember[];
  /** Default repository used when the instruction does not name one. */
  defaultRepo: string;
  /** Operational source of truth identifier for reconciliation checks. */
  opsSource: string;
  now: Date;
}

// ─── Lexicons ────────────────────────────────────────────────────────────────

const TECHNICAL_TERMS = [
  'deploy', 'deployment', 'rilis', 'release', 'code', 'kode', 'api', 'endpoint', 'service',
  'servis', 'repo', 'repository', 'branch', 'cabang', 'pull request', 'pr ', 'merge', 'bug',
  'perbaiki', 'fix', 'patch', 'infra', 'infrastruktur', 'server', 'database', 'db', 'script',
  'test', 'testing', 'ci', 'cd', 'pipeline', 'komponen', 'modul', 'aplikasi', 'backend',
  'frontend', 'konfigurasi', 'container', 'docker', 'kubernetes', 'k8s', 'library', 'library',
  'query', 'endpoint', 'refactor', 'integrasi', 'antarmuka', 'kode', 'patching', 'rollback',
];

const OPERATIONAL_TERMS = [
  'sop', 'dokumen', 'document', 'dokumentasi', 'laporan', 'report', 'formulir', 'form',
  'inventaris', 'inventory', 'stok', 'stock', 'gudang', 'warehouse', 'data entry', 'entri data',
  'arsip', 'archive', 'rekonsiliasi', 'reconciliation', 'reconcile', 'settle', 'settlement',
  'kepatuhan', 'compliance', 'pajak', 'tax', 'surat', 'faktur', 'invoice', 'nota', 'kwitansi',
  'absensi', 'cuti', 'izin', 'legalisasi', 'ttd', 'stempel', 'ledger', 'keuangan', 'finance',
  'sengketa', 'komplain', 'pengaduan', 'retur', 'pengiriman', 'kirim', 'barang', 'mutasi',
  // Operational vocabulary that is easy to miss and otherwise classifies as technical.
  'logistik', 'pemasok', 'supplier', 'purchase', 'pembelian', 'pengadaan',
  'keuangan', 'biaya', 'budget', 'anggaran', 'catatan', 'pengadaan',
];

const P0_TERMS = ['urgent', 'darurat', 'kritis', 'critical', 'asap', 'p0', 'blokir', 'blocker', 'segera', 'gawat', 'produksi mati', 'down'];
const P2_TERMS = ['p2', 'rendah', 'low', 'kapan-kapan', 'santai', 'nanti', 'jika sempat'];

const ACTION_TERMS = [
  'deploy', 'rilis', 'release', 'buat', 'bikin', 'buatkan', 'buatlah', 'update', 'perbarui',
  'tambah', 'hapus', 'fix', 'perbaiki', 'patch', 'review', 'cek', 'periksa', 'uji', 'test',
  'rekap', 'laporkan', 'kirim', 'install', 'merge', 'pull', 'isi', 'entri', 'catat', 'cocokkan',
  'verifikasi', 'audit', 'sip', 'jalan', 'eksekusi', 'kerjakan', 'tangani', 'telusuri',
  // Maintenance verbs. Without these a clause like "Refactor modul refund biar lebih
  // rapi" carries no recognised action and is discarded as a mere modifier.
  'refactor', 'rapikan', 'optimasi', 'setting', 'atur', 'bikinin',
  'bangun', 'siapkan', 'siapin', 'bikin', 'modify', 'ubah', 'revisi', 'perbaiki',
  'lakukan', 'kerjakan', 'telusuri', 'susun', 'siapkan', 'bikin', 'kerjakan',
];

/**
 * A clause with no action verb is a qualifier, not a unit of work:
 * "Mas Budi yang infra", "deadline Kamis", "P0". Without this guard the global
 * assignee fallback would silently promote each of them into its own ticket.
 */
function isActionClause(clause: string): boolean {
  return containsAny(clause.toLowerCase(), ACTION_TERMS).length > 0;
}

const CONNECTORS = [
  'sekalian', 'serta', 'kemudian', 'selain itu', 'lalu', 'setelah itu', 'dan juga',
  'ditambah', 'bahkan', 'pula', 'masih', 'terus', 'sambungan',
];

const WEEKDAYS: Record<string, number> = {
  senin: 1, selasa: 2, rabu: 3, kamis: 4, jumat: 5, "jum'at": 5, sabtu: 6, minggu: 0, ahad: 0,
};

const STOPWORDS = new Set([
  'yang', 'untuk', 'dengan', 'dari', 'pada', 'dan', 'atau', 'itu', 'ini', 'agar', 'supaya',
  'sudah', 'tolong', 'tolong', 'mohon', 'silakan', 'ya', 'yaa', 'yuk', 'dong', 'sih', 'kok',
  'besok', 'hari', 'pagi', 'sore', 'malam', 'ya', 'oke', 'ok', 'sip', 'makasih', 'terima',
  'kasih', 'sebentar', 'sedikit', 'banget', 'agak', 'sudah', 'masih', 'saja', 'aja', 'nih',
]);

// ─── Helpers ─────────────────────────────────────────────────────────────────

function containsAny(haystack: string, terms: string[]): string[] {
  return terms.filter((t) => haystack.includes(t));
}

function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Clause splitting for free-form Indonesian instructions.
 *
 * Two passes, because real instructions hide two different kinds of structure:
 *  1. Conjunctions  — "sekalian", "lalu", "kemudian" join two *pieces of work*.
 *  2. Modifiers    — "Mas Budi yang infra, deadline Kamis." is a *qualifier* for the
 *     work, not work in itself. Without this pass it glues onto the preceding clause
 *     and corrupts both its title and its assignee.
 */
export function splitClauses(text: string): string[] {
  let working = text.replace(/\s+/g, ' ').trim();

  for (const c of CONNECTORS) {
    working = working.replace(new RegExp(`(?:^|\\s)${c}\\s+`, 'gi'), ' | ');
  }

  // "dan" is a weak connective, so only split when the tail is itself recognisable work.
  working = working.replace(/\s+dan\s+(?=[^|]*\b(?:deploy|fix|perbaiki|patch|bug|buat|update|tambah|hapus|report|laporan|review|cek|uji|test|sop|dokumen|stok|inventaris|rekap|reconcile|rekonsiliasi|install|rilis|merge|kirim)\b)/gi, ' | ');
  working = working.replace(/[.;]\s+/g, ' | ');

  // Modifier pass: a comma introduces a qualifier when the tail names a person or a deadline.
  const HONORIFIC = '(?:mas|pak|bu|mba|mbak|bapak|ibu)';
  working = working.replace(new RegExp(`,\\s*(?=${HONORIFIC}\\s+\\w+)`, 'gi'), ' | ');
  working = working.replace(/,\s*(?=(?:deadline|tenggat|ddl|due|batas waktu|batas akhir|selesai sebelum)\b)/gi, ' | ');
  // "Sari tolong cek ..." appearing as a new subject after a comma.
  working = working.replace(/,\s*(?=[A-Z][a-z]{2,}\s+(?:tolong|mohon|please|bisa|tolong)\b)/g, ' | ');
  // A name-only trailing fragment: "..., Budi infra, ..."
  working = working.replace(/,\s*(?=\w+(?:\s+\w+)?\s+(?:yang|infra|backend|frontend|ops|qa)\b)/gi, ' | ');

  return working
    .split('|')
    .map((s) => s.replace(/^[\s,;:.-]+|[\s,;:.-]+$/g, '').trim())
    .filter((s) => s.length >= 4);
}

export function detectDivision(clause: string): DivisionKind | null {
  const tech = containsAny(clause, TECHNICAL_TERMS);
  const ops = containsAny(clause, OPERATIONAL_TERMS);
  if (tech.length === 0 && ops.length === 0) return null;
  if (tech.length === 0) return 'operational';
  if (ops.length === 0) return 'technical';
  // Tie-break on the earlier-mentioned domain in the sentence.
  const techIdx = Math.min(...tech.map((t) => clause.indexOf(t)));
  const opsIdx = Math.min(...ops.map((t) => clause.indexOf(t)));
  return techIdx <= opsIdx ? 'technical' : 'operational';
}

/** Matches a roster name, tolerating honorifics and first-name-only references. */
export function detectAssignee(clause: string, roster: RosterMember[]): RosterMember | null {
  const lower = clause.toLowerCase();
  for (const m of roster) {
    const full = m.name.toLowerCase();
    if (lower.includes(full)) return m;

    const parts = full.split(' ');
    const given = parts[0]!;
    const family = parts[parts.length - 1]!;
    // "Mas Budi", "Budi", "Pak Budi Santoso"
    if (new RegExp(`\\b(?:mas|pak|bu|mba|mbak|dr)\\s+${given}\\b`).test(lower)) return m;
    if (new RegExp(`\\b${given}\\s+${family}\\b`).test(lower)) return m;
  }

  // Bare given name with no honorific ("Sari tolong cek stok"): only accept it when
  // it is unambiguous across the roster, otherwise "Budi" could match two people.
  const bare = roster.filter((m) => new RegExp(`\\b${m.name.toLowerCase().split(' ')[0]!}\\b`).test(lower));
  return bare.length === 1 ? bare[0]! : null;
}

export function detectDueDate(clause: string, now: Date): string | null {
  const lower = clause.toLowerCase();
  const base = new Date(now);

  const explicit = lower.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (explicit) return `${explicit[1]}-${explicit[2]}-${explicit[3]}`;

  const dmy = lower.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
  if (dmy) {
    const d = dmy[1]!.padStart(2, '0');
    const m = dmy[2]!.padStart(2, '0');
    return `${dmy[3]}-${m}-${d}`;
  }

  if (/\b(?:besok|esok)\b/.test(lower)) {
    base.setDate(base.getDate() + 1);
    return isoDate(base);
  }
  if (/\b(?:hari ini|malam ini|sekarang)\b/.test(lower)) return isoDate(base);

  const inDays = lower.match(/\b(?:dalam|selama)\s+(\d{1,3})\s*hari\b/) ?? lower.match(/\b(\d{1,3})\s*hari\s+(?:lagi|kemudian)\b/);
  if (inDays) {
    base.setDate(base.getDate() + Number(inDays[1]));
    return isoDate(base);
  }
  if (/\bminggu depan\b/.test(lower)) {
    base.setDate(base.getDate() + 7);
    return isoDate(base);
  }

  for (const [day, target] of Object.entries(WEEKDAYS)) {
    if (!new RegExp(`\\b${day.replace("'", "\\'")}\\b`).test(lower)) continue;
    const delta = (target - base.getDay() + 7) % 7 || 7;
    base.setDate(base.getDate() + delta);
    return isoDate(base);
  }
  return null;
}

export function detectPriority(clause: string): Priority {
  const lower = clause.toLowerCase();
  if (containsAny(lower, P0_TERMS).length) return 'P0';
  if (containsAny(lower, P2_TERMS).length) return 'P2';
  return 'P1';
}

/**
 * Extracts a human-readable title.
 *
 * Stopwords are only stripped from non-final positions: dropping a trailing "ini"
 * turns "laporan keuangan bulan ini" into the meaningless "laporan keuangan bulan".
 */
export function deriveTitle(clause: string, maxWords = 9): string {
  // Drop a leading vocative ("Rina, tolong ...") but keep the work that follows it.
  // Cutting at the first comma outright would title this task "Rina", which is both
  // useless to the commander and unmatchable by any sensible expectation.
  let s = clause.replace(/^[^,;]{0,40},\s*(?=(?:tolong|mohon|silakan|please|bisa)\b)/i, '');
  s = s
    .split(/[,;]/)[0]!
    .replace(/\b(?:mas|pak|bu|mba|mbak|tolong|mohon|silakan|yuk|dong|sih|kok|ya|yaa|oke|ok|sip)\b/gi, ' ')
    .replace(/^(?:tolong|mohon|silakan|bisakah|bolehkah|boleh|tolong)\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim();

  const all = s.split(' ').filter(Boolean);
  const kept = all
    .map((w, i) => (i === all.length - 1 || !STOPWORDS.has(w.toLowerCase()) ? w : null))
    .filter((w): w is string => w !== null);

  const words = kept.length ? kept : all;
  const picked = words.slice(0, maxWords).join(' ').trim();
  if (!picked) return clause.trim().slice(0, 80);

  const capitalized = picked
    .split(' ')
    .map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(' ');
  return capitalized.charAt(0).toUpperCase() + capitalized.slice(1);
}

export function deriveBranch(title: string): string {
  const lower = title.toLowerCase();
  const isBug = /\b(bug|fix|perbaiki|patch|regresi|error)\b/.test(lower);
  const isOps = /\b(sop|dokumen|laporan|formulir|inventaris|rekonsiliasi|stok)\b/.test(lower);
  const prefix = isBug ? 'fix' : isOps ? 'chore' : 'feat';
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6)
    .join('-');
  return `${prefix}/${slug || 'perubahan'}`;
}

/**
 * Builds the Definition of Done for a clause.
 *
 * The important invariant from FR-05: every engineering task gets a
 * machine-executable `github_pr` check. Without one the gatekeeper would have no
 * objective way to verify code work, which is the whole point of the product.
 */
export function buildDod(clause: string, division: DivisionKind, title: string, ctx: HeuristicContext): ParsedTask['dod'] {
  const lower = clause.toLowerCase();
  const dod: ParsedTask['dod'] = [];

  if (division === 'technical') {
    const repoMatch = lower.match(/\b([a-z0-9_.-]+\/[a-z0-9_.-]+)\b/);
    const repo = repoMatch?.[1] ?? ctx.defaultRepo;
    dod.push({
      kind: 'engineering',
      label: `Pull Request pada ${repo} sudah ter-merge`,
      required: true,
      check: { type: 'github_pr', repo, branch: deriveBranch(title), requireMerged: true, requireCiGreen: true, requireNoConflicts: true },
    });
    dod.push({
      kind: 'engineering',
      label: 'Seluruh CI check wajib hijau (lint, unit-test, integration-test, security-scan, build-image)',
      required: true,
      check: { type: 'github_pr', repo, branch: deriveBranch(title), requireMerged: false, requireCiGreen: true, requireNoConflicts: false },
    });
  }

  if (/rekonsiliasi|reconcil|settle/.test(lower)) {
    dod.push({
      kind: 'reconciliation',
      label: 'Nilai total_amount, transaction_count, dan settlement_count cocok dengan sumber settle',
      required: true,
      check: { type: 'reconciliation', source: ctx.opsSource, key: 'date', expectedField: 'transaction_count', actualField: 'settlement_count', tolerance: 0.01 },
    });
    dod.push({
      kind: 'document',
      label: 'Berkas output rekonsiliasi (.csv) telah diunggah dan tidak kosong',
      required: true,
      check: { type: 'document_present', minBytes: 1 },
    });
  }

  if (/sop|dokumen|dokumentasi|laporan|formulir|arsip/.test(lower)) {
    dod.push({
      kind: 'document',
      label: 'Dokumen telah diperbarui dan diunggah ke repositori dokumen perusahaan',
      required: true,
      check: { type: 'document_present', minBytes: 1 },
    });
    dod.push({
      kind: 'review',
      label: 'Disetujui oleh commanding officer sebagai dokumen acuan baku',
      required: true,
      check: { type: 'manual_review', reviewerRole: 'commander' },
    });
  }

  if (division === 'operational' && dod.length === 0) {
    dod.push({
      kind: 'document',
      label: 'Berkas administrative wajib telah diunggah',
      required: true,
      check: { type: 'document_present', minBytes: 1 },
    });
  }

  if (division === 'technical' && dod.length === 0) {
    dod.push({
      kind: 'engineering',
      label: 'Perubahan telah ter-merge dan seluruh CI check hijau',
      required: true,
      check: { type: 'github_pr', repo: ctx.defaultRepo, branch: deriveBranch(title), requireMerged: true, requireCiGreen: true, requireNoConflicts: true },
    });
  }

  if (dod.length === 0) {
    dod.push({
      kind: 'document',
      label: 'Bukti hasil kerja telah dilampirkan pada tiket',
      required: true,
      check: { type: 'document_present', minBytes: 1 },
    });
  }
  return dod;
}

/**
 * Deterministic offline decomposition.
 *
 * This is the `fake` provider (so CI and this build machine can run the whole
 * system with no keys) and the fallback when a real model's output fails
 * validation. It is also the baseline the PRD §10.2 ticket-accuracy eval compares
 * against.
 */
export function heuristicParse(instruction: string, ctx: HeuristicContext): ParsedTask[] {
  const clauses = splitClauses(instruction);

  // Trailing "Mas Budi yang infra, deadline Kamis" style modifiers attach to the task.
  const modifierText = clauses.join(' ');
  const globalAssignee = detectAssignee(modifierText, ctx.roster);
  const globalDue = detectDueDate(modifierText, ctx.now);

  const tasks: ParsedTask[] = [];
  for (const clause of clauses) {
    if (!isActionClause(clause)) continue;
    const detected = detectDivision(clause) ?? (globalAssignee && globalAssignee.division !== 'management' ? globalAssignee.division : null);
    if (!detected || detected === 'management') continue;
    const division: 'technical' | 'operational' = detected;

    const title = deriveTitle(clause);
    if (tasks.some((t) => t.title.toLowerCase() === title.toLowerCase())) continue;

    const assignee = detectAssignee(clause, ctx.roster) ?? (globalAssignee?.division === division ? globalAssignee : null);

    tasks.push({
      title,
      description: clause,
      division,
      assigneeHint: assignee?.name ?? null,
      priority: detectPriority(clause),
      dueAt: detectDueDate(clause, ctx.now) ?? globalDue,
      dod: buildDod(clause, division, title, ctx),
    });
  }

  return tasks;
}

/** Ambiguities worth surfacing on the approval card (FR-03.2). */
export function heuristicAmbiguities(instruction: string, tasks: ParsedTask[], ctx: HeuristicContext): string[] {
  const amb: string[] = [];
  const lower = instruction.toLowerCase();

  if (!tasks.length) return ['Arahan tidak memuat pekerjaan yang dapat diuraikan menjadi penugasan.'];

  if (!/\b(urgent|darurat|p0|p1|p2|segera|penting|rendah|asap)\b/.test(lower)) {
    amb.push('Prioritas tidak dinyatakan eksplisit — sistem menetapkan P1 sebagai asumsi.');
  }
  if (!tasks.some((t) => t.dueAt)) {
    amb.push('Tenggat waktu tidak dinyatakan — sistem belum menetapkan tenggat.');
  }
  const unassigned = tasks.filter((t) => !t.assigneeHint);
  if (unassigned.length) {
    const candidates = new Set<string>();
    for (const t of unassigned) {
      for (const m of ctx.roster.filter((r) => r.division === t.division)) {
        const overlap = t.title.toLowerCase();
        const hit = m.specializations.find((s) => overlap.includes(s.split(' ')[0]!.toLowerCase()));
        if (hit) candidates.add(`${m.name} (${hit})`);
      }
    }
    amb.push(
      candidates.size
        ? `Pengalokasian tidak disebutkan. Kandidat berdasarkan spesialisasi: ${[...candidates].join(', ')}.`
        : `Pengalokasian tidak disebutkan untuk ${unassigned.length} tugas.`,
    );
  }
  if (/\b(paypal|midnight|magic|rahasia|confidential)\b/.test(lower)) {
    amb.push('Arahan memuat istilah yang tidak ada dalam glosarium proyek — perlu konfirmasi.');
  }
  return amb;
}
