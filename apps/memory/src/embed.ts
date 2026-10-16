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
