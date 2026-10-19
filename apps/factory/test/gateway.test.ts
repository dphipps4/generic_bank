// The model gateway: caps before every request, spend after it, and a refusal with no key, on
// OpenRouter's route. No test reaches a model: the live path runs the real SDK against a fake
// fetch, with a key that is not one.
import net from 'node:net';
import OpenAI from 'openai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { controlDb } from '../../../packages/oauth/test/control.js';
import { CAPS } from '../src/caps.js';
import { gateway, worstCaseUsd } from '../src/gateway.js';
import { sqlLedger, type Ledger } from '../src/ledger.js';
import { PRICES } from '../src/models.js';
import { buildServer } from '../src/server.js';
import { live, upstreamFor, type Upstream } from '../src/upstream.js';

const TOKEN = 'gateway-token-for-tests-0123456789abcdef';

// A model priced for these tests only: 1,000 tokens in and 500 out cost $0.014.
const MODEL = 'test-model';
const PRICE = { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 8 };
const TEST_PRICES = { ...PRICES, [MODEL]: PRICE };

// What the fake model answers, streamed and whole.
const USAGE = { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 };
const CHUNKS = [
  {
    choices: [{ index: 0, delta: { role: 'assistant', content: 'Sign in.' }, finish_reason: null }],
  },
  { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  { choices: [], usage: USAGE },
].map((c) => ({
  id: 'chatcmpl-1',
  object: 'chat.completion.chunk',
  created: 1,
  model: MODEL,
  ...c,
}));
const SSE = `${CHUNKS.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('')}data: [DONE]\n\n`;
const WHOLE = {
  id: 'chatcmpl-1',
  object: 'chat.completion',
  created: 1,
  model: MODEL,
  choices: [
    { index: 0, message: { role: 'assistant', content: 'Sign in.' }, finish_reason: 'stop' },
  ],
  usage: USAGE,
};

let db: Awaited<ReturnType<typeof controlDb>>;
let sent: Record<string, unknown>[];
let release: Promise<void>;

/** The SDK with a fetch that answers like the API and remembers each body. */
function fakeModel(): OpenAI {
  const fetch = async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    sent.push(body);
    await release;
    return body.stream
      ? new Response(SSE, { headers: { 'content-type': 'text/event-stream' } })
      : Response.json(WHOLE);
  };
  return new OpenAI({ apiKey: 'not-a-real-key', fetch: fetch as never, maxRetries: 0 });
}

function factory(upstream: Upstream, ledger: Ledger = sqlLedger(db)) {
  const app = buildServer({
    gateway: gateway({ ledger, upstream, prices: TEST_PRICES }),
    token: TOKEN,
  });
  return (runId: string, role: string, body: Record<string, unknown>, token = TOKEN) =>
    app.inject({
      method: 'POST',
      url: `/gateway/${runId}/${role}/openrouter/v1/chat/completions`,
      headers: { authorization: `Bearer ${token}` },
      payload: body,
    });
}

const ask = (extra: Record<string, unknown> = {}) => ({
  model: MODEL,
  max_tokens: 1000,
  messages: [{ role: 'user', content: 'Where is the sign-in form?' }],
  ...extra,
});

async function spent(runId: string, usd: number, daysAgo = 0) {
  await db.query(
    `INSERT INTO "ModelCall" (id, "factoryRunId", role, model, "tokensIn", "tokensOut", "costUsd", at)
     VALUES (gen_random_uuid()::text, $1, 'scout', 'test-model', 0, 0, $2,
             now() - make_interval(days => $3::int))`,
    [runId, usd, daysAgo],
  );
}

beforeEach(async () => {
  db = await controlDb();
  await db.query(
    `INSERT INTO "FactoryRun" (id, tenant, task, mode, phase, status) VALUES
       ('run1', 'generic', 'check-balance', 'build', 'SCOUT', 'running'),
       ('run2', 'generic', 'check-balance', 'build', 'SCOUT', 'running')`,
  );
  sent = [];
  release = Promise.resolve();
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await db.close();
});

describe('the caps', () => {
  it('are the plan’s defaults', () => {
    expect(CAPS).toEqual({
      runUsd: 25,
      weekUsd: 150,
      lessonsReserveUsd: 1,
    });
  });

  it('count a screenshot at an image’s worst case, not its bytes', () => {
    const data = 'A'.repeat(300_000);
    const image = { type: 'image_url', image_url: { url: `data:image/png;base64,${data}` } };
    const frame = ask({ messages: [{ role: 'user', content: [image] }] });
    // 1,000 output tokens are $0.02; the image at most 5,000 input tokens, $0.02.
    expect(worstCaseUsd(PRICE, frame)).toBeCloseTo(0.04, 2);
  });
});

