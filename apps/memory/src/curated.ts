// What a person curates (plan §K.8, §K.10): rules, checks, scenarios, approaches and lessons. Each
// save is a new version that waits, unserved, until approved; one approval can make a whole set
// current, as the seed does. A save the same as the latest version writes nothing, and the catalog
// and lessons read at any version.
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Query } from './db.js';
import type { Write } from './door.js';
import { asVector, type Embed } from './embed.js';
import { LessonText } from './episodes.js';
import { canonical, Refused, type Memory } from './memory.js';
import type { WriteHandler } from './server.js';

/** The catalog's routes, and the kind each holds. */
export const CATALOG = {
  rules: 'rule',
  checks: 'check',
  scenarios: 'scenario',
  approaches: 'approach',
} as const;

const Key = z.string().min(1).max(128);
const Reason = z.string().trim().min(1).max(500);
const Kind = z.enum(['rule', 'check', 'scenario', 'approach', 'lesson']);

const Lesson = z
  .strictObject({
    text: LessonText,
    why: z.string().trim().min(1).max(600).optional(),
    signals: z.array(z.string().min(1).max(120)).max(30).default([]),
    area: Key,
    scenario: Key.optional(),
    scope: z.enum(['tenant', 'vendor', 'pattern']),
    bank: Key.optional(),
    vendor: Key.optional(),
    confidence: z.enum(['low', 'medium', 'high']),
  })
  .refine(
    (l) => (l.scope === 'tenant') === !!l.bank && (l.scope !== 'vendor' || !!l.vendor),
    'a tenant lesson names its bank, a vendor lesson its vendor, and a pattern neither',
  )
  .refine((l) => l.scope !== 'pattern' || !l.vendor, 'a pattern names no vendor');

const Curated = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('lesson'), key: Key, lesson: Lesson, reason: Reason }),
  z.strictObject({
    kind: z.enum(['rule', 'check', 'scenario', 'approach']),
    key: Key,
    body: z.record(z.string(), z.unknown()),
    reason: Reason,
  }),
]);

const Approve = z.strictObject({
  set: Key.optional(),
  reason: Reason,
  versions: z
    .array(z.strictObject({ kind: Kind, key: Key, version: z.int().min(1) }))
    .min(1)
    .max(2000),
});

const AtVersion = z.strictObject({ version: z.coerce.number().int().min(1).optional() });

const LESSON = `v."lessonId" AS key, v.version, l.current, v.text, v.why, v.signals, v.area, v.scenario,
  v.scope::text AS scope, v.bank, v.vendor, v.state::text AS state, v."retiredAtBanks", v.confidence::text AS confidence,
  v.seen, v.evidence, v.reason, v.role::text AS role, v."runId", v."createdAt"`;

/** Where each kind keeps its current version (the head), and its versions, for the key $1. */
const tables = (kind: z.infer<typeof Kind>) =>
  kind === 'lesson'
    ? { head: `"Lesson" WHERE id = $1`, versions: `"LessonVersion" WHERE "lessonId" = $1` }
    : {
        head: `"CatalogEntry" WHERE kind = '${kind}' AND key = $1`,
        versions: `"CatalogVersion" WHERE kind = '${kind}' AND key = $1`,
      };

async function latest<R>(tx: Query, kind: z.infer<typeof Kind>, key: string, columns: string) {
  return (
    await tx.query<R & { version: number }>(
      `SELECT version, ${columns} FROM ${tables(kind).versions} ORDER BY version DESC LIMIT 1`,
      [key],
    )
  ).rows[0];
}

async function currentOf(tx: Query, kind: z.infer<typeof Kind>, key: string) {
  return (await tx.query<{ current: number }>(`SELECT current FROM ${tables(kind).head}`, [key]))
    .rows[0]?.current;
}

async function setCurrent(tx: Query, kind: z.infer<typeof Kind>, key: string, version: number) {
  const [table, where] = tables(kind).head.split(' WHERE ');
  await tx.query(`UPDATE ${table} SET current = $2 WHERE ${where}`, [key, version]);
}

