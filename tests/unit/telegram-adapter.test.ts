import { describe, it, expect, beforeEach, vi } from 'vitest';
import { writeFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TelegramAdapter, ChannelRouter } from '@execugate/channels';
import type { InboundMessage } from '@execugate/core';

/**
 * Telegram transport behaviour, with the Bot API stubbed.
 *
 * The point of these tests is the transport contract: update normalisation, media
 * staging, idempotency exposure, and callback handling — the paths where a live demo
 * fails quietly (an update cursor that stalls, a voice note that never reaches ASR).
 */

const TOKEN = '123456789:AAHqTESTtokenVALUEforunit0000';
const dir = mkdtempSync(join(tmpdir(), 'execugate-tg-'));

function adapterWith(fetchImpl: typeof fetch) {
  return new TelegramAdapter({ token: TOKEN, mediaDir: dir, fetchImpl, apiBase: 'https://api.test' });
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('TelegramAdapter health', () => {
  it('reports the bot username on success', async () => {
    const a = adapterWith(vi.fn(async () => jsonResponse({ ok: true, result: { username: 'execugate_bot' } })));
    const health = await a.healthCheck();
    expect(health.ok).toBe(true);
    expect(health.detail).toContain('@execugate_bot');
  });

  it('fails when the API rejects the token', async () => {
    const a = adapterWith(vi.fn(async () => jsonResponse({ ok: false, description: 'Unauthorized' }, 401)));
    const health = await a.healthCheck();
    expect(health.ok).toBe(false);
    expect(health.detail).toContain('401');
  });

  it('fails when the network is down', async () => {
    const a = adapterWith(vi.fn(async () => { throw new Error('ENOTFOUND'); }));
    expect((await a.healthCheck()).ok).toBe(false);
  });

  it('reports a missing token without calling the network', async () => {
    const impl = vi.fn();
    const a = new TelegramAdapter({ token: '', fetchImpl: impl as never });
    expect((await a.healthCheck()).ok).toBe(false);
    expect(impl).not.toHaveBeenCalled();
  });

  it('does not start polling when getMe fails', async () => {
    const getUpdates = vi.fn();
    const a = adapterWith(vi.fn(async (input) => {
      const url = String(input);
      if (url.includes('getMe')) return jsonResponse({ ok: false }, 401);
      getUpdates(String(input));
      return jsonResponse({ ok: true, result: [] });
    }));

    await a.start();
    await new Promise((r) => setTimeout(r, 30));
    await a.stop();

    // Polling an unauthorised bot would spin the update cursor at nothing.
    expect(getUpdates).not.toHaveBeenCalled();
  });
});

describe('update normalisation', () => {
  it('converts a text message into a normalised inbound', async () => {
    const a = adapterWith(vi.fn(async () => jsonResponse({ ok: true, result: [] })));
    const received: InboundMessage[] = [];
    a.onInbound(async (m) => { received.push(m); });

    await a.handleUpdateForTest({
      update_id: 100,
      message: { text: 'deploy payment service', from: { id: 555 }, chat: { id: 999 } },
    });

    expect(received).toHaveLength(1);
    expect(received[0]!.kind).toBe('text');
    expect(received[0]!.text).toBe('deploy payment service');
    expect(received[0]!.senderExternalId).toBe('555');
    expect(received[0]!.externalId).toBe('100');
  });

  it('downloads a voice note and stages it for ASR', async () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    const a = adapterWith(vi.fn(async (input) => {
      const url = String(input);
      if (url.includes('getFile')) return jsonResponse({ ok: true, result: { file_path: 'voice/file_1.oga' } });
      if (url.includes('/file/bot')) return new Response(payload);
      return jsonResponse({ ok: true, result: [] });
    }));

    const received: InboundMessage[] = [];
    a.onInbound(async (m) => { received.push(m); });

    await a.handleUpdateForTest({
      update_id: 101,
      message: { voice: { file_id: 'abc123' }, from: { id: 555 }, chat: { id: 999 } },
    });

    expect(received).toHaveLength(1);
    expect(received[0]!.kind).toBe('voice');
    expect(received[0]!.mediaRef).toBeTruthy();
    // The staged file must contain the real bytes, or ASR transcribes nothing.
    expect([...readFileSync(received[0]!.mediaRef!)]).toEqual([...payload]);
  });

  it('treats an uploaded document as a document, not a voice note', async () => {
    const a = adapterWith(vi.fn(async (input) => {
      const url = String(input);
      if (url.includes('getFile')) return jsonResponse({ ok: true, result: { file_path: 'docs/report.pdf' } });
      if (url.includes('/file/bot')) return new Response(new Uint8Array([9]));
      return jsonResponse({ ok: true, result: [] });
    }));

    const received: InboundMessage[] = [];
    a.onInbound(async (m) => { received.push(m); });
    await a.handleUpdateForTest({
      update_id: 102,
      message: { document: { file_id: 'doc1' }, from: { id: 555 }, chat: { id: 999 } },
    });

    expect(received[0]!.kind).toBe('document');
  });

  it('skips a message with no chat rather than acting on sender alone', async () => {
    const a = adapterWith(vi.fn(async () => jsonResponse({ ok: true, result: [] })));
    const received: InboundMessage[] = [];
    a.onInbound(async (m) => { received.push(m); });

    await a.handleUpdateForTest({ update_id: 103, message: { text: 'tanpa chat' } });
    expect(received).toHaveLength(0);
  });

  it('surfaces a callback press with its data and actor', async () => {
    const answerCallback = vi.fn();
    const a = adapterWith(vi.fn(async (input, init) => {
      const url = String(input);
      if (url.includes('answerCallbackQuery')) { answerCallback(url); return jsonResponse({ ok: true }); }
      void init;
      return jsonResponse({ ok: true, result: [] });
    }));

    const received: InboundMessage[] = [];
    a.onInbound(async (m) => { received.push(m); });

    await a.handleUpdateForTest({
      update_id: 104,
      callback_query: { id: 'cb1', data: 'apv:ok:ins_123', from: { id: 777 } },
    });

    expect(received[0]!.kind).toBe('callback');
    expect(received[0]!.callbackData).toBe('apv:ok:ins_123');
    expect(received[0]!.senderExternalId).toBe('777');
    // Answering must happen regardless of how long the handler takes.
    expect(answerCallback).toHaveBeenCalled();
  });
});

