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
const app = await buildServer(
  {
    t: tenant,
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
  },
  true,
);
await app.listen({ host: '0.0.0.0', port: Number(process.env.PORT ?? 8081) });
