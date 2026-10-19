// Hybrid search (plan §8): Postgres full-text ranking and pgvector similarity, each a ranked
// list, fused by reciprocal rank. It searches what memory serves a bank, and nothing else.
import type { Query } from './db.js';
import { asVector, type Embed } from './embed.js';

/** Reciprocal rank fusion's constant: a place in either list counts 1 / (K + place). */
export const RRF_K = 60;

/** Ranked lists of ids as one ranking, best first. */
export function fuse(...rankings: string[][]): string[] {
  const score = new Map<string, number>();
  for (const ranking of rankings)
    ranking.forEach((id, i) => score.set(id, (score.get(id) ?? 0) + 1 / (RRF_K + i + 1)));
  return [...score.keys()].sort((a, b) => score.get(b)! - score.get(a)! || (a < b ? -1 : 1));
}

/** A question as a full-text query matching any of its words. Stop words drop out. */
export const anyWord = (q: string) => (q.toLowerCase().match(/[a-z0-9]+/g) ?? []).join(' | ');

/** How far down each list is read before fusing. */
const DEPTH = 100;

/** The lessons memory serves a bank ($1) of a vendor ($2): each at its current version, never
 *  retired there, and a pattern only once confirmed (a confirmed pattern since disputed is served,
 *  with its reason). */
/** The agent a lesson is served to; 'both' asks for every lesson. */
export type Audience = 'scout' | 'supervisor' | 'both';

/** The lessons served to one agent ($n names it): its own, and those for both. */
export const servedTo = (
  n: number,
) => `FROM "Lesson" l JOIN "LessonVersion" v ON v."lessonId" = l.id AND v.version = l.current
  WHERE ($${n}::"Audience" = 'both' OR v.audience IN ('both', $${n}::"Audience")) AND v.state <> 'retired' AND NOT ($1 = ANY(COALESCE(v."retiredAtBanks", '{}')))
    AND CASE v.scope WHEN 'pattern' THEN v.state = 'confirmed' OR (v.state = 'disputed' AND EXISTS (
                       SELECT 1 FROM "LessonVersion" p WHERE p."lessonId" = l.id AND p.version < l.current
                         AND p.scope = 'pattern' AND p.state = 'confirmed'))
                     WHEN 'vendor' THEN v.vendor = $2
                     ELSE v.bank = $1 END`;

const LESSON_TEXT = `to_tsvector('english', v.text || ' ' || COALESCE(v.why, '') || ' ' ||
  COALESCE(array_to_string(v.signals, ' '), ''))`;

/** The served lessons for a question, best first, by full-text rank and similarity fused. */
export async function searchLessons(
  db: Query,
  embed: Embed,
  at: { bank: string; vendor: string | null },
  q: string,
  who: Audience,
): Promise<string[]> {
  const ids = async (sql: string, extra: unknown) =>
    (await db.query<{ id: string }>(sql, [at.bank, at.vendor, extra, who])).rows.map((r) => r.id);
  const [byText, byVector] = await Promise.all([
    ids(
      `SELECT l.id ${servedTo(4)} AND ${LESSON_TEXT} @@ to_tsquery('english', $3)
       ORDER BY ts_rank_cd(${LESSON_TEXT}, to_tsquery('english', $3)) DESC, l.id LIMIT ${DEPTH}`,
      anyWord(q),
    ),
    ids(
      `SELECT l.id ${servedTo(4)} AND v.embedding IS NOT NULL
       ORDER BY v.embedding <=> $3::vector, l.id LIMIT ${DEPTH}`,
      asVector(await embed(q)),
    ),
  ]);
  return fuse(byText, byVector);
}
