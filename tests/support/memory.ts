// The Memory service for tests that reach it as the factory and the Runner do, over HTTP: the real
// server and every real migration, on an in-process Postgres with pgvector, and the test embedder
// in place of the model. Seeded, it starts from seeds/memory through its own door, as the curator.
import { join } from 'node:path';
import { catalogRoutes, curated } from '../../apps/memory/src/curated.js';
import { episodes } from '../../apps/memory/src/episodes.js';
import { factRoutes, facts } from '../../apps/memory/src/facts.js';
import { knowledgeRoutes } from '../../apps/memory/src/knowledge.js';
import { openMemory } from '../../apps/memory/src/memory.js';
import { seed } from '../../apps/memory/src/seed.js';
import { buildServer } from '../../apps/memory/src/server.js';
import { memoryDb, SIGNING_KEY, testDoor, testEmbed, TOKENS } from '../../apps/memory/test/db.js';

export const SEEDS = join(import.meta.dirname, '../../seeds/memory');
export { SIGNING_KEY, TOKENS };

export async function memoryService(o: { seeded?: boolean } = {}) {
  const db = await memoryDb();
  const memory = openMemory(db);
  const app = buildServer({
    db,
    memory,
    door: testDoor(),
    writes: { ...episodes(memory, testEmbed), ...curated(memory, testEmbed), ...facts(memory) },
  });
  catalogRoutes(app, db);
  knowledgeRoutes(app, db, testEmbed);
  factRoutes(app, db);
  const url = await app.listen({ host: '127.0.0.1', port: 0 });
  if (o.seeded) await seed({ dir: SEEDS, url, token: TOKENS.curator, signingKey: SIGNING_KEY });
  return {
    db,
    app,
    url,
    /** What the factory is given: memory's address, its role's token and the signing key. */
    factory: { url, token: TOKENS.factory, signingKey: SIGNING_KEY },
    async close() {
      await app.close();
      await db.close();
    },
  };
}
