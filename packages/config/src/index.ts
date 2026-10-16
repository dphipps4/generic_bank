// Settings fail closed: every required variable must be present, secrets must be long
// enough, and no two secrets may be equal. A service that cannot read its settings
// does not start.
import { z } from 'zod';

export const secret = () =>
  z.string().min(32, 'must be at least 32 characters (run just setup to generate it)');

export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Configuration is not valid:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

/**
 * Parse settings from an environment. `secretKeys` names the fields that must all differ
 * from each other, so one value can never unlock two doors.
 */
export function loadConfig<S extends z.ZodRawShape>(
  shape: S,
  env: Record<string, string | undefined> = process.env,
  secretKeys: (keyof S & string)[] = [],
): z.infer<z.ZodObject<S>> {
  const parsed = z.object(shape).safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    );
  }
  const data = parsed.data as Record<string, unknown>;
  const seen = new Map<unknown, string>();
  const clashes: string[] = [];
  for (const key of secretKeys) {
    const value = data[key];
    const earlier = seen.get(value);
    if (earlier) clashes.push(`${key}: must differ from ${earlier}`);
    else seen.set(value, key);
  }
  if (clashes.length) throw new ConfigError(clashes);
  return parsed.data;
}

export const port = (fallback: number) =>
  z.coerce.number().int().min(1).max(65535).default(fallback);
