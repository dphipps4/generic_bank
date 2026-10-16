// The Task API: typed tasks in, one typed result out. The caller never sees the UI. Every call
// but health and the OAuth2 endpoints carries a bearer access token (plan, §A.7).
import formbody from '@fastify/formbody';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  httpStatus,
  problem,
  TASKS,
  type TaskName,
  type TaskResult,
  type TransferInput,
} from '@gb/contracts';
import {
  createRun,
  DuplicateRun,
  newMemoToken,
  noteAsk,
  resultOf,
  statementKey,
  statementOf,
  waitForResult,
} from '@gb/runs';
import { allows, type Caller, type OAuth, OAuthError, type Sql, type TaskScope } from '@gb/oauth';
import { banks, openapi, TASK_SCOPE, tools } from './catalog.js';

declare module 'fastify' {
  interface FastifyRequest {
    caller: Caller | null;
  }
}

export { TASK_SCOPE };

/** An account as the caller named it, so `Checking` and `checking ` are the same account. */
const sameRef = (ref: string) => ref.trim().toLowerCase();

/**
 * What a run is sealed with. A transfer gets its memo token here, once, so the Runner, every resume
 * and every history read look for the same one; a retry with the same key reuses the run and so the
 * token. What makes two transfers the same request is the member, the accounts and the amount.
 */
function prepare(name: TaskName, data: Record<string, unknown>) {
  if (name !== 'transfer') return { inputs: data };
  const t = data as z.infer<typeof TransferInput>;
  return {
    inputs: { ...t, memoToken: newMemoToken() },
    idempotencyKey: t.idempotencyKey,
    dedupeOn: [t.memberId, sameRef(t.from), sameRef(t.to), t.amountCents],
  };
}

