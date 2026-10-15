// The Console: AdminJS over the control database, behind a local sign-in.
import AdminJSFastify from '@adminjs/fastify';
import { Database, Resource } from '@adminjs/prisma';
import AdminJS from 'adminjs';
import argon2 from 'argon2';
import Fastify from 'fastify';
import { z } from 'zod';
import { loadConfig, port, secret } from '@gb/config';
import { db, sql } from '@gb/db';
import { oauth } from '@gb/oauth';
import { apiClientActions, onceStore } from './api-clients.js';
import { ADMIN_BAR_JS } from './pages/layout.js';
import { runPages } from './pages/runs.js';
import { s3Store } from '@gb/evidence';
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
    MINIO_ENDPOINT: z.string().url().default('http://minio:9000'),
    MINIO_ROOT_USER: z.string().min(3),
    MINIO_ROOT_PASSWORD: secret(),
  },
  process.env,
  ['CONSOLE_SESSION_SECRET', 'CONSOLE_COOKIE_SECRET', 'API_TOKEN_HASH_KEY', 'MINIO_ROOT_PASSWORD'],
);

const client = db();

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
  resources: resources(
    client,
    apiClientActions(oauth(sql(cfg.CONTROL_DATABASE_URL), cfg.API_TOKEN_HASH_KEY), once),
  ),
  branding: { companyName: 'Generic Bank Console', withMadeWithLove: false },
  // A bar back to the Console's own pages, and a trail link on a run's record.
  assets: { scripts: ['/console-bar.js'] },
});

const app = Fastify({ logger: true });
app.get('/healthz', async () => ({ ok: true, service: 'console' }));
app.get('/', async (_req, reply) => reply.redirect('/runs'));
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
runPages(app, {
  sql: sql(cfg.CONTROL_DATABASE_URL),
  store: s3Store({
    endpoint: cfg.MINIO_ENDPOINT,
    bucket: 'evidence',
    accessKey: cfg.MINIO_ROOT_USER,
    secretKey: cfg.MINIO_ROOT_PASSWORD,
  }),
  whoIs: (req) => {
    const s = (req as unknown as { session?: { get(k: string): { email?: string } | undefined } })
      .session;
    return s?.get('adminUser')?.email ?? null;
  },
});

await app.listen({ host: '0.0.0.0', port: cfg.CONSOLE_PORT });
