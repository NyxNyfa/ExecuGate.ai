import { getStore, userRepo } from '@execugate/db';

/**
 * Binds real Telegram accounts to seeded staff (BUILD_PLAN §4, division routing).
 *
 * The bot resolves inbound traffic to a tenant and a role by matching the sender's
 * Telegram user id against `users.external_id`. Until that mapping exists, a live
 * message is rejected as an "unknown sender" — which looks like a broken bot rather
 * than missing configuration, so this script makes the step explicit.
 *
 * Usage:
 *   npm run bind:staff                       list roster + bound ids
 *   npm run bind:staff -- 123456789 commander bind a Telegram id to a seeded role
 *   npm run bind:staff -- 123456789 budi     bind to a specific person
 *   npm run bind:staff -- --clear 123456789  unbind
 */

const args = process.argv.slice(2);
const clear = args.includes('--clear');
const positional = args.filter((a) => !a.startsWith('--'));
const [externalId, who] = positional;

const store = getStore();
store.migrate();

const orgRows = store.all<{ id: string }>('SELECT id FROM organizations ORDER BY created_at');
if (!orgRows.length) {
  console.error('No organisation found. Run: npm run seed');
  process.exit(1);
}

const orgId = orgRows[0]!.id;
const users = userRepo(store).list(orgId);

if (!externalId) {
  console.log('\nSeeded staff and their bound Telegram ids:\n');
  for (const u of users) {
    const bound = u.external_id ? `\x1b[32m${u.external_id}\x1b[0m` : '\x1b[33m(unbound)\x1b[0m';
    console.log(`  ${u.display_name.padEnd(16)} ${u.role.padEnd(11)} ${bound}`);
  }
  console.log('\nTo learn your own Telegram id: message @userinfobot, or read it from the bot log.');
  console.log('Then:  npm run bind:staff -- <telegram_id> <name-or-role>\n');
  store.close();
  process.exit(0);
}

if (clear) {
  for (const u of users) {
    if (u.external_id === externalId) {
      userRepo(store).setExternal(orgId, u.id, '');
      console.log(`Unbound ${u.display_name}.`);
    }
  }
  store.close();
  process.exit(0);
}

if (!who) {
  console.error('Missing person or role. Usage: npm run bind:staff -- <telegram_id> <name-or-role>');
  console.error('\nAvailable:');
  for (const u of users) console.error(`  ${u.display_name.padEnd(16)} ${u.role}`);
  store.close();
  process.exit(1);
}

const needle = who.toLowerCase();
const target =
  users.find((u) => u.display_name.toLowerCase() === needle) ??
  users.find((u) => u.role === needle) ??
  users.find((u) => u.display_name.toLowerCase().includes(needle));

if (!target) {
  console.error(`No seeded staff matching "${who}".`);
  console.error('\nAvailable:');
  for (const u of users) console.error(`  ${u.display_name.padEnd(16)} ${u.role}`);
  store.close();
  process.exit(1);
}

// A Telegram id may only map to one person: two mappings would make role resolution
// ambiguous and silently authorise the wrong actor.
const clash = users.find((u) => u.external_id === externalId && u.id !== target.id);
if (clash) {
  console.error(`Telegram id ${externalId} is already bound to ${clash.display_name}.`);
  console.error(`Unbind it first:  npm run bind:staff -- --clear ${externalId}`);
  store.close();
  process.exit(1);
}

userRepo(store).setExternal(orgId, target.id, externalId);
console.log(`\nBound Telegram id ${externalId} -> ${target.display_name} (${target.role})\n`);
store.close();