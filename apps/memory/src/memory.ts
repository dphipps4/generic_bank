// Every write and its change-log row commit together, or neither does. Each row's hash covers its
// own fields and the hash of the row before it; a chain that fails verification makes memory
// read-only until a person looks.
import { createHash } from 'node:crypto';
import type { Db, Query } from './db.js';

export const ROLES = ['runner', 'factory', 'curator', 'system'] as const;
export type Role = (typeof ROLES)[number];

/** What a write tells the change log about itself. */
export interface Entry {
  entity: string;
  entityId: string;
  runId?: string | null;
  data: unknown;
  /** Who made this change and what it was, when not the write itself: memory's own rules, run
   *  by a write, record their changes as the system. */
  role?: Role;
  action?: string;
}

export interface Change {
  seq: number;
  at: Date;
  role: Role;
  action: string;
  entity: string;
  entityId: string;
  runId: string | null;
  data: unknown;
  prevHash: string;
  hash: string;
}

export type Verdict = { ok: true; rows: number } | { ok: false; rows: number; brokenAt: number };

export class ReadOnly extends Error {
  constructor() {
    super('the change log failed verification; memory is read-only');
  }
}

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

const GENESIS = '0'.repeat(64);

/** JSON with keys sorted, so a value hashes the same after Postgres stores and returns it. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object')
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  return JSON.stringify(v ?? null);
}

export function hashOf(c: Omit<Change, 'hash'>): string {
  const { seq, at, role, action, entity, entityId, runId, data } = c;
  const fields = { seq, at: at.toISOString(), role, action, entity, entityId, runId, data };
  return createHash('sha256')
    .update(`${c.prevHash}\n${canonical(fields)}`)
    .digest('hex');
}

const COLUMNS = `seq, at, role::text AS role, action, entity, "entityId", "runId", data, "prevHash", hash`;

export interface HistoryFilter {
  entity?: string;
  id?: string;
  run?: string;
  since?: Date;
  limit?: number;
}

export function openMemory(db: Db, opts: { onBroken?: (v: Verdict) => void } = {}) {
  let readOnly = false;

  async function append(tx: Query, role: Role, action: string, e: Entry): Promise<Change> {
    const head = (
      await tx.query<{ seq: number; hash: string }>(
        `SELECT seq, hash FROM "ChangeLog" ORDER BY seq DESC LIMIT 1`,
      )
    ).rows[0];
    const row = {
      seq: (head?.seq ?? 0) + 1,
      at: new Date(),
      role: e.role ?? role,
      action: e.action ?? action,
      entity: e.entity,
      entityId: e.entityId,
      runId: e.runId ?? null,
      // As Postgres will hold it: no undefined values.
      data: JSON.parse(JSON.stringify(e.data ?? {})) as unknown,
      prevHash: head?.hash ?? GENESIS,
    };
    const hash = hashOf(row);
    await tx.query(
      `INSERT INTO "ChangeLog" (seq, at, role, action, entity, "entityId", "runId", data, "prevHash", hash)
       VALUES ($1, $2, $3::"Role", $4, $5, $6, $7, $8::jsonb, $9, $10)`,
      [
        row.seq,
        row.at,
        row.role,
        row.action,
        row.entity,
        row.entityId,
        row.runId,
        JSON.stringify(row.data),
        row.prevHash,
        hash,
      ],
    );
    return { ...row, hash };
  }

  return {
    get readOnly() {
      return readOnly;
    },

    /** `fn` writes the entity; its change-log row is appended in the same transaction. */
    async write(role: Role, action: string, fn: (tx: Query) => Promise<Entry>): Promise<Change> {
      if (readOnly) throw new ReadOnly();
      return db.serializable(async (tx) => append(tx, role, action, await fn(tx)));
    },

    /** The same, for a write that may find nothing to change: then `fn` returns null and nothing,
     *  not even a change-log row, is written. */
    async writeIf(
      role: Role,
      action: string,
      fn: (tx: Query) => Promise<Entry | null>,
    ): Promise<Change | null> {
      if (readOnly) throw new ReadOnly();
      return db.serializable(async (tx) => {
        const e = await fn(tx);
        return e ? append(tx, role, action, e) : null;
      });
    },

    /** The same, for a write that changes several entries: one change-log row each, in order.
     *  When `fn` returns none, nothing is written. */
    async writeAll(
      role: Role,
      action: string,
      fn: (tx: Query) => Promise<Entry[]>,
    ): Promise<Change[]> {
      if (readOnly) throw new ReadOnly();
      return db.serializable(async (tx) => {
        const changes: Change[] = [];
        for (const e of await fn(tx)) changes.push(await append(tx, role, action, e));
        return changes;
      });
    },

    /** Recompute the chain from the first row. The first row that does not hold is reported. */
    async verify(): Promise<Verdict> {
      const { rows } = await db.query<Change>(`SELECT ${COLUMNS} FROM "ChangeLog" ORDER BY seq`);
      let prevHash = GENESIS;
      for (const [i, r] of rows.entries()) {
        const seq = i + 1;
        if (r.seq !== seq || r.prevHash !== prevHash || hashOf(r) !== r.hash) {
          readOnly = true;
          const v: Verdict = { ok: false, rows: rows.length, brokenAt: seq };
          opts.onBroken?.(v);
          return v;
        }
        prevHash = r.hash;
      }
      return { ok: true, rows: rows.length };
    },

    /** What changed: for one entry, in one run, or since a time, oldest first. */
    async history(f: HistoryFilter): Promise<Change[]> {
      const where: string[] = [];
      const params: unknown[] = [];
      const add = (clause: string, v: unknown) => {
        params.push(v);
        where.push(clause.replace('?', `$${params.length}`));
      };
      if (f.entity) add('entity = ?', f.entity);
      if (f.id) add('"entityId" = ?', f.id);
      if (f.run) add('"runId" = ?', f.run);
      if (f.since) add('at >= ?', f.since);
      params.push(f.limit ?? 100);
      const { rows } = await db.query<Change>(
        `SELECT ${COLUMNS} FROM "ChangeLog" ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY seq LIMIT $${params.length}`,
        params,
      );
      return rows;
    },
  };
}

export type Memory = ReturnType<typeof openMemory>;
