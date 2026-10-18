// The gate (prompts, part 2, §5): a learned table must work before a person sees it. Code runs it
// live through the crawler's own loop: the balance, and a transfer up to its review (never sent).
// Then once more with one hazard forced, the confirmation dialog the brief names. A table that
// fails the first run is not recommended; one that breaks under the hazard is kept as broken and
// opens a repair case with that run's frames, as a break in service would. A table that passes
// both waits in the Console for a person's approval: nothing promotes it but that.
import {
  checkBalance,
  inHistory,
  isWritten,
  prepareTransfer,
  type Table,
  type Written,
} from '@gb/crawler';
import { decideWritten, GuardError } from '@gb/guardrails';
import type { FrameStore } from '@gb/evidence';
import { driverFault, hazardHeader, type Sql } from '@gb/runs';
import { type Browser, newPage } from '@gb/runtime';
import { openTrail } from './trail.js';

/** The one hazard a learned table is checked against. */
export const GATE_HAZARD = 'confirm-dialog';

export interface GateDeps {
  sql: Sql;
  store: FrameStore;
  browser: Browser;
  credentials: { operatorId: string; password: string };
  /** A person's code, through the Console's inbox, for a run of this id. */
  code(runId: string): Promise<string>;
  /** Signs a forced hazard for the bank; without it, the hazard run is skipped and says so. */
  hazardKey?: string;
}

export interface CheckRun {
  runId: string;
  hazard: string | null;
  ok: boolean;
  /** What the run read, or why it stopped. */
  said: string;
}

/** One live run of the table: the balance, then a transfer to its review, its pages kept. */
async function checkRun(
  d: GateDeps,
  o: {
    runId: string;
    bank: string;
    url: string;
    table: Table | Written;
    member: string;
    from: string;
    to: string;
  },
  hazard: string | null,
): Promise<CheckRun> {
  const trail = await openTrail({
    sql: d.sql,
    store: d.store,
    runId: o.runId,
    task: 'factory',
    bank: o.bank,
    known: [],
  });
  const headers = hazard && d.hazardKey ? hazardHeader([hazard as never], d.hazardKey) : undefined;
  // From a browser that has never signed in: as the service's first run on this bank will.
  const page = await newPage(d.browser, headers ? { headers } : {});
  const session = {
    page,
    url: o.url,
    table: o.table,
    known: trail.known,
    everyStep: true,
    // A written crawler runs with the guard on, as it will in service.
    ...(isWritten(o.table) && {
      guard: (a: {
        verb: 'type' | 'press' | 'choose' | 'read';
        control: string;
        typed?: string;
      }) => {
        const v = decideWritten(a.verb, a.control, {
          secrets: [d.credentials.password],
          ...(a.typed !== undefined ? { typed: a.typed } : {}),
        });
        if (!v.allowed) throw new GuardError(v.layer, v.rule);
      },
    }),
    credentials: async () => d.credentials,
    code: () => d.code(o.runId),
    keep: async (seen: { did: string; page: string | null }, f: Parameters<typeof trail.step>[1]) =>
      void (await trail.step({ name: seen.page ?? 'unknown page', action: seen.did }, f)),
  };
  try {
    const b = await checkBalance(session, { member: o.member, account: o.from });
    const r = await prepareTransfer(session, {
      member: o.member,
      from: o.from,
      to: o.to,
      amountCents: 100,
      memo: 'GBX GATE',
    });
    const holds = (drawn: string, asked: string) =>
      drawn.includes(asked.match(/\d{4}$/)?.[0] ?? asked) ||
      drawn.toLowerCase().includes(asked.toLowerCase());
    const wrong = [
      ...(holds(r.from, o.from) ? [] : ['From']),
      ...(holds(r.to, o.to) ? [] : ['To']),
      ...(r.amountCents === 100 ? [] : ['Amount']),
      ...(r.memo.includes('GBX GATE') ? [] : ['Memo']),
    ];
    // The activity, reached and read: nothing was sent, so no line holds the memo.
    const rows = await inHistory(session, { member: o.member, from: o.from, memo: 'GBX GATE' });
    const ok = wrong.length === 0 && rows === 0;
    return {
      runId: o.runId,
      hazard,
      ok,
      said: ok
        ? `the balance read ${b.availableCents} cents; the review held the task's accounts, $1.00 and the memo; the activity was reached`
        : wrong.length
          ? `the review did not match the task in ${wrong.join(', ')}`
          : `the activity held ${rows} lines with the memo, not 0`,
    };
  } catch (e) {
    return {
      runId: o.runId,
      hazard,
      ok: false,
      said: e instanceof Error ? e.message : String(e),
    };
  } finally {
    await page
      .context()
      .close()
      .catch(() => undefined);
  }
}

/**
 * The gate for a table a factory run wrote. Returns the recommendation a person decides, or null
 * when the table failed: then the runs say why.
 */
export async function gate(
  d: GateDeps,
  o: {
    factoryRunId: string;
    bank: string;
    url: string;
    table: Table | Written;
    member: string;
    from: string;
    to: string;
    /** Practice on a bank whose table is written by hand: checked, never recommended. */
    practice?: boolean;
  },
): Promise<{ recommendationId: string | null; runs: CheckRun[] }> {
  const runs = [await checkRun(d, { ...o, runId: `${o.factoryRunId}-check` }, null)];
  if (runs[0]!.ok && d.hazardKey)
    runs.push(await checkRun(d, { ...o, runId: `${o.factoryRunId}-${GATE_HAZARD}` }, GATE_HAZARD));
  const passed = runs.every((r) => r.ok);
  if (o.practice) return { recommendationId: null, runs };
  const broken = runs[0]!.ok && !passed;
  // Kept either way: approvable, or broken and the table a repair starts from.
  const rec = await d.sql.query<{ id: string }>(
    `INSERT INTO "Recommendation" (id, "factoryRunId", tenant, status, "table", "check")
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [
      `rec_${o.factoryRunId}`,
      o.factoryRunId,
      o.bank,
      passed ? 'open' : broken ? 'broken' : 'failed',
      JSON.stringify(o.table),
      JSON.stringify(runs),
    ],
  );
  if (broken)
    await driverFault(d.sql, {
      tenant: o.bank,
      task: 'check-balance',
      versionId: null,
      runId: runs.at(-1)!.runId,
      why: `the learned table broke under ${GATE_HAZARD}: ${runs.at(-1)!.said}`,
    });
  return { recommendationId: passed ? rec.rows[0]!.id : null, runs };
}
