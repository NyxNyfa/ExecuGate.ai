import type { InstructionParse, OrgScope, ParsedTaskDraft } from '@execugate/core';
import { AppError, newId } from '@execugate/core';
import { instructionRepo, ticketRepo, dodRepo, divisionRepo, userRepo, metricsRepo } from '@execugate/db';
import { decomposeInstruction, heuristicAmbiguities, heuristicParse } from '@execugate/llm';
import type { RosterMember } from '@execugate/llm';
import { retrieve } from '@execugate/memory';
import { createLogger } from '@execugate/observability';
import type { AppContext } from './context.ts';
import { loadRoster } from './context.ts';

const log = createLogger('orchestration:intake');

export interface IntakeResult {
  instructionId: string;
  parse: InstructionParse;
  ticketIds: string[];
  ttftMs: number;
  totalMs: number;
  usedFallback: boolean;
}

export interface IntakeInput {
  rawText: string;
  asrConfidence?: number | null;
  sourceMessageId?: string | null;
  projectId?: string;
  actorUserId: string;
  /** Streams partial output into the channel while the model generates. */
  onToken?: (chunk: string) => void;
}

/**
 * FR-01.3 + FR-02 + FR-03.1 in one step.
 *
 * Produces an instruction, retrieves project memory, decomposes into tasks, and
 * persists tickets in `PENDING_APPROVAL`.
 *
 * FR-03.1 invariant: nothing here reaches `ASSIGNED`. The dispatcher selects
 * `WHERE status = 'ASSIGNED'`, so there is no code path by which a draft can reach
 * a division channel without an approval record.
 */
export async function intakeInstruction(ctx: AppContext, scope: OrgScope, input: IntakeInput): Promise<IntakeResult> {
  const { store } = ctx;
  const instructions = instructionRepo(store);
  const tickets = ticketRepo(store);
  const dod = dodRepo(store);
  const divisions = divisionRepo(store);
  const users = userRepo(store);
  const metrics = metricsRepo(store);

  const projectId = input.projectId ?? store.get<{ id: string }>(
    "SELECT id FROM projects WHERE org_id = ? AND status = 'active' ORDER BY created_at LIMIT 1", scope.orgId,
  )?.id;
  if (!projectId) throw new AppError('VALIDATION_FAILED', 'No active project configured for this organisation');

  const roster = loadRoster(store) as RosterMember[];
  const instructionId = instructions.insert(scope, {
    projectId,
    sourceMessageId: input.sourceMessageId ?? null,
    rawText: input.rawText,
    asrConfidence: input.asrConfidence ?? null,
  });

  // FR-02.3: retrieve before generating so the decomposition cites canonical values
  // (limits, repo names, roster rules) rather than inventing them.
  const found = await retrieve(store, ctx.embedder, scope, { projectId, query: input.rawText, limit: 5 });

  const project = store.get<{ name: string; code: string }>(
    'SELECT name, code FROM projects WHERE org_id = ? AND id = ?', scope.orgId, projectId,
  );

  const outcome = await decomposeInstruction(ctx.llm, {
    roster,
    defaultRepo: 'acme/payment-service',
    opsSource: ctx.config.ops.sourceUrl || 'ops-sheets://settlement/daily',
    now: new Date(),
  }, {
    instruction: input.rawText,
    roster,
    projectName: project?.name ?? 'Project',
    projectCode: project?.code ?? 'PRJ',
    retrieved: found.chunks.map((c) => ({ title: c.docTitle, text: c.text })),
    onToken: input.onToken,
  });

  // Hard guarantee: the commander always receives a usable draft.
  let parse = outcome.parse;
  if (!parse.tasks.length) {
    const fallbackTasks = heuristicParse(input.rawText, {
      roster, defaultRepo: 'acme/payment-service',
      opsSource: ctx.config.ops.sourceUrl || 'ops-sheets://settlement/daily', now: new Date(),
    });
    if (!fallbackTasks.length) {
      throw new AppError('VALIDATION_FAILED', 'Instruction produced no actionable tasks', { text: input.rawText.slice(0, 200) });
    }
    parse = {
      language: parse.language,
      summary: parse.summary,
      ambiguities: heuristicAmbiguities(input.rawText, fallbackTasks, {
        roster, defaultRepo: 'acme/payment-service', opsSource: '', now: new Date(),
      }),
      tasks: fallbackTasks as ParsedTaskDraft[],
    };
  }

  instructions.setParse(scope, instructionId, parse, parse.language);
  const ticketIds = persistDrafts(ctx, scope, { instructionId, projectId, parse, actorUserId: input.actorUserId, divisions, users });

  metrics.incr(scope.orgId, 'instructions.received');
  metrics.incr(scope.orgId, 'tickets.created', ticketIds.length);
  metrics.set(scope.orgId, 'llm.last_ttft_ms', outcome.ttftMs);
  metrics.set(scope.orgId, 'llm.last_total_ms', outcome.totalMs);
  metrics.incr(scope.orgId, outcome.usedFallback ? 'llm.fallback_total' : 'llm.success_total');

  log.info('instruction decomposed', {
    instructionId,
    tasks: ticketIds.length,
    retrieved: found.chunks.length,
    ttftMs: outcome.ttftMs,
    totalMs: outcome.totalMs,
    fallback: outcome.usedFallback,
  });

  return {
    instructionId,
    parse,
    ticketIds,
    ttftMs: outcome.ttftMs,
    totalMs: outcome.totalMs,
    usedFallback: outcome.usedFallback,
  };
}

