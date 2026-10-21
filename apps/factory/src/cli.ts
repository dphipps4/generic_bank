// The factory's one command, run as a one-off container beside the factory (just factory):
//   factory <bank> <member> <from> <to>
// It repairs the bank's table if a repair case is open, and learns the bank otherwise; then the
// gate. A person gives the member and two of their accounts (by name or last four), as a caller of
// the API would, and the codes the bank sends, through the Console's inbox. Banks with a table
// written by hand are not the factory's: their author fixes them. The models are reached only
// through the factory's gateway, which meters them and holds them to the caps.
import { TABLES, type Table } from '@gb/crawler';
import { loadConfig, secret } from '@gb/config';
import { sql as connect } from '@gb/db';
import { fileStore, openRepairCase, tableOf } from '@gb/runs';
import { launch } from '@gb/runtime';
import { Agent as Dispatcher, setGlobalDispatcher } from 'undici';
import { z } from 'zod';
import { TURN_MS } from './agent.js';
import { gate } from './gate.js';
import { memoryClient } from './memory.js';
import { ROLE_SETTINGS, rolesOf } from './models.js';
import { personCode } from './person.js';
import { factoryRun } from './run.js';
import { dbNow, failOpenFactoryRuns } from './settle.js';
import { framesOf } from './trail.js';

const cfg = loadConfig(
  {
    CONTROL_DATABASE_URL: z.string().startsWith('postgresql://'),
    FACTORY_URL: z.string().url().default('http://factory:8200'),
    FACTORY_GATEWAY_TOKEN: secret(),
    EVIDENCE_DIR: z.string().min(1).default('/data/evidence'),
    BANK_SERVICE_PASSWORD: z.string().min(16),
    BANK_OPERATOR_ID: z.string().min(8),
    ANSWER_SEAL_KEY: secret(),
    HAZARD_HMAC_KEY: secret().optional(),
    CONSOLE_PORT: z.coerce.number().int().default(8080),
    MEMORY_URL: z.url().default('http://memory:8470'),
    MEMORY_TOKEN_FACTORY: secret(),
    MEMORY_SIGNING_KEY: secret(),
    ...ROLE_SETTINGS,
  },
  process.env,
  [
    'FACTORY_GATEWAY_TOKEN',
    'ANSWER_SEAL_KEY',
    'HAZARD_HMAC_KEY',
    'MEMORY_TOKEN_FACTORY',
    'MEMORY_SIGNING_KEY',
  ],
);

// The gateway answers a turn once the model has finished; a turn may take as long as TURN_MS.
setGlobalDispatcher(new Dispatcher({ headersTimeout: TURN_MS, bodyTimeout: TURN_MS }));

const [bank, member, from, to] = process.argv.slice(2);
if (!bank || !member || !from || !to) {
  console.error('usage: cli.js <bank> <member> <from> <to>');
  process.exit(2);
}
if (TABLES[bank]) {
  console.error(`${bank}'s table is written by hand: its author fixes it, not the factory`);
  process.exit(2);
}

const sql = connect(cfg.CONTROL_DATABASE_URL);
const store = fileStore(cfg.EVIDENCE_DIR);
const credentials = { operatorId: cfg.BANK_OPERATOR_ID, password: cfg.BANK_SERVICE_PASSWORD };
// A person has 5 minutes to give a code; no wait in a factory run is long.
const code = (runId: string) =>
  personCode({ sql, runId, bank, answerKey: cfg.ANSWER_SEAL_KEY, deadlineMs: 5 * 60_000 })();
const log = (line: string) => console.log(line);

// No run ends showing as running. A run older than the recipe's hard stop has no process left:
// it ends as failed before this one starts. What this process starts from now on is its own, and
// whatever it leaves open ends as failed, however it stops: an error, a signal, a crash.
const HARD_STOP_MS = (Number(process.env.FACTORY_RUN_LIMIT_MINUTES ?? 60) + 15) * 60_000;
const swept = await failOpenFactoryRuns(sql, bank, { olderThanMs: HARD_STOP_MS });
if (swept) log(`ended ${swept} earlier runs that a stopped process had left running`);
const since = await dbNow(sql);
const leaveNothingOpen = () => failOpenFactoryRuns(sql, bank, { since }).catch(() => 0);
const stop = (code: number) => () => void leaveNothingOpen().finally(() => process.exit(code));
process.once('SIGTERM', stop(143));
process.once('SIGINT', stop(130));
for (const event of ['uncaughtException', 'unhandledRejection'] as const)
  process.once(event, (e) => {
    console.error(e);
    stop(1)();
  });
