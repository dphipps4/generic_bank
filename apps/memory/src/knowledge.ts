// What a run reads (plan §K.4, §K.8): the knowledge pack it starts from, the question behind
// `memory_query`, and the episodes: similar failures, a bank's latest attempts and a vendor's
// recurring failures. The pack says what is known and labels everything that is not: a proposed
// lesson is "verify before relying", a guess says so, and a disputed lesson carries its reason. A
// hypothesis is never read here, and a pattern is served only once confirmed.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Query } from './db.js';
import type { Embed } from './embed.js';
import { anyWord, failureSearch, fuse, searchLessons, SERVED } from './search.js';

export const TIERS = [
  'patterns',
  'vendor',
  'tenant',
  'proposed',
  'disputed',
  'recent',
  'recurring',
  'drivers',
] as const;
type Tier = (typeof TIERS)[number];

/** The pack's size, in characters of JSON, when the caller names none. */
export const BUDGET = 24_000;

/** At most this many items, and this many facts, answer one `memory_query`. */
export const QUERY_ITEMS = 8;
export const QUERY_FACTS = 3;

const Key = z.string().min(1).max(128);
const Limit = (n: number, max: number) => z.coerce.number().int().min(1).max(max).default(n);

const At = z.strictObject({ bank: Key, vendor: Key.optional() });
const PackQuery = At.extend({
  /** What the run is for; the lessons most like it come first in each tier. */
  q: z.string().trim().min(1).max(500).optional(),
  budget: z.coerce.number().int().min(1000).max(200_000).default(BUDGET),
});
const AskQuery = At.extend({ q: z.string().trim().min(1).max(500) });
const SearchQuery = z.strictObject({
  q: z.string().trim().min(1).max(500),
  bank: Key.optional(),
  vendor: Key.optional(),
  limit: Limit(5, 20),
});
const RecentQuery = z.strictObject({ bank: Key, limit: Limit(10, 50) });
const RecurringQuery = z.strictObject({ vendor: Key, limit: Limit(5, 20) });

interface LessonRow {
  id: string;
  version: number;
  text: string;
  why: string | null;
  area: string;
  scenario: string | null;
  scope: 'tenant' | 'vendor' | 'pattern';
  state: 'proposed' | 'confirmed' | 'disputed';
  confidence: 'low' | 'medium' | 'high';
  seen: boolean;
  reason: string | null;
  used: number;
  citations: number;
}

/** What a lesson does not yet prove. A confirmed lesson is known and carries no label; a seeded
 *  lesson is confirmed by the person who approved it, so it is never read as a guess. */
export function labelOf(l: Pick<LessonRow, 'state' | 'seen' | 'reason'>): string | undefined {
  if (l.state === 'disputed') return `disputed: ${l.reason ?? 'a run contradicted it'}`;
  if (l.state === 'proposed')
    return l.seen ? 'verify before relying' : 'a guess: verify before relying';
  return undefined;
}

/** A lesson as a run reads it. */
const lessonItem = (l: LessonRow) => ({
  id: l.id,
  version: l.version,
  text: l.text,
  ...(l.why && { why: l.why }),
  area: l.area,
  ...(l.scenario && { scenario: l.scenario }),
  scope: l.scope,
  state: l.state,
  confidence: l.confidence,
  seen: l.seen,
  ...(labelOf(l) && { label: labelOf(l) }),
});

const tierOf = (l: LessonRow): Tier =>
  l.state === 'confirmed'
    ? ({ pattern: 'patterns', vendor: 'vendor', tenant: 'tenant' } as const)[l.scope]
    : l.state;

const CONFIDENCE = { high: 0, medium: 1, low: 2 };

/** A failure signature across runs: how many runs and banks it ended, and when last. */
const FAILURES = `SELECT a.failure, count(DISTINCT a."runId")::int AS runs,
    array_agg(DISTINCT r.bank ORDER BY r.bank) AS banks, max(a.at) AS "lastAt"`;

/** A fact's words: `has_screen` and `statements.list` read as words. */
const FACT_TEXT = `to_tsvector('english', translate(predicate || ' ' || object, '._', '  '))`;

