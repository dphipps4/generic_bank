// The Task API: typed tasks in, one typed result out. The caller never sees the UI. Every call
// but health and the OAuth2 endpoints carries a bearer access token (plan, §D.6).
import formbody from '@fastify/formbody';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import { problem, TASKS, type TaskName } from '@gb/contracts';
import { allows, type Caller, type OAuth, OAuthError, type TaskScope } from '@gb/oauth';

declare module 'fastify' {
  interface FastifyRequest {
    caller: Caller | null;
  }
}

export const TASK_SCOPE: Record<TaskName, TaskScope> = {
  'check-balance': 'tasks:balance',
  transfer: 'tasks:transfer',
  'download-statements': 'tasks:statements',
};

const PUBLIC = new Set(['/healthz', '/oauth/token', '/oauth/revoke']);

/** Token requests per client per minute. */
const TOKEN_RATE = 20;

const problemJson = (reply: FastifyReply, p: ReturnType<typeof problem>) =>
  reply.code(p.status).type('application/problem+json').send(p);

/** The client's id and secret, from HTTP Basic or from the form body (RFC 6749, §2.3.1). */
function clientCredentials(req: FastifyRequest): { id: string; secret: string } {
  const auth = req.headers.authorization ?? '';
  if (auth.startsWith('Basic ')) {
    const [id = '', secret = ''] = Buffer.from(auth.slice(6), 'base64').toString().split(':');
    return { id: decodeURIComponent(id), secret: decodeURIComponent(secret) };
  }
  const b = (req.body ?? {}) as Record<string, string>;
  return { id: String(b.client_id ?? ''), secret: String(b.client_secret ?? '') };
}

export async function buildServer(opts: {
  oauth: OAuth;
  logger?: boolean;
  now?: () => number;
}): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false });
  await app.register(formbody);
  const now = opts.now ?? Date.now;
  app.decorateRequest('caller', null);

  // Bearer tokens on everything that is not public.
  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0]!;
    if (PUBLIC.has(path)) return;
    const auth = req.headers.authorization ?? '';
    const caller = auth.startsWith('Bearer ')
      ? await opts.oauth.authenticate(auth.slice(7).trim())
      : null;
    if (!caller) {
      return reply
        .code(401)
        .header('www-authenticate', 'Bearer error="invalid_token"')
        .type('application/problem+json')
        .send(problem(401, 'invalid_token', 'A valid bearer access token is required.'));
    }
    req.caller = caller;
  });

  const requireScope = (
    req: FastifyRequest,
    reply: FastifyReply,
    scope: TaskScope,
    bank?: string,
  ) => {
    if (allows(req.caller!, scope, bank)) return true;
    reply.header('www-authenticate', `Bearer error="insufficient_scope", scope="${scope}"`);
    problemJson(
      reply,
      problem(
        403,
        'insufficient_scope',
        `This client may not use ${scope}${bank ? ` on ${bank}` : ''}.`,
      ),
    );
    return false;
  };

  app.get('/healthz', async () => ({ ok: true, service: 'api' }));

  // ── OAuth2 ──────────────────────────────────────────────────────────────────
  const recent = new Map<string, number[]>();
  const limited = (clientId: string) => {
    const t = now();
    const hits = (recent.get(clientId) ?? []).filter((x) => t - x < 60_000);
    hits.push(t);
    recent.set(clientId, hits);
    return hits.length > TOKEN_RATE;
  };
  const oauthError = (reply: FastifyReply, e: unknown) => {
    if (!(e instanceof OAuthError)) throw e;
    if (e.status === 401) reply.header('www-authenticate', 'Basic realm="oauth"');
    return reply
      .code(e.status)
      .header('cache-control', 'no-store')
      .send({ error: e.error, error_description: e.description });
  };

  app.post('/oauth/token', async (req, reply) => {
    const { id, secret } = clientCredentials(req);
    if (limited(id))
      return reply
        .code(429)
        .header('retry-after', '60')
        .send({ error: 'slow_down', error_description: 'Too many token requests.' });
    const b = (req.body ?? {}) as Record<string, string>;
    try {
      const tokens =
        b.grant_type === 'authorization_code'
          ? await opts.oauth.exchangeCode(id, secret, String(b.code ?? ''))
          : b.grant_type === 'refresh_token'
            ? await opts.oauth.refresh(id, secret, String(b.refresh_token ?? ''))
            : null;
      if (!tokens)
        return reply.code(400).send({
          error: 'unsupported_grant_type',
          error_description: 'Use authorization_code or refresh_token.',
        });
      return reply.header('cache-control', 'no-store').header('pragma', 'no-cache').send(tokens);
    } catch (e) {
      return oauthError(reply, e);
    }
  });

  app.post('/oauth/revoke', async (req, reply) => {
    const { id, secret } = clientCredentials(req);
    try {
      await opts.oauth.revoke(
        id,
        secret,
        String(((req.body ?? {}) as Record<string, string>).token ?? ''),
      );
      return reply.code(200).send({});
    } catch (e) {
      return oauthError(reply, e);
    }
  });

  // ── Tasks ───────────────────────────────────────────────────────────────────
  app.get('/tasks', async (req, reply) => {
    if (!requireScope(req, reply, 'tasks:read')) return;
    return {
      tasks: Object.entries(TASKS).map(([name, schema]) => ({
        name,
        scope: TASK_SCOPE[name as TaskName],
        input: z.toJSONSchema(schema),
      })),
    };
  });

  app.post<{ Params: { name: string } }>('/tasks/:name', async (req, reply) => {
    const name = req.params.name as TaskName;
    const schema = TASKS[name];
    if (!schema)
      return problemJson(
        reply,
        problem(404, 'no_such_task', 'There is no task by that name; GET /tasks lists them.'),
      );
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .type('application/problem+json')
        .send({
          ...problem(400, 'invalid_input', 'The input did not match the task’s schema.'),
          fields: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        });
    }
    if (!requireScope(req, reply, TASK_SCOPE[name], parsed.data.bank)) return;
    // Runs are wired in a later step of this milestone. Until then the API says so plainly.
    return problemJson(
      reply,
      problem(501, 'not_built_yet', 'Tasks are accepted once runs are wired in.'),
    );
  });

  return app;
}
