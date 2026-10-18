// The factory reads and writes memory (plan §A.6, §7): no pack, no run; `record_lesson` keeps a
// lesson only when it cites frames of this run, and the Scout cannot call it; at the run's end the
// lessons reach memory as proposals, with the served lessons the run relied on and contradicted.
// The models are fake fetches behind the real gateway, and memory is the real service over HTTP.
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { controlDb } from '../../../packages/oauth/test/control.js';
import { memoryService } from '../../../tests/support/memory.js';
import { gateway } from '../src/gateway.js';
import { sqlLedger } from '../src/ledger.js';
import {
  type Lesson,
  memoryClient,
  memoryQueryTool,
  recordLessonTool,
  sendLearned,
  servedBy,
  writeLessons,
} from '../src/memory.js';
import { type Role } from '../src/models.js';
import { DEFAULT_ROLES } from './fakes.js';
import { buildServer } from '../src/server.js';
import { refusal, toolsOf } from '../src/tools.js';
import type { Shown, Trail } from '../src/trail.js';
import { live } from '../src/upstream.js';
import { fakeModels, type Reply, type Seen } from './fakes.js';

const TOKEN = 'k'.repeat(40);
const RUN = 'build-example-0a1b2c3d';

const FRAMES: Record<string, Shown> = {
  f1: {
    page: 'bank/signin',
    title: 'Sign In',
    controls: ['Sign In'],
    texts: ['Generic Bank: CoreLink Branch Console'],
  },
  f2: {
    page: 'bank/code/enter',
    title: 'Enter Code',
    controls: ['Verify', 'Send a new code'],
    texts: ['Enter the 6-digit code we sent.'],
  },
};

let db: Awaited<ReturnType<typeof controlDb>>;
let memory: Awaited<ReturnType<typeof memoryService>>;
let app: ReturnType<typeof buildServer>;
let script: (seen: Seen, results: number) => Reply;
const sent: Record<string, unknown>[] = [];

