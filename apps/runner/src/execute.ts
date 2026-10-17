// One task run, carried out: a browser held for the run, the bank's crawler, every page it sees
// recorded and its masked frame stored, a person asked when only a person can answer, and exactly
// one result.
import { type Action, checkBalance, type Seen, type Session, Stop, TABLES } from '@gb/crawler';
import type { FrameStore } from '@gb/evidence';
import { GuardError, JOBS } from '@gb/guardrails';
import {
  addFrame,
  addStep,
  awaitAnswer,
  driverFault,
  type Ending,
  forcedHazardsOf,
  inputsOf,
  loadRun,
  openHumanTask,
  serving,
  settleRun,
  type Sql,
  trailEnd,
} from '@gb/runs';
import { type Browser, type Frame, launch, newPage, type Page } from '@gb/runtime';
import { runGuard } from './guard.js';
import { runTransfer, type TransferTask } from './transfer.js';

export interface RunDeps {
  sql: Sql;
  store: FrameStore;
  sealKey: string;
  /** Opens a person's answer (a staff code). The Console seals with it; it opens no run's inputs. */
  answerKey: string;
  /** The staff service account for a bank (from the Runner's secrets, which SOPS keeps). */
  credentials(bank: string): Promise<{ operatorId: string; password: string }>;
  launch?: () => Promise<Browser>;
  /** How long a person has to answer a human task. */
  humanDeadlineMs?: number;
  /** How often a waiting run looks for a person's answer. */
  pollMs?: number;
  now?: () => Date;
  headers?: Record<string, string>;
}

/** At most this many frames per run (plan, §9). */
const MAX_FRAMES = 60;

/** The jobs a run can be: each has its allowlist. */
const TASKS = new Set<string>(JOBS);

