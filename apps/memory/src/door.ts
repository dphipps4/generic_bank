// Memory's one door (plan §A.6): every caller holds a token for one role, and each role may make
// only the writes listed here. Every write is also signed with a key that only deterministic code
// holds, so a model that learns a token still cannot forge a write.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { ROLES, type Role } from './memory.js';

/** Who may make each write. The app box (the runner) adds episodes and forwards lessons, nothing
 *  more; the factory's agents add episodes and hypotheses, propose lessons and challenge what is
 *  held; only memory's own rules confirm and write facts; a person curates and approves. */
export const WRITES = {
  'episodes/runs': ['runner', 'factory'],
  'episodes/attempts': ['runner', 'factory'],
  hypotheses: ['factory'],
  'lessons/proposals': ['runner', 'factory'],
  'lessons/relied-on': ['runner', 'factory'],
  facts: ['system'],
  'facts/invalidate': ['factory', 'curator', 'system'],
  'lessons/confirm': ['system'],
  'lessons/retire': ['curator', 'system'],
  curated: ['curator'],
  'curated/approve': ['curator'],
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
