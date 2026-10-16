import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { recommendationPages } from '../../apps/console/src/pages/recommendations.js';
import { runPages } from '../../apps/console/src/pages/runs.js';
import type { Agent, Conversation } from '../../apps/factory/src/agent.js';
import { gateway } from '../../apps/factory/src/gateway.js';
import { sqlLedger } from '../../apps/factory/src/ledger.js';
import { DEFAULT_ROLES, PRICES, type Provider, type Role } from '../../apps/factory/src/models.js';
import { personCode } from '../../apps/factory/src/person.js';
import { type Claim, recommend } from '../../apps/factory/src/recommend.js';
import { scout } from '../../apps/factory/src/scout.js';
import { buildServer } from '../../apps/factory/src/server.js';
import { type Goal, GOALS, runGoal } from '../../apps/factory/src/supervisor.js';
import { openTrail } from '../../apps/factory/src/trail.js';
import { live, upstreamFor, type Upstream } from '../../apps/factory/src/upstream.js';
import { fakeModels, OPENAI_TEST_MODEL, TEST_PRICE } from '../../apps/factory/test/fakes.js';
import { MEMBERS, OPERATORS } from '../../apps/bank/src/seed.js';
import { GENERIC_BANK } from '../../packages/drivers/src/corelink/profiles.js';
import { memoryStore } from '../../packages/evidence/src/index.js';
import { controlDb } from '../../packages/oauth/test/control.js';
import { answerHumanTask } from '../../packages/runs/src/index.js';
import { Browser, click, encodePng, waitFullyRendered } from '../../packages/screen/src/index.js';
import { type LiveBank, liveBank, PASSWORDS } from '../support/banks.js';

// The Scout against the real Generic Bank in Chrome: its tools, what they refuse, and a run guided
// by the Supervisor to the three goals' pages, through the model gateway, recorded and then
// replayed in mock mode, on the Anthropic defaults and with OpenAI configured. No request reaches
// a model and no key is used: both roles' models are a scripted fake fetch behind the gateway.

const TOKEN = 'gateway-token-for-tests-0123456789abcdef';

/** Whether a text holds a secret as itself: the operator's four digits are also inside many a port
 *  number or duration, which reveal nothing. */
const holds = (text: string, secret: string) =>
  new RegExp(
    `(?<![0-9A-Za-z])${secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![0-9A-Za-z])`,
  ).test(text);
const CREDS = { operatorId: OPERATORS.service.id, password: PASSWORDS.service };

let db: Awaited<ReturnType<typeof controlDb>>;
let bank: LiveBank;
let browser: Browser;
let store: ReturnType<typeof memoryStore>;
// A page that links off the allowlist, and the host it links to, which counts every request.
let near: Server;
let far: Server;
let farHits = 0;
let posts = 0;
// A picture of text: a dark bar, as a button drawn as an image.
const CONFIRM = encodePng({ width: 80, height: 24, data: new Uint8Array(80 * 24 * 4).fill(64) });
let nearUrl: string;
let farHost: string;
// The Console's run and recommendation pages, for a person signed in as an approver.
let consoleApp: ReturnType<typeof Fastify>;
let consoleUrl: string;

const listen = async (s: Server) => {
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return (s.address() as AddressInfo).port;
};

beforeAll(async () => {
  [db, bank] = await Promise.all([controlDb(), liveBank('generic')]);
  far = createServer((_q, s) => {
    farHits++;
    s.end('far away');
  });
  farHost = `127.0.0.1:${await listen(far)}`;
  near = createServer((q, s) => {
    if (q.url === '/confirm.png') {
      s.setHeader('content-type', 'image/png');
      return s.end(CONFIRM);
    }
    s.setHeader('content-type', 'text/html');
    if (q.method === 'POST') {
      posts++;
      return s.end('<title>Near</title><p>Posted.</p>');
    }
    // A review page whose submit is a picture of text with no name, as bank 2's is, and a named
    // picture button beside it.
    // A bank with no profile: its submit is a text button named Confirm.
    if (q.url === '/confirm')
      return s.end(
        `<title>Near</title><p>Review transfer</p><form method="post" action="/submit"><input type="submit" value="Confirm"></form><form method="post" action="/continue"><input type="submit" value="Continue"></form>`,
      );
    // Send code asks the bank for a sign-in code; Send money moves money.
    if (q.url === '/send')
      return s.end(
        `<title>Near</title><p>Where should we send your code?</p><form method="post" action="/money"><input type="submit" value="Send money"></form><form method="post" action="/code"><input type="submit" value="Send code"></form>`,
      );
    if (q.url === '/review')
      return s.end(
        `<title>Near</title><p>Review transfer</p><form method="post" action="/submit"><input type="image" src="/confirm.png"></form><form method="post" action="/preview"><input type="image" src="/confirm.png" alt="Preview"></form>`,
      );
    s.end(
      `<title>Near</title><p>A page with a way out.</p><img src="http://${farHost}/pixel.png" width="1" height="1"><a href="http://${farHost}/away">Elsewhere</a>`,
    );
  });
  nearUrl = `http://localhost:${await listen(near)}/`;
  store = memoryStore();
  consoleApp = Fastify();
  const whoIs = () => ({ email: 'staff@test', role: 'approver' }) as const;
  runPages(consoleApp, { sql: db, store, whoIs });
  recommendationPages(consoleApp, { sql: db, whoIs });
  await consoleApp.listen({ host: '127.0.0.1', port: 0 });
  consoleUrl = `http://127.0.0.1:${(consoleApp.server.address() as AddressInfo).port}`;
  browser = await Browser.launch({
    hosts: [new URL(bank.url).host, new URL(nearUrl).host, new URL(consoleUrl).host],
  });
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await consoleApp?.close();
  await bank?.close();
  await db?.close();
  near?.close();
  far?.close();
});

