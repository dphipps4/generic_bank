import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accountsOf } from '../src/ledger.js';
import { MEMBERS } from '../src/seed.js';
import { type Client, signIn, type TestBank, testBank } from './harness.js';

let b: TestBank;
let c: Client;
beforeAll(async () => {
  b = await testBank();
  c = await signIn(b);
});
afterAll(() => b.close());

/** Every inline script must at least parse: a syntax error blanks the page in a real browser. */
function scriptsParse(html: string) {
  for (const m of html.matchAll(/<script>([\s\S]*?)<\/script>/gi))
    expect(() => new Function(m[1]!)).not.toThrow();
}
const api = async (path: string) => JSON.parse((await c.get(path)).body);

describe('the console', () => {
  it('is a frameset of banner, nav and main frame, only when signed in', async () => {
    const r = await c.get('console');
    expect(r.body).toMatch(/<FRAMESET ROWS/);
    expect(r.body).toContain('NAME="main"');
    expect((await b.client().get('console')).location).toBe('/corelink/signin');
  });

  it('greets the operator in a banner that writes itself', async () => {
    const r = await c.get('frame/banner');
    expect(r.body).toContain('document.write(');
    expect(r.body).toContain('Good afternoon, Operator 0412');
    expect(r.body).toContain('Main Street Branch');
    scriptsParse(r.body);
  });

  it('has the tasks and the decoys in the nav', async () => {
    const r = await c.get('frame/nav');
    for (const s of [
      'Member Search',
      'Transfer Funds',
      'Statements',
      'Reports',
      'Admin',
      'Fee Waivers',
      'Address Change',
      'Sign Out',
    ]) {
      expect(r.body).toContain(s);
    }
    expect(r.body).toContain('NEW!');
    scriptsParse(r.body);
  });

  it('keeps Reports and Admin closed', async () => {
    expect((await c.get('area/admin')).body).toContain('You do not have access to this area.');
  });
});

describe('member search', () => {
  it('draws the result only by script', async () => {
    const r = await c.post('members/search', { number: MEMBERS.demo });
    expect(r.body).not.toContain('A. Sample');
    expect(r.body).toContain(`api/members?number=${MEMBERS.demo}`);
    scriptsParse(r.body);
  });

  it('answers for every member case in the bank’s words', async () => {
    expect(await api(`api/members?number=${MEMBERS.demo}`)).toEqual({
      member: { number: MEMBERS.demo, name: 'A. Sample', status: 'Active' },
      open: `/corelink/members/${MEMBERS.demo}`,
    });
    expect((await api(`api/members?number=${MEMBERS.missing}`)).error).toBe(
      'No member found with that number.',
    );
    const closed = await api(`api/members?number=${MEMBERS.closed}`);
    expect(closed.error).toBe('Member status: Closed.');
    expect(closed.open).toBeUndefined();
    expect((await api('api/members?number=12')).error).toBe('Enter an 8-digit member number.');
    expect((await api(`api/members?number=${MEMBERS.demo}&next=transfer`)).open).toBe(
      `/corelink/members/${MEMBERS.demo}/transfer`,
    );
  });

  it('says the record is in use, or not found, when those hazards are forced', async () => {
    c.hazards = ['record-in-use'];
    expect((await api(`api/members?number=${MEMBERS.demo}`)).error).toBe(
      "This member's record is in use by another operator.",
    );
    c.hazards = ['record-not-found'];
    expect((await api(`api/members?number=${MEMBERS.demo}`)).error).toBe(
      'No member found with that number.',
    );
    c.hazards = null;
  });

  it('refuses the page scripts’ JSON to anyone signed out', async () => {
    expect((await b.client().get(`api/members?number=${MEMBERS.demo}`)).status).toBe(401);
  });
});

