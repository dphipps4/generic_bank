// A guard trip (plan, §9): the bank is frozen until a person clears it on the Freezes page, and the
// run ends escalated: guard_tripped. The freeze is written here; the ending is returned for the
// Runner, which owns the run's result.
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
    ending: { status: 'escalated', code: 'guard_tripped' },
  };
}
