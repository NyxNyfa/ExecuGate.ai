import type { InboundMessage, OutboundMessage } from './types.ts';
import type { ChannelAdapter } from './types.ts';
import { createLogger } from '@execugate/observability';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const log = createLogger('channels:telegram');

export interface TelegramOptions {
  token: string;
  /** Where downloaded voice notes are staged for ASR. */
  mediaDir?: string;
  pollIntervalMs?: number;
  /** Injected in tests to avoid real network calls. */
  fetchImpl?: typeof fetch;
  /** Base URL override for Bot API (proxies, self-hosted gateways). */
  apiBase?: string;
}

/**
 * Telegram Bot API adapter (ADR-4: long polling in development).
 *
 * Long polling needs no inbound port and no tunnel, which is why it is the default.
 * `setWebhook` mode is left to the HTTP app; this adapter only reads updates.
 */
export class TelegramAdapter implements ChannelAdapter {
  readonly kind = 'telegram' as const;

  private handler: ((msg: InboundMessage) => Promise<void>) | null = null;
  private offset = 0;
  private running = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private readonly mediaDir: string;
  private readonly pollIntervalMs: number;
  private readonly apiBase: string;
  private readonly fileBase: string;
  private readonly doFetch: typeof fetch;

  constructor(private readonly opts: TelegramOptions) {
    this.mediaDir = opts.mediaDir ?? join(tmpdir(), 'execugate-media');
    this.pollIntervalMs = opts.pollIntervalMs ?? 0;
    this.apiBase = (opts.apiBase ?? 'https://api.telegram.org').replace(/\/+$/, '');
    this.fileBase = this.apiBase;
    this.doFetch = opts.fetchImpl ?? fetch;
  }

