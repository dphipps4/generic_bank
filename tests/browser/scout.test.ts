import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runPages } from '../../apps/console/src/pages/runs.js';
import { gateway } from '../../apps/factory/src/gateway.js';
import { sqlLedger } from '../../apps/factory/src/ledger.js';
import { runScout, scout, type Supervisor } from '../../apps/factory/src/scout.js';
import { buildServer } from '../../apps/factory/src/server.js';
import { openTrail } from '../../apps/factory/src/trail.js';
import { live, upstreamFor, type Upstream } from '../../apps/factory/src/upstream.js';
import { MEMBERS, OPERATORS } from '../../apps/bank/src/seed.js';
import { memoryStore } from '../../packages/evidence/src/index.js';
import { controlDb } from '../../packages/oauth/test/control.js';
import { Browser } from '../../packages/screen/src/index.js';
import { type LiveBank, liveBank, PASSWORDS } from '../support/banks.js';

// The Scout against the real Generic Bank in Chrome: its tools, what they refuse, and a short
// scripted run through the model gateway, recorded and then replayed in mock mode. No request
// reaches the model and no key is used: the scripted model is a fake fetch behind the gateway.

const TOKEN = 'gateway-token-for-tests-0123456789abcdef';
const CREDS = { operatorId: OPERATORS.service.id, password: PASSWORDS.service };

let db: Awaited<ReturnType<typeof controlDb>>;
let bank: LiveBank;
let browser: Browser;
let store: ReturnType<typeof memoryStore>;
// A page that links off the allowlist, and the host it links to, which counts every request.
let near: Server;
let far: Server;
let farHits = 0;
let nearUrl: string;
let farHost: string;

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
  near = createServer((_q, s) => {
    s.setHeader('content-type', 'text/html');
    s.end(
      `<title>Near</title><p>A page with a way out.</p><img src="http://${farHost}/pixel.png" width="1" height="1"><a href="http://${farHost}/away">Elsewhere</a>`,
    );
  });
  nearUrl = `http://localhost:${await listen(near)}/`;
  browser = await Browser.launch({ hosts: [new URL(bank.url).host, new URL(nearUrl).host] });
  store = memoryStore();
}, 120_000);

afterAll(async () => {
  await browser?.close();
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

async function newScout(runId: string, start = bank.url) {
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
    code: lastCode,
  });
  return { page, trail, s };
}

/** What a tool's result says, and the page it shows, as the model reads them. */
const read = (r: unknown) => {
  const text =
    typeof r === 'string'
      ? r
      : (r as { type: string; text?: string }[]).find((b) => b.type === 'text')!.text!;
  const page = JSON.parse(text.slice(text.indexOf('\n') + 1)) as {
    page: string;
    controls: { ref: string; role: string; name: string }[];
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
    const tools = s.runnable('scout');
    expect(tools.map((t) => t.name)).toEqual([
      'browser_open',
      'browser_look',
      'browser_click',
      'browser_type',
      'browser_press',
      'browser_wait',
      'browser_type_credential',
      'browser_enter_code',
    ]);
    expect(s.runnable('supervisor').map((t) => t.name)).toEqual(['browser_look']);
    const inputs = tools.flatMap((t) =>
      Object.keys((t as { input_schema: { properties?: object } }).input_schema.properties ?? {}),
    );
    expect(new Set(inputs)).toEqual(
      new Set(['path', 'ref', 'text', 'key', 'seconds', 'credential']),
    );

    const refused = await rows<{ outcome: string }>(
      `SELECT outcome FROM "Step" WHERE "runId" = $1 AND name = 'refused' ORDER BY seq`,
      'scout-refusals',
    );
    expect(refused).toHaveLength(9);
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
      expect(all).not.toContain(secret);
    await page.close();
  }, 180_000);
});

// ── A scripted run through the gateway ──────────────────────────────────────────────────────

type Page_ = ReturnType<typeof read>['page'];
type Use = { name: string; input: Record<string, unknown> };

