// A lesson changes only by a new version (plan §A.6). A merge or a rule builds on the current
// version and makes its own current.
import type { Query } from './db.js';
import type { Role } from './memory.js';

/** A proposal at least this similar to a held lesson in the same scope adds to that lesson. */
export const SAME_LESSON = 0.95;

/** What a lesson rests on: one citation per run. A contradiction cites its run's frames too. */
export interface Citation {
  run: string;
  frames: string[];
  hash: string;
  seen: boolean;
  contradicts?: true;
  reason?: string;
}

export type Scope = 'tenant' | 'vendor' | 'pattern';
export type State = 'proposed' | 'confirmed' | 'disputed' | 'retired';

/** A lesson's current version. */
export interface Current {
  lessonId: string;
  version: number;
  text: string;
  area: string;
  scope: Scope;
  bank: string | null;
  vendor: string | null;
  state: State;
  retiredAtBanks: string[];
  seen: boolean;
  evidence: Citation[];
  reason: string | null;
  /** A base lesson: a run may dispute it, never retire it. */
  base: boolean;
}

/** What a new version changes, and who made it. */
export interface Change {
  scope?: Scope;
  bank?: string | null;
  vendor?: string | null;
  state?: State;
  retiredAtBanks?: string[];
  seen?: boolean;
  evidence?: Citation[];
  reason: string;
  role: Role;
  runId?: string | null;
  model?: string | null;
  prompts?: unknown;
  evidenceHash?: string | null;
}

export async function currentOf(tx: Query, lessonId: string): Promise<Current | undefined> {
  return (
    await tx.query<Current>(
      `SELECT v."lessonId", v.version, v.text, v.area, v.scope::text AS scope, v.bank, v.vendor, v.state::text AS state,
         COALESCE(v."retiredAtBanks", '{}') AS "retiredAtBanks", v.seen, v.evidence, v.reason, l.base
       FROM "Lesson" l JOIN "LessonVersion" v ON v."lessonId" = l.id AND v.version = l.current
       WHERE l.id = $1`,
      [lessonId],
    )
  ).rows[0];
}

/** A new version of the lesson, built on its current one, and made current. */
export async function addVersion(tx: Query, cur: Current, c: Change): Promise<{ version: number }> {
  const version = cur.version + 1;
  await tx.query(
    `INSERT INTO "LessonVersion" ("lessonId", version, text, why, signals, area, scenario, confidence, embedding, audience,
       scope, bank, vendor, state, "retiredAtBanks", seen, evidence, reason, role, "runId", model, prompts, "evidenceHash")
     SELECT "lessonId", $3, text, why, signals, area, scenario, confidence, embedding, audience,
       $4::"Scope", $5, $6, $7::"LessonState", $8, $9, $10::jsonb, $11, $12::"Role", $13, $14, $15::jsonb, $16
     FROM "LessonVersion" WHERE "lessonId" = $1 AND version = $2`,
    [
      cur.lessonId,
      cur.version,
      version,
      c.scope ?? cur.scope,
      c.bank === undefined ? cur.bank : c.bank,
      c.vendor === undefined ? cur.vendor : c.vendor,
      c.state ?? cur.state,
      c.retiredAtBanks ?? cur.retiredAtBanks,
      c.seen ?? cur.seen,
      JSON.stringify(c.evidence ?? cur.evidence),
      c.reason,
      c.role,
      c.runId ?? null,
      c.model ?? null,
      c.prompts === undefined ? null : JSON.stringify(c.prompts),
      c.evidenceHash ?? null,
    ],
  );
  await tx.query(`UPDATE "Lesson" SET current = $2 WHERE id = $1`, [cur.lessonId, version]);
  return { version };
}