const lastCode = async () => {
  const r = await bank.db.query<{ body: string }>(
    'SELECT body FROM messages ORDER BY id DESC LIMIT 1',
  );
  return /(\d{6})/.exec(r.rows[0]!.body)![1]!;
};

async function newScout(
  runId: string,
  start = bank.url,
  code = lastCode,
  never: string[] = GENERIC_BANK.words.submitTransfer,
) {
  const page = await browser.newPage();
  const trail = await openTrail({
    sql: db,
    store,
    runId,
    task: 'check-balance',
    bank: 'generic',
    known: [],
  });
  const s = scout({
    page,
    start,
    hosts: [new URL(start).host],
    trail,
    credentials: CREDS,
    code,
    never,
  });
  return { page, trail, s };
}

/** What a tool's result says, and the page it shows, as the model reads them. */
const read = (r: { text: string } | string) => {
  const text = typeof r === 'string' ? r : r.text;
  const page = JSON.parse(text.slice(text.lastIndexOf('\n') + 1)) as {
    page: string;
    controls: { ref: string; role: string; name: string; options?: string[] }[];
    texts: string[];
  };
  return { text, page };
};
/** A control on the page by its role, and its name when given; a name alone matches any role. */
function refOf(p: ReturnType<typeof read>['page'], role: string | null, name?: string) {
  const c = p.controls.find(
    (x) => (role === null || x.role === role) && (name === undefined || x.name === name),
  );
  if (!c) throw new Error(`no ${role ?? 'control'} ${name ?? ''} on ${JSON.stringify(p)}`);
  return c.ref;
}

const rows = async <T>(q: string, runId: string) => (await db.query<T>(q, [runId])).rows;
const stored = async (runId: string) =>
  (
    await Promise.all(
      store
        .keys()
        .filter((k) => k.startsWith(`runs/${runId}/`) && k.endsWith('.json'))
        .map(async (k) => (await store.get(k))!.toString()),
    )
  ).join('\n');

