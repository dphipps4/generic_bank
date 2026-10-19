// Who writes to memory, and the write memory will not make. Every write runs in one serializable
// transaction, so a write and what it rests on commit together, or neither does.

export const ROLES = ['runner', 'factory', 'curator', 'system'] as const;
export type Role = (typeof ROLES)[number];

/** A write memory will not make, and why: 409 when what it needs is missing or already held. */
export class Refused extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
