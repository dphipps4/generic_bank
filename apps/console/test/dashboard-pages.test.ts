import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tripGuard } from '@gb/guardrails';
import { createRun, openHumanTask } from '@gb/runs';
import { controlDb } from '../../../packages/oauth/test/control.js';
import { dashboardPages, landOnDashboard } from '../src/pages/dashboard.js';
import type { Viewer } from '../src/pages/layout.js';

// The Dashboard: where signing in lands, with what waits for a person, frozen banks, what each bank
// serves, the latest runs, and links onward.

let db: Awaited<ReturnType<typeof controlDb>>;
let app: ReturnType<typeof Fastify>;
let who: Viewer | null = { email: 'ada@generic-bank.local', role: 'admin' };

beforeAll(async () => {
  db = await controlDb();
  app = Fastify();
  landOnDashboard(app);
  app.get('/admin/resources/TaskRun', async () => 'AdminJS');
  dashboardPages(app, { sql: db, whoIs: () => who, apiPort: 18000, inboxPort: 18089 });
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await db.close();
});

describe('the Dashboard', () => {
  it('shows what waits for a person, a frozen bank, what each bank serves, and the latest run', async () => {
    const { runId } = await createRun(
      db,
      {
        task: 'check-balance',
        bank: 'generic',
        clientId: 'gbc_agent',
        inputs: { bank: 'generic', memberId: '40017732', account: '7890' },
      },
      'k'.repeat(40),
    );
    await openHumanTask(
      db,
      runId,
      'staff_code',
      { bank: 'generic', prompt: 'The bank sent a code.' },
      new Date(Date.now() + 5 * 60_000),
    );
    await tripGuard(db, { runId, bank: 'example', layer: 'element', rule: 'pressed Pay now' });

    const page = (await app.inject({ url: '/dashboard', headers: { host: 'localhost:18080' } }))
      .body;
    expect(page).toContain('1 staff codes');
    expect(page).toContain('<span class="pill escalated">frozen</span>');
    expect(page).toContain('pressed Pay now');
    expect(page).toMatch(/Generic Bank.*check-balance, transfer/s);
    expect(page).toContain(`href="/runs/${runId}"`);
    expect(page).toContain('href="http://localhost:18000/docs"');
    expect(page).toContain('href="http://localhost:18089"');
    expect(page).toContain('<a href="/dashboard" class="on">Dashboard</a>');
  });

  it('is where the root and signing in land, and asks a stranger to sign in', async () => {
    for (const url of ['/', '/admin', '/admin/']) {
      const r = await app.inject({ url });
      expect([r.statusCode, r.headers.location]).toEqual([302, '/dashboard']);
    }
    expect((await app.inject({ url: '/admin/resources/TaskRun' })).body).toBe('AdminJS');
    who = null;
    expect((await app.inject({ url: '/dashboard' })).headers.location).toBe('/admin/login');
  });
});
