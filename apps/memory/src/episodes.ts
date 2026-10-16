// Episodes, hypotheses and lessons (plan §8, §A.6): what runs record and propose. Each write
// reads what it rests on inside its own transaction, so a run memory has not recorded is 409 and
// nothing is written.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Write } from './door.js';
import { asVector, type Embed } from './embed.js';
import { Refused, type Memory } from './memory.js';
import { demote, promote, runOf } from './rules.js';
import type { WriteHandler } from './server.js';
import { addVersion, currentOf, SAME_LESSON } from './versions.js';

export { SAME_LESSON };

const Id = z.string().min(1).max(128);
const Hash = z.string().regex(/^[\da-f]{64}$/, 'a sha256, in hex');
const Prompts = z.record(z.string(), z.string()).optional();
const Model = z.string().min(1).max(128).optional();

const Run = z.strictObject({
  id: Id,
  kind: z.enum(['task', 'factory']),
  bank: Id,
  vendor: Id.optional(),
  task: Id.optional(),
  driver: Id.optional(),
  outcome: Id,
  mark: z.enum(['promoted', 'demoted']).optional(),
  startedAt: z.coerce.date(),
  endedAt: z.coerce.date().optional(),
  model: Model,
  prompts: Prompts,
  evidenceHash: Hash.optional(),
});

const Attempt = z.strictObject({
  runId: Id,
  n: z.int().min(1),
  outcome: Id,
  failure: z.string().min(1).max(200).optional(),
  frames: z.array(Id).max(500).default([]),
  evidenceHash: Hash.optional(),
  at: z.coerce.date(),
});

const Hypothesis = z.strictObject({
  runId: Id,
  text: z.string().trim().min(1).max(600),
  model: Model,
  prompts: Prompts,
  evidenceHash: Hash.optional(),
});

const sentences = (t: string) => t.split(/(?<=[.!?])\s+/).filter(Boolean).length;

/** A lesson's advice: one to three sentences. */
export const LessonText = z
  .string()
  .trim()
  .min(1)
  .max(600)
  .refine((t) => sentences(t) <= 3, 'a lesson is one to three sentences');

const Proposal = z.strictObject({
  runId: Id,
  text: LessonText,
  area: Id,
  scenario: Id.optional(),
  scope: z.enum(['tenant', 'vendor', 'pattern']),
  confidence: z.enum(['low', 'medium', 'high']),
  /** Seen on the cited frames, or a guess. */
  seen: z.boolean(),
  frames: z.array(Id).min(1, 'a lesson cites the frames of the run it came from').max(50),
  evidenceHash: Hash,
  model: Model,
  prompts: Prompts,
});

const ReliedOn = z.strictObject({ runId: Id, lessonIds: z.array(Id).min(1).max(100) });

const json = (v: unknown) => (v === undefined ? null : JSON.stringify(v));

