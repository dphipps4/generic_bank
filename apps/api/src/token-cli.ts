// make api-token: a fresh access token for Swagger UI or curl, for a local developer client that
// is created the first time. Runs inside the API container, which holds the hashing key.
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
const NAME = 'Local developer (make api-token)';

const found = await db.query<{ clientId: string }>(
  'SELECT "clientId" FROM "ApiClient" WHERE name = $1 AND "revokedAt" IS NULL LIMIT 1',
  [NAME],
);
const clientId =
  found.rows[0]?.clientId ??
  (await o.createClient({ name: NAME, scopes: [...TASK_SCOPES], createdBy: 'make api-token' }))
    .clientId;
const t = await o.issueDirect(clientId, 'make api-token');
console.error(
  `Client ${clientId}, scopes: ${t.scope}. The token below works for ${t.expires_in / 60} minutes.`,
);
console.log(t.access_token);
await db.close();
