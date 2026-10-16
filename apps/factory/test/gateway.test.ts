// The model gateway: caps before every request, spend after it, and mock mode. No test reaches
// the model: the live path runs the real SDK against a fake fetch, with a key that is not one.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigError, loadConfig } from '../../../packages/config/src/index.js';
import { controlDb } from '../../../packages/oauth/test/control.js';
import { CAPS } from '../src/caps.js';
import { gateway, worstCaseUsd } from '../src/gateway.js';
import { sqlLedger, type Ledger } from '../src/ledger.js';
import { DEFAULT_ROLES, PRICES, ROLE_SETTINGS, rolesOf } from '../src/models.js';
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

function factory(upstream: Upstream, ledger: Ledger = sqlLedger(db)) {
  const app = buildServer({ gateway: gateway({ ledger, upstream }), token: TOKEN, mode: 'live' });
  return (runId: string, role: string, body: Record<string, unknown>, token = TOKEN) =>
    app.inject({
      method: 'POST',
      url: `/gateway/${runId}/${role}/v1/messages`,
      headers: { 'x-api-key': token },
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
    const post = factory(live(fakeModel(), dir));
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
    const post = factory(live(fakeModel(), dir));
    await spent('run1', 23.9);
    expect((await post('run1', 'supervisor', ask({ max_tokens: 20_000 }))).statusCode).toBe(402);
    expect((await post('run1', 'lessons', ask({ max_tokens: 20_000 }))).statusCode).toBe(200);
  });

  it('refuses at the week’s cap across runs, counting only the last seven days', async () => {
    const post = factory(live(fakeModel(), dir));
    await spent('run2', 149.5, 8);
    expect((await post('run1', 'scout', ask({ max_tokens: 64_000 }))).statusCode).toBe(200);
    await spent('run2', 149.5);
    expect((await post('run1', 'scout', ask({ max_tokens: 64_000 }))).statusCode).toBe(402);
    expect(sent).toHaveLength(1);
  });

  it('holds a request in flight against the cap', async () => {
    let go!: () => void;
    release = new Promise((r) => (go = r));
    const post = factory(live(fakeModel(), dir));
    await spent('run1', 22);
    // Each could cost about $1.28; one fits under $24, two do not.
    const first = post('run1', 'scout', ask({ max_tokens: 64_000 }));
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect((await post('run1', 'supervisor', ask({ max_tokens: 64_000 }))).statusCode).toBe(402);
    go();
    expect((await first).statusCode).toBe(200);
  });

  it('refuses a model with no known price, server tools, an unknown run and a bad token', async () => {
    const post = factory(live(fakeModel(), dir));
    const fable = await post('run1', 'scout', ask({ model: 'claude-fable-5-1' }));
    expect(fable.statusCode).toBe(400);
    expect(fable.json().error.message).toBe('no known price for model claude-fable-5-1');
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
    const r = await factory(live(fakeModel(), dir), broken)('run1', 'scout', ask());
    expect(r.statusCode).toBe(503);
    expect(sent).toHaveLength(0);
  });

  it('records tokens and cost per run and role, and sets each role’s effort', async () => {
    const post = factory(live(fakeModel(), dir));
    const streamed = await post('run1', 'scout', ask({ stream: true }));
    expect(streamed.headers['content-type']).toMatch(/^text\/event-stream/);
    expect(streamed.body).toBe(SSE);
    const whole = await post('run1', 'supervisor', ask());
    expect(whole.json().content).toEqual([{ type: 'text', text: 'Sign in.' }]);
    await post('run2', 'supervisor', ask());

    expect(sent.map((b) => (b.output_config as { effort: string }).effort)).toEqual([
      'low',
      'high',
      'high',
    ]);
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
    const recorder = factory(live(fakeModel(), dir));
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
    const upstream = upstreamFor('', dir);
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
    await factory(live(fakeModel(), dir))('run1', 'scout', ask());
    const post = factory(upstreamFor('', dir));
    const r = await post('run1', 'scout', ask({ max_tokens: 999 }));
    expect(r.statusCode).toBe(400);
    expect(r.json().error.message).toBe('call 1 differs from the recording');
  });

  it('matches a screenshot by its place, since the same page differs where it moves', async () => {
    const shot = (data: string, text = 'What next?') =>
      ask({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data } },
              { type: 'text', text },
            ],
          },
        ],
      });
    await factory(live(fakeModel(), dir))('run1', 'supervisor', shot('AAAA'));
    await factory(live(fakeModel(), dir))('run2', 'supervisor', shot('AAAA'));
    const post = factory(upstreamFor('', dir));
    expect((await post('run1', 'supervisor', shot('BBBB'))).statusCode).toBe(200);
    // Every other byte must still match.
    expect((await post('run2', 'supervisor', shot('AAAA', 'What now?'))).statusCode).toBe(400);
  });
});

describe('each role’s model', () => {
  const settings = (env: Record<string, string>) => rolesOf(loadConfig(ROLE_SETTINGS, env));

  it('defaults to Opus 5.5, thinking hard for the Supervisor and lightly for the Scout', () => {
    expect(settings({})).toEqual(DEFAULT_ROLES);
    expect(DEFAULT_ROLES.scout).toEqual({
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      effort: 'low',
    });
    expect(DEFAULT_ROLES.supervisor.effort).toBe('high');
    expect(DEFAULT_ROLES.lessons).toEqual(DEFAULT_ROLES.supervisor);
  });

  it('comes from the settings, and a provider not yet supported is refused', async () => {
    const roles = settings({ FACTORY_SUPERVISOR_EFFORT: 'max', FACTORY_SCOUT_MODEL: 'other' });
    expect(roles.supervisor.effort).toBe('max');
    expect(roles.lessons.effort).toBe('max');
    expect(roles.scout.model).toBe('other');
    expect(() => settings({ FACTORY_SCOUT_PROVIDER: 'openai' })).toThrow(ConfigError);

    // The gateway sets the configured effort; a model with no price is refused.
    const post = factory(live(fakeModel(), dir, roles));
    await post('run1', 'supervisor', ask());
    expect((sent[0]!.output_config as { effort: string }).effort).toBe('max');
    expect((await post('run1', 'scout', ask({ model: 'other' }))).statusCode).toBe(400);
  });
});