const browser = await launch();

/** Where a run stopped: its last frame and what it showed, for the repair to open. */
async function whereItStopped(runId: string, said?: string) {
  const frames = await framesOf(sql, store, runId);
  const last = frames.at(-1);
  return `Run ${runId}${said ? ` (${said})` : ''} stopped at its frame f${frames.length}${last ? `, which showed: ${last.texts.slice(0, 20).join(' · ')}` : ''}. open_frame with run ${runId} shows its frames.`;
}

/**
 * What a repair starts from: the table of the bank's open repair case, where it last broke. A
 * served version's table, or the table the gate failed in the replay the case names.
 */
async function repairOf(): Promise<{ table: Table; diagnosis: string } | undefined> {
  const c = await openRepairCase(sql, bank!, 'check-balance');
  if (!c?.runId) return undefined;
  const table =
    ((await tableOf(sql, c.versionId)) as Table | null) ??
    (
      await sql.query<{ table: Table }>(
        `SELECT "table" FROM "Recommendation"
          WHERE tenant = $1 AND "check" @> jsonb_build_array(jsonb_build_object('runId', $2::text))
          ORDER BY "createdAt" DESC LIMIT 1`,
        [bank, c.runId],
      )
    ).rows[0]?.table;
  if (!table) return undefined;
  return { table, diagnosis: await whereItStopped(c.runId) };
}

/**
 * The agents' hour, across every pass: a pass whose route fails the gate is repaired by the next,
 * from that route and where the gate stopped, while enough of the hour is left for one.
 */
const RUN_LIMIT_MS = Number(process.env.FACTORY_RUN_LIMIT_MINUTES ?? 60) * 60_000;
const PASS_MS = 10 * 60_000;
/** Passes a run may make: one, until a person turns repair passes back on. */
const PASSES = Math.max(1, Number(process.env.FACTORY_PASSES ?? 1));

/** A run's steps, in order. */
async function stepsOf(runId: string) {
  return (
    await sql.query<{ name: string; action: string | null; outcome: string | null }>(
      `SELECT name, action, outcome FROM "Step" WHERE "runId" = $1 ORDER BY seq`,
      [runId],
    )
  ).rows;
}

/** The run's report: its cost, the actions targeting confirmed or refused, the corrections, the lessons. */
async function report(runId: string) {
  const spend = (
    await sql.query<{ usd: string | null }>(
      `SELECT SUM("costUsd") AS usd FROM "ModelCall" WHERE "factoryRunId" = $1`,
      [runId],
    )
  ).rows[0]?.usd;
  const steps = await stepsOf(runId);
  const sup = steps.filter((s) => s.name === 'supervisor');
  log(`cost: $${Number(spend ?? 0).toFixed(2)}`);
  log(`actions: ${sup.length} judged, ${steps.filter((s) => s.name === 'refused').length} refused`);
  log(
    `corrections citing a frame: ${sup.filter((s) => s.action !== 'continue' && /\bf\d+\b/.test(s.outcome ?? '')).length}`,
  );
  // The evidence is complete, or the report says where it is not: every action with its frame, every
  // refusal with what was asked, every judgment whole, and the agents' thinking kept.
  const framed = (
    await sql.query<{ seq: number; framed: boolean }>(
      `SELECT s.seq, EXISTS (SELECT 1 FROM "TrailFrame" f WHERE f."runId" = s."runId" AND f."stepSeq" = s.seq) AS framed
         FROM "Step" s WHERE s."runId" = $1 AND s.name IN ('balance', 'transfer', 'history')`,
      [runId],
    )
  ).rows;
  const bare = framed.filter((r) => !r.framed).map((r) => r.seq);
  const refusedBare = steps.filter(
    (s) => s.name === 'refused' && !/ · input /.test(s.action ?? ''),
  );
  log(
    `evidence: ${framed.length} actions, ${bare.length ? `${bare.length} without a frame (steps ${bare.join(', ')})` : 'each with its frame'}; ${
      refusedBare.length
        ? `${refusedBare.length} refusals without their input`
        : 'every refusal with its input'
    }; ${steps.filter((s) => s.name === 'scout thought').length} Scout replies and ${
      steps.filter((s) => s.name === 'supervisor thought').length
    } Supervisor thoughts kept`,
  );
  // Every slow judgment, with its packet to replay on its frame.
  for (const s of steps.filter((x) => x.name === 'slow judgment'))
    log(`slow judgment at ${s.action}: ${s.outcome}`);
}