export function episodes(memory: Memory, embed: Embed): Partial<Record<Write, WriteHandler>> {
  return {
    // A run that promoted or demoted a driver sets off memory's rules, in the same transaction.
    async 'episodes/runs'(body, role) {
      const r = Run.parse(body);
      const [c, ...ruled] = await memory.writeAll(role, 'episodes/runs', async (tx) => {
        const added = await tx.query(
          `INSERT INTO "Run" (id, kind, bank, vendor, task, driver, outcome, mark, "startedAt", "endedAt", model, prompts, "evidenceHash")
           VALUES ($1, $2::"RunKind", $3, $4, $5, $6, $7, $8::"Mark", $9, $10, $11, $12::jsonb, $13)
           ON CONFLICT (id) DO NOTHING RETURNING id`,
          [
            r.id,
            r.kind,
            r.bank,
            r.vendor ?? null,
            r.task ?? null,
            r.driver ?? null,
            r.outcome,
            r.mark ?? null,
            r.startedAt,
            r.endedAt ?? null,
            r.model ?? null,
            json(r.prompts),
            r.evidenceHash ?? null,
          ],
        );
        if (!added.rows.length) throw new Refused(409, 'run_exists', `run ${r.id} is recorded`);
        const entry = { entity: 'Run', entityId: r.id, runId: r.id, data: r };
        if (!r.mark) return [entry];
        const run = await runOf(tx, r.id);
        return [entry, ...(r.mark === 'promoted' ? await promote(tx, run) : await demote(tx, run))];
      });
      return { run: r.id, seq: c!.seq, ruled: ruled.length };
    },

    async 'episodes/attempts'(body, role) {
      const a = Attempt.parse(body);
      const c = await memory.write(role, 'episodes/attempts', async (tx) => {
        await runOf(tx, a.runId);
        const added = await tx.query(
          `INSERT INTO "Attempt" ("runId", n, outcome, failure, frames, "evidenceHash", at)
           VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING RETURNING n`,
          [a.runId, a.n, a.outcome, a.failure ?? null, a.frames, a.evidenceHash ?? null, a.at],
        );
        if (!added.rows.length)
          throw new Refused(409, 'attempt_exists', `attempt ${a.n} of run ${a.runId} is recorded`);
        return { entity: 'Attempt', entityId: `${a.runId}/${a.n}`, runId: a.runId, data: a };
      });
      return { run: a.runId, attempt: a.n, seq: c.seq };
    },

    async hypotheses(body, role) {
      const h = Hypothesis.parse(body);
      let id = '';
      const c = await memory.write(role, 'hypotheses', async (tx) => {
        const { bank } = await runOf(tx, h.runId);
        id = (
          await tx.query<{ id: string }>(
            `INSERT INTO "Hypothesis" ("runId", bank, text, model, prompts, "evidenceHash")
             VALUES ($1, $2, $3, $4, $5::jsonb, $6) RETURNING id`,
            [h.runId, bank, h.text, h.model ?? null, json(h.prompts), h.evidenceHash ?? null],
          )
        ).rows[0]!.id;
        return { entity: 'Hypothesis', entityId: id, runId: h.runId, data: { bank, ...h } };
      });
      return { hypothesis: id, seq: c.seq };
    },

    // A near-duplicate in the same scope (the same bank, for a tenant lesson; the same vendor, for
    // a vendor lesson) gets a new version that adds this run's citation, and no lesson is added.
    async 'lessons/proposals'(body, role) {
      const p = Proposal.parse(body);
      const vector = asVector(await embed(p.text));
      const citation = { run: p.runId, frames: p.frames, hash: p.evidenceHash, seen: p.seen };
      const out = { lesson: '', version: 1, merged: false };
      const c = await memory.write(role, 'lessons/proposals', async (tx) => {
        const run = await runOf(tx, p.runId);
        if (p.scope === 'vendor' && !run.vendor)
          throw new Refused(409, 'no_vendor', `run ${p.runId} names no vendor`);
        const bank = p.scope === 'tenant' ? run.bank : null;
        const vendor = p.scope === 'pattern' ? null : run.vendor;
        const near = (
          await tx.query<{ lessonId: string; version: number; similarity: number }>(
            `SELECT v."lessonId", v.version, 1 - (v.embedding <=> $1::vector) AS similarity
             FROM "LessonVersion" v JOIN "Lesson" l ON l.id = v."lessonId" AND l.current = v.version
             WHERE v.scope = $2::"Scope" AND v.embedding IS NOT NULL
               AND (v.scope <> 'tenant' OR v.bank = $3) AND (v.scope <> 'vendor' OR v.vendor = $4)
             ORDER BY v.embedding <=> $1::vector LIMIT 1`,
            [vector, p.scope, bank, vendor],
          )
        ).rows[0];
        const provenance = [role, p.runId, p.model ?? null, json(p.prompts), p.evidenceHash];

        if (near && near.similarity >= SAME_LESSON) {
          // A disputed lesson keeps the reason it is disputed; a version waiting for a person
          // stays waiting, above this one.
          const held = (await currentOf(tx, near.lessonId))!;
          const { version, carried } = await addVersion(tx, held, {
            seen: held.seen || p.seen,
            evidence: [...held.evidence, citation],
            reason:
              held.state === 'disputed' && held.reason
                ? held.reason
                : 'a near-duplicate proposal added its evidence',
            role,
            runId: p.runId,
            model: p.model ?? null,
            prompts: p.prompts,
            evidenceHash: p.evidenceHash,
          });
          Object.assign(out, { lesson: near.lessonId, version, merged: true });
          const similarity = Math.round(near.similarity * 1e4) / 1e4;
          return {
            entity: 'Lesson',
            entityId: near.lessonId,
            runId: p.runId,
            data: { version, carried, merged: true, similarity, citation, text: p.text },
          };
        }

        const id = randomUUID();
        await tx.query(`INSERT INTO "Lesson" (id, current) VALUES ($1, 1)`, [id]);
        await tx.query(
          `INSERT INTO "LessonVersion" ("lessonId", version, text, signals, area, scenario, scope, bank, vendor, state,
             "retiredAtBanks", confidence, seen, evidence, role, "runId", model, prompts, "evidenceHash", embedding)
           VALUES ($1, 1, $2, '{}', $3, $4, $5::"Scope", $6, $7, 'proposed', '{}', $8::"Confidence", $9, $10::jsonb,
             $11::"Role", $12, $13, $14::jsonb, $15, $16::vector)`,
          [
            id,
            p.text,
            p.area,
            p.scenario ?? null,
            p.scope,
            bank,
            vendor,
            p.confidence,
            p.seen,
            JSON.stringify([citation]),
            ...provenance,
            vector,
          ],
        );
        out.lesson = id;
        const { text, area, scenario, scope, confidence, seen, model, prompts } = p;
        return {
          entity: 'Lesson',
          entityId: id,
          runId: p.runId,
          data: {
            version: 1,
            merged: false,
            state: 'proposed',
            text,
            area,
            scenario,
            scope,
            bank,
            vendor,
            confidence,
            seen,
            citation,
            model,
            prompts,
          },
        };
      });
      return { ...out, seq: c.seq };
    },

    // A lesson a run relied on is recorded once, at its current version; saying so again writes
    // nothing.
    async 'lessons/relied-on'(body, role) {
      const r = ReliedOn.parse(body);
      const c = await memory.writeIf(role, 'lessons/relied-on', async (tx) => {
        await runOf(tx, r.runId);
        const served = (
          await tx.query<{ id: string }>(
            `SELECT id FROM "Lesson" WHERE id = ANY($1) AND current > 0`,
            [r.lessonIds],
          )
        ).rows.map((l) => l.id);
        const unknown = r.lessonIds.filter((l) => !served.includes(l));
        if (unknown.length)
          throw new Refused(409, 'no_lesson', `memory serves no lesson ${unknown.join(', ')}`);
        const added = (
          await tx.query<{ lessonId: string; version: number }>(
            `INSERT INTO "Reliance" ("runId", "lessonId", version)
             SELECT $1, id, current FROM "Lesson" WHERE id = ANY($2)
             ON CONFLICT DO NOTHING RETURNING "lessonId", version`,
            [r.runId, r.lessonIds],
          )
        ).rows;
        if (!added.length) return null;
        return { entity: 'Run', entityId: r.runId, runId: r.runId, data: { reliedOn: added } };
      });
      return c ? { run: r.runId, written: true, seq: c.seq } : { run: r.runId, written: false };
    },
  };
}
