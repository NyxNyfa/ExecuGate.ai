import { getStore } from '@execugate/db';

const store = getStore();
const applied = store.migrate();

console.log(applied.length ? `Applied migrations:\n  ${applied.join('\n  ')}` : 'Schema already up to date.');
console.log(`Database: ${process.env.DATABASE_PATH ?? './data/execugate.db'}`);
store.close();