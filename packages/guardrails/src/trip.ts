// A guard trip (plan, §9): the bank is frozen until a person clears it on the Freezes page, the
// run ends escalated: guard_tripped, and the journal records why. The freeze is written here; the
// journal line and the ending are returned for the Runner, which owns the run's journal and its
// result.
import { randomBytes } from 'node:crypto';
import type { Sql } from './grants.js';

export interface Trip {
  runId: string;
  bank: string;
  layer: string;
  rule: string;
}

export interface Tripped {
  freezeId: string;
  /** For the run's journal, in the journal's own shape. */
  line: { intent: string; action: string; result: string };
  ending: { status: 'escalated'; code: 'guard_tripped' };
}

export async function tripGuard(sql: Sql, t: Trip, now = new Date()): Promise<Tripped> {
  const freezeId = `f_${randomBytes(8).toString('hex')}`;
  await sql.query(
    'INSERT INTO "Freeze" (id, tenant, layer, "runId", reason, "frozenAt") VALUES ($1, $2, $3, $4, $5, $6)',
    [freezeId, t.bank, t.layer, t.runId, t.rule, now],
  );
  return {
    freezeId,
    line: {
      intent: `stop: the ${t.layer} guard refused (${t.rule})`,
      action: `froze ${t.bank}`,
      result: 'escalated: guard_tripped',
    },
    ending: { status: 'escalated', code: 'guard_tripped' },
  };
}
