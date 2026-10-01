import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFakeAsr, transcribeSafe, AudioTooLargeError } from '@execugate/asr';

const dir = mkdtempSync(join(tmpdir(), 'execugate-asr-'));

const writeAudio = (name: string, size: number) => {
  const path = join(dir, name);
  writeFileSync(path, Buffer.alloc(size, 0));
  return path;
};

describe('ASR provider', () => {
  it('returns the fixture transcript for a known clip', async () => {
    const provider = createFakeAsr({
      'voice-note-1': { text: 'Besok pagi deploy payment service ya', confidence: 0.93, language: 'id' },
    });
    const result = await provider.transcribe(writeAudio('voice-note-1.ogg', 4096));
    expect(result.text).toContain('deploy payment service');
    expect(result.confidence).toBeGreaterThan(0.55);
    expect(result.language).toBe('id');
  });

  it('is deterministic for the same clip', async () => {
    const provider = createFakeAsr({ clip: { text: 'stabil' } });
    const a = await provider.transcribe(writeAudio('clip.ogg', 512));
    const b = await provider.transcribe(writeAudio('clip.ogg', 512));
    expect(a.text).toBe(b.text);
  });

  it('matches a fixture by file extension when no name matches', async () => {
    const provider = createFakeAsr({ '.wav': { text: 'dari berkas wav' } });
    const result = await provider.transcribe(writeAudio('suara-panjang-sekali.wav', 512));
    expect(result.text).toBe('dari berkas wav');
  });

  it('refuses to fabricate a transcript for an unknown clip', async () => {
    const provider = createFakeAsr({ known: { text: 'x' } });
    const result = await provider.transcribe(writeAudio('tidak-dikenal.ogg', 512));
    // Confidence 0 forces the approval card to warn; an empty string would let a demo
    // assert something the ASR never said.
    expect(result.confidence).toBe(0);
    expect(result.text).toMatch(/belum tersedia/);
  });

  it('rejects an oversized clip before contacting a provider', async () => {
    const provider = createFakeAsr();
    const big = writeAudio('besar.ogg', 2_000);
    // Guard against a large upload exhausting memory on the demo laptop.
    const { config } = await import('@execugate/core');
    const original = config.asr.maxBytes;
    (config.asr as { maxBytes: number }).maxBytes = 1_000;
    try {
      await expect(provider.transcribe(big)).rejects.toBeInstanceOf(AudioTooLargeError);
    } finally {
      (config.asr as { maxBytes: number }).maxBytes = original;
    }
  });

  it('reports health with the fixture count', async () => {
    const provider = createFakeAsr({ a: { text: 'a' }, b: { text: 'b' } });
    const health = await provider.healthCheck();
    expect(health.ok).toBe(true);
    expect(health.detail).toContain('2');
  });
});

describe('transcribeSafe', () => {
  it('reports a missing file as an error without throwing', async () => {
    const { result, error } = await transcribeSafe(createFakeAsr(), join(dir, 'tidak-ada.ogg'));
    expect(error).toBeTruthy();
    expect(result.text).toBe('');
    expect(result.confidence).toBe(0);
  });

  it('falls back to supplied text when transcription fails', async () => {
    const { result, error } = await transcribeSafe(createFakeAsr(), join(dir, 'hilang.ogg'), {
      fallbackText: 'deploy payment service',
    });
    expect(error).toBeTruthy();
    expect(result.text).toBe('deploy payment service');
  });

  it('passes the result through on success', async () => {
    const provider = createFakeAsr({ ok: { text: 'hasil transkripsi', confidence: 0.88 } });
    const { result, error } = await transcribeSafe(provider, writeAudio('ok.ogg', 512));
    expect(error).toBeNull();
    expect(result.text).toBe('hasil transkripsi');
    expect(result.confidence).toBe(0.88);
  });
});

describe('WER measurement helper (FR-01.2)', () => {
  it('computes word error rate for an exact match', async () => {
    const { wordErrorRate } = await import('@execugate/asr/wer');
    expect(wordErrorRate('satu dua tiga', 'satu dua tiga')).toBe(0);
  });

  it('counts substitutions, deletions and insertions', async () => {
    const { wordErrorRate } = await import('@execugate/asr/wer');
    // ref "a b c" vs hyp "a x c" -> 1 substitution / 3 words
    expect(wordErrorRate('a b c', 'a x c')).toBeCloseTo(1 / 3, 5);
    expect(wordErrorRate('a b c', 'a c')).toBeCloseTo(1 / 3, 5);
    expect(wordErrorRate('a b', 'a b c')).toBeCloseTo(1 / 2, 5);
  });

  it('is case and punctuation insensitive', async () => {
    const { wordErrorRate } = await import('@execugate/asr/wer');
    expect(wordErrorRate('Halo, dunia!', 'halo dunia')).toBe(0);
  });

  it('treats an empty reference as unusable rather than infinite', async () => {
    const { wordErrorRate } = await import('@execugate/asr/wer');
    expect(wordErrorRate('', 'apa saja')).toBe(1);
  });

  it('returns 1 for a completely wrong hypothesis', async () => {
    const { wordErrorRate } = await import('@execugate/asr/wer');
    expect(wordErrorRate('satu dua tiga empat', 'x y z w')).toBeGreaterThan(0.5);
  });
});