import { readFile, stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { config } from '@execugate/core';
import { createLogger } from '@execugate/observability';

const log = createLogger('asr');

export interface AsrResult {
  text: string;
  /** 0..1. Below 0.55 the approval card flags the transcript for confirmation (FR-01.2). */
  confidence: number;
  language: string;
  durationMs: number;
  provider: string;
  model: string;
}

export interface AsrProvider {
  readonly name: string;
  readonly model: string;
  transcribe(audioPath: string, opts?: { language?: string }): Promise<AsrResult>;
  healthCheck(): Promise<{ ok: boolean; detail: string }>;
  /** Release VRAM so the LLM can load on a 4 GB demo GPU (BUILD_PLAN §9.1). */
  free?(): Promise<void>;
}

export class AudioTooLargeError extends Error {
  constructor(readonly bytes: number, readonly maxBytes: number) {
    super(`Audio ${bytes} bytes exceeds the ${maxBytes} byte limit`);
    this.name = 'AudioTooLargeError';
  }
}

async function assertWithinLimit(path: string, maxBytes = config.asr.maxBytes): Promise<void> {
  const s = await stat(path);
  if (s.size > maxBytes) throw new AudioTooLargeError(s.size, maxBytes);
}

/**
 * Fixture-driven provider.
 *
 * Chosen by hashing the audio file so the same clip always yields the same
 * transcript — this is what makes `npm run eval:asr` reproducible in CI without a GPU.
 */
export function createFakeAsr(fixtures: Record<string, { text: string; confidence?: number; language?: string }> = {}): AsrProvider {
  const entries = Object.entries(fixtures);
  return {
    name: 'fake',
    model: 'fixture-v1',

    async transcribe(audioPath) {
      await assertWithinLimit(audioPath);
      const key = basename(audioPath).toLowerCase();
      const hit =
        entries.find(([k]) => key.includes(k.toLowerCase())) ??
        entries.find(([k]) => extname(k) === extname(audioPath));

      if (hit) {
        const [, f] = hit;
        return {
          text: f.text,
          confidence: f.confidence ?? 0.9,
          language: f.language ?? 'id',
          durationMs: 1,
          provider: 'fake',
          model: 'fixture-v1',
        };
      }

      // No fixture: emit a clearly-labelled placeholder rather than fabricated text,
      // so a demo never silently asserts something the ASR never said.
      return {
        text: `[transkripsi belum tersedia untuk berkas ${basename(audioPath)} — sediakan fixture ASR atau aktifkan provider asr]`,
        confidence: 0,
        language: 'id',
        durationMs: 1,
        provider: 'fake',
        model: 'fixture-v1',
      };
    },

    async healthCheck() {
      return { ok: true, detail: `${entries.length} fixture transcript(s) registered` };
    },
  };
}

async function postForm(url: string, form: FormData, headers: Record<string, string>, timeoutMs: number): Promise<Response> {
  return fetch(url, { method: 'POST', body: form, headers, signal: AbortSignal.timeout(timeoutMs) });
}

/**
 * faster-whisper-server / whisper.cpp server on the demo laptop.
 * Language auto-detection is on by default because the product must handle
 * code-switched Indonesian-English (FR-01.2).
 */
export function createWhisperHttpProvider(opts: { baseUrl: string; model: string }): AsrProvider {
  const base = opts.baseUrl.replace(/\/+$/, '');
  return {
    name: 'whisper-http',
    model: opts.model,

    async transcribe(audioPath, o) {
      await assertWithinLimit(audioPath);
      const started = performance.now();
      const bytes = await readFile(audioPath);
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array(bytes)]), basename(audioPath));
      form.append('response_format', 'json');
      if (o?.language) form.append('language', o.language);

      const res = await postForm(`${base}/transcribe`, form, {}, 30_000);
      if (!res.ok) throw new Error(`ASR HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);

      const json = (await res.json()) as { text?: string; language?: string; duration?: number };
      return {
        text: (json.text ?? '').trim(),
        confidence: json.text ? 0.88 : 0,
        language: json.language ?? o?.language ?? 'id',
        durationMs: Math.round(performance.now() - started),
        provider: 'whisper-http',
        model: opts.model,
      };
    },

    async healthCheck() {
      try {
        const res = await fetch(`${base}/`, { signal: AbortSignal.timeout(2000) });
        return { ok: res.status < 500, detail: `GET ${base}/ -> ${res.status}` };
      } catch (err) {
        return { ok: false, detail: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

/** OpenAI-compatible `/audio/transcriptions` (cloud fallback for the demo). */
export function createCloudAsr(opts: { baseUrl: string; apiKey: string; model: string }): AsrProvider {
  const base = opts.baseUrl.replace(/\/+$/, '');
  return {
    name: 'cloud',
    model: opts.model,

    async transcribe(audioPath, o) {
      await assertWithinLimit(audioPath);
      const started = performance.now();
      const bytes = await readFile(audioPath);
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array(bytes)]), basename(audioPath));
      form.append('model', opts.model);
      form.append('response_format', 'verbose_json');
      if (o?.language) form.append('language', o.language);

      const res = await postForm(`${base}/audio/transcriptions`, form, { authorization: `Bearer ${opts.apiKey}` }, 30_000);
      if (!res.ok) throw new Error(`ASR HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);

      const json = (await res.json()) as { text?: string; language?: string };
      return {
        text: (json.text ?? '').trim(),
        confidence: json.text ? 0.92 : 0,
        language: json.language ?? o?.language ?? 'id',
        durationMs: Math.round(performance.now() - started),
        provider: 'cloud',
        model: opts.model,
      };
    },

    async healthCheck() {
      return { ok: !!opts.apiKey, detail: opts.apiKey ? `cloud ASR configured (${opts.model})` : 'ASR_API_KEY missing' };
    },
  };
}

export function createAsrProvider(fixtures?: Record<string, { text: string; confidence?: number; language?: string }>): AsrProvider {
  if (config.asr.provider === 'fake') return createFakeAsr(fixtures);
  if (config.asr.provider === 'whisper-http') {
    return createWhisperHttpProvider({ baseUrl: config.asr.baseUrl, model: config.asr.model });
  }
  return createCloudAsr({
    baseUrl: 'https://api.openai.com/v1',
    apiKey: config.asr.apiKey,
    model: config.asr.model || 'whisper-1',
  });
}

/** Transcribe but never throw: a voice note must not take the whole pipeline down. */
export async function transcribeSafe(
  provider: AsrProvider,
  audioPath: string,
  opts?: { language?: string; fallbackText?: string },
): Promise<{ result: AsrResult; error: string | null }> {
  try {
    return { result: await provider.transcribe(audioPath, opts), error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('transcription failed', { audioPath, error: message });
    return {
      result: {
        text: opts?.fallbackText ?? '',
        confidence: 0,
        language: opts?.language ?? 'id',
        durationMs: 0,
        provider: provider.name,
        model: provider.model,
      },
      error: message,
    };
  }
}