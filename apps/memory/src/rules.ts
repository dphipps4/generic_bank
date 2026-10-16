// The rules (plan §A.6): fixed functions of stored evidence, with no model, that confirm, dispute,
// retire, widen and bring back lessons. Each change is a new version and a change-log row written
// as the system, in the transaction of the write that set it off.
//
// - A promotion that memory's own records bear out confirms the lessons its probation runs relied
//   on, or proposed from what they saw; a guess no probation run relied on stays a guess. It
//   retires what they contradicted, at this bank only unless the lesson is the bank's own, and
//   brings back a retired lesson they relied on. A pattern only a person has not approved becomes
//   a candidate that waits for one.
// - A tenant lesson proven at two banks of a vendor widens to the vendor; a vendor lesson proven at
//   three vendors becomes a pattern candidate.
// - One run's contradiction disputes a lesson; two runs' retire it, at one bank only when both
//   are there and the lesson is not that bank's own.
// - A demotion disputes what its driver's promotion confirmed.
import type { Query } from './db.js';
import { Refused, type Entry, type Role } from './memory.js';
import { addVersion, currentOf, SAME_LESSON, type Citation, type Current } from './versions.js';

/** Clean probation runs of a driver at a bank that a promotion rests on. */
export const PROBATION = 2;

export interface MarkedRun {
  id: string;
  bank: string;
  vendor: string | null;
  driver: string | null;
  outcome: string;
  mark: 'promoted' | 'demoted' | null;
  startedAt: Date;
  recordedAt: Date;
}

export async function runOf(tx: Query, id: string): Promise<MarkedRun> {
  const run = (
    await tx.query<MarkedRun>(
      `SELECT id, bank, vendor, driver, outcome, mark::text AS mark, "startedAt", "recordedAt" FROM "Run" WHERE id = $1`,
      [id],
    )
  ).rows[0];
  if (!run) throw new Refused(409, 'no_run', `memory holds no run ${id}`);
  return run;
}

/** Whether memory's records bear out a run's promotion: it succeeded, and its driver has at least
 *  PROBATION clean task runs at its bank. */
