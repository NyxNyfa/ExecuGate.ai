import { describe, it, expect, beforeEach } from 'vitest';
import { Store, seedCore, secretRepo } from '@execugate/db';
import { seal, open, sealBuffer, openBuffer } from '@execugate/db';
import { redact, redactString } from '@execugate/observability';
import { AppError } from '@execugate/core';

describe('secret encryption at rest (NFR 8.2)', () => {
  let store: Store;
  let scope: { orgId: string };

  beforeEach(() => {
    store = new Store(':memory:');
    store.migrate();
    scope = { orgId: seedCore(store).orgId };
  });

  it('round-trips a secret through AES-256-GCM', () => {
    secretRepo(store).set(scope, 'github.token', 'ghp_supersecretvalue1234567890');
    expect(secretRepo(store).get(scope, 'github.token')).toBe('ghp_supersecretvalue1234567890');
  });

  it('never stores plaintext in the ciphertext column', () => {
    const secret = 'ghp_plaintextmustnotappear000000';
    secretRepo(store).set(scope, 'github.token', secret);

    const row = store.get<{ ciphertext: Buffer }>(
      'SELECT ciphertext FROM secrets WHERE org_id = ? AND key_name = ?', scope.orgId, 'github.token',
    )!;
    expect(row.ciphertext.toString('utf8')).not.toContain(secret);
    expect(row.ciphertext.toString('binary')).not.toContain('ghp_');
  });

  it('produces a distinct ciphertext per write (random IV)', () => {
    secretRepo(store).set(scope, 'k', 'same-value');
    const first = store.get<{ ciphertext: Buffer }>('SELECT ciphertext FROM secrets WHERE org_id = ? AND key_name = ?', scope.orgId, 'k')!.ciphertext.toString('hex');
    secretRepo(store).set(scope, 'k', 'same-value');
    const second = store.get<{ ciphertext: Buffer }>('SELECT ciphertext FROM secrets WHERE org_id = ? AND key_name = ?', scope.orgId, 'k')!.ciphertext.toString('hex');
    expect(first).not.toBe(second);
  });

  it('fails closed when the ciphertext is tampered with', () => {
    secretRepo(store).set(scope, 'k', 'value');
    const row = store.get<{ iv: Buffer; tag: Buffer }>('SELECT iv, tag FROM secrets WHERE org_id = ? AND key_name = ?', scope.orgId, 'k')!;
    const tag = Buffer.from(row.tag);
    tag[0] = tag[0]! ^ 0xff;

    expect(() => open({ ciphertext: Buffer.from('deadbeef', 'hex'), iv: row.iv, tag })).toThrow(AppError);
  });

  it('exposes only key names from the listing', () => {
    secretRepo(store).set(scope, 'github.token', 'ghp_abcdefghijklmnopqrst');
    const listed = secretRepo(store).list(scope);
    expect(listed).toHaveLength(1);
    expect(listed[0]!.key_name).toBe('github.token');
    expect(JSON.stringify(listed)).not.toContain('ghp_');
  });

  it('handles binary secrets', () => {
    const sealed = sealBuffer(Buffer.from([0, 1, 2, 250, 255]));
    expect([...openBuffer(sealed)]).toEqual([0, 1, 2, 250, 255]);
  });

  it('rejects a master key of the wrong length', async () => {
    // The key is cached at module level, so the guard only runs on a fresh process.
    // `node_modules/.bin/tsx` is invoked directly rather than via `npx`: on Windows
    // `npx` is a .cmd shim, which execFileSync cannot spawn without a shell.
    const { execFileSync } = await import('node:child_process');
    const { resolve } = await import('node:path');
    const tsx = resolve('node_modules', 'tsx', 'dist', 'cli.mjs');

    const out = execFileSync(process.execPath, [tsx, resolve('tests/fixtures/bad-master-key.ts')], {
      env: { ...process.env, EXECUGATE_MASTER_KEY: 'ab'.repeat(31) },
      encoding: 'utf8',
    });
    expect(out).toContain('REJECTED:CRYPTO_ERROR');
  });
});

describe('log redaction', () => {
  it('masks a Telegram bot token', () => {
    const token = '123456789:AAHqwertyuiopASDFGHJKLzxcvbnmQWERTY';
    expect(redactString(`token=${token}`)).toContain('[TELEGRAM_TOKEN]');
    expect(redactString(`token=${token}`)).not.toContain(token);
  });

  it('masks GitHub and OpenAI style tokens', () => {
    expect(redactString('ghp_abcdefghijklmnopqrstuvwxyz0123')).toContain('[GITHUB_TOKEN]');
    expect(redactString('sk-abcdefghijklmnopqrstuv')).toContain('[API_KEY]');
  });

  it('masks authorization headers and inline key/value pairs', () => {
    expect(redactString('Authorization: Bearer abc123def456')).toContain('[REDACTED]');
    expect(redactString('api_key=supersecret')).toContain('[REDACTED]');
    expect(redactString('password=hunter2')).toContain('[REDACTED]');
  });

  it('redacts sensitive object keys regardless of case', () => {
    const out = redact({ Token: 'x', SECRET: 'y', nested: { password: 'z', fine: 'ok' } }) as Record<string, unknown>;
    expect(out.Token).toBe('[REDACTED]');
    expect(out.SECRET).toBe('[REDACTED]');
    expect((out.nested as Record<string, unknown>).password).toBe('[REDACTED]');
    expect((out.nested as Record<string, unknown>).fine).toBe('ok');
  });

  it('does not recurse without bound on a deeply nested object', () => {
    let deep: Record<string, unknown> = { end: true };
    for (let i = 0; i < 50; i++) deep = { child: deep };
    expect(() => redact(deep)).not.toThrow();
  });

  it('survives circular-ish structures via depth limiting', () => {
    const out = redact({ a: { b: { c: { d: { e: 'value' } } } } }) as Record<string, unknown>;
    expect(out).toBeDefined();
  });
});