import { randomBytes, randomInt } from 'node:crypto';
import argon2 from 'argon2';
import type { Db } from './db.js';

export const IDLE_MS = 10 * 60_000;
export const CODE_MS = 5 * 60_000;
export const CODE_TRIES = 3;
export const WORKSTATION_DAYS = 30;
const LOCK_WINDOW_MS = 15 * 60_000;
const LOCK_AFTER = 5;
const LOCK_MS = 30 * 60_000;

export const token = () => randomBytes(24).toString('base64url');

export interface Operator {
  pk: number;
  operatorId: string;
  displayName: string;
  role: 'teller' | 'senior teller' | 'supervisor';
  phone: string;
  email: string;
}

export interface Session {
  token: string;
  operatorPk: number | null;
  state: 'code' | 'handoff' | 'active' | 'ended';
  handoff: string | null;
  pending: Record<string, unknown> | null;
  promoShown: boolean;
  lastSeen: Date;
  expiresEarlyAt: Date | null;
}

type OperatorRow = {
  pk: number;
  operator_id: string;
  display_name: string;
  role: Operator['role'];
  phone: string;
  email: string;
  locked: boolean;
  locked_until: Date | null;
};
const toOperator = (o: OperatorRow): Operator => ({
  pk: o.pk,
  operatorId: o.operator_id,
  displayName: o.display_name,
  role: o.role,
  phone: o.phone,
  email: o.email,
});

export async function operatorByPk(db: Db, pk: number): Promise<Operator | null> {
  const r = await db.query<OperatorRow>('SELECT * FROM operators WHERE pk = $1', [pk]);
  return r.rows[0] ? toOperator(r.rows[0]) : null;
}

export async function operatorById(db: Db, id: string): Promise<Operator | null> {
  const r = await db.query<OperatorRow>('SELECT * FROM operators WHERE operator_id = $1', [id]);
  return r.rows[0] ? toOperator(r.rows[0]) : null;
}

export type SignInResult =
  { ok: true; operator: Operator } | { ok: false; reason: 'bad-credentials' | 'locked' };

