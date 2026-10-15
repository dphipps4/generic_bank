// The journal (plan, §F.2, §G.2): every state-changing action a run intends and performs, hash-
// chained per run. Each entry's hash covers its own content and the hash before it, starting from
// the run's own origin, so changing or reordering any entry, or removing any but the newest, breaks
// the chain at that entry.
import { createHash, randomBytes } from 'node:crypto';

interface Sql {
  query<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: R[] }>;
}

export interface JournalLine {
  /** What the run is about to do, in words: "press Submit transfer under grant g_…". */
  intent: string;
  /** What it did, once it has: "pressed Submit transfer". */
  action?: string;
  /** What came of it: "confirmation GB-48213-K", "no confirmation screen". */
  result?: string;
}

interface Row {
  runId: string;
  seq: number;
  intent: string;
  action: string | null;
  result: string | null;
  prevHash: string;
  rowHash: string;
  at: Date;
}

const origin = (runId: string) => `origin:${runId}`;

/** The hash of one entry: its run, place, words and time, and the hash before it. */
export function hashOf(r: Omit<Row, 'rowHash'>): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        r.runId,
        r.seq,
        r.intent,
        r.action ?? null,
        r.result ?? null,
        r.prevHash,
        new Date(r.at).toISOString(),
      ]),
    )
    .digest('hex');
}

/** Adds one entry to a run's journal, after its last one. Returns its place in the chain. */
export async function journal(
  sql: Sql,
  runId: string,
  line: JournalLine,
  now = new Date(),
): Promise<number> {
  for (let attempt = 0; ; attempt++) {
    const last = (
      await sql.query<{ seq: number; rowHash: string }>(
        `SELECT seq, "rowHash" FROM "JournalEntry" WHERE "runId" = $1 ORDER BY seq DESC LIMIT 1`,
        [runId],
      )
    ).rows[0];
    const entry = {
      runId,
      seq: (last?.seq ?? 0) + 1,
      intent: line.intent,
      action: line.action ?? null,
      result: line.result ?? null,
      prevHash: last?.rowHash ?? origin(runId),
      at: now,
    };
    try {
      await sql.query(
        `INSERT INTO "JournalEntry" (id, "runId", seq, intent, action, result, "prevHash", "rowHash", at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          `j_${randomBytes(8).toString('hex')}`,
          entry.runId,
          entry.seq,
          entry.intent,
          entry.action,
          entry.result,
          entry.prevHash,
          hashOf(entry),
          entry.at,
        ],
      );
      return entry.seq;
    } catch (e) {
      // Another writer took this place in the chain first: read the new end and try again.
      if (attempt >= 3) throw e;
    }
  }
}

export type Verdict =
  | { ok: true; runs: number; entries: number }
  | { ok: false; runId: string; seq: number; reason: string };

/** Walks every chain (or one run's) from its origin and says where, if anywhere, it breaks. */
export async function verifyJournal(sql: Sql, runId?: string): Promise<Verdict> {
  const rows = (
    await sql.query<Row>(
      `SELECT "runId", seq, intent, action, result, "prevHash", "rowHash", at FROM "JournalEntry"
        ${runId ? 'WHERE "runId" = $1' : ''} ORDER BY "runId", seq`,
      runId ? [runId] : [],
    )
  ).rows;
  let run = '';
  let expectSeq = 0;
  let prev = '';
  let runs = 0;
  for (const r of rows) {
    if (r.runId !== run) {
      run = r.runId;
      expectSeq = 1;
      prev = origin(run);
      runs++;
    }
    if (r.seq !== expectSeq)
      return { ok: false, runId: run, seq: r.seq, reason: `entry ${expectSeq} is missing` };
    if (r.prevHash !== prev)
      return {
        ok: false,
        runId: run,
        seq: r.seq,
        reason: 'it does not follow the entry before it',
      };
    if (hashOf(r) !== r.rowHash)
      return { ok: false, runId: run, seq: r.seq, reason: 'its content was changed' };
    prev = r.rowHash;
    expectSeq++;
  }
  return { ok: true, runs, entries: rows.length };
}
