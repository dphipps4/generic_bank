import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { esc } from '../../apps/console/src/pages/layout.js';
import { labPages } from '../../apps/console/src/pages/lab.js';
import {
  describeExpected,
  HAZARDS,
  type HazardName,
  OUTCOMES,
} from '../../packages/contracts/src/index.js';
import { hazardHeader } from '../../packages/runs/src/index.js';
import { controlDb } from '../../packages/oauth/test/control.js';
import { HAZARD_NAMES, hazards } from '../../apps/bank/src/hazards.js';
import { MEMBERS } from '../../apps/bank/src/seed.js';
import { CASES, RUN } from './support.js';

// The hazard lab and the outcome table read one list (plan, §A.3, §B.4): every hazard the bank
// knows, the healthy member they are forced on, the member's own cases, and the one result each
// gives. The bank shares no code with us, so its names and its seed are checked against the list.

let db: Awaited<ReturnType<typeof controlDb>>;
const lab = Fastify();
beforeAll(async () => {
  db = await controlDb();
  labPages(lab, {
    sql: db,
    whoIs: () => ({ email: 'ada@generic-bank.local', role: 'admin' }),
    start: async () => ({ ok: false, detail: 'not in this test' }),
  });
  await lab.ready();
});
afterAll(async () => {
  await lab.close();
  await db.close();
});

const o = OUTCOMES['check-balance'];

describe('one list of hazards and results', () => {
  it('names every hazard the bank knows, once, with one result each', () => {
    expect([...HAZARDS].sort()).toEqual([...HAZARD_NAMES].sort());
    expect(o.hazards.map((c) => c.hazard).sort()).toEqual([...HAZARDS].sort());
  });

  it('uses the bank’s own seeded members', () => {
    const ids = o.members.map((m) => m.memberId);
    expect(ids).toEqual([MEMBERS.demo, MEMBERS.missing, MEMBERS.closed, MEMBERS.demo]);
  });

  it('is the list the outcome suite runs its three rows from, one of each kind', () => {
    expect(CASES).toBe(o);
    expect(o.members).toContain(RUN.business);
    expect(o.hazards).toEqual(expect.arrayContaining([RUN.recoverable, RUN.hard]));
    expect([RUN.business, RUN.recoverable, RUN.hard].map((c) => c.expected.status)).toEqual([
      'business_outcome',
      'succeeded',
      'failed',
    ]);
  });

  it('is the list the hazard lab shows, each result beside its hazard', async () => {
    const html = (await lab.inject({ url: '/lab' })).body;
    for (const c of o.hazards) {
      const row = new RegExp(`<tr data-hazard="${c.hazard}">.*?</tr>`).exec(html)?.[0] ?? '';
      expect(row, c.hazard).toContain(esc(c.does));
      expect(row, c.hazard).toContain(`class="pill ${c.expected.status}"`);
      if (c.expected.code) expect(row, c.hazard).toContain(`<code>${c.expected.code}</code>`);
      else expect(row, c.hazard).not.toMatch(/pill[^<]*<\/span> <code>/);
    }
    expect(html.match(/<tr data-hazard=/g)).toHaveLength(o.hazards.length);
    for (const m of o.members) expect(html).toContain(esc(m.name));
    expect(describeExpected(o.members[1]!.expected)).toBe('business_outcome: no_such_member');
  });
});

describe('the Runner’s header is the one the bank obeys', () => {
  const KEY = 'h'.repeat(32);
  const bank = hazards({ profile: 'none', seed: 1, forceable: true, hmacKey: KEY, log: () => {} });

  it('forces exactly the named hazards', () => {
    const names: HazardName[] = ['unknown-screen', 'late-rows'];
    const h = bank.forRequest(hazardHeader(names, KEY)['x-hazards'], '/');
    if (h === 'bad-signature') throw new Error('the bank refused the header');
    expect(h.forced).toBe(true);
    for (const n of HAZARDS) expect(h.on(n), n).toBe(names.includes(n));
  });

  it('is refused when signed with another key', () => {
    expect(bank.forRequest(hazardHeader(['promo'], 'x'.repeat(32))['x-hazards'], '/')).toBe(
      'bad-signature',
    );
  });
});
