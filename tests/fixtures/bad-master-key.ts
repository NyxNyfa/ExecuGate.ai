/**
 * Child-process probe: the master-key length guard lives behind a module-level
 * cache, so it cannot be re-triggered in-process by mutating the environment.
 * Invoked by tests/integration/security.test.ts via `npx tsx`.
 */
import { seal } from '../../packages/db/src/crypto.ts';

try {
  seal('probe');
  console.log('ACCEPTED');
} catch (err) {
  console.log(`REJECTED:${(err as { code?: string }).code ?? 'UNKNOWN'}`);
}