export function curated(memory: Memory, embed: Embed): Partial<Record<Write, WriteHandler>> {
  return {
    async curated(body, role) {
      const c = Curated.parse(body);
      const vector = c.kind === 'lesson' ? asVector(await embed(c.lesson.text)) : null;
      const out = { kind: c.kind, key: c.key, version: 0, current: 0, written: false };
      const change = await memory.writeIf(role, 'curated', async (tx) => {
        if (c.kind === 'lesson') {
          const l = { why: null, scenario: null, bank: null, vendor: null, ...c.lesson };
          const held = await latest<Record<string, unknown>>(
            tx,
            'lesson',
            c.key,
            `text, why, signals, area, scenario, scope::text AS scope, bank, vendor,
             confidence::text AS confidence, seen, evidence`,
          );
          out.current = (await currentOf(tx, 'lesson', c.key)) ?? 0;
          const fields = (x: Record<string, unknown>) =>
            canonical([
              x.text,
              x.why,
              x.signals,
              x.area,
              x.scenario,
              x.scope,
              x.bank,
              x.vendor,
              x.confidence,
            ]);
          if (held && fields(held) === fields(l)) {
            out.version = held.version;
            return null;
          }
          out.version = (held?.version ?? 0) + 1;
          await tx.query(`INSERT INTO "Lesson" (id) VALUES ($1) ON CONFLICT DO NOTHING`, [c.key]);
          // A person's version is confirmed once approved; it keeps what the lesson rests on.
          await tx.query(
            `INSERT INTO "LessonVersion" ("lessonId", version, text, why, signals, area, scenario, scope, bank, vendor,
               state, "retiredAtBanks", confidence, seen, evidence, reason, role, embedding)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8::"Scope", $9, $10, 'confirmed', '{}', $11::"Confidence",
               $12, $13::jsonb, $14, $15::"Role", $16::vector)`,
            [
              c.key,
              out.version,
              l.text,
              l.why,
              l.signals,
              l.area,
              l.scenario,
              l.scope,
              l.bank,
              l.vendor,
              l.confidence,
              held?.seen ?? false,
              JSON.stringify(held?.evidence ?? []),
              c.reason,
              role,
              vector,
            ],
          );
          return {
            entity: 'Lesson',
            entityId: c.key,
            data: { version: out.version, state: 'confirmed', ...l, reason: c.reason },
          };
        }

        const held = await latest<{ body: unknown }>(tx, c.kind, c.key, 'body');
        out.current = (await currentOf(tx, c.kind, c.key)) ?? 0;
        if (held && canonical(held.body) === canonical(c.body)) {
          out.version = held.version;
          return null;
        }
        out.version = (held?.version ?? 0) + 1;
        await tx.query(
          `INSERT INTO "CatalogEntry" (kind, key) VALUES ($1::"CatalogKind", $2) ON CONFLICT DO NOTHING`,
          [c.kind, c.key],
        );
        await tx.query(
          `INSERT INTO "CatalogVersion" (kind, key, version, body, role, reason)
           VALUES ($1::"CatalogKind", $2, $3, $4::jsonb, $5::"Role", $6)`,
          [c.kind, c.key, out.version, JSON.stringify(c.body), role, c.reason],
        );
        return {
          entity: 'CatalogEntry',
          entityId: `${c.kind}/${c.key}`,
          data: { version: out.version, body: c.body, reason: c.reason },
        };
      });
      return { ...out, written: !!change, ...(change && { seq: change.seq }) };
    },

    // One approval, one change-log row, for every version it makes current. A version already
    // current is passed over; one below the current version would move it backward and is 409.
    async 'curated/approve'(body, role) {
      const a = Approve.parse(body);
      const id = a.set ?? randomUUID();
      const approved: z.infer<typeof Approve>['versions'] = [];
      const change = await memory.writeIf(role, 'curated/approve', async (tx) => {
        for (const v of a.versions) {
          const current = await currentOf(tx, v.kind, v.key);
          const held = await tx.query(`SELECT 1 FROM ${tables(v.kind).versions} AND version = $2`, [
            v.key,
            v.version,
          ]);
          if (current === undefined || !held.rows.length)
            throw new Refused(409, 'no_version', `${v.kind} ${v.key} has no version ${v.version}`);
          if (v.version < current)
            throw new Refused(
              409,
              'backward',
              `${v.kind} ${v.key} is at version ${current}; approving ${v.version} would move it backward`,
            );
          if (v.version === current) continue;
          await setCurrent(tx, v.kind, v.key, v.version);
          approved.push(v);
        }
        if (!approved.length) return null;
        return { entity: 'Approval', entityId: id, data: { reason: a.reason, versions: approved } };
      });
      return { approval: id, approved: approved.length, written: !!change, seq: change?.seq };
    },
  };
}

/** The catalog and the lessons as served, or any one entry at any version. */
export function catalogRoutes(app: FastifyInstance, db: Query) {
  for (const [path, kind] of Object.entries(CATALOG)) {
    app.get(`/${path}`, async () => ({
      entries: (
        await db.query(
          `SELECT e.key, v.version, e.current, v.body FROM "CatalogEntry" e
           JOIN "CatalogVersion" v ON v.kind = e.kind AND v.key = e.key AND v.version = e.current
           WHERE e.kind = $1::"CatalogKind" ORDER BY e.key`,
          [kind],
        )
      ).rows,
    }));
    app.get<{ Params: { key: string } }>(`/${path}/:key`, async (req) => {
      const { version } = AtVersion.parse(req.query);
      const row = (
        await db.query(
          `SELECT e.key, v.version, e.current, v.body, v.role::text AS role, v.reason, v."createdAt"
           FROM "CatalogEntry" e JOIN "CatalogVersion" v ON v.kind = e.kind AND v.key = e.key
           WHERE e.kind = $1::"CatalogKind" AND e.key = $2 AND v.version = COALESCE($3, e.current)`,
          [kind, req.params.key, version ?? null],
        )
      ).rows[0];
      if (!row) throw new Refused(404, 'not_found', `no ${kind} ${req.params.key} at that version`);
      return row;
    });
  }

  app.get('/lessons', async () => ({
    lessons: (
      await db.query(
        `SELECT ${LESSON} FROM "Lesson" l JOIN "LessonVersion" v ON v."lessonId" = l.id AND v.version = l.current
         ORDER BY l.id`,
      )
    ).rows,
  }));
  app.get<{ Params: { id: string } }>('/lessons/:id', async (req) => {
    const { version } = AtVersion.parse(req.query);
    const row = (
      await db.query(
        `SELECT ${LESSON} FROM "Lesson" l JOIN "LessonVersion" v ON v."lessonId" = l.id
         WHERE l.id = $1 AND v.version = COALESCE($2, l.current)`,
        [req.params.id, version ?? null],
      )
    ).rows[0];
    if (!row) throw new Refused(404, 'not_found', `no lesson ${req.params.id} at that version`);
    return row;
  });
}
