// The model gateway: caps before every request, spend after it, and a refusal with no key, on
// Anthropic's route. No test reaches a model: the live path runs each real SDK against a fake
// fetch, with a key that is not one.
import net from 'node:net';
import Anthropic from '@anthropic-ai/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { controlDb } from '../../../packages/oauth/test/control.js';
import { CAPS } from '../src/caps.js';
import { gateway, worstCaseUsd } from '../src/gateway.js';
import { sqlLedger, type Ledger } from '../src/ledger.js';
import { PRICES, type Provider } from '../src/models.js';
import { buildServer } from '../src/server.js';
import { live, upstreamFor, type Upstream } from '../src/upstream.js';

const TOKEN = 'gateway-token-for-tests-0123456789abcdef';

// What the fake model answers: 1,000 tokens in and 500 out, $0.014 at Opus 5.5's prices.
const EVENTS = [
  {
    type: 'message_start',
    message: {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-5-5',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 1000, output_tokens: 1 },
    },
  },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Sign in.' } },
  { type: 'content_block_stop', index: 0 },
  {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { output_tokens: 500 },
  },
  { type: 'message_stop' },
];
const SSE = EVENTS.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');

let db: Awaited<ReturnType<typeof controlDb>>;
let sent: Record<string, unknown>[];
let release: Promise<void>;

/** The SDK with a fetch that answers like the API and remembers each body. */
function fakeModel(): Anthropic {
  const fetch = async (_url: unknown, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    await release;
    return new Response(SSE, { headers: { 'content-type': 'text/event-stream' } });
  };
  return new Anthropic({ apiKey: 'not-a-real-key', fetch: fetch as never, maxRetries: 0 });
}

// An OpenAI model, priced for these tests only.
const TEST_PRICES = {
  ...PRICES,
  'gpt-test': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 0 },
};

const PATHS: Record<Provider, string> = { anthropic: 'messages', openai: 'chat/completions' };

function factory(
  upstream: Upstream,
  ledger: Ledger = sqlLedger(db),
  provider: Provider = 'anthropic',
) {
  const app = buildServer({
    gateway: gateway({ ledger, upstream, prices: TEST_PRICES }),
    token: TOKEN,
  });
  return (runId: string, role: string, body: Record<string, unknown>, token = TOKEN) =>
    app.inject({
      method: 'POST',
      url: `/gateway/${runId}/${role}/v1/${PATHS[provider]}`,
      headers:
        provider === 'anthropic' ? { 'x-api-key': token } : { authorization: `Bearer ${token}` },
      payload: body,
    });
}

const ask = (extra: Record<string, unknown> = {}) => ({
  model: 'claude-opus-5-5',
  max_tokens: 1000,
  messages: [{ role: 'user', content: 'Where is the sign-in form?' }],
  ...extra,
});

async function spent(runId: string, usd: number, daysAgo = 0) {
  await db.query(
    `INSERT INTO "ModelCall" (id, "factoryRunId", role, model, "tokensIn", "tokensOut", "costUsd", at)
     VALUES (gen_random_uuid()::text, $1, 'scout', 'claude-opus-5-5', 0, 0, $2,
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
      runUsd: 10,
      weekUsd: 150,
      scoutTurns: 6,
      liveSignInsPerRun: 6,
      activeHoursPerRun: 4,
      failedCheckTurns: 3,
      liveVerifications: 2,
      lessonsReserveUsd: 1,
    });
  });

  it('count a screenshot at an image’s worst case, not its bytes', () => {
    const data = 'A'.repeat(300_000);
    const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data } };
    const frame = ask({ messages: [{ role: 'user', content: [image] }] });
    // 1,000 output tokens are $0.02; the image at most 5,000 input tokens, $0.02.
    expect(worstCaseUsd(PRICES['claude-opus-5-5']!, frame)).toBeCloseTo(0.04, 2);
  });
});

describe('the model gateway', () => {
  it('refuses a request that would pass the run’s cap before it is sent', async () => {
    const post = factory(live({ anthropic: fakeModel() }));
    await spent('run1', 8.5);
    // 64,000 output tokens could cost $1.28: past the $9 a run may spend before the lessons.
    const r = await post('run1', 'scout', ask({ max_tokens: 64_000 }));
    expect(r.statusCode).toBe(402);
    expect(r.json().error.type).toBe('billing_error');
    expect(sent).toHaveLength(0);
    // A smaller request still fits.
    expect((await post('run1', 'scout', ask())).statusCode).toBe(200);
    expect(sent).toHaveLength(1);
  });

  it('keeps the reserve for the lessons', async () => {
    const post = factory(live({ anthropic: fakeModel() }));
    await spent('run1', 8.9);
    expect((await post('run1', 'supervisor', ask({ max_tokens: 20_000 }))).statusCode).toBe(402);
    expect((await post('run1', 'lessons', ask({ max_tokens: 20_000 }))).statusCode).toBe(200);
  });

  it('refuses at the week’s cap across runs, counting only the last seven days', async () => {
    const post = factory(live({ anthropic: fakeModel() }));
    await spent('run2', 149.5, 8);
    expect((await post('run1', 'scout', ask({ max_tokens: 64_000 }))).statusCode).toBe(200);
    await spent('run2', 149.5);
    expect((await post('run1', 'scout', ask({ max_tokens: 64_000 }))).statusCode).toBe(402);
    expect(sent).toHaveLength(1);
  });

  it('holds a request in flight against the cap', async () => {
    let go!: () => void;
    release = new Promise((r) => (go = r));
    const post = factory(live({ anthropic: fakeModel() }));
    await spent('run1', 7);
    // Each could cost about $1.28; one fits under $9, two do not.
    const first = post('run1', 'scout', ask({ max_tokens: 64_000 }));
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect((await post('run1', 'supervisor', ask({ max_tokens: 64_000 }))).statusCode).toBe(402);
    go();
    expect((await first).statusCode).toBe(200);
  });

  it('refuses server tools, an unknown run and a bad token', async () => {
    const post = factory(live({ anthropic: fakeModel() }));
    const search = ask({ tools: [{ type: 'web_search_20260209', name: 'web_search' }] });
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
    const r = await factory(live({ anthropic: fakeModel() }), broken)('run1', 'scout', ask());
    expect(r.statusCode).toBe(503);
    expect(sent).toHaveLength(0);
  });

  it('records tokens and cost per run and role', async () => {
    const post = factory(live({ anthropic: fakeModel() }));
    const streamed = await post('run1', 'scout', ask({ stream: true }));
    expect(streamed.headers['content-type']).toMatch(/^text\/event-stream/);
    expect(streamed.body).toBe(SSE);
    const whole = await post('run1', 'supervisor', ask());
    expect(whole.json().content).toEqual([{ type: 'text', text: 'Sign in.' }]);
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
      message: 'ANTHROPIC_API_KEY is not set',
    });
    expect(connect).not.toHaveBeenCalled();
    const rows = await db.query(`SELECT 1 FROM "ModelCall"`);
    expect(rows.rows).toHaveLength(0);
  });
});
