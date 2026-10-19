// The factory's HTTP surface. An agent's base URL is /gateway/<run>/<role>, where OpenAI's Chat
// Completions API answers; its API key is the gateway token, never a real key.
import { createHash, timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { isRole, type Provider } from './models.js';
import type { gateway } from './gateway.js';

const digest = (s: string) => createHash('sha256').update(s).digest();
const error = (type: string, message: string) => ({ type: 'error', error: { type, message } });

type Req = FastifyRequest<{ Params: { runId: string; role: string }; Body: unknown }>;

export function buildServer(opts: {
  gateway: ReturnType<typeof gateway>;
  token: string;
  logger?: boolean;
}) {
  // A conversation of screenshots runs to megabytes; the API itself takes up to 32 MB.
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 32 * 1024 * 1024 });
  const token = digest(opts.token);

  app.get('/healthz', async () => ({ ok: true, service: 'factory' }));

  const route = (provider: Provider) => async (req: Req, reply: FastifyReply) => {
    const key = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
    if (typeof key !== 'string' || !timingSafeEqual(digest(key), token))
      return reply.code(401).send(error('authentication_error', 'invalid gateway token'));
    const { runId, role } = req.params;
    if (!/^[\w-]{1,64}$/.test(runId) || !isRole(role))
      return reply.code(404).send(error('not_found_error', 'no such run or role'));
    if (typeof req.body !== 'object' || req.body === null || Array.isArray(req.body))
      return reply.code(400).send(error('invalid_request_error', 'a JSON object is required'));
    const r = await opts.gateway.call(provider, runId, role, req.body as Record<string, unknown>);
    return reply.code(r.status).type(r.contentType).send(r.body);
  };
  app.post('/gateway/:runId/:role/v1/chat/completions', route('openai'));
  app.post('/gateway/:runId/:role/openrouter/v1/chat/completions', route('openrouter'));
  return app;
}
