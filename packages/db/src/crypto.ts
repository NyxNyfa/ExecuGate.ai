import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { config, AppError } from '@execugate/core';

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;

/**
 * AES-256-GCM secret handling (PRD NFR §8.2).
 *
 * The master key comes from EXECUGATE_MASTER_KEY. In development only, a keyfile
 * is generated on first run with 0600 permissions and a loud warning — production
 * must supply the key from the environment or a real secret manager.
 */
function loadMasterKey(): Buffer {
  if (config.masterKeyHex) {
    const key = Buffer.from(config.masterKeyHex, 'hex');
    if (key.length !== 32) {
      throw new AppError('CRYPTO_ERROR', 'EXECUGATE_MASTER_KEY must be 32 bytes of hex (64 hex characters)');
    }
    return key;
  }
  if (config.isProduction) {
    throw new AppError('CRYPTO_ERROR', 'EXECUGATE_MASTER_KEY is required in production');
  }

  const path = resolve(process.cwd(), '.secrets', 'dev-master.key');
  if (existsSync(path)) return Buffer.from(readFileSync(path, 'utf8').trim(), 'hex');

  mkdirSync(dirname(path), { recursive: true });
  const key = randomBytes(32);
  writeFileSync(path, key.toString('hex'), { mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* best effort on Windows */ }
  console.warn(
    `[crypto] EXECUGATE_MASTER_KEY not set. Generated a development key at ${path}.\n` +
      `[crypto]        This is NOT suitable for production. Set EXECUGATE_MASTER_KEY before deploying.`,
  );
  return key;
}

let cachedKey: Buffer | undefined;

function masterKey(): Buffer {
  cachedKey ??= loadMasterKey();
  return cachedKey;
}

export interface Sealed {
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
}

export function seal(plaintext: string): Sealed {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, masterKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { ciphertext, iv, tag: cipher.getAuthTag() };
}

export function open(sealed: Sealed): string {
  try {
    const decipher = createDecipheriv(ALGO, masterKey(), sealed.iv);
    decipher.setAuthTag(sealed.tag);
    return Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]).toString('utf8');
  } catch (err) {
    throw new AppError('CRYPTO_ERROR', 'Failed to decrypt secret: wrong master key or tampered ciphertext', {}, err);
  }
}

export function sealBuffer(plaintext: Buffer): Sealed {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, masterKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { ciphertext, iv, tag: cipher.getAuthTag() };
}

export function openBuffer(sealed: Sealed): Buffer {
  try {
    const decipher = createDecipheriv(ALGO, masterKey(), sealed.iv);
    decipher.setAuthTag(sealed.tag);
    return Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]);
  } catch (err) {
    throw new AppError('CRYPTO_ERROR', 'Failed to decrypt secret buffer', {}, err);
  }
}
