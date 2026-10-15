import { createHash } from 'node:crypto';

/** A 32-bit hash of any strings, stable across runs. */
export function hash32(...parts: (string | number)[]): number {
  return createHash('sha256').update(parts.join('\u0000')).digest().readUInt32BE(0);
}

/** A small seeded generator (mulberry32): the same seed gives the same sequence. */
export function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)] as T,
    chance: (p: number) => next() < p,
  };
}
export type Rng = ReturnType<typeof rng>;
