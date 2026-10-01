import type { Check, CheckOutcome } from '@execugate/core';
import { createLogger } from '@execugate/observability';

const log = createLogger('gatekeeper:ops');

export interface OpsEvidenceRow {
  [field: string]: string | number | null;
}

export interface OpsSource {
  readonly name: string;
  /** Fetches a record set from the operational system of record. */
  fetch(key: string): Promise<OpsEvidenceRow[]>;
  /** Resolves a staff-uploaded artefact reference to its byte length, or null. */
  fileSize(path: string): Promise<number | null>;
}

/**
 * FR-05.1 operational lane.
 *
 * Implemented as three generic check types rather than a bespoke integration per
 * system, so "ERP / inventory / spreadsheet / issue tracker" are all covered by
 * configuration. That keeps Alpha scope achievable without inventing 40 connectors.
 */
export class OpsProvider {
  constructor(private readonly source: OpsSource) {}

  get configured(): boolean {
    return true;
  }

  async verify(check: Check): Promise<CheckOutcome> {
    const started = performance.now();
    const done = () => ({ latencyMs: Math.round(performance.now() - started) });

    try {
      switch (check.type) {
        case 'document_present':
          return await this.documentPresent(check, done);
        case 'reconciliation':
          return await this.reconciliation(check, done);
        case 'data_row':
          return await this.dataRow(check, done);
        default:
          return {
            type: check.type,
            ok: false,
            unverifiable: true,
            detail: `Tipe pemeriksaan '${check.type}' tidak ditangani oleh penyedia operasional.`,
            ...done(),
          };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn('ops verification unavailable', { type: check.type, error: message });
      return {
        type: check.type,
        ok: false,
        unverifiable: true,
        detail: `Sumber data operasional tidak dapat dihubungi (${message}). Verifikasi dijadwalkan ulang.`,
        ...done(),
      };
    }
  }

  private async documentPresent(
    check: Extract<Check, { type: 'document_present' }>,
    done: () => { latencyMs: number },
  ): Promise<CheckOutcome> {
    const path = check.path ?? check.documentId ?? '';
    if (!path) {
      return { type: check.type, ok: false, detail: 'Tidak ada berkas wajib yang dirujuk pada kriteria ini.', ...done() };
    }
    const size = await this.source.fileSize(path);
    if (size === null) {
      return { type: check.type, ok: false, detail: `Berkas wajib '${path}' belum diunggah.`, ...done() };
    }
    if (size < (check.minBytes || 1)) {
      return { type: check.type, ok: false, detail: `Berkas '${path}' berukuran ${size} byte, di bawah minimum ${check.minBytes} byte.`, ...done() };
    }
    return { type: check.type, ok: true, detail: `Berkas '${path}' ditemukan (${size} byte).`, ...done() };
  }

  private async reconciliation(
    check: Extract<Check, { type: 'reconciliation' }>,
    done: () => { latencyMs: number },
  ): Promise<CheckOutcome> {
    const rows = await this.source.fetch(check.key);
    if (!rows.length) {
      return { type: check.type, ok: false, unverifiable: true, detail: `Tidak ada data rekonsiliasi untuk '${check.key}'.`, ...done() };
    }

    const problems: string[] = [];
    for (const row of rows) {
      const expected = Number(row[check.expectedField] ?? NaN);
      const actual = Number(row[check.actualField] ?? NaN);
      if (Number.isNaN(expected) || Number.isNaN(actual)) {
        problems.push(`baris ${check.key}: kolom ${check.expectedField}/${check.actualField} tidak terbaca`);
        continue;
      }
      const delta = Math.abs(expected - actual);
      const allowed = Math.max(Math.abs(expected) * check.tolerance, check.tolerance);
      if (delta > allowed) {
        problems.push(`${check.key}: ${check.expectedField}=${expected} vs ${check.actualField}=${actual} (selisih ${delta.toFixed(2)})`);
      }
    }

    if (problems.length) {
      return {
        type: check.type,
        ok: false,
        detail: `Rekonsiliasi belum cocok: ${problems.slice(0, 4).join('; ')}.`,
        ...done(),
      };
    }
    return {
      type: check.type,
      ok: true,
      detail: `Rekonsiliasi '${check.key}' cocok pada ${rows.length} baris (${check.expectedField} = ${check.actualField}).`,
      ...done(),
    };
  }

  private async dataRow(
    check: Extract<Check, { type: 'data_row' }>,
    done: () => { latencyMs: number },
  ): Promise<CheckOutcome> {
    const rows = await this.source.fetch(Object.values(check.match).join('|'));
    const matches = rows.filter((row) =>
      Object.entries(check.match).every(([field, want]) => String(row[field] ?? '') === String(want)),
    );
    if (!matches.length) {
      return {
        type: check.type,
        ok: false,
        detail: `Data row tidak ditemukan untuk ${JSON.stringify(check.match)} pada sumber '${check.source}'.`,
        ...done(),
      };
    }
    return { type: check.type, ok: true, detail: `${matches.length} baris data cocok pada '${check.source}'.`, ...done() };
  }
}

/** In-memory source seeded from fixtures; the demo's operational system of record. */
export class FixtureOpsSource implements OpsSource {
  readonly name: string;
  private rows = new Map<string, OpsEvidenceRow[]>();
  private files = new Map<string, number>();

  constructor(
    name = 'fixture',
    seed: { rows?: Record<string, OpsEvidenceRow[]>; files?: Record<string, number> } = {},
  ) {
    this.name = name;
    for (const [k, v] of Object.entries(seed.rows ?? {})) this.rows.set(k, v);
    for (const [k, v] of Object.entries(seed.files ?? {})) this.files.set(k, v);
  }

  setRows(key: string, rows: OpsEvidenceRow[]) {
    this.rows.set(key, rows);
  }
  setFile(path: string, size: number) {
    this.files.set(path, size);
  }

  async fetch(key: string): Promise<OpsEvidenceRow[]> {
    // Fall back to the single seeded key so any check key resolves in a demo.
    if (this.rows.has(key)) return this.rows.get(key)!;
    const only = [...this.rows.values()];
    return only.length === 1 ? only[0]! : [];
  }

  async fileSize(path: string): Promise<number | null> {
    return this.files.get(path) ?? null;
  }
}