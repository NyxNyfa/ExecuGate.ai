import type { Ticket, InstructionParse } from '@execugate/core';

/**
 * Card rendering (FR-03.2, FR-03.3).
 *
 * Telegram's Markdown parser is finicky, so the renderer deliberately uses only
 * `*bold*` and `_italic_` and escapes reserved characters. A card that fails to
 * render would take the whole HITL gate down, so this stays conservative.
 */
/**
 * Escapes text for Telegram's legacy Markdown parser.
 *
 * Deliberately minimal. Over-escaping breaks the card in exactly the way a
 * reviewer notices: `\-` and `\?` are not valid escapes there, so a greedy
 * character class turns bullets and headings into literal backslashes. Only the
 * characters Telegram actually treats as markup are escaped.
 */
function esc(text: string): string {
  return text.replace(/([_*[\]()`])/g, '\\$1');
}

const PRIORITY_ICON: Record<string, string> = { P0: '🔴 P0', P1: '🟡 P1', P2: '🟢 P2' };

export function priorityLabel(p: string): string {
  return PRIORITY_ICON[p] ?? p;
}

/**
 * FR-03.2: the approval card must show the original instruction, the per-division
 * split, and the Definition of Done for each task — because that is precisely what
 * the commander is being asked to authorise.
 */
export function renderApprovalCard(opts: {
  instructionId: string;
  rawText: string;
  asrConfidence: number | null;
  parse: InstructionParse;
  tickets: Array<{ ticket: Ticket; assigneeName: string | null; divisionName: string }>;
}): { text: string; actions: Array<{ label: string; callbackData: string }> } {
  const { instructionId, rawText, asrConfidence, parse, tickets } = opts;
  const lines: string[] = [];

  lines.push('*KARTU OTORISASI PENUGASAN*');
  lines.push('');

  // FR-01.2: a low-confidence transcript must be flagged rather than trusted.
  if (asrConfidence !== null && asrConfidence < 0.55) {
    lines.push('⚠️ *Transkripsi suara kurang yakin* — mohon konfirmasi sebelum menyetujui.');
    lines.push('');
  }

  lines.push('*Arahan asli*');
  lines.push(esc(rawText).slice(0, 600));
  lines.push('');

  if (parse.summary) {
    lines.push(`*Intisari*: ${esc(parse.summary)}`);
    lines.push('');
  }

  // Group by division so the commander reads the split, not a flat list.
  const byDivision = new Map<string, typeof tickets>();
  for (const t of tickets) {
    const key = t.divisionName;
    byDivision.set(key, [...(byDivision.get(key) ?? []), t]);
  }

  for (const [divisionName, items] of byDivision) {
    lines.push(`*▸ ${esc(divisionName)}*`);
    for (const { ticket, assigneeName } of items) {
      lines.push('');
      lines.push(`${esc(ticket.code)} — ${esc(ticket.title)}`);
      lines.push(`   Prioritas: ${priorityLabel(ticket.priority)} | Tenggat: ${esc(ticket.dueAt ?? 'belum ditetapkan')}`);
      lines.push(`   Assigned: ${esc(assigneeName ?? 'belum ditentukan')}`);
    }
    lines.push('');
  }

  if (parse.ambiguities.length) {
    lines.push('*⚠️ Hal yang perlu dikonfirmasi*');
    for (const a of parse.ambiguities.slice(0, 5)) lines.push(`• ${esc(a)}`);
    lines.push('');
  }

  lines.push('_Tugas BELUM didistribusikan. Menyetujui berarti menerbitkan tiket ke kanal divisi._');

  return {
    text: lines.join('\n'),
    actions: [
      { label: '✅ Setujui & Distribusikan', callbackData: `apv:ok:${instructionId}` },
      { label: '✏️ Koreksi Parameter', callbackData: `apv:fix:${instructionId}` },
      { label: '🚫 Batalkan', callbackData: `apv:no:${instructionId}` },
    ],
  };
}

/** FR-04.1: the staff-facing task card. */
export function renderTicketCard(opts: {
  ticket: Ticket;
  assigneeName: string | null;
  divisionName: string;
  dod: Array<{ label: string; kind: string }>;
  referenceDocs: Array<{ title: string }>;
}): string {
  const { ticket, assigneeName, divisionName, dod, referenceDocs } = opts;
  const lines: string[] = [];

  lines.push(`*${esc(ticket.code)} — ${esc(ticket.title)}*`);
  lines.push('');
  lines.push(esc(ticket.description));
  lines.push('');
  lines.push(`Divisi: ${esc(divisionName)} | Prioritas: ${priorityLabel(ticket.priority)} | Tenggat: ${esc(ticket.dueAt ?? '-')}`);
  lines.push(`Assigned: ${esc(assigneeName ?? '-')}`);
  lines.push('');
  lines.push('*Kriteria Selesai (Definition of Done)*');
  for (const d of dod) lines.push(`☐ ${esc(d.label)}`);
  lines.push('');

  if (referenceDocs.length) {
    lines.push('*Dokumen acuan*');
    for (const d of referenceDocs) lines.push(`• ${esc(d.title)}`);
    lines.push('');
  }

  lines.push('_Laporkan selesai hanya setelah seluruh kriteria terpenihi. Sistem akan memverifikasi otomatis._');

  return lines.join('\n');
}

/** FR-03.3 second-stage actions. */
export function renderStaffActions(ticketCode: string): Array<{ label: string; callbackData: string }> {
  return [
    { label: '▶️ Terima & Mulai', callbackData: `tic:ack:${ticketCode}` },
    { label: '❓ Tanya Konteks', callbackData: `tic:ask:${ticketCode}` },
    { label: '📤 Lapor Selesai', callbackData: `tic:done:${ticketCode}` },
  ];
}

/** FR-05.2 rejection notice. Must name the failing artefact, never just "failed". */
export function renderReworkNotice(ticketCode: string, title: string, body: string): string {
  return [`*🔁 ${esc(ticketCode)} — PERLU DIPERBAIKI*`, esc(title), '', body].join('\n');
}

/** FR-06.2 evening walkthrough. */
export function renderWalkthrough(report: {
  date: string;
  completed: Array<{ code: string; title: string; assignee: string; evidenceUrls: string[] }>;
  blocked: Array<{ code: string; title: string; assignee: string; blocker: string }>;
  reopened: Array<{ code: string; title: string; reason: string }>;
  tomorrow: Array<{ code: string; title: string; priority: string; dueAt: string | null }>;
  counts: { completed: number; blocked: number; open: number; passRate: number };
}): string {
  const lines: string[] = [];
  lines.push(`*LAPORAN PROGRES — ${esc(report.date)}*`);
  lines.push('');

  lines.push(`✅ *Tuntas terverifikasi* (${report.counts.completed})`);
  if (!report.completed.length) lines.push('   — belum ada tugas yang lolos verifikasi hari ini');
  for (const c of report.completed) {
    lines.push(`• ${esc(c.code)} — ${esc(c.title)} (${esc(c.assignee)})`);
    for (const u of c.evidenceUrls) lines.push(`   Bukti: ${esc(u)}`);
  }
  lines.push('');

  lines.push(`⚠️ *Tertunda / perlu intervensi* (${report.counts.blocked})`);
  if (!report.blocked.length) lines.push('   — tidak ada kendala');
  for (const b of report.blocked) {
    lines.push(`• ${esc(b.code)} — ${esc(b.title)} (${esc(b.assignee)})`);
    lines.push(`   Kendala: ${esc(b.blocker)}`);
  }
  lines.push('');

  if (report.reopened.length) {
    lines.push(`🔁 *Dikembalikan untuk diperbaiki* (${report.reopened.length})`);
    for (const r of report.reopened) lines.push(`• ${esc(r.code)} — ${esc(r.title)}`);
    lines.push('');
  }

  lines.push('📌 *Proyeksi prioritas besok*');
  if (!report.tomorrow.length) lines.push('   — antrean kosong');
  report.tomorrow.forEach((t, i) => {
    lines.push(`${i + 1}. ${esc(t.code)} [${esc(t.priority)}] ${esc(t.title)}${t.dueAt ? ` — tenggat ${esc(t.dueAt)}` : ''}`);
  });
  lines.push('');

  const pct = Math.round(report.counts.passRate * 100);
  lines.push(`_Lulus verifikasi: ${pct}% | masih terbuka: ${report.counts.open}_`);

  return lines.join('\n');
}

/** Clarification answer with numbered citations (the visible FR-02.3 proof). */
export function renderAnswer(question: string, answer: string, citations: Array<{ docTitle: string; ordinal: number; excerpt: string }>, grounded: boolean): string {
  const lines: string[] = [];
  lines.push(`❓ *${esc(question.slice(0, 200))}*`);
  lines.push('');
  lines.push(esc(answer));
  lines.push('');
  if (grounded && citations.length) {
    lines.push('*Sumber*');
    citations.forEach((c, i) => lines.push(`[${i + 1}] ${esc(c.docTitle)} — bagian ${c.ordinal + 1}`));
  } else if (!grounded) {
    lines.push('_Jawaban ini tidak bersumber dari memori proyek._');
  }
  return lines.join('\n');
}