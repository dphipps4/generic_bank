import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import Fastify, { type FastifyInstance } from 'fastify';
import { type Bank, COOKIE, rotateNonce } from './context.js';
import { HEADER, type RequestHazards } from './hazards.js';
import { buttonSvg, CORELINK_JS, NEW_SVG, SPACER_GIF } from './markup/html.js';
import { consoleRoutes } from './routes/console.js';
import { signInRoutes } from './routes/signin.js';

export type { Bank } from './context.js';
export { hazardLog } from './context.js';

const GATEWAY_503 = `<HTML><HEAD><TITLE>503 Service Unavailable</TITLE></HEAD><BODY BGCOLOR="#FFFFFF">
<H1>Service Unavailable</H1><P>The server is temporarily unable to service your request. Please try again later.</P>
<HR><ADDRESS>CoreLink Gateway</ADDRESS></BODY></HTML>`;

const calm: RequestHazards = { forced: false, on: () => false, latencyMs: () => 0 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function buildServer(bank: Bank, logger = false): Promise<FastifyInstance> {
  const app = Fastify({ logger });
  await app.register(cookie);
  await app.register(formbody);
  const base = bank.t.basePath;
  app.decorateRequest('hz', null as unknown as RequestHazards);
  app.decorateRequest('nonce', '');

  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0] ?? req.url;
    req.nonce = req.cookies[COOKIE.form] ?? '';
    if (path === '/healthz' || path.startsWith(`${base}js/`) || path.startsWith(`${base}img/`)) {
      req.hz = calm;
      return;
    }
    if (!req.nonce) rotateNonce(bank, req, reply);
    const h = bank.hazards.forRequest(req.headers[HEADER] as string | undefined, path);
    if (h === 'bad-signature')
      return reply.code(400).type('text/plain').send('Bad X-Hazards header.');
    req.hz = h;
    const ms = h.latencyMs();
    if (ms) await sleep(ms);
    if (h.on('service-unavailable')) return reply.code(503).type('text/html').send(GATEWAY_503);
  });

  app.get('/healthz', async () => ({ ok: true, service: 'bank', tenant: bank.t.id }));
  app.get(`${base}js/corelink.js`, async (_req, reply) =>
    reply.type('application/javascript').send(CORELINK_JS),
  );
  app.get(`${base}img/spacer.gif`, async (_req, reply) => reply.type('image/gif').send(SPACER_GIF));
  app.get(`${base}img/new.svg`, async (_req, reply) => reply.type('image/svg+xml').send(NEW_SVG));
  app.get<{ Querystring: { l?: string; t?: string } }>(`${base}img/btn.svg`, async (req, reply) =>
    reply
      .type('image/svg+xml')
      .send(buttonSvg(String(req.query.l ?? '').slice(0, 40), String(req.query.t ?? ''))),
  );
  if (base !== '/') app.get('/', async (_req, reply) => reply.redirect(base));

  signInRoutes(app, bank);
  consoleRoutes(app, bank);
  return app;
}