describe('the model gateway', () => {
  it('refuses a request that would pass the run’s cap before it is sent', async () => {
    const post = factory(live({ openrouter: fakeModel() }));
    await spent('run1', 23.5);
    // 64,000 output tokens could cost $1.28: past the $24 a run may spend before the lessons.
    const r = await post('run1', 'scout', ask({ max_tokens: 64_000 }));
    expect(r.statusCode).toBe(402);
    expect(r.json().error.type).toBe('billing_error');
    expect(sent).toHaveLength(0);
    // A smaller request still fits.
    expect((await post('run1', 'scout', ask())).statusCode).toBe(200);
    expect(sent).toHaveLength(1);
  });

  it('keeps the reserve for the lessons', async () => {
    const post = factory(live({ openrouter: fakeModel() }));
    await spent('run1', 23.9);
    expect((await post('run1', 'supervisor', ask({ max_tokens: 20_000 }))).statusCode).toBe(402);
    expect((await post('run1', 'lessons', ask({ max_tokens: 20_000 }))).statusCode).toBe(200);
  });

  it('refuses at the week’s cap across runs, counting only the last seven days', async () => {
    const post = factory(live({ openrouter: fakeModel() }));
    await spent('run2', 149.5, 8);
    expect((await post('run1', 'scout', ask({ max_tokens: 64_000 }))).statusCode).toBe(200);
    await spent('run2', 149.5);
    expect((await post('run1', 'scout', ask({ max_tokens: 64_000 }))).statusCode).toBe(402);
    expect(sent).toHaveLength(1);
  });

  it('holds a request in flight against the cap', async () => {
    let go!: () => void;
    release = new Promise((r) => (go = r));
    const post = factory(live({ openrouter: fakeModel() }));
    await spent('run1', 22);
    // Each could cost about $1.28; one fits under $24, two do not.
    const first = post('run1', 'scout', ask({ max_tokens: 64_000 }));
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect((await post('run1', 'supervisor', ask({ max_tokens: 64_000 }))).statusCode).toBe(402);
    go();
    expect((await first).statusCode).toBe(200);
  });

  it('refuses server tools, an unknown run and a bad token', async () => {
    const post = factory(live({ openrouter: fakeModel() }));
    const search = ask({ tools: [{ type: 'web_search' }] });
    expect((await post('run1', 'scout', search)).statusCode).toBe(400);
    expect((await post('nope', 'scout', ask())).statusCode).toBe(404);
    expect((await post('run1', 'operator', ask())).statusCode).toBe(404);
    expect((await post('run1', 'scout', ask(), 'wrong-token')).statusCode).toBe(401);
    expect(sent).toHaveLength(0);
  });

  it('fails closed when the ledger cannot be read', async () => {
    const broken: Ledger = {
      spend: () => Promise.reject(new Error('connection refused')),
      record: () => Promise.resolve(),
    };
    const r = await factory(live({ openrouter: fakeModel() }), broken)('run1', 'scout', ask());
    expect(r.statusCode).toBe(503);
    expect(sent).toHaveLength(0);
  });

  it('records tokens and cost per run and role', async () => {
    const post = factory(live({ openrouter: fakeModel() }));
    const streamed = await post('run1', 'scout', ask({ stream: true }));
    expect(streamed.headers['content-type']).toMatch(/^text\/event-stream/);
    expect(streamed.body).toBe(SSE);
    const whole = await post('run1', 'supervisor', ask());
    expect(whole.json().choices[0].message.content).toBe('Sign in.');
    await post('run2', 'supervisor', ask());

    const rows = await db.query<{ run: string; role: string; calls: number; usd: string }>(
      `SELECT "factoryRunId" AS run, role, COUNT(*)::int AS calls, SUM("costUsd")::text AS usd,
              SUM("tokensIn")::int AS "in", SUM("tokensOut")::int AS out
         FROM "ModelCall" GROUP BY 1, 2 ORDER BY 1, 2`,
    );
    expect(rows.rows).toEqual([
      { run: 'run1', role: 'scout', calls: 1, usd: '0.0140', in: 1000, out: 500 },
      { run: 'run1', role: 'supervisor', calls: 1, usd: '0.0140', in: 1000, out: 500 },
      { run: 'run2', role: 'supervisor', calls: 1, usd: '0.0140', in: 1000, out: 500 },
    ]);
  });
});

describe('with no model key', () => {
  it('refuses every call, names the key, and reaches no model', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error('a call left the process')));
    const connect = vi.spyOn(net.Socket.prototype, 'connect');
    const r = await factory(upstreamFor({}))('run1', 'scout', ask());
    expect(r.statusCode).toBe(401);
    expect(r.json().error).toEqual({
      type: 'authentication_error',
      message: 'OPENROUTER_API_KEY is not set',
    });
    expect(connect).not.toHaveBeenCalled();
    const rows = await db.query(`SELECT 1 FROM "ModelCall"`);
    expect(rows.rows).toHaveLength(0);
  });
});
