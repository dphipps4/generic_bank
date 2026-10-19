import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import Fastify, { type FastifyInstance } from 'fastify';
import { accessDenied, botReason, reference } from './botscreen.js';
import { type Bank, COOKIE, refusalLog, rotateNonce } from './context.js';
import { HEADER, type RequestHazards } from './hazards.js';
import { buttonSvg, CORELINK_JS, logoSvg, NEW_SVG, SPACER_GIF } from './markup/html.js';
import { pixelImage } from './markup/pixels.js';
import { consoleRoutes } from './routes/console.js';
import { layoutRoutes } from './routes/layout.js';
import { signInRoutes } from './routes/signin.js';
import { transferRoutes } from './routes/transfer.js';

export type { Bank } from './context.js';
export { hazardLog } from './context.js';

const GATEWAY_503 = `<HTML><HEAD><TITLE>503 Service Unavailable</TITLE></HEAD><BODY BGCOLOR="#FFFFFF">
<H1>Service Unavailable</H1><P>The server is temporarily unable to service your request. Please try again later.</P>
<HR><ADDRESS>CoreLink Gateway</ADDRESS></BODY></HTML>`;

const calm: RequestHazards = { forced: false, on: () => false, latencyMs: () => 0 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Where a person's pasted hazards are kept for their session. */
const HAZARD_COOKIE = 'cl_hazards';

export async function buildServer(bank: Bank, logger = false): Promise<FastifyInstance> {
  const app = Fastify({ logger });
  await app.register(cookie);
  await app.register(formbody);
  const base = bank.t.basePath;
  app.decorateRequest('hz', null as unknown as RequestHazards);
  app.decorateRequest('nonce', '');

  // The bot screen comes first: a refused request sees no hazard and gets no
  // cookie. Health checks pass; the bank-admin API is a server of its own and is never screened.
  if (bank.t.botScreen)
    app.addHook('onRequest', async (req, reply) => {
      const path = req.url.split('?')[0] ?? req.url;
      if (path === '/healthz') return;
      const reason = botReason(req.headers);
      if (!reason) return;
      const ref = reference();
      await refusalLog(bank, path, `${reason}, reference ${ref}`);
      return reply.code(403).type('text/html').send(accessDenied(bank.t, ref));
    });

  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0] ?? req.url;
    req.nonce = req.cookies[COOKIE.form] ?? '';
    if (path === '/healthz' || path.startsWith(`${base}js/`) || path.startsWith(`${base}img/`)) {
      req.hz = calm;
      return;
    }
    // A form nonce belongs to the pages its cookie reaches. A request outside them (a browser asks
    // for /favicon.ico on every site) never carries the cookie; answering it with a fresh nonce
    // would replace the one the form on screen was drawn with.
    if (!req.nonce && path.startsWith(base)) rotateNonce(bank, req, reply);
    // Forced hazards come in the runner's signed header; a person can paste the same signed value
    // onto any page's address (?hazards=…), and the bank keeps it for the rest of their session.
    // ?hazards= with nothing after it stops them.
    const q = (req.query ?? {}) as { hazards?: string };
    let forced = req.headers[HEADER] as string | undefined;
    if (forced === undefined && typeof q.hazards === 'string') {
      if (q.hazards) {
        forced = q.hazards;
        reply.setCookie(HAZARD_COOKIE, q.hazards, { path: base, httpOnly: true, sameSite: 'lax' });
      } else reply.clearCookie(HAZARD_COOKIE, { path: base });
    } else if (forced === undefined) forced = req.cookies[HAZARD_COOKIE];
    const h = bank.hazards.forRequest(forced, path);
    if (h === 'bad-signature')
      return reply
        .code(400)
        .type('text/plain')
        .send('Bad hazards: copy them again from the hazard lab.');
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
  app.get(`${base}img/logo.svg`, async (_req, reply) =>
    reply.type('image/svg+xml').send(logoSvg(bank.t.theme, bank.t.brand)),
  );
  app.get<{ Querystring: { l?: string; t?: string } }>(`${base}img/btn.svg`, async (req, reply) =>
    reply
      .type('image/svg+xml')
      .send(buttonSvg(String(req.query.l ?? '').slice(0, 40), String(req.query.t ?? ''))),
  );
  app.get<{ Params: { file: string } }>(`${base}img/t/:file`, async (req, reply) => {
    const img = pixelImage(req.params.file.replace(/\.png$/, ''));
    return img ? reply.type('image/png').send(img) : reply.code(404).send();
  });
  if (base !== '/') app.get('/', async (_req, reply) => reply.redirect(base));

  signInRoutes(app, bank);
  layoutRoutes(app, bank);
  consoleRoutes(app, bank);
  transferRoutes(app, bank);
  return app;
}