/** Checks an Operator ID and password, counting failures toward a lockout. */
export async function checkPassword(
  db: Db,
  operatorId: string,
  password: string,
  now: Date,
): Promise<SignInResult> {
  const r = await db.query<OperatorRow & { hash: string }>(
    'SELECT o.*, c.hash FROM operators o JOIN credentials c ON c.operator_pk = o.pk WHERE o.operator_id = $1',
    [operatorId],
  );
  const o = r.rows[0];
  if (o && (o.locked || (o.locked_until && new Date(o.locked_until) > now)))
    return { ok: false, reason: 'locked' };
  const ok = !!o && (await argon2.verify(o.hash, password).catch(() => false));
  await db.query('INSERT INTO sign_in_attempts (operator_id, ok, at) VALUES ($1, $2, $3)', [
    operatorId,
    ok,
    now,
  ]);
  if (ok) return { ok: true, operator: toOperator(o) };
  if (o) {
    const f = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM sign_in_attempts WHERE operator_id = $1 AND NOT ok AND at > $2
         AND at > COALESCE((SELECT max(at) FROM sign_in_attempts WHERE operator_id = $1 AND ok), 'epoch')`,
      [operatorId, new Date(now.getTime() - LOCK_WINDOW_MS)],
    );
    if ((f.rows[0]?.n ?? 0) >= LOCK_AFTER) {
      await db.query('UPDATE operators SET locked_until = $2 WHERE pk = $1', [
        o.pk,
        new Date(now.getTime() + LOCK_MS),
      ]);
      return { ok: false, reason: 'locked' };
    }
  }
  return { ok: false, reason: 'bad-credentials' };
}

export async function createSession(
  db: Db,
  operatorPk: number,
  state: Session['state'],
  now: Date,
): Promise<string> {
  const t = token();
  await db.query(
    'INSERT INTO sessions (token, operator_pk, state, last_seen) VALUES ($1, $2, $3, $4)',
    [t, operatorPk, state, now],
  );
  return t;
}

export async function loadSession(db: Db, t: string | undefined): Promise<Session | null> {
  if (!t) return null;
  const r = await db.query<{
    token: string;
    operator_pk: number | null;
    state: Session['state'];
    handoff: string | null;
    pending: Record<string, unknown> | null;
    promo_shown: boolean;
    last_seen: Date;
    expires_early_at: Date | null;
  }>('SELECT * FROM sessions WHERE token = $1', [t]);
  const s = r.rows[0];
  if (!s) return null;
  return {
    token: s.token,
    operatorPk: s.operator_pk,
    state: s.state,
    handoff: s.handoff,
    pending: s.pending,
    promoShown: s.promo_shown,
    lastSeen: new Date(s.last_seen),
    expiresEarlyAt: s.expires_early_at ? new Date(s.expires_early_at) : null,
  };
}

/** An active session that has been idle too long, or hit its early expiry, ends here. */
export async function touch(db: Db, s: Session, now: Date): Promise<boolean> {
  const idle = now.getTime() - s.lastSeen.getTime() > IDLE_MS;
  const early = s.expiresEarlyAt !== null && now >= s.expiresEarlyAt;
  if (s.state === 'active' && (idle || early)) {
    await db.query(`UPDATE sessions SET state = 'ended' WHERE token = $1`, [s.token]);
    s.state = 'ended';
    return false;
  }
  await db.query('UPDATE sessions SET last_seen = $2 WHERE token = $1', [s.token, now]);
  return s.state !== 'ended';
}

export async function setSession(
  db: Db,
  t: string,
  fields: Partial<
    Record<'state' | 'handoff' | 'pending' | 'promo_shown' | 'expires_early_at', unknown>
  >,
) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
  const vals = keys.map((k) => {
    const v = (fields as Record<string, unknown>)[k];
    return k === 'pending' && v !== null ? JSON.stringify(v) : v;
  });
  await db.query(`UPDATE sessions SET ${sets} WHERE token = $1`, [t, ...vals]);
}

export async function endSession(db: Db, t: string) {
  await db.query(`UPDATE sessions SET state = 'ended' WHERE token = $1`, [t]);
}

/** Sends a 6-digit code to the operator's phone or email in the fake inbox. */
export async function sendCode(
  db: Db,
  o: Operator,
  purpose: 'sign-in' | 'approval',
  channel: 'text' | 'email',
  brand: string,
  now: Date,
  ref: string | null = null,
): Promise<void> {
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  await db.query(
    'UPDATE one_time_codes SET used = true WHERE operator_pk = $1 AND purpose = $2 AND NOT used',
    [o.pk, purpose],
  );
  await db.query(
    'INSERT INTO one_time_codes (operator_pk, purpose, channel, code, ref, expires_at) VALUES ($1, $2, $3, $4, $5, $6)',
    [o.pk, purpose, channel, code, ref, new Date(now.getTime() + CODE_MS)],
  );
  const body =
    purpose === 'sign-in'
      ? `${brand}: your CoreLink sign-in code is ${code}. It expires in 5 minutes.`
      : `${brand}: approval code ${code} for transfer ${ref}. Give it only to the operator who asked.`;
  await db.query('INSERT INTO messages (mailbox, address, body, at) VALUES ($1, $2, $3, $4)', [
    channel === 'text' ? 'phone' : 'email',
    channel === 'text' ? o.phone : o.email,
    body,
    now,
  ]);
}

export type CodeResult = 'ok' | 'wrong' | 'expired';

export async function checkCode(
  db: Db,
  operatorPk: number,
  purpose: 'sign-in' | 'approval',
  code: string,
  now: Date,
  ref: string | null = null,
): Promise<CodeResult> {
  const r = await db.query<{
    id: number;
    code: string;
    tries: number;
    expires_at: Date;
    ref: string | null;
  }>(
    `SELECT id, code, tries, expires_at, ref FROM one_time_codes
      WHERE operator_pk = $1 AND purpose = $2 AND NOT used ORDER BY id DESC LIMIT 1`,
    [operatorPk, purpose],
  );
  const c = r.rows[0];
  if (
    !c ||
    new Date(c.expires_at) <= now ||
    c.tries >= CODE_TRIES ||
    (ref !== null && c.ref !== ref)
  )
    return 'expired';
  if (c.code !== code.trim()) {
    await db.query('UPDATE one_time_codes SET tries = tries + 1 WHERE id = $1', [c.id]);
    return 'wrong';
  }
  await db.query('UPDATE one_time_codes SET used = true WHERE id = $1', [c.id]);
  return 'ok';
}

export async function trustWorkstation(db: Db, operatorPk: number, now: Date): Promise<string> {
  const t = token();
  await db.query('INSERT INTO workstations (token, operator_pk, expires_at) VALUES ($1, $2, $3)', [
    t,
    operatorPk,
    new Date(now.getTime() + WORKSTATION_DAYS * 86_400_000),
  ]);
  return t;
}

export async function trustedOperator(
  db: Db,
  t: string | undefined,
  now: Date,
): Promise<Operator | null> {
  if (!t) return null;
  const r = await db.query<{ operator_pk: number }>(
    'SELECT operator_pk FROM workstations WHERE token = $1 AND expires_at > $2',
    [t, now],
  );
  return r.rows[0] ? operatorByPk(db, r.rows[0].operator_pk) : null;
}

/** "(***) ***-0412" and "o***@generic.bank.localhost": where a code goes, without saying all of it. */
export const maskPhone = (p: string) => `(***) ***-${p.slice(-4)}`;
export const maskEmail = (e: string) => `${e.charAt(0)}***@${e.split('@')[1] ?? ''}`;
