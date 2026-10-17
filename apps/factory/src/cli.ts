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
import { fileStore } from '@gb/evidence';
import { openRepairCase, tableOf } from '@gb/runs';
import { launch } from '@gb/runtime';
import { Agent as Dispatcher, setGlobalDispatcher } from 'undici';
import { z } from 'zod';
import { TURN_MS } from './agent.js';
import { gate } from './gate.js';
import { memoryClient } from './memory.js';
import { ROLE_SETTINGS, rolesOf } from './models.js';
import { personCode } from './person.js';
import { factoryRun } from './run.js';
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
const code = (runId: string) => personCode({ sql, runId, bank, answerKey: cfg.ANSWER_SEAL_KEY })();
const log = (line: string) => console.log(line);
const browser = await launch();

/** What a repair starts from: the table that broke, and where its run stopped. */
async function repairOf(): Promise<{ table: Table; diagnosis: string } | undefined> {
  const c = await openRepairCase(sql, bank!, 'check-balance');
  if (!c?.runId) return undefined;
  const table =
    ((await tableOf(sql, c.versionId)) as Table | null) ??
    (
      await sql.query<{ table: Table }>(
        `SELECT "table" FROM "Recommendation" WHERE tenant = $1 AND status = 'broken' ORDER BY "createdAt" DESC LIMIT 1`,
        [bank],
      )
    ).rows[0]?.table;
  if (!table) return undefined;
  const frames = await framesOf(sql, store, c.runId);
  const last = frames.at(-1);
  return {
    table,
    diagnosis: `Run ${c.runId} stopped at its frame f${frames.length}${last ? `, which showed: ${last.texts.slice(0, 20).join(' · ')}` : ''}. open_frame with run ${c.runId} shows its frames.`,
  };
}

/** The run's report: its cost, the actions targeting confirmed or refused, the corrections, the lessons. */
async function report(runId: string) {
  const spend = (
    await sql.query<{ usd: string | null }>(
      `SELECT SUM("costUsd") AS usd FROM "ModelCall" WHERE "factoryRunId" = $1`,
      [runId],
    )
  ).rows[0]?.usd;
  const steps = (
    await sql.query<{ name: string; action: string | null; outcome: string | null }>(
      `SELECT name, action, outcome FROM "Step" WHERE "runId" = $1 ORDER BY seq`,
      [runId],
    )
  ).rows;
  const sup = steps.filter((s) => s.name === 'supervisor');
  log(`cost: $${Number(spend ?? 0).toFixed(2)}`);
  log(`actions: ${sup.length} judged, ${steps.filter((s) => s.name === 'refused').length} refused`);
  log(
    `corrections citing a frame: ${sup.filter((s) => s.action !== 'continue' && /\bf\d+\b/.test(s.outcome ?? '')).length}`,
  );
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
  const repair = await repairOf();
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
    },
    { bank, member, from, to, ...(repair ? { repair } : {}) },
  );
  await report(run.runId);
  if (!run.table) {
    log(`not every goal was reached (${run.reached.join(', ') || 'none'}): ${run.diagnosis ?? ''}`);
    process.exitCode = 1;
  } else {
    const g = await gate(
      {
        sql,
        store,
        browser,
        credentials,
        code,
        ...(cfg.HAZARD_HMAC_KEY ? { hazardKey: cfg.HAZARD_HMAC_KEY } : {}),
      },
      { factoryRunId: run.runId, bank, url, table: run.table, member, from, to },
    );
    for (const r of g.runs)
      log(`gate ${r.hazard ?? 'plain'}: ${r.ok ? 'passed' : 'failed'}: ${r.said}`);
    log(
      g.recommendationId
        ? `Approve or reject it in the Console: http://localhost:${cfg.CONSOLE_PORT}/recommendations`
        : 'Not recommended. A table that broke under the hazard has a repair case: run this again to repair it.',
    );
    if (!g.recommendationId) process.exitCode = 1;
  }
} finally {
  await browser.close();
}
process.exit();
