import { config } from '@execugate/core';
import { createLogger } from '@execugate/observability';
import { deterministicHash } from '@execugate/core';

const log = createLogger('memory:embed');

export interface EmbeddingProvider {
  readonly name: string;
  readonly model: string;
  readonly dims: number;
  embed(texts: string[]): Promise<Float32Array[]>;
  healthCheck(): Promise<{ ok: boolean; detail: string }>;
  free?(): Promise<void>;
}

/** float32 <-> little-endian BLOB. Stored directly in SQLite (ADR-2). */
export function toBlob(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

export function fromBlob(buf: Uint8Array | null): Float32Array | null {
  if (!buf) return null;
  // Buffer may be unaligned relative to a Float32Array view, so copy via a new ArrayBuffer.
  const copy = new ArrayBuffer(buf.byteLength);
  new Uint8Array(copy).set(buf);
  return new Float32Array(copy);
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Deterministic hashed bag-of-words embedding.
 *
 * Not competitive with a real model, but it is a genuine vector representation:
 * texts sharing vocabulary land close together, which makes the whole retrieval
 * pipeline exercisable with zero network and zero API keys. The demo laptop swaps
 * in `multilingual-e5-small` by changing one env var.
 */
export function createFakeEmbedder(dims = 256): EmbeddingProvider {
  return {
    name: 'fake-hashed',
    model: 'hashed-bow-v1',
    dims,

    async embed(texts: string[]) {
      return texts.map((text) => hashedVector(text, dims));
    },

    async healthCheck() {
      return { ok: true, detail: `deterministic ${dims}-dim hashed embedder` };
    },
  };
}

export function hashedVector(text: string, dims: number): Float32Array {
  const vec = new Float32Array(dims);
  const tokens = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  for (const token of tokens) {
    const h = deterministicHash(token);
    const idx = parseInt(h.slice(0, 8), 16) % dims;
    const sign = parseInt(h.slice(8, 10), 16) % 2 === 0 ? 1 : -1;
    // Two independent hash slots reduce collision-induced noise.
    const idx2 = parseInt(h.slice(10, 18), 16) % dims;
    vec[idx] = vec[idx]! + sign;
    vec[idx2] = vec[idx2]! + sign * 0.5;
  }
  return normalize(vec);
}

export function normalize(vec: Float32Array): Float32Array {
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm);
  if (norm === 0) return vec;
  for (let i = 0; i < vec.length; i++) vec[i] = vec[i]! / norm;
  return vec;
}

export interface OpenAiEmbeddingOptions {
  baseUrl: string;
  apiKey?: string;
  model: string;
  dims?: number;
}

/**
 * Covers cloud (text-embedding-3-small) and the demo laptop's local
 * sentence-transformers server (intfloat/multilingual-e5-small) through the same
 * OpenAI-compatible `/embeddings` endpoint.
 */
export function createOpenAiEmbedder(opts: OpenAiEmbeddingOptions): EmbeddingProvider {
  const base = opts.baseUrl.replace(/\/+$/, '');

  return {
    name: 'openai-compatible',
    model: opts.model,
    dims: opts.dims ?? config.embed.dims,

    async embed(texts: string[]) {
      const res = await fetch(`${base}/embeddings`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}),
        },
        body: JSON.stringify({ model: opts.model, input: texts }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) throw new Error(`Embedding HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);

      const json = (await res.json()) as { data?: Array<{ embedding: number[]; index: number }> };
      const ordered = (json.data ?? []).slice().sort((a, b) => a.index - b.index);
      if (!ordered.length) throw new Error('Embedding response contained no vectors');
      return ordered.map((d) => normalize(Float32Array.from(d.embedding)));
    },

    async healthCheck() {
      try {
        const res = await fetch(`${base}/models`, {
          headers: opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {},
          signal: AbortSignal.timeout(2500),
        });
        return { ok: res.ok, detail: `GET ${base}/models -> ${res.status}` };
      } catch (err) {
        return { ok: false, detail: err instanceof Error ? err.message : String(err) };
      }
    },

    async free() {
      // Nothing resident client-side; the local server owns GPU memory.
    },
  };
}

export function createEmbeddingProvider(): EmbeddingProvider {
  if (config.embed.provider === 'fake') {
    log.info('using deterministic offline embedder');
    return createFakeEmbedder(config.embed.dims);
  }
  const baseUrl = config.embed.baseUrl || 'https://api.openai.com/v1';
  const model = config.embed.model || 'text-embedding-3-small';
  return createOpenAiEmbedder({ baseUrl, apiKey: config.embed.apiKey, model, dims: config.embed.dims });
}