/** The lessons the run sent to memory: after `finish`, so after the report. */
async function lessonsLine(runId: string) {
  const steps = await stepsOf(runId);
  log(
    `lessons: ${
      steps
        .filter((s) => s.name === 'memory')
        .map((s) => `${s.action} ${s.outcome}`)
        .join('; ') || 'none sent'
    }`,
  );
}

try {
  const url = (await sql.query<{ url: string }>('SELECT url FROM "Bank" WHERE id = $1', [bank]))
    .rows[0]?.url;
  if (!url) throw new Error(`no bank ${bank} in the registry`);
  const endsAt = Date.now() + RUN_LIMIT_MS;
  let repair = await repairOf();
  let passed = false;
  for (let pass = 1; !passed && pass <= PASSES; pass++) {
    if (pass > 1) {
      const left = endsAt - Date.now();
      if (left < PASS_MS) {
        log(`no time for another pass: ${Math.round(left / 60_000)} minutes of the hour are left`);
        break;
      }
      log(`pass ${pass}: ${Math.round(left / 60_000)} minutes of the hour are left`);
    }
    log(repair ? `repairing ${bank}: ${repair.diagnosis}` : `learning ${bank}`);
    const run = await factoryRun(
      {
        sql,
        store,
        browser,
        factoryUrl: cfg.FACTORY_URL,
        gatewayToken: cfg.FACTORY_GATEWAY_TOKEN,
        roles: rolesOf(cfg),
        credentials,
        code,
        memory: memoryClient({
          url: cfg.MEMORY_URL,
          token: cfg.MEMORY_TOKEN_FACTORY,
          signingKey: cfg.MEMORY_SIGNING_KEY,
        }),
        log,
        ...(cfg.HAZARD_HMAC_KEY ? { hazardKey: cfg.HAZARD_HMAC_KEY } : {}),
      },
      { bank, member, from, to, endsAt, ...(repair ? { repair } : {}) },
    );
    await report(run.runId);
    if (!run.table) {
      log(`no goal was reached: ${run.diagnosis ?? ''}`);
      // The next pass starts from the same table, or learns afresh; memory has this run's lessons.
      if (repair) repair = { ...repair, diagnosis: `${run.diagnosis ?? ''} ${repair.diagnosis}` };
    } else {
      if (run.reached.length < 3)
        log(
          `learned ${run.reached.join(', ')}; not reached: ${run.diagnosis ?? ''}. The table serves what it covers.`,
        );
      const g = await gate(
        {
          sql,
          store,
          browser,
          credentials,
          code,
          ...(cfg.HAZARD_HMAC_KEY ? { hazardKey: cfg.HAZARD_HMAC_KEY } : {}),
        },
        {
          factoryRunId: run.runId,
          bank,
          url,
          table: run.table,
          member,
          from,
          to,
        },
      );
      for (const r of g.runs)
        log(
          `gate ${r.hazard ?? (r.trusted ? 'trusted' : 'plain')}: ${r.ok ? 'passed' : 'failed'}: ${r.said}`,
        );
      passed = !!g.recommendationId;
      if (passed)
        log(
          `Approve or reject it in the Console: http://localhost:${cfg.CONSOLE_PORT}/recommendations`,
        );
      else {
        const failed = g.runs.find((r) => !r.ok)!;
        repair = { table: run.table, diagnosis: await whereItStopped(failed.runId, failed.said) };
      }
    }
    // The lessons last, after everything a person waits on; the next pass reads them.
    log("writing the run's lessons to memory…");
    await run.finish();
    await lessonsLine(run.runId);
  }
  if (!passed) {
    log(
      'Not recommended: no pass of the hour passed the gate. Its repair case names where it last broke.',
    );
    process.exitCode = 1;
  }
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  await leaveNothingOpen();
  await browser.close();
}
process.exit();
