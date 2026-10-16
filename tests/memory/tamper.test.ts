// The memory suite: a tampered change log (plan §K.3, §K.11). Every write appends a row chained by
// hash to the one before; someone who changes a row in the database, outside the door, breaks the
// chain at that row. Memory says where, and refuses every write until a person looks. Through the
// Memory service's API, but for the tampering itself, which is the attack.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { memoryService } from '../support/memory.js';
import { as, type Caller, run } from './api.js';

let memory: Awaited<ReturnType<typeof memoryService>>;
let runner: Caller;
beforeAll(async () => {
  memory = await memoryService();
  runner = as(memory.url, 'runner');
  for (const id of ['t-1', 't-2', 't-3']) await run(runner, id, 'generic');
});
afterAll(async () => {
  await memory.close();
});

describe('a tampered change log', () => {
  it('verifies while untouched', async () => {
    expect((await runner.get('/history/verify')).body).toEqual({ ok: true, rows: 3 });
  });

  it('fails verification at the row changed, and memory refuses every write after', async () => {
    const [second] = (await runner.get<{ changes: { seq: number }[] }>('/history?run=t-2')).body
      .changes;
    await memory.db.query(
      `UPDATE "ChangeLog" SET data = jsonb_set(data, '{bank}', '"elsewhere"') WHERE seq = $1`,
      [second!.seq],
    );
    expect((await runner.get('/history/verify')).body).toEqual({
      ok: false,
      rows: 3,
      brokenAt: second!.seq,
    });
    const r = await run(runner, 't-4', 'generic');
    expect(r.status).toBe(503);
    expect(r.body).toEqual({ error: 'read_only' });
    expect((await runner.get('/healthz')).body).toMatchObject({ readOnly: true });
    // Reads still answer, so a person can look.
    expect((await runner.get('/history?run=t-1')).status).toBe(200);
  });
});
