// Text to a vector for similarity, in this process: bge-small-en-v1.5 on CPU (plan §8). No text
// leaves the service. The model is fetched once into `cacheDir` and loaded on first use.

/** A unit-length vector of DIMENSIONS numbers for a text. */
export type Embed = (text: string) => Promise<number[]>;

export const DIMENSIONS = 384;

export const MODEL = 'Xenova/bge-small-en-v1.5';

export function localEmbedder(opts: { cacheDir?: string } = {}): Embed {
  let extract: Promise<(t: string, o: object) => Promise<{ data: ArrayLike<number> }>> | undefined;
  return async (text) => {
    extract ??= import('@huggingface/transformers').then(async ({ env, pipeline }) => {
      if (opts.cacheDir) env.cacheDir = opts.cacheDir;
      return (await pipeline('feature-extraction', MODEL, { dtype: 'fp32' })) as never;
    });
    // bge embeds a text as its first token's state, normalized.
    const out = await (await extract)(text, { pooling: 'cls', normalize: true });
    return Array.from(out.data);
  };
}

/** A vector as pgvector reads it. */
export const asVector = (v: number[]) => `[${v.join(',')}]`;

/**
 * Embeds every lesson version written without a vector, such as the base lessons a migration
 * writes: search finds them by meaning too, and a near-duplicate proposal merges into them.
 */
export async function embedMissing(
  db: { query<R>(sql: string, params?: unknown[]): Promise<{ rows: R[] }> },
  embed: Embed,
): Promise<number> {
  const missing = (
    await db.query<{ lessonId: string; version: number; text: string }>(
      `SELECT "lessonId", version, text FROM "LessonVersion" WHERE embedding IS NULL`,
    )
  ).rows;
  for (const m of missing)
    await db.query(
      `UPDATE "LessonVersion" SET embedding = $3::vector WHERE "lessonId" = $1 AND version = $2`,
      [m.lessonId, m.version, asVector(await embed(m.text))],
    );
  return missing.length;
}
