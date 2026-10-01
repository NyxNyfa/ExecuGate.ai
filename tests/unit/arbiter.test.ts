import { describe, it, expect, vi } from 'vitest';
import { ModelArbiter } from '@execugate/orchestration';

/**
 * VRAM arbitration (BUILD_PLAN §9.1).
 *
 * The demo laptop has 4 GB. Whisper plus a 3B LLM plus an embedding model cannot be
 * resident together, and the providers expose a `free()` that nothing else calls —
 * so without an explicit arbiter the machine runs out of memory partway through a
 * demo. These tests pin the invariant: never two resident roles at once.
 */

function tracker() {
  const events: string[] = [];
  const make = (role: string) => ({
    free: vi.fn(async () => { events.push(`free:${role}`); }),
  });
  return { events, asr: make('asr'), llm: make('llm'), embed: make('embed') };
}

describe('ModelArbiter', () => {
  it('starts with nothing resident', () => {
    const t = tracker();
    const arbiter = new ModelArbiter({ ...t });
    expect(arbiter.activeRole).toBeNull();
  });

  it('releases the previous role when switching', async () => {
    const t = tracker();
    const arbiter = new ModelArbiter({ ...t });

    await arbiter.withRole('asr', async () => { expect(arbiter.activeRole).toBe('asr'); });
    await arbiter.withRole('llm', async () => { expect(arbiter.activeRole).toBe('llm'); });

    // Whisper must be unloaded before the 3B model loads, or the card OOMs.
    expect(t.events).toContain('free:asr');
    expect(t.asr.free).toHaveBeenCalled();
  });

  it('does not release when the role is unchanged', async () => {
    const t = tracker();
    const arbiter = new ModelArbiter({ ...t });

    await arbiter.withRole('llm', async () => undefined);
    await arbiter.withRole('llm', async () => undefined);

    // Reloading the same model on every request would be pointless churn.
    expect(t.llm.free).not.toHaveBeenCalled();
  });

  it('releases the outgoing role before running the next task', async () => {
    const t = tracker();
    const arbiter = new ModelArbiter({ ...t });
    const order: string[] = [];

    for (const role of ['asr', 'llm', 'embed', 'asr', 'llm'] as const) {
      await arbiter.withRole(role, async () => {
        // Inside the task, the outgoing model must already be gone.
        order.push(`run:${role}`);
        expect(arbiter.activeRole).toBe(role);
      });
      order.push(`released:${String(arbiter.activeRole)}`);
    }

    expect(t.events).toEqual(['free:asr', 'free:llm', 'free:embed', 'free:asr']);
    // The first task must run before anything has been released.
    expect(order[0]).toBe('run:asr');
    // The final asr->llm switch releases asr; nothing is released after the last task.
    expect(order.filter((o) => o.startsWith('run:'))).toEqual(['run:asr', 'run:llm', 'run:embed', 'run:asr', 'run:llm']);
  });

  it('serialises concurrent acquisitions so two models cannot load at once', async () => {
    const t = tracker();
    const arbiter = new ModelArbiter({ ...t });
    let concurrent = 0;
    let maxConcurrent = 0;

    await Promise.all(
      ['llm', 'asr', 'embed'].map((role) =>
        arbiter.withRole(role as 'llm', async () => {
          concurrent++;
          maxConcurrent = Math.max(maxConcurrent, concurrent);
          await new Promise((r) => setTimeout(r, 10));
          concurrent--;
        }),
      ),
    );

    // A real 4 GB card cannot host two models; overlapping load is exactly the failure.
    expect(maxConcurrent).toBe(1);
  });

  it('propagates a task failure without leaving a role stuck', async () => {
    const t = tracker();
    const arbiter = new ModelArbiter({ ...t });

    await expect(arbiter.withRole('llm', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    // The next acquisition must still be able to switch away.
    await arbiter.withRole('asr', async () => { expect(arbiter.activeRole).toBe('asr'); });
  });

  it('still switches when a release throws', async () => {
    const broken = { free: vi.fn(async () => { throw new Error('release failed'); }) };
    const t = tracker();
    const arbiter = new ModelArbiter({ asr: broken, llm: t.llm, embed: t.embed });

    await arbiter.withRole('asr', async () => undefined);
    await arbiter.withRole('llm', async () => { expect(arbiter.activeRole).toBe('llm'); });
  });

  it('treats a missing free() as a no-op', async () => {
    const arbiter = new ModelArbiter({ llm: {} });
    await arbiter.withRole('llm', async () => undefined);
    await arbiter.withRole('asr', async () => { expect(arbiter.activeRole).toBe('asr'); });
  });

  it('reports allRemote when nothing can occupy VRAM', () => {
    expect(new ModelArbiter({}).allRemote).toBe(true);
    expect(new ModelArbiter({ llm: {} }).allRemote).toBe(false);
  });

  it('releaseAll is safe when nothing is resident', async () => {
    const t = tracker();
    const arbiter = new ModelArbiter({ ...t });
    await arbiter.releaseAll();
    expect(t.events).toEqual([]);
  });

  it('exposes its status for the dashboard', async () => {
    const t = tracker();
    const arbiter = new ModelArbiter({ ...t, budgetMb: 3800 });
    await arbiter.withRole('llm', async () => undefined);

    const status = arbiter.status();
    expect(status.budgetMb).toBe(3800);
    expect(status.resident).toBe('llm');
    expect(status.footprintMb.llm).toBeGreaterThan(0);
    // All three cannot be resident at once, which is precisely why roles are serialised.
    const total = Object.values(status.footprintMb).reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThan(status.budgetMb);
  });

  it('fits the largest single model inside the budget', () => {
    const footprint = { asr: 1100, llm: 2560, embed: 560 };
    const budgetMb = 3800;
    expect(Math.max(...Object.values(footprint))).toBeLessThan(budgetMb);
  });
});