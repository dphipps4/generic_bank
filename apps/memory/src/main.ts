// The Memory service. In M0 it reports health and whether its database answers.
import Fastify from 'fastify';
import pg from 'pg';
import { z } from 'zod';
import { loadConfig, port } from '@gb/config';

const cfg = loadConfig({ MEMORY_PORT: port(8470), MEMORY_DATABASE_URL: z.url() });
const pool = new pg.Pool({ connectionString: cfg.MEMORY_DATABASE_URL, max: 2 });
const app = Fastify({ logger: true });
app.get('/healthz', async (_req, reply) => {
  try {
    await pool.query('select 1');
    return { ok: true, service: 'memory', database: 'up' };
  } catch {
    return reply.code(503).send({ ok: false, service: 'memory', database: 'down' });
  }
});
await app.listen({ host: '0.0.0.0', port: cfg.MEMORY_PORT });