/** The Supervisor's instructions, for now; and what the scripted model does for each. */
const SCRIPT: [string, ((p: Page_) => Use)[]][] = [
  ['Open the bank.', [() => ({ name: 'browser_open', input: {} })]],
  [
    'Sign in as the staff service account.',
    [
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
  ],
  [
    'Have the code sent.',
    [(p) => ({ name: 'browser_click', input: { ref: refOf(p, null, 'Send code') } })],
  ],
  [
    'Enter the code the bank sent.',
    [
      (p) => ({ name: 'browser_enter_code', input: { ref: refOf(p, 'textbox') } }),
      (p) => ({ name: 'browser_click', input: { ref: refOf(p, null, 'Verify') } }),
    ],
  ],
  [
    'Open member search.',
    [
      (p) => ({
        name: 'browser_click',
        input: { ref: p.controls.find((c) => c.name === 'Member Search')!.ref },
      }),
    ],
  ],
];

const stub = (): Supervisor => {
  let i = 0;
  return { next: async () => SCRIPT[i++]?.[0] ?? null };
};

/** A model that follows the script: the instruction, the tool results since, the latest page. */
function scriptedModel(): Anthropic {
  let n = 0;
  const fetch = async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Anthropic.MessageCreateParams;
    const msgs = body.messages;
    const at = msgs.findLastIndex((m) => typeof m.content === 'string');
    const plan = SCRIPT.find(([text]) => text === msgs[at]!.content)![1];
    const results = (m: Anthropic.MessageParam[]) =>
      m.flatMap((x) =>
        Array.isArray(x.content) ? x.content.filter((b) => b.type === 'tool_result') : [],
      ) as Anthropic.ToolResultBlockParam[];
    const done = results(msgs.slice(at + 1)).length;
    // The latest page, from this instruction or an earlier one.
    const latest = results(msgs).at(-1);
    const step =
      done < plan.length
        ? plan[done]!(latest ? read(latest.content).page : (undefined as never))
        : null;
    n++;
    const block = step
      ? { type: 'tool_use', id: `toolu_${n}`, name: step.name, input: {} }
      : { type: 'text', text: '' };
    const delta = step
      ? { type: 'input_json_delta', partial_json: JSON.stringify(step.input) }
      : { type: 'text_delta', text: 'Done.' };
    const events = [
      {
        type: 'message_start',
        message: {
          id: `msg_${n}`,
          type: 'message',
          role: 'assistant',
          model: 'claude-opus-5-5',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 2000, output_tokens: 1 },
        },
      },
      { type: 'content_block_start', index: 0, content_block: block },
      { type: 'content_block_delta', index: 0, delta },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'message_delta',
        delta: { stop_reason: step ? 'tool_use' : 'end_turn', stop_sequence: null },
        usage: { output_tokens: 50 },
      },
      { type: 'message_stop' },
    ];
    return new Response(
      events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''),
      {
        headers: { 'content-type': 'text/event-stream' },
      },
    );
  };
  return new Anthropic({ apiKey: 'not-a-real-key', fetch: fetch as never, maxRetries: 0 });
}

async function runThrough(upstream: Upstream, runId: string) {
  const app = buildServer({
    gateway: gateway({ ledger: sqlLedger(db), upstream }),
    token: TOKEN,
    mode: upstream.spends ? 'live' : 'mock',
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const { port } = app.server.address() as AddressInfo;
  const { page, trail, s } = await newScout(runId);
  try {
    const client = new Anthropic({
      apiKey: TOKEN,
      baseURL: `http://127.0.0.1:${port}/gateway/${runId}/scout`,
      maxRetries: 0,
    });
    return await runScout({ client, scout: s, supervisor: stub(), trail });
  } finally {
    await page.close();
    await app.close();
  }
}

describe('the Scout as a model loop', () => {
  it('signs in to bank 1 and reaches member search, recorded once and replayed in mock mode', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gb-scout-'));
    await db.query(
      `INSERT INTO "FactoryRun" (id, tenant, task, mode, phase, status) VALUES
         ('scout-live', 'generic', 'check-balance', 'build', 'SCOUT', 'running'),
         ('scout-mock', 'generic', 'check-balance', 'build', 'SCOUT', 'running')`,
    );
    try {
      // The scripted model, recorded through the gateway as a live run is.
      const recorded = await runThrough(live(scriptedModel(), dir), 'scout-live');
      // The same run with no key: every request must be the recording's, byte for byte.
      await copyFile(join(dir, 'scout-live.jsonl'), join(dir, 'scout-mock.jsonl'));
      const upstream = upstreamFor('', dir);
      expect(upstream.spends).toBe(false);
      const replayed = await runThrough(upstream, 'scout-mock');
      expect(replayed).toEqual(recorded);

      const calls = await rows<{ role: string; model: string; usd: string }>(
        `SELECT role, model, "costUsd"::text AS usd FROM "ModelCall" WHERE "factoryRunId" = $1`,
        'scout-mock',
      );
      expect(calls).toHaveLength(13);
      expect(
        calls.every(
          (c) => c.role === 'scout' && c.model === 'claude-opus-5-5' && c.usd === '0.0000',
        ),
      ).toBe(true);

      // A frame for every page the Scout reached, the last one member search.
      const frames = await rows<{ seq: number; imageKey: string | null }>(
        'SELECT seq, "imageKey" FROM "TrailFrame" WHERE "runId" = $1 ORDER BY seq',
        'scout-mock',
      );
      expect(frames).toHaveLength(8);
      expect(frames.every((f) => f.imageKey)).toBe(true);
      const lastModel = JSON.parse((await store.get(`runs/scout-mock/008.json`))!.toString()) as {
        controls: { name: string }[];
      };
      expect(lastModel.controls.some((c) => c.name === 'Search')).toBe(true);
      // Nothing the model saw, and nothing stored, holds a credential or the code.
      const seen = JSON.stringify(replayed) + (await stored('scout-mock'));
      for (const secret of [PASSWORDS.service, OPERATORS.service.id, await lastCode()])
        expect(seen).not.toContain(secret);

      // The Console shows the factory run's trail, behind its Frames button.
      const consoleApp = Fastify();
      runPages(consoleApp, {
        sql: db,
        store,
        whoIs: () => ({ email: 'staff@test', role: 'approver' }),
      });
      const html = (await consoleApp.inject({ method: 'GET', url: '/runs/scout-mock' })).body;
      expect(html).toContain('Frames (8)');
      await consoleApp.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 240_000);
});
