// just measure: the models' sight, measured on bank 2's captured pages before any live run. It
// goes through the factory's gateway like a run, so every call is metered and capped, and prints
// one row per page.
import { readdirSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { loadConfig, secret } from '@gb/config';
import { sql as connect } from '@gb/db';
import { Agent as Dispatcher, setGlobalDispatcher } from 'undici';
import { z } from 'zod';
import { TURN_MS } from './agent.js';
import { measurePage, table, type Truth } from './measure.js';
import { ROLE_SETTINGS, rolesOf } from './models.js';

const cfg = loadConfig(
  {
    CONTROL_DATABASE_URL: z.string().startsWith('postgresql://'),
    FACTORY_URL: z.string().url().default('http://factory:8200'),
    FACTORY_GATEWAY_TOKEN: secret(),
    ...ROLE_SETTINGS,
  },
  process.env,
  ['FACTORY_GATEWAY_TOKEN'],
);
setGlobalDispatcher(new Dispatcher({ headersTimeout: TURN_MS, bodyTimeout: TURN_MS }));

const dir = new URL('../measure/bank-2/', import.meta.url);
const sql = connect(cfg.CONTROL_DATABASE_URL);
const runId = `measure-example-${randomBytes(4).toString('hex')}`;
// The gateway meters a run it knows: the measurement is one.
await sql.query(
  `INSERT INTO "FactoryRun" (id, tenant, task, mode, phase, status) VALUES ($1, 'example', 'check-balance', 'measure', 'MEASURE', 'running')`,
  [runId],
);
const roles = rolesOf(cfg);
const agent = (role: 'scout' | 'supervisor') => ({
  model: roles[role],
  url: `${cfg.FACTORY_URL}/gateway/${runId}/${role}`,
  token: cfg.FACTORY_GATEWAY_TOKEN,
});
const scores = [];
try {
  for (const f of readdirSync(dir)
    .filter((n) => n.endsWith('.json'))
    .sort()) {
    const truth = JSON.parse(readFileSync(new URL(f, dir), 'utf8')) as Truth;
    const picture = readFileSync(new URL(f.replace(/\.json$/, '.png'), dir));
    console.log(`measuring ${truth.page}`);
    scores.push(
      await measurePage(
        { scout: agent('scout'), supervisor: agent('supervisor') },
        picture,
        truth,
      ).catch((e: Error) => ({
        page: truth.page,
        controls: 0,
        found: 0,
        pictureFields: 0,
        read: 0,
        invented: 0,
        missed: [],
        supervisor: `failed: ${e.message.slice(0, 120)}`,
      })),
    );
  }
} finally {
  const spend = (
    await sql.query<{ usd: string | null }>(
      `SELECT SUM("costUsd") AS usd FROM "ModelCall" WHERE "factoryRunId" = $1`,
      [runId],
    )
  ).rows[0]?.usd;
  await sql.query(
    `UPDATE "FactoryRun" SET status = 'succeeded', phase = 'DONE', "spendUsd" = $2 WHERE id = $1`,
    [runId, Number(spend ?? 0)],
  );
  console.log(`\n${table(scores)}\n\ncost: $${Number(spend ?? 0).toFixed(2)} (${runId})`);
}
process.exit();
