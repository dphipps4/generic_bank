// The factory's caps (plan §7). This file imports nothing, so no other module shapes them.
export const CAPS = {
  /** Model spend per run, in US dollars. */
  runUsd: 25,
  /** Model spend across every run in the last seven days, in US dollars. */
  weekUsd: 150,
  /** Kept back from each run's spend for writing the lessons, in US dollars. */
  lessonsReserveUsd: 1,
} as const;

export type Caps = { readonly [K in keyof typeof CAPS]: number };
