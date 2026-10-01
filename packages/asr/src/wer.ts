/**
 * Word Error Rate (PRD FR-01.2: WER below 10% for code-switched Indonesian).
 *
 * Levenshtein distance over normalised word tokens, which is the standard
 * definition: (substitutions + deletions + insertions) / reference word count.
 */

export function normalise(text: string): string[] {
  return text
    .toLowerCase()
    // Strip punctuation but keep intra-word hyphens, which matter in Indonesian
    // compounds like "code-switching".
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

export function levenshtein(a: string[], b: string[]): number {
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr = new Array<number>(b.length + 1);

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length]!;
}

/** Returns 1 for an empty reference, so a broken harness cannot report a false pass. */
export function wordErrorRate(reference: string, hypothesis: string): number {
  const ref = normalise(reference);
  const hyp = normalise(hypothesis);
  if (!ref.length) return 1;
  return levenshtein(ref, hyp) / ref.length;
}

export interface WerCase {
  id: string;
  audio: string;
  reference: string;
}

export interface WerResult {
  id: string;
  reference: string;
  hypothesis: string;
  wer: number;
  passed: boolean;
  durationMs: number;
}

/**
 * Aggregates a corpus. `passed` is per the PRD threshold of 0.10 on the corpus mean,
 * which is what FR-01.2 actually specifies.
 */
export function summarise(results: WerResult[], threshold = 0.1) {
  const total = results.length;
  const mean = total ? results.reduce((n, r) => n + r.wer, 0) / total : 1;
  const worst = results.reduce((a, b) => (b.wer > a.wer ? b : a), results[0] ?? { wer: 0 } as WerResult);
  return {
    cases: total,
    meanWer: Number(mean.toFixed(4)),
    worstWer: worst?.wer ?? 0,
    worstCaseId: worst?.id ?? null,
    threshold,
    passed: total > 0 && mean < threshold,
  };
}