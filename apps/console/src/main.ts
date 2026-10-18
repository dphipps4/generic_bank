// The Console: AdminJS over the control database, behind a local sign-in.
import AdminJSFastify from '@adminjs/fastify';
import { DBOSClient } from '@dbos-inc/dbos-sdk';
import { Database, Resource } from '@adminjs/prisma';
import AdminJS from 'adminjs';
import argon2 from 'argon2';
import Fastify, { type FastifyRequest } from 'fastify';
import { z } from 'zod';
import { loadConfig, port, secret } from '@gb/config';
import { db, sql } from '@gb/db';
import { oauth } from '@gb/oauth';
import { WORKFLOW } from '@gb/runs';
import { apiClientActions, onceStore } from './api-clients.js';
import { ADMIN_BAR_JS, showLabInNav } from './pages/layout.js';
import { dashboardPages, landOnDashboard } from './pages/dashboard.js';
import { freezePages } from './pages/freezes.js';
import { inboxPages } from './pages/inbox.js';
import { labPages, throughTheApi } from './pages/lab.js';
import { recommendationPages } from './pages/recommendations.js';
import { runPages, type Viewer } from './pages/runs.js';
import { fileStore } from '@gb/evidence';
import { resources } from './resources.js';

const cfg = loadConfig(
  {
    CONSOLE_PORT: port(8080),
    CONSOLE_SESSION_SECRET: secret(),
    CONSOLE_COOKIE_SECRET: secret(),
    CONSOLE_ADMIN_EMAIL: z.email(),
    CONSOLE_ADMIN_PASSWORD: z.string().min(12),
    API_TOKEN_HASH_KEY: secret(),
    CONTROL_DATABASE_URL: z.string().startsWith('postgresql://'),
    EVIDENCE_DIR: z.string().min(1).default('/data/evidence'),
    ANSWER_SEAL_KEY: secret(),
    HAZARDS_FORCEABLE: z.enum(['true', 'false']).default('false'),
    // Signs a hazard for a bank's address in the lab; only on a stack whose banks obey them.
    HAZARD_HMAC_KEY: secret().optional(),
    API_URL: z.url().default('http://api:8000'),
    // The host ports a browser reaches the Task API and the staff inbox on, for the Dashboard's links.
    API_PORT: port(8000),
    BANK_INBOX_PORT: port(8089),
  },
  process.env,
  [
    'CONSOLE_SESSION_SECRET',
    'CONSOLE_COOKIE_SECRET',
    'API_TOKEN_HASH_KEY',
    'ANSWER_SEAL_KEY',
    'HAZARD_HMAC_KEY',
  ],
);

const client = db();
const control = sql(cfg.CONTROL_DATABASE_URL);
const tokens = oauth(control, cfg.API_TOKEN_HASH_KEY);

// The first admin comes from .env; later users are created in the Console.
const existing = await client.consoleUser.findUnique({ where: { email: cfg.CONSOLE_ADMIN_EMAIL } });
if (!existing) {
  await client.consoleUser.create({
    data: {
      email: cfg.CONSOLE_ADMIN_EMAIL,
      passwordHash: await argon2.hash(cfg.CONSOLE_ADMIN_PASSWORD),
      role: 'admin',
    },
  });
}

AdminJS.registerAdapter({ Database, Resource });
const once = onceStore();
// Mounted at /admin: at the root, AdminJS builds API paths that begin with '//', which a browser
// reads as another host. The root redirects here.
const admin = new AdminJS({
  rootPath: '/admin',
  loginPath: '/admin/login',
  logoutPath: '/admin/logout',
  resources: resources(client, apiClientActions(tokens, once)),
  branding: { companyName: 'Generic Bank Console', withMadeWithLove: false },
  // A bar back to the Console's own pages, and a trail link on a run's record.
  assets: { scripts: ['/console-bar.js'] },
});

const app = Fastify({ logger: true });
app.get('/healthz', async () => ({ ok: true, service: 'console' }));
// Before AdminJS's routes, so its dashboard is never the page a person lands on.
landOnDashboard(app);
app.get('/console-bar.js', async (_req, reply) =>
  reply.type('application/javascript').send(ADMIN_BAR_JS),
);

await AdminJSFastify.buildAuthenticatedRouter(
  admin,
  {
    cookieName: 'gb_console',
    cookiePassword: cfg.CONSOLE_COOKIE_SECRET,
    authenticate: async (email: string, password: string) => {
      const user = await client.consoleUser.findUnique({ where: { email } });
      if (!user || !(await argon2.verify(user.passwordHash, password))) return null;
      return { email: user.email, role: user.role };
    },
  },
  app,
  { secret: cfg.CONSOLE_SESSION_SECRET, saveUninitialized: false },
);

// The Console's own pages, behind the same sign-in as AdminJS.
const whoIs = (req: FastifyRequest): Viewer | null => {
  const s = (req as unknown as { session?: { get(k: string): Partial<Viewer> | undefined } })
    .session;
  const u = s?.get('adminUser');
  return u?.email && u.role ? { email: u.email, role: u.role } : null;
};
runPages(app, {
  sql: control,
  store: fileStore(cfg.EVIDENCE_DIR),
  whoIs,
});
// A resumed run goes back to the Runner through the workflow queue, as a new workflow: one per
// escalation, so a resume is enqueued at most once.
const workflows = await DBOSClient.create({
  systemDatabaseUrl: cfg.CONTROL_DATABASE_URL,
  systemDatabaseSchemaName: 'dbos',
});
inboxPages(app, {
  sql: control,
  answerKey: cfg.ANSWER_SEAL_KEY,
  whoIs,
  restart: async (runId, taskId) =>
    void (await workflows.enqueue(
      { workflowName: WORKFLOW.name, queueName: WORKFLOW.queue, workflowID: `${runId}.${taskId}` },
      runId,
    )),
});
recommendationPages(app, { sql: control, whoIs });
if (cfg.HAZARDS_FORCEABLE === 'true') {
  showLabInNav();
  labPages(app, {
    sql: control,
    whoIs,
    start: throughTheApi({ sql: control, tokens, apiUrl: cfg.API_URL }),
    ...(cfg.HAZARD_HMAC_KEY ? { hazardKey: cfg.HAZARD_HMAC_KEY } : {}),
  });
}
freezePages(app, { sql: control, whoIs });
dashboardPages(app, {
  sql: control,
  whoIs,
  apiPort: cfg.API_PORT,
  inboxPort: cfg.BANK_INBOX_PORT,
});

await app.listen({ host: '0.0.0.0', port: cfg.CONSOLE_PORT });
