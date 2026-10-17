import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import type { Db } from './db.js';
import { type Account, activity, balanceAt, dollars, type Member, maskedName } from './ledger.js';
import type { Tenant } from './tenants.js';

// Statements are made on request from the ledger, one per month, and kept in memory. The bank
// stores no PDF files.

export interface StatementRow {
  month: string; // YYYY-MM
  statementDate: Date; // the month's last day
  balanceCents: number;
  documentType: 'Statement';
}

const monthStart = (y: number, m: number) => new Date(Date.UTC(y, m, 1));

/** The twelve most recent complete months, newest first. */
export async function statementsFor(db: Db, accountId: number, now: Date): Promise<StatementRow[]> {
  const out: StatementRow[] = [];
  for (let i = 1; i <= 12; i++) {
    const start = monthStart(now.getUTCFullYear(), now.getUTCMonth() - i);
    const end = monthStart(start.getUTCFullYear(), start.getUTCMonth() + 1);
    out.push({
      month: start.toISOString().slice(0, 7),
      statementDate: new Date(end.getTime() - 86_400_000),
      balanceCents: await balanceAt(db, accountId, end),
      documentType: 'Statement',
    });
  }
  return out;
}

const cache = new Map<string, Uint8Array>();
const CACHE_MAX = 64;

export async function statementPdf(
  db: Db,
  t: Tenant,
  member: Member,
  account: Account,
  month: string,
): Promise<Uint8Array | null> {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) return null;
  const key = `${account.id}:${month}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const start = monthStart(Number(m[1]), Number(m[2]) - 1);
  const end = monthStart(start.getUTCFullYear(), start.getUTCMonth() + 1);
  const opening = await balanceAt(db, account.id, start);
  const rows = (await activity(db, account.id, start, end)).filter((r) => !r.pending).reverse();
  const closing = await balanceAt(db, account.id, end);

  const pdf = await PDFDocument.create();
  pdf.setTitle(`${t.brand} statement ${month}`);
  pdf.setProducer('CoreLink Branch Console');
  pdf.setCreationDate(end);
  pdf.setModificationDate(end);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  let page = pdf.addPage([612, 792]);
  let y = 740;
  const line = (text: string, x = 50, f = font, size = 10) => {
    page.drawText(text, { x, y, size, font: f, color: rgb(0, 0, 0) });
  };
  line(t.brand, 50, bold, 16);
  y -= 20;
  line(`Statement for ${t.accountWording(account.number)} (${account.nickname})`);
  y -= 14;
  line(`Member ${member.number}, ${maskedName(member)}`);
  y -= 14;
  line(
    `Period ${start.toISOString().slice(0, 10)} to ${new Date(end.getTime() - 86_400_000).toISOString().slice(0, 10)}`,
  );
  y -= 24;
  line(`Opening balance  ${dollars(opening)}`, 50, bold);
  y -= 20;
  for (const r of rows) {
    if (y < 80) {
      page = pdf.addPage([612, 792]);
      y = 740;
    }
    line(r.postedAt.toISOString().slice(0, 10));
    line(r.description.slice(0, 60), 130);
    line(dollars(r.amountCents), 470);
    y -= 14;
  }
  y -= 10;
  line(`Closing balance  ${dollars(closing)}`, 50, bold);
  const bytes = await pdf.save();
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
  cache.set(key, bytes);
  return bytes;
}