describe('outbound', () => {
  it('renders inline buttons as callback data', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const a = adapterWith(vi.fn(async (input, init) => {
      calls.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return jsonResponse({ ok: true });
    }));

    await a.send('999', {
      target: '999',
      text: 'Kartu',
      actions: [{ label: 'Setujui', callbackData: 'apv:ok:ins_1' }],
    });

    const body = calls.find((c) => c.url.includes('sendMessage'))?.body as Record<string, unknown>;
    expect(body.chat_id).toBe('999');
    expect(body.reply_markup).toEqual({
      inline_keyboard: [[{ text: 'Setujui', callback_data: 'apv:ok:ins_1' }]],
    });
  });

  it('skips sending when no token is configured, without throwing', async () => {
    const impl = vi.fn();
    const a = new TelegramAdapter({ token: '', fetchImpl: impl as never });
    await expect(a.send('999', { target: '999', text: 'x' })).resolves.toBeUndefined();
    expect(impl).not.toHaveBeenCalled();
  });

  it('logs rather than throws when the API rejects a message', async () => {
    const a = adapterWith(vi.fn(async () => new Response('chat not found', { status: 400 })));
    await expect(a.send('999', { target: '999', text: 'x' })).resolves.toBeUndefined();
  });

  it('deletes staged media after ASR consumes it', async () => {
    const path = join(dir, 'discard-me.oga');
    writeFileSync(path, 'x');
    const a = adapterWith(vi.fn(async () => jsonResponse({ ok: true })));
    await a.discardMedia(path);
    expect(() => readFileSync(path)).toThrow();
  });
});

describe('ChannelRouter', () => {
  it('resolves a division kind to its chat id', () => {
    const router = new ChannelRouter(adapterWith(vi.fn() as never));
    router.route('technical', '111');
    router.route('operational', '222');

    expect(router.target('technical')).toBe('111');
    expect(router.known).toContain('operational');
  });

  it('returns undefined for an unbound division rather than a wrong chat', () => {
    const router = new ChannelRouter(adapterWith(vi.fn() as never));
    expect(router.target('technical')).toBeUndefined();
  });
});