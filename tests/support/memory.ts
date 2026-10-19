// The Memory service for tests that reach it as the factory does, over HTTP: the real
// server and every real migration, on an in-process Postgres with pgvector, and the test embedder
// in place of the model. It starts empty, as memory does.
// It can be stopped and started again on the same address and database, as when memory restarts.
import type { AddressInfo } from 'node:net';
import { episodes } from '../../apps/memory/src/episodes.js';
import { knowledgeRoutes } from '../../apps/memory/src/knowledge.js';
import { buildServer } from '../../apps/memory/src/server.js';
import { memoryDb, SIGNING_KEY, testDoor, testEmbed, TOKENS } from '../../apps/memory/test/db.js';

export { SIGNING_KEY, TOKENS };

export async function memoryService() {
  const db = await memoryDb();
  let app: ReturnType<typeof buildServer> | null = null;
  let port = 0;
  async function start() {
    app = buildServer({ db, door: testDoor(), writes: episodes(db, testEmbed) });
    knowledgeRoutes(app, db, testEmbed);
    await app.listen({ host: '127.0.0.1', port });
    port = (app.server.address() as AddressInfo).port;
  }
  await start();
  const url = `http://127.0.0.1:${port}`;
  return {
    db,
    url,
    /** What the factory is given: memory's address, its role's token and the signing key. */
    factory: { url, token: TOKENS.factory, signingKey: SIGNING_KEY },
    /** Memory stops answering; its database stays. */
    async stop() {
      await app?.close();
      app = null;
    },
    /** Memory answers again, on the same address. */
    start,
    async close() {
      await app?.close();
      await db.close();
    },
  };
}
