import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRun, openHumanTask, settleRun } from '@gb/runs';
import { controlDb } from '../../../packages/oauth/test/control.js';
import { pending, told } from '../src/notices.js';
import { tokenFrom } from '../src/slack.js';

// What the notifier tells Slack: each person's task, failed run and route to review once, with the
// link to the Console page where a person acts on it, and nothing older than the last hour.

let db: Awaited<ReturnType<typeof controlDb>>;
const links = { console: 'https://gb.example.test', inbox: 'https://gb.example.test:3001' };
const input = { bank: 'generic', memberId: '40017732', account: 'Everyday Checking' };
const run = async () =>
  (
    await createRun(
      db,
      { task: 'check-balance', bank: 'generic', clientId: 'gbc_agent', inputs: input },
      'k'.repeat(40),
    )
  ).runId;
const soon = () => new Date(Date.now() + 5 * 60_000);

beforeAll(async () => {
  db = await controlDb();
});
afterAll(() => db.close());

describe('the notifier', () => {
  it('tells of a transfer to approve with what the review page said, and links the inbox', async () => {
    const runId = await run();
    const review = {
      from: 'Everyday Checking …9706',
      to: 'Rainy Day Savings …4410',
      amountCents: 2500,
      memo: 'rent <b>',
      memoToken: 'GB1A2B3C',
    };
    const id = await openHumanTask(db, runId, 'approval', { review }, soon());
    const n = (await pending(db, links)).find((x) => x.ref === id)!;
    expect(n.kind).toBe('approval');
    expect(n.text).toContain('*A transfer waits for approval.* Generic Bank: $25.00');
    expect(n.text).toContain('from Everyday Checking …9706 to Rainy Day Savings …4410');
    expect(n.text).toContain('memo "rent &lt;b&gt;"');
    expect(n.text).toContain("<https://gb.example.test/inbox|Open the Console's Inbox>");
  });

  it('tells of a sign-in code with the simulated inbox to read it from', async () => {
    const id = await openHumanTask(db, await run(), 'staff_code', { bank: 'generic' }, soon());
    const n = (await pending(db, links)).find((x) => x.ref === id)!;
    expect(n.text).toContain('*Generic Bank wants a sign-in code.*');
    expect(n.text).toContain('<https://gb.example.test:3001|simulated inbox>');
  });

  it('tells of a failed run with a link to its frames', async () => {
    const runId = await run();
    await settleRun(db, runId, { status: 'failed', code: 'unknown_screen' });
    const n = (await pending(db, links)).find((x) => x.ref === runId)!;
    expect(n.kind).toBe('run_failed');
    expect(n.text).toContain('ended `unknown_screen`');
    expect(n.text).toContain(`<https://gb.example.test/runs/${runId}|Open the run and its frames>`);
  });

  it('tells of a route waiting for review', async () => {
    await db.query(
      `INSERT INTO "FactoryRun" (id, tenant, task, mode, phase, status) VALUES ('f1', 'example', 'all', 'build', 'DONE', 'succeeded')`,
    );
    await db.query(
      `INSERT INTO "Recommendation" (id, "factoryRunId", tenant) VALUES ('c1', 'f1', 'example')`,
    );
    const n = (await pending(db, links)).find((x) => x.ref === 'c1')!;
    expect(n.text).toContain(
      'waits for review.* <https://gb.example.test/recommendations|Open Recommendations>',
    );
  });

  it('tells each thing once, and nothing from before the last hour', async () => {
    const id = await openHumanTask(db, await run(), 'staff_code', { bank: 'generic' }, soon());
    const old = await openHumanTask(db, await run(), 'staff_code', { bank: 'generic' }, soon());
    await db.query(`UPDATE "HumanTask" SET "openedAt" = now() - interval '2 hours' WHERE id = $1`, [
      old,
    ]);
    const first = await pending(db, links);
    expect(first.map((n) => n.ref)).toContain(id);
    expect(first.map((n) => n.ref)).not.toContain(old);
    for (const n of first) await told(db, n, 'C1', '1.0');
    expect(await pending(db, links)).toEqual([]);
  });
});

describe('the Slack token', () => {
  it('is SLACK_TOKEN where one is set', async () => {
    expect(await tokenFrom({ SLACK_TOKEN: 'x'.repeat(20) })()).toBe('x'.repeat(20));
  });

  it("is otherwise the Replit connection's, and absent without either", () => {
    expect(() => tokenFrom({})).toThrow('No Slack token');
    expect(typeof tokenFrom({ REPLIT_CONNECTORS_HOSTNAME: 'h', REPL_IDENTITY: 'i' })).toBe(
      'function',
    );
  });
});
