// The Memory service: the only process that opens the memory database. It verifies the change
// log and loads its embedding model before it serves, and stays read-only if the chain does not
// hold.
import { z } from 'zod';
import { loadConfig, port, secret } from '@gb/config';
import { pgDb } from './db.js';
import { door } from './door.js';
import { localEmbedder } from './embed.js';
import { episodes } from './episodes.js';
import { knowledgeRoutes } from './knowledge.js';
import { openMemory } from './memory.js';
import { buildServer } from './server.js';

const cfg = loadConfig(
  {
    MEMORY_PORT: port(8470),
    MEMORY_DATABASE_URL: z.url(),
    MEMORY_TOKEN_RUNNER: secret(),
    MEMORY_TOKEN_FACTORY: secret(),
    MEMORY_TOKEN_CURATOR: secret(),
    MEMORY_TOKEN_SYSTEM: secret(),
    MEMORY_SIGNING_KEY: secret(),
    MEMORY_MODEL_DIR: z.string().min(1).optional(),
  },
  process.env,
  [
    'MEMORY_TOKEN_RUNNER',
    'MEMORY_TOKEN_FACTORY',
    'MEMORY_TOKEN_CURATOR',
    'MEMORY_TOKEN_SYSTEM',
    'MEMORY_SIGNING_KEY',
  ],
);
const db = pgDb(cfg.MEMORY_DATABASE_URL);
const memory = openMemory(db, {
  onBroken: (v) => app.log.error(v, 'the change log failed verification; memory is read-only'),
});
const embed = localEmbedder({ cacheDir: cfg.MEMORY_MODEL_DIR });
const app = buildServer({
  db,
  memory,
  door: door({
    tokens: {
      runner: cfg.MEMORY_TOKEN_RUNNER,
      factory: cfg.MEMORY_TOKEN_FACTORY,
      curator: cfg.MEMORY_TOKEN_CURATOR,
      system: cfg.MEMORY_TOKEN_SYSTEM,
    },
    signingKey: cfg.MEMORY_SIGNING_KEY,
  }),
  writes: episodes(memory, embed),
  logger: true,
});
knowledgeRoutes(app, db, embed);
await memory.verify();
await embed('ready');
await app.listen({ host: '0.0.0.0', port: cfg.MEMORY_PORT });
