// One task run, carried out: a browser held for the run, the bank's driver, every step recorded and
// every frame masked before it is stored, a person asked when only a person can answer, and exactly
// one result.
import {
  type BalanceInput,
  checkBalance,
  type DriverContext,
  downloadStatements,
  type StepRecord,
} from '@gb/drivers';
import { type FrameStore, frameOf } from '@gb/evidence';
import {
  addFrame,
  addStep,
  type Ending,
  inputsOf,
  loadRun,
  openHumanTask,
  awaitAnswer,
  driverFault,
  forcedHazardsOf,
  serving,
  settleRun,
  type Sql,
  trailEnd,
} from '@gb/runs';
import {
  ActError,
  Browser,
  CdpTimeout,
  guardActions,
  type Page,
  type ScreenModel,
  TargetError,
} from '@gb/screen';
import { JOBS } from '@gb/guardrails';
import { runGuard } from './guard.js';
import { keepStatements } from './statements.js';
import { runTransfer, type TransferTask } from './transfer.js';

export interface RunDeps {
  sql: Sql;
  store: FrameStore;
  sealKey: string;
  /** Opens a person's answer (a staff code). The Console seals with it; it opens no run's inputs. */
  answerKey: string;
  /**
   * The staff service account for a bank (from the Runner's secrets, which SOPS keeps),
   * and the supervisor whose code a person reads when a transfer is over the bank's threshold.
   */
  credentials(
    bank: string,
  ): Promise<{ operatorId: string; password: string; supervisorId?: string }>;
  launch?: () => Promise<Browser>;
  /** How long a person has to answer a human task. */
  humanDeadlineMs?: number;
  /** How often a waiting run looks for a person's answer. */
  pollMs?: number;
  now?: () => Date;
  headers?: Record<string, string>;
}

