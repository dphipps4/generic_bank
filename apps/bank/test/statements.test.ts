import { PDFDocument } from 'pdf-lib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectInProcess, type Db, migrate } from '../src/db.js';
import { accountsOf, balanceAt, findMember } from '../src/ledger.js';
import { MEMBERS, seed } from '../src/seed.js';
import { statementPdf, statementsFor } from '../src/statements.js';
import { TENANTS } from '../src/tenants.js';

const NOW = new Date('2026-06-15T15:00:00Z');
let db: Db;

beforeAll(async () => {
  db = await connectInProcess();
  await migrate(db);
  await seed(
    db,
    TENANTS.generic,
    { servicePassword: 'p'.repeat(20), supervisorPassword: 's'.repeat(20) },
    NOW,
  );
}, 60_000);
afterAll(() => db.close());

const checking = async () =>
  (await accountsOf(db, MEMBERS.demo)).find((a) => a.type === 'checking')!;

describe('statements', () => {
  it('lists the twelve most recent complete months, newest first', async () => {
    const rows = await statementsFor(db, (await checking()).id, NOW);
    expect(rows).toHaveLength(12);
    expect(rows.map((r) => r.month).slice(0, 2)).toEqual(['2026-05', '2026-04']);
    expect(rows[0]!.statementDate.toISOString().slice(0, 10)).toBe('2026-05-31');
    expect(rows.every((r) => r.documentType === 'Statement')).toBe(true);
  });

  it('states each month’s closing balance from the ledger', async () => {
    const a = await checking();
    const [may] = await statementsFor(db, a.id, NOW);
    expect(may!.balanceCents).toBe(await balanceAt(db, a.id, new Date('2026-06-01T00:00:00Z')));
  });

  it('makes a real PDF, and the same bytes the second time', async () => {
    const member = (await findMember(db, MEMBERS.demo))!;
    const a = await checking();
    const bytes = await statementPdf(db, TENANTS.generic, member, a, '2026-05');
    const doc = await PDFDocument.load(bytes!);
    expect(doc.getPageCount()).toBeGreaterThan(0);
    expect(doc.getTitle()).toBe('Generic Bank statement 2026-05');
    expect(await statementPdf(db, TENANTS.generic, member, a, '2026-05')).toBe(bytes);
  });

  it('refuses a month it does not understand', async () => {
    const member = (await findMember(db, MEMBERS.demo))!;
    expect(await statementPdf(db, TENANTS.generic, member, await checking(), 'May')).toBeNull();
  });
});
