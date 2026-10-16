import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildServer } from '../../apps/api/src/server.js';
import { inboxPages } from '../../apps/console/src/pages/inbox.js';
import { executeRun } from '../../apps/runner/src/execute.js';
import { accountsOf } from '../../apps/bank/src/ledger.js';
import { MEMBERS, OPERATORS } from '../../apps/bank/src/seed.js';
import type { TaskName } from '../../packages/contracts/src/index.js';
import { type MaskedModel, memoryStore } from '../../packages/evidence/src/index.js';
import { oauth } from '../../packages/oauth/src/index.js';
import { controlDb } from '../../packages/oauth/test/control.js';
import {
  type Box,
  decodePng,
  type Image,
  type ScreenModel,
} from '../../packages/screen/src/index.js';
import { type LiveBank, liveBank, PASSWORDS } from '../support/banks.js';
import { captureLogs } from './logs.js';
import {
  digits,
  type Drawn,
  everyRow,
  type Hit,
  placesOf,
  pngText,
  type Row,
  scanRow,
  scanText,
  sourcesOf,
  uncoveredShare,
} from './scan.js';
import { type Seeded, seededOf } from './seeded.js';

// The PII suite (plan, §I.2): each task once on bank 1, asked for through the Task API and carried
// out by the Runner, with a person answering through the Console. Then everything those runs wrote
// is searched for every seeded secret and personal value: each row of the control database, each
// stored object, each log line. A stored picture is judged by what the bank drew: every place a
// screen showed a seeded value must be covered. Any hit fails the suite and names where it was.

// Every screen the crawler reads, before masking: what the bank drew, and where.
const seen = vi.hoisted(() => [] as Drawn[]);
vi.mock('../../packages/screen/src/model.js', async (original) => {
  const m = await original<typeof import('../../packages/screen/src/model.js')>();
  const { drawnOf: keep } = await import('./scan.js');
  return {
    ...m,
    readScreen: async (...a: Parameters<typeof m.readScreen>) => {
      const s: ScreenModel = await m.readScreen(...a);
      seen.push(keep(s));
      return s;
    },
  };
});

const BANKS = ['generic'] as const;
const SEAL = 'k'.repeat(40);
const ANSWER_KEY = 'q'.repeat(40);
const lastMonth = () => {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 7);
};

/** Inputs for each task: the demo member, so the runs meet a name, balances and account numbers. */
const CASES: Record<TaskName, (b: LiveBank) => Promise<Record<string, unknown>[]>> = {
  'check-balance': async (b) => {
    const demo = await accountsOf(b.db, MEMBERS.demo);
    return [
      {
        bank: b.id,
        memberId: MEMBERS.demo,
        account: demo.find((a) => a.type === 'checking')!.number.slice(-4),
      },
    ];
  },
  transfer: async (b) => {
    const demo = await accountsOf(b.db, MEMBERS.demo);
    return [
      {
        bank: b.id,
        memberId: MEMBERS.demo,
        from: demo.find((a) => a.type === 'checking')!.number.slice(-4),
        to: demo.find((a) => a.type === 'savings')!.number.slice(-4),
        amountCents: 2_500,
        memo: 'pii suite',
        idempotencyKey: `pii-suite-${b.id}-${Date.now()}`,
      },
    ];
  },
  'download-statements': async (b) => {
    const demo = await accountsOf(b.db, MEMBERS.demo);
    return [
      {
        bank: b.id,
        memberId: MEMBERS.demo,
        account: demo.find((a) => a.type === 'checking')!.number.slice(-4),
        months: [lastMonth()],
      },
    ];
  },
};

let db: Awaited<ReturnType<typeof controlDb>>;
const banks = new Map<string, LiveBank>();
const store = memoryStore();
let logs: ReturnType<typeof captureLogs>;
let answering: NodeJS.Timeout | undefined;
let before: Set<string>;
const seeded: Seeded = { text: [], drawn: [] };
/** What happened to each bank and task: run by the Runner, or refused by the API. */
const asked: { bank: string; task: TaskName; runId: string | null; ending: string }[] = [];

