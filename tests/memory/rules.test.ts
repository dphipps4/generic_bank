// The memory suite: every rule (plan §K.4). Fixed functions of stored episodes, with no model:
// promotion confirms what its probation runs proposed from what they saw or relied on; one
// contradiction disputes, two retire; a lesson wrong at one bank retires there only; two banks of a
// vendor widen a lesson to the vendor; three vendors make a pattern candidate that waits for a
// person; a later promoted run brings a retired lesson back; a demotion disputes what its promotion
// confirmed. Facts need a successful promotion, and a search as of a past run returns what memory
// believed then. Each case reads back the versions and change-log rows the rule leaves, all through
// the Memory service's API.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { memoryService } from '../support/memory.js';
import { as, type Caller, HASH, lesson, propose, ruled, run } from './api.js';

let memory: Awaited<ReturnType<typeof memoryService>>;
let runner: Caller;
let factory: Caller;
let system: Caller;
let curator: Caller;
beforeAll(async () => {
  memory = await memoryService();
  [runner, factory, system, curator] = (['runner', 'factory', 'system', 'curator'] as const).map(
    (r) => as(memory.url, r),
  );
});
afterAll(async () => {
  await memory.close();
});

/** A factory run at a bank that builds `driver`. */
const build = (id: string, bank: string, driver: string, vendor = 'corelink') =>
  run(factory, id, bank, { kind: 'factory', driver, vendor, outcome: 'recommended' });

/** Two clean probation runs of a driver, the second promoting it, the first relying on `relied`. */
async function promote(bank: string, driver: string, relied: string[] = [], vendor = 'corelink') {
  await run(runner, `${driver}/p1`, bank, { driver, vendor });
  if (relied.length)
    expect(
      (await runner.post('lessons/relied-on', { runId: `${driver}/p1`, lessonIds: relied })).status,
    ).toBe(201);
  const r = await run(runner, `${driver}/p2`, bank, { driver, vendor, mark: 'promoted' });
  expect(r.status).toBe(201);
  return r.body as { ruled: number };
}

const contradict = (lessonId: string, runId: string) =>
  factory.post('facts/invalidate', {
    lessonId,
    runId,
    reason: 'the bank did otherwise',
    frames: ['f2'],
    evidenceHash: HASH,
  });

