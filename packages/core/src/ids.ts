import { randomBytes, createHash } from 'node:crypto';

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/** Sortable, URL-safe, prefixed id: `tic_lq3x8f2a_0007`. */
export function newId(prefix: string, counter?: number): string {
  const time = Date.now().toString(36).padStart(8, '0');
  const rand = randomBytes(4);
  let randPart = '';
  for (const b of rand) randPart += ALPHABET[b % ALPHABET.length];
  const seq = counter === undefined ? '' : `_${counter.toString(36).padStart(4, '0')}`;
  return `${prefix}_${time}${randPart}${seq}`;
}

/** Human-facing ticket code, e.g. `TKT-2026-0001`. */
export function ticketCode(year: number, seq: number): string {
  return `TKT-${year}-${seq.toString().padStart(4, '0')}`;
}

export function sha256(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

/** Stable hash used by the `fake` providers so output is deterministic in CI. */
export function deterministicHash(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}
