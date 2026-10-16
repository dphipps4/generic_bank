// The memory suite: the outbox (plan §K.4, §K.11). Every run the system settles leaves its episode
// in the outbox; the recorder sends it to memory as the runner, signed. With memory stopped, runs
// settle as before and their episodes wait; once memory is back, each arrives exactly once. Read
// back through the Memory service's API.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sendEpisodes } from '../../apps/runner/src/recorder.js';
import { controlDb } from '../../packages/oauth/test/control.js';
import { createRun, resultOf, settleRun } from '../../packages/runs/src/index.js';
import { memoryService, SIGNING_KEY, TOKENS } from '../support/memory.js';
import { as } from './api.js';

const KEY = 'k'.repeat(40);
let control: Awaited<ReturnType<typeof controlDb>>;
let memory: Awaited<ReturnType<typeof memoryService>>;
const writer = () => ({ url: memory.url, token: TOKENS.runner, signingKey: SIGNING_KEY });

beforeAll(async () => {
  [control, memory] = await Promise.all([controlDb(), memoryService()]);
});
afterAll(async () => {
  await memory.close();
  await control.close();
});

async function settled(status: 'succeeded' | 'failed') {
  const { runId } = await createRun(
    control,
    {
      task: 'check-balance',
      bank: 'generic',
      clientId: null,
      inputs: { bank: 'generic', memberId: '700123456', account: '4321' },
    },
    KEY,
  );
  await settleRun(
    control,
    runId,
    status === 'succeeded'
      ? { status, data: { availableCents: 100 } }
      : { status, code: 'app_error' },
  );
  return runId;
}

const recent = async () =>
  (
    await as(memory.url, 'runner').get<{ attempts: { run: string; outcome: string }[] }>(
      '/episodes/recent?bank=generic&limit=50',
    )
  ).body.attempts;

describe('the outbox', () => {
  it('keeps episodes while memory is stopped, and sends each exactly once when it is back', async () => {
    await memory.stop();
    const a = await settled('succeeded');
    const b = await settled('failed');
    // The runs settled as they would have anyway.
    expect(await resultOf(control, a)).toMatchObject({ status: 'succeeded' });
    expect(await resultOf(control, b)).toMatchObject({ status: 'failed', code: 'app_error' });
    expect(await sendEpisodes(control, writer())).toBe(0);

    await memory.start();
    expect(await sendEpisodes(control, writer())).toBe(2);
    expect(await sendEpisodes(control, writer())).toBe(0);
    expect((await recent()).map((x) => [x.run, x.outcome])).toEqual(
      expect.arrayContaining([
        [a, 'succeeded'],
        [b, 'failed'],
      ]),
    );
    expect(await recent()).toHaveLength(2);
  });
});
