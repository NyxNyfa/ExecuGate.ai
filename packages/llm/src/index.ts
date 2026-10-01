import type { InstructionParse, OrgScope, Check, DodKind, Priority, DivisionKind } from '@execugate/core';
import { config } from '@execugate/core';
import type { LlmProvider, LlmRequest } from './types.ts';
import { z } from 'zod';
import { InstructionParseSchema } from './types.ts';
import { parseStructured } from './structured.ts';
import { heuristicAmbiguities, heuristicParse } from './heuristic.ts';
import type { HeuristicContext, RosterMember } from './heuristic.ts';
import {
  clarificationSystemPrompt, clarificationUserPrompt,
  decompositionSystemPrompt, decompositionUserPrompt,
  instructionParseJsonSchema, PARSE_PROMPT_VERSION,
} from './prompts.ts';
import { createFakeProvider } from './providers/fake.ts';
import { createOpenAiCompatibleProvider } from './providers/openai-compatible.ts';
import { createLogger } from '@execugate/observability';

export * from './types.ts';
export * from './structured.ts';
export * from './heuristic.ts';
export * from './prompts.ts';

const log = createLogger('llm');

export function createLlmProvider(ctx: HeuristicContext): LlmProvider {
  if (config.llm.provider === 'fake') return createFakeProvider(ctx);

  const baseUrl = config.llm.baseUrl || (config.llm.provider === 'ollama' ? 'http://127.0.0.1:11434/v1' : 'https://api.openai.com/v1');
  const model = config.llm.model || (config.llm.provider === 'ollama' ? 'qwen2.5:3b-instruct' : 'gpt-4o-mini');
  if (!config.llm.model) log.warn('LLM_MODEL not set; defaulting', { model, provider: config.llm.provider });

  return createOpenAiCompatibleProvider({
    baseUrl,
    apiKey: config.llm.apiKey || undefined,
    model,
    timeoutMs: config.llm.timeoutMs,
    temperature: config.llm.temperature,
    maxTokens: config.llm.maxTokens,
  });
}

export interface DecomposeInput {
  instruction: string;
  roster: RosterMember[];
  projectName: string;
  projectCode: string;
  retrieved: Array<{ title: string; text: string }>;
  language?: 'id' | 'en' | 'mixed';
  now?: Date;
  /** When set, partial output is forwarded so the approval card can stream (BUILD_PLAN §9.2). */
  onToken?: (chunk: string) => void;
}

export interface DecomposeOutcome {
  parse: InstructionParse;
  provider: string;
  model: string;
  promptVersion: string;
  ttftMs: number;
  totalMs: number;
  usedFallback: boolean;
  usedStreaming: boolean;
}

function toDomainParse(raw: z.infer<typeof InstructionParseSchema>): InstructionParse {
  return {
    language: raw.language ?? 'id',
    summary: raw.summary,
    ambiguities: raw.ambiguities ?? [],
    tasks: raw.tasks.map((t) => ({
      title: t.title,
      description: t.description,
      division: t.division,
      assigneeHint: t.assigneeHint ?? null,
      priority: t.priority ?? 'P1',
      dueAt: t.dueAt ?? null,
      dod: (t.dod ?? []) as Array<{ kind: DodKind; label: string; required: boolean; check: Check }>,
    })),
  };
}

/**
 * FR-01.3. Always resolves to a valid parse: if the model's output cannot be
 * validated after repairs, the deterministic heuristic parser takes over so a
 * commander is never left without a draft.
 */
