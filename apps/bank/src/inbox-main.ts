import { connectPostgres, type Db } from './db.js';
import { buildInbox } from './inbox.js';
import { TENANTS, type TenantId } from './tenants.js';

// The inbox reads each bank's messages from its own database. BANKS lists which banks to show.
const base = process.env.BANK_DATABASE_URL_BASE ?? '';
if (!base) {
  console.error('BANK_DATABASE_URL_BASE is missing');
  process.exit(1);
}
const ids = (process.env.BANKS ?? 'generic,example,sample,placeholder')
  .split(',')
  .map((s) => s.trim()) as TenantId[];
const banks: { t: (typeof TENANTS)[TenantId]; db: Db }[] = [];
for (const id of ids) {
  const t = TENANTS[id];
  if (!t) {
    console.error(`unknown bank ${id}`);
    process.exit(1);
  }
  banks.push({ t, db: await connectPostgres(`${base}/${t.database}`) });
}
const app = await buildInbox(banks);
await app.listen({ host: '0.0.0.0', port: Number(process.env.PORT ?? 8089) });