export async function executeRun(runId: string, deps: RunDeps): Promise<Ending> {
  const now = deps.now ?? (() => new Date());
  const run = await loadRun(deps.sql, runId);
  if (!run) throw new Error(`no run ${runId}`);
  if (run.status !== 'running' && run.status !== 'needs_human')
    return { status: 'failed', code: 'app_error' };

  const bank = (
    await deps.sql.query<{ url: string }>('SELECT url FROM "Bank" WHERE id = $1', [run.bank])
  ).rows[0];
  // The version serving the task now; a frozen bank, or one with no crawler, runs nothing.
  const served = await serving(deps.sql, run.bank, run.task);
  const table = TABLES[run.bank];
  if (!bank || !served || !table || !TASKS.has(run.task)) {
    const e: Ending = { status: 'failed', code: 'no_driver', retryable: false };
    await settleRun(deps.sql, runId, e);
    return e;
  }
  await deps.sql.query(`UPDATE "TaskRun" SET "driverVersionId" = $2 WHERE id = $1`, [
    runId,
    served.versionId,
  ]);

  const input = await inputsOf<Record<string, unknown>>(deps.sql, runId, deps.sealKey);
  const creds = await deps.credentials(run.bank);
  // Everything known before the run is masked wherever it appears; the crawler adds the member's
  // name to this same list when the bank first shows it.
  const known = [input.memberId, input.account, input.from, input.to, creds.password]
    .filter((v): v is string => typeof v === 'string')
    .concat(creds.operatorId);
  const guarded = runGuard({
    job: run.task as (typeof JOBS)[number],
    ...(table.names ? { names: table.names } : {}),
    // Only the password. A username is not a secret: the bank prints it on every page.
    secrets: [creds.password],
  });
  // A resumed run carries on its trail after the steps and frames it already has.
  let { step: stepSeq, frame: frameSeq } = await trailEnd(deps.sql, runId);
  let pictured: { step: number; frame: number } | null = null;
  let lastAt = Date.now();

  const keep = async (seen: Seen, f: Frame) => {
    stepSeq++;
    const ms = Date.now() - lastAt;
    lastAt = Date.now();
    await addStep(deps.sql, runId, stepSeq, {
      name: seen.page ?? 'unknown page',
      screen: seen.screen,
      action: seen.did,
      ms,
    });
    if (frameSeq >= MAX_FRAMES) return;
    try {
      // The frame is masked already: the runtime paints out every known value before it is kept.
      frameSeq++;
      const base = `runs/${runId}/${String(frameSeq).padStart(3, '0')}`;
      const { picture, ...page } = f;
      await deps.store.put(`${base}.png`, picture, 'image/png');
      await deps.store.put(`${base}.json`, Buffer.from(JSON.stringify(page)), 'application/json');
      const address = new URL(f.address);
      await addFrame(deps.sql, runId, frameSeq, {
        stepSeq,
        imageKey: `${base}.png`,
        modelKey: `${base}.json`,
        host: address.host,
        path: address.pathname,
      });
      pictured = { step: stepSeq, frame: frameSeq };
    } catch {
      // A capture failure is recorded by its absence and never breaks the run.
    }
  };
  const note = async (name: string, action: string) => {
    stepSeq++;
    await addStep(deps.sql, runId, stepSeq, { name, screen: null, action, ms: 0 });
  };

  const deadline = () => new Date(now().getTime() + (deps.humanDeadlineMs ?? 15 * 60_000));
  const askPerson = async (kind: 'staff_code', prompt: string) => {
    const due = deadline();
    const task = await openHumanTask(deps.sql, runId, kind, { bank: run.bank, prompt }, due);
    const a = await awaitAnswer(deps.sql, task, deps.answerKey, due, deps.pollMs);
    if (a.status === 'expired') throw new Expired();
    if (a.status === 'cancelled') throw new Cancelled();
    return a.answer;
  };

  const sessionOf = (page: Page): Session => ({
    page,
    url: bank.url,
    table,
    known,
    credentials: async () => creds,
    code: () =>
      askPerson('staff_code', 'The bank sent a sign-in code to the staff phone. Enter it here.'),
    keep,
    note,
    guard: (a: Action) => guarded.guard(a),
  });

  // The run's browser: launched when first needed, held while a person decides, and replaced by a
  // fresh one if it was lost meanwhile.
  let browser: Browser | null = null;
  let page: Page | null = null;
  const hold = async (): Promise<{ s: Session; fresh: boolean }> => {
    if (browser?.isConnected() && page && !page.isClosed())
      return { s: sessionOf(page), fresh: false };
    await browser?.close().catch(() => undefined);
    browser = await (deps.launch ?? launch)();
    page = await newPage(browser, deps.headers ? { headers: deps.headers } : {});
    return { s: sessionOf(page), fresh: true };
  };

  let ending: Ending;
  try {
    ending =
      run.task === 'transfer'
        ? await runTransfer({
            sql: deps.sql,
            runId,
            input: input as unknown as TransferTask,
            known,
            hold,
            note,
            lastFrame: () =>
              pictured?.step === stepSeq ? { runId, seq: pictured.frame } : undefined,
            granted: guarded.granted,
            deadline,
            ...(deps.pollMs ? { pollMs: deps.pollMs } : {}),
          })
        : {
            status: 'succeeded',
            data: await checkBalance((await hold()).s, {
              member: String(input.memberId),
              account: String(input.account),
            }),
          };
  } catch (e) {
    ending = endingOf(e);
  } finally {
    await (browser as Browser | null)?.close().catch(() => undefined);
  }
  // A refusal ends the run as a trip, whatever came of the error: the bank is frozen with the
  // refusal's layer and rule when the run settles.
  const trip = guarded.tripped();
  if (trip) ending = { status: 'escalated', code: 'guard_tripped', guard: trip };
  await settleRun(deps.sql, runId, ending);
  // A page the crawler does not know is the crawler's fault, never the bank's: it is taken out of
  // service, and a repair case opens (plan, §7). A hazard forced in the lab is the bank
  // misbehaving on purpose, and is no fault.
  if (
    ending.status === 'escalated' &&
    ending.code === 'unknown_screen' &&
    !(await forcedHazardsOf(deps.sql, runId)).length
  )
    await driverFault(deps.sql, {
      tenant: run.bank,
      task: run.task,
      versionId: served.versionId,
      runId,
      why: 'a page the crawler does not know',
    });
  return ending;
}

/** How a run that threw ends: the crawler's own word, or ours. */
export function endingOf(e: unknown): Ending {
  if (e instanceof Stop) {
    const { status, code, retryable } = e.ended;
    return { status, code, ...(retryable !== undefined ? { retryable } : {}) };
  }
  if (e instanceof Expired) return { status: 'expired', code: 'expired' };
  if (e instanceof Cancelled) return { status: 'cancelled', code: 'cancelled' };
  if (e instanceof GuardError) return { status: 'escalated', code: 'guard_tripped' };
  if (e instanceof Error && e.name === 'TimeoutError')
    return { status: 'failed', code: 'step_timeout', retryable: true };
  // Something we did not expect: a person should look.
  return { status: 'escalated', code: 'stuck' };
}

class Expired extends Error {}
class Cancelled extends Error {}
