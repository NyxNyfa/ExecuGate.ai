import type { LlmProvider, LlmRequest, LlmResult } from '../types.ts';
import { heuristicParse } from '../heuristic.ts';
import { heuristicAmbiguities } from '../heuristic.ts';
import type { HeuristicContext } from '../heuristic.ts';

/**
 * Deterministic offline provider (ADR-6).
 *
 * Not a stub: it performs a real clause-splitting, division-classification,
 * assignee-matching, date-resolution and DoD-synthesis pass. That means the entire
 * golden path runs on the build machine with no API keys, CI is deterministic, and
 * the heuristic doubles as (a) the fallback when a real model's output fails
 * validation and (b) the baseline that the PRD §10.2 accuracy eval compares against.
 */
export function createFakeProvider(ctx: HeuristicContext): LlmProvider {
  return {
    name: 'fake',
    model: 'heuristic-v1',

    async complete(req: LlmRequest): Promise<LlmResult> {
      const instruction = extractInstruction(req.messages);
      const t0 = performance.now();
      const tasks = heuristicParse(instruction, ctx);
      // Emit a well-formed envelope matching InstructionParseSchema. Streaming the
      // same shape a real provider returns keeps one code path exercised offline.
      const body = JSON.stringify({
        language: 'id',
        summary: instruction.slice(0, 200),
        ambiguities: heuristicAmbiguities(instruction, tasks, ctx),
        tasks,
      });
      req.onToken?.(body);

      return {
        text: body,
        ttftMs: 1,
        totalMs: Math.max(1, Math.round(performance.now() - t0)),
        usage: { promptTokens: estimateTokens(req.messages), completionTokens: estimateTokens([{ role: 'assistant', content: body }]) },
        model: 'heuristic-v1',
        provider: 'fake',
      };
    },

    async healthCheck() {
      return { ok: true, detail: `heuristic parser ready (${ctx.roster.length} staff, default repo ${ctx.defaultRepo})` };
    },
  };
}

function extractInstruction(messages: LlmRequest['messages']): string {
  const last = messages[messages.length - 1]?.content ?? '';
  const m = last.match(/<ARAHAN_PIMPINAN>\s*([\s\S]*?)\s*<\/ARAHAN_PIMPINAN>/);
  return (m?.[1] ?? last).trim();
}

/** Rough token estimate; good enough for cost telemetry without a tokenizer dependency. */
export function estimateTokens(messages: LlmRequest['messages']): number {
  const chars = messages.reduce((n, m) => n + m.content.length, 0);
  return Math.ceil(chars / 4);
}