// The Task API: typed tasks in, one typed result out. The caller never sees the UI.
import { timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { TASKS, type TaskName } from '@gb/contracts';

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function buildServer(opts: { apiKey: string; logger?: boolean }): FastifyInstance {
  const app = Fastify({ logger: opts.logger ?? false });

  app.get('/healthz', async () => ({ ok: true, service: 'api' }));

  app.addHook('onRequest', async (req, reply) => {
    if (req.url === '/healthz') return;
    const key = req.headers['x-api-key'];
    if (typeof key !== 'string' || !sameSecret(key, opts.apiKey)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
  });

  app.get('/tasks', async () => ({
    tasks: Object.entries(TASKS).map(([name, schema]) => ({
      name,
      input: z.toJSONSchema(schema),
    })),
  }));

  app.post<{ Params: { name: string } }>('/tasks/:name', async (req, reply) => {
    const schema = TASKS[req.params.name as TaskName];
    if (!schema) return reply.code(404).send({ error: 'no such task' });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid input',
        fields: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    // The workflow that runs tasks lands in M3. Until then the API says so plainly.
    return reply.code(501).send({ error: 'not built yet: tasks run from milestone M3' });
  });

  return app;
}
