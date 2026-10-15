// One task run, carried out: a fresh browser, the bank's driver, every step recorded and every frame
// masked before it is stored, a person asked when only a person can answer, and exactly one result.
import { checkBalance, type DriverContext, PROFILES, type StepRecord } from '@gb/drivers';
import { type FrameStore, frameOf } from '@gb/evidence';
import {
  addFrame,
  addStep,
  type Ending,
  inputsOf,
  loadRun,
  openHumanTask,
  awaitAnswer,
  settleRun,
  type Sql,
} from '@gb/runs';
import { ActError, Browser, CdpTimeout, type ScreenModel, TargetError } from '@gb/screen';

export interface RunDeps {
  sql: Sql;
  store: FrameStore;
  sealKey: string;
  /** The staff service account for a bank (from Vault in the plan; from the Runner's secrets here). */
  credentials(bank: string): Promise<{ operatorId: string; password: string }>;
  launch?: () => Promise<Browser>;
  /** How long a person has to answer a human task. */
  humanDeadlineMs?: number;
  now?: () => Date;
  headers?: Record<string, string>;
}

/** At most this many frames per run (plan, §I.1); the last step always gets one. */
const MAX_FRAMES = 60;

export async function executeRun(runId: string, deps: RunDeps): Promise<Ending> {
  const now = deps.now ?? (() => new Date());
  const run = await loadRun(deps.sql, runId);
  if (!run) throw new Error(`no run ${runId}`);
  if (run.status !== 'running' && run.status !== 'needs_human')
    return { status: 'failed', code: 'app_error' };

  const bank = (
    await deps.sql.query<{ url: string }>('SELECT url FROM "Bank" WHERE id = $1', [run.bank])
  ).rows[0];
  const promoted = (
    await deps.sql.query<{ id: string }>(
      `SELECT id FROM "Driver" WHERE tenant = $1 AND task = $2 AND state = 'promoted'`,
      [run.bank, run.task],
    )
  ).rows[0];
  const profile = PROFILES[run.bank];
  if (!bank || !promoted || !profile || run.task !== 'check-balance') {
    const e: Ending = { status: 'failed', code: 'no_driver', retryable: false };
    await settleRun(deps.sql, runId, e);
    return e;
  }

  const input = await inputsOf<{ memberId: string; account: string }>(
    deps.sql,
    runId,
    deps.sealKey,
  );
  const creds = await deps.credentials(run.bank);
  // Everything known before the run is masked wherever it appears.
  const known = [input.memberId, input.account, creds.password, creds.operatorId];
  let stepSeq = 0;
  let frameSeq = 0;

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
    } catch {
      // A capture failure is recorded by its absence and never breaks the run.
    }
  };

  const browser = await (
    deps.launch ?? (() => Browser.launch(deps.headers ? { headers: deps.headers } : {}))
  )();
  let ending: Ending;
  try {
    const page = await browser.newPage();
    if (deps.headers) await page.call('Network.setExtraHTTPHeaders', { headers: deps.headers });
    const ctx: DriverContext = {
      page,
      profile: { ...profile, url: bank.url },
      credentials: async () => creds,
      askHuman: async (req) => {
        const deadline = new Date(now().getTime() + (deps.humanDeadlineMs ?? 15 * 60_000));
        const task = await openHumanTask(
          deps.sql,
          runId,
          req.kind,
          { bank: run.bank, prompt: req.prompt },
          deadline,
        );
        const answer = await awaitAnswer(deps.sql, task, deps.sealKey, deadline);
        if (answer === null) throw new Expired();
        return answer;
      },
      // A name the bank shows is masked from then on, and so is each of its words.
      learn: (values) => {
        for (const v of values)
          for (const part of [v, ...v.split(/[\s.,]+/)])
            if (part.trim().length >= 2 && !known.includes(part)) known.push(part);
      },
      step: record,
      now,
    };
    const out = await checkBalance(ctx, input);
    ending =
      out.status === 'succeeded'
        ? {
            status: 'succeeded',
            data: { ...out.data, accountLabel: out.data.accountLabel.replace(/\d/g, '*') },
          }
        : {
            status: out.status,
            code: out.code,
            ...(out.retryable !== undefined ? { retryable: out.retryable } : {}),
          };
  } catch (e) {
    // Our own failures are ours to say: the bank too slow, a screen we could not act on, or
    // something we did not expect, which a person should look at.
    ending =
      e instanceof Expired
        ? { status: 'expired', code: 'expired' }
        : e instanceof CdpTimeout
          ? { status: 'failed', code: 'step_timeout', retryable: true }
          : e instanceof TargetError || e instanceof ActError
            ? { status: 'escalated', code: 'unknown_screen' }
            : { status: 'escalated', code: 'stuck' };
  } finally {
    await browser.close();
  }
  await settleRun(deps.sql, runId, ending);
  return ending;
}

class Expired extends Error {}
