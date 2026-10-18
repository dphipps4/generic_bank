// The rules and facts (plan §8, §A.6): each rule, set off by stored episodes alone, leaves
// the versions and change-log rows the plan gives it; facts need a successful promotion, and a
// search as of a past run returns what memory believed then.
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { catalogRoutes, curated } from '../src/curated.js';
import { episodes } from '../src/episodes.js';
import { factRoutes, facts } from '../src/facts.js';
import { knowledgeRoutes } from '../src/knowledge.js';
import { openMemory, type Role } from '../src/memory.js';
import { buildServer } from '../src/server.js';
import { memoryDb, signedPost, testDoor, testEmbed, TOKENS } from './db.js';

let db: Awaited<ReturnType<typeof memoryDb>>;
let app: ReturnType<typeof buildServer>;

beforeAll(async () => {
  db = await memoryDb();
  const memory = openMemory(db);
  const writes = {
    ...episodes(memory, testEmbed),
    ...curated(memory, testEmbed),
    ...facts(memory),
  };
  app = buildServer({ db, memory, door: testDoor(), writes });
  catalogRoutes(app, db);
  knowledgeRoutes(app, db, testEmbed);
  factRoutes(app, db);
});
afterAll(async () => {
  await app.close();
  await db.close();
});

const HASH = 'ab'.repeat(32);

const send = (write: string, body: unknown, role: Role) => signedPost(app, write, body, role);
const post = async (write: string, body: unknown, role: Role = 'factory') => {
  const r = await send(write, body, role);
  expect(r.statusCode, JSON.stringify(r.json())).toBeLessThan(300);
  return r.json() as Record<string, unknown>;
};
const get = async (url: string) =>
  (
    await app.inject({ url, headers: { authorization: `Bearer ${TOKENS.runner}` } })
  ).json() as Record<string, unknown>;