const PUBLIC = new Set(['/healthz', '/oauth/token', '/oauth/revoke', '/openapi.json']);
/** Swagger UI and its assets are public; the calls it makes carry the token you paste in. */
const isPublic = (path: string) =>
  PUBLIC.has(path) || path === '/docs' || path.startsWith('/docs/');

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
  sql: Sql;
  /** Seals a run's inputs; only the API and the Runner hold it. */
  sealKey: string;
  /** Hands a new run to the Runner (the workflow queue). */
  enqueue: (runId: string) => Promise<void>;
  /** Where the Runner keeps the statements it downloaded (MinIO). */
  documents?: { get(key: string): Promise<Buffer | null> };
  logger?: boolean;
  now?: () => number;
}): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false });
  await app.register(formbody);
  // The document is ours, generated from the contracts; the plugins only serve it.
  await app.register(swagger, { mode: 'static', specification: { document: openapi() as never } });
  await app.register(swaggerUi, {
    routePrefix: '/docs',
    // A link to /docs#/tasks/check_balance opens that call; Authorize lasts across page loads,
    // so each link in the docs lands signed in (a token lasts 15 minutes).
    uiConfig: { deepLinking: true, persistAuthorization: true, tryItOutEnabled: true },
  });
  const now = opts.now ?? Date.now;
  app.decorateRequest('caller', null);

  // Bearer tokens on everything that is not public.
  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0]!;
    if (isPublic(path)) return;
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
  app.get('/openapi.json', async () => openapi());

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
        b.grant_type === 'client_credentials'
          ? await opts.oauth.clientCredentials(id, secret)
          : b.grant_type === 'authorization_code'
            ? await opts.oauth.exchangeCode(id, secret, String(b.code ?? ''))
            : b.grant_type === 'refresh_token'
              ? await opts.oauth.refresh(id, secret, String(b.refresh_token ?? ''))
              : null;
      if (!tokens)
        return reply.code(400).send({
          error: 'unsupported_grant_type',
          error_description: 'Use client_credentials, authorization_code or refresh_token.',
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
  app.get('/banks', async (req, reply) => {
    if (!requireScope(req, reply, 'tasks:read')) return;
    const all = await banks(opts.sql);
    // A client limited to some banks sees only those.
    const only = req.caller!.scopes.filter((x) => x.startsWith('bank:')).map((x) => x.slice(5));
    return only.length ? all.filter((b) => only.includes(b.id)) : all;
  });

  app.get('/tools', async (req, reply) => {
    if (!requireScope(req, reply, 'tasks:read')) return;
    return { tools: tools() };
  });

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
    // The registry decides: the bank must exist, and a promoted crawler must serve this task on it.
    const all = await banks(opts.sql);
    const bank = all.find((b) => b.id === parsed.data.bank);
    const serving = all.filter((b) => b.tasks.some((t) => t.task === name)).map((b) => b.id);
    if (!bank || !bank.tasks.some((t) => t.task === name)) {
      return reply
        .code(404)
        .type('application/problem+json')
        .send({
          ...problem(
            404,
            bank ? 'task_not_available' : 'unknown_bank',
            bank
              ? `No promoted crawler serves ${name} on ${bank.id} right now.`
              : 'There is no bank by that id; GET /banks lists them.',
          ),
          banksThatSupportIt: serving,
        });
    }
    let runId: string;
    try {
      ({ runId } = await createRun(
        opts.sql,
        {
          task: name,
          bank: parsed.data.bank,
          clientId: req.caller!.clientId,
          ...prepare(name, parsed.data as Record<string, unknown>),
        },
        opts.sealKey,
      ).then(async (r) => {
        // The same request again is the agent asking again.
        if (r.existing) await noteAsk(opts.sql, r.runId);
        else await opts.enqueue(r.runId);
        return r;
      }));
    } catch (e) {
      // Plan, §3: while a transfer is open, the same transfer again is refused and points to it.
      if (!(e instanceof DuplicateRun)) throw e;
      return reply
        .code(409)
        .header('location', `/tasks/${e.runId}`)
        .type('application/problem+json')
        .send(
          problem(
            409,
            'duplicate_transfer',
            'A transfer for the same member, accounts and amount is already open; runId names it.',
            { runId: e.runId },
          ),
        );
    }
    const result = await resultOf(opts.sql, runId);
    return answer(reply, result!);
  });

  app.get<{ Params: { runId: string }; Querystring: { wait?: string } }>(
    '/tasks/:runId',
    async (req, reply) => {
      if (!requireScope(req, reply, 'tasks:read')) return;
      // A run is visible only to the client that started it.
      const owner = await opts.sql.query<{ clientId: string | null }>(
        'SELECT "clientId" FROM "TaskRun" WHERE id = $1',
        [req.params.runId],
      );
      if (!owner.rows[0] || owner.rows[0].clientId !== req.caller!.clientId) {
        return problemJson(reply, problem(404, 'no_such_run', 'There is no run with that id.'));
      }
      await noteAsk(opts.sql, req.params.runId);
      const result = await waitForResult(
        opts.sql,
        req.params.runId,
        Number(req.query.wait ?? 0) || 0,
      );
      return answer(reply, result!);
    },
  );

  // A statement a run kept, by the reference in its result: only to the client that started the
  // run, and only with tasks:statements for that run's bank.
  app.get<{ Params: { ref: string } }>('/statements/:ref', async (req, reply) => {
    if (!requireScope(req, reply, 'tasks:statements')) return;
    const none = () =>
      problemJson(
        reply,
        problem(404, 'no_such_statement', 'There is no statement by that reference.'),
      );
    const ref = statementOf(req.params.ref);
    if (!ref) return none();
    const run = (
      await opts.sql.query<{
        clientId: string | null;
        bank: string;
        task: string;
        result: unknown;
      }>('SELECT "clientId", bank, task, result FROM "TaskRun" WHERE id = $1', [ref.runId])
    ).rows[0];
    if (!run || run.clientId !== req.caller!.clientId || run.task !== 'download-statements')
      return none();
    if (!requireScope(req, reply, 'tasks:statements', run.bank)) return;
    const months = (run.result as { months?: { statement: string | null }[] } | null)?.months;
    if (!months?.some((m) => m.statement === req.params.ref)) return none();
    const pdf = await opts.documents?.get(statementKey(ref.runId, ref.month));
    if (!pdf) return none();
    return reply
      .type('application/pdf')
      .header('content-disposition', `inline; filename="statement-${ref.month}.pdf"`)
      .header('cache-control', 'no-store')
      .send(pdf);
  });

  /** A result as HTTP (plan, §A.1): the status code says what to do next. */
  function answer(reply: FastifyReply, r: TaskResult) {
    const status = httpStatus(r);
    reply.header('location', `/tasks/${r.runId}`);
    if (status === 202) return reply.code(202).header('retry-after', '5').send(r);
    if (status === 200) return reply.code(200).send(r);
    if (status === 503) reply.header('retry-after', '30');
    // The result's own members (escalationId, resolvable, …) ride along; the problem's status is
    // the HTTP status, as RFC 9457 has it, never the run's.
    return reply
      .code(status)
      .type('application/problem+json')
      .send({
        ...r,
        ...problem(status, r.code ?? r.status, r.message ?? '', {
          runId: r.runId,
          retryable: r.retryable ?? false,
        }),
      });
  }

  return app;
}