/** At most this many frames per run (plan, §I.1); the last step always gets one. */
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
  // The version serving the task now, and its profile; a frozen bank, or none, runs nothing.
  const served = await serving(deps.sql, run.bank, run.task);
  if (!bank || !served || !TASKS.has(run.task)) {
    const e: Ending = { status: 'failed', code: 'no_driver', retryable: false };
    await settleRun(deps.sql, runId, e);
    return e;
  }
  const profile = served.profile;
  await deps.sql.query(`UPDATE "TaskRun" SET "driverVersionId" = $2 WHERE id = $1`, [
    runId,
    served.versionId,
  ]);

  const input = await inputsOf<Record<string, unknown>>(deps.sql, runId, deps.sealKey);
  const creds = await deps.credentials(run.bank);
  // Everything known before the run is masked wherever it appears.
  const known = [
    ...[input.memberId, input.account, input.from, input.to].filter(
      (v): v is string => typeof v === 'string',
    ),
    creds.password,
    creds.operatorId,
  ];
  // Every action on every page the run opens passes the job's guard first.
  const guarded = runGuard({
    job: run.task as (typeof JOBS)[number],
    profile,
    // Only the password. A username is not a secret: the bank prints it on every page.
    secrets: [creds.password],
  });
  // A resumed run carries on its trail after the steps and frames it already has.
  let { step: stepSeq, frame: frameSeq } = await trailEnd(deps.sql, runId);
  let pictured: { step: number; frame: number } | null = null;

  const record = async (s: StepRecord, model: ScreenModel | null) => {
    stepSeq++;
    await addStep(deps.sql, runId, stepSeq, s);
    if (!model || frameSeq >= MAX_FRAMES) return;
    try {
      const f = frameOf(
        model,
        { known, safePictures: profile.safePictures },
        { step: stepSeq, at: now(), screen: s.screen },
      );
      frameSeq++;
      const base = `runs/${runId}/${String(frameSeq).padStart(3, '0')}`;
      if (f.image) await deps.store.put(`${base}.png`, f.image, 'image/png');
      await deps.store.put(
        `${base}.json`,
        Buffer.from(JSON.stringify(f.model)),
        'application/json',
      );
      await addFrame(deps.sql, runId, frameSeq, {
        stepSeq,
        imageKey: f.image ? `${base}.png` : null,
        modelKey: `${base}.json`,
        withheld: f.withheld,
        host: f.host,
        path: f.path,
      });
      if (f.image) pictured = { step: stepSeq, frame: frameSeq };
    } catch {
      // A capture failure is recorded by its absence and never breaks the run.
    }
  };

  const deadline = () => new Date(now().getTime() + (deps.humanDeadlineMs ?? 15 * 60_000));
  const askPerson = async (kind: 'staff_code' | 'supervisor_code', prompt: string) => {
    const due = deadline();
    const task = await openHumanTask(deps.sql, runId, kind, { bank: run.bank, prompt }, due);
    const a = await awaitAnswer(deps.sql, task, deps.answerKey, due, deps.pollMs);
    if (a.status === 'expired') throw new Expired();
    if (a.status === 'cancelled') throw new Cancelled();
    return a.answer;
  };

  const contextOf = (page: Page): DriverContext => ({
    page,
    profile: { ...profile, url: bank.url },
    credentials: async () => creds,
    askHuman: (req) => askPerson(req.kind, req.prompt),
    // A name the bank shows is masked from then on, and so is each of its words.
    learn: (values) => {
      for (const v of values)
        for (const part of [v, ...v.split(/[\s.,]+/)])
          if (part.trim().length >= 2 && !known.includes(part)) known.push(part);
    },
    step: record,
    now,
  });

  // The run's browser: launched when first needed, held while a person decides, and replaced by a
  // fresh one if it was lost meanwhile.
  let browser: Browser | null = null;
  let page: Page | null = null;
  const launch =
    deps.launch ?? (() => Browser.launch(deps.headers ? { headers: deps.headers } : {}));
  const hold = async (): Promise<{ ctx: DriverContext; fresh: boolean }> => {
    if (browser && page && (await alive(browser, page)))
      return { ctx: contextOf(page), fresh: false };
    await browser?.close().catch(() => undefined);
    browser = await launch();
    page = await browser.newPage();
    guardActions(page, guarded.guard);
    if (deps.headers) await page.call('Network.setExtraHTTPHeaders', { headers: deps.headers });
    return { ctx: contextOf(page), fresh: true };
  };

  let ending: Ending;
  try {
    ending =
      run.task === 'transfer'
        ? await runTransfer({
            sql: deps.sql,
            runId,
            profile,
            input: input as unknown as TransferTask,
            known,
            supervisorId: creds.supervisorId ?? '',
            hold,
            note: (name, action) => record({ name, screen: null, action, ms: 0 }, null),
            lastFrame: () =>
              pictured?.step === stepSeq ? { runId, seq: pictured.frame } : undefined,
            ask: askPerson,
            granted: guarded.granted,
            deadline,
            ...(deps.pollMs ? { pollMs: deps.pollMs } : {}),
          })
        : run.task === 'download-statements'
          ? await keepStatements(
              runId,
              await downloadStatements((await hold()).ctx, {
                ...(input as unknown as BalanceInput),
                months: (input.months as string[] | undefined) ?? [],
              }),
              deps.store,
            )
          : await balance((await hold()).ctx, input as unknown as BalanceInput);
  } catch (e) {
    // Our own failures are ours to say: the bank too slow, a screen we could not act on, or
    // something we did not expect, which a person should look at.
    ending =
      e instanceof Expired
        ? { status: 'expired', code: 'expired' }
        : e instanceof Cancelled
          ? { status: 'cancelled', code: 'cancelled' }
          : e instanceof CdpTimeout
            ? { status: 'failed', code: 'step_timeout', retryable: true }
            : e instanceof TargetError || e instanceof ActError
              ? { status: 'escalated', code: 'unknown_screen' }
              : { status: 'escalated', code: 'stuck' };
  } finally {
    await (browser as Browser | null)?.close();
  }
  // A refusal ends the run as a trip, whatever the driver made of the error: the bank is frozen
  // with the refusal's layer and rule when the run settles.
  const trip = guarded.tripped();
  if (trip) ending = { status: 'escalated', code: 'guard_tripped', guard: trip };
  await settleRun(deps.sql, runId, ending);
  // A screen the driver does not know is the driver's fault, never the bank's: it is taken out of
  // service, and a repair case opens (plan, Appendix L). A hazard forced in the lab is the bank
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
      why: 'a screen the driver does not know',
    });
  return ending;
}

async function balance(ctx: DriverContext, input: BalanceInput): Promise<Ending> {
  const out = await checkBalance(ctx, input);
  return out.status === 'succeeded'
    ? {
        status: 'succeeded',
        data: { ...out.data, accountLabel: out.data.accountLabel.replace(/\d/g, '*') },
      }
    : {
        status: out.status,
        code: out.code,
        ...(out.retryable !== undefined ? { retryable: out.retryable } : {}),
      };
}

/** Whether a held page still answers, asked of the browser and never of the page's scripts. */
const alive = (b: Browser, p: Page) =>
  !b.cdp.isClosed &&
  p.call('Page.getFrameTree', {}, 5000).then(
    () => true,
    () => false,
  );

class Expired extends Error {}
class Cancelled extends Error {}