const count = async (table: string) =>
  (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM "${table}"`)).rows[0]!.n;

/** A run, recorded now. A task run is a probation run when it carries a driver. */
const run = async (id: string, bank: string, extra: Record<string, unknown> = {}) =>
  post(
    'episodes/runs',
    {
      id,
      kind: 'task',
      bank,
      vendor: 'corelink',
      outcome: 'succeeded',
      startedAt: new Date().toISOString(),
      ...extra,
    },
    'runner',
  );

const propose = async (runId: string, text: string, scope = 'tenant', seen = true) =>
  (
    await post('lessons/proposals', {
      runId,
      text,
      area: 'statements',
      scope,
      confidence: 'medium',
      seen,
      frames: [`${runId}/001`],
      evidenceHash: HASH,
    })
  ).lesson as string;

const rely = (runId: string, lessonIds: string[]) =>
  post('lessons/relied-on', { runId, lessonIds }, 'runner');

const contradiction = (
  lessonId: string,
  runId: string,
  reason = 'the list sorted the other way',
) => ({
  lessonId,
  runId,
  reason,
  frames: [`${runId}/002`],
  evidenceHash: HASH,
});

/** Two clean probation runs of a driver, the second promoting it, each relying on `relied`. */
async function promote(bank: string, driver: string, relied: string[] = [], vendor = 'corelink') {
  await run(`${driver}/p1`, bank, { driver, vendor });
  if (relied.length) await rely(`${driver}/p1`, relied);
  return run(`${driver}/p2`, bank, { driver, vendor, mark: 'promoted' });
}

const versions = async (id: string) =>
  (
    await db.query<Record<string, unknown>>(
      `SELECT version, state::text AS state, scope::text AS scope, bank, vendor, "retiredAtBanks",
         role::text AS role, "runId", reason, text, evidence
       FROM "LessonVersion" WHERE "lessonId" = $1 ORDER BY version`,
      [id],
    )
  ).rows;
const current = async (id: string) =>
  (await db.query<{ current: number }>(`SELECT current FROM "Lesson" WHERE id = $1`, [id])).rows[0]!
    .current;
const served = async (id: string) => (await versions(id))[(await current(id)) - 1]!;

/** The change-log rows a run's write left, after the run's own. */
const ruled = async (runId: string) =>
  (
    await db.query<{
      role: string;
      action: string;
      entityId: string;
      data: Record<string, unknown>;
    }>(
      `SELECT role::text AS role, action, "entityId", data FROM "ChangeLog"
       WHERE "runId" = $1 AND action <> 'episodes/runs' ORDER BY seq`,
      [runId],
    )
  ).rows;

describe('a promotion', () => {
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    await run('build-ex', 'example', { kind: 'factory', driver: 'ex@1' });
    ids.seen = await propose('build-ex', 'Example lists statements newest first, twelve per page.');
    ids.guess = await propose(
      'build-ex',
      'Example may hide closed accounts behind a toggle.',
      'tenant',
      false,
    );
    ids.reliedGuess = await propose(
      'build-ex',
      'Example names the statements tab Documents.',
      'tenant',
      false,
    );
    ids.pattern = await propose(
      'build-ex',
      'Every console marks the focused frame in grey.',
      'pattern',
    );
    ids.vendor = await propose(
      'build-ex',
      'CoreLink opens each statement in a popup window.',
      'vendor',
    );
    await run('ex@1/p1', 'example', { driver: 'ex@1' });
    await rely('ex@1/p1', [ids.reliedGuess]);
  });

  it('confirms what its probation runs saw or relied on, and leaves a guess a guess', async () => {
    const r = await run('ex@1/p2', 'example', { driver: 'ex@1', mark: 'promoted' });
    expect(r).toMatchObject({ ruled: 4 });

    for (const id of [ids.seen!, ids.reliedGuess!, ids.vendor!])
      expect(await served(id)).toMatchObject({
        version: 2,
        state: 'confirmed',
        role: 'system',
        runId: 'ex@1/p2',
        reason: 'its probation runs bore it out',
      });
    expect(await versions(ids.guess!)).toEqual([expect.objectContaining({ state: 'proposed' })]);

    // A pattern only a person can approve: confirmed, but waiting, unserved.
    expect(await current(ids.pattern!)).toBe(1);
    expect((await versions(ids.pattern!))[1]).toMatchObject({
      version: 2,
      state: 'confirmed',
      scope: 'pattern',
      role: 'system',
      reason: 'a promoted run proved it: a pattern candidate, waiting for a person',
    });

    expect(await ruled('ex@1/p2')).toEqual(
      [
        [ids.seen, 'confirm'],
        [ids.reliedGuess, 'confirm'],
        [ids.pattern, 'candidate'],
        [ids.vendor, 'confirm'],
      ]
        .sort(([a], [b]) => (a! < b! ? -1 : 1))
        .map(([id, rule]) => ({
          role: 'system',
          action: 'lessons/confirm',
          entityId: id,
          data: expect.objectContaining({ rule }),
        })),
    );
  });

  it('is applied again only for what arrived since, and refused when memory cannot bear it out', async () => {
    const before = await count('ChangeLog');
    const again = await post('lessons/confirm', { runId: 'ex@1/p2' }, 'system');
    expect(again).toMatchObject({ written: false, changes: [] });
    expect(await count('ChangeLog')).toBe(before);

    // A promotion resting on one clean run is not borne out: it is recorded, and nothing else.
    await run('build-solo', 'solo', { kind: 'factory', driver: 'solo@1' });
    const late = await propose('build-solo', 'Solo asks for the member number twice.');
    expect(await run('solo@1/p2', 'solo', { driver: 'solo@1', mark: 'promoted' })).toMatchObject({
      ruled: 0,
    });
    const refused = await send('lessons/confirm', { runId: 'solo@1/p2' }, 'system');
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ error: 'no_successful_run' });

    // Once memory holds the second clean run, the rules confirm what it proves.
    await run('solo@1/p1', 'solo', { driver: 'solo@1' });
    const now = await post('lessons/confirm', { runId: 'solo@1/p2' }, 'system');
    expect(now).toMatchObject({ written: true, changes: [{ lesson: late, rule: 'confirm' }] });
    expect(await served(late)).toMatchObject({ state: 'confirmed', runId: 'solo@1/p2' });
    expect((await send('lessons/confirm', { runId: 'solo@1/p2' }, 'factory')).statusCode).toBe(403);
  });

  it('a demotion disputes what its driver’s promotion confirmed, and nothing else', async () => {
    const curatedBefore = await count('LessonVersion');
    const r = await run('ex@1/d', 'example', {
      driver: 'ex@1',
      mark: 'demoted',
      outcome: 'failed',
    });
    expect(r).toMatchObject({ ruled: 3 });
    for (const id of [ids.seen!, ids.reliedGuess!, ids.vendor!])
      expect(await served(id)).toMatchObject({
        version: 3,
        state: 'disputed',
        role: 'system',
        runId: 'ex@1/d',
        reason: 'the driver whose promotion confirmed it was demoted',
      });
    expect(await count('LessonVersion')).toBe(curatedBefore + 3);
    expect(await current(ids.pattern!)).toBe(1);
    expect((await ruled('ex@1/d')).map((c) => [c.action, c.data.rule])).toEqual([
      ['lessons/dispute', 'demote'],
      ['lessons/dispute', 'demote'],
      ['lessons/dispute', 'demote'],
    ]);
  });
});

describe('contradictions', () => {
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    await run('c-gen', 'generic');
    await run('c-ex', 'example');
    for (const id of ['x1', 'x2', 'x3']) await run(id, 'example', { outcome: 'failed' });
    await run('g1', 'generic', { outcome: 'failed' });
    ids.tenant = await propose('c-ex', 'Example puts the balance in the third column.');
    ids.vendor = await propose(
      'c-gen',
      'CoreLink shows the member name above the accounts.',
      'vendor',
    );
  });

  it('one run disputes a lesson; the same run again changes nothing; a second retires it', async () => {
    const one = await post('facts/invalidate', contradiction(ids.tenant!, 'x1'));
    expect(one).toMatchObject({ written: true, rule: 'dispute', state: 'disputed', against: 1 });
    expect(await served(ids.tenant!)).toMatchObject({
      version: 2,
      state: 'disputed',
      role: 'factory',
      runId: 'x1',
      reason: 'the list sorted the other way',
    });
    // Still served, with its reason.
    const pack = (await get('/knowledge/pack?bank=example&vendor=corelink')) as {
      tiers: { disputed: { id: string; label: string }[] };
    };
    expect(pack.tiers.disputed).toContainEqual(
      expect.objectContaining({ id: ids.tenant, label: 'disputed: the list sorted the other way' }),
    );

    const before = await count('ChangeLog');
    const again = await send('facts/invalidate', contradiction(ids.tenant!, 'x1'), 'factory');
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ written: false });
    expect(await count('ChangeLog')).toBe(before);

    expect(await post('facts/invalidate', contradiction(ids.tenant!, 'x2'))).toMatchObject({
      rule: 'retire',
      state: 'retired',
      against: 2,
    });
    const last = await served(ids.tenant!);
    expect(last).toMatchObject({ version: 3, state: 'retired' });
    expect(
      (last.evidence as { run: string; contradicts?: boolean }[]).filter((c) => c.contradicts),
    ).toHaveLength(2);
  });

  it('retires a lesson wrong at one bank there only, and everywhere once a second bank says so', async () => {
    await post('facts/invalidate', contradiction(ids.vendor!, 'x1'));
    expect(await post('facts/invalidate', contradiction(ids.vendor!, 'x2'))).toMatchObject({
      rule: 'retire at the bank',
      state: 'disputed',
    });
    expect(await served(ids.vendor!)).toMatchObject({
      state: 'disputed',
      retiredAtBanks: ['example'],
    });
    const at = async (bank: string) =>
      JSON.stringify(await get(`/knowledge/pack?bank=${bank}&vendor=corelink`)).includes(
        ids.vendor!,
      );
    expect(await at('example')).toBe(false);
    expect(await at('generic')).toBe(true);

    expect(await post('facts/invalidate', contradiction(ids.vendor!, 'g1'))).toMatchObject({
      rule: 'retire',
      state: 'retired',
    });
    expect(await at('generic')).toBe(false);
  });

  it('needs the frames that show it, and a lesson memory holds', async () => {
    const { frames: _, ...bare } = contradiction(ids.tenant!, 'x3');
    expect((await send('facts/invalidate', bare, 'factory')).statusCode).toBe(400);
    const none = await send('facts/invalidate', contradiction('L-none', 'x3'), 'factory');
    expect(none.statusCode).toBe(409);
  });
});

describe('a later promotion', () => {
  it('retires at its bank what its probation runs contradicted', async () => {
    await run('build-r', 'example', { kind: 'factory', driver: 'ex@2' });
    const wrong = await propose(
      'build-r',
      'CoreLink keeps the sign-out link in the banner.',
      'vendor',
    );
    await run('ex@2/p1', 'example', { driver: 'ex@2', outcome: 'succeeded' });
    await post(
      'facts/invalidate',
      contradiction(wrong, 'ex@2/p1', 'the link sat in the nav frame'),
    );
    expect(await served(wrong)).toMatchObject({ state: 'disputed' });
    await run('ex@2/p2', 'example', { driver: 'ex@2', mark: 'promoted' });
    expect(await served(wrong)).toMatchObject({
      state: 'disputed',
      retiredAtBanks: ['example'],
      role: 'system',
    });
    expect((await ruled('ex@2/p2')).map((c) => c.data.rule)).toEqual(['retire at the bank']);
  });

  it('brings back a retired lesson its runs relied on', async () => {
    await run('build-b', 'generic', { kind: 'factory' });
    const back = await propose('build-b', 'Generic confirms a transfer on a second review page.');
    const here = await propose(
      'build-b',
      'CoreLink pads short member numbers with zeros.',
      'vendor',
    );
    await post('lessons/retire', { lessonId: back, reason: 'it looked wrong' }, 'curator');
    await post(
      'lessons/retire',
      { lessonId: here, reason: 'wrong here', bank: 'generic' },
      'curator',
    );
    expect(await served(back)).toMatchObject({ state: 'retired', role: 'curator' });
    expect(await served(here)).toMatchObject({ state: 'proposed', retiredAtBanks: ['generic'] });
    // Retired again, it changes nothing.
    expect(
      await post('lessons/retire', { lessonId: back, reason: 'still wrong' }, 'curator'),
    ).toMatchObject({ written: false });

    await sleep(5);
    await promote('generic', 'gen@2', [back, here]);
    expect(await served(back)).toMatchObject({
      state: 'confirmed',
      reason: 'a later promoted run relied on it',
    });
    expect(await served(here)).toMatchObject({ state: 'confirmed', retiredAtBanks: [] });
    expect((await ruled('gen@2/p2')).map((c) => c.data.rule)).toEqual(['return', 'return']);
  });
});

describe('widening', () => {
  const SAME = 'Statements open only after the member is selected again.';

  it('widens a tenant lesson proven at two banks of the vendor', async () => {
    await run('w-gen', 'generic', { kind: 'factory' });
    await run('w-ex', 'example', { kind: 'factory' });
    const atGeneric = await propose('w-gen', SAME);
    const atExample = await propose('w-ex', SAME);
    expect(atGeneric).not.toBe(atExample);

    await promote('generic', 'gen@3', [atGeneric]);
    expect(await served(atGeneric)).toMatchObject({ state: 'confirmed', scope: 'tenant' });
    await promote('example', 'ex@3', [atExample]);

    expect(await served(atExample)).toMatchObject({
      state: 'confirmed',
      scope: 'vendor',
      bank: null,
      vendor: 'corelink',
      reason: 'proven at 2 banks of the vendor',
    });
    expect(
      ((await served(atExample)).evidence as { run: string }[]).map((c) => c.run).sort(),
    ).toEqual(['w-ex', 'w-gen']);
    expect(await served(atGeneric)).toMatchObject({ state: 'retired', scope: 'tenant' });
    expect((await ruled('ex@3/p2')).map((c) => [c.entityId, c.data.rule])).toEqual([
      [atExample, 'confirm'],
      [atGeneric, 'widened'],
      [atExample, 'widen'],
    ]);
  });

  it('makes a lesson proven at three vendors a pattern candidate that waits for a person', async () => {
    const ADVICE = 'Read the totals row only after every page of the list is loaded.';
    const ids: string[] = [];
    for (const vendor of ['corelink', 'northwind', 'contoso']) {
      await run(`v-${vendor}`, `bank-${vendor}`, { kind: 'factory', vendor });
      ids.push(await propose(`v-${vendor}`, ADVICE, 'vendor'));
      await promote(`bank-${vendor}`, `${vendor}@1`, [ids.at(-1)!], vendor);
    }
    const last = ids.at(-1)!;
    expect(await served(last)).toMatchObject({
      state: 'confirmed',
      scope: 'vendor',
      vendor: 'contoso',
    });
    const all = await versions(last);
    expect(all.at(-1)).toMatchObject({
      version: (await current(last)) + 1,
      state: 'confirmed',
      scope: 'pattern',
      vendor: null,
      reason: 'proven at 3 vendors: a pattern candidate, waiting for a person',
    });
    expect((await ruled('contoso@1/p2')).map((c) => c.data.rule)).toEqual(['confirm', 'candidate']);

    // Unserved until a person approves it.
    const pattern = async () =>
      JSON.stringify(await get('/knowledge/pack?bank=elsewhere')).includes(last);
    expect(await pattern()).toBe(false);
    await post(
      'curated/approve',
      {
        reason: 'reviewed',
        versions: [{ kind: 'lesson', key: last, version: all.at(-1)!.version }],
      },
      'curator',
    );
    expect(await pattern()).toBe(true);
  });
});

describe('a near-duplicate and a version waiting for approval', () => {
  it('builds on the served version and carries the waiting one above it, still waiting', async () => {
    const TEXT = 'Example shows the transfer review on its own page.';
    const key = 'L-curated-wait';
    const lesson = { area: 'transfers', scope: 'tenant', bank: 'example', confidence: 'high' };
    await post(
      'curated',
      { kind: 'lesson', key, lesson: { ...lesson, text: TEXT }, reason: 'first' },
      'curator',
    );
    await post(
      'curated/approve',
      { reason: 'ok', versions: [{ kind: 'lesson', key, version: 1 }] },
      'curator',
    );
    const edit = 'Example shows the transfer review on a separate page, with a Confirm image.';
    await post(
      'curated',
      { kind: 'lesson', key, lesson: { ...lesson, text: edit }, reason: 'clearer' },
      'curator',
    );
    expect(await current(key)).toBe(1);

    await run('dup-ex', 'example', { kind: 'factory' });
    const merged = await post('lessons/proposals', {
      runId: 'dup-ex',
      text: TEXT,
      area: 'transfers',
      scope: 'tenant',
      confidence: 'low',
      seen: true,
      frames: ['dup-ex/004'],
      evidenceHash: HASH,
    });
    expect(merged).toMatchObject({ lesson: key, version: 3, merged: true });

    const all = await versions(key);
    expect(await current(key)).toBe(3);
    expect(all.map((v) => [v.version, v.text, v.role])).toEqual([
      [1, TEXT, 'curator'],
      [2, edit, 'curator'],
      [3, TEXT, 'factory'],
      [4, edit, 'curator'],
    ]);
    // The waiting version rests on the merged evidence, and is the one a person approves.
    expect((all[3]!.evidence as { run: string }[]).map((c) => c.run)).toEqual(['dup-ex']);
    const backward = await send(
      'curated/approve',
      { reason: 'ok', versions: [{ kind: 'lesson', key, version: 2 }] },
      'curator',
    );
    expect(backward.json()).toMatchObject({ error: 'backward' });
    await post(
      'curated/approve',
      { reason: 'ok', versions: [{ kind: 'lesson', key, version: 4 }] },
      'curator',
    );
    expect(await served(key)).toMatchObject({ text: edit, state: 'confirmed' });
  });
});

describe('facts', () => {
  const screens = [
    { predicate: 'has_screen', object: 'statements.list' },
    { predicate: 'has_screen', object: 'transfer.review' },
    { predicate: 'code_sent_by', object: 'email' },
  ];
  type Fact = { id: string; predicate: string; object: string };
  const search = async (query: string) =>
    ((await get(`/facts/search?${query}`)) as { facts: Fact[] }).facts
      .map((f) => `${f.predicate} ${f.object}`)
      .sort();

  it('needs a successful promotion that memory’s records bear out', async () => {
    await run('f-fail', 'factsbank', { outcome: 'failed', driver: 'fb@0', mark: 'promoted' });
    await run('f-plain', 'factsbank');
    const before = await count('Fact');
    for (const runId of ['f-fail', 'f-plain', 'f-none']) {
      const r = await send('facts', { runId, facts: screens }, 'system');
      expect(r.statusCode, runId).toBe(409);
    }
    expect(await count('Fact')).toBe(before);
    expect((await send('facts', { runId: 'f-plain', facts: screens }, 'factory')).statusCode).toBe(
      403,
    );
    const bad = await send(
      'facts',
      { runId: 'f-plain', facts: [{ predicate: 'likes', object: 'tea' }] },
      'system',
    );
    expect(bad.statusCode).toBe(400);
    const notScreen = await send(
      'facts',
      { runId: 'f-plain', facts: [{ predicate: 'has_screen', object: 'Transfer Review' }] },
      'system',
    );
    expect(notScreen.statusCode).toBe(400);
  });

  it('holds each fact once, closes what a new value replaces, and answers as of a past run', async () => {
    await run('asof-1', 'factsbank');
    await sleep(5);
    await promote('factsbank', 'fb@1');
    const w = await post('facts', { runId: 'fb@1/p2', facts: screens }, 'system');
    expect(w).toMatchObject({ written: true, closed: [] });
    expect(w.added).toHaveLength(3);
    expect(await post('facts', { runId: 'fb@1/p2', facts: screens }, 'system')).toMatchObject({
      written: false,
      added: [],
    });
    expect(
      (await db.query(`SELECT role::text AS role, action FROM "ChangeLog" WHERE action = 'facts'`))
        .rows,
    ).toEqual([
      { role: 'system', action: 'facts' },
      { role: 'system', action: 'facts' },
      { role: 'system', action: 'facts' },
    ]);
    await sleep(5);
    await run('asof-2', 'factsbank');
    await sleep(5);

    // The code now comes by text: the email fact is closed. A failed run there closes a screen.
    await promote('factsbank', 'fb@2');
    const replaced = await post(
      'facts',
      { runId: 'fb@2/p2', facts: [{ predicate: 'code_sent_by', object: 'text' }] },
      'system',
    );
    expect(replaced.closed).toHaveLength(1);
    const review = ((await get('/facts?bank=factsbank')) as { facts: Fact[] }).facts.find(
      (f) => f.object === 'transfer.review',
    )!;
    await run('f-broke', 'factsbank', { outcome: 'failed' });
    expect(
      (
        await send(
          'facts/invalidate',
          { factId: review.id, runId: 'fb@2/p2', reason: 'gone' },
          'factory',
        )
      ).statusCode,
    ).toBe(409);
    expect(
      (await send('facts/invalidate', { factId: review.id, reason: 'gone' }, 'factory')).statusCode,
    ).toBe(409);
    expect(
      await post('facts/invalidate', {
        factId: review.id,
        runId: 'f-broke',
        reason: 'the page is gone',
      }),
    ).toMatchObject({ written: true });
    expect(
      (await db.query(`SELECT "invalidAt", "expiredAt" FROM "Fact" WHERE id = $1`, [review.id]))
        .rows[0],
    ).toMatchObject({ invalidAt: expect.any(Date), expiredAt: expect.any(Date) });
    await sleep(5);
    await run('asof-3', 'factsbank');

    expect(await search('bank=factsbank&asOf=asof-1')).toEqual([]);
    expect(await search('bank=factsbank&asOf=asof-2')).toEqual([
      'code_sent_by email',
      'has_screen statements.list',
      'has_screen transfer.review',
    ]);
    const now = ['code_sent_by text', 'has_screen statements.list'];
    expect(await search('bank=factsbank&asOf=asof-3')).toEqual(now);
    expect(await search('bank=factsbank')).toEqual(now);
    expect(await search('bank=factsbank&q=statements')).toEqual(['has_screen statements.list']);
    expect(await search('bank=factsbank&asOf=asof-2&predicate=code_sent_by')).toEqual([
      'code_sent_by email',
    ]);

    // A person may close a fact with a reason alone.
    const list = ((await get('/facts?bank=factsbank')) as { facts: Fact[] }).facts[0]!;
    expect(
      await post('facts/invalidate', { factId: list.id, reason: 'the bank retired it' }, 'curator'),
    ).toMatchObject({ written: true });
    expect(
      await post('facts/invalidate', { factId: list.id, reason: 'again' }, 'curator'),
    ).toMatchObject({
      written: false,
    });

    // The pack holds the bank's facts as known.
    const pack = (await get('/knowledge/pack?bank=factsbank')) as { tiers: { facts: Fact[] } };
    expect(pack.tiers.facts.map((f) => `${f.predicate} ${f.object}`)).toEqual([
      'has_screen statements.list',
    ]);
  });
});

describe('the change log', () => {
  it('verifies after every rule', async () => {
    expect(await get('/history/verify')).toMatchObject({ ok: true });
  });
});