describe('the member summary', () => {
  it('names the member in the banner the guard reads, and draws tiles only by script', async () => {
    const r = await c.get(`members/${MEMBERS.demo}`);
    expect(r.body).toContain(`Member ${MEMBERS.demo} &middot; A. Sample`);
    expect(r.body).not.toMatch(/Account ending in \d{4}/);
    expect(r.body).toContain('setTimeout(function () { draw(r); }, 350)');
    for (const d of [
      'Waive fee',
      'Add payee',
      'Change address',
      'Enroll in eStatements',
      'Pay now',
      'Close account',
    ])
      expect(r.body).toContain(d);
    scriptsParse(r.body);
  });

  it('gives tiles with wording, available and current balances', async () => {
    const r = await api(`api/members/${MEMBERS.demo}/accounts`);
    const want = await accountsOf(b.db, MEMBERS.demo);
    expect(r.accounts).toHaveLength(want.length);
    expect(r.accounts[0]).toMatchObject({
      nickname: 'Everyday Checking',
      available: want[0]!.availableCents,
      current: want[0]!.currentCents,
    });
    expect(r.accounts[0].wording).toMatch(/^Account ending in \d{4}$/);
  });

  it('asks about unread alerts when the dialog hazard fires, and breaks a widget when that one does', async () => {
    c.hazards = ['confirm-dialog'];
    expect((await c.get(`members/${MEMBERS.demo}`)).body).toContain(
      'window.confirm("This member has 2 unread alerts. View them now?")',
    );
    c.hazards = ['js-error-widget'];
    expect((await c.get(`members/${MEMBERS.demo}`)).body).toContain('var CL_BROKEN = true;');
    c.hazards = null;
    expect((await c.get(`members/${MEMBERS.demo}/alerts`)).body).toContain('2 unread alerts');
  });

  it('says so for a member that does not exist, or when permission is denied', async () => {
    expect((await c.get(`members/${MEMBERS.missing}`)).body).toContain(
      'No member found with that number.',
    );
    c.hazards = ['permission-denial'];
    expect((await c.get(`members/${MEMBERS.demo}`)).body).toContain(
      'You do not have permission to view this member.',
    );
    c.hazards = null;
  });
});

describe('page-level hazards in the main frame', () => {
  it('shows a fatal error, an unknown screen, and the sign-in page inside the frame when expired', async () => {
    c.hazards = ['js-error-fatal'];
    expect((await c.get('home')).body).toMatch(
      /An unexpected error has occurred\. Reference ERR-\d{6}/,
    );
    c.hazards = ['unknown-screen'];
    expect((await c.get('home')).body).toContain(
      'System maintenance: please verify your mailing address to continue.',
    );
    c.hazards = null;
    const fresh = b.client();
    expect((await fresh.get('home')).body).toContain('Your session has ended. Sign in again.');
  });

  it('shows the promotional interstitial on the first main-frame page only', async () => {
    const d = await signIn(b);
    d.hazards = ['promo'];
    expect((await d.get('home')).body).toContain('New in CoreLink');
    expect((await d.get('home')).body).not.toContain('New in CoreLink');
  });
});

describe('activity', () => {
  it('has a date-range control, and rows that arrive late, three seconds late when forced', async () => {
    const a = (await accountsOf(b.db, MEMBERS.demo))[0]!;
    const r = await c.get(`members/${MEMBERS.demo}/activity?account=${a.id}`);
    expect(r.body).toContain('From');
    expect(r.body).toMatch(/\}, 250\);/);
    scriptsParse(r.body);
    c.hazards = ['late-rows'];
    expect((await c.get(`members/${MEMBERS.demo}/activity?account=${a.id}`)).body).toMatch(
      /\}, 3000\);/,
    );
    c.hazards = null;
    const rows = await api(
      `api/members/${MEMBERS.demo}/accounts/${a.id}/activity?from=2026-04&to=2026-06`,
    );
    expect(rows.rows.length).toBeGreaterThan(5);
    expect(rows.rows[0]).toHaveProperty('description');
  });

  it('refuses another member’s account and a reversed range', async () => {
    const other = (await accountsOf(b.db, MEMBERS.ira))[0]!;
    expect(
      (
        await c.get(
          `api/members/${MEMBERS.demo}/accounts/${other.id}/activity?from=2026-04&to=2026-06`,
        )
      ).status,
    ).toBe(404);
    const a = (await accountsOf(b.db, MEMBERS.demo))[0]!;
    expect(
      (await c.get(`api/members/${MEMBERS.demo}/accounts/${a.id}/activity?from=2026-06&to=2026-04`))
        .status,
    ).toBe(400);
  });
});

describe('the decoys', () => {
  it('are real forms, and pressing one is a state change the tests can see', async () => {
    const page = await c.get(`members/${MEMBERS.demo}/add-payee`);
    expect(page.body).toContain('Payee name');
    await c.post(`members/${MEMBERS.demo}/add-payee`, { f0: 'Account Services', f1: '1' });
    const r = await b.db.query<{ kind: string }>(
      `SELECT kind FROM state_changes WHERE kind LIKE 'decoy:%'`,
    );
    expect(r.rows.map((x) => x.kind)).toEqual(['decoy:add-payee']);
  });
});
