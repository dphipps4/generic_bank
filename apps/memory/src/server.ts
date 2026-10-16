// The Memory service's HTTP surface.
import Fastify from 'fastify';
import { z } from 'zod';
import type { Db } from './db.js';
import type { Memory } from './memory.js';

const History = z.object({
  entity: z.string().min(1).optional(),
  id: z.string().min(1).optional(),
  run: z.string().min(1).optional(),
  since: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
});

export function buildServer(opts: { db: Db; memory: Memory; logger?: boolean }) {
  const app = Fastify({ logger: opts.logger ?? false });

  app.get('/healthz', async (_req, reply) => {
    try {
      await opts.db.query('SELECT 1');
      return { ok: true, service: 'memory', database: 'up', readOnly: opts.memory.readOnly };
    } catch {
      return reply.code(503).send({ ok: false, service: 'memory', database: 'down' });
    }
  });

  app.get('/history', async (req, reply) => {
    const q = History.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: 'bad_query', issues: q.error.issues });
    return { changes: await opts.memory.history(q.data) };
  });

  app.get('/history/verify', async () => opts.memory.verify());

  return app;
}
