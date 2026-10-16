// The memory suite: one door (plan §K.5, §K.11). Every caller holds a token for one role, and each
// role may make only the writes §K.5 gives it; anything else is 403 with nothing written. A write
// must be signed with the key only deterministic code holds, and a caller with no known token is
// 401. All through the Memory service's API.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WRITES, type Write } from '../../apps/memory/src/door.js';
import { type Role, ROLES } from '../../apps/memory/src/memory.js';
import { memoryService } from '../support/memory.js';
import { as, changes, run } from './api.js';

let memory: Awaited<ReturnType<typeof memoryService>>;
beforeAll(async () => {
  memory = await memoryService();
});
afterAll(async () => {
  await memory.close();
});

describe('the role matrix', () => {
  // Plan §K.5, written out here rather than read from the door: box A (the runner) adds episodes
  // and forwards lessons; the factory's agents add episodes and hypotheses, propose lessons and
  // challenge what is held; only memory's own rules confirm and write facts; a person curates and
  // approves, and may retire a lesson or close a fact.
  const MAY: Record<Write, Role[]> = {
    'episodes/runs': ['runner', 'factory'],
    'episodes/attempts': ['runner', 'factory'],
    hypotheses: ['factory'],
    'lessons/proposals': ['runner', 'factory'],
    'lessons/relied-on': ['runner', 'factory'],
    facts: ['system'],
    'facts/invalidate': ['factory', 'curator', 'system'],
    'lessons/confirm': ['system'],
    'lessons/retire': ['curator', 'system'],
    curated: ['curator'],
    'curated/approve': ['curator'],
  };
  const cases = ROLES.flatMap((role) =>
    (Object.keys(MAY) as Write[]).map((write) => ({
      role,
      write,
      allowed: MAY[write].includes(role),
    })),
  );

  it('covers every write the door knows', () => {
    expect(Object.keys(MAY).sort()).toEqual(Object.keys(WRITES).sort());
  });

  it.each(cases)('$role writing $write: allowed $allowed', async ({ role, write, allowed }) => {
    const c = as(memory.url, role);
    const before = await changes(c);
    // An empty body: the door decides before the write reads it.
    const r = await c.post(write, {});
    if (allowed) expect([401, 403]).not.toContain(r.status);
    else {
      expect(r.status).toBe(403);
      expect(r.body).toMatchObject({ error: 'role_forbidden' });
      expect(await changes(c)).toBe(before);
    }
  });

  it('lets each role’s own write through, and records it', async () => {
    const runner = as(memory.url, 'runner');
    const before = await changes(runner);
    expect((await run(runner, 'roles-1', 'generic')).status).toBe(201);
    expect(await changes(runner)).toBe(before + 1);
  });
});

describe('the door', () => {
  it('is 401 with no token or an unknown one, for reads and writes', async () => {
    const nobody = as(memory.url, null);
    expect((await nobody.get('/history')).status).toBe(401);
    expect((await nobody.post('episodes/runs', {})).status).toBe(401);
    const unknown = await fetch(`${memory.url}/history`, {
      headers: { authorization: `Bearer ${'x'.repeat(40)}` },
    });
    expect(unknown.status).toBe(401);
  });

  it('is 403 for a write unsigned or signed with another key, and nothing is written', async () => {
    const runner = as(memory.url, 'runner');
    const before = await changes(runner);
    for (const key of [null, 'z'.repeat(40)]) {
      const r = await runner.post(
        'episodes/runs',
        {
          id: 'roles-unsigned',
          kind: 'task',
          bank: 'generic',
          outcome: 'succeeded',
          startedAt: new Date(),
        },
        { key },
      );
      expect(r.status).toBe(403);
      expect(r.body).toMatchObject({ error: 'role_forbidden', message: 'the write is not signed' });
    }
    expect(await changes(runner)).toBe(before);
  });

  it('reports itself alive without a token', async () => {
    expect((await as(memory.url, null).get('/healthz')).body).toMatchObject({
      ok: true,
      database: 'up',
      readOnly: false,
    });
  });
});