export async function promoted(tx: Query, run: MarkedRun): Promise<boolean> {
  if (run.mark !== 'promoted' || run.outcome !== 'succeeded' || !run.driver) return false;
  const { n } = (
    await tx.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM "Run"
       WHERE driver = $1 AND bank = $2 AND kind = 'task' AND outcome = 'succeeded'`,
      [run.driver, run.bank],
    )
  ).rows[0]!;
  return n >= PROBATION;
}

const ruled = (
  action: string,
  rule: string,
  cur: Current,
  runId: string | null,
  data: Record<string, unknown>,
): Entry => ({
  role: 'system',
  action,
  entity: 'Lesson',
  entityId: cur.lessonId,
  runId,
  data: { rule, ...data },
});

const without = (banks: string[], bank: string) => banks.filter((b) => b !== bank);
const union = (a: Citation[], b: Citation[]) => [
  ...a,
  ...b.filter((c) => !a.some((x) => x.run === c.run && !!x.contradicts === !!c.contradicts)),
];

/** Confirmed lessons near-duplicate to this one, in the given scope, that are not it. */
async function twins(tx: Query, cur: Current, scope: 'tenant' | 'vendor') {
  return (
    await tx.query<{ lessonId: string; bank: string | null; vendor: string | null }>(
      `SELECT v."lessonId", v.bank, v.vendor
       FROM "Lesson" l JOIN "LessonVersion" v ON v."lessonId" = l.id AND v.version = l.current,
         (SELECT embedding FROM "LessonVersion" WHERE "lessonId" = $1 AND version = $2) me
       WHERE l.id <> $1 AND v.scope = $3::"Scope" AND v.state = 'confirmed' AND v.embedding IS NOT NULL
         AND 1 - (v.embedding <=> me.embedding) >= $4
       ORDER BY l.id`,
      [cur.lessonId, cur.version, scope, SAME_LESSON],
    )
  ).rows;
}

/** Widen a confirmed lesson that holds beyond its scope: from one bank to its vendor at two banks,
 *  and to a pattern candidate at three vendors. */
async function widen(tx: Query, lessonId: string, runId: string): Promise<Entry[]> {
  const out: Entry[] = [];
  let cur = (await currentOf(tx, lessonId))!;
  if (cur.state !== 'confirmed') return out;

  if (cur.scope === 'tenant' && cur.vendor) {
    const others = (await twins(tx, cur, 'tenant')).filter(
      (t) => t.vendor === cur.vendor && t.bank !== cur.bank,
    );
    if (others.length) {
      let evidence = cur.evidence;
      for (const o of others) {
        const other = (await currentOf(tx, o.lessonId))!;
        evidence = union(evidence, other.evidence);
        const v = await addVersion(tx, other, {
          state: 'retired',
          reason: 'widened to the vendor, with the same lesson proven at another bank',
          role: 'system',
          runId,
        });
        out.push(ruled('lessons/retire', 'widened', other, runId, { ...v, into: cur.lessonId }));
      }
      const banks = [cur.bank, ...others.map((o) => o.bank)];
      const v = await addVersion(tx, cur, {
        scope: 'vendor',
        bank: null,
        evidence,
        reason: `proven at ${banks.length} banks of the vendor`,
        role: 'system',
        runId,
      });
      out.push(ruled('lessons/confirm', 'widen', cur, runId, { ...v, scope: 'vendor', banks }));
      cur = (await currentOf(tx, lessonId))!;
    }
  }

  if (cur.scope === 'vendor' && cur.version === cur.latest) {
    const vendors = new Set([cur.vendor]);
    let evidence = cur.evidence;
    for (const t of await twins(tx, cur, 'vendor'))
      if (!vendors.has(t.vendor)) {
        vendors.add(t.vendor);
        evidence = union(evidence, (await currentOf(tx, t.lessonId))!.evidence);
      }
    if (vendors.size >= 3) {
      const v = await addVersion(
        tx,
        cur,
        {
          scope: 'pattern',
          bank: null,
          vendor: null,
          evidence,
          reason: `proven at ${vendors.size} vendors: a pattern candidate, waiting for a person`,
          role: 'system',
          runId,
        },
        { pending: true },
      );
      out.push(ruled('lessons/confirm', 'candidate', cur, runId, { ...v, vendors: [...vendors] }));
    }
  }
  return out;
}

/** The rules a promotion sets off. Nothing changes unless memory's records bear it out. */
export async function promote(tx: Query, run: MarkedRun): Promise<Entry[]> {
  if (!(await promoted(tx, run))) return [];
  const probation = (
    await tx.query<{ id: string }>(`SELECT id FROM "Run" WHERE driver = $1 AND bank = $2`, [
      run.driver,
      run.bank,
    ])
  ).rows.map((r) => r.id);
  const touched = (
    await tx.query<{ id: string; relied: boolean; wasPattern: boolean }>(
      `SELECT l.id,
         EXISTS (SELECT 1 FROM "Reliance" r WHERE r."lessonId" = l.id AND r."runId" = ANY($1)) AS relied,
         EXISTS (SELECT 1 FROM "LessonVersion" p WHERE p."lessonId" = l.id AND p.version <= l.current
           AND p.scope = 'pattern' AND p.state = 'confirmed') AS "wasPattern"
       FROM "Lesson" l JOIN "LessonVersion" v ON v."lessonId" = l.id AND v.version = l.current
       WHERE EXISTS (SELECT 1 FROM "Reliance" r WHERE r."lessonId" = l.id AND r."runId" = ANY($1))
          OR EXISTS (SELECT 1 FROM jsonb_array_elements(v.evidence) c WHERE c->>'run' = ANY($1))
       ORDER BY l.id`,
      [probation],
    )
  ).rows;

  const out: Entry[] = [];
  const confirmed: string[] = [];
  for (const t of touched) {
    const cur = (await currentOf(tx, t.id))!;
    const cites = cur.evidence.filter((c) => probation.includes(c.run));
    const retiredHere = cur.state === 'retired' || cur.retiredAtBanks.includes(run.bank);

    if (cites.some((c) => c.contradicts)) {
      if (retiredHere) continue;
      const here = cur.scope !== 'tenant';
      const v = await addVersion(tx, cur, {
        ...(here
          ? { retiredAtBanks: [...cur.retiredAtBanks, run.bank] }
          : { state: 'retired' as const }),
        reason: here
          ? `wrong at ${run.bank}: a run its promotion rests on contradicted it`
          : 'a run its promotion rests on contradicted it',
        role: 'system',
        runId: run.id,
      });
      out.push(
        ruled('lessons/retire', here ? 'retire at the bank' : 'retire', cur, run.id, {
          ...v,
          bank: run.bank,
        }),
      );
      continue;
    }

    if (!t.relied && !cites.some((c) => c.seen)) continue; // a guess, and no one relied on it
    if (cur.state === 'confirmed' && !retiredHere) {
      confirmed.push(cur.lessonId);
      continue;
    }
    // Only a later promotion overrides a dispute or a retirement, and only one its runs relied on
    // brings a retired lesson back.
    if (cur.state !== 'proposed' && !(run.recordedAt > cur.createdAt)) continue;
    if (retiredHere && !t.relied) continue;
    if (cur.scope === 'pattern' && !t.wasPattern) {
      if (cur.latest > cur.version) continue; // already waiting for a person
      const v = await addVersion(
        tx,
        cur,
        {
          state: 'confirmed',
          reason: 'a promoted run proved it: a pattern candidate, waiting for a person',
          role: 'system',
          runId: run.id,
        },
        { pending: true },
      );
      out.push(ruled('lessons/confirm', 'candidate', cur, run.id, v));
      continue;
    }
    const v = await addVersion(tx, cur, {
      state: 'confirmed',
      retiredAtBanks: without(cur.retiredAtBanks, run.bank),
      reason: retiredHere ? 'a later promoted run relied on it' : 'its probation runs bore it out',
      role: 'system',
      runId: run.id,
    });
    out.push(ruled('lessons/confirm', retiredHere ? 'return' : 'confirm', cur, run.id, v));
    confirmed.push(cur.lessonId);
  }
  for (const id of confirmed) out.push(...(await widen(tx, id, run.id)));
  return out;
}

/** A demotion disputes what its driver's promotions confirmed. */
export async function demote(tx: Query, run: MarkedRun): Promise<Entry[]> {
  if (run.mark !== 'demoted' || !run.driver) return [];
  const ids = (
    await tx.query<{ id: string }>(
      `SELECT DISTINCT v."lessonId" AS id FROM "LessonVersion" v JOIN "Run" p ON p.id = v."runId"
       WHERE p.mark = 'promoted' AND p.driver = $1 AND v.role = 'system' AND v.state = 'confirmed'
       ORDER BY 1`,
      [run.driver],
    )
  ).rows;
  const out: Entry[] = [];
  for (const { id } of ids) {
    const cur = (await currentOf(tx, id))!;
    if (cur.state !== 'confirmed') continue;
    const v = await addVersion(tx, cur, {
      state: 'disputed',
      reason: `the driver whose promotion confirmed it was demoted`,
      role: 'system',
      runId: run.id,
    });
    out.push(ruled('lessons/dispute', 'demote', cur, run.id, v));
  }
  return out;
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