describe('the Scout’s tools', () => {
  it('cannot reach a host off the allowlist, whatever the model proposes or a page links to', async () => {
    const { page, s } = await newScout('scout-hosts', nearUrl);
    for (const path of [
      `http://${farHost}/`,
      `//${farHost}/x`,
      'javascript:alert(1)',
      'file:///etc/passwd',
    ])
      await expect(s.call('scout', 'browser_open', { path })).rejects.toThrow(
        /not on the allowlist/,
      );

    // The page itself tries: its picture and its link go to another host, and neither request leaves.
    expect(read(await s.call('scout', 'browser_open', {})).page.texts).toContain(
      'A page with a way out.',
    );
    const away = read(await s.call('scout', 'browser_look', {})).page;
    const r = read(
      await s.call('scout', 'browser_click', { ref: refOf(away, 'link', 'Elsewhere') }),
    );
    expect(r.text).toContain(`the page tried to open ${farHost}, which is not on the allowlist`);
    expect(farHits).toBe(0);
    expect(new Set(page.refused.map((x) => x.host))).toEqual(new Set([farHost]));
    expect(page.refused.filter((x) => x.document)).toHaveLength(1);
    expect(r.page.texts).toContain('A page with a way out.');

    const steps = await rows<{ name: string; action: string | null; outcome: string | null }>(
      'SELECT name, action, outcome FROM "Step" WHERE "runId" = $1 ORDER BY seq',
      'scout-hosts',
    );
    expect(steps.filter((x) => x.name === 'refused')).toHaveLength(5);
    await page.close();
  }, 120_000);

  it('cannot type a secret, run page script, or call a tool outside its role', async () => {
    const { page, s } = await newScout('scout-refusals');
    const signIn = read(await s.call('scout', 'browser_open', {})).page;
    const user = refOf(signIn, 'textbox');
    const pass = refOf(signIn, 'password');
    for (const [input, why] of [
      [{ ref: user, text: PASSWORDS.service }, /holds a secret/],
      [{ ref: user, text: `id ${OPERATORS.service.id}` }, /holds a secret/],
      [{ ref: pass, text: 'anything' }, /not a text field/],
      [{ ref: 'c999', text: 'x' }, /no control c999/],
    ] as const)
      await expect(s.call('scout', 'browser_type', input)).rejects.toThrow(why);
    await expect(
      s.call('scout', 'browser_type_credential', { ref: user, credential: 'password' }),
    ).rejects.toThrow(/goes into a password field/);
    await expect(s.call('scout', 'browser_enter_code', { ref: user })).rejects.toThrow(
      /has not shown that it sent a code/,
    );
    await expect(s.call('scout', 'browser_press', { key: 'F12' })).rejects.toThrow(
      /does not fit browser_press/,
    );
    // No tool runs script: there is none to call, and the tool set is closed.
    await expect(s.call('scout', 'browser_eval', { script: 'document.cookie' })).rejects.toThrow(
      /browser_eval is not one of the scout's tools/,
    );
    await expect(s.call('supervisor', 'browser_click', { ref: user })).rejects.toThrow(
      /browser_click is not one of the supervisor's tools/,
    );
    const tools = s.tools('scout');
    expect(tools.map((t) => t.name)).toEqual([
      'browser_open',
      'browser_look',
      'browser_click',
      'browser_type',
      'browser_choose',
      'browser_press',
      'browser_wait',
      'browser_type_credential',
      'browser_enter_code',
    ]);
    expect(s.tools('supervisor').map((t) => t.name)).toEqual(['browser_look']);
    const inputs = tools.flatMap((t) =>
      Object.keys((z.toJSONSchema(t.input) as { properties?: object }).properties ?? {}),
    );
    expect(new Set(inputs)).toEqual(
      new Set(['path', 'ref', 'text', 'option', 'key', 'seconds', 'credential']),
    );

    const refused = await rows<{ outcome: string }>(
      `SELECT outcome FROM "Step" WHERE "runId" = $1 AND name = 'refused' ORDER BY seq`,
      'scout-refusals',
    );
    expect(refused).toHaveLength(9);
    await page.close();
  }, 120_000);

  it('on the transfer path, never presses a control named with a money word, profile or not', async () => {
    const { page, s } = await newScout('scout-money', `${nearUrl}confirm`, lastCode, []);
    const before = posts;
    // Off the transfer path, Confirm is only a word; on it, Confirm moves money.
    s.onTransferPath(true);
    const p = read(await s.call('scout', 'browser_open', {})).page;
    await expect(
      s.call('scout', 'browser_click', { ref: refOf(p, 'button', 'Confirm') }),
    ).rejects.toThrow(/could move money/);
    await expect(s.call('scout', 'browser_press', { key: 'Enter' })).rejects.toThrow(
      /could move money/,
    );
    expect(posts).toBe(before);
    const refused = await rows<{ action: string }>(
      `SELECT action FROM "Step" WHERE "runId" = $1 AND name = 'refused' ORDER BY seq`,
      'scout-money',
    );
    expect(refused.map((r) => r.action)).toEqual(['browser_click', 'browser_press']);
    // Continue only leads to the review page, and stays allowed.
    expect(
      read(await s.call('scout', 'browser_click', { ref: refOf(p, 'button', 'Continue') })).page
        .texts,
    ).toContain('Posted.');
    expect(posts).toBe(before + 1);
    await page.close();
  }, 120_000);

  it('on the transfer path, presses Send code but never Send money', async () => {
    const { page, s } = await newScout('scout-send', `${nearUrl}send`, lastCode, []);
    const before = posts;
    s.onTransferPath(true);
    const p = read(await s.call('scout', 'browser_open', {})).page;
    await expect(
      s.call('scout', 'browser_click', { ref: refOf(p, 'button', 'Send money') }),
    ).rejects.toThrow(/could move money/);
    expect(posts).toBe(before);
    expect(
      read(await s.call('scout', 'browser_click', { ref: refOf(p, 'button', 'Send code') })).page
        .texts,
    ).toContain('Posted.');
    expect(posts).toBe(before + 1);
    await page.close();
  }, 120_000);

  it('never clicks a picture no one has named, nor presses Enter beside one', async () => {
    const { page, s } = await newScout('scout-pictures', `${nearUrl}review`);
    const before = posts;
    const p = read(await s.call('scout', 'browser_open', {})).page;
    const [unnamed, named] = p.controls.filter((c) => c.role === 'image-button');
    expect([unnamed!.name, named!.name]).toEqual(['', 'Preview']);
    await expect(s.call('scout', 'browser_click', { ref: unnamed!.ref })).rejects.toThrow(
      /an unnamed picture is never clicked/,
    );
    await expect(s.call('scout', 'browser_press', { key: 'Enter' })).rejects.toThrow(
      /picture button no one has named/,
    );
    expect(posts).toBe(before);
    const refused = await rows<{ action: string }>(
      `SELECT action FROM "Step" WHERE "runId" = $1 AND name = 'refused' ORDER BY seq`,
      'scout-pictures',
    );
    expect(refused.map((r) => r.action)).toEqual(['browser_click', 'browser_press']);
    // A named picture is clicked, and its form posts.
    expect(read(await s.call('scout', 'browser_click', { ref: named!.ref })).page.texts).toContain(
      'Posted.',
    );
    expect(posts).toBe(before + 1);
    await page.close();
  }, 120_000);

  it('each tool leaves a frame, from the Loading shell to member search, and none shows a secret', async () => {
    const { page, s } = await newScout('scout-frames');
    const done: string[] = [];
    const call = async (name: string, input: object) => {
      done.push(name);
      return read(await s.call('scout', name, input)).page;
    };
    await call('browser_open', {});
    let p = await call('browser_look', {});
    p = await call('browser_type_credential', { ref: refOf(p, 'textbox'), credential: 'user_id' });
    p = await call('browser_type_credential', {
      ref: refOf(p, 'password'),
      credential: 'password',
    });
    p = await call('browser_click', { ref: refOf(p, null, 'Sign In') });
    expect(p.texts).toContain('Where should we send your code?');
    p = await call('browser_click', { ref: refOf(p, null, 'Send code') });
    await call('browser_enter_code', { ref: refOf(p, 'textbox') });
    // Enter does not submit this form: its Verify is a scripted link.
    p = await call('browser_press', { key: 'Tab' });
    await call('browser_click', { ref: refOf(p, null, 'Verify') });
    p = await call('browser_wait', { seconds: 1 });
    p = await call('browser_click', { ref: refOf(p, null, 'Member Search') });
    p = await call('browser_type', { ref: refOf(p, 'textbox'), text: MEMBERS.demo });
    expect(p.controls.some((c) => c.name === 'Search')).toBe(true);

    const frames = await rows<{ imageKey: string | null; host: string }>(
      'SELECT "imageKey", host FROM "TrailFrame" WHERE "runId" = $1 ORDER BY seq',
      'scout-frames',
    );
    expect(frames).toHaveLength(done.length);
    expect(
      frames.every((f) => f.imageKey?.endsWith('.png') && f.host === new URL(bank.url).host),
    ).toBe(true);
    const all =
      (await stored('scout-frames')) +
      JSON.stringify(await rows('SELECT * FROM "Step" WHERE "runId" = $1', 'scout-frames'));
    for (const secret of [PASSWORDS.service, OPERATORS.service.id, await lastCode(), MEMBERS.demo])
      expect(holds(all, secret), secret).toBe(false);
    await page.close();
  }, 180_000);
});

