// The Supervisor's answer: its fixed form, the frames it cites, and when it stops the run. Its
// model is a fake fetch behind the real gateway; no request leaves the process.
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { controlDb } from '../../../packages/oauth/test/control.js';
import { gateway } from '../src/gateway.js';
import { sqlLedger } from '../src/ledger.js';
import { DEFAULT_ROLES } from '../src/models.js';
import type { Scout } from '../src/scout.js';
import { buildServer } from '../src/server.js';
import { readAnswer, supervisor } from '../src/supervisor.js';
import type { Trail } from '../src/trail.js';
import { live } from '../src/upstream.js';

const TOKEN = 'gateway-token-for-tests-0123456789abcdef';
const PNG = Buffer.from('a masked screenshot');

let db: Awaited<ReturnType<typeof controlDb>>;
let dir: string;
let app: ReturnType<typeof buildServer>;
let answers: string[];
let sent: Record<string, unknown>[];

/** The model: each request is answered with the next scripted text. */
function fakeModel(): Anthropic {
  const fetch = async (_url: unknown, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    const text = answers.shift() ?? 'nothing left';
    const events = [
      {
        type: 'message_start',
        message: {
          id: `msg_${sent.length}`,
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
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 50 },
      },
      { type: 'message_stop' },
    ];
    return new Response(
      events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''),
      { headers: { 'content-type': 'text/event-stream' } },
    );
  };
  return new Anthropic({ apiKey: 'not-a-real-key', fetch: fetch as never, maxRetries: 0 });
}

beforeEach(async () => {
  db = await controlDb();
  await db.query(
    `INSERT INTO "FactoryRun" (id, tenant, task, mode, phase, status)
     VALUES ('run1', 'generic', 'check-balance', 'build', 'SCOUT', 'running')`,
  );
  dir = await mkdtemp(join(tmpdir(), 'gb-supervisor-'));
  app = buildServer({
    gateway: gateway({ ledger: sqlLedger(db), upstream: live(fakeModel(), dir) }),
    token: TOKEN,
    mode: 'live',
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  answers = [];
  sent = [];
});

afterEach(async () => {
  await app.close();
  await db.close();
  await rm(dir, { recursive: true, force: true });
});

const answer = (next: string, frames = ['f1'], reason = 'the sign-in form is on screen') =>
  JSON.stringify({ next, reason, frames });

/** A Supervisor over a Scout that is always on frame f1, the only frame of the run. */
function setUp() {
  const steps: { name: string; action?: string; outcome?: string }[] = [];
  const trail: Trail = {
    policy: { known: [] },
    step: async (s) => {
      steps.push(s);
      return null;
    },
    has: (ref) => ref === 'f1',
  };
  const call = vi.fn(async () => ({ text: 'waited 1 s.\n{}' }));
  const scout = {
    latest: () => ({ ref: 'f1', image: PNG, view: { page: 'bank/corelink/' } }),
    call,
  } as unknown as Scout;
  const { port } = app.server.address() as AddressInfo;
  const s = supervisor({
    agent: {
      model: DEFAULT_ROLES.supervisor,
      url: `http://127.0.0.1:${port}/gateway/run1/supervisor`,
      token: TOKEN,
    },
    scout,
    trail,
    goal: 'Reach the balance.',
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

  it('is asked of the Supervisor’s model with the frame’s picture, in a fixed form, at high effort', async () => {
    const { s, steps } = setUp();
    answers = [answer('Sign in as the staff service account.')];
    expect(await s.next(null)).toBe('Sign in as the staff service account.');
    const body = sent[0] as {
      model: string;
      output_config: { effort: string; format: { type: string } };
      messages: { content: { type: string; text?: string }[] }[];
    };
    expect(body.model).toBe('claude-opus-5-5');
    expect(body.output_config.effort).toBe('high');
    expect(body.output_config.format.type).toBe('json_schema');
    expect(body.messages[0]!.content.map((b) => b.type)).toEqual(['image', 'text']);
    expect(body.messages[0]!.content[1]!.text).toContain('Latest frame, f1:');
    expect(steps).toEqual([
      {
        name: 'supervisor',
        action: 'Sign in as the staff service account.',
        outcome: 'the sign-in form is on screen [f1]',
      },
    ]);
  });

  it('counts an unreadable answer as a wait, and three in a row stop the run', async () => {
    const { s, steps, call } = setUp();
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
    let { s } = setUp();
    answers = [answer('stop')];
    expect(await s.next(null)).toBeNull();
    expect(s.ended()).toBe('the sign-in form is on screen');

    ({ s } = setUp());
    answers = [answer('Sign in.'), answer('Sign in.'), answer('Sign in.')];
    expect(await s.next(null)).toBe('Sign in.');
    expect(await s.next('Nothing happened.')).toBe('Sign in.');
    expect(await s.next('Nothing happened.')).toBeNull();
    expect(s.ended()).toBe('the same step 3 times in a row: no progress');
  });
});
