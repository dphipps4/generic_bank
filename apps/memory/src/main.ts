// The Memory service: the only process that opens the memory database. It verifies the change
// log before it serves, and stays read-only if the chain does not hold.
import { z } from 'zod';
import { loadConfig, port } from '@gb/config';
import { pgDb } from './db.js';
import { openMemory } from './memory.js';
import { buildServer } from './server.js';

const cfg = loadConfig({ MEMORY_PORT: port(8470), MEMORY_DATABASE_URL: z.url() });
const db = pgDb(cfg.MEMORY_DATABASE_URL);
const memory = openMemory(db, {
  onBroken: (v) => app.log.error(v, 'the change log failed verification; memory is read-only'),
});
const app = buildServer({ db, memory, logger: true });
await memory.verify();
await app.listen({ host: '0.0.0.0', port: cfg.MEMORY_PORT });
