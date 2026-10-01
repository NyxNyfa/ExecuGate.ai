import { z } from 'zod';

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmRequest {
  messages: LlmMessage[];
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  /** JSON Schema used for grammar-constrained decoding when the backend supports it. */
  jsonSchema?: Record<string, unknown>;
  /** Called with partial output so the approval card can stream (BUILD_PLAN §9.2). */
  onToken?: (chunk: string) => void;
}

export interface LlmUsage {
  promptTokens: number;
  completionTokens: number;
}

export interface LlmResult {
  text: string;
  /** Time to first token — the user-perceived latency for streamed cards. */
  ttftMs: number;
  totalMs: number;
  usage: LlmUsage;
  model: string;
  provider: string;
}

export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  complete(req: LlmRequest): Promise<LlmResult>;
  /** Release accelerator memory on the demo GPU (BUILD_PLAN §9.1). */
  free?(): Promise<void>;
  healthCheck(): Promise<{ ok: boolean; detail: string }>;
}

// ─── Parsing / decomposition (FR-01.3) ──────────────────────────────────────

export const CheckSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('github_pr'),
    repo: z.string(),
    branch: z.string(),
    requireMerged: z.boolean().default(true),
    requireCiGreen: z.boolean().default(true),
    requireNoConflicts: z.boolean().default(true),
  }),
  z.object({
    type: z.literal('document_present'),
    documentId: z.string().optional(),
    path: z.string().optional(),
    minBytes: z.number().default(1),
  }),
  z.object({
    type: z.literal('reconciliation'),
    source: z.string(),
    key: z.string(),
    expectedField: z.string(),
    actualField: z.string(),
    tolerance: z.number().default(0.01),
  }),
  z.object({
    type: z.literal('data_row'),
    source: z.string(),
    match: z.record(z.union([z.string(), z.number()])),
  }),
  z.object({
    type: z.literal('manual_review'),
    reviewerRole: z.enum(['commander', 'technical', 'ops', 'admin']),
  }),
]);

export const DodSchema = z.object({
  kind: z.enum(['engineering', 'document', 'reconciliation', 'data', 'review']),
  label: z.string().min(3),
  required: z.boolean().default(true),
  check: CheckSchema,
});

export const ParsedTaskSchema = z.object({
  title: z.string().min(3).max(200),
  description: z.string().min(3),
  division: z.enum(['technical', 'operational']),
  assigneeHint: z.string().nullable().default(null),
  priority: z.enum(['P0', 'P1', 'P2']).default('P1'),
  dueAt: z.string().nullable().default(null),
  dod: z.array(DodSchema).min(1),
});

export const InstructionParseSchema = z.object({
  language: z.enum(['id', 'en', 'mixed']).default('id'),
  summary: z.string(),
  ambiguities: z.array(z.string()).default([]),
  tasks: z.array(ParsedTaskSchema).min(1),
});

export type CheckZod = z.infer<typeof CheckSchema>;
export type ParsedTask = z.infer<typeof ParsedTaskSchema>;
export type InstructionParseZod = z.infer<typeof InstructionParseSchema>;
