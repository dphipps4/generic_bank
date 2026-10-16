// Facts (plan §8): typed claims about a bank in a fixed vocabulary, written by code only
// on a promotion memory's records bear out, never typed in by hand and never built from page text.
// A fact is a bi-temporal row: validAt and invalidAt bound when it held at the bank, createdAt and
// expiredAt when memory believed it. A fact is closed, never deleted, so a search as of a past run
// returns what memory believed then. Saying a lesson does not hold goes through the same door, and
// the rules decide what it does.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Query } from './db.js';
import type { Write } from './door.js';
import { Refused, type Entry, type Memory } from './memory.js';
import { contradict, promoted, retire, runOf, promote } from './rules.js';
import { anyWord, FACT_TEXT } from './search.js';
import type { WriteHandler } from './server.js';

/** What a fact may say, and whether a bank holds one value of it or many. A new value of a
 *  single-valued predicate closes the old one. */
export const VOCABULARY = {
  /** A screen the factory mapped, by its screen id: `transfer.review`. */
  has_screen: { one: false, object: /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/ },
  /** How a fresh sign-in's staff code arrives. */
  code_sent_by: { one: true, object: /^(email|text|authenticator|chooser)$/ },
  /** The product and version the bank runs: `corelink 4.3`. */
  runs_product: { one: true, object: /^[a-z][a-z0-9-]* \d+(\.\d+)*$/ },
} as const;

const Id = z.string().min(1).max(128);
const Reason = z.string().trim().min(1).max(500);
const Hash = z.string().regex(/^[\da-f]{64}$/, 'a sha256, in hex');

const Fact = z
  .strictObject({
    predicate: z.enum(Object.keys(VOCABULARY) as [keyof typeof VOCABULARY]),
    object: z.string(),
  })
  .refine(
    (f) => VOCABULARY[f.predicate].object.test(f.object),
    'the object is not in the vocabulary',
  );

const Facts = z.strictObject({ runId: Id, facts: z.array(Fact).min(1).max(200) });

const Invalidate = z.union([
  z.strictObject({ factId: z.uuid(), runId: Id.optional(), reason: Reason }),
  z.strictObject({
    lessonId: Id,
    runId: Id,
    reason: Reason,
    frames: z.array(Id).min(1, 'a contradiction cites the frames that show it').max(50),
    evidenceHash: Hash,
  }),
]);

const Confirm = z.strictObject({ runId: Id });
const Retire = z.strictObject({ lessonId: Id, reason: Reason, bank: Id.optional() });

