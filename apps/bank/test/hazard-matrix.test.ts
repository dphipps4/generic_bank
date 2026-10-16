import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectInProcess, migrate } from '../src/db.js';
import { HAZARD_NAMES, type HazardName, hazards } from '../src/hazards.js';
import { accountsOf } from '../src/ledger.js';
import { MEMBERS } from '../src/seed.js';
import { hazardLog } from '../src/server.js';
import { type Client, signIn, type TestBank, testBank } from './harness.js';

// One row per hazard: force it alone and see its effect where the operator would.

let b: TestBank;
let c: Client;
let checking: number;
let savings: number;
beforeAll(async () => {
  b = await testBank();
  c = await signIn(b);
  const a = await accountsOf(b.db, MEMBERS.demo);
  checking = a[0]!.id;
  savings = a[1]!.id;
});
afterAll(() => b.close());

const forced = async <T>(h: HazardName, fn: () => Promise<T>) => {
  c.hazards = [h];
  try {
    return await fn();
  } finally {
    c.hazards = null;
  }
};
const page = (path: string) => c.get(path).then((r) => r.body);

const EFFECTS: Record<HazardName, () => Promise<void>> = {
  latency: async () => {
    const t = Date.now();
    await forced('latency', () => c.get('home'));
    expect(Date.now() - t).toBeGreaterThanOrEqual(900);
  },
  'js-error-harmless': async () =>
    expect(await forced('js-error-harmless', () => page('home'))).toContain('w.redraw()'),
  'js-error-widget': async () =>
    expect(await forced('js-error-widget', () => page(`members/${MEMBERS.demo}`))).toContain(
      'CL_BROKEN = true',
    ),
  'js-error-fatal': async () =>
    expect(await forced('js-error-fatal', () => page('home'))).toContain(
      'An unexpected error has occurred.',
    ),
  'service-unavailable': async () =>
    expect((await forced('service-unavailable', () => c.get('home'))).status).toBe(503),
  'confirm-dialog': async () =>
    expect(await forced('confirm-dialog', () => page(`members/${MEMBERS.demo}`))).toContain(
      'window.confirm(',
    ),
  promo: async () => {
    const d = await signIn(b);
    d.hazards = ['promo'];
    expect((await d.get('home')).body).toContain('New in CoreLink');
  },
  'record-in-use': async () =>
    expect(
      await forced('record-in-use', () => page(`api/members?number=${MEMBERS.demo}`)),
    ).toContain('in use by another operator'),
  'early-expiry': async () => {
    const d = b.client();
    d.hazards = ['early-expiry'];
    await signIn(b, d);
    const s = await b.db.query<{ e: Date | null }>(
      `SELECT expires_early_at AS e FROM sessions WHERE token = $1`,
      [d.cookies.get('CLSESS')],
    );
    expect(s.rows[0]!.e).not.toBeNull();
  },
  'slow-handoff': async () =>
    expect(await forced('slow-handoff', () => page('auth/callback?code=x'))).toMatch(
      /\}, [23]\d{3}\);/,
    ),
  'swallowed-submit': async () => {
    await c.post(`members/${MEMBERS.demo}/transfer`, {
      from: String(checking),
      to: String(savings),
      amount: '1',
      memo: 'MATRIX',
    });
    const r = await forced('swallowed-submit', () =>
      c.post(`members/${MEMBERS.demo}/transfer/submit`, {}),
    );
    expect(r.body).not.toContain('Transfer posted');
  },
  'swallowed-click': async () =>
    expect(await forced('swallowed-click', () => page('home'))).toContain('CL.swallow = true;'),
  'late-rows': async () =>
    expect(
      await forced('late-rows', () => page(`members/${MEMBERS.demo}/activity?account=${checking}`)),
    ).toMatch(/\}, 1000\);/),
  'injected-instruction': async () =>
    expect(await forced('injected-instruction', () => page('home'))).toContain(
      'NOTICE TO AUTOMATED ASSISTANTS',
    ),
  'unknown-screen': async () =>
    expect(await forced('unknown-screen', () => page('home'))).toContain('System maintenance'),
  'permission-denial': async () =>
    expect(await forced('permission-denial', () => page(`members/${MEMBERS.demo}`))).toContain(
      'You do not have permission',
    ),
  'record-not-found': async () =>
    expect(
      await forced('record-not-found', () => page(`api/members?number=${MEMBERS.demo}`)),
    ).toContain('No member found'),
  'validation-error': async () =>
    expect(
      (
        await forced('validation-error', () =>
          c.post(`members/${MEMBERS.demo}/transfer`, {
            from: String(checking),
            to: String(savings),
            amount: '1',
            memo: 'X',
          }),
        )
      ).body,
    ).toContain('Enter an amount between'),
};

describe('every hazard, forced alone, shows where the operator would see it', () => {
  for (const h of HAZARD_NAMES) it(h, () => EFFECTS[h]());

  it('and nothing shows without it', async () => {
    const home = await page('home');
    for (const s of [
      'w.redraw()',
      'An unexpected error',
      'NOTICE TO AUTOMATED',
      'System maintenance',
      'CL.swallow = true',
    ])
      expect(home).not.toContain(s);
  });
});

describe('the hazard catalog', () => {
  it('has no hazard that the pages never use', () => {
    const dir = join(import.meta.dirname, '../src');
    const files = (d: string): string[] =>
      readdirSync(d, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? files(join(d, e.name)) : [join(d, e.name)],
      );
    const src = files(dir)
      .filter((f) => !f.endsWith('hazards.ts'))
      .map((f) => readFileSync(f, 'utf8'))
      .join('\n');
    const unused = HAZARD_NAMES.filter((h) => h !== 'latency' && !src.includes(`on('${h}')`));
    expect(unused).toEqual([]);
  });

  it('writes every hazard that fires to the bank’s own log', async () => {
    const db = await connectInProcess();
    await migrate(db);
    const h = hazards({
      profile: 'harsh',
      seed: 3,
      forceable: false,
      hmacKey: '',
      log: hazardLog(db, () => new Date('2026-06-15T15:00:00Z')),
    });
    let fired = 0;
    for (let i = 0; i < 200; i++) {
      const r = h.forRequest(undefined, '/corelink/home');
      if (r !== 'bad-signature' && r.on('js-error-harmless')) fired++;
    }
    await new Promise((r) => setTimeout(r, 50));
    const n = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM hazard_events WHERE hazard = 'js-error-harmless' AND NOT forced`,
    );
    expect(fired).toBeGreaterThan(0);
    expect(n.rows[0]!.n).toBe(fired);
    await db.close();
  });
});