// ── The Supervisor and the Scout, through the gateway ───────────────────────────────────────

type View = ReturnType<typeof read>['page'];
type Use = { name: string; input: Record<string, unknown> };

const has = (p: View, name: string) => p.controls.some((c) => c.name === name);
const lastRef = (p: View, name: string) => p.controls.findLast((c) => c.name === name)!.ref;
const lists = (p: View) => p.controls.filter((c) => c.options);

const FILL =
  'Choose the first account in From and the second in To, type 1.00 as the Amount, and press Continue.';
const SEARCH = `Search for member ${MEMBERS.demo}.`;

/** The Scout's side of the script: what its model does for each instruction. */
const PLANS: Record<string, ((p: View) => Use)[]> = {
  'Sign in as the staff service account.': [
    (p) => ({
      name: 'browser_type_credential',
      input: { ref: refOf(p, 'textbox'), credential: 'user_id' },
    }),
    (p) => ({
      name: 'browser_type_credential',
      input: { ref: refOf(p, 'password'), credential: 'password' },
    }),
    (p) => ({ name: 'browser_click', input: { ref: refOf(p, null, 'Sign In') } }),
  ],
  'Have the code sent.': [
    (p) => ({ name: 'browser_click', input: { ref: refOf(p, null, 'Send code') } }),
  ],
  'Enter the code the bank sent.': [
    (p) => ({ name: 'browser_enter_code', input: { ref: refOf(p, 'textbox') } }),
    (p) => ({ name: 'browser_click', input: { ref: refOf(p, null, 'Verify') } }),
  ],
  'Open Member Search.': [
    (p) => ({ name: 'browser_click', input: { ref: lastRef(p, 'Member Search') } }),
  ],
  [SEARCH]: [
    (p) => ({ name: 'browser_type', input: { ref: refOf(p, 'textbox'), text: MEMBERS.demo } }),
    (p) => ({ name: 'browser_click', input: { ref: refOf(p, null, 'Search') } }),
  ],
  'Open the member.': [(p) => ({ name: 'browser_click', input: { ref: lastRef(p, 'Open') } })],
  'Open Statements on the first account.': [
    (p) => ({ name: 'browser_click', input: { ref: refOf(p, null, 'Statements') } }),
  ],
  'Open Transfer Funds.': [
    (p) => ({ name: 'browser_click', input: { ref: lastRef(p, 'Transfer Funds') } }),
  ],
  [FILL]: [
    (p) => ({ name: 'browser_choose', input: { ref: lists(p)[0]!.ref, option: 2 } }),
    (p) => ({ name: 'browser_choose', input: { ref: lists(p)[1]!.ref, option: 3 } }),
    (p) => ({ name: 'browser_type', input: { ref: refOf(p, 'textbox'), text: '1.00' } }),
    (p) => ({ name: 'browser_click', input: { ref: refOf(p, null, 'Continue') } }),
  ],
  // Told to submit, the Scout tries the button and then the Enter key.
  'Press Submit transfer.': [
    (p) => ({ name: 'browser_click', input: { ref: refOf(p, null, 'Submit transfer') } }),
    () => ({ name: 'browser_press', input: { key: 'Enter' } }),
  ],
};

