import type { Actor, InboundMessage, OrgScope } from '@execugate/core';
import { ticketRepo, userRepo } from '@execugate/db';
import { askClarification, submitEvidence, runGatekeeper } from '@execugate/orchestration';
import { renderAnswer, renderReworkNotice } from '@execugate/channels';
import type { TelegramAdapter } from '@execugate/channels';
import type { AppContext } from '@execugate/orchestration';
import { createLogger } from '@execugate/observability';

const log = createLogger('bot:questions');

/**
 * Free-text staff messages need to be attributed to a ticket. Telegram chats are
 * shared by a whole division, so the most recent ticket the sender touched is used as
 * the conversation context, with an explicit escape hatch (`/kode TIKET`) when a
 * staff member is working on more than one task at a time.
 */
export interface ConversationState {
  lastTicketId: string | null;
  awaitingQuestion: boolean;
}

export function createConversationState(): ConversationState {
  return { lastTicketId: null, awaitingQuestion: false };
}

const CODE_PATTERN = /^\/?([A-Z]{3}-\d{4}-\d{4})\b/i;

export function extractTicketCode(text: string): string | null {
  return text.match(CODE_PATTERN)?.[1]?.toUpperCase() ?? null;
}

export interface TextRouterDeps {
  ctx: AppContext;
  adapter: TelegramAdapter;
  state: ConversationState;
  scope: OrgScope;
  commanderChatId: string | null;
}

/**
 * Returns true when the message was consumed as staff traffic, so the caller does
 * not also treat it as a commander instruction.
 */
export async function routeStaffText(
  deps: TextRouterDeps,
  msg: InboundMessage,
  actor: Actor,
): Promise<boolean> {
  const { ctx, adapter, state, scope } = deps;
  const text = msg.text ?? '';
  const chat = String(msg.senderExternalId);

  const explicit = extractTicketCode(text);
  if (explicit) {
    const ticket = ticketRepo(ctx.store).list(scope).find((t) => t.code === explicit);
    if (!ticket) {
      await adapter.send(chat, { target: chat, text: `❌ Tiket ${explicit} tidak ditemukan.` });
      return true;
    }
    state.lastTicketId = ticket.id;
    const rest = text.replace(CODE_PATTERN, '').trim();
    // "/TKT-2026-0001" alone just switches context.
    if (!rest) {
      await adapter.send(chat, { target: chat, text: `🎯 Konteks sekarang: ${ticket.code} — ${ticket.title}` });
      return true;
    }
    return await handleStaffBody(deps, msg, actor, ticket.id, rest);
  }

  // Only intercept for a sender who is actually working a ticket.
  if (actor.role !== 'technical' && actor.role !== 'ops') return false;
  if (!state.lastTicketId) return false;

  const ticket = ticketRepo(ctx.store).get(scope, state.lastTicketId);
  const body = text.replace(/^\/[a-z]+\s*/i, '').trim();
  if (!body) return false;

  // "done" / "selesai" means "I finished; verify me".
  if (/^(done|selesai|sudah selesai|udah selesai|selesai|sudah|oke selesai)\b/i.test(body)) {
    return await finish(deps, ticket.id, actor);
  }
  return await handleStaffBody(deps, msg, actor, ticket.id, body);
}

async function handleStaffBody(
  deps: TextRouterDeps,
  msg: InboundMessage,
  actor: Actor,
  ticketId: string,
  body: string,
): Promise<boolean> {
  const { ctx, adapter, scope } = deps;
  const chat = String(msg.senderExternalId);

  if (/^(tanya|ask|gimana|bagai mana|boleh tanya)\b/i.test(body)) {
    const question = body.replace(/^(tanya|ask)\s*/i, '').trim() || body;
    await ask(ctx, actor, ticketId, question, chat, deps);
    return true;
  }

  if (/^(link|bukti|evidence|pr|pull request)\b/i.test(body)) {
    const url = body.match(/https?:\/\/\S+/)?.[0];
    await submitEvidence(ctx, scope, actor, ticketId, { url, note: body });
    log.info('evidence submitted via chat', { ticketId, hasUrl: !!url });
    await adapter.send(chat, { target: chat, text: '📤 Bukti diterima. Memverifikasi otomatis ke sistem eksternal...' });
    await finish(deps, ticketId, actor);
    return true;
  }

  // Default: treat as a clarification question (FR-04.2).
  await ask(ctx, actor, ticketId, body, chat, deps);
  void msg;
  return true;
}

async function ask(ctx: AppContext, actor: Actor, ticketId: string, question: string, chat: string, deps: TextRouterDeps): Promise<void> {
  const { adapter } = deps;
  const answer = await askClarification(ctx, { orgId: actor.orgId }, actor, ticketId, question);

  await adapter.send(chat, {
    target: chat,
    text: renderAnswer(question, answer.answer, answer.citations, answer.grounded),
    parseMode: 'markdown',
  });

  // An ungrounded answer is escalated rather than left hanging (FR-04.2).
  if (!answer.grounded && deps.commanderChatId) {
    const users = userRepo(ctx.store);
    const ticket = ticketRepo(ctx.store).get({ orgId: actor.orgId }, ticketId);
    await adapter.send(deps.commanderChatId, {
      target: deps.commanderChatId,
      text: `❓ *Klarifikasi perlu bantuan commanding*\nTiket: ${ticket.code} — ${ticket.title}\nPenanya: ${users.byId(actor.orgId, actor.userId)?.display_name ?? actor.displayName}\n> ${question}\n\nMemori proyek tidak memuat jawaban yang dapat diverifikasi.`,
      parseMode: 'markdown',
    });
  }
}

async function finish(deps: TextRouterDeps, ticketId: string, actor: Actor): Promise<boolean> {
  const { ctx, adapter, scope, commanderChatId } = deps;
  const chat = String(actor.userId);
  const ticket = ticketRepo(ctx.store).get(scope, ticketId);

  try {
    await submitEvidence(ctx, scope, actor, ticketId, {});
  } catch (err) {
    await adapter.send(chat, {
      target: chat,
      text: `⚠️ ${err instanceof Error ? err.message : 'Gagal melapor selesai.'}`,
    });
    return true;
  }

  const gate = await runGatekeeper(ctx, scope, ticketId, actor);

  if (gate.verdict === 'pass') {
    await adapter.send(chat, { target: chat, text: gate.staffMessage });
  } else if (gate.verdict === 'fail') {
    await adapter.send(chat, { target: chat, text: renderReworkNotice(ticket.code, ticket.title, gate.staffMessage) });
  } else {
    await adapter.send(chat, { target: chat, text: gate.staffMessage });
  }

  if (gate.commanderMessage && commanderChatId) {
    await adapter.send(commanderChatId, { target: commanderChatId, text: gate.commanderMessage });
  }
  return true;
}