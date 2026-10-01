import { config } from '@execugate/core';
import { createContext } from '@execugate/orchestration';
import type { Actor, InboundMessage, OrgScope } from '@execugate/core';
import { TelegramAdapter, ChannelRouter, renderApprovalCard, renderTicketCard, renderStaffActions, renderReworkNotice, renderWalkthrough, renderAnswer } from '@execugate/channels';
import { userRepo, divisionRepo, ticketRepo, messageRepo, idempotencyRepo, instructionRepo, projectRepo, clarificationRepo } from '@execugate/db';
import type { ApprovalDecision } from '@execugate/orchestration/approval';
import {
  intakeInstruction, handleApproval, acknowledgeTicket, askClarification,
  submitEvidence, runGatekeeper, buildWalkthrough, isWalkthroughRequest,
  buildTicketCardData, referenceDocs, loadRoster,
} from '@execugate/orchestration';
import { transcribeSafe } from '@execugate/asr';
import { routeStaffText, createConversationState } from './questions.ts';
import { createLogger } from '@execugate/observability';

const log = createLogger('bot');

/**
 * The Telegram runtime: normalises inbound traffic into domain actions and renders
 * every reply. All decision logic lives in `@execugate/orchestration` — this file is
 * transport plus presentation, which keeps the golden path testable without Telegram.
 */
