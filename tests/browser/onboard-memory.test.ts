import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MEMBERS, OPERATORS } from '../../apps/bank/src/seed.js';
import { gateway } from '../../apps/factory/src/gateway.js';
import { sqlLedger } from '../../apps/factory/src/ledger.js';
import { memoryClient } from '../../apps/factory/src/memory.js';
import { DEFAULT_ROLES } from '../../apps/factory/src/models.js';
import { factoryRun } from '../../apps/factory/src/run.js';
import { buildServer } from '../../apps/factory/src/server.js';
import {
  live,
  type Recorded,
  type Request,
  unpictured,
  type Upstream,
} from '../../apps/factory/src/upstream.js';
import { memoryStore } from '../../packages/evidence/src/index.js';
import { controlDb } from '../../packages/oauth/test/control.js';
import { answerHumanTask } from '../../packages/runs/src/index.js';
import { Browser } from '../../packages/screen/src/index.js';
import { type LiveBank, liveBank, PASSWORDS } from '../support/banks.js';
import { memoryService, TOKENS } from '../support/memory.js';
import { scripted } from '../support/scripted.js';

// The factory onboards bank 2 from memory, in mock mode: the run starts from the knowledge pack
// memory serves for the bank (the seed, through memory's own door), which the Supervisor reads
// before its first turn, and ends with what it taught proposed in memory, each lesson citing the
// frames of the run that show it, beside the lesson it relied on; the run's recording carries the
// lessons. The Supervisor and the Scout are the scripted models behind the gateway, which records
// them; no key is used and nothing reaches a model.
//
// The scripted models, not a kept recording: bank 2 lists its sign-in page's controls in another
// order on Linux than on a Mac, so a recording made on one does not replay on the other. With
// FACTORY_RECORD=1 the run's recording is kept in apps/factory/recordings, where `just onboard
// example` replays it with no key; make it where the stack runs, on Linux.

const RECORDINGS = 'apps/factory/recordings';
const RECORD = process.env.FACTORY_RECORD === '1';
const TOKEN = 'gateway-token-for-tests-0123456789abcdef';
const ANSWER_KEY = 'q'.repeat(40);

let db: Awaited<ReturnType<typeof controlDb>>;
let bank: LiveBank;
let memory: Awaited<ReturnType<typeof memoryService>>;
let browser: Browser;
let factory: ReturnType<typeof buildServer>;
let factoryUrl: string;
let dir: string;
let answering: NodeJS.Timeout;
const store = memoryStore();
// What each role was asked, in order, as the gateway passed it on.
const asked: { role: string; request: Request }[] = [];

beforeAll(async () => {
  [db, bank, memory] = await Promise.all([
    controlDb(),
    liveBank('example'),
    memoryService({ seeded: true }),
  ]);
  await db.query('UPDATE "Bank" SET url = $1 WHERE id = $2', [bank.url, 'example']);
  // Bank 2 serves its tab strip from a second origin.
  const hosts = [bank.url, bank.secondOrigin!].map((u) => new URL(u).host);
  browser = await Browser.launch({ hosts });
  dir = await mkdtemp(join(tmpdir(), 'gb-onboard-'));
  const upstream = live(scripted('example', MEMBERS.demo), dir);
  const watched: Upstream = {
    spends: upstream.spends,
    answer: (runId, role, provider, request) => {
      asked.push({ role, request });
      return upstream.answer(runId, role, provider, request);
    },
  };
  factory = buildServer({
    gateway: gateway({ ledger: sqlLedger(db), upstream: watched }),
    token: TOKEN,
    mode: 'live',
  });
  await factory.listen({ host: '127.0.0.1', port: 0 });
  factoryUrl = `http://127.0.0.1:${(factory.server.address() as AddressInfo).port}`;
  // The person at the staff phone answers the Scout's staff-code task with the code the bank sent.
  answering = setInterval(async () => {
    const open = await db.query<{ id: string }>(
      `SELECT id FROM "HumanTask" WHERE status = 'open' AND kind = 'staff_code'`,
    );
    for (const t of open.rows) {
      const m = await bank.db.query<{ body: string }>(
        'SELECT body FROM messages ORDER BY id DESC LIMIT 1',
      );
      const code = /(\d{6})/.exec(m.rows[0]?.body ?? '')?.[1];
      if (code) await answerHumanTask(db, t.id, code, 'staff@test', ANSWER_KEY);
    }
  }, 300);
}, 180_000);

afterAll(async () => {
  clearInterval(answering);
  await browser?.close();
  await factory?.close();
  await bank?.close();
  await memory?.close();
  await db?.close();
  await rm(dir, { recursive: true, force: true });
});

/** The text a request says to the model, for the Supervisor: its last user message. */
const sayOf = (r: Request) => {
  const m = (r.messages as { role: string; content: unknown }[]).findLast(
    (x) => x.role === 'user',
  )!;
  return JSON.stringify(m.content);
};

