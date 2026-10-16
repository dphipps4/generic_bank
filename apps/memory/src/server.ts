// The Memory service's HTTP surface. Everything but healthz needs a role's token; a write must
// also be signed, be one its role may make, and pass the privacy screen, before it runs.
import Fastify from 'fastify';
import { z } from 'zod';
import type { Db } from './db.js';
import { SIGNATURE, type Door, type Write } from './door.js';
import { ReadOnly, Refused, type Memory, type Role } from './memory.js';
import { screen } from './screen.js';

declare module 'fastify' {
  interface FastifyRequest {
    role?: Role;
    rawBody?: string;
  }
}

/** A write's own work, once the door has let it through. Its result is the response: 201, or 200
 *  when it says `written: false`. */
export type WriteHandler = (body: unknown, role: Role) => Promise<unknown>;

const History = z.object({
  entity: z.string().min(1).optional(),
  id: z.string().min(1).optional(),
  run: z.string().min(1).optional(),
  since: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
});

const forbidden = (message: string) => ({ error: 'role_forbidden', message });

export function buildServer(opts: {
  db: Db;
  memory: Memory;
  door: Door;
  writes?: Partial<Record<Write, WriteHandler>>;
  logger?: boolean;
}) {
  const app = Fastify({ logger: opts.logger ?? false });

  // The signature covers the exact bytes sent, so the body is kept as it arrived.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    req.rawBody = body as string;
    try {
      done(null, body === '' ? undefined : JSON.parse(body as string));
    } catch {
      done(Object.assign(new Error('the body is not JSON'), { statusCode: 400 }));
    }
  });

  app.addHook('onRequest', async (req, reply) => {
    if (req.routeOptions.url === '/healthz') return;
    req.role = opts.door.roleOf(req.headers.authorization);
    if (!req.role) return reply.code(401).send({ error: 'unauthorized' });
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ReadOnly) return reply.code(503).send({ error: 'read_only' });
    if (err instanceof Refused)
      return reply.code(err.status).send({ error: err.code, message: err.message });
    if (err instanceof z.ZodError)
      return reply.code(400).send({ error: 'bad_body', issues: err.issues });
    return reply.send(err);
  });

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

  for (const [write, handler] of Object.entries(opts.writes ?? {}) as [Write, WriteHandler][]) {
    app.post(`/${write}`, async (req, reply) => {
      const role = req.role!;
      if (!opts.door.signed(req.method, req.url, req.rawBody ?? '', req.headers[SIGNATURE]))
        return reply.code(403).send(forbidden('the write is not signed'));
      if (!opts.door.allows(role, write))
        return reply.code(403).send(forbidden(`the ${role} role may not write ${write}`));
      const screened = screen(req.body);
      if (!screened.ok)
        return reply
          .code(422)
          .send({ error: 'privacy_screen', reason: screened.reason, path: screened.path });
      const out = await handler(req.body, role);
      const written = (out as { written?: boolean } | null)?.written !== false;
      return reply.code(written ? 201 : 200).send(out);
    });
  }

  return app;
}
