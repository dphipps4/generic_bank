import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inboxPages } from '../../apps/console/src/pages/inbox.js';
import { executeRun } from '../../apps/runner/src/execute.js';
import { runGuard } from '../../apps/runner/src/guard.js';
import {
  checkBalance,
  type DriverContext,
  downloadStatements,
  prepareTransfer,
  PROFILES,
  type Review,
  submitTransfer,
} from '../../packages/drivers/src/index.js';
import { memoryStore } from '../../packages/evidence/src/index.js';
import {
  consumeGrant,
  GuardError,
  issueGrant,
  type JOBS,
} from '../../packages/guardrails/src/index.js';
import { createRun, journal, openHumanTask, resultOf } from '../../packages/runs/src/index.js';
import {
  Browser,
  button,
  click,
  guardActions,
  readScreen,
} from '../../packages/screen/src/index.js';
import { controlDb } from '../../packages/oauth/test/control.js';
import { MEMBERS, OPERATORS } from '../../apps/bank/src/seed.js';
import type { TenantId } from '../../apps/bank/src/tenants.js';
import { type LiveBank, liveBank, PASSWORDS } from '../support/banks.js';

// The guard on every action (plan, §J.2), on banks 1 and 2 through a real browser: each task's
// driver runs with the Runner's guard in front of every click, key and choice, and does all it
// must; anything else is refused before the browser with its rule and layer, and in a run that
// trips the guard, the bank is frozen. The bank is the judge: its state-change counter does not
// move for anything the guard refused.

const KEY = 'k'.repeat(40);
const ANSWER_KEY = 'q'.repeat(40);

/** Last month, as YYYY-MM: always on the bank's list. */
const lastMonth = () => {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
};

