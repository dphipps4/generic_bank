// A lesson changes only by a new version (plan §A.6). A merge or a rule builds on the current
// version and makes its own current; a version that was waiting for a person's approval is carried
// above it, still waiting, with what the new version added, so no write skips past an approval.
import type { Query } from './db.js';
import type { Role } from './memory.js';

/** A proposal at least this similar to a held lesson in the same scope adds to that lesson, and
 *  confirmed lessons this similar at two banks, or three vendors, are one lesson proven wider. */
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

/** A lesson's current version, and the newest of its versions. */
export interface Current {
  lessonId: string;
  version: number;
  latest: number;
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
  createdAt: Date;
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
      `SELECT v."lessonId", v.version, (SELECT max(version)::int FROM "LessonVersion" WHERE "lessonId" = l.id) AS latest,
         v.text, v.area, v.scope::text AS scope, v.bank, v.vendor, v.state::text AS state,
         COALESCE(v."retiredAtBanks", '{}') AS "retiredAtBanks", v.seen, v.evidence, v.reason, v."createdAt"
       FROM "Lesson" l JOIN "LessonVersion" v ON v."lessonId" = l.id AND v.version = l.current
       WHERE l.id = $1`,
      [lessonId],
    )
  ).rows[0];
}

/** A new version of the lesson, built on its current one. It becomes current unless `pending`,
 *  when it waits for a person instead. */
export async function addVersion(
  tx: Query,
  cur: Current,
  c: Change,
  opts: { pending?: boolean } = {},
): Promise<{ version: number; carried?: number }> {
  const version = cur.latest + 1;
  const after = {
    retiredAtBanks: c.retiredAtBanks ?? cur.retiredAtBanks,
    seen: c.seen ?? cur.seen,
    evidence: JSON.stringify(c.evidence ?? cur.evidence),
  };
  await tx.query(
    `INSERT INTO "LessonVersion" ("lessonId", version, text, why, signals, area, scenario, confidence, embedding,
       scope, bank, vendor, state, "retiredAtBanks", seen, evidence, reason, role, "runId", model, prompts, "evidenceHash")
     SELECT "lessonId", $3, text, why, signals, area, scenario, confidence, embedding,
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
      after.retiredAtBanks,
      after.seen,
      after.evidence,
      c.reason,
      c.role,
      c.runId ?? null,
      c.model ?? null,
      c.prompts === undefined ? null : JSON.stringify(c.prompts),
      c.evidenceHash ?? null,
    ],
  );
  if (opts.pending) return { version };
  await tx.query(`UPDATE "Lesson" SET current = $2 WHERE id = $1`, [cur.lessonId, version]);
  if (cur.latest === cur.version) return { version };

  // A version waits above the old current one: carry it above the new one, as the person wrote it,
  // resting on what the new version rests on.
  const carried = version + 1;
  await tx.query(
    `INSERT INTO "LessonVersion" ("lessonId", version, text, why, signals, area, scenario, confidence, embedding,
       scope, bank, vendor, state, "retiredAtBanks", seen, evidence, reason, role, "runId", model, prompts, "evidenceHash")
     SELECT "lessonId", $3, text, why, signals, area, scenario, confidence, embedding,
       scope, bank, vendor, state, $4, $5, $6::jsonb, reason, role, "runId", model, prompts, "evidenceHash"
     FROM "LessonVersion" WHERE "lessonId" = $1 AND version = $2`,
    [cur.lessonId, cur.latest, carried, after.retiredAtBanks, after.seen, after.evidence],
  );
  return { version, carried };
}