beforeAll(async () => {
  [db, memory] = await Promise.all([controlDb(), memoryService()]);
  await db.query(
    `INSERT INTO "FactoryRun" (id, tenant, task, mode, phase, status)
     VALUES ($1, 'example', 'check-balance', 'build', 'SCOUT', 'running')`,
    [RUN],
  );
  const models = fakeModels(
    (_p, seen) => script(seen, seen.items.filter((i) => 'result' in i).length),
    sent,
  );
  app = buildServer({
    gateway: gateway({ ledger: sqlLedger(db), upstream: live(models) }),
    token: TOKEN,
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
});

afterAll(async () => {
  await app.close();
  await memory.close();
  await db.close();
});

function trailOf() {
  const steps: { name: string; action?: string; outcome?: string }[] = [];
  const trail: Trail = {
    policy: { known: [] },
    step: async (s) => {
      steps.push(s);
      return null;
    },
    has: (ref) => ref in FRAMES,
    shown: async (ref) => FRAMES[ref] ?? null,
  };
  return { trail, steps };
}

const agent = (role: Role) => ({
  model: DEFAULT_ROLES[role],
  url: `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/gateway/${RUN}/${role}`,
  token: TOKEN,
});

const LESSON: Lesson = {
  text: 'This site sends the staff code as soon as the password is accepted.',
  area: 'sign-in',
  scope: 'tenant',
  confidence: 'high',
  basis: 'seen',
  frames: ['f2'],
};

const at = { bank: 'example', vendor: 'corelink' };

describe('record_lesson', () => {
  it('keeps a lesson only when it cites frames of this run', async () => {
    const { trail, steps } = trailOf();
    const kept: Lesson[] = [];
    const tool = recordLessonTool(trail, kept);
    await expect(tool.run({ ...LESSON, frames: [] })).rejects.toThrow(
      /cites the frames of this run that show it, and this cites none/,
    );
    await expect(tool.run({ ...LESSON, frames: ['f2', 'f9'] })).rejects.toThrow(
      /f9 is not a frame of this run/,
    );
    await expect(tool.run({ ...LESSON, frames: ['f2'] })).resolves.toMatchObject({
      text: expect.stringMatching(/^Recorded lesson 1/),
    });
    expect(kept).toEqual([LESSON]);
    expect(steps.map((s) => s.action)).toEqual(['refused', 'refused', 'recorded']);
    // Advice is one to three sentences.
    await expect(tool.run({ ...LESSON, text: 'One. Two. Three. Four.' })).rejects.toThrow(
      /one to three sentences/,
    );
  });

  it('is the Supervisor’s, never the Scout’s', async () => {
    expect(refusal('supervisor', 'record_lesson')).toBeNull();
    expect(refusal('scout', 'record_lesson')).toBe("record_lesson is not one of the scout's tools");
    expect(refusal('scout', 'memory_query')).toBeNull();
    const { trail } = trailOf();
    const kept: Lesson[] = [];
    const memoryTools = [
      recordLessonTool(trail, kept),
      memoryQueryTool(memoryClient(memory.factory), at, new Map()),
    ];
    expect(toolsOf('scout', memoryTools).map((t) => t.name)).toEqual(['memory_query']);
  });
});

describe('a run’s lessons', () => {
  it('reach memory as proposals, with what the run relied on and contradicted', async () => {
    const m = memoryClient(memory.factory);
    // An earlier run's two lessons, which memory now serves for the bank.
    const earlier = { id: 'build-example-earlier', kind: 'factory', bank: 'example' };
    expect(
      (
        await m.write('episodes/runs', {
          ...earlier,
          vendor: 'corelink',
          outcome: 'recommended',
          startedAt: new Date(),
        })
      ).status,
    ).toBe(201);
    for (const text of [
      'Statements here list the newest first.',
      'The transfer form offers only accounts the member owns.',
    ])
      await m.write('lessons/proposals', {
        runId: earlier.id,
        text,
        area: 'documents',
        scope: 'tenant',
        confidence: 'medium',
        seen: true,
        frames: ['f3'],
        evidenceHash: 'ab'.repeat(32),
      });
    const pack = await m.pack(at, 'statements and transfers');
    const served = servedBy(pack);
    const idOf = (start: string) => [...served].find(([, text]) => text.startsWith(start))![0];
    const newestFirst = idOf('Statements here');
    const accountsOnly = idOf('The transfer form');
    expect(served.size).toBe(2);

    const { trail, steps } = trailOf();
    script = (seen, results) => {
      const lessons: Reply[] = [
        { tool: 'record_lesson', input: LESSON },
        { tool: 'record_lesson', input: { ...LESSON, frames: [] } },
        { tool: 'record_lesson', input: { ...LESSON, frames: ['f7'] } },
        {
          tool: 'record_lesson',
          input: {
            ...LESSON,
            text: 'Ask ops@example.com when the code page stalls.',
            basis: 'guess',
            frames: ['f1'],
          },
        },
      ];
      if (results < lessons.length) return lessons[results]!;
      expect(seen.items[0]).toMatchObject({ user: expect.stringContaining(newestFirst) });
      return {
        text: JSON.stringify({
          reliedOn: [newestFirst, 'a-lesson-memory-never-served'],
          contradicted: [
            {
              lesson: accountsOnly,
              reason: 'it offered an account of another member',
              frames: ['f2'],
            },
            { lesson: newestFirst, reason: 'cited nothing of this run', frames: ['f8'] },
          ],
        }),
      };
    };
    const learned = await writeLessons({
      agent: agent('lessons'),
      memory: m,
      at,
      trail,
      ended: ['check-balance: the balances are on screen', 'recommended 7 claims'],
      served,
    });
    expect(learned.lessons).toHaveLength(2);
    expect(learned.reliedOn).toEqual([newestFirst]);
    expect(learned.contradicted.map((c) => c.lesson)).toEqual([accountsOnly]);
    expect(steps.find((s) => s.action === 'dropped')?.outcome).toBe(
      'a-lesson-memory-never-served: memory did not serve it; ' +
        `${newestFirst}: f8 is not a frame of this run`,
    );

    const refused = await sendLearned(
      m,
      trail,
      {
        id: RUN,
        at,
        task: 'check-balance',
        driver: 'dv_0123456789abcdef',
        outcome: 'recommended',
        startedAt: new Date(),
        model: DEFAULT_ROLES.lessons.model,
      },
      learned,
    );
    // The lesson naming a person is refused by memory's privacy screen, and goes no further.
    expect(refused).toEqual(['propose a lesson: 422 privacy_screen person']);

    const q = <T>(sql: string) => memory.db.query<T>(sql, [RUN]).then((r) => r.rows);
    expect(await q(`SELECT kind::text AS kind, driver, outcome FROM "Run" WHERE id = $1`)).toEqual([
      { kind: 'factory', driver: 'dv_0123456789abcdef', outcome: 'recommended' },
    ]);
    expect(
      await q<{ text: string; seen: boolean; evidence: unknown }>(
        `SELECT text, seen, state::text AS state, evidence FROM "LessonVersion" WHERE "runId" = $1 AND version = 1`,
      ),
    ).toEqual([
      {
        text: LESSON.text,
        seen: true,
        state: 'proposed',
        evidence: [
          { run: RUN, frames: ['f2'], hash: expect.stringMatching(/^[\da-f]{64}$/), seen: true },
        ],
      },
    ]);
    expect(await q(`SELECT "lessonId" FROM "Reliance" WHERE "runId" = $1`)).toEqual([
      { lessonId: newestFirst },
    ]);
    // One run's contradiction disputes the lesson.
    const disputed = await memory.db.query(
      `SELECT v.state::text AS state, v.reason FROM "Lesson" l
         JOIN "LessonVersion" v ON v."lessonId" = l.id AND v.version = l.current WHERE l.id = $1`,
      [accountsOnly],
    );
    expect(disputed.rows).toEqual([
      { state: 'disputed', reason: 'it offered an account of another member' },
    ]);
  });
});
