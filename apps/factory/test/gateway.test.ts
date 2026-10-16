// The model gateway: caps before every request, spend after it, and mock mode, on Anthropic's
// route and OpenAI's. No test reaches a model: the live path runs each real SDK against a fake
// fetch, with a key that is not one.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
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
let dir: string;
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

/** What the fake OpenAI model answers: 1,000 tokens in (200 of them cached) and 500 out. */
const CHUNKS = [
  {
    choices: [{ index: 0, delta: { role: 'assistant', content: 'Sign in.' }, finish_reason: null }],
  },
  { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  {
    choices: [],
    usage: {
      prompt_tokens: 1000,
      completion_tokens: 500,
      total_tokens: 1500,
      prompt_tokens_details: { cached_tokens: 200 },
    },
  },
].map((c) => ({
  id: 'chatcmpl-1',
  object: 'chat.completion.chunk',
  created: 1,
  model: 'gpt-test',
  ...c,
}));
const CHAT_SSE = `${CHUNKS.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('')}data: [DONE]\n\n`;

function fakeOpenAI(): OpenAI {
  const fetch = async (_url: unknown, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    await release;
    return new Response(CHAT_SSE, { headers: { 'content-type': 'text/event-stream' } });
  };
  return new OpenAI({ apiKey: 'not-a-real-key', fetch: fetch as never, maxRetries: 0 });
}

const PATHS: Record<Provider, string> = { anthropic: 'messages', openai: 'chat/completions' };

function factory(
  upstream: Upstream,
  ledger: Ledger = sqlLedger(db),
  provider: Provider = 'anthropic',
) {
  const app = buildServer({
    gateway: gateway({ ledger, upstream, prices: TEST_PRICES }),
    token: TOKEN,
    mode: 'live',
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

const chat = (extra: Record<string, unknown> = {}) => ({
  model: 'gpt-test',
  max_completion_tokens: 1000,
  stream: true,
  messages: [{ role: 'user', content: 'Where is the sign-in form?' }],
  ...extra,
});

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
  dir = await mkdtemp(join(tmpdir(), 'gb-recordings-'));
  sent = [];
  release = Promise.resolve();
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await db.close();
  await rm(dir, { recursive: true, force: true });
});

describe('the caps', () => {
  it('are the plan’s defaults', () => {
    expect(CAPS).toEqual({
      runUsd: 25,
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
    const post = factory(live({ anthropic: fakeModel() }, dir));
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
    const post = factory(live({ anthropic: fakeModel() }, dir));
    await spent('run1', 23.9);
    expect((await post('run1', 'supervisor', ask({ max_tokens: 20_000 }))).statusCode).toBe(402);
    expect((await post('run1', 'lessons', ask({ max_tokens: 20_000 }))).statusCode).toBe(200);
  });

  it('refuses at the week’s cap across runs, counting only the last seven days', async () => {
    const post = factory(live({ anthropic: fakeModel() }, dir));
    await spent('run2', 149.5, 8);
    expect((await post('run1', 'scout', ask({ max_tokens: 64_000 }))).statusCode).toBe(200);
    await spent('run2', 149.5);
    expect((await post('run1', 'scout', ask({ max_tokens: 64_000 }))).statusCode).toBe(402);
    expect(sent).toHaveLength(1);
  });

  it('holds a request in flight against the cap', async () => {
    let go!: () => void;
    release = new Promise((r) => (go = r));
    const post = factory(live({ anthropic: fakeModel() }, dir));
    await spent('run1', 22);
    // Each could cost about $1.28; one fits under $24, two do not.
    const first = post('run1', 'scout', ask({ max_tokens: 64_000 }));
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect((await post('run1', 'supervisor', ask({ max_tokens: 64_000 }))).statusCode).toBe(402);
    go();
    expect((await first).statusCode).toBe(200);
  });

  it('refuses server tools, an unknown run and a bad token', async () => {
    const post = factory(live({ anthropic: fakeModel() }, dir));
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
    const r = await factory(live({ anthropic: fakeModel() }, dir), broken)('run1', 'scout', ask());
    expect(r.statusCode).toBe(503);
    expect(sent).toHaveLength(0);
  });

  it('records tokens and cost per run and role', async () => {
    const post = factory(live({ anthropic: fakeModel() }, dir));
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

describe('mock mode', () => {
  it('replays a recording exactly, without a key or the network', async () => {
    // A live run, recorded.
    const recorder = factory(live({ anthropic: fakeModel() }, dir));
    const calls = [
      ['scout', ask({ stream: true })],
      ['supervisor', ask({ messages: [{ role: 'user', content: 'What next?' }] })],
    ] as const;
    const recorded: string[] = [];
    for (const [role, body] of calls) recorded.push((await recorder('run1', role, body)).body);
    expect((await readFile(join(dir, 'run1.jsonl'), 'utf8')).trim().split('\n')).toHaveLength(2);

    // The same run with no key: nothing may leave the process.
    vi.stubGlobal('fetch', () => Promise.reject(new Error('mock mode used the network')));
    const connect = vi.spyOn(net.Socket.prototype, 'connect');
    await db.query(`DELETE FROM "ModelCall"`);
    const upstream = upstreamFor({}, dir);
    expect(upstream.spends).toBe(false);
    const post = factory(upstream);
    for (const [i, [role, body]] of calls.entries()) {
      const r = await post('run1', role, body);
      expect(r.statusCode).toBe(200);
      expect(r.body).toBe(recorded[i]);
    }
    expect(connect).not.toHaveBeenCalled();
    expect(sent).toHaveLength(2);

    const rows = await db.query<{ role: string; usd: string }>(
      `SELECT role, "costUsd"::text AS usd FROM "ModelCall" ORDER BY role`,
    );
    expect(rows.rows).toEqual([
      { role: 'scout', usd: '0.0000' },
      { role: 'supervisor', usd: '0.0000' },
    ]);
    // Past the end of the recording, or a run with none, is refused.
    expect((await post('run1', 'scout', ask())).statusCode).toBe(400);
    expect((await post('run2', 'scout', ask())).json().error.message).toBe(
      'no recording for run run2',
    );
  });

  it('refuses a request that differs from the recording', async () => {
    await factory(live({ anthropic: fakeModel() }, dir))('run1', 'scout', ask());
    const post = factory(upstreamFor({}, dir));
    const r = await post('run1', 'scout', ask({ max_tokens: 999 }));
    expect(r.statusCode).toBe(400);
    expect(r.json().error.message).toBe('call 1 differs from the recording at max_tokens');
  });

  it('replays what the bank showed by its shape, and refuses a turn of the model that differs', async () => {
    const shot = (data: string, text: string, earlier = 'Open the sign-in page.') =>
      ask({
        messages: [
          { role: 'user', content: 'Reach the balance.' },
          { role: 'assistant', content: [{ type: 'text', text: earlier }] },
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data } },
              { type: 'text', text },
            ],
          },
        ],
      });
    await factory(live({ anthropic: fakeModel() }, dir))(
      'run1',
      'supervisor',
      shot('AAAA', 'Page one'),
    );
    await factory(live({ anthropic: fakeModel() }, dir))(
      'run2',
      'supervisor',
      shot('AAAA', 'Page one'),
    );
    const post = factory(upstreamFor({}, dir));
    // The page moved and its text changed between the recording and the replay: still the same call.
    expect((await post('run1', 'supervisor', shot('BBBB', 'Page one, redrawn'))).statusCode).toBe(
      200,
    );
    // The model's own earlier turn is not what was recorded: refused.
    expect(
      (await post('run2', 'supervisor', shot('AAAA', 'Page one', 'Open the help page.')))
        .statusCode,
    ).toBe(400);
  });
});

describe('the OpenAI route', () => {
  const openai = (ledger?: Ledger) =>
    factory(live({ anthropic: fakeModel(), openai: fakeOpenAI() }, dir), ledger, 'openai');

  it('is metered as Anthropic’s is: the cost recorded after, at the model’s price', async () => {
    const r = await openai()('run1', 'scout', chat());
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toMatch(/^text\/event-stream/);
    expect(r.body).toBe(CHAT_SSE);
    // The usage is always asked for, so the call can be metered.
    expect(sent[0]!.stream_options).toEqual({ include_usage: true });
    const rows = await db.query(
      `SELECT role, model, "tokensIn" AS "in", "tokensOut" AS out, "tokensCached" AS cached,
              "costUsd"::text AS usd FROM "ModelCall"`,
    );
    // 800 tokens at $2, 200 cached at $0.20 and 500 out at $10 a million: $0.00664, rounded up.
    expect(rows.rows).toEqual([
      { role: 'scout', model: 'gpt-test', in: 1000, out: 500, cached: 200, usd: '0.0067' },
    ]);
  });

  it('checks the budget before the call, and refuses a server tool', async () => {
    const post = openai();
    await spent('run1', 23.5);
    // 64,000 output tokens could cost $0.64 at $10 a million: past the $0.50 left before the lessons.
    const big = await post('run1', 'scout', chat({ max_completion_tokens: 64_000 }));
    expect(big.statusCode).toBe(402);
    expect(big.json().error.type).toBe('billing_error');
    expect(
      (await post('run1', 'scout', chat({ max_completion_tokens: undefined }))).statusCode,
    ).toBe(400);
    expect((await post('run1', 'scout', chat({ web_search_options: {} }))).statusCode).toBe(400);
    expect((await post('run1', 'scout', chat({ service_tier: 'priority' }))).statusCode).toBe(400);
    expect((await post('run1', 'scout', chat(), 'wrong-token')).statusCode).toBe(401);
    expect(sent).toHaveLength(0);
    expect((await post('run1', 'scout', chat())).statusCode).toBe(200);
  });

  it('refuses a provider with no key in live mode, and replays in mock mode without the network', async () => {
    const keyless = factory(live({ anthropic: fakeModel() }, dir), undefined, 'openai');
    const r = await keyless('run1', 'scout', chat());
    expect(r.statusCode).toBe(401);
    expect(r.json().error.message).toBe('OPENAI_API_KEY is not set');

    const recorded = (await openai()('run1', 'scout', chat())).body;
    vi.stubGlobal('fetch', () => Promise.reject(new Error('mock mode used the network')));
    const connect = vi.spyOn(net.Socket.prototype, 'connect');
    const post = factory(upstreamFor({}, dir), undefined, 'openai');
    const again = await post('run1', 'scout', chat());
    expect(again.statusCode).toBe(200);
    expect(again.body).toBe(recorded);
    expect(connect).not.toHaveBeenCalled();
    // The same bytes on the other provider's route are not the recording's.
    await rm(join(dir, 'run1.jsonl'));
    await openai()('run1', 'scout', chat());
    expect((await factory(upstreamFor({}, dir))('run1', 'scout', chat())).statusCode).toBe(400);
  });
});
