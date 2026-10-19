// The rules (plan §A.6): fixed functions of stored evidence, with no model, that dispute and
// retire lessons. Each change is a new version, written in the transaction of the write that set
// it off.
//
// - One run's contradiction disputes a lesson; two runs' retire it, at one bank only when both
//   are there and the lesson is not that bank's own.
// - A person retires a lesson by hand, everywhere or at one bank.
import type { Query } from './db.js';
import { Refused, type Entry, type Role } from './memory.js';
import { addVersion, currentOf, type Citation } from './versions.js';

/** A run as the rules read it. */
export interface RunRow {
  id: string;
  bank: string;
  vendor: string | null;
}

export async function runOf(tx: Query, id: string): Promise<RunRow> {
  const run = (await tx.query<RunRow>(`SELECT id, bank, vendor FROM "Run" WHERE id = $1`, [id]))
    .rows[0];
  if (!run) throw new Refused(409, 'no_run', `memory holds no run ${id}`);
  return run;
}

/** A run says a lesson does not hold. One run disputes it; two retire it. Said again by the same
 *  run, it changes nothing. */
export async function contradict(
  tx: Query,
  role: Role,
  c: { lessonId: string; runId: string; frames: string[]; evidenceHash: string; reason: string },
): Promise<Entry | null> {
  const run = await runOf(tx, c.runId);
  const cur = await currentOf(tx, c.lessonId);
  if (!cur) throw new Refused(409, 'no_lesson', `memory serves no lesson ${c.lessonId}`);
  if (cur.evidence.some((x) => x.contradicts && x.run === run.id)) return null;

  const citation: Citation = {
    run: run.id,
    frames: c.frames,
    hash: c.evidenceHash,
    seen: true,
    contradicts: true,
    reason: c.reason,
  };
  const evidence = [...cur.evidence, citation];
  const against = [...new Set(evidence.filter((x) => x.contradicts).map((x) => x.run))];
  const banks = (
    await tx.query<{ bank: string }>(`SELECT DISTINCT bank FROM "Run" WHERE id = ANY($1)`, [
      against,
    ])
  ).rows.map((r) => r.bank);

  let change: { state?: 'disputed' | 'retired'; retiredAtBanks?: string[] } = {};
  let rule = 'dispute';
  if (against.length >= 2 && (cur.scope === 'tenant' || banks.length >= 2)) {
    change = { state: 'retired' };
    rule = 'retire';
  } else if (against.length >= 2) {
    change = { state: 'disputed', retiredAtBanks: [...new Set([...cur.retiredAtBanks, ...banks])] };
    rule = 'retire at the bank';
  } else if (cur.state !== 'retired') change = { state: 'disputed' };

  const v = await addVersion(tx, cur, {
    ...change,
    evidence,
    reason: c.reason,
    role,
    runId: run.id,
    evidenceHash: c.evidenceHash,
  });
  return {
    entity: 'Lesson',
    entityId: cur.lessonId,
    runId: run.id,
    data: { rule, ...v, state: change.state ?? cur.state, citation, against: against.length },
  };
}

/** Retire a lesson by hand, everywhere or at one bank. Already retired there, it changes nothing. */
export async function retire(
  tx: Query,
  role: Role,
  r: { lessonId: string; reason: string; bank?: string },
): Promise<Entry | null> {
  const cur = await currentOf(tx, r.lessonId);
  if (!cur) throw new Refused(409, 'no_lesson', `memory serves no lesson ${r.lessonId}`);
  if (cur.state === 'retired' || (r.bank && cur.retiredAtBanks.includes(r.bank))) return null;
  const v = await addVersion(tx, cur, {
    ...(r.bank ? { retiredAtBanks: [...cur.retiredAtBanks, r.bank] } : { state: 'retired' }),
    reason: r.reason,
    role,
  });
  return {
    entity: 'Lesson',
    entityId: cur.lessonId,
    data: { rule: r.bank ? 'retire at the bank' : 'retire', ...v, bank: r.bank, reason: r.reason },
  };
}
