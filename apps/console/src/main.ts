// The Console: AdminJS over the control database, behind a local sign-in.
import AdminJSFastify from '@adminjs/fastify';
import { Database, Resource } from '@adminjs/prisma';
import AdminJS from 'adminjs';
import argon2 from 'argon2';
import Fastify from 'fastify';
import { z } from 'zod';
import { loadConfig, port, secret } from '@gb/config';
import { db } from '@gb/db';
import { resources } from './resources.js';

const cfg = loadConfig(
  {
    CONSOLE_PORT: port(8080),
    CONSOLE_SESSION_SECRET: secret(),
    CONSOLE_COOKIE_SECRET: secret(),
    CONSOLE_ADMIN_EMAIL: z.email(),
    CONSOLE_ADMIN_PASSWORD: z.string().min(12),
  },
  process.env,
  ['CONSOLE_SESSION_SECRET', 'CONSOLE_COOKIE_SECRET'],
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
// Mounted at /admin: at the root, AdminJS builds API paths that begin with '//', which a browser
// reads as another host. The root redirects here.
const admin = new AdminJS({
  rootPath: '/admin',
  loginPath: '/admin/login',
  logoutPath: '/admin/logout',
  resources: resources(client),
  branding: { companyName: 'Generic Bank Console', withMadeWithLove: false },
});

const app = Fastify({ logger: true });
app.get('/healthz', async () => ({ ok: true, service: 'console' }));
app.get('/', async (_req, reply) => reply.redirect('/admin'));

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

await app.listen({ host: '0.0.0.0', port: cfg.CONSOLE_PORT });
