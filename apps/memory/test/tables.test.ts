// Memory's tables and its change log: the migration on an empty database, every write with its
// change-log row in one transaction, and a chain that names the first row someone changed.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openMemory, ReadOnly, type Memory, type Verdict } from '../src/memory.js';
import { buildServer } from '../src/server.js';
import { emptyDb, memoryDb, MIGRATIONS, migrations, testDoor, TOKENS } from './db.js';

type TestDb = Awaited<ReturnType<typeof memoryDb>>;

const recordRun = (memory: Memory, id: string, bank = 'generic') =>
  memory.write('runner', 'episodes/runs', async (tx) => {
    await tx.query(
      `INSERT INTO "Run" (id, kind, bank, outcome, "startedAt") VALUES ($1, 'task', $2, 'succeeded', $3)`,
      [id, bank, new Date('2026-01-02T03:04:05.678Z')],
    );
    return { entity: 'Run', entityId: id, runId: id, data: { bank, outcome: 'succeeded' } };
  });

const count = async (db: TestDb, table: string) =>
  Number((await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM "${table}"`)).rows[0]!.n);

describe('the memory migration', () => {
  it('applies to an empty memory database', async () => {
    const pg = emptyDb();
    for (const m of migrations())
      await pg.exec(readFileSync(join(MIGRATIONS, m, 'migration.sql'), 'utf8'));
    const tables = await pg.query<{ t: string }>(
      `SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1`,
    );
    expect(tables.rows.map((r) => r.t)).toEqual(
      expect.arrayContaining([
        'Run',
        'Attempt',
        'Hypothesis',
        'Fact',
        'Lesson',
        'LessonVersion',
        'CatalogEntry',
        'CatalogVersion',
        'ChangeLog',
      ]),
    );

    // An attempt cannot exist without its run.
    await expect(
      pg.query(
        `INSERT INTO "Attempt" ("runId", n, outcome, at) VALUES ('none', 1, 'failed', now())`,
      ),
    ).rejects.toThrow(/foreign key/);

    // A fact is bi-temporal: when it held at the bank, and when memory believed it.
    await pg.exec(
      `INSERT INTO "Run" (id, kind, bank, outcome, "startedAt", mark) VALUES ('r1', 'factory', 'generic', 'succeeded', now(), 'promoted');
       INSERT INTO "Fact" (bank, predicate, object, "runId", "validAt", "invalidAt", "expiredAt")
         VALUES ('generic', 'has_screen', 'transfer.review', 'r1', now(), now(), now())`,
    );

    // The embedding is a pgvector column of 384 dimensions, searchable by distance.
    const at = (i: number) =>
      `[${Array.from({ length: 384 }, (_, j) => (j === i ? 1 : 0)).join(',')}]`;
    await pg.exec(`INSERT INTO "Lesson" (id) VALUES ('L-1'), ('L-2')`);
    for (const [id, i] of [
      ['L-1', 0],
      ['L-2', 1],
    ] as const)
      await pg.query(
        `INSERT INTO "LessonVersion" ("lessonId", version, text, area, scope, state, confidence, seen, evidence, role, embedding)
         VALUES ($1, 1, 'Advice.', 'sign-in', 'pattern', 'confirmed', 'medium', false, '[]', 'curator', $2::vector)`,
        [id, at(i)],
      );
    const near = await pg.query<{ lessonId: string }>(
      `SELECT "lessonId" FROM "LessonVersion" ORDER BY embedding <=> $1::vector LIMIT 1`,
      [at(1)],
    );
    expect(near.rows[0]!.lessonId).toBe('L-2');
    await expect(
      pg.query(`UPDATE "LessonVersion" SET embedding = '[1,2,3]'::vector WHERE "lessonId" = 'L-1'`),
    ).rejects.toThrow(/384/);
    await pg.close();
  });
});

describe('the change log', () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await memoryDb();
  });
  afterAll(() => db.close());

  it('commits each write with its row, or neither', async () => {
    const memory = openMemory(db);
    const c = await recordRun(memory, 'run-1');
    expect(c).toMatchObject({ seq: 1, role: 'runner', action: 'episodes/runs', entity: 'Run' });
    expect(c.prevHash).toBe('0'.repeat(64));

    await expect(
      memory.write('runner', 'episodes/runs', async (tx) => {
        await tx.query(
          `INSERT INTO "Run" (id, kind, bank, outcome, "startedAt") VALUES ('run-x', 'task', 'generic', 'failed', now())`,
        );
        throw new Error('the write fails after its insert');
      }),
    ).rejects.toThrow('the write fails');
    expect(await count(db, 'Run')).toBe(1);
    expect(await count(db, 'ChangeLog')).toBe(1);

    const d = await recordRun(memory, 'run-2');
    expect(d).toMatchObject({ seq: 2, prevHash: c.hash });
    expect(await memory.verify()).toEqual({ ok: true, rows: 2 });
  });

  it('breaks verification at any row that changes, and refuses the next write', async () => {
    const setup = openMemory(db);
    await recordRun(setup, 'run-3');
    await recordRun(setup, 'run-4');
    const rows = await count(db, 'ChangeLog');
    expect(rows).toBe(4);

    for (let seq = 1; seq <= rows; seq++) {
      const before = (
        await db.query<{ data: unknown }>(`SELECT data FROM "ChangeLog" WHERE seq = $1`, [seq])
      ).rows[0]!.data;
      await db.query(
        `UPDATE "ChangeLog" SET data = jsonb_set(data, '{outcome}', '"failed"') WHERE seq = $1`,
        [seq],
      );
      const broken: Verdict[] = [];
      const memory = openMemory(db, { onBroken: (v) => broken.push(v) });
      expect(await memory.verify()).toEqual({ ok: false, rows, brokenAt: seq });
      expect(broken).toHaveLength(1);
      expect(memory.readOnly).toBe(true);
      await expect(recordRun(memory, `run-after-${seq}`)).rejects.toBeInstanceOf(ReadOnly);
      expect(await count(db, 'Run')).toBe(4);
      expect(await count(db, 'ChangeLog')).toBe(rows);
      await db.query(`UPDATE "ChangeLog" SET data = $1::jsonb WHERE seq = $2`, [
        JSON.stringify(before),
        seq,
      ]);
    }
    expect(await openMemory(db).verify()).toEqual({ ok: true, rows });
  });

  it('covers every column of a row', async () => {
    const changes: Record<string, string> = {
      seq: `seq = 100`,
      at: `at = at + interval '1 millisecond'`,
      role: `role = 'system'`,
      action: `action = 'lessons/confirm'`,
      entity: `entity = 'Fact'`,
      entityId: `"entityId" = 'run-9'`,
      runId: `"runId" = NULL`,
      data: `data = '{}'`,
      prevHash: `"prevHash" = repeat('1', 64)`,
      hash: `hash = repeat('2', 64)`,
    };
    for (const [column, set] of Object.entries(changes)) {
      await db.pg.exec('BEGIN');
      await db.query(`UPDATE "ChangeLog" SET ${set} WHERE seq = 2`);
      expect(await openMemory(db).verify(), column).toMatchObject({ ok: false, brokenAt: 2 });
      await db.pg.exec('ROLLBACK');
    }
    expect(await openMemory(db).verify()).toEqual({ ok: true, rows: 4 });
  });

  it('serves the history and its verification', async () => {
    const memory = openMemory(db);
    const app = buildServer({ db, memory, door: testDoor() });
    const get = (url: string) =>
      app.inject({ url, headers: { authorization: `Bearer ${TOKENS.curator}` } });
    const one = await get('/history?entity=Run&id=run-2');
    expect(one.json().changes).toEqual([
      expect.objectContaining({ seq: 2, entity: 'Run', entityId: 'run-2', runId: 'run-2' }),
    ]);
    const all = await get('/history?since=2000-01-01T00:00:00Z&limit=3');
    expect(all.json().changes.map((c: { seq: number }) => c.seq)).toEqual([1, 2, 3]);
    expect((await get('/history?limit=0')).statusCode).toBe(400);

    expect((await get('/history/verify')).json()).toEqual({ ok: true, rows: 4 });
    expect((await app.inject({ url: '/healthz' })).json()).toMatchObject({ readOnly: false });
    await db.query(`UPDATE "ChangeLog" SET action = 'facts' WHERE seq = 3`);
    expect((await get('/history/verify')).json()).toEqual({
      ok: false,
      rows: 4,
      brokenAt: 3,
    });
    expect((await app.inject({ url: '/healthz' })).json()).toMatchObject({ readOnly: true });
    await app.close();
  });
});