async function main() {
  const ctx = createContext();
  const store = ctx.store;
  const users = userRepo(store);
  const divisions = divisionRepo(store);

  const orgRow = store.get<{ id: string }>('SELECT id FROM organizations ORDER BY created_at LIMIT 1');
  if (!orgRow) throw new Error('No organisation found. Run: npm run seed');
  // Bound as a plain const so narrowing survives inside the nested closures below.
  const orgId = orgRow.id;
  const scope: OrgScope = { orgId };
  const channelId = 'telegram-main';
  const state = createConversationState();
  const divisionList = divisionRepo(store).list(orgId);

  // Resolve chat ids to real staff so inbound traffic carries a tenant and a role.
  if (config.telegram.commanderChatId) {
    const commander = users.byExternal(orgId, config.telegram.commanderChatId);
    if (!commander) log.warn('commander chat id not bound to a seeded user', { chatId: config.telegram.commanderChatId });
  }

  const adapter = new TelegramAdapter({ token: config.telegram.token, pollIntervalMs: 250 });
  const router = new ChannelRouter(adapter);
  if (config.telegram.techDivisionChatId) router.route('technical', config.telegram.techDivisionChatId);
  if (config.telegram.opsDivisionChatId) router.route('operational', config.telegram.opsDivisionChatId);

  const actorFor = (senderExternalId: string): Actor | null => {
    const user = users.byExternal(orgId, senderExternalId);
    if (!user || !user.active) return null;
    return { orgId, userId: user.id, role: user.role, divisionId: user.division_id, displayName: user.display_name };
  };

  const reply = async (target: string, text: string, actions?: Array<{ label: string; callbackData: string }>) =>
    adapter.send(target, { target, text, actions, parseMode: 'markdown' });

  /** FR-01.2 — a low-confidence transcript is flagged rather than trusted. */
  const confidenceWarning = (confidence: number | null) =>
    confidence !== null && confidence < 0.55
      ? '⚠️ Transkripsi suara kurang yakin — mohon koreksi sebelum menyetujui.\n\n'
      : '';

  adapter.onInbound(async (msg: InboundMessage) => {
    // Telegram replays updates after a long-poll timeout. Claiming the update id
    // prevents one voice note from becoming two instructions and two ticket sets.
    if (!idempotencyRepo(store).claim(channelId, msg.externalId)) {
      log.debug('duplicate update ignored', { externalId: msg.externalId });
      return;
    }

    const actor = actorFor(msg.senderExternalId);
    if (!actor) {
      log.warn('update from unknown sender', { senderExternalId: msg.senderExternalId });
      return;
    }

    try {
      if (msg.kind === 'callback') return await handleCallback(msg, actor);
      if (msg.kind === 'voice' && msg.mediaRef) return await handleVoice(msg, actor);
      if (msg.kind === 'text' && msg.text) {
        // Staff traffic is checked first: a question inside a ticket thread must not
        // be mistaken for a commander instruction.
        if (await routeStaffText({ ctx, adapter, state, scope, commanderChatId: config.telegram.commanderChatId || null }, msg, actor)) return;
        return await handleText(msg.text, actor);
      }
    } catch (err) {
      const code = (err as { code?: string })?.code ?? 'ERROR';
      log.error('handling failed', { code, error: err instanceof Error ? err.message : String(err) });
      await reply(String(msg.senderExternalId), `⚠️ Gagal diproses (${code}). Silakan coba ulang atau hubungi administrator.`);
    } finally {
      idempotencyRepo(store).release(channelId, msg.externalId);
    }
  });

  async function handleText(text: string, actor: Actor): Promise<void> {
    // FR-06.1 — the walkthrough can be requested in plain language, with no command syntax.
    if (isWalkthroughRequest(text)) {
      const report = buildWalkthrough(ctx, scope);
      await reply(String(actor.userId), renderWalkthrough(report));
      return;
    }
    await decomposeAndPresent(text, null, actor);
  }

  async function handleVoice(msg: InboundMessage, actor: Actor): Promise<void> {
    const target = String(msg.senderExternalId);
    // FR-01.2 acknowledgement: the commander sees progress immediately, because a
    // transcription plus decomposition round trip is not instant.
    await reply(target, '🎧 Menerima voice note, sedang mentranskripsi...');

    const { result, error } = await transcribeSafe(ctx.asr, msg.mediaRef!, {
      language: config.asr.language || undefined,
    });
    if (msg.mediaRef) await adapter.discardMedia(msg.mediaRef);

    if (error || !result.text) {
      await reply(target, '⚠️ Transkripsi gagal. Mohon kirim arahan berupa teks.');
      return;
    }
    log.info('transcribed voice note', { provider: result.provider, confidence: result.confidence, ms: result.durationMs });

    await decomposeAndPresent(result.text, result.confidence, actor, target);
  }

  async function decomposeAndPresent(rawText: string, asrConfidence: number | null, actor: Actor, target?: string): Promise<void> {
    const projectId = projectRepo(store).default(orgId)?.id;

    const result = await intakeInstruction(ctx, scope, {
      rawText,
      asrConfidence,
      actorUserId: actor.userId,
      projectId,
    });
    instructionRepo(store); // parse is persisted by intake

    const tickets = result.ticketIds.map((id) => ticketRepo(store).get(scope, id));
    const userList = users.list(orgId);

    const card = renderApprovalCard({
      instructionId: result.instructionId,
      rawText,
      asrConfidence,
      parse: result.parse,
      tickets: tickets.map((t) => ({
        ticket: t,
        assigneeName: userList.find((u) => u.id === t.assigneeId)?.display_name ?? null,
        divisionName: divisionList.find((d) => d.id === t.divisionId)?.name ?? 'Divisi',
      })),
    });

    messageRepo(store).record(scope, {
      channelId, direction: 'outbound', kind: 'text', body: card.text,
    });

    // FR-03.2 — the card must carry the raw instruction including the caution line.
    const destination = target ?? (config.telegram.commanderChatId || String(actor.userId));
    await adapter.send(destination, {
      target: destination,
      text: `${confidenceWarning(asrConfidence)}${card.text}`,
      actions: card.actions,
      parseMode: 'markdown',
    });
  }

  async function handleCallback(msg: InboundMessage, actor: Actor): Promise<void> {
    const data = msg.callbackData ?? '';
    const target = String(msg.senderExternalId);
    const [namespace, verb, reference] = data.split(':');
    log.info('callback', { namespace, verb, reference, by: actor.displayName });

    if (namespace === 'apv') {
      const decision: ApprovalDecision = verb === 'ok'
        ? { action: 'approve' }
        : verb === 'no'
          ? { action: 'cancel' }
          // `apv:fix` opens a guided correction; with no inline editor yet the drafts
          // stay pending and the commander is told to use the web console.
          : { action: 'correct', changes: [] };

      if (decision.action === 'correct' && decision.changes.length === 0) {
        await reply(String(msg.senderExternalId), '✏️ Gunakan panel koreksi di Web Control Center untuk adjusting alokasi personil dan tenggat waktu.');
        return;
      }

      const result = await handleApproval(ctx, scope, actor, reference!, decision);

      if (result.alreadyProcessed) {
        await reply(target, 'ℹ️ Permintaan ini sudah diproses sebelumnya. Tidak ada perubahan tambahan.');
        return;
      }
      if (result.decision === 'cancel') {
        await reply(target, `🚫 Penugasan dibatalkan. ${result.dispatched.length} tiket dibatalkan, tidak ada yang didistribusikan.`);
        return;
      }

      // FR-03.3 + FR-04.1 — fan out only now, and only to ASSIGNED tickets.
      for (const ticket of result.dispatched) {
        const division = divisionList.find((d) => d.id === ticket.divisionId);
        const chat = router.target(division?.kind ?? '');
        if (!chat) {
          log.warn('no channel bound for division', { division: division?.kind });
          continue;
        }
        const card = buildTicketCardData(ctx, scope, ticket);
        await adapter.send(chat, {
          target: chat,
          text: renderTicketCard({
            ticket,
            assigneeName: card.assigneeName,
            divisionName: card.divisionName,
            dod: card.dod,
            referenceDocs: referenceDocs(ctx, scope, ticket.projectId, ticket.title),
          }),
          actions: renderStaffActions(ticket.code),
          parseMode: 'markdown',
        });
      }
      await reply(target, `✅ ${result.dispatched.length} tiket didistribusikan.${result.skipped.length ? `\n⚠️ ${result.skipped.length} dilewati: ${result.skipped.map((s) => s.code).join(', ')}` : ''}`);
      return;
    }

    if (namespace === 'tic') {
      const ticket = findTicketByCode(scope, reference!);
      if (!ticket) {
        await reply(target, `❌ Tiket ${reference} tidak ditemukan.`);
        return;
      }
      const chat = String(msg.senderExternalId);

      if (verb === 'ack') {
        await acknowledgeTicket(ctx, scope, actor, ticket.id);
        await reply(chat, `▶️ ${ticket.code} dimulai. Kerjakan sesuai Kriteria Selesai di atas.`);
        return;
      }

      if (verb === 'done') {
        await submitEvidence(ctx, scope, actor, ticket.id, {});
        // FR-05 — verification is immediate and automatic; nothing else is required.
        const gate = await runGatekeeper(ctx, scope, ticket.id, actor);
        if (gate.verdict === 'pass') {
          await reply(chat, gate.staffMessage);
        } else if (gate.verdict === 'fail') {
          await reply(chat, renderReworkNotice(ticket.code, ticket.title, gate.staffMessage));
        } else {
          await reply(chat, gate.staffMessage);
        }
        if (gate.commanderMessage && config.telegram.commanderChatId) {
          await reply(config.telegram.commanderChatId, gate.commanderMessage);
        }
        return;
      }

      if (verb === 'ask') {
        await reply(chat, '✍️ Tulis pertanyaan Anda. Saya akan menjawab dari memori proyek.');
        return;
      }
    }

    if (namespace === 'q') {
      // FR-04.2 — free-text clarification, ticket id carried in callback data.
      await reply(target, '✍️ Tulis pertanyaan Anda tentang konteks tugas ini.');
      return;
    }
  }

  function findTicketByCode(scope: OrgScope, code: string) {
    return ticketRepo(store).list(scope).find((t) => t.code === code);
  }

  await adapter.start();
  log.info('bot started', { runtime: `routes=${router.known.join(',') || 'none'}`, roster: loadRoster(store).length });

  const shutdown = async () => {
    log.info('bot shutting down');
    await adapter.stop();
    store.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((err) => {
  log.error('fatal', { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
