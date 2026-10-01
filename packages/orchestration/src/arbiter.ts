import { config } from '@execugate/core';
import { createLogger } from '@execugate/observability';

const log = createLogger('orchestration:arbiter');

export type GpuRole = 'asr' | 'llm' | 'embed';

export interface Releasable {
  free?(): Promise<void>;
}

/**
 * Approximate VRAM footprint per role, in MiB, for the 4 GB demo laptop
 * (BUILD_PLAN §9.1): whisper `small` int8_float16, Qwen2.5-3B Q4_K_M, and
 * multilingual-e5-small. Deliberately pessimistic — over-reserving is free, whereas
 * an out-of-memory error during a demo is not.
 *
 * The LLM figure includes the KV cache for an 8k context, not just the weights
 * (~2.0 GB for Qwen2.5-3B Q4_K_M). llama.cpp allocates that cache as soon as the
 * context opens, and omitting it makes the budget look feasible when it is not.
 */
const DEFAULT_FOOTPRINT: Record<GpuRole, number> = { asr: 1100, llm: 2560, embed: 560 };

export interface ArbiterOptions {
  asr?: Releasable;
  llm?: Releasable;
  /** Keyed to match `GpuRole`, so a role name and its provider key never diverge. */
  embed?: Releasable;
  /** Total usable VRAM in MiB. Set from VRAM_BUDGET_MB on the demo laptop. */
  budgetMb?: number;
  footprint?: Record<GpuRole, number>;
}

/**
 * Serialises GPU-resident roles so only one is loaded at a time.
 *
 * The demo laptop has 4 GB. Whisper plus a 3B LLM plus an embedding model do not fit
 * together, and the providers each expose a `free()` that nothing else calls. Without
 * an explicit arbiter the first request of each kind loads a model and keeps it
 * resident, and the machine dies partway through a demo.
 *
 * The rule is simply "one resident role at a time", which fits comfortably inside any
 * budget large enough for the largest single model. Releasing a model that was never
 * loaded is a no-op, so the cost of the invariant is one extra call per switch.
 */
export class ModelArbiter {
  private resident: GpuRole | null = null;
  private readonly providers: Record<'asr' | 'llm' | 'embed', Releasable | undefined>;
  private readonly budgetMb: number;
  private readonly footprint: Record<GpuRole, number>;
  /** Serialises acquisition so two concurrent requests cannot both load a model. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(opts: ArbiterOptions = {}) {
    this.providers = { asr: opts.asr, llm: opts.llm, embed: opts.embed };
    this.budgetMb = opts.budgetMb ?? config.vram.budgetMb;
    this.footprint = opts.footprint ?? DEFAULT_FOOTPRINT;
    this.validateBudget();
  }

  private validateBudget(): void {
    const largest = Math.max(...Object.values(this.footprint));
    if (this.budgetMb < largest) {
      log.warn('VRAM budget is below the largest single model', {
        budgetMb: this.budgetMb,
        largestModelMb: largest,
      });
    }
  }

  get activeRole(): GpuRole | null {
    return this.resident;
  }

  /** True when no role can occupy local VRAM, so arbitration is pure overhead. */
  get allRemote(): boolean {
    return !this.providers.asr && !this.providers.llm && !this.providers.embed;
  }

  /**
   * Runs `fn` with `role` resident, releasing whichever other role currently holds
   * the GPU. Calls are serialised so concurrent requests cannot race two models in.
   */
  async withRole<T>(role: GpuRole, fn: () => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      if (this.resident === role) return fn();

      // Release the outgoing role only. Calling free() on the incoming role here would
      // unload the model we are about to use.
      await this.releaseAll();
      this.resident = role;
      log.debug('gpu role acquired', { role, footprintMb: this.footprint[role] });
      return fn();
    };

    // Chain onto the previous acquisition so switches cannot interleave.
    const next = this.chain.then(run, run);
    this.chain = next.catch(() => undefined);
    return next;
  }

  /** Releases the current role. Safe to call when nothing is resident. */
  async releaseAll(): Promise<void> {
    if (!this.resident) return;
    const role = this.resident;
    try {
      await this.providers[role]?.free?.();
      log.debug('gpu role released', { role });
    } catch (err) {
      // A failed release must not block the next role from loading.
      log.warn('gpu release failed', { role, error: err instanceof Error ? err.message : String(err) });
    } finally {
      this.resident = null;
    }
  }

  status() {
    return {
      budgetMb: this.budgetMb,
      resident: this.resident,
      footprintMb: this.footprint,
      allRemote: this.allRemote,
    };
  }
}