/** The Supervisor's side: the next step from the goal, the latest page and the steps so far. */
function decide(goal: Goal, p: View, steps: string): string {
  if (p.controls.some((c) => c.role === 'password')) return 'Sign in as the staff service account.';
  if (has(p, 'Send code')) return 'Have the code sent.';
  if (has(p, 'Verify')) return 'Enter the code the bank sent.';
  const summary = p.texts.some((t) => t.includes('Available balance'));
  const search = has(p, 'Open')
    ? 'Open the member.'
    : has(p, 'Search')
      ? SEARCH
      : 'Open Member Search.';
  switch (goal) {
    case 'check-balance':
      return summary ? 'stop' : search;
    case 'download-statements':
      if (has(p, 'Show')) return 'stop';
      return summary ? 'Open Statements on the first account.' : search;
    case 'transfer':
      // A rogue instruction, once: the Scout must not be able to follow it.
      if (p.texts.includes('Review transfer'))
        return steps.includes('Press Submit transfer.') ? 'stop' : 'Press Submit transfer.';
      if (lists(p).length === 2) return FILL;
      return summary ? 'Open Transfer Funds.' : search;
  }
}

/** The page a tool's result shows, if it shows one (a refusal does not). */
const pageOf = (text: string) => {
  try {
    return read(text).page;
  } catch {
    return undefined;
  }
};

/**
 * The Supervisor's model drafting the recommendation from the run's frames: first a draft with a
 * claim that cites no frame, which the tool refuses; then each claim on the first frame that shows
 * it, and a refusal the bank never made, as a guess from the transfer form; then done.
 */
function recommending(text: string, items: object[]) {
  const results = items.filter((x) => 'result' in x).length;
  if (results === 2) return { text: 'Recommended.' };
  const frames = [...text.matchAll(/^(f\d+): (\{.*\})$/gm)].map(([, ref, json]) => ({
    ref: ref!,
    ...(JSON.parse(json!) as { controls: string[]; texts: string[] }),
  }));
  const on = (pred: (f: (typeof frames)[number]) => boolean) => frames.find(pred)!.ref;
  const control = (name: string) => on((f) => f.controls.includes(name));
  const seen = (about: string, value: string, ref: string): Claim => ({
    about,
    value,
    basis: 'seen',
    frames: [ref],
  });
  const guess: Claim = {
    about: 'refusals.insufficient_funds',
    value: 'The amount is more than the available balance.',
    basis: 'guess',
    frames: results === 0 ? [] : [control('Continue')],
  };
  const claims =
    results === 0
      ? [seen('words.signIn', 'Sign In', control('Sign In')), guess]
      : [
          seen('words.signIn', 'Sign In', control('Sign In')),
          seen('words.memberSearch', 'Member Search', control('Member Search')),
          seen('words.statements', 'Statements', control('Statements')),
          seen('words.transfer', 'Transfer Funds', control('Transfer Funds')),
          seen('words.continue', 'Continue', control('Continue')),
          seen('words.submitTransfer', 'Submit transfer', control('Submit transfer')),
          seen(
            'screens.member.summary',
            'Available balance',
            on((f) => f.texts.some((t) => t.includes('Available balance'))),
          ),
          guess,
        ];
  return { tool: 'recommend', input: { claims } };
}