  onInbound(handler: (msg: InboundMessage) => Promise<void>): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    if (!this.opts.token) {
      log.warn('TELEGRAM_BOT_TOKEN is empty; Telegram adapter disabled');
      return;
    }
    await mkdir(this.mediaDir, { recursive: true });
    const me = await this.healthCheck();
    if (!me.ok) {
      log.error('Telegram getMe failed; adapter will not start', { detail: me.detail });
      return;
    }
    log.info('Telegram adapter starting (long polling)', { identity: me.detail });
    this.running = true;
    void this.poll();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }

  private async poll(): Promise<void> {
    while (this.running) {
      try {
        const updates = await this.getUpdates();
        for (const update of updates) {
          this.offset = update.update_id + 1;
          try {
            await this.handleUpdate(update);
          } catch (err) {
            // A failure on one update must not stall the update cursor.
            log.error('update handling failed', {
              updateId: update.update_id,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      } catch (err) {
        log.warn('poll failed', { error: err instanceof Error ? err.message : String(err) });
      }
      if (this.pollIntervalMs > 0) {
        await new Promise((r) => setTimeout(r, this.pollIntervalMs));
      }
    }
  }

  private async call(method: string, body?: Record<string, unknown>): Promise<Response> {
    return this.doFetch(`${this.apiBase}/bot${this.opts.token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  private async getUpdates(): Promise<TelegramUpdate[]> {
    const res = await this.call('getUpdates', {
      offset: this.offset,
      timeout: 25,
      allowed_updates: ['message', 'callback_query'],
    });
    if (!res.ok) return [];
    const json = (await res.json()) as { ok: boolean; result?: TelegramUpdate[] };
    return json.result ?? [];
  }

  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    if (update.callback_query) return this.handleCallback(update.callback_query);
    const msg = update.message;
    if (!msg) return;

    const chatId = String(msg.chat?.id ?? '');
    if (!chatId) return;

    if (msg.text) {
      await this.handler?.({
        externalId: String(update.update_id),
        senderExternalId: String(msg.from?.id ?? ''),
        kind: 'text',
        text: msg.text,
        rawPayload: update,
        receivedAt: new Date().toISOString(),
      });
      return;
    }

    // Voice notes (and audio-as-voice) both arrive as a file_id that must be
    // downloaded before ASR can read them.
    const media = msg.voice ?? msg.audio ?? msg.document;
    if (media?.file_id) {
      const path = await this.downloadFile(media.file_id);
      if (!path) return;
      await this.handler?.({
        externalId: String(update.update_id),
        senderExternalId: String(msg.from?.id ?? ''),
        kind: msg.voice || msg.audio ? 'voice' : 'document',
        mediaRef: path,
        rawPayload: update,
        receivedAt: new Date().toISOString(),
      });
    }
  }

  /**
   * A button press resolves the ticket referenced by `callback_data` and carries
   * the actor, which is what makes approval attributable in the audit trail.
   */
  private async handleCallback(cb: TelegramCallbackQuery): Promise<void> {
    // Answer before dispatching: a slow handler would leave the client spinner up.
    await this.call('answerCallbackQuery', { callback_query_id: cb.id, show_alert: false }).catch(() => undefined);

    await this.handler?.({
      externalId: `cb:${cb.id}`,
      senderExternalId: String(cb.from?.id ?? ''),
      kind: 'callback',
      callbackData: cb.data,
      rawPayload: cb,
      receivedAt: new Date().toISOString(),
    });
  }

  private async downloadFile(fileId: string): Promise<string | null> {
    try {
      const info = await this.doFetch(`${this.apiBase}/bot${this.opts.token}/getFile?file_id=${fileId}`);
      if (!info.ok) return null;
      const json = (await info.json()) as { result?: { file_path?: string } };
      const filePath = json.result?.file_path;
      if (!filePath) return null;

      const res = await this.doFetch(`${this.fileBase}/file/bot${this.opts.token}/${filePath}`);
      if (!res.ok) return null;

      const path = join(this.mediaDir, `${Date.now()}-${filePath.replace(/[^\w.-]/g, '_')}`);
      await writeFile(path, Buffer.from(await res.arrayBuffer()));
      return path;
    } catch (err) {
      log.error('file download failed', { fileId, error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  }

  async send(target: string, msg: OutboundMessage): Promise<void> {
    if (!this.opts.token) {
      log.warn('Telegram send skipped: no token', { target });
      return;
    }
    const replyMarkup = msg.actions?.length
      ? {
          inline_keyboard: [
            msg.actions.map((a) => ({
              text: a.label,
              // Telegram caps callback_data at 64 bytes, so ticket ids stay short.
              callback_data: a.callbackData,
            })),
          ],
        }
      : undefined;

    const res = await this.call('sendMessage', {
      chat_id: target,
      text: msg.text,
      parse_mode: msg.parseMode === 'markdown' ? 'Markdown' : undefined,
      disable_web_page_preview: true,
      reply_markup: replyMarkup,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      log.error('sendMessage failed', { target, status: res.status, body: body.slice(0, 200) });
    }
  }

  /** Deletes a staged media file once ASR has consumed it. */
  async discardMedia(path: string): Promise<void> {
    await rm(path, { force: true }).catch(() => undefined);
  }

  async healthCheck(): Promise<{ ok: boolean; detail: string }> {
    if (!this.opts.token) return { ok: false, detail: 'TELEGRAM_BOT_TOKEN not set' };
    try {
      const res = await this.doFetch(`${this.apiBase}/bot${this.opts.token}/getMe`);
      const json = (await res.json()) as { ok: boolean; result?: { username?: string } };
      if (!json.ok) return { ok: false, detail: `getMe failed (${res.status})` };
      return { ok: true, detail: `@${json.result?.username ?? 'unknown'}` };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Normalises a single raw update and hands it to the handler.
   *
   * Public so the transport contract can be tested without running the polling loop;
   * `poll()` is the only production caller.
   */
  async handleUpdateForTest(update: TelegramUpdate): Promise<void> {
    await this.handleUpdate(update);
  }
}

export interface TelegramUpdate {
  update_id: number;
  message?: {
    text?: string;
    from?: { id: number };
    chat?: { id: number };
    voice?: { file_id: string };
    audio?: { file_id: string };
    document?: { file_id: string; mime_type?: string };
  };
  callback_query?: TelegramCallbackQuery;
}

interface TelegramCallbackQuery {
  id: string;
  data: string;
  from?: { id: number };
  message?: { chat?: { id: number } };
}