export function knowledgeRoutes(app: FastifyInstance, db: Query, embed: Embed) {
  const rankFailures = failureSearch(embed);

  async function lessons(at: { bank: string; vendor: string | null }) {
    return (
      await db.query<LessonRow>(
        `SELECT l.id, v.version, v.text, v.why, v.area, v.scenario, v.scope::text AS scope,
           v.state::text AS state, v.confidence::text AS confidence, v.seen, v.reason,
           jsonb_array_length(v.evidence)::int AS citations,
           (SELECT count(*)::int FROM "Reliance" r WHERE r."lessonId" = l.id) AS used
         ${SERVED}`,
        [at.bank, at.vendor],
      )
    ).rows;
  }

  const recent = async (bank: string, limit: number) =>
    (
      await db.query(
        `SELECT a."runId" AS run, a.n, r.kind::text AS kind, r.task, a.outcome, a.failure, a.at
         FROM "Attempt" a JOIN "Run" r ON r.id = a."runId"
         WHERE r.bank = $1 ORDER BY a.at DESC, a.n DESC LIMIT $2`,
        [bank, limit],
      )
    ).rows;

  const recurring = async (vendor: string, limit: number) =>
    (
      await db.query(
        `${FAILURES} FROM "Attempt" a JOIN "Run" r ON r.id = a."runId"
         WHERE a.failure IS NOT NULL AND r.vendor = $1
         GROUP BY a.failure HAVING count(DISTINCT a."runId") >= 2
         ORDER BY runs DESC, "lastAt" DESC, a.failure LIMIT $2`,
        [vendor, limit],
      )
    ).rows;

  // The crawler each bank runs now: its latest promotion that no later demotion undid. This
  // bank's own comes first, then the vendor's, then the newest.
  async function drivers(at: { bank: string; vendor: string | null }) {
    const rows = (
      await db.query<{ driver: string; bank: string; vendor: string | null; promotedAt: Date }>(
        `SELECT DISTINCT ON (p.bank) p.driver, p.bank, p.vendor, COALESCE(p."endedAt", p."startedAt") AS "promotedAt"
         FROM "Run" p
         WHERE p.mark = 'promoted' AND p.driver IS NOT NULL AND NOT EXISTS (
           SELECT 1 FROM "Run" d WHERE d.mark = 'demoted' AND d.driver = p.driver AND d."startedAt" > p."startedAt")
         ORDER BY p.bank, p."startedAt" DESC`,
      )
    ).rows;
    const near = (d: (typeof rows)[number]) =>
      (d.bank === at.bank ? 0 : 2) + (at.vendor && d.vendor === at.vendor ? 0 : 1);
    return rows.sort((a, b) => near(a) - near(b) || +b.promotedAt - +a.promotedAt).slice(0, 2);
  }

  app.get('/knowledge/pack', async (req) => {
    const p = PackQuery.parse(req.query);
    const at = { bank: p.bank, vendor: p.vendor ?? null };
    const rows = await lessons(at);
    const relevance = p.q ? await searchLessons(db, embed, at, p.q) : [];
    const place = (id: string) => {
      const i = relevance.indexOf(id);
      return i < 0 ? relevance.length : i;
    };
    // Rank: most like what the run is for, then most relied on (a lesson never used is ranked
    // lower, never dropped), then most confident, then most cited.
    rows.sort(
      (a, b) =>
        place(a.id) - place(b.id) ||
        b.used - a.used ||
        CONFIDENCE[a.confidence] - CONFIDENCE[b.confidence] ||
        b.citations - a.citations ||
        (a.id < b.id ? -1 : 1),
    );

    const candidates: Record<Tier, unknown[]> = {
      patterns: [],
      vendor: [],
      tenant: [],
      proposed: [],
      disputed: [],
      recent: await recent(p.bank, 5),
      recurring: at.vendor ? await recurring(at.vendor, 5) : [],
      drivers: await drivers(at),
    };
    for (const l of rows) candidates[tierOf(l)].push(lessonItem(l));

    // The episodes and drivers are few, and fit first; the lessons fill what is left, tier by
    // tier, in rank order. What does not fit is counted, so the run knows to ask.
    const tiers = Object.fromEntries(TIERS.map((t) => [t, [] as unknown[]])) as Record<
      Tier,
      unknown[]
    >;
    const omitted: Partial<Record<Tier, number>> = {};
    let size = 0;
    const fill = ['recent', 'recurring', 'drivers', ...TIERS.slice(0, 5)] as Tier[];
    for (const t of fill)
      for (const item of candidates[t]) {
        const cost = JSON.stringify(item).length;
        if (size + cost > p.budget) omitted[t] = (omitted[t] ?? 0) + 1;
        else {
          tiers[t].push(item);
          size += cost;
        }
      }
    return { bank: p.bank, vendor: at.vendor, budget: p.budget, size, tiers, omitted };
  });

  // The question behind `memory_query`: served lessons and scenarios fused into one ranking, and
  // the bank's served facts, never a hypothesis.
  app.get('/knowledge/query', async (req) => {
    const a = AskQuery.parse(req.query);
    const at = { bank: a.bank, vendor: a.vendor ?? null };
    const words = anyWord(a.q);
    const [lessonOrder, rows, scenarios, facts] = await Promise.all([
      searchLessons(db, embed, at, a.q),
      lessons(at),
      db.query<{ key: string; body: Record<string, unknown> }>(
        `SELECT e.key, v.body FROM "CatalogEntry" e
         JOIN "CatalogVersion" v ON v.kind = e.kind AND v.key = e.key AND v.version = e.current
         WHERE e.kind = 'scenario' AND jsonb_to_tsvector('english', v.body, '["string"]') @@ to_tsquery('english', $1)
         ORDER BY ts_rank_cd(jsonb_to_tsvector('english', v.body, '["string"]'), to_tsquery('english', $1)) DESC, e.key
         LIMIT ${QUERY_ITEMS}`,
        [words],
      ),
      db.query(
        `SELECT id, predicate, object, "validAt", "runId" FROM "Fact"
         WHERE bank = $1 AND "invalidAt" IS NULL AND "expiredAt" IS NULL
           AND ${FACT_TEXT} @@ to_tsquery('english', $2)
         ORDER BY ts_rank_cd(${FACT_TEXT}, to_tsquery('english', $2)) DESC, "validAt" DESC
         LIMIT ${QUERY_FACTS}`,
        [a.bank, words],
      ),
    ]);
    const byId = new Map(rows.map((l) => [`lesson:${l.id}`, { kind: 'lesson', ...lessonItem(l) }]));
    const byKey = new Map(
      scenarios.rows.map((s) => [`scenario:${s.key}`, { ...s.body, id: s.key, kind: 'scenario' }]),
    );
    const order = fuse(
      lessonOrder.map((id) => `lesson:${id}`),
      scenarios.rows.map((s) => `scenario:${s.key}`),
    );
    return {
      items: order.slice(0, QUERY_ITEMS).map((k) => byId.get(k) ?? byKey.get(k)),
      facts: facts.rows,
    };
  });

  app.get('/episodes/search', async (req) => {
    const s = SearchQuery.parse(req.query);
    const rows = (
      await db.query<{ failure: string; rank: number }>(
        `${FAILURES}, ts_rank_cd(to_tsvector('english', a.failure), to_tsquery('english', $3)) AS rank
         FROM "Attempt" a JOIN "Run" r ON r.id = a."runId"
         WHERE a.failure IS NOT NULL AND ($1::text IS NULL OR r.bank = $1) AND ($2::text IS NULL OR r.vendor = $2)
         GROUP BY a.failure ORDER BY "lastAt" DESC LIMIT 500`,
        [s.bank ?? null, s.vendor ?? null, anyWord(s.q)],
      )
    ).rows;
    const ranked = await rankFailures(rows, s.q);
    return { failures: ranked.slice(0, s.limit).map(({ rank: _, ...f }) => f) };
  });

  app.get('/episodes/recent', async (req) => {
    const r = RecentQuery.parse(req.query);
    return { attempts: await recent(r.bank, r.limit) };
  });

  app.get('/episodes/recurring', async (req) => {
    const r = RecurringQuery.parse(req.query);
    return { failures: await recurring(r.vendor, r.limit) };
  });
}
