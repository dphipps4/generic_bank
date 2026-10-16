// The Supervisor's answer: its fixed form, the frames it cites, and when it stops the run, on the
// Anthropic defaults and with OpenAI configured. Its model is a fake fetch behind the real gateway;
// no request leaves the process.
import { mkdtemp, rm } from 'node:fs/promises';
import net, { type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { controlDb } from '../../../packages/oauth/test/control.js';
import { gateway } from '../src/gateway.js';
import { sqlLedger } from '../src/ledger.js';
import { PRICES, type Provider, type RoleModel } from '../src/models.js';
import { DEFAULT_ROLES } from './fakes.js';
import type { Scout } from '../src/scout.js';
import { buildServer } from '../src/server.js';
import { readAnswer, supervisor } from '../src/supervisor.js';
import type { Trail } from '../src/trail.js';
import { live, upstreamFor } from '../src/upstream.js';
import { fakeModels, OPENAI_TEST_MODEL, TEST_PRICE } from './fakes.js';

const TOKEN = 'gateway-token-for-tests-0123456789abcdef';
const PNG = Buffer.from('a masked screenshot');

let db: Awaited<ReturnType<typeof controlDb>>;
let dir: string;
let app: ReturnType<typeof buildServer>;
let answers: string[];
let sent: Record<string, unknown>[];

/** The Supervisor's model on each provider: the default, and OpenAI configured as the README says. */
const MODELS: Record<Provider, RoleModel> = {
  anthropic: DEFAULT_ROLES.supervisor,
  openai: { ...DEFAULT_ROLES.supervisor, provider: 'openai', model: OPENAI_TEST_MODEL },
};

beforeEach(async () => {
  db = await controlDb();
  await db.query(
    `INSERT INTO "FactoryRun" (id, tenant, task, mode, phase, status)
     VALUES ('run1', 'generic', 'check-balance', 'build', 'SCOUT', 'running')`,
  );
  dir = await mkdtemp(join(tmpdir(), 'gb-supervisor-'));
  answers = [];
  sent = [];
  // The model: each request is answered with the next scripted text.
  const models = fakeModels(() => ({ text: answers.shift() ?? 'nothing left' }), sent);
  app = buildServer({
    gateway: gateway({
      ledger: sqlLedger(db),
      upstream: live(models, dir),
      prices: { ...PRICES, [OPENAI_TEST_MODEL]: TEST_PRICE },
    }),
    token: TOKEN,
    mode: 'live',
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
});

afterEach(async () => {
  await app.close();
  await db.close();
  await rm(dir, { recursive: true, force: true });
});

const answer = (next: string, frames = ['f1'], reason = 'the sign-in form is on screen') =>
  JSON.stringify({ next, reason, frames });

/** A Supervisor over a Scout that is always on frame f1, the only frame of the run. */
function setUp(provider: Provider, startedAt?: Date, at = app) {
  const steps: { name: string; action?: string; outcome?: string }[] = [];
  const trail: Trail = {
    policy: { known: [] },
    step: async (s) => {
      steps.push(s);
      return null;
    },
    has: (ref) => ref === 'f1',
    shown: async () => null,
  };
  const call = vi.fn(async () => ({ text: 'waited 1 s.\n{}' }));
  const scout = {
    latest: () => ({ ref: 'f1', image: PNG, view: { page: 'bank/corelink/' } }),
    call,
  } as unknown as Scout;
  const { port } = at.server.address() as AddressInfo;
  const s = supervisor({
    agent: {
      model: MODELS[provider],
      url: `http://127.0.0.1:${port}/gateway/run1/supervisor`,
      token: TOKEN,
    },
    scout,
    trail,
    goal: 'Reach the balance.',
    startedAt,
  });
  return { s, steps, call };
}

describe('the Supervisor’s answer', () => {
  it('is read only in its form, citing frames of this run', () => {
    const has = (r: string) => r === 'f1' || r === 'f2';
    expect(readAnswer(answer('Sign in.'), has)).toEqual({
      next: 'Sign in.',
      reason: 'the sign-in form is on screen',
      frames: ['f1'],
    });
    expect(readAnswer('Sign in.', has)).toBe('the answer is not JSON');
    expect(readAnswer(answer('Sign in.', ['f1', 'f7']), has)).toBe('f7 is not a frame of this run');
    expect(readAnswer(answer('Sign in.', []), has)).toMatch(/does not fit/);
    expect(readAnswer(answer('Sign in.', ['f1'], 'one\ntwo'), has)).toMatch(/one line/);
    expect(readAnswer(JSON.stringify({ next: 'stop', frames: ['f1'] }), has)).toMatch(
      /does not fit/,
    );
  });
});

describe.each(['anthropic'] as const)('the Supervisor on %s', (provider) => {
  it('is asked of the Supervisor’s model with the frame’s picture, in a fixed form, at its effort', async () => {
    const { s, steps } = setUp(provider);
    answers = [answer('Sign in as the staff service account.')];
    expect(await s.next(null)).toBe('Sign in as the staff service account.');
    type Part = { type: string; text?: string };
    const body = sent[0] as Record<string, unknown> & {
      messages: { role: string; content: Part[]; output_config?: { effort: string } }[];
    };
    const said = body.messages.find((m) => m.role === 'user')!.content;
    expect(said.find((b) => b.type === 'text')!.text).toContain('Latest frame, f1:');
    expect(body.model).toBe(MODELS[provider].model);
    if (provider === 'anthropic') {
      // pi sets the role's effort from the conversation's start; thinking cannot be turned off.
      expect(body.messages.find((m) => m.role === 'system')!.output_config).toEqual({
        effort: 'high',
      });
      expect(body.thinking).toMatchObject({ type: 'adaptive' });
      expect((body.output_config as { format: { type: string } }).format.type).toBe('json_schema');
      expect(said.map((b) => b.type)).toEqual(['image', 'text']);
    } else {
      expect(body.reasoning_effort).toBe('high');
      expect(body.response_format).toMatchObject({
        type: 'json_schema',
        json_schema: { strict: true },
      });
      expect(said.map((b) => b.type)).toEqual(['image_url', 'text']);
    }
    expect(steps).toEqual([
      {
        name: 'supervisor',
        action: 'Sign in as the staff service account.',
        outcome: 'the sign-in form is on screen [f1]',
      },
    ]);
  });

  it('counts an unreadable answer as a wait, and three in a row stop the run', async () => {
    const { s, steps, call } = setUp(provider);
    // Two unreadable, a wait (which resets the count), then three unreadable.
    answers = [
      'not an answer',
      answer('Sign in.', ['f9']),
      answer('wait'),
      answer('Sign in.', ['f1'], 'one\ntwo'),
      '{}',
      answer('Sign in.', ['f2']),
    ];
    expect(await s.next(null)).toBeNull();
    expect(s.ended()).toBe('3 unreadable answers in a row');
    // Each wait is the Scout's, and asks no model.
    expect(call).toHaveBeenCalledTimes(5);
    expect(call).toHaveBeenCalledWith('scout', 'browser_wait', { seconds: 1 });
    expect(steps.map((x) => x.action)).toEqual(['wait', 'wait', 'wait', 'wait', 'wait', 'wait']);
    expect(steps[1]!.outcome).toBe('unreadable: f9 is not a frame of this run');
  });

  it('stops on stop, and on the same step three times in a row', async () => {
    let { s } = setUp(provider);
    answers = [answer('stop')];
    expect(await s.next(null)).toBeNull();
    expect(s.ended()).toBe('the sign-in form is on screen');

    ({ s } = setUp(provider));
    answers = [answer('Sign in.'), answer('Sign in.'), answer('Sign in.')];
    expect(await s.next(null)).toBe('Sign in.');
    expect(await s.next('Nothing happened.')).toBe('Sign in.');
    expect(await s.next('Nothing happened.')).toBeNull();
    expect(s.ended()).toBe('the same step 3 times in a row: no progress');
  });

  it('stops at the run’s hours cap without asking the model', async () => {
    const { s, steps } = setUp(provider, new Date(Date.now() - 4 * 3_600_000 - 1000));
    answers = [answer('Sign in.')];
    expect(await s.next(null)).toBeNull();
    expect(s.ended()).toBe('the run has been active 4 hours, its cap');
    expect(sent).toHaveLength(0);
    expect(steps).toEqual([
      { name: 'supervisor', action: 'stop', outcome: 'the run has been active 4 hours, its cap' },
    ]);
  });

  it('in mock mode, with no key, reaches nothing but the gateway', async () => {
    answers = [answer('Sign in.')];
    expect(await setUp(provider).s.next(null)).toBe('Sign in.');
    // The same call again, replayed: pi's only connection is to the gateway, on this machine.
    const mock = buildServer({
      gateway: gateway({
        ledger: sqlLedger(db),
        upstream: upstreamFor({}, dir),
        prices: { ...PRICES, [OPENAI_TEST_MODEL]: TEST_PRICE },
      }),
      token: TOKEN,
      mode: 'mock',
    });
    await mock.listen({ host: '127.0.0.1', port: 0 });
    const connect = vi.spyOn(net.Socket.prototype, 'connect');
    try {
      expect(await setUp(provider, undefined, mock).s.next(null)).toBe('Sign in.');
      const { port } = mock.server.address() as AddressInfo;
      expect(connect).toHaveBeenCalled();
      // Node hands connect its options in an array.
      for (const args of connect.mock.calls)
        expect(args.flat()[0]).toMatchObject({ host: '127.0.0.1', port: String(port) });
      expect(sent).toHaveLength(1);
    } finally {
      connect.mockRestore();
      await mock.close();
    }
  });
});