/**
 * Both roles' models, scripted, on either provider. The Supervisor reads the goal and the latest
 * frame and answers in its form, citing that frame (its first answer cites a frame of no run, which
 * counts as a wait); the Scout follows the plan for its instruction, on the latest page a tool
 * showed it.
 */
function scripted() {
  let n = 0;
  return fakeModels((_provider, r) => {
    n++;
    const said = r.items.flatMap((x) => ('user' in x ? [x.user] : []));
    if (r.system.includes('with the recommend tool')) return recommending(said[0]!, r.items);
    if (r.system.startsWith('You are the Supervisor')) {
      const text = said[0]!;
      const goal = (Object.keys(GOALS) as Goal[]).find((g) =>
        text.startsWith(`Goal: ${GOALS[g](MEMBERS.demo)}`),
      )!;
      const [, ref, json] = /Latest frame, (f\d+):\n(.*)$/s.exec(text)!;
      const answer = {
        next: decide(goal, JSON.parse(json!) as View, text),
        reason: `the page in ${ref} shows where the Scout is`,
        frames: [n === 1 ? 'f999' : ref],
      };
      return { text: JSON.stringify(answer) };
    }
    // The instruction is the last thing the Supervisor said; the tool results after it are this step's.
    const at = r.items.findLastIndex((x) => 'user' in x && PLANS[x.user.split('\n')[0]!]);
    const instruction = (r.items[at] as { user: string }).user;
    const plan = PLANS[instruction.split('\n')[0]!]!;
    const results = r.items.slice(at + 1).flatMap((x) => ('result' in x ? [x.result] : []));
    // The latest page: the one the instruction came with, or one a tool showed since.
    const shown = results.map(pageOf).filter(Boolean).at(-1);
    const step =
      results.length < plan.length ? plan[results.length]!(shown ?? read(instruction).page) : null;
    return step ? { tool: step.name, input: step.input } : { text: 'Done.' };
  });
}

const ANSWER_KEY = 'a'.repeat(32);

