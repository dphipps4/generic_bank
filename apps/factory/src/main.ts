// The software factory. Every model call goes through its gateway to the provider whose key is
// set: OPENROUTER_API_KEY for the default models, or ANTHROPIC_API_KEY or OPENAI_API_KEY. With no
// key for a role's provider, that role's calls are refused; nothing stands in for the model.
import { loadConfig, port, secret } from '@gb/config';
import { sql } from '@gb/db';
import { z } from 'zod';
import { gateway } from './gateway.js';
import { sqlLedger } from './ledger.js';
import { ROLE_SETTINGS } from './models.js';
import { buildServer } from './server.js';
import { upstreamFor } from './upstream.js';

const cfg = loadConfig(
  {
    FACTORY_PORT: port(8200),
    ANTHROPIC_API_KEY: z.string().default(''),
    OPENAI_API_KEY: z.string().default(''),
    OPENROUTER_API_KEY: z.string().default(''),
    FACTORY_GATEWAY_TOKEN: secret(),
    CONTROL_DATABASE_URL: z.string().startsWith('postgresql://'),
    ...ROLE_SETTINGS,
  },
  process.env,
  ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'FACTORY_GATEWAY_TOKEN'],
);
const upstream = upstreamFor({
  anthropic: cfg.ANTHROPIC_API_KEY,
  openai: cfg.OPENAI_API_KEY,
  openrouter: cfg.OPENROUTER_API_KEY,
});
const app = buildServer({
  gateway: gateway({ ledger: sqlLedger(sql(cfg.CONTROL_DATABASE_URL)), upstream }),
  token: cfg.FACTORY_GATEWAY_TOKEN,
  logger: true,
});
await app.listen({ host: '0.0.0.0', port: cfg.FACTORY_PORT });
