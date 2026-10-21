// The gate (prompts, part 2, §5): a learned table must work before a person sees it. Code runs it
// live through the crawler's own loop, exactly what an approval would promote: the balance, if the
// route ends there; and, if it ends at both the review and the activity, a transfer up to its
// review (never sent) and the activity the transfer's Submit is confirmed by. Then each again from
// the browser the bank now trusts, as every run in service after the first meets it: a sign-in
// that welcomes the operator back. Then once more with one hazard forced, the confirmation dialog
// the brief names. A table that fails the first run is
// not recommended; one that breaks under the hazard is kept as broken and opens a repair case with
// that run's frames, as a break in service would. A table that passes both waits in the Console
// for a person's approval: nothing promotes it but that.
import {
  type Action,
  checkBalance,
  crawl,
  type Goal,
  leaves,
  prepareTransfer,
  Stop,
  type Table,
} from '@gb/crawler';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { driverFault, type FrameStore, hazardHeader, type Sql } from '@gb/runs';
import { type Browser, newPage, type Page } from '@gb/runtime';
import { judge, refusals } from './guard.js';
import { openTrail } from './trail.js';

/**
 * The hazards a learned table is checked against, forced together in one browser: a surprise
 * dialog, and a promotion in place of the page asked for, which the hazard pass taught it.
 */
export const GATE_HAZARDS = ['confirm-dialog', 'promo'] as const;
/** The forced run's name, as the Console shows it. */
export const GATE_HAZARD = GATE_HAZARDS.join(' and ');

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
  /** Run from the cookies the first run left, as the runner keeps them between runs. */
  trusted?: true;
  ok: boolean;
  /** What the run read, or why it stopped. */
  said: string;
}

/**
 * What an approval would promote, as the registry decides it: the balance needs its end; the
 * transfer needs its review and the activity it is checked against.
 */
export function covered(t: Table) {
  const ends = t.ends as Partial<Table['ends']>;
  return { balance: !!ends.balance, transfer: !!ends.transfer && !!ends.history };
}

/**
 * One live run of what the table covers, its pages kept: the balance; a transfer to its review;
 * the activity, opened and read, with nothing submitted. From a new browser, the tasks follow one
 * another in it, and its cookies are saved at the end. From a trusted one, each task starts from
 * those cookies in a browser of its own, as each run in service does.
 */
