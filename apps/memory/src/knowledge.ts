// What a run reads (plan §A.6, §8): the knowledge pack it starts from, and the question behind
// `memory_query`. The pack says what is known and labels everything that is not: a proposed
// lesson is "verify before relying", a guess says so, and a disputed lesson carries its reason. A
// pattern is served only once confirmed.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Query } from './db.js';
import type { Embed } from './embed.js';
import { type Audience, searchLessons, servedTo } from './search.js';

export const TIERS = ['patterns', 'vendor', 'tenant', 'proposed', 'disputed'] as const;
type Tier = (typeof TIERS)[number];

/** The pack's size, in characters of JSON, when the caller names none. */
export const BUDGET = 24_000;

/** At most this many lessons answer one `memory_query`. */
export const QUERY_ITEMS = 8;

const Key = z.string().min(1).max(128);

/** The agent asking: each is served its own lessons, and those for both; none named, every one. */
const At = z.strictObject({
  bank: Key,
  vendor: Key.optional(),
  for: z.enum(['scout', 'supervisor', 'both']).default('both'),
});
const PackQuery = At.extend({
  /** What the run is for; the lessons most like it come first in each tier. */
  q: z.string().trim().min(1).max(500).optional(),
  budget: z.coerce.number().int().min(1000).max(200_000).default(BUDGET),
});
const AskQuery = At.extend({ q: z.string().trim().min(1).max(500) });

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
  base: boolean;
}

/** What a lesson does not yet prove. A confirmed lesson is known and carries no label. */
export function labelOf(
  l: Pick<LessonRow, 'state' | 'seen' | 'reason'> & { base?: boolean },
): string | undefined {
  if (l.state === 'disputed')
    return `disputed: ${l.reason ?? 'a run contradicted it'}${l.base ? '; a base lesson, still served' : ''}`;
  if (l.base) return 'a base lesson: true of working any such console, from the first start';
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
  ...(l.base && { base: true }),
  ...(labelOf(l) && { label: labelOf(l) }),
});

const tierOf = (l: LessonRow): Tier =>
  l.state === 'confirmed'
    ? ({ pattern: 'patterns', vendor: 'vendor', tenant: 'tenant' } as const)[l.scope]
    : l.state;

const CONFIDENCE = { high: 0, medium: 1, low: 2 };

export function knowledgeRoutes(app: FastifyInstance, db: Query, embed: Embed) {
  async function lessons(at: { bank: string; vendor: string | null }, who: Audience) {
    return (
      await db.query<LessonRow>(
        `SELECT l.id, v.version, v.text, v.why, v.area, v.scenario, v.scope::text AS scope,
           v.state::text AS state, v.confidence::text AS confidence, v.seen, v.reason,
           jsonb_array_length(v.evidence)::int AS citations,
           (SELECT count(*)::int FROM "Reliance" r WHERE r."lessonId" = l.id) AS used, l.base
         ${servedTo(3)}`,
        [at.bank, at.vendor, who],
      )
    ).rows;
  }

  app.get('/knowledge/pack', async (req) => {
    const p = PackQuery.parse(req.query);
    const at = { bank: p.bank, vendor: p.vendor ?? null };
    const rows = await lessons(at, p.for);
    const relevance = p.q ? await searchLessons(db, embed, at, p.q, p.for) : [];
    const place = (id: string) => {
      const i = relevance.indexOf(id);
      return i < 0 ? relevance.length : i;
    };
    // Rank: most like what the run is for, then most relied on (a lesson never used is ranked
    // lower, never dropped), then most confident, then most cited.
    rows.sort(
      (a, b) =>
        Number(b.base) - Number(a.base) ||
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
    };
    for (const l of rows) candidates[tierOf(l)].push(lessonItem(l));

    // The lessons fill the budget, tier by tier, in rank order. What does not fit is counted, so the
    // run knows to ask.
    const tiers = Object.fromEntries(TIERS.map((t) => [t, [] as unknown[]])) as Record<
      Tier,
      unknown[]
    >;
    const omitted: Partial<Record<Tier, number>> = {};
    let size = 0;
    for (const t of TIERS)
      for (const item of candidates[t]) {
        const cost = JSON.stringify(item).length;
        // A base lesson is always served; what is left of the budget goes to the rest.
        if ((item as { base?: boolean }).base) {
          tiers[t].push(item);
          size += cost;
        } else if (size + cost > p.budget) omitted[t] = (omitted[t] ?? 0) + 1;
        else {
          tiers[t].push(item);
          size += cost;
        }
      }
    return { bank: p.bank, vendor: at.vendor, budget: p.budget, size, tiers, omitted };
  });

  // The question behind `memory_query`: the served lessons most like it, best first.
  app.get('/knowledge/query', async (req) => {
    const a = AskQuery.parse(req.query);
    const at = { bank: a.bank, vendor: a.vendor ?? null };
    const [order, rows] = await Promise.all([
      searchLessons(db, embed, at, a.q, a.for),
      lessons(at, a.for),
    ]);
    const byId = new Map(rows.map((l) => [l.id, { kind: 'lesson', ...lessonItem(l) }]));
    return { items: order.slice(0, QUERY_ITEMS).map((id) => byId.get(id)) };
  });
}
