// The software factory. With no model key it runs in mock mode: recorded answers are replayed and
// nothing reaches a model. Any combination of ANTHROPIC_API_KEY, OPENAI_API_KEY and
// OPENROUTER_API_KEY enables live mode for the providers whose keys are set.
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
    FACTORY_RECORDINGS: z.string().default('apps/factory/recordings'),
    ...ROLE_SETTINGS,
  },
  process.env,
  ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'FACTORY_GATEWAY_TOKEN'],
);
const upstream = upstreamFor(
  {
    anthropic: cfg.ANTHROPIC_API_KEY,
    openai: cfg.OPENAI_API_KEY,
    openrouter: cfg.OPENROUTER_API_KEY,
  },
  cfg.FACTORY_RECORDINGS,
);
const mode = upstream.spends ? 'live' : 'mock';
const app = buildServer({
  gateway: gateway({ ledger: sqlLedger(sql(cfg.CONTROL_DATABASE_URL)), upstream }),
  token: cfg.FACTORY_GATEWAY_TOKEN,
  mode,
  logger: true,
});
await app.listen({ host: '0.0.0.0', port: cfg.FACTORY_PORT });
