import type { Store } from '@execugate/db';
import { getStore } from '@execugate/db';
import { config, describeRuntime } from '@execugate/core';
import { createEmbeddingProvider } from '@execugate/memory';
import type { EmbeddingProvider } from '@execugate/memory';
import { createAsrProvider } from '@execugate/asr';
import type { AsrProvider } from '@execugate/asr';
import { createLlmProvider } from '@execugate/llm';
import type { LlmProvider } from '@execugate/llm';
import { GatekeeperEngine } from '@execugate/gatekeeper';
import { createLogger } from '@execugate/observability';
import { ModelArbiter } from './arbiter.ts';

const log = createLogger('orchestration');

export interface AppContext {
  store: Store;
  embedder: EmbeddingProvider;
  asr: AsrProvider;
  llm: LlmProvider;
  gatekeeper: GatekeeperEngine;
  /** Serialises GPU-resident roles so a 4 GB card never holds two models at once. */
  arbiter: ModelArbiter;
  config: typeof config;
}

let cached: AppContext | null = null;

/**
 * Wires the whole dependency graph once per process.
 *
 * Provider selection is env-driven, so the build machine runs entirely on `fake`
 * providers while the demo laptop swaps in llama.cpp + faster-whisper by changing
 * configuration only (ADR-6).
 */
export function createContext(overrides: Partial<AppContext> = {}): AppContext {
  const store = overrides.store ?? getStore();
  store.migrate();

  const roster = loadRoster(store);
  const heuristicCtx = {
    roster,
    defaultRepo: 'acme/payment-service',
    opsSource: config.ops.sourceUrl || 'ops-sheets://settlement/daily',
    now: new Date(),
  };

  const embedder = overrides.embedder ?? createEmbeddingProvider();
  const asr = overrides.asr ?? createAsrProvider();
  const llm = overrides.llm ?? createLlmProvider(heuristicCtx);

  const ctx: AppContext = {
    store,
    embedder,
    asr,
    llm,
    gatekeeper: overrides.gatekeeper ?? new GatekeeperEngine(),
    // Only arbitrate when something can actually occupy local VRAM; with cloud
    // providers the serialisation would be pure overhead.
    arbiter: new ModelArbiter({ asr, llm, embed: embedder, budgetMb: config.vram.budgetMb }),
    config,
  };

  log.info('context ready', { runtime: describeRuntime(), vram: config.vram.budgetMb });
  return ctx;
}

export function getContext(): AppContext {
  cached ??= createContext();
  return cached;
}

export function setContext(ctx: AppContext): void {
  cached = ctx;
}

/** Roster in the shape the heuristic parser and prompts expect. */
export function loadRoster(store: Store) {
  const orgs = store.all<{ id: string }>('SELECT id FROM organizations ORDER BY created_at LIMIT 1');
  const orgId = orgs[0]?.id;
  if (!orgId) return [];

  const divisions = new Map(
    store.all<{ id: string; kind: 'management' | 'technical' | 'operational' }>('SELECT id, kind FROM divisions WHERE org_id = ?', orgId)
      .map((d) => [d.id, d.kind]),
  );

  return store
    .all<{ id: string; display_name: string; role: 'commander' | 'technical' | 'ops' | 'admin'; division_id: string | null; specializations: string }>(
      "SELECT id, display_name, role, division_id, specializations FROM users WHERE org_id = ? AND active = 1",
      orgId,
    )
    .map((u) => ({
      name: u.display_name,
      role: u.role,
      division: divisions.get(u.division_id ?? '') ?? 'management',
      specializations: safeParse(u.specializations),
    }));
}

function safeParse(json: string): string[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}