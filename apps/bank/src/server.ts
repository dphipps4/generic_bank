import Fastify, { type FastifyInstance } from 'fastify';
import type { Tenant } from './tenants.js';

// Until M1, each bank serves one honest placeholder page in its own look.
function placeholder(t: Tenant): string {
  if (t.id === 'generic') {
    return `<HTML><HEAD><TITLE>${t.brand} - CoreLink Branch Console</TITLE></HEAD>
<BODY BGCOLOR="#C0C0C0"><CENTER>
<TABLE BORDER="2" CELLPADDING="6" BGCOLOR="#FFFFFF" WIDTH="760"><TR><TD>
<FONT FACE="Verdana" SIZE="2"><MARQUEE>Welcome to ${t.brand} Online Branch</MARQUEE>
<P><B>CoreLink Branch Console ${t.version}</B></P>
<P>The console opens in milestone M1.</P>
<HR><FONT SIZE="1">Best viewed in Internet Explorer at 800x600.</FONT></FONT>
</TD></TR></TABLE></CENTER></BODY></HTML>`;
  }
  return `<!doctype html><html><head><title>${t.brand}</title></head><body>
<h1>${t.brand}</h1><p>CoreLink Branch Console ${t.version}. The console opens in milestone M1.</p>
</body></html>`;
}

export function buildServer(t: Tenant, logger = false): FastifyInstance {
  const app = Fastify({ logger });
  app.get('/healthz', async () => ({ ok: true, service: 'bank', tenant: t.id }));
  app.get('/', async (_req, reply) =>
    t.basePath === '/' ? reply.type('text/html').send(placeholder(t)) : reply.redirect(t.basePath),
  );
  if (t.basePath !== '/') {
    app.get(t.basePath, async (_req, reply) => reply.type('text/html').send(placeholder(t)));
  }
  return app;
}