async function checkRun(
  d: GateDeps,
  o: {
    runId: string;
    bank: string;
    url: string;
    table: Table;
    member: string;
    from: string;
    to: string;
  },
  hazard: string | null,
  cookies: { save?: string; from?: string } = {},
): Promise<CheckRun> {
  const trail = await openTrail({
    sql: d.sql,
    store: d.store,
    runId: o.runId,
    task: 'factory',
    bank: o.bank,
    known: [],
  });
  const headers = hazard && d.hazardKey ? hazardHeader([...GATE_HAZARDS], d.hazardKey) : undefined;
  const trusted = !!cookies.from;
  const open = () =>
    newPage(d.browser, { ...(headers && { headers }), ...(trusted && { session: cookies.from }) });
  const pages: Page[] = [];
  // Judged by the guard as service judges it.
  let page = await open();
  pages.push(page);
  let goal: Goal = 'balance';
  const session = {
    guard: (a: Action) => {
      const v = judge(o.table, goal, a);
      if (!v.allowed) throw new Error(`the guard refused: ${v.rule}`);
    },
    page,
    url: o.url,
    table: o.table,
    known: trail.known,
    everyStep: true,
    credentials: async () => d.credentials,
    code: () => d.code(o.runId),
    keep: async (seen: { did: string; page: string | null }, f: Parameters<typeof trail.step>[1]) =>
      void (await trail.step({ name: seen.page ?? 'unknown page', action: seen.did }, f)),
  };
  const covers = covered(o.table);
  const task = { member: o.member, from: o.from, to: o.to, amountCents: 100, memo: 'GBX GATE' };
  const checked: string[] = [];
  let ok = false;
  try {
    if (covers.balance) {
      const b = await checkBalance(session, { ...task, account: o.from });
      checked.push(`the balance read ${b.availableCents} cents`);
    }
    if (covers.transfer) {
      goal = 'transfer';
      if (trusted && covers.balance) {
        page = session.page = await open();
        pages.push(page);
      }
      const r = await prepareTransfer(session, task);
      if (r.amountCents !== 100)
        return {
          runId: o.runId,
          hazard,
          ok: false,
          said: `the review read ${r.amountCents} cents, not 100`,
        };
      checked.push('the review read $1.00');
      // The activity a Submit is confirmed by, reached as service reaches it, under the transfer's
      // job. The crawl ends only on the page the route names for it; nothing was sent, so there is
      // no transfer to find, and reading its lines is enough.
      goal = 'history';
      await crawl(session, task, 'history');
      session.guard({
        screen:
          o.table.rows.find((r) => r.page === o.table.ends.history)?.screen ?? o.table.ends.history,
        verb: 'read',
        control: 'Page',
      });
      const lines = await leaves(page);
      checked.push(`the activity opened (${lines.length} lines)`);
    }
    if (cookies.save) await page.context().storageState({ path: cookies.save });
    ok = true;
    return {
      runId: o.runId,
      hazard,
      ...(trusted && { trusted }),
      ok: true,
      said: checked.join('; '),
    };
  } catch (e) {
    const said = e instanceof Stop ? e.message : String(e);
    return { runId: o.runId, hazard, ...(trusted && { trusted }), ok: false, said };
  } finally {
    for (const p of pages)
      await p
        .context()
        .close()
        .catch(() => undefined);
    await trail.settle(ok).catch(() => undefined);
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
    table: Table;
    member: string;
    from: string;
    to: string;
  },
): Promise<{ recommendationId: string | null; runs: CheckRun[] }> {
  // A route that covers nothing an approval would promote, or one the guard would refuse in
  // service, is not run at all.
  const covers = covered(o.table);
  const refused = refusals(o.table);
  let runs: CheckRun[] | null =
    !covers.balance && !covers.transfer
      ? [
          {
            runId: `${o.factoryRunId}-check`,
            hazard: null,
            ok: false,
            said: 'the route covers nothing a person could approve: no end for the balance, and no transfer with both its review and its activity',
          },
        ]
      : refused.length
        ? [
            {
              runId: `${o.factoryRunId}-check`,
              hazard: null,
              ok: false,
              said: `the guard would refuse it in service: ${refused
                .slice(0, 3)
                .map((r) => `on "${r.page}", ${r.rule}`)
                .join('; ')}`,
            },
          ]
        : null;
  if (!runs) {
    const dir = await mkdtemp(join(tmpdir(), 'gate-'));
    const save = join(dir, 'cookies.json');
    try {
      const at = (end: string) => ({ ...o, runId: `${o.factoryRunId}-${end}` });
      runs = [await checkRun(d, at('check'), null, { save })];
      if (runs[0]!.ok) runs.push(await checkRun(d, at('trusted'), null, { from: save }));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  if (runs.every((r) => r.ok) && d.hazardKey)
    runs.push(await checkRun(d, { ...o, runId: `${o.factoryRunId}-hazards` }, GATE_HAZARD));
  const passed = runs.every((r) => r.ok);
  // A route that served both ways in and failed only with the hazard forced broke under it.
  const broken = runs.some((r) => r.hazard && !r.ok);
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
  // A table that failed any replay has a repair case, which names the replay that failed: the next
  // repair starts from this table, where it broke.
  const failed = runs.find((r) => !r.ok);
  if (failed)
    await driverFault(d.sql, {
      tenant: o.bank,
      task: 'check-balance',
      versionId: null,
      runId: failed.runId,
      why: broken
        ? `the learned table broke under ${GATE_HAZARD}: ${failed.said}`
        : `the learned table failed the gate: ${failed.said}`,
    });
  return { recommendationId: passed ? rec.rows[0]!.id : null, runs };
}
