import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRun, journal } from '@gb/runs';
import { controlDb } from '../../../packages/oauth/test/control.js';
import { journalPages } from '../src/pages/journal.js';

let db: Awaited<ReturnType<typeof controlDb>>;
let app: ReturnType<typeof Fastify>;
let runId: string;

beforeAll(async () => {
  db = await controlDb();
  app = Fastify();
  journalPages(app, {
    sql: db,
    whoIs: () => ({ email: 'val@generic-bank.local', role: 'viewer' }),
  });
  ({ runId } = await createRun(
    db,
    {
      task: 'transfer',
      bank: 'generic',
      clientId: null,
      inputs: { bank: 'generic', memberId: '40017732', account: '7890' },
    },
    'k'.repeat(40),
  ));
  await journal(db, runId, { intent: 'press Submit transfer under grant g_1' });
  await journal(db, runId, { intent: 'read the confirmation', result: 'confirmation GB-1' });
});
afterAll(async () => {
  await app.close();
  await db.close();
});

describe('the journal page', () => {
  it('lists entries newest first, each linked to its run', async () => {
    const html = (await app.inject({ url: '/journal' })).body;
    expect(html.indexOf('read the confirmation')).toBeLessThan(
      html.indexOf('press Submit transfer under grant g_1'),
    );
    expect(html).toContain(`/runs/${runId}`);
  });

  it('verifies every chain, and names the entry where one breaks', async () => {
    expect((await app.inject({ url: '/journal?verified=1' })).body).toContain(
      'Every chain is whole',
    );
    await db.query(
      `UPDATE "JournalEntry" SET intent = 'something else' WHERE "runId" = $1 AND seq = 1`,
      [runId],
    );
    const html = (await app.inject({ url: '/journal?verified=1' })).body;
    expect(html).toContain('The chain breaks');
    expect(html).toContain('at entry 1: its content was changed');
  });
});