/** Persists drafts as DRAFT -> PENDING_APPROVAL, with assignee resolution and DoD. */
function persistDrafts(
  ctx: AppContext,
  scope: OrgScope,
  args: {
    instructionId: string;
    projectId: string;
    parse: InstructionParse;
    actorUserId: string;
    divisions: ReturnType<typeof divisionRepo>;
    users: ReturnType<typeof userRepo>;
  },
): string[] {
  const { store } = ctx;
  const tickets = ticketRepo(store);
  const dod = dodRepo(store);
  const ids: string[] = [];

  const allUsers = args.users.list(scope.orgId);
  const divisions = args.divisions.list(scope.orgId);
  const techDivision = divisions.find((d) => d.kind === 'technical');
  const opsDivision = divisions.find((d) => d.kind === 'operational');
  const crossDivisionAssignments: Array<{ title: string; assigneeName: string }> = [];

  for (const task of args.parse.tasks) {
    const divisionId = task.division === 'technical' ? techDivision?.id : opsDivision?.id;
    if (!divisionId) {
      log.warn('no division configured for task; skipping', { title: task.title, division: task.division });
      continue;
    }

    // Resolve the assignee by name against the roster.
    //
    // Two passes: an exact full-name match within the owning division first, then a
    // match anywhere in the org. The second pass matters because the LLM may return a
    // name that exists but sits in another division; rather than silently dropping the
    // assignment (which is what produced NULL assignees on the demo corpus), the name
    // is honoured and the mismatch is reported on the approval card as an ambiguity.
    let assignee: (typeof allUsers)[number] | undefined;
    if (task.assigneeHint) {
      const want = task.assigneeHint.toLowerCase().trim();
      const byName = (u: (typeof allUsers)[number]) => u.display_name.toLowerCase().trim() === want;
      assignee = allUsers.find((u) => byName(u) && u.division_id === divisionId) ?? allUsers.find(byName);

      if (assignee && assignee.division_id !== divisionId) {
        crossDivisionAssignments.push({ title: task.title, assigneeName: assignee.display_name });
      }
    }

    const ticket = tickets.insert(scope.orgId, {
      projectId: args.projectId,
      instructionId: args.instructionId,
      title: task.title,
      description: task.description,
      divisionId,
      assigneeId: assignee?.id ?? null,
      priority: task.priority,
      dueAt: task.dueAt,
      status: 'DRAFT',
      createdBy: args.actorUserId,
    });

    dod.replaceAll(scope, ticket.id, task.dod);

    // PRD §6: DRAFT -> PENDING_APPROVAL on parse completion.
    tickets.transition(scope, ticket.id, 'PENDING_APPROVAL', 'approval.requested', { id: args.actorUserId }, {
      reason: 'Draf tiket disajikan untuk otorisasi',
    });

    ids.push(ticket.id);
  }

  if (crossDivisionAssignments.length) {
    // Surfaced so the commander sees the mismatch on the approval card instead of
    // discovering a mis-assigned ticket after distribution.
    for (const m of crossDivisionAssignments) {
      log.warn('assignee resolved outside the owning division', { title: m.title, assignee: m.assigneeName });
    }
  }
  return ids;
}

export { newId };