describe('the rules', () => {
  it('confirm on promotion what its runs saw or relied on, and leave a guess no one relied on', async () => {
    await build('confirm-b', 'bank-a', 'a@1');
    const seen = await propose(factory, 'confirm-b', 'Bank A lists statements newest first.');
    const guess = await propose(factory, 'confirm-b', 'Bank A may hide closed shares.', {
      seen: false,
    });
    expect((await promote('bank-a', 'a@1')).ruled).toBe(1);
    expect(await lesson(runner, seen)).toMatchObject({ state: 'confirmed', role: 'system' });
    expect(await ruled(runner, seen)).toEqual(['lessons/confirm (confirm)']);
    expect(await lesson(runner, guess)).toMatchObject({ state: 'proposed', role: 'factory' });
    expect(await ruled(runner, guess)).toEqual([]);
  });

  it('dispute a lesson at one run’s contradiction, and retire it at two', async () => {
    await build('contra-b', 'bank-b', 'b@1');
    const id = await propose(factory, 'contra-b', 'Bank B shows the balance on the first page.');
    for (const r of ['contra-1', 'contra-2']) await run(runner, r, 'bank-b', { outcome: 'failed' });
    expect((await contradict(id, 'contra-1')).status).toBe(201);
    expect(await lesson(runner, id)).toMatchObject({ state: 'disputed' });
    // Said again by the same run, it changes nothing.
    expect((await contradict(id, 'contra-1')).status).toBe(200);
    expect((await contradict(id, 'contra-2')).status).toBe(201);
    expect(await lesson(runner, id)).toMatchObject({ state: 'retired' });
  });

  it('retire a vendor lesson wrong at one bank there only', async () => {
    await build('there-b', 'bank-c', 'c@1');
    const id = await propose(factory, 'there-b', 'The vendor’s search accepts a partial number.', {
      scope: 'vendor',
    });
    for (const r of ['there-1', 'there-2']) {
      await run(runner, r, 'bank-c', { outcome: 'failed' });
      await contradict(id, r);
    }
    expect(await lesson(runner, id)).toMatchObject({
      state: 'disputed',
      scope: 'vendor',
      retiredAtBanks: ['bank-c'],
    });
  });

  it('widen a lesson proven at two banks of a vendor to the vendor', async () => {
    const text = 'Members open from the search results with the Open link.';
    await build('widen-d', 'bank-d', 'd@1');
    const d = await propose(factory, 'widen-d', text);
    await promote('bank-d', 'd@1');
    await build('widen-e', 'bank-e', 'e@1');
    const e = await propose(factory, 'widen-e', text);
    await promote('bank-e', 'e@1');
    expect(await lesson(runner, e)).toMatchObject({
      state: 'confirmed',
      scope: 'vendor',
      vendor: 'corelink',
      bank: null,
    });
    expect(await lesson(runner, d)).toMatchObject({ state: 'retired' });
    expect(await ruled(runner, e)).toEqual([
      'lessons/confirm (confirm)',
      'lessons/confirm (widen)',
    ]);
  });

  it('make a lesson proven at three vendors a pattern candidate, unserved until a person approves', async () => {
    const text = 'A session ends quietly after twenty idle minutes; sign in again.';
    let last = '';
    for (const v of ['alpha', 'beta', 'gamma']) {
      await build(`cand-${v}`, `bank-${v}`, `${v}@1`, v);
      last = await propose(factory, `cand-${v}`, text, { scope: 'vendor' });
      await promote(`bank-${v}`, `${v}@1`, [], v);
    }
    const now = await lesson(runner, last);
    expect(now).toMatchObject({ state: 'confirmed', scope: 'vendor', vendor: 'gamma' });
    const waiting = await lesson(runner, last, now.current + 1);
    expect(waiting).toMatchObject({ scope: 'pattern', vendor: null });
    expect(await ruled(runner, last)).toContain('lessons/confirm (candidate)');
    // A person approves it, and it becomes current.
    expect(
      (
        await curator.post('curated/approve', {
          reason: 'proven at three vendors',
          versions: [{ kind: 'lesson', key: last, version: now.current + 1 }],
        })
      ).status,
    ).toBe(201);
    expect(await lesson(runner, last)).toMatchObject({ scope: 'pattern', state: 'confirmed' });
  });

  it('bring a retired lesson back when a later promoted run relied on it', async () => {
    await build('back-b', 'bank-f', 'f@1');
    const id = await propose(factory, 'back-b', 'Bank F keeps statements under Documents.');
    for (const r of ['back-1', 'back-2']) {
      await run(runner, r, 'bank-f', { outcome: 'failed' });
      await contradict(id, r);
    }
    expect(await lesson(runner, id)).toMatchObject({ state: 'retired' });
    await promote('bank-f', 'f@2', [id]);
    expect(await lesson(runner, id)).toMatchObject({ state: 'confirmed' });
    expect(await ruled(runner, id)).toContain('lessons/confirm (return)');
  });

  it('dispute on a demotion what its driver’s promotion confirmed', async () => {
    await build('demote-b', 'bank-g', 'g@1');
    const id = await propose(factory, 'demote-b', 'Bank G asks for the code by text.');
    await promote('bank-g', 'g@1');
    expect(await lesson(runner, id)).toMatchObject({ state: 'confirmed' });
    await run(runner, 'g@1/fault', 'bank-g', { driver: 'g@1', outcome: 'failed', mark: 'demoted' });
    expect(await lesson(runner, id)).toMatchObject({ state: 'disputed' });
    expect(await ruled(runner, id)).toEqual([
      'lessons/confirm (confirm)',
      'lessons/dispute (demote)',
    ]);
  });
});

describe('facts', () => {
  it('are written only for a successful promotion', async () => {
    await run(runner, 'fact-none', 'bank-h');
    const r = await system.post('facts', {
      runId: 'fact-none',
      facts: [{ predicate: 'code_sent_by', object: 'email' }],
    });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ error: 'no_successful_run' });
  });

  it('as of a past run, are what memory believed then', async () => {
    await promote('bank-h', 'h@1');
    expect(
      (
        await system.post('facts', {
          runId: 'h@1/p2',
          facts: [{ predicate: 'code_sent_by', object: 'email' }],
        })
      ).status,
    ).toBe(201);
    await run(runner, 'fact-between', 'bank-h');
    await promote('bank-h', 'h@2');
    await system.post('facts', {
      runId: 'h@2/p2',
      facts: [{ predicate: 'code_sent_by', object: 'text' }],
    });
    const at = async (q: string) =>
      (
        await runner.get<{ facts: { object: string }[] }>(`/facts/search?bank=bank-h${q}`)
      ).body.facts.map((f) => f.object);
    expect(await at('&asOf=fact-between')).toEqual(['email']);
    expect(await at('')).toEqual(['text']);
  });
});
