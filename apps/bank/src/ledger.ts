import type { Db } from './db.js';
import { hash32 } from './rng.js';

export interface Account {
  id: number;
  memberNumber: string;
  type: string;
  nickname: string;
  number: string;
  restriction: string | null;
  currentCents: number;
  availableCents: number;
}

export interface Member {
  number: string;
  firstName: string;
  lastName: string;
  status: 'active' | 'closed';
}

/** "A. Sample": the only form of a member's name the console shows. */
export const maskedName = (m: Member) => `${m.firstName.charAt(0)}. ${m.lastName}`;

export async function findMember(db: Db, number: string): Promise<Member | null> {
  const r = await db.query<{
    number: string;
    first_name: string;
    last_name: string;
    status: Member['status'];
  }>('SELECT number, first_name, last_name, status FROM members WHERE number = $1', [number]);
  const m = r.rows[0];
  return m
    ? { number: m.number, firstName: m.first_name, lastName: m.last_name, status: m.status }
    : null;
}

/** Balances are never stored: current is every posted entry, available also subtracts holds. */
export async function accountsOf(db: Db, memberNumber: string): Promise<Account[]> {
  const r = await db.query<{
    id: number;
    member_number: string;
    type: string;
    nickname: string;
    number: string;
    restriction: string | null;
    current: number;
    holds: number;
  }>(
    `SELECT a.id, a.member_number, a.type, a.nickname, a.number, a.restriction,
            COALESCE(SUM(e.amount_cents) FILTER (WHERE NOT e.pending), 0)::bigint AS current,
            COALESCE(SUM(e.amount_cents) FILTER (WHERE e.pending AND e.amount_cents < 0), 0)::bigint AS holds
       FROM accounts a LEFT JOIN ledger_entries e ON e.account_id = a.id
      WHERE a.member_number = $1
      GROUP BY a.id ORDER BY a.id`,
    [memberNumber],
  );
  return r.rows.map((a) => ({
    id: a.id,
    memberNumber: a.member_number,
    type: a.type,
    nickname: a.nickname,
    number: a.number,
    restriction: a.restriction,
    currentCents: a.current,
    availableCents: a.current + a.holds,
  }));
}

export interface ActivityRow {
  postedAt: Date;
  description: string;
  amountCents: number;
  pending: boolean;
}

export async function activity(
  db: Db,
  accountId: number,
  from: Date,
  to: Date,
): Promise<ActivityRow[]> {
  const r = await db.query<{
    posted_at: Date;
    description: string;
    amount_cents: number;
    pending: boolean;
  }>(
    `SELECT posted_at, description, amount_cents, pending FROM ledger_entries
      WHERE account_id = $1 AND posted_at >= $2 AND posted_at < $3 ORDER BY posted_at DESC, id DESC`,
    [accountId, from, to],
  );
  return r.rows.map((e) => ({
    postedAt: new Date(e.posted_at),
    description: e.description,
    amountCents: e.amount_cents,
    pending: e.pending,
  }));
}

export async function balanceAt(db: Db, accountId: number, at: Date): Promise<number> {
  const r = await db.query<{ b: number }>(
    'SELECT COALESCE(SUM(amount_cents), 0)::bigint AS b FROM ledger_entries WHERE account_id = $1 AND NOT pending AND posted_at < $2',
    [accountId, at],
  );
  return r.rows[0]?.b ?? 0;
}

export type TransferRefusal =
  | 'insufficient-funds'
  | 'not-permitted'
  | 'daily-limit'
  | 'validation'
  | 'restricted'
  | 'same-account';

export const REFUSAL_TEXT: Record<TransferRefusal, string> = {
  'insufficient-funds': 'The amount is more than the available balance.',
  'not-permitted': 'Transfers from this account type are not permitted.',
  'daily-limit': 'Your operator role cannot transfer more than $10,000 per day.',
  validation: 'Enter an amount between $0.01 and $25,000.00.',
  restricted: 'This account is restricted. Refer the member to a branch.',
  'same-account': 'Choose two different accounts.',
};

export interface TransferRequest {
  memberNumber: string;
  fromId: number;
  toId: number;
  amountCents: number;
  memo: string;
  operatorPk: number;
}

/** Checks a transfer the way the bank does, in the bank's order. Null means it may proceed. */
export async function checkTransfer(
  db: Db,
  q: TransferRequest,
  now: Date,
): Promise<TransferRefusal | null> {
  if (!Number.isInteger(q.amountCents) || q.amountCents < 1 || q.amountCents > 2_500_000)
    return 'validation';
  if (q.fromId === q.toId) return 'same-account';
  const accounts = await accountsOf(db, q.memberNumber);
  const from = accounts.find((a) => a.id === q.fromId);
  const to = accounts.find((a) => a.id === q.toId);
  if (!from || !to) return 'validation';
  if (from.type === 'ira' || from.type === 'cd') return 'not-permitted';
  if (from.restriction || to.restriction) return 'restricted';
  if (q.amountCents > from.availableCents) return 'insufficient-funds';
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const used = await db.query<{ total: number; limit: number }>(
    `SELECT COALESCE(SUM(t.amount_cents), 0)::bigint AS total, o.daily_limit_cents AS limit
       FROM operators o LEFT JOIN transfers t ON t.operator_pk = o.pk AND t.created_at >= $2
      WHERE o.pk = $1 GROUP BY o.pk`,
    [q.operatorPk, today],
  );
  const u = used.rows[0];
  if (u && u.total + q.amountCents > u.limit) return 'daily-limit';
  return null;
}

/** Posts a transfer: two ledger entries and one transfer row. Returns the confirmation number. */
export async function postTransfer(
  db: Db,
  q: TransferRequest & { approvedBy: number | null; prefix: string },
  now: Date,
): Promise<string> {
  const n = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM transfers');
  const seq = (n.rows[0]?.n ?? 0) + 1;
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const confirmation = `${q.prefix}-${48_212 + seq}-${letters[hash32(q.prefix, seq) % letters.length]}`;
  const txn = `X${confirmation}`;
  const desc = (dir: string) => `TRANSFER ${dir} ${q.memo}`.slice(0, 120);
  await db.transaction(async (query) => {
    await query(
      `INSERT INTO ledger_entries (txn, account_id, amount_cents, description, posted_at) VALUES ($1, $2, $3, $4, $5), ($1, $6, $7, $8, $5)`,
      [txn, q.fromId, -q.amountCents, desc('OUT'), now, q.toId, q.amountCents, desc('IN')],
    );
    await query(
      `INSERT INTO transfers (member_number, from_account, to_account, amount_cents, memo, operator_pk, approved_by, confirmation, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'posted', $9)`,
      [
        q.memberNumber,
        q.fromId,
        q.toId,
        q.amountCents,
        q.memo,
        q.operatorPk,
        q.approvedBy,
        confirmation,
        now,
      ],
    );
    await query(`INSERT INTO state_changes (kind, detail, at) VALUES ('transfer', $1, $2)`, [
      JSON.stringify({ confirmation, amountCents: q.amountCents, member: q.memberNumber }),
      now,
    ]);
  });
  return confirmation;
}

export const dollars = (cents: number) =>
  `${cents < 0 ? '-' : ''}$${(Math.abs(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Parses "$1,234.50" or "1234.5" into cents, or null. */
export function parseDollars(s: string): number | null {
  const t = s.trim().replace(/^\$/, '').replace(/,/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  return Math.round(Number(t) * 100);
}
