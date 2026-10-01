import type { Store } from '@execugate/db';
import type { OrgScope, AnswerResult, Citation } from '@execugate/core';
import type { LlmProvider } from '@execugate/llm';
import { answerClarification } from '@execugate/llm';
import type { EmbeddingProvider } from './embed.ts';
import { retrieve } from './retrieve.ts';

export interface AnswerOptions {
  projectId: string;
  projectName: string;
  question: string;
  limit?: number;
  /** Answer without invoking the model: return the best chunk verbatim. */
  extractiveOnly?: boolean;
}

/**
 * FR-04.2 / FR-04.3 with the FR-02.3 grounding guarantee.
 *
 * `grounded=false` is a first-class outcome, not an error: when the corpus cannot
 * support an answer the system says so instead of inventing one. Citations are
 * always real chunks from the store, never model-generated references.
 */
export async function answerQuestion(
  store: Store,
  embedder: EmbeddingProvider,
  llm: LlmProvider,
  scope: OrgScope,
  opts: AnswerOptions,
): Promise<AnswerResult & { latencyMs: number }> {
  const started = performance.now();
  const found = await retrieve(store, embedder, scope, { projectId: opts.projectId, query: opts.question, limit: opts.limit ?? 4 });

  const payload = found.chunks.map((c) => ({ title: `${c.docTitle} (bagian ${c.ordinal + 1})`, text: c.text }));
  const citationsOf = (indexes: number[]): Citation[] =>
    indexes.map((i) => {
      const c = found.chunks[i - 1];
      if (!c) return null;
      return {
        docId: c.docId,
        docTitle: c.docTitle,
        ordinal: c.ordinal,
        excerpt: c.text.slice(0, 220).replace(/\s+/g, ' ').trim(),
      };
    }).filter((c): c is Citation => c !== null);

  if (!payload.length) {
    return {
      answer:
        'Informasi tersebut tidak ditemukan dalam memori proyek. Silakan eskalasi ke commanding officer agar arahan dapat diperjelas.',
      citations: [],
      grounded: false,
      latencyMs: Math.round(performance.now() - started),
    };
  }

  // Extractive mode backs the `fake` provider: quote the best chunk instead of
  // pretending a model composed prose.
  if (opts.extractiveOnly) {
    const best = found.chunks[0]!;
    const sentences = best.text.split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 20);
    return {
      answer: sentences.slice(0, 3).join(' ').trim() || best.text.slice(0, 400),
      citations: citationsOf([1]),
      grounded: true,
      latencyMs: Math.round(performance.now() - started),
    };
  }

  const outcome = await answerClarification(llm, { question: opts.question, projectName: opts.projectName, retrieved: payload });

  return {
    answer: outcome.answer,
    citations: outcome.grounded ? citationsOf(outcome.citationIndexes) : [],
    grounded: outcome.grounded,
    latencyMs: Math.round(performance.now() - started),
  };
}