describe('the factory onboards bank 2 from memory', () => {
  it('starts from the knowledge pack and ends with its lessons proposed in memory, each citing its frames', async () => {
    const { runId, recommendationId } = await factoryRun(
      {
        sql: db,
        store,
        browser,
        factoryUrl,
        gatewayToken: TOKEN,
        roles: DEFAULT_ROLES,
        credentials: { operatorId: OPERATORS.service.id, password: PASSWORDS.service },
        answerKey: ANSWER_KEY,
        member: MEMBERS.demo,
        memory: memoryClient(memory.factory),
      },
      { bank: 'example', mode: 'build' },
    );
    // Kept as the replay reads it: the agents' own turns, and only the shape of what the bank showed.
    const recorded = (await readFile(join(dir, `${runId}.jsonl`), 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Recorded);
    if (RECORD)
      await writeFile(
        join(RECORDINGS, 'build-example.jsonl'),
        `${recorded.map((l) => JSON.stringify({ ...l, request: unpictured(l.request) as Request })).join('\n')}\n`,
      );
    expect(recommendationId).not.toBeNull();
    // The recording carries the lessons: the Supervisor's record_lesson calls, on the lessons budget.
    expect(
      recorded.filter((l) => l.role === 'lessons' && l.body.includes('"name":"record_lesson"')),
    ).toHaveLength(2);

    // The pack: the seed's patterns, served for bank 2, and the Supervisor's first turn reads it.
    const pack = (await (
      await fetch(`${memory.url}/knowledge/pack?bank=example&vendor=corelink`, {
        headers: { authorization: `Bearer ${TOKENS.factory}` },
      })
    ).json()) as { tiers: { patterns: { id: string }[] } };
    expect(pack.tiers.patterns.length).toBeGreaterThan(0);
    const first = asked[0]!;
    expect(first.role).toBe('supervisor');
    expect(sayOf(first.request)).toContain('What memory knows');
    const intake = (
      await db.query<{ action: string; outcome: string }>(
        `SELECT action, outcome FROM "Step" WHERE "runId" = $1 AND name = 'memory' ORDER BY seq LIMIT 1`,
        [runId],
      )
    ).rows[0];
    expect(intake).toMatchObject({ action: 'knowledge pack' });
    expect(intake!.outcome).toMatch(/^[1-9]\d* lessons/);

    // Its end: the lessons it taught, proposed in memory as the factory, each citing frames of
    // this run; one seen, one a guess. The lesson it relied on is recorded against the run.
    const lessons = (
      await memory.db.query<{
        state: string;
        role: string;
        seen: boolean;
        scope: string;
        bank: string | null;
        evidence: { run: string; frames: string[]; seen: boolean }[];
      }>(
        `SELECT state::text AS state, role::text AS role, seen, scope::text AS scope, bank, evidence
           FROM "LessonVersion" WHERE "runId" = $1 ORDER BY "createdAt"`,
        [runId],
      )
    ).rows;
    expect(lessons.map(({ state, role, seen, scope }) => ({ state, role, seen, scope }))).toEqual([
      { state: 'proposed', role: 'factory', seen: true, scope: 'tenant' },
      { state: 'proposed', role: 'factory', seen: false, scope: 'vendor' },
    ]);
    expect(lessons[0]!.bank).toBe('example');
    const frames = (
      await db.query<{ seq: number }>(`SELECT seq FROM "TrailFrame" WHERE "runId" = $1`, [runId])
    ).rows.map((f) => `f${f.seq}`);
    for (const l of lessons) {
      expect(l.evidence).toHaveLength(1);
      expect(l.evidence[0]!.run).toBe(runId);
      expect(l.evidence[0]!.frames.length).toBeGreaterThan(0);
      for (const f of l.evidence[0]!.frames) expect(frames).toContain(f);
    }
    const run = (
      await memory.db.query(
        `SELECT kind::text AS kind, bank, vendor, outcome FROM "Run" WHERE id = $1`,
        [runId],
      )
    ).rows[0];
    expect(run).toEqual({
      kind: 'factory',
      bank: 'example',
      vendor: 'corelink',
      outcome: 'recommended',
    });
    const relied = (
      await memory.db.query<{ lessonId: string }>(
        `SELECT "lessonId" FROM "Reliance" WHERE "runId" = $1`,
        [runId],
      )
    ).rows;
    expect(relied).toHaveLength(1);
    expect(sayOf(first.request)).toContain(relied[0]!.lessonId);

    // Every write went through memory's door, and the change log still verifies.
    expect(
      await (
        await fetch(`${memory.url}/history/verify`, {
          headers: { authorization: `Bearer ${TOKENS.factory}` },
        })
      ).json(),
    ).toMatchObject({ ok: true });
  }, 600_000);
});
