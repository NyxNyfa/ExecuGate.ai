import { z } from 'zod';
import type { LlmResult } from './types.ts';
import { llmInvalidOutput } from '@execugate/core';

/**
 * Extracts a JSON value from a model response. Small models (and every model in
 * JSON mode) wrap payloads in fences or prose; a local 3B model will do both.
 */
export function extractJson(raw: string): string | null {
  let s = raw.trim();

  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) s = fence[1].trim();

  const firstObj = s.indexOf('{');
  const firstArr = s.indexOf('[');
  const start = firstObj === -1 ? firstArr : firstArr === -1 ? firstObj : Math.min(firstObj, firstArr);
  if (start === -1) return null;

  const openChar = s[start];
  const closeChar = openChar === '{' ? '}' : ']';

  // Walk with string/escape awareness so a brace inside a string value is ignored.
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i]!;
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === openChar) depth++;
    else if (ch === closeChar) {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

const REPAIRS: Array<[RegExp, string]> = [
  [/\/\/[^\n\r]*/g, ''],            // line comments
  [/\/\*[\s\S]*?\*\//g, ''],        // block comments
  [/,\s*([}\]])/g, '$1'],            // trailing commas
  [/\bNaN\b/g, 'null'],
  [/\bInfinity\b/g, 'null'],
  [/\bundefined\b/g, 'null'],
  [/(?<!")\bTrue\b/g, 'true'],
  [/(?<!")\bFalse\b/g, 'false'],
  [/(?<!")\bNone\b/g, 'null'],
];

export function repairJson(json: string): string {
  let out = json;
  for (const [re, rep] of REPAIRS) out = out.replace(re, rep);
  return out;
}

export interface StructuredResult<T> {
  value: T;
  raw: string;
  attempts: number;
  usedFallback: boolean;
}

export interface ParseOutcome<T> extends StructuredResult<T> {
  result: LlmResult;
}

/**
 * Validates model output against a schema, applying bounded repairs.
 * Throws `LLM_INVALID_OUTPUT` only after every repair is exhausted, so callers
 * can fall back to the heuristic parser (BUILD_PLAN §9.3).
 *
 * The three-parameter `ZodType<T, ZodTypeDef, unknown>` binds T to the schema's
 * *output* type. With the default `ZodType<T>` form, a schema using `.default()`
 * infers T as the input type, where defaulted fields are still optional — and the
 * result would claim fields exist that were never parsed.
 */
export function parseStructured<T>(
  raw: string,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  maxAttempts = 3,
): StructuredResult<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const json = extractJson(raw);
    if (!json) {
      lastError = new Error('no JSON value found in response');
      continue;
    }
    try {
      return { value: schema.parse(JSON.parse(json)), raw, attempts: attempt, usedFallback: false };
    } catch (err) {
      lastError = err;
      try {
        const repaired = repairJson(json);
        if (repaired !== json) {
          const value = schema.parse(JSON.parse(repaired));
          return { value, raw, attempts: attempt, usedFallback: true };
        }
      } catch (err2) {
        lastError = err2;
      }
    }
  }

  const detail =
    lastError instanceof z.ZodError
      ? lastError.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`).join('; ')
      : lastError instanceof Error ? lastError.message : String(lastError);

  throw llmInvalidOutput(detail, raw);
}
