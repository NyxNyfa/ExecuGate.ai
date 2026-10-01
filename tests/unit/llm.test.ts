import { describe, it, expect } from 'vitest';
import {
  extractJson, repairJson, parseStructured, splitClauses, detectDivision,
  detectDueDate, detectAssignee, deriveTitle, deriveBranch, heuristicParse,
  heuristicAmbiguities,
} from '@execugate/llm';
import { z } from 'zod';
import type { HeuristicContext } from '@execugate/llm';

const ctx: HeuristicContext = {
  roster: [
    { name: 'Rahma Dewi', role: 'commander', division: 'management', specializations: ['project owner'] },
    { name: 'Budi Santoso', role: 'technical', division: 'technical', specializations: ['payment service', 'backend'] },
    { name: 'Rina Kartika', role: 'technical', division: 'technical', specializations: ['CI/CD', 'docker'] },
    { name: 'Sari Wijaya', role: 'ops', division: 'operational', specializations: ['reconciliation', 'settlement'] },
  ],
  defaultRepo: 'acme/payment-service',
  opsSource: 'ops-sheets://settlement/daily',
  now: new Date('2026-09-30T08:00:00+07:00'),
};

describe('JSON extraction and repair', () => {
  it('reads a bare object', () => {
    expect(extractJson('{"a":1}')).toBe('{"a":1}');
  });

  it('reads a fenced block', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it('reads an object embedded in prose', () => {
    expect(extractJson('Ini hasilnya: {"a":1} semoga membantu.')).toBe('{"a":1}');
  });

  it('ignores braces inside string values', () => {
    expect(extractJson('{"a":"}{ not a brace","b":2}')).toBe('{"a":"}{ not a brace","b":2}');
  });

  it('honours escaped quotes', () => {
    expect(extractJson('{"a":"say \\"hi\\"","b":2}')).toBe('{"a":"say \\"hi\\"","b":2}');
  });

  it('returns null when there is no JSON at all', () => {
    expect(extractJson('maaf, saya tidak bisa')).toBeNull();
  });

  it('strips trailing commas, comments and Python literals', () => {
    const repaired = repairJson('{"a":1, /* c */ "b":True, "c":None,}');
    expect(JSON.parse(repaired)).toEqual({ a: 1, b: true, c: null });
  });
});

describe('parseStructured', () => {
  const schema = z.object({ name: z.string(), count: z.number() });

  it('validates clean output on the first attempt', () => {
    const r = parseStructured('{"name":"a","count":2}', schema);
    expect(r.attempts).toBe(1);
    expect(r.usedFallback).toBe(false);
    expect(r.value.count).toBe(2);
  });

  it('repairs and succeeds on output needing fixes', () => {
    const r = parseStructured('{"name":"a","count":2,}', schema);
    expect(r.value).toEqual({ name: 'a', count: 2 });
  });

  it('throws LLM_INVALID_OUTPUT when nothing satisfies the schema', () => {
    expect(() => parseStructured('{"name":123}', schema)).toThrow(/failed validation/i);
  });

  it('binds defaulted fields as present in the output type', () => {
    const withDefault = z.object({ n: z.number().default(7) });
    const r = parseStructured('{}', withDefault);
    // If T were inferred as the input type this would be `number | undefined`.
    expect(r.value.n).toBe(7);
  });
});

describe('clause splitting', () => {
  it('splits on connectors', () => {
    expect(splitClauses('deploy payment service sekalian update SOP')).toHaveLength(2);
  });

  it('separates a trailing person modifier from the work clause', () => {
    const clauses = splitClauses('deploy payment service, Mas Budi yang infra, deadline Kamis');
    expect(clauses.some((c) => /infra/i.test(c))).toBe(true);
    expect(clauses.some((c) => /deadline/i.test(c))).toBe(true);
  });

  it('splits "dan" only when the tail is recognisable work', () => {
    expect(splitClauses('buat laporan keuangan dan review pipeline docker')).toHaveLength(2);
    // "pendapatan dan biaya" is one task, not two.
    expect(splitClauses('rekap pendapatan dan biaya')).toHaveLength(1);
  });
});

describe('field extraction', () => {
  it('classifies technical vs operational', () => {
    expect(detectDivision('deploy payment service')).toBe('technical');
    expect(detectDivision('update SOP reconciliation')).toBe('operational');
    expect(detectDivision('makan siang')).toBeNull();
  });

  it('resolves relative and absolute dates', () => {
    expect(detectDueDate('besok pagi', ctx.now)).toBe('2026-10-01');
    expect(detectDueDate('hari ini', ctx.now)).toBe('2026-09-30');
    expect(detectDueDate('dalam 3 hari', ctx.now)).toBe('2026-10-03');
    expect(detectDueDate('tenggat 2026-12-01', ctx.now)).toBe('2026-12-01');
    expect(detectDueDate('tanpa tanggal', ctx.now)).toBeNull();
  });

  it('matches full names, honorifics and unambiguous first names', () => {
    expect(detectAssignee('kCBDI, Mas Budi yang handles ini', ctx.roster)?.name).toBe('Budi Santoso');
    expect(detectAssignee('tolong Budi Santoso tangani', ctx.roster)?.name).toBe('Budi Santoso');
    expect(detectAssignee('Sari tolong cek stok', ctx.roster)?.name).toBe('Sari Wijaya');
    expect(detectAssignee('apa kabar', ctx.roster)).toBeNull();
  });

  it('keeps a meaningful trailing token in derived titles', () => {
    expect(deriveTitle('Buatkan laporan keuangan bulan ini')).toContain('bulan ini');
  });

  it('derives branch names by intent', () => {
    expect(deriveBranch('Perbaiki bug refund')).toMatch(/^fix\//);
    expect(deriveBranch('Update SOP rekonsiliasi')).toMatch(/^chore\//);
    expect(deriveBranch('Tambah endpoint')).toMatch(/^feat\//);
  });
});

describe('heuristic decomposition', () => {
  const instruction = 'Besok pagi deploy payment service ya, sekalian update SOP reconciliation, Mas Budi yang infra, deadline Kamis.';

  it('splits the demo instruction into two correctly-scoped tasks', () => {
    const tasks = heuristicParse(instruction, ctx);
    expect(tasks).toHaveLength(2);
    expect(tasks[0]!.division).toBe('technical');
    expect(tasks[1]!.division).toBe('operational');
  });

  it('does not promote a person-only modifier clause into a task', () => {
    const tasks = heuristicParse(instruction, ctx);
    expect(tasks.some((t) => /^budi$/i.test(t.title))).toBe(false);
    expect(tasks.some((t) => /deadline kamis/i.test(t.title))).toBe(false);
  });

  it('attaches the named person to the matching division only', () => {
    const tasks = heuristicParse(instruction, ctx);
    expect(tasks[0]!.assigneeHint).toBe('Budi Santoso');
    // Budi is technical; the ops task must not silently inherit him.
    expect(tasks[1]!.assigneeHint).toBeNull();
  });

  it('gives every engineering task a machine-executable github_pr check (FR-05.1)', () => {
    for (const task of heuristicParse(instruction, ctx)) {
      expect(task.dod.length).toBeGreaterThan(0);
      for (const d of task.dod) expect(d.check.type).toBeTruthy();
      if (task.division === 'technical') {
        expect(task.dod.some((d) => d.check.type === 'github_pr')).toBe(true);
      }
    }
  });

  it('gives reconciliation work an explicit reconciliation check', () => {
    const tasks = heuristicParse('rekap settlement bank hari ini', ctx);
    expect(tasks[0]!.dod.some((d) => d.check.type === 'reconciliation')).toBe(true);
  });

  it('detects urgency as P0', () => {
    expect(heuristicParse('urgent patch bug refund', ctx)[0]!.priority).toBe('P0');
  });

  it('flags unstated priority and allocation as ambiguities rather than guessing silently', () => {
    const tasks = heuristicParse('deploy payment service', ctx);
    const ambiguities = heuristicAmbiguities('deploy payment service', tasks, ctx);
    expect(ambiguities.join(' ')).toMatch(/prioritas/i);
  });

  it('returns nothing actionable for a non-work instruction', () => {
    expect(heuristicParse('halo apa kabar', ctx)).toHaveLength(0);
  });
});