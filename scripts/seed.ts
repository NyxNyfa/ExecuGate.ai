import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Store, seedCore, bindExternalIds, DEMO_ORG_SLUG } from '@execugate/db';
import { ingestDocument, createFakeEmbedder } from '@execugate/memory';
import { createContext } from '@execugate/orchestration';
import { config } from '@execugate/core';

const FIXTURES = resolve(process.cwd(), 'fixtures', 'seed');

/**
 * Idempotent seeding: reference data is upserted by natural key, documents by
 * content checksum. Safe to re-run after changing the embedding model.
 */
async function main() {
  const store = new Store();
  const applied = store.migrate();
  console.log(applied.length ? `Applied migrations: ${applied.join(', ')}` : 'Schema already up to date.');

  const channels: Record<'management' | 'technical' | 'operational', string> = {
    management: config.telegram.commanderChatId,
    technical: config.telegram.techDivisionChatId,
    operational: config.telegram.opsDivisionChatId,
  };
  const anyChannel = Object.values(channels).some(Boolean);

  const refs = seedCore(store, { channels: anyChannel ? channels : undefined });

  // Link chat identities to seeded staff so inbound messages resolve to real users.
  if (config.telegram.commanderChatId) {
    bindExternalIds(store, refs, { commander: config.telegram.commanderChatId });
  }

  console.log(`\nOrganisation : ${DEMO_ORG_SLUG} (${refs.orgId})`);
  console.log(`Project      : Core Platform (${refs.projectId})`);
  console.log('Staff        :');
  for (const [key, id] of Object.entries(refs.users)) console.log(`  - ${key.padEnd(12)} ${id}`);
  if (!anyChannel) {
    console.log('\nNo Telegram chat ids configured. Set TELEGRAM_COMMANDER_CHAT_ID,');
    console.log('TELEGRAM_TECH_DIVISION_CHAT_ID and TELEGRAM_OPS_DIVISION_CHAT_ID in .env to enable dispatch.');
  }

  // Ingest the institutional project memory (FR-02).
  const ctx = createContext({ store });
  const embedder = createFakeEmbedder(384);
  const scope = { orgId: refs.orgId };

  const files = existsSync(FIXTURES) ? readdirSync(FIXTURES).filter((f) => f.endsWith('.md')) : [];
  console.log(`\nIngesting project memory (${files.length} document(s))...`);

  for (const file of files) {
    const body = readFileSync(join(FIXTURES, file), 'utf8');
    const title = body.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? file.replace(/\.md$/, '');
    const result = await ingestDocument(store, embedder, scope, {
      projectId: refs.projectId,
      title,
      body,
      mime: 'text/markdown',
      sourcePath: `fixtures/seed/${file}`,
    });
    console.log(`  - ${title.padEnd(44)} ${result.deduplicated ? 'already ingested' : `${result.chunkCount} chunks`}`);
  }

  console.log('\nSeed complete. Next: npm run dev');
  store.close();
}

main().catch((err) => {
  console.error('Seed failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});