const Search = z.strictObject({
  bank: Id,
  q: z.string().trim().min(1).max(500).optional(),
  predicate: z.enum(Object.keys(VOCABULARY) as [keyof typeof VOCABULARY]).optional(),
  /** What memory believed when this run started. */
  asOf: Id.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const FACT = `id, bank, predicate, object, "runId", "validAt", "invalidAt", "createdAt", "expiredAt"`;

/** The facts memory believed about a bank at a time: written by then, and not yet closed. */
export async function factsAt(
  db: Query,
  f: { bank: string; at: Date; q?: string; predicate?: string; limit: number },
) {
  return (
    await db.query(
      `SELECT ${FACT} FROM "Fact"
       WHERE bank = $1 AND "createdAt" <= $2 AND ("expiredAt" IS NULL OR "expiredAt" > $2)
         AND ($3::text IS NULL OR predicate = $3)
         AND ($4::text IS NULL OR ${FACT_TEXT} @@ to_tsquery('english', $4))
       ORDER BY predicate, object LIMIT $5`,
      [f.bank, f.at, f.predicate ?? null, f.q ? anyWord(f.q) : null, f.limit],
    )
  ).rows;
}

export function facts(memory: Memory): Partial<Record<Write, WriteHandler>> {
  return {
    // Each fact once; a new value of a single-valued predicate closes the one it replaces.
    async facts(body, role) {
      const w = Facts.parse(body);
      const added: string[] = [];
      const closed: string[] = [];
      const changes = await memory.writeAll(role, 'facts', async (tx) => {
        const run = await runOf(tx, w.runId);
        if (!(await promoted(tx, run)))
          throw new Refused(
            409,
            'no_successful_run',
            `run ${run.id} is not a successful promotion that memory's records bear out`,
          );
        const validAt = run.startedAt;
        const out: Entry[] = [];
        for (const f of w.facts) {
          const held = (
            await tx.query<{ id: string; object: string }>(
              `SELECT id, object FROM "Fact" WHERE bank = $1 AND predicate = $2 AND "expiredAt" IS NULL`,
              [run.bank, f.predicate],
            )
          ).rows;
          if (held.some((h) => h.object === f.object)) continue;
          if (VOCABULARY[f.predicate].one)
            for (const h of held) {
              await tx.query(
                `UPDATE "Fact" SET "invalidAt" = $2, "expiredAt" = now() WHERE id = $1`,
                [h.id, validAt],
              );
              closed.push(h.id);
              out.push({
                entity: 'Fact',
                entityId: h.id,
                runId: run.id,
                data: {
                  closed: true,
                  predicate: f.predicate,
                  object: h.object,
                  replacedBy: f.object,
                },
              });
            }
          const id = (
            await tx.query<{ id: string }>(
              `INSERT INTO "Fact" (bank, predicate, object, "runId", "validAt") VALUES ($1, $2, $3, $4, $5) RETURNING id`,
              [run.bank, f.predicate, f.object, run.id, validAt],
            )
          ).rows[0]!.id;
          added.push(id);
          out.push({
            entity: 'Fact',
            entityId: id,
            runId: run.id,
            data: { bank: run.bank, ...f, validAt },
          });
        }
        return out;
      });
      return { added, closed, written: changes.length > 0 };
    },

    // Close a fact, backed by a failed run at its bank or by a person's reason; or say, citing a
    // run's frames, that a lesson does not hold.
    async 'facts/invalidate'(body, role) {
      const w = Invalidate.parse(body);
      if ('lessonId' in w) {
        const c = await memory.writeIf(role, 'facts/invalidate', (tx) => contradict(tx, role, w));
        return c
          ? { lesson: w.lessonId, written: true, seq: c.seq, ...(c.data as object) }
          : { lesson: w.lessonId, written: false };
      }
      const c = await memory.writeIf(role, 'facts/invalidate', async (tx) => {
        const fact = (
          await tx.query<{ bank: string; expiredAt: Date | null }>(
            `SELECT bank, "expiredAt" FROM "Fact" WHERE id = $1`,
            [w.factId],
          )
        ).rows[0];
        if (!fact) throw new Refused(409, 'no_fact', `memory holds no fact ${w.factId}`);
        if (fact.expiredAt) return null;
        let invalidAt = new Date();
        if (w.runId) {
          const run = await runOf(tx, w.runId);
          if (run.bank !== fact.bank || run.outcome === 'succeeded')
            throw new Refused(
              409,
              'no_failed_run',
              `run ${run.id} is no failed run at ${fact.bank}`,
            );
          invalidAt = run.startedAt;
        } else if (role !== 'curator')
          throw new Refused(
            409,
            'no_failed_run',
            'only a person closes a fact without a failed run',
          );
        await tx.query(`UPDATE "Fact" SET "invalidAt" = $2, "expiredAt" = now() WHERE id = $1`, [
          w.factId,
          invalidAt,
        ]);
        return {
          entity: 'Fact',
          entityId: w.factId,
          runId: w.runId ?? null,
          data: { closed: true, invalidAt, reason: w.reason },
        };
      });
      return { fact: w.factId, written: !!c, ...(c && { seq: c.seq }) };
    },

    // The promotion rules again, for what arrived after the run's mark. Unchanged, nothing is written.
    async 'lessons/confirm'(body, role) {
      const w = Confirm.parse(body);
      const changes = await memory.writeAll(role, 'lessons/confirm', async (tx) => {
        const run = await runOf(tx, w.runId);
        if (!(await promoted(tx, run)))
          throw new Refused(
            409,
            'no_successful_run',
            `run ${run.id} is not a successful promotion that memory's records bear out`,
          );
        return promote(tx, run);
      });
      return { run: w.runId, written: changes.length > 0, changes: changes.map(summary) };
    },

    async 'lessons/retire'(body, role) {
      const w = Retire.parse(body);
      const c = await memory.writeIf(role, 'lessons/retire', (tx) => retire(tx, role, w));
      return { lesson: w.lessonId, written: !!c, ...(c && { seq: c.seq }) };
    },
  };
}

const summary = (c: { seq: number; action: string; entityId: string; data: unknown }) => ({
  seq: c.seq,
  action: c.action,
  lesson: c.entityId,
  ...(c.data as object),
});

export function factRoutes(app: FastifyInstance, db: Query) {
  app.get('/facts', async (req) => {
    const { bank } = z.strictObject({ bank: Id }).parse(req.query);
    return { facts: await factsAt(db, { bank, at: new Date(), limit: 200 }) };
  });

  app.get('/facts/search', async (req) => {
    const s = Search.parse(req.query);
    let at = new Date();
    if (s.asOf) {
      const run = (
        await db.query<{ startedAt: Date }>(`SELECT "startedAt" FROM "Run" WHERE id = $1`, [s.asOf])
      ).rows[0];
      if (!run) throw new Refused(404, 'not_found', `memory holds no run ${s.asOf}`);
      at = run.startedAt;
    }
    return { at, facts: await factsAt(db, { ...s, at }) };
  });
}
