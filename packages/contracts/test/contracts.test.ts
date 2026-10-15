import { describe, expect, it } from 'vitest';
import {
  ACTIONS,
  CANNED,
  CheckBalanceInput,
  CODES,
  HUMAN_BODIES,
  HumanAction,
  HumanTaskKind,
  httpStatus,
  messageFor,
  problem,
  refusal,
  RETRYABLE,
  type ResultCode,
  safeMessage,
  statusOf,
  TASKS,
  TransferInput,
} from '../src/index.js';

describe('task inputs', () => {
  it('lists the three tasks', () => {
    expect(Object.keys(TASKS).sort()).toEqual(['check-balance', 'download-statements', 'transfer']);
  });

  it('takes the bank as a registry id, not a fixed list', () => {
    expect(
      CheckBalanceInput.safeParse({ bank: 'a-new-bank', memberId: '40017732', account: '7890' })
        .success,
    ).toBe(true);
    expect(
      CheckBalanceInput.safeParse({ bank: 'Bad Bank!', memberId: '40017732', account: '7890' })
        .success,
    ).toBe(false);
  });

  it('refuses a transfer without an idempotency key', () => {
    const r = TransferInput.safeParse({
      bank: 'generic',
      memberId: '40017732',
      from: '7890',
      to: '1234',
      amountCents: 1000,
    });
    expect(r.success).toBe(false);
  });
});

describe('the result', () => {
  const all = Object.values(CODES).flatMap((c) => Object.keys(c)) as ResultCode[];

  it('has every code under exactly one status, each with its own sentence', () => {
    expect(new Set(all).size).toBe(all.length);
    for (const code of all) expect(messageFor(code).length).toBeGreaterThan(10);
    expect(statusOf('insufficient_funds')).toBe('business_outcome');
    expect(statusOf('unknown_screen')).toBe('escalated');
  });

  it('marks only failures as retryable', () => {
    for (const code of RETRYABLE) expect(statusOf(code)).toBe('failed');
  });

  it('maps every status to the HTTP status of §D.7', () => {
    expect(httpStatus({ status: 'running' })).toBe(202);
    expect(httpStatus({ status: 'needs_human' })).toBe(202);
    expect(httpStatus({ status: 'succeeded' })).toBe(200);
    expect(httpStatus({ status: 'handed_off' })).toBe(200);
    expect(httpStatus({ status: 'business_outcome' })).toBe(422);
    expect(httpStatus({ status: 'escalated' })).toBe(409);
    expect(httpStatus({ status: 'expired' })).toBe(410);
    expect(httpStatus({ status: 'cancelled' })).toBe(410);
    expect(httpStatus({ status: 'failed', retryable: true })).toBe(503);
    expect(httpStatus({ status: 'failed', retryable: false })).toBe(502);
  });

  it('writes problem details as RFC 9457 with our three members', () => {
    expect(
      problem(422, 'insufficient_funds', messageFor('insufficient_funds'), { runId: 'r_1' }),
    ).toMatchObject({
      status: 422,
      code: 'insufficient_funds',
      runId: 'r_1',
      retryable: false,
      type: 'https://generic-bank.local/problems/insufficient_funds',
    });
  });
});

describe('the caller gets our words', () => {
  it('passes our sentences through', () => {
    for (const code of ['insufficient_funds', 'unknown_screen', 'unavailable'] as ResultCode[])
      expect(safeMessage(messageFor(code))).toBe(messageFor(code));
  });

  it('replaces anything carrying page text, code, a selector or our hosts', () => {
    for (const leak of [
      '<td class="bal">$1,234</td>',
      "TypeError: Cannot read properties of null (reading 'balance')",
      'Error\n    at Runner.step (/app/runner.js:10:3)',
      'connect ECONNREFUSED 10.0.0.4:5432',
      'GET http://bank-generic:8081/corelink/home failed',
      'no match for div.tiles > table',
      'vault sealed',
    ]) {
      expect(safeMessage(leak)).toBe(CANNED.generic);
    }
    expect(problem(502, 'app_error', 'TypeError: x is null').detail).toBe(CANNED.generic);
  });
});

describe('human steps', () => {
  it('give every kind of task its own actions, and every action a body', () => {
    for (const k of HumanTaskKind.options) expect(ACTIONS[k].length).toBeGreaterThan(1);
    for (const a of HumanAction.options) expect(HUMAN_BODIES[a]).toBeDefined();
    // Every action is offered by some kind of task, and Cancel by all of them.
    expect(new Set(Object.values(ACTIONS).flat())).toEqual(new Set(HumanAction.options));
    for (const k of HumanTaskKind.options) expect(ACTIONS[k]).toContain('cancel');
  });

  it('refuse an action from the wrong state or the wrong kind', () => {
    const open = { kind: 'approval', status: 'open' } as const;
    expect(refusal(open, 'approve')).toBeNull();
    expect(refusal({ ...open, status: 'answered' }, 'approve')).toMatch(/answered/);
    expect(refusal({ ...open, status: 'expired' }, 'cancel')).toMatch(/expired/);
    expect(refusal(open, 'answer')).toMatch(/cannot be answered/);
    expect(refusal({ kind: 'staff_code', status: 'open' }, 'approve')).toMatch(/cannot/);
    expect(refusal({ kind: 'escalation', status: 'open' }, 'resume')).toBeNull();
    expect(refusal({ kind: 'escalation', status: 'open', resolvable: false }, 'resume')).toMatch(
      /cannot resume/,
    );
    expect(refusal({ kind: 'escalation', status: 'open', resolvable: false }, 'cancel')).toBeNull();
  });

  it('need a written reason for everything but a code', () => {
    expect(HUMAN_BODIES.answer.safeParse({ code: '123456' }).success).toBe(true);
    expect(HUMAN_BODIES.answer.safeParse({ code: '12a456' }).success).toBe(false);
    for (const a of ['approve', 'reject', 'take_over', 'resume', 'finish', 'cancel'] as const) {
      expect(HUMAN_BODIES[a].safeParse({}).success).toBe(false);
      expect(HUMAN_BODIES[a].safeParse({ reason: 'ok' }).success).toBe(false);
      expect(HUMAN_BODIES[a].safeParse({ reason: '  checked the member  ' }).success).toBe(true);
      expect(HUMAN_BODIES[a].safeParse({ reason: '          ' }).success).toBe(false);
    }
  });
});
