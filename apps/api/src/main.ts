import { loadConfig, port, secret } from '@gb/config';
import { sql } from '@gb/db';
import { oauth } from '@gb/oauth';
import { z } from 'zod';
import { buildServer } from './server.js';

const cfg = loadConfig({
  API_TOKEN_HASH_KEY: secret(),
  CONTROL_DATABASE_URL: z.string().startsWith('postgresql://'),
  API_PORT: port(8000),
});
const app = await buildServer({
  oauth: oauth(sql(cfg.CONTROL_DATABASE_URL), cfg.API_TOKEN_HASH_KEY),
  logger: true,
});
await app.listen({ host: '0.0.0.0', port: cfg.API_PORT });
