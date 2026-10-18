import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tripGuard } from '@gb/guardrails';
import { controlDb } from '../../../packages/oauth/test/control.js';
import { freezePages } from '../src/pages/freezes.js';
import type { Viewer } from '../src/pages/layout.js';

// The Freezes page: every freeze newest first, and an admin clears one with a reason that goes to
// the audit. Nobody else can.

let db: Awaited<ReturnType<typeof controlDb>>;
let app: ReturnType<typeof Fastify>;
let who: Viewer | null = { email: 'ada@generic-bank.local', role: 'admin' };

beforeAll(async () => {
  db = await controlDb();
  app = Fastify();
  freezePages(app, { sql: db, whoIs: () => who });
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await db.close();
});

const trip = (runId: string, rule: string, at?: Date) =>
  tripGuard(db, { runId, bank: 'generic', layer: 'element', rule }, at);
const clear = (id: string, body: unknown) =>
  app.inject({ method: 'POST', url: `/freezes/${id}/clear`, payload: body as object });

describe('the Freezes page', () => {
  it('lists every freeze, newest first, with its layer, run and reason', async () => {
    await trip('r_older', 'pressed Pay now', new Date(Date.now() - 60_000));
    await trip('r_newer', 'a money control on a read-only job');
    const page = (await app.inject({ url: '/freezes' })).body;
    expect(page.indexOf('r_newer')).toBeLessThan(page.indexOf('r_older'));
    expect(page).toContain('a money control on a read-only job');
    expect(page).toContain('href="/runs/r_newer"');
    expect(page).toMatch(/action="\/freezes\/f_[0-9a-f]+\/clear"/);
  });

  it('clears a freeze only with a reason, once, and audits it', async () => {
    const { freezeId } = await trip('r_clear', 'pressed Pay now');
    expect((await clear(freezeId, { reason: 'short' })).statusCode).toBe(400);
    expect((await clear(freezeId, { reason: 'checked the run; the bank is safe' })).json()).toEqual(
      { ok: true },
    );
    expect(
      (await clear(freezeId, { reason: 'checked the run; the bank is safe' })).statusCode,
    ).toBe(409);
    const f = await db.query('SELECT "clearedBy" FROM "Freeze" WHERE id = $1', [freezeId]);
    expect(f.rows).toEqual([{ clearedBy: 'ada@generic-bank.local' }]);
    const audit = await db.query(
      'SELECT actor, action, reason FROM "AuditEntry" WHERE target = $1',
      [freezeId],
    );
    expect(audit.rows).toEqual([
      {
        actor: 'ada@generic-bank.local',
        action: 'freeze.clear',
        reason: 'checked the run; the bank is safe',
      },
    ]);
  });

  it('clears from the form, and says so', async () => {
    const { freezeId } = await trip('r_form', 'pressed Pay now');
    const r = await app.inject({
      method: 'POST',
      url: `/freezes/${freezeId}/clear`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'reason=checked+the+run+in+the+trail',
    });
    expect(r.headers.location).toBe('/freezes?done=clear');
    expect((await app.inject({ url: r.headers.location })).body).toContain('Cleared');
  });

  it('lets no one but an admin clear a freeze', async () => {
    const { freezeId } = await trip('r_role', 'pressed Pay now');
    try {
      who = { email: 'ann@generic-bank.local', role: 'viewer' };
      expect((await app.inject({ url: '/freezes' })).body).not.toContain(
        `/freezes/${freezeId}/clear`,
      );
      expect((await clear(freezeId, { reason: 'it looked fine to me' })).statusCode).toBe(403);
      who = null;
      expect((await clear(freezeId, { reason: 'it looked fine to me' })).statusCode).toBe(401);
      expect((await app.inject({ url: '/freezes' })).headers.location).toBe('/admin/login');
    } finally {
      who = { email: 'ada@generic-bank.local', role: 'admin' };
    }
    const f = await db.query('SELECT "clearedAt" FROM "Freeze" WHERE id = $1', [freezeId]);
    expect(f.rows).toEqual([{ clearedAt: null }]);
  });
});