beforeAll(async () => {
  logs = captureLogs();
  const [control, ...live] = await Promise.all([controlDb(), ...BANKS.map((b) => liveBank(b))]);
  db = control;
  for (const b of live) {
    banks.set(b.id, b);
    await db.query('UPDATE "Bank" SET url = $1 WHERE id = $2', [b.url, b.id]);
  }

  // The services, built as their mains build them: each logs every request.
  const o = oauth(db, 'h'.repeat(40));
  const queue: string[] = [];
  const api = await buildServer({
    oauth: o,
    sql: db,
    sealKey: SEAL,
    enqueue: async (id) => void queue.push(id),
    logger: true,
  });
  const consoleApp = Fastify({ logger: true });
  inboxPages(consoleApp, {
    sql: db,
    answerKey: ANSWER_KEY,
    whoIs: () => ({ email: 'approver@generic-bank.local', role: 'approver' }),
  });
  await consoleApp.ready();

  // The person at the staff phone, and the approver: each open task is answered through the Console.
  answering = setInterval(async () => {
    const open = await db.query<{ id: string; kind: string; bank: string }>(
      `SELECT h.id, h.kind, r.bank FROM "HumanTask" h JOIN "TaskRun" r ON r.id = h."runId" WHERE h.status = 'open'`,
    );
    for (const t of open.rows) {
      if (t.kind === 'approval') {
        await consoleApp.inject({
          method: 'POST',
          url: `/human-tasks/${t.id}/approve`,
          payload: { reason: 'The PII suite approves its own test transfer.' },
        });
        continue;
      }
      const bank = banks.get(t.bank)!;
      const m = await bank.db.query<{ body: string }>(
        `SELECT m.body FROM messages m JOIN operators o ON m.address IN (o.phone, o.email)
          WHERE o.operator_id = $1 ORDER BY m.id DESC LIMIT 1`,
        [t.kind === 'supervisor_code' ? OPERATORS.supervisor.id : OPERATORS.service.id],
      );
      const code = /(\d{6})/.exec(m.rows[0]?.body ?? '')?.[1];
      if (code)
        await consoleApp.inject({
          method: 'POST',
          url: `/human-tasks/${t.id}/answer`,
          payload: { code },
        });
    }
  }, 500);

  const client = await o.createClient({
    name: 'pii suite',
    scopes: ['tasks:read', 'tasks:balance', 'tasks:transfer', 'tasks:statements'],
    createdBy: 'the pii suite',
  });
  const token = (await o.exchangeCode(client.clientId, client.clientSecret, client.code))
    .access_token;
  before = new Set((await everyRow(db)).map((r) => r.key));

  const deps = {
    sql: db,
    store,
    sealKey: SEAL,
    answerKey: ANSWER_KEY,
    // The suite answers a person's tasks within a second; 20 seconds unanswered means it never will.
    humanDeadlineMs: 20_000,
    credentials: async () => ({ operatorId: OPERATORS.service.id, password: PASSWORDS.service }),
  };
  const lookedUp = new Set<string>();
  for (const b of live) {
    for (const task of ['check-balance', 'transfer'] as TaskName[]) {
      for (const inputs of await CASES[task](b)) {
        const r = await api.inject({
          method: 'POST',
          url: `/tasks/${task}`,
          headers: { authorization: `Bearer ${token}` },
          payload: inputs,
        });
        if (r.statusCode === 202) {
          const runId = queue.shift()!;
          await executeRun(runId, deps);
          lookedUp.add(String(inputs.memberId));
          const done = await api.inject({
            method: 'GET',
            url: `/tasks/${runId}`,
            headers: { authorization: `Bearer ${token}` },
          });
          const { status, code } = done.json() as { status: string; code?: string };
          asked.push({ bank: b.id, task, runId, ending: code ?? status });
          if (status !== 'succeeded') throw new Error(await whyNot(runId, task, code ?? status));
        } else {
          expect(r.json().code, `${task} on ${b.id}`).toBe('task_not_available');
          asked.push({ bank: b.id, task, runId: null, ending: 'task_not_available' });
        }
      }
    }
  }
  clearInterval(answering);
  answering = undefined;
  await api.close();
  await consoleApp.close();

  for (const b of live) {
    const s = await seededOf(b, [...lookedUp]);
    seeded.text.push(...s.text);
    seeded.drawn.push(...s.drawn);
  }
}, 240_000);

afterAll(async () => {
  if (answering) clearInterval(answering);
  logs?.restore();
  await Promise.all([...banks.values()].map((b) => b.close()));
  await db?.close();
});

/** Why a run did not succeed, in a line a person can act on: its last steps and its tasks for a person. */
async function whyNot(runId: string, task: TaskName, ending: string): Promise<string> {
  const steps = await db.query<{ screen: string | null; name: string; outcome: string | null }>(
    `SELECT screen, name, outcome FROM "Step" WHERE "runId" = $1 ORDER BY seq DESC LIMIT 3`,
    [runId],
  );
  const tasks = await db.query<{ kind: string; status: string }>(
    `SELECT kind, status FROM "HumanTask" WHERE "runId" = $1 ORDER BY "openedAt"`,
    [runId],
  );
  const last = steps.rows
    .reverse()
    .map((r) => `${r.screen ?? 'unknown'} (${r.name}${r.outcome ? `: ${r.outcome}` : ''})`)
    .join(', then ');
  const people = tasks.rows.map((t) => `${t.kind} ${t.status}`).join(', ') || 'none';
  return `${task} run ${runId} ended ${ending}. Last steps: ${last || 'none'}. Tasks for a person: ${people}.`;
}

/** A place the picture test found covered, for the last test to draw over. */
let covered: { img: Image; box: Box } | undefined;

