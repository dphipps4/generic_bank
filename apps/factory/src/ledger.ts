// The spend ledger: every model call, in the control database's ModelCall table.
import { randomUUID } from 'node:crypto';
import type { Sql } from '@gb/db';
import type { Role } from './models.js';

export interface Spend {
  runUsd: number;
  weekUsd: number;
}

export interface Call {
  runId: string;
  role: Role;
  model: string;
  tokensIn: number;
  tokensOut: number;
  tokensCached: number;
  costUsd: number;
}

export interface Ledger {
  /** What a run and the last seven days have spent; undefined when there is no such run. */
  spend(runId: string): Promise<Spend | undefined>;
  record(call: Call): Promise<void>;
}

export function sqlLedger(sql: Sql): Ledger {
  return {
    async spend(runId) {
      const { rows } = await sql.query<{ run: string | null; week: string }>(
        `SELECT (SELECT COALESCE(SUM("costUsd"), 0) FROM "ModelCall" WHERE "factoryRunId" = $1)
                  * (SELECT 1 FROM "FactoryRun" WHERE id = $1) AS run,
                (SELECT COALESCE(SUM("costUsd"), 0) FROM "ModelCall"
                  WHERE at > now() - interval '7 days') AS week`,
        [runId],
      );
      const r = rows[0];
      return r?.run == null ? undefined : { runUsd: Number(r.run), weekUsd: Number(r.week) };
    },
    async record(c) {
      // Rounded up to the hundredth of a cent the column keeps, so the ledger never counts low.
      await sql.query(
        `INSERT INTO "ModelCall" (id, "factoryRunId", role, model, "tokensIn", "tokensOut",
           "tokensCached", "costUsd") VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          randomUUID(),
          c.runId,
          c.role,
          c.model,
          c.tokensIn,
          c.tokensOut,
          c.tokensCached,
          Math.ceil(c.costUsd * 1e4) / 1e4,
        ],
      );
    },
  };
}