describe.each(['generic', 'example'] as TenantId[])('the guard on %s', (id) => {
  let bank: LiveBank;
  let browser: Browser;
  let db: Awaited<ReturnType<typeof controlDb>>;
  beforeAll(async () => {
    [bank, browser, db] = await Promise.all([liveBank(id), Browser.launch(), controlDb()]);
  }, 120_000);
  afterAll(async () => {
    await browser?.close();
    await bank?.close();
    await db?.close();
  });

  const profile = PROFILES[id]!;
  const lastCode = async () => {
    const r = await bank.db.query<{ body: string }>(
      'SELECT body FROM messages ORDER BY id DESC LIMIT 1',
    );
    return /(\d{6})/.exec(r.rows[0]!.body)![1]!;
  };
  const changes = async () => (await bank.admin<{ stateChanges: number }>('/state')).stateChanges;

  /** A page with the Runner's guard for this job in front of it, and a driver's context on it. */
  async function guarded(job: (typeof JOBS)[number]) {
    const page = await browser.newPage();
    const g = runGuard({ job, profile, secrets: [PASSWORDS.service, OPERATORS.service.id] });
    guardActions(page, g.guard);
    const ctx: DriverContext = {
      page,
      profile: { ...profile, url: bank.url },
      credentials: async () => ({ operatorId: OPERATORS.service.id, password: PASSWORDS.service }),
      askHuman: lastCode,
      learn: () => undefined,
      step: () => undefined,
      now: () => new Date(),
    };
    return { ctx, g };
  }

  it('lets each task do all its list allows: a balance, a statement, a granted transfer', async () => {
    const before = await changes();
    const balance = await guarded('check-balance');
    try {
      expect(
        await checkBalance(balance.ctx, { memberId: MEMBERS.demo, account: 'Everyday Checking' }),
      ).toMatchObject({ status: 'succeeded' });
      expect(balance.g.tripped()).toBeNull();
    } finally {
      await balance.ctx.page.close();
    }

    const statements = await guarded('download-statements');
    try {
      const out = await downloadStatements(statements.ctx, {
        memberId: MEMBERS.demo,
        account: 'Everyday Checking',
        months: [lastMonth()],
      });
      expect(out.status).toBe('succeeded');
      if (out.status === 'succeeded') expect(out.data.months[0]).toHaveProperty('pdf');
      expect(statements.g.tripped()).toBeNull();
    } finally {
      await statements.ctx.page.close();
    }
    // Reading moves nothing.
    expect(await changes()).toBe(before);

    // A transfer: prepared, approved by a person (a grant for what the review page shows), and
    // submitted once under it.
    const memoToken = `GBX ${id === 'generic' ? 'G4RD' : 'G4RX'}`;
    const input = {
      memberId: MEMBERS.demo,
      from: 'Everyday Checking',
      to: 'Rainy Day Savings',
      amountCents: 1_500,
      memoToken,
    };
    const { runId } = await createRun(
      db,
      { task: 'transfer', bank: id, clientId: null, inputs: { bank: id, ...input } },
      KEY,
    );
    const values = (r: Review) => ({
      fromRef: r.from.replace(/\d/g, '*'),
      toRef: r.to.replace(/\d/g, '*'),
      amountCents: r.amountCents,
      memoToken,
    });
    const transfer = await guarded('transfer');
    try {
      const prepared = await prepareTransfer(transfer.ctx, input);
      expect(prepared.status).toBe('succeeded');
      if (prepared.status !== 'succeeded') return;
      const task = await openHumanTask(db, runId, 'approval', {}, new Date(Date.now() + 60_000));
      await issueGrant(db, { ...values(prepared.data), humanTaskId: task, runId });
      const out = await submitTransfer(transfer.ctx, input, {
        consume: async (r) => {
          const g = await consumeGrant(db, { runId, screen: values(r) });
          transfer.g.granted(g);
          return g.ok ? { ok: true } : { ok: false, reason: g.reason };
        },
        journal: async (line) => void (await journal(db, runId, line)),
        supervisorCode: lastCode,
        supervisorId: OPERATORS.supervisor.id,
      });
      expect(out).toMatchObject({ status: 'succeeded', data: { seenInHistory: true } });
      expect(transfer.g.tripped()).toBeNull();
    } finally {
      await transfer.ctx.page.close();
    }
    expect(await changes()).toBe(before + 1);
  }, 600_000);

  it('refuses anything else before the browser, with its rule and layer, and for good', async () => {
    const { ctx, g } = await guarded('check-balance');
    try {
      expect(
        await checkBalance(ctx, { memberId: MEMBERS.demo, account: 'Everyday Checking' }),
      ).toMatchObject({ status: 'succeeded' });
      const before = await changes();
      const summary = await readScreen(ctx.page);

      // What another job's list allows, and a key pressed on its own, are refused by the list.
      const statements = summary.controls.find((c) => profile.words.statements.includes(c.name))!;
      const other = runGuard({ job: 'check-balance', profile, secrets: [] });
      expect(() => other.guard({ verb: 'press', control: statements, model: summary })).toThrow(
        GuardError,
      );
      expect(other.tripped()).toMatchObject({ layer: 'task allowlist' });
      const keys = runGuard({ job: 'check-balance', profile, secrets: [] });
      expect(() =>
        keys.guard({ verb: 'press', control: null, key: 'Enter', model: summary }),
      ).toThrow(GuardError);
      expect(keys.tripped()).toEqual({
        layer: 'task allowlist',
        rule: 'check-balance does not press "the Enter key" on member.summary',
      });

      // A trap in plain view on the member's summary, clicked through the page's own guard.
      const refused = await click(ctx.page, button(summary, 'Waive fee')).then(
        () => null,
        (e: unknown) => e,
      );
      expect(refused).toBeInstanceOf(GuardError);
      expect(refused).toMatchObject({ layer: 'element', rule: '"Waive fee" is never on any list' });
      expect(g.tripped()).toEqual({ layer: 'element', rule: '"Waive fee" is never on any list' });
      // Once tripped, the guard refuses everything, even what the list allows.
      await expect(
        click(
          ctx.page,
          summary.controls.find((c) => profile.words.activity.includes(c.name))!,
        ),
      ).rejects.toThrow(/the guard has tripped/);
      // Nothing reached the bank: the summary is still on the screen, and the counter has not moved.
      expect((await readScreen(ctx.page)).controls.some((c) => c.name === 'Waive fee')).toBe(true);
      expect(await changes()).toBe(before);
    } finally {
      await ctx.page.close();
    }
  }, 300_000);

  it('ends a run that trips the guard escalated, and freezes the bank', async () => {
    // A profile gone wrong: approved words that point member search at the bank's Admin link.
    await db.query('UPDATE "Bank" SET url = $1 WHERE id = $2', [bank.url, id]);
    const claims = [
      ...Object.entries(profile.words).flatMap(([k, vs]) =>
        k === 'memberSearch' ? [] : vs.map((value) => ({ about: `words.${k}`, value })),
      ),
      { about: 'words.memberSearch', value: 'Admin' },
    ];
    await db.query(
      `INSERT INTO "FactoryRun" (id, tenant, task, mode, phase, status)
       VALUES ('fr_wrong', $1, 'check-balance', 'onboard', 'DONE', 'done')`,
      [id],
    );
    await db.query(
      `INSERT INTO "Recommendation" (id, "factoryRunId", tenant, claims, status)
       VALUES ('rec_wrong', 'fr_wrong', $1, $2, 'approved')`,
      [id, JSON.stringify(claims)],
    );
    await db.query(
      `INSERT INTO "Driver" (id, tenant, task, state) VALUES ('drv_wrong', $1, 'check-balance', 'draft')
       ON CONFLICT (tenant, task) DO NOTHING`,
      [id],
    );
    const driverId = (
      await db.query<{ id: string }>(
        `SELECT id FROM "Driver" WHERE tenant = $1 AND task = 'check-balance'`,
        [id],
      )
    ).rows[0]!.id;
    await db.query(
      `INSERT INTO "DriverVersion" (id, "driverId", version, sha256, kind, state, "sourceFactoryRunId")
       VALUES ('dv_wrong', $1, 99, 'x', 'profile', 'promoted', 'fr_wrong')`,
      [driverId],
    );
    await db.query(
      `UPDATE "Driver" SET state = 'promoted', "activeVersionId" = 'dv_wrong' WHERE id = $1`,
      [driverId],
    );

    // The person at the staff phone answers through the Console, as in a real run.
    const consoleApp = Fastify();
    inboxPages(consoleApp, {
      sql: db,
      answerKey: ANSWER_KEY,
      whoIs: () => ({ email: 'staff@test', role: 'approver' }),
    });
    await consoleApp.ready();
    const answering = setInterval(async () => {
      const open = await db.query<{ id: string }>(
        `SELECT id FROM "HumanTask" WHERE status = 'open' AND kind = 'staff_code'`,
      );
      for (const t of open.rows)
        await consoleApp.inject({
          method: 'POST',
          url: `/human-tasks/${t.id}/answer`,
          payload: { code: await lastCode() },
        });
    }, 500);

    try {
      const before = await changes();
      const { runId } = await createRun(
        db,
        {
          task: 'check-balance',
          bank: id,
          clientId: 'gbc_t',
          inputs: { bank: id, memberId: MEMBERS.demo, account: 'Everyday Checking' },
        },
        KEY,
      );
      await executeRun(runId, {
        sql: db,
        store: memoryStore(),
        sealKey: KEY,
        answerKey: ANSWER_KEY,
        credentials: async () => ({
          operatorId: OPERATORS.service.id,
          password: PASSWORDS.service,
        }),
      });
      expect(await resultOf(db, runId)).toMatchObject({
        status: 'escalated',
        code: 'guard_tripped',
        resolvable: false,
      });
      const freezes = await db.query<{ tenant: string; layer: string; reason: string }>(
        `SELECT tenant, layer, reason FROM "Freeze" WHERE "runId" = $1`,
        [runId],
      );
      expect(freezes.rows).toEqual([
        { tenant: id, layer: 'element', reason: '"Admin" is never on any list' },
      ]);
      expect(await changes()).toBe(before);
    } finally {
      clearInterval(answering);
      await consoleApp.close();
    }
  }, 300_000);
});
