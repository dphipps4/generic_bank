// Approval grants (plan, §6 step 3-4): the single key to the one money-moving click. A person's
// Approve issues it, bound to the run, the masked accounts, the exact amount, the memo token and a
// nonce, for five minutes. The click consumes it, and only when the screen shows exactly what the
// person approved.
import { randomBytes } from 'node:crypto';

export interface Sql {
  query<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: R[] }>;
}

export const GRANT_LIFETIME_MS = 5 * 60_000;

/** The values a transfer's review page shows, as read off the screen (accounts masked). */
export interface TransferValues {
  fromRef: string;
  toRef: string;
  amountCents: number;
  memoToken: string;
}

export type GrantRefusal =
  | 'no grant'
  | 'already used'
  | 'expired'
  | 'the screen shows a different amount'
  | 'the screen shows different accounts'
  | 'the screen shows a different memo';

export type GrantCheck = { ok: true; grantId: string } | { ok: false; reason: GrantRefusal };

// Only a check consumeGrant returned counts: an { ok: true } written by hand is not a grant.
const consumed = new WeakSet<object>();
export const isConsumedGrant = (c: GrantCheck | undefined): boolean =>
  c !== undefined && c.ok && consumed.has(c);

export async function issueGrant(
  sql: Sql,
  g: TransferValues & { humanTaskId: string; runId: string },
  now = new Date(),
): Promise<{ grantId: string; nonce: string; expiresAt: Date }> {
  if (!Number.isInteger(g.amountCents) || g.amountCents <= 0)
    throw new Error('a grant is for a whole, positive number of cents');
  const grantId = `g_${randomBytes(8).toString('hex')}`;
  const nonce = randomBytes(16).toString('base64url');
  const expiresAt = new Date(now.getTime() + GRANT_LIFETIME_MS);
  await sql.query(
    `INSERT INTO "ApprovalGrant" (id, "humanTaskId", "runId", "fromRef", "toRef", "amountCents", "memoToken", nonce, "expiresAt")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      grantId,
      g.humanTaskId,
      g.runId,
      g.fromRef,
      g.toRef,
      g.amountCents,
      g.memoToken,
      nonce,
      expiresAt,
    ],
  );
  return { grantId, nonce, expiresAt };
}

/**
 * Uses the run's grant for the click, if the screen matches it. One UPDATE both checks and marks
 * it used, so two consumers racing for one grant cannot both win: the second finds it used.
 */
export async function consumeGrant(
  sql: Sql,
  c: { runId: string; screen: TransferValues },
  now = new Date(),
): Promise<GrantCheck> {
  const s = c.screen;
  const used = await sql.query<{ id: string }>(
    `UPDATE "ApprovalGrant" SET "usedAt" = $2
      WHERE "runId" = $1 AND "usedAt" IS NULL AND "expiresAt" > $2
        AND "fromRef" = $3 AND "toRef" = $4 AND "amountCents" = $5 AND "memoToken" = $6
      RETURNING id`,
    [c.runId, now, s.fromRef, s.toRef, s.amountCents, s.memoToken],
  );
  if (used.rows[0]) {
    const check: GrantCheck = { ok: true, grantId: used.rows[0].id };
    consumed.add(check);
    return check;
  }
  return { ok: false, reason: await whyNot(sql, c.runId, s, now) };
}

// The refusal names the first thing wrong with the run's best grant: a live one if it has one.
async function whyNot(
  sql: Sql,
  runId: string,
  s: TransferValues,
  now: Date,
): Promise<GrantRefusal> {
  const g = (
    await sql.query<TransferValues & { usedAt: Date | null; expiresAt: Date }>(
      `SELECT "fromRef", "toRef", "amountCents", "memoToken", "usedAt", "expiresAt"
         FROM "ApprovalGrant" WHERE "runId" = $1
        ORDER BY ("usedAt" IS NULL AND "expiresAt" > $2) DESC, "expiresAt" DESC LIMIT 1`,
      [runId, now],
    )
  ).rows[0];
  if (!g) return 'no grant';
  if (g.usedAt) return 'already used';
  if (g.expiresAt.getTime() <= now.getTime()) return 'expired';
  if (g.amountCents !== s.amountCents) return 'the screen shows a different amount';
  if (g.fromRef !== s.fromRef || g.toRef !== s.toRef) return 'the screen shows different accounts';
  if (g.memoToken !== s.memoToken) return 'the screen shows a different memo';
  // Live and matching a moment ago: another consumer used it in between.
  return 'already used';
}
