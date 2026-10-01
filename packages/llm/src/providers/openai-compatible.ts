import type { LlmProvider, LlmRequest, LlmResult } from '../types.ts';
import { config } from '@execugate/core';
import { createLogger } from '@execugate/observability';
import { estimateTokens } from './fake.ts';

const log = createLogger('llm:openai');

export interface OpenAiCompatibleOptions {
  baseUrl: string;
  apiKey?: string;
  model: string;
  timeoutMs?: number;
  temperature?: number;
  maxTokens?: number;
}

/**
 * One implementation covers every backend the project needs (BUILD_PLAN §9.1):
 *   cloud  — LLM_BASE_URL=https://api.openai.com/v1
 *   local  — LLM_BASE_URL=http://127.0.0.1:8080/v1   (llama.cpp / LM Studio on the demo laptop)
 *   ollama — its own native API, proxied through /v1 by recent versions
 *
 * `jsonSchema` is forwarded as `response_format: json_schema`, which llama.cpp and
 * Ollama compile into a decoding grammar. That is what makes a 3B local model
 * reliably emit parseable JSON (BUILD_PLAN §9.2).
 */
export function createOpenAiCompatibleProvider(opts: OpenAiCompatibleOptions): LlmProvider {
  const base = opts.baseUrl.replace(/\/+$/, '');
  const timeoutMs = opts.timeoutMs ?? config.llm.timeoutMs;

  const request = async (req: LlmRequest): Promise<LlmResult> => {
    const t0 = performance.now();
    let ttft = 0;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), req.timeoutMs ?? timeoutMs);

    try {
      const body: Record<string, unknown> = {
        model: opts.model,
        messages: req.messages,
        temperature: req.temperature ?? opts.temperature ?? 0,
        max_tokens: req.maxTokens ?? opts.maxTokens ?? 900,
        stream: !!req.onToken,
      };
      if (req.jsonSchema) {
        body.response_format = { type: 'json_schema', json_schema: { name: 'execugate', schema: req.jsonSchema, strict: true } };
      }

      const res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`LLM HTTP ${res.status} ${res.statusText}: ${text.slice(0, 300)}`);
      }

      // Streaming path: accumulate deltas while feeding the caller.
      if (req.onToken && res.body) {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let content = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) continue;
            const payload = trimmed.slice(5).trim();
            if (!payload || payload === '[DONE]') continue;
            try {
              const parsed = JSON.parse(payload) as { choices?: Array<{ delta?: { content?: string } }> };
              const delta = parsed.choices?.[0]?.delta?.content;
              if (delta) {
                if (!ttft) ttft = Math.round(performance.now() - t0);
                content += delta;
                req.onToken(delta);
              }
            } catch {
              /* ignore keep-alive or malformed frame */
            }
          }
        }

        return {
          text: content,
          ttftMs: ttft || Math.round(performance.now() - t0),
          totalMs: Math.round(performance.now() - t0),
          usage: { promptTokens: estimateTokens(req.messages), completionTokens: Math.ceil(content.length / 4) },
          model: opts.model,
          provider: 'openai-compatible',
        };
      }

      const json = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const content = json.choices?.[0]?.message?.content ?? '';
      return {
        text: content,
        ttftMs: Math.round(performance.now() - t0),
        totalMs: Math.round(performance.now() - t0),
        usage: { promptTokens: json.usage?.prompt_tokens ?? estimateTokens(req.messages), completionTokens: json.usage?.completion_tokens ?? Math.ceil(content.length / 4) },
        model: opts.model,
        provider: 'openai-compatible',
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('LLM request failed', { model: opts.model, baseUrl: base, error: msg });
      throw err;
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    name: 'openai-compatible',
    model: opts.model,
    complete: request,
    async free() {
      // llama.cpp keeps weights resident; the demo runner unloads via its own server
      // control endpoint, so there is nothing to free client-side here.
    },
    async healthCheck() {
      try {
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 2500);
        const res = await fetch(`${base}/models`, {
          headers: opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {},
          signal: controller.signal,
        });
        return { ok: res.ok, detail: `GET ${base}/models -> ${res.status}` };
      } catch (err) {
        return { ok: false, detail: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}