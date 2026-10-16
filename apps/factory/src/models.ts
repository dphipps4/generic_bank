// Each role's provider, model and effort, read from the factory's settings, and the prices the
// meter charges (plan §7). The models themselves are set in config/app.env, nowhere else.
import { z } from 'zod';

export const ROLE_NAMES = ['scout', 'supervisor', 'lessons'] as const;
export type Role = (typeof ROLE_NAMES)[number];
export const isRole = (r: string): r is Role => (ROLE_NAMES as readonly string[]).includes(r);

export const PROVIDERS = ['anthropic', 'openai', 'openrouter'] as const;
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
  FACTORY_SCOUT_PROVIDER: z.enum(PROVIDERS).default('anthropic'),
  FACTORY_SCOUT_MODEL: z.string().min(1),
  FACTORY_SCOUT_EFFORT: z.enum(EFFORTS).default('low'),
  FACTORY_SUPERVISOR_PROVIDER: z.enum(PROVIDERS).default('anthropic'),
  FACTORY_SUPERVISOR_MODEL: z.string().min(1),
  FACTORY_SUPERVISOR_EFFORT: z.enum(EFFORTS).default('high'),
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

// Cache writes are charged at the one-hour rate, the dearer of the two, so the meter never
// counts low. A model of another provider (OpenAI, for one) goes here the same way, at its
// maker's prices, before a role is set to it.
export const PRICES: Readonly<Record<string, Price>> = {
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 8 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 4 },
  // OpenRouter model ids carry the provider prefix; the prices are the maker's.
  'anthropic/claude-opus-4.6': { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  'anthropic/claude-opus-4.8': { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  'anthropic/claude-sonnet-5.5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 4 },
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