export async function decomposeInstruction(provider: LlmProvider, ctx: HeuristicContext, input: DecomposeInput): Promise<DecomposeOutcome> {
  const heuristicCtx: HeuristicContext = { ...ctx, now: input.now ?? new Date() };
  const messages: LlmRequest['messages'] = [
    {
      role: 'system',
      content: decompositionSystemPrompt({
        projectName: input.projectName,
        projectCode: input.projectCode,
        roster: input.roster,
        defaultRepo: ctx.defaultRepo,
        opsSource: ctx.opsSource,
        language: input.language ?? 'id',
      }),
    },
    { role: 'user', content: decompositionUserPrompt(input.instruction, input.retrieved) },
  ];

  const result = await provider.complete({
    messages,
    jsonSchema: instructionParseJsonSchema(),
    onToken: input.onToken,
  });

  try {
    const structured = parseStructured(result.text, InstructionParseSchema);
    return {
      parse: toDomainParse(structured.value),
      provider: result.provider,
      model: result.model,
      promptVersion: PARSE_PROMPT_VERSION,
      ttftMs: result.ttftMs,
      totalMs: result.totalMs,
      usedFallback: false,
      usedStreaming: !!input.onToken,
    };
  } catch (err) {
    log.warn('LLM output failed validation; falling back to heuristic parser', {
      error: err instanceof Error ? err.message : String(err),
      model: result.model,
    });

    const tasks = heuristicParse(input.instruction, heuristicCtx);
    const ambiguities = heuristicAmbiguities(input.instruction, tasks, heuristicCtx);
    return {
      parse: {
        language: input.language ?? 'id',
        summary: input.instruction.slice(0, 300),
        ambiguities,
        tasks: tasks as InstructionParse['tasks'],
      },
      provider: result.provider,
      model: result.model,
      promptVersion: PARSE_PROMPT_VERSION,
      ttftMs: result.ttftMs,
      totalMs: result.totalMs,
      usedFallback: true,
      usedStreaming: false,
    };
  }
}

export interface ClarifyInput {
  question: string;
  projectName: string;
  retrieved: Array<{ title: string; text: string }>;
}

export interface ClarifyOutcome {
  answer: string;
  grounded: boolean;
  /** Indexes into `retrieved`, 1-based, matching the [n] labels in the prompt. */
  citationIndexes: number[];
  provider: string;
  model: string;
  usedFallback: boolean;
}

const CLARIFY_SCHEMA = {
  type: 'object',
  properties: {
    answer: { type: 'string' },
    grounded: { type: 'boolean' },
    citations: { type: 'array', items: { type: 'integer' } },
  },
  required: ['answer', 'grounded', 'citations'],
  additionalProperties: false,
};

const ClarifyResponseSchema = z.object({
  answer: z.string(),
  grounded: z.boolean(),
  citations: z.array(z.number()).default([]),
});

/**
 * FR-04.2 / FR-04.3. When no memory is retrieved there is nothing to ground on, so
 * the system refuses rather than inventing an answer — the anti-hallucination
 * guarantee of FR-02.3.
 */
export async function answerClarification(provider: LlmProvider, input: ClarifyInput): Promise<ClarifyOutcome> {
  if (!input.retrieved.length) {
    return {
      answer:
        'Informasi tersebut tidak ditemukan dalam memori proyek. Silakan eskalasi ke commanding officer agar arahan dapat diperjelas.',
      grounded: false,
      citationIndexes: [],
      provider: provider.name,
      model: provider.model,
      usedFallback: false,
    };
  }

  const result = await provider.complete({
    messages: [
      { role: 'system', content: clarificationSystemPrompt(input.projectName) },
      { role: 'user', content: clarificationUserPrompt(input.question, input.retrieved) },
    ],
    jsonSchema: CLARIFY_SCHEMA,
    temperature: 0.3,
  });

  try {
    const { value } = parseStructured(result.text, ClarifyResponseSchema);
    const citations = value.citations ?? [];
    return {
      answer: value.answer,
      grounded: value.grounded && citations.length > 0,
      citationIndexes: citations.filter((n) => n >= 1 && n <= input.retrieved.length),
      provider: result.provider,
      model: result.model,
      usedFallback: false,
    };
  } catch (err) {
    log.warn('Clarification output invalid; returning raw text ungrounded', {
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      answer:
        'Maaf, jawaban tidak dapat dibangkitkan dengan validitas yang cukup. Silakan eskalasi ke commanding officer.',
      grounded: false,
      citationIndexes: [],
      provider: result.provider,
      model: result.model,
      usedFallback: true,
    };
  }
}

export type { DivisionKind, OrgScope, Priority };