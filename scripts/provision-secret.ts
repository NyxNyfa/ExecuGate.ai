import { getStore, userRepo, orgRepo, DEMO_ORG_SLUG, SECOND_ORG_SLUG } from '@execugate/db';
import { hashSecret, generateSecret } from '@execugate/core';

/**
 * Issues API credentials for staff accounts.
 *
 * Tokens replace the `X-Actor-User-Id` header, which any caller can set — so without
 * this step the API is impersonable. The secret is printed once and never stored in
 * plaintext; only a salted scrypt hash reaches the database.
 *
 * Usage:
 *   npm run provision:secret -- commander          print a new secret for one person
 *   npm run provision:secret -- all                print one per active staff member
 *   npm run provision:secret -- commander --revoke clear a credential
 */

const args = process.argv.slice(2);
const revoke = args.includes('--revoke');
const target = args.find((a) => !a.startsWith('--'));

if (!target) {
  console.error('Usage: npm run provision:secret -- <commander|technical|ops|admin|name|all> [--revoke]');
  process.exit(1);
}

const store = getStore();
store.migrate();

const org = orgRepo(store).bySlug(DEMO_ORG_SLUG) ?? orgRepo(store).bySlug(SECOND_ORG_SLUG);
if (!org) {
  console.error('No organisation found. Run: npm run setup');
  process.exit(1);
}

const users = userRepo(store).list(org.id);
const needle = target.toLowerCase();

const matches =
  needle === 'all'
    ? users
    : users.filter((u) => u.role === needle || u.display_name.toLowerCase() === needle || u.display_name.toLowerCase().includes(needle));

if (!matches.length) {
  console.error(`No staff matching "${target}".`);
  console.error('\nAvailable:');
  for (const u of users) console.error(`  ${u.display_name.padEnd(18)} ${u.role}`);
  store.close();
  process.exit(1);
}

console.log(`\nOrganisation: ${org.name} (${org.id})\n`);

for (const user of matches) {
  if (revoke) {
    userRepo(store).clearAuthSecret(org.id, user.id);
    console.log(`  revoked  ${user.display_name} (${user.role})`);
    continue;
  }

  const secret = generateSecret();
  const { hash, salt } = hashSecret(secret);
  userRepo(store).setAuthSecret(org.id, user.id, hash, salt);

  console.log(`  ${user.display_name} (${user.role})`);
  console.log(`    userId : ${user.id}`);
  console.log(`    secret : ${secret}`);
  console.log('    ^ shown once and not recoverable — only a salted hash is stored');
  console.log('');
}

if (!revoke) {
  console.log('Obtain a token with:');
  console.log('  curl -X POST http://localhost:3000/api/v1/auth/login \\');
  console.log('    -H "content-type: application/json" \\');
  console.log(`    -d '{"userId":"${matches[0]!.id}","secret":"<paste>"}'`);
  console.log('\nThen send:  Authorization: Bearer <token>');
  console.log('AUTH_MODE must be `token` for login to be enabled.');
}

store.close();