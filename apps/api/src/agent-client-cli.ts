// make agent: the demo agent's own OAuth2 client, made afresh each time (the last one is revoked),
// printed as JSON for the agent to read. Runs inside the API container, which holds the hashing key.
import { loadConfig, secret } from '@gb/config';
import { sql } from '@gb/db';
import { oauth, TASK_SCOPES } from '@gb/oauth';
import { z } from 'zod';

const cfg = loadConfig({
  API_TOKEN_HASH_KEY: secret(),
  CONTROL_DATABASE_URL: z.string().startsWith('postgresql://'),
});
const db = sql(cfg.CONTROL_DATABASE_URL);
const o = oauth(db, cfg.API_TOKEN_HASH_KEY);
const NAME = 'Demo agent (make agent)';

const old = await db.query<{ clientId: string }>(
  'SELECT "clientId" FROM "ApiClient" WHERE name = $1 AND "revokedAt" IS NULL',
  [NAME],
);
for (const c of old.rows) await o.revokeClient(c.clientId, 'make agent');
const c = await o.createClient({ name: NAME, scopes: [...TASK_SCOPES], createdBy: 'make agent' });
console.log(JSON.stringify({ clientId: c.clientId, clientSecret: c.clientSecret, code: c.code }));
await db.close();
