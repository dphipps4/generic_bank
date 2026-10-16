// The factory's HTTP surface. An agent's base URL is /gateway/<run>/<role>, where Anthropic's
// Messages API and OpenAI's Chat Completions API both answer; its API key is the gateway token,
// never a real key.
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
  mode: 'live' | 'mock';
  logger?: boolean;
}) {
  // A conversation of screenshots runs to megabytes; the API itself takes up to 32 MB.
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 32 * 1024 * 1024 });
  const token = digest(opts.token);

  app.get('/healthz', async () => ({ ok: true, service: 'factory', mode: opts.mode }));

  const route = (provider: Provider) => async (req: Req, reply: FastifyReply) => {
    // Anthropic's SDK sends the key as x-api-key, OpenAI's as a bearer token.
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
    const key = req.headers['x-api-key'] ?? bearer;
    if (typeof key !== 'string' || !timingSafeEqual(digest(key), token))
      return reply.code(401).send(error('authentication_error', 'invalid gateway token'));
    const { runId, role } = req.params;
    if (!/^[\w-]{1,64}$/.test(runId) || !isRole(role))
      return reply.code(404).send(error('not_found_error', 'no such run or role'));
    if (typeof req.body !== 'object' || req.body === null || Array.isArray(req.body))
      return reply.code(400).send(error('invalid_request_error', 'a JSON object is required'));
    // Anthropic's betas travel as a header; the request is recorded and replayed with them.
    const betas = req.headers['anthropic-beta'];
    const body = req.body as Record<string, unknown>;
    const request =
      provider === 'anthropic' && typeof betas === 'string'
        ? { ...body, betas: betas.split(',').map((b) => b.trim()) }
        : body;
    const r = await opts.gateway.call(provider, runId, role, request);
    return reply.code(r.status).type(r.contentType).send(r.body);
  };
  app.post('/gateway/:runId/:role/v1/messages', route('anthropic'));
  app.post('/gateway/:runId/:role/v1/chat/completions', route('openai'));
  return app;
}
