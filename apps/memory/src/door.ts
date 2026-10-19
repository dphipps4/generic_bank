// Memory's one door (plan §A.6): every caller holds a token for one role, and each role may make
// only the writes listed here. Every write is also signed with a key that only deterministic code
// holds, so a model that learns a token still cannot forge a write.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { ROLES, type Role } from './memory.js';

/** Who may make each write. The factory's agents add runs, propose lessons, and say which they
 *  relied on and which do not hold; a person retires a lesson. */
export const WRITES = {
  'episodes/runs': ['factory'],
  'lessons/proposals': ['factory'],
  'lessons/relied-on': ['factory'],
  'facts/invalidate': ['factory'],
  'lessons/retire': ['curator'],
} as const satisfies Record<string, readonly Role[]>;

export type Write = keyof typeof WRITES;

export const SIGNATURE = 'x-memory-signature';

const digest = (s: string) => createHash('sha256').update(s).digest('hex');

/** The signature a writer sends: an HMAC of the method, the path and the exact body. */
export function sign(key: string, method: string, path: string, body: string): string {
  return createHmac('sha256', key).update(`${method.toUpperCase()} ${path}\n${body}`).digest('hex');
}

export function door(opts: { tokens: Record<Role, string>; signingKey: string }) {
  const roles = new Map(ROLES.map((r) => [digest(opts.tokens[r]), r]));
  return {
    /** The role a bearer token belongs to, if any. */
    roleOf(authorization: string | undefined): Role | undefined {
      const token = /^Bearer (\S+)$/.exec(authorization ?? '')?.[1];
      return token ? roles.get(digest(token)) : undefined;
    },
    signed(method: string, path: string, body: string, signature: unknown): boolean {
      if (typeof signature !== 'string' || !/^[\da-f]{64}$/.test(signature)) return false;
      const want = Buffer.from(sign(opts.signingKey, method, path, body), 'hex');
      return timingSafeEqual(want, Buffer.from(signature, 'hex'));
    },
    allows: (role: Role, write: Write) => (WRITES[write] as readonly Role[]).includes(role),
  };
}

export type Door = ReturnType<typeof door>;
