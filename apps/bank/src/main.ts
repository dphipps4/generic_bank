import { buildAdmin } from './admin.js';
import { connectPostgres, migrate } from './db.js';
import { hazards, type Profile } from './hazards.js';
import { seed } from './seed.js';
import { buildServer, hazardLog } from './server.js';
import { TENANTS, type TenantId } from './tenants.js';

// One bank per process. Everything it needs comes from the environment, and it refuses to start
// on anything missing or malformed.
function need(name: string, minLength = 1): string {
  const v = process.env[name] ?? '';
  if (v.length < minLength) {
    console.error(`${name} is missing or too short (at least ${minLength} characters)`);
    process.exit(1);
  }
  return v;
}

const tenant = TENANTS[process.env.TENANT as TenantId];
if (!tenant) {
  console.error(`TENANT must be one of: ${Object.keys(TENANTS).join(', ')}`);
  process.exit(1);
}
const profile = (process.env.HAZARDS ?? 'default') as Profile;
if (!['default', 'gentle', 'harsh'].includes(profile)) {
  console.error('HAZARDS must be default, gentle or harsh');
  process.exit(1);
}

const db = await connectPostgres(`${need('BANK_DATABASE_URL_BASE')}/${tenant.database}`);
await migrate(db);
const now = () => new Date();
await seed(
  db,
  tenant,
  {
    servicePassword: need('BANK_SERVICE_PASSWORD', 16),
    supervisorPassword: need('BANK_SUPERVISOR_PASSWORD', 16),
  },
  now(),
);
const forceable = process.env.HAZARDS_FORCEABLE === 'true';
const port = Number(process.env.PORT ?? 8081);
const secondPort = process.env.SECOND_PORT ? Number(process.env.SECOND_PORT) : undefined;
if (tenant.secondOrigin && !secondPort) {
  console.error(`${tenant.brand} serves part of itself from a second origin: set SECOND_PORT`);
  process.exit(1);
}
const bank = {
  t: tenant,
  ports: { main: port, second: secondPort },
  db,
  now,
  uiVersion: Number(process.env.BANK_UI_VERSION ?? 1),
  hazards: hazards({
    profile,
    seed: Number(process.env.HAZARD_SEED ?? 1),
    forceable,
    hmacKey: forceable ? need('HAZARD_HMAC_KEY', 32) : '',
    log: hazardLog(db, now),
  }),
};
const app = await buildServer(bank, true);
await app.listen({ host: '0.0.0.0', port });
// The second origin is the same bank on another port: a different origin to the browser.
if (secondPort) await (await buildServer(bank, true)).listen({ host: '0.0.0.0', port: secondPort });
// Ground truth for the test harness, on its own port.
const admin = await buildAdmin(bank, need('BANK_ADMIN_TOKEN', 32));
await admin.listen({ host: '0.0.0.0', port: Number(process.env.ADMIN_PORT ?? 9000) });