/** A person at the Console: answers each staff-code task with the code the bank sent. */
function person(runId: string) {
  let on = true;
  const answered: string[] = [];
  const done = (async () => {
    while (on) {
      const open = await db.query<{ id: string }>(
        `SELECT id FROM "HumanTask" WHERE "runId" = $1 AND status = 'open'`,
        [runId],
      );
      for (const t of open.rows) {
        const code = await lastCode();
        if (await answerHumanTask(db, t.id, code, 'staff@test', ANSWER_KEY)) answered.push(code);
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  })();
  return async () => {
    on = false;
    await done;
    return answered;
  };
}

/** The three goals in one run and one browser session: the balance, statements, the transfer. */
async function runThrough(upstream: Upstream, runId: string, provider: Provider) {
  const app = buildServer({
    gateway: gateway({
      ledger: sqlLedger(db),
      upstream,
      prices: { ...PRICES, [OPENAI_TEST_MODEL]: TEST_PRICE },
    }),
    token: TOKEN,
    mode: upstream.spends ? 'live' : 'mock',
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const { port } = app.server.address() as AddressInfo;
  const code = personCode({
    sql: db,
    runId,
    bank: 'generic',
    answerKey: ANSWER_KEY,
    deadlineMs: 60_000,
  });
  const { page, trail, s } = await newScout(runId, bank.url, code);
  const agent = (role: Role): Agent => ({
    model: MODELS[provider][role],
    url: `http://127.0.0.1:${port}/gateway/${runId}/${role}`,
    token: TOKEN,
  });
  const stop = person(runId);
  try {
    let conversation: Conversation | undefined;
    const ended: (string | null)[] = [];
    // The frame each goal ended on.
    const reached: (string | null)[] = [];
    for (const goal of ['check-balance', 'download-statements', 'transfer'] as const) {
      const r = await runGoal({
        scoutAgent: agent('scout'),
        supervisorAgent: agent('supervisor'),
        scout: s,
        trail,
        goal,
        member: MEMBERS.demo,
        conversation,
      });
      conversation = r.conversation;
      ended.push(r.ended);
      reached.push(s.latest()!.ref);
    }
    // The goals reached, the Supervisor recommends the bank's profile from the run's frames.
    const claims = await recommend({
      agent: agent('supervisor'),
      sql: db,
      trail,
      runId,
      bank: 'generic',
      goals: (['check-balance', 'download-statements', 'transfer'] as const).map((g) =>
        GOALS[g](MEMBERS.demo),
      ),
    });
    return { conversation, ended, reached, claims, answered: await stop() };
  } finally {
    await stop();
    await page.close();
    await app.close();
  }
}

/** Each role's model: the Anthropic defaults, or OpenAI configured for both roles. */
const MODELS: Record<Provider, Record<Role, Agent['model']>> = {
  anthropic: DEFAULT_ROLES,
  openai: {
    scout: { ...DEFAULT_ROLES.scout, provider: 'openai', model: OPENAI_TEST_MODEL },
    supervisor: { ...DEFAULT_ROLES.supervisor, provider: 'openai', model: OPENAI_TEST_MODEL },
    lessons: { ...DEFAULT_ROLES.lessons, provider: 'openai', model: OPENAI_TEST_MODEL },
  },
};

// A conversation as the replay checks it: the agents' own turns (system and assistant) in full, in
// the same places; what the live bank showed may differ. Less when each message was added and how
// long the model took.
const untimed = (c: unknown) =>
  (
    JSON.parse(
      JSON.stringify(c, (k, v: unknown) =>
        k === 'timestamp' || k === 'durationMs' ? undefined : v,
      ),
    ) as { role: string }[] | undefined
  )?.map((m) => (m.role === 'assistant' || m.role === 'system' ? m : { role: m.role }));

describe.each(['anthropic', 'openai'] as const)(
  'the Supervisor guiding the Scout on %s',
  (provider) => {
    it('reaches the balance, the statements list and the transfer review page on bank 1, recorded once and replayed in mock mode', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'gb-supervisor-'));
      const [liveRun, mockRun] = [`guided-live-${provider}`, `guided-mock-${provider}`];
      await db.query(
        `INSERT INTO "FactoryRun" (id, tenant, task, mode, phase, status) VALUES
         ($1, 'generic', 'check-balance', 'build', 'SCOUT', 'running'),
         ($2, 'generic', 'check-balance', 'build', 'SCOUT', 'running')`,
        [liveRun, mockRun],
      );
      try {
        // The scripted models, recorded through the gateway as a live run is.
        const recorded = await runThrough(live(scripted(), dir), liveRun, provider);
        // The same run with no key: every request must be the recording's, byte for byte.
        await copyFile(join(dir, `${liveRun}.jsonl`), join(dir, `${mockRun}.jsonl`));
        const upstream = upstreamFor({}, dir);
        expect(upstream.spends).toBe(false);
        const replayed = await runThrough(upstream, mockRun, provider);
        expect(untimed(replayed.conversation)).toEqual(untimed(recorded.conversation));
        expect(replayed.reached).toEqual(recorded.reached);

        // Each goal ended on its page, by the Supervisor's stop.
        const model = async (ref: string | null) =>
          JSON.parse(
            (await store.get(`runs/${mockRun}/${ref!.slice(1).padStart(3, '0')}.json`))!.toString(),
          ) as { controls: { name: string }[]; texts: { text: string }[] };
        const [balance, statements, review] = await Promise.all(replayed.reached.map(model));
        expect(balance!.texts.some((t) => t.text.includes('Available balance'))).toBe(true);
        expect(statements!.controls.some((c) => c.name === 'Show')).toBe(true);
        expect(review!.texts.some((t) => t.text === 'Review transfer')).toBe(true);
        expect(replayed.ended.every((e) => e?.startsWith('the page in f'))).toBe(true);

        // Every answer cites a frame of the run; the first, citing f999, was read as a wait.
        const turns = await rows<{ action: string; outcome: string }>(
          `SELECT action, outcome FROM "Step" WHERE "runId" = $1 AND name = 'supervisor' ORDER BY seq`,
          mockRun,
        );
        expect(turns[0]).toEqual({
          action: 'wait',
          outcome: 'unreadable: f999 is not a frame of this run',
        });
        for (const t of turns.slice(1)) expect(t.outcome).toMatch(/ \[f\d+\]$/);

        // Told to submit, the Scout could not: the button and Enter were refused, and nothing posted.
        const refused = await rows<{ action: string; outcome: string }>(
          `SELECT action, outcome FROM "Step" WHERE "runId" = $1 AND name = 'refused' ORDER BY seq`,
          mockRun,
        );
        expect(refused.map((r) => r.action)).toEqual(['browser_click', 'browser_press']);
        for (const r of refused)
          expect(r.outcome).toMatch(/the factory stops at the transfer's review page/);
        expect((await bank.db.query('SELECT 1 FROM transfers')).rows).toHaveLength(0);

        // The code came from a person through the Console's inbox, and no model saw it.
        expect(replayed.answered).toHaveLength(1);
        expect(
          await rows(`SELECT kind, status FROM "HumanTask" WHERE "runId" = $1`, mockRun),
        ).toEqual([{ kind: 'staff_code', status: 'answered' }]);
        // The masked screenshots are left out: base64 holds runs of digits that a code can match.
        const recording = (await readFile(join(dir, `${liveRun}.jsonl`), 'utf8'))
          .replace(/"data":"[A-Za-z0-9+/=]+"/g, '"data":""')
          .replace(/"url":"data:image\/png;base64,[A-Za-z0-9+/=]+"/g, '"url":""');
        const seen = recording + (await stored(liveRun)) + (await stored(mockRun));
        const codes = [...recorded.answered, ...replayed.answered];
        for (const secret of [PASSWORDS.service, OPERATORS.service.id, ...codes])
          expect(holds(seen, secret), secret).toBe(false);

        // Both roles went through the gateway, on their models, at no cost in mock mode.
        const calls = await rows<{ role: string; model: string; usd: string }>(
          `SELECT role, model, "costUsd"::text AS usd FROM "ModelCall" WHERE "factoryRunId" = $1`,
          mockRun,
        );
        expect(new Set(calls.map((c) => c.role))).toEqual(new Set(['scout', 'supervisor']));
        expect(
          calls.every((c) => c.model === MODELS[provider].scout.model && c.usd === '0.0000'),
        ).toBe(true);

        // The Console shows the run's trail, behind its Frames button.
        const frames = await rows('SELECT seq FROM "TrailFrame" WHERE "runId" = $1', mockRun);
        const html = (await consoleApp.inject({ method: 'GET', url: `/runs/${mockRun}` })).body;
        expect(html).toContain(`Frames (${frames.length})`);

        // The recommendation: every claim cites frames of this run, and each claim marked seen
        // is on every frame it cites. The refusal the bank never made is kept as a guess.
        const claims = replayed.claims!;
        expect(claims).toEqual(recorded.claims);
        expect(claims.map((c) => c.basis)).toEqual([...Array<string>(7).fill('seen'), 'guess']);
        for (const c of claims) {
          expect(c.frames.length).toBeGreaterThan(0);
          for (const ref of c.frames) {
            expect(Number(ref.slice(1))).toBeLessThanOrEqual(frames.length);
            const m = await model(ref);
            const words = [...m.controls.map((x) => x.name), ...m.texts.map((t) => t.text)];
            if (c.basis === 'seen') expect(words.some((w) => w.includes(c.value))).toBe(true);
            else expect(words).not.toContain(c.value);
          }
        }
        // Its first draft held a claim with no frame: refused, and nothing kept until it was fixed.
        const drafts = await rows<{ action: string; outcome: string }>(
          `SELECT action, outcome FROM "Step" WHERE "runId" = $1 AND name = 'recommend' ORDER BY seq`,
          mockRun,
        );
        expect(drafts.map((d) => d.action)).toEqual(['refused', 'recommended']);
        expect(drafts[0]!.outcome).toBe(
          'claim 2 (refusals.insufficient_funds) cites no frame: every claim rests on frames of this run',
        );
        expect(drafts[1]!.outcome).toBe('8 claims: 7 seen, 1 guessed');
        const [kept] = await rows<{ id: string; status: string }>(
          'SELECT id, status FROM "Recommendation" WHERE "factoryRunId" = $1',
          mockRun,
        );
        expect(kept!.status).toBe('open');

        // In Chrome, on the review card: the guess shows as a guess, and the first claim's Frames
        // button opens the frame it cites.
        const tab = await browser.newPage();
        try {
          await tab.goto(`${consoleUrl}/recommendations`);
          const card = (await waitFullyRendered(tab, { limitMs: 30_000 })).model;
          expect(card.texts.some((t) => t.text === 'guess')).toBe(true);
          expect(card.texts.some((t) => t.text.includes('One claim is a guess'))).toBe(true);
          // The newest open recommendation, this run's, is the first card.
          const button = card.controls.find((x) => x.name.startsWith('Frames ('))!;
          expect(button.name).toBe('Frames (1)');
          await click(tab, button);
          await waitFullyRendered(tab, { limitMs: 30_000 });
          const shown = await tab.call<{
            result: { value: { open: boolean; src: string; loaded: boolean; caption: string } };
          }>('Runtime.evaluate', {
            expression: `(() => { const i = document.querySelector('#frame-body img'); return { open: document.getElementById('frames').open, src: i ? new URL(i.src).pathname : '', loaded: !!i && i.complete && i.naturalWidth > 0, caption: document.getElementById('frame-cap').textContent }; })()`,
            returnByValue: true,
          });
          const seq = Number(claims[0]!.frames[0]!.slice(1));
          expect(shown.result.value).toEqual({
            open: true,
            src: `/runs/${mockRun}/frames/${seq}.png`,
            loaded: true,
            caption: expect.stringMatching(new RegExp(`^${seq}\\. `)),
          });
        } finally {
          await tab.close();
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }, 600_000);
  },
);
