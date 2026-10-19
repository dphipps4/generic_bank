// Each role's provider, model and effort, read from the factory's settings, and the prices the
// meter charges (plan §7). The models themselves are set in config/app.env, nowhere else.
import { OPENROUTER_MODELS } from '@earendil-works/pi-ai/providers/openrouter.models';
import { z } from 'zod';

export const ROLE_NAMES = ['scout', 'supervisor', 'lessons'] as const;
export type Role = (typeof ROLE_NAMES)[number];
export const isRole = (r: string): r is Role => (ROLE_NAMES as readonly string[]).includes(r);

export const PROVIDERS = ['openai', 'openrouter'] as const;
export type Provider = (typeof PROVIDERS)[number];
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

export interface RoleModel {
  provider: Provider;
  model: string;
  effort: (typeof EFFORTS)[number];
}
export type Roles = Readonly<Record<Role, RoleModel>>;

/** The settings, for loadConfig. The Supervisor reasons, so it thinks harder than the Scout. */
export const ROLE_SETTINGS = {
  FACTORY_SCOUT_PROVIDER: z.enum(PROVIDERS).default('openrouter'),
  FACTORY_SCOUT_MODEL: z.string().min(1),
  FACTORY_SCOUT_EFFORT: z.enum(EFFORTS).default('low'),
  FACTORY_SUPERVISOR_PROVIDER: z.enum(PROVIDERS).default('openrouter'),
  FACTORY_SUPERVISOR_MODEL: z.string().min(1),
  FACTORY_SUPERVISOR_EFFORT: z.enum(EFFORTS).default('low'),
};
type Settings = z.infer<z.ZodObject<typeof ROLE_SETTINGS>>;

/** Each role's model from the settings. Writing the lessons is the Supervisor's work. */
export function rolesOf(s: Settings): Roles {
  const supervisor: RoleModel = {
    provider: s.FACTORY_SUPERVISOR_PROVIDER,
    model: s.FACTORY_SUPERVISOR_MODEL,
    effort: s.FACTORY_SUPERVISOR_EFFORT,
  };
  const scout: RoleModel = {
    provider: s.FACTORY_SCOUT_PROVIDER,
    model: s.FACTORY_SCOUT_MODEL,
    effort: s.FACTORY_SCOUT_EFFORT,
  };
  return { scout, supervisor, lessons: supervisor };
}

/** US dollars per million tokens. A model with no price here is metered at nothing. */
export interface Price {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

// An OpenAI model goes here at its maker's prices before a role is set to it. Every OpenRouter
// model is priced from pi's catalog, at its dearest tier, so the meter never counts low.
type Rates = Price & { tiers?: Price[] };
const dearest = (c: Rates): Price => {
  const all = [c, ...(c.tiers ?? [])];
  const most = (k: keyof Price) => Math.max(...all.map((t) => t[k]));
  return {
    input: most('input'),
    output: most('output'),
    cacheRead: most('cacheRead'),
    cacheWrite: most('cacheWrite'),
  };
};
const OPENROUTER_PRICES = Object.fromEntries(
  Object.entries(OPENROUTER_MODELS).map(([id, m]) => [id, dearest(m.cost as Rates)]),
);
export const PRICES: Readonly<Record<string, Price>> = {
  ...OPENROUTER_PRICES,
  // Not in pi's catalog: OpenRouter's published rates, per million tokens. A model the meter
  // can't price counts as free, so the run's budget cap would not hold.
  'meta/muse-spark-1.3': { input: 1.25, output: 4.25, cacheRead: 0.15, cacheWrite: 1.25 },
};

export const priceOf = (model: unknown, prices: Readonly<Record<string, Price>> = PRICES): Price =>
  typeof model === 'string' && Object.hasOwn(prices, model) ? prices[model]! : FREE;

const FREE: Price = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** What a call used, in tokens, whichever provider answered. `input` is the uncached input. */
export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export function costUsd(price: Price, u: Usage): number {
  const millionths =
    u.input * price.input +
    u.cacheWrite * price.cacheWrite +
    u.cacheRead * price.cacheRead +
    u.output * price.output;
  return millionths / 1e6;
}