const report = (hits: Hit[]) =>
  hits.length === 0
    ? 'nothing found'
    : `${hits.length} found:\n${hits.map((h) => `  ${h.what}, in ${h.where}`).join('\n')}`;

describe('the PII suite', () => {
  it('runs a balance and a transfer on bank 1', async () => {
    // Each run read the member's data: a balance, and a transfer's review.
    expect(asked.map((a) => a.ending)).toEqual(['succeeded', 'succeeded']);
    expect(store.keys().filter((k) => k.endsWith('.png')).length).toBeGreaterThan(3);
  });

  it('finds no seeded value in any row of the control database', async () => {
    const rows = (await everyRow(db)).filter((r) => !before.has(r.key));
    expect(rows.some((r) => r.table === 'TaskRun')).toBe(true);
    const hits = rows.flatMap((r) => scanRow(r, seeded.text));
    expect(hits, report(hits)).toEqual([]);
  });

  it('finds no seeded value in any stored object', async () => {
    const hits: Hit[] = [];
    for (const k of store.keys()) {
      const body = (await store.get(k))!;
      const text = k.endsWith('.png') ? pngText(body) : body.toString('utf8');
      hits.push(...scanText(text, seeded.text, `object ${k}`));
    }
    expect(hits, report(hits)).toEqual([]);
  });

  it('covers every place a screen showed a seeded value in the stored picture', async () => {
    const hits: Hit[] = [];
    let checked = 0;
    for (const k of store.keys().filter((x) => x.endsWith('.png'))) {
      const model = JSON.parse(
        (await store.get(k.replace(/\.png$/, '.json')))!.toString(),
      ) as MaskedModel;
      const sources = sourcesOf(model, seen);
      if (sources.length === 0) {
        hits.push({ where: `object ${k}`, what: 'a picture no screen the bank drew accounts for' });
        continue;
      }
      const img = decodePng((await store.get(k))!);
      for (const s of sources) {
        for (const p of placesOf(s, seeded.drawn)) {
          const open = uncoveredShare(img, p.box);
          if (open === null) continue;
          checked++;
          if (open <= 0.01 && !covered && p.box.h >= 8) covered = { img, box: p.box };
          // Several screens can account for one picture (the same page read twice): one hit each.
          if (
            open > 0.01 &&
            !hits.some((h) =>
              h.where.startsWith(
                `object ${k}, the box at ${Math.round(p.box.x)},${Math.round(p.box.y)} `,
              ),
            )
          )
            hits.push({
              where: `object ${k}, the box at ${Math.round(p.box.x)},${Math.round(p.box.y)} (${Math.round(open * 100)}% uncovered)`,
              what: p.what,
            });
        }
      }
    }
    expect(hits, report(hits)).toEqual([]);
    // The member summary alone draws a name, account digits and balances.
    expect(checked).toBeGreaterThan(10);
  });

  it('finds no seeded value in any log line', () => {
    const lines = logs.lines();
    // Both services logged their requests, so the capture saw them.
    expect(lines.filter((l) => /"url":"\/tasks\//.test(l)).length).toBeGreaterThan(0);
    expect(lines.filter((l) => /"url":"\/human-tasks\//.test(l)).length).toBeGreaterThan(0);
    const hits = lines.flatMap((l, i) => scanText(l, seeded.text, `log line ${i + 1}`));
    expect(hits, report(hits)).toEqual([]);
  });

  it('finds a planted value in a row, an object, a log line and an uncovered picture', () => {
    // The scan is not vacuous: each way of looking finds what was put in front of it.
    const number = digits('a planted member number', MEMBERS.demo);
    const row: Row = {
      table: 'Step',
      id: 's_x',
      key: '',
      columns: [['outcome', `opened ${MEMBERS.demo}`]],
    };
    expect(scanRow(row, seeded.text)[0]?.what).toMatch(/generic member demo's member number/);
    expect(scanText(`{"text":"Member ${MEMBERS.demo}"}`, [number], 'object x')).toHaveLength(1);
    expect(scanText(`{"url":"/members/${MEMBERS.demo}0"}`, [number], 'log line 1')).toHaveLength(0);
    expect(scanText(`password=${PASSWORDS.service}`, seeded.text, 'log line 1')[0]?.what).toBe(
      'the service password',
    );
    // A covered place in a real stored picture, with a stroke of dark text drawn back over it.
    expect(covered).toBeDefined();
    const { img, box } = covered!;
    expect(uncoveredShare(img, box)).toBeLessThanOrEqual(0.01);
    const data = new Uint8Array(img.data);
    const y = Math.ceil(box.y + box.h / 2);
    for (let x = Math.ceil(box.x); x < box.x + box.w; x++)
      data.fill(40, (y * img.width + x) * 4, (y * img.width + x) * 4 + 3);
    expect(uncoveredShare({ ...img, data }, box)).toBeGreaterThan(0.01);
  });
});
