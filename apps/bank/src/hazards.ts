import { createHmac, timingSafeEqual } from 'node:crypto';
import { hash32, rng } from './rng.js';

// "Stable UIs, but real runtime errors." Ambient hazards draw from a seeded stream on every
// request; forced hazards are named in a signed header and nothing else happens.

// Chances per page. A run loads about 20 pages, so the hazards that could stop one (all but a
// harmless script error, a dialog, a promotion and a slow handoff) reach about 1 run in 240, before
// the Runner recovers from any. Never on the transfer pages: there, hazards are forced only.
export const AMBIENT = {
  'js-error-harmless': 0.02,
  'js-error-widget': 0.00005,
  'js-error-fatal': 0.00002,
  'service-unavailable': 0.0001,
  'confirm-dialog': 0.01,
  promo: 0.01,
  'record-in-use': 0.00002,
  'early-expiry': 0.00002,
  'slow-handoff': 0.02,
} as const;

export const FORCED_ONLY = [
  'swallowed-submit',
  'swallowed-click',
  'late-rows',
  'injected-instruction',
  'unknown-screen',
  'permission-denial',
  'record-not-found',
  'validation-error',
] as const;

export type AmbientHazard = keyof typeof AMBIENT;
export type HazardName = AmbientHazard | (typeof FORCED_ONLY)[number] | 'latency';
export const HAZARD_NAMES: readonly HazardName[] = [
  'latency',
  ...(Object.keys(AMBIENT) as AmbientHazard[]),
  ...FORCED_ONLY,
];

/** `none` is for the bank's own unit tests; the running banks use the other three. */
export type Profile = 'default' | 'gentle' | 'harsh' | 'none';
const SCALE: Record<Profile, number> = { default: 1, gentle: 0.25, harsh: 2, none: 0 };

// The stopping hazards' total per-page rate at scale 1 and the pages a run loads, used to compute
// the scale from a target run-rate percentage.
const STOPPING: readonly (keyof typeof AMBIENT)[] = [
  'js-error-widget',
  'js-error-fatal',
  'service-unavailable',
  'record-in-use',
  'early-expiry',
];
const STOPPING_RATE = STOPPING.reduce((s, k) => s + AMBIENT[k], 0);
const PAGES_PER_RUN = 20;

/** The scale that gives `pct`% of runs at least one stopping hazard over ~20 pages. */
export function scaleForRunRate(pct: number): number {
  if (pct <= 0) return 0;
  if (pct >= 100) return 1 / (STOPPING_RATE * PAGES_PER_RUN);
  return -Math.log(1 - pct / 100) / (STOPPING_RATE * PAGES_PER_RUN);
}

export interface RequestHazards {
  readonly forced: boolean;
  /** Whether a hazard fires on this request. A hazard that fires is logged. */
  on(name: HazardName): boolean;
  latencyMs(): number;
}

export interface HazardOptions {
  profile: Profile;
  /** Overrides the profile's scale: what percentage of runs should hit a stopping hazard. */
  runRatePct?: number;
  seed: number;
  forceable: boolean;
  hmacKey: string;
  log: (hazard: HazardName, path: string, forced: boolean) => void;
}

export const HEADER = 'x-hazards';

/** The header value that forces exactly `names`: `names;signature`. */
export function signHazards(names: readonly HazardName[], key: string): string {
  const list = [...names].sort().join(',');
  return `${list};${createHmac('sha256', key).update(list).digest('hex')}`;
}

function verify(value: string, key: string): HazardName[] | null {
  const i = value.lastIndexOf(';');
  if (i < 0 || !key) return null;
  const list = value.slice(0, i);
  const want = createHmac('sha256', key).update(list).digest();
  const got = Buffer.from(value.slice(i + 1), 'hex');
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  const names = list ? list.split(',') : [];
  return names.every((n) => (HAZARD_NAMES as readonly string[]).includes(n))
    ? (names as HazardName[])
    : null;
}

export function hazards(opts: HazardOptions) {
  // gentle also fixes the seed, so a first run is the same every time
  const seed = opts.profile === 'gentle' ? 20_031_014 : opts.seed;
  const scale =
    opts.runRatePct !== undefined ? scaleForRunRate(opts.runRatePct) : SCALE[opts.profile];
  let counter = 0;

  return {
    forRequest(header: string | undefined, path: string): RequestHazards | 'bad-signature' {
      if (header !== undefined) {
        const names = opts.forceable ? verify(header, opts.hmacKey) : null;
        if (!names) return 'bad-signature';
        const set = new Set(names);
        return {
          forced: true,
          on: (n) => {
            const hit = set.has(n);
            if (hit) opts.log(n, path, true);
            return hit;
          },
          latencyMs: () => (set.has('latency') ? 500 : 0),
        };
      }
      const r = rng(hash32(seed, ++counter));
      const transfer = path.includes('/transfer');
      // Enough to shuffle the order frames arrive in, not enough to slow a test down.
      const latency = scale === 0 ? 0 : r.int(0, 150);
      return {
        forced: false,
        on: (n) => {
          const rate = (AMBIENT as Record<string, number>)[n];
          const hit = rate !== undefined && !transfer && r.chance(Math.min(1, rate * scale));
          if (hit) opts.log(n, path, false);
          return hit;
        },
        latencyMs: () => latency,
      };
    },
  };
}
export type Hazards = ReturnType<typeof hazards>;
