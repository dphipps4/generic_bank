// The factory's commands, run as a one-off container beside the factory (just onboard, just
// repair):
//   onboard <bank>   a build run at the bank, then the gate once a person approves its profile
//   repair <bank>    a repair run from the bank's open repair case, then the same gate
//   gate <rec>       the gate alone, for a recommendation approved after its run's command ended
// The models are reached only through the factory's gateway, which meters them and, with no key,
// replays the recording kept for the run's kind (mock mode). The hazard check is the sandbox: it
// judges each run by the bank's own records, through the bank's admin port, as the tests do; no
// model ever sees that port or its token.
import { loadConfig, secret } from '@gb/config';
import { sql as connect } from '@gb/db';
import { s3Store } from '@gb/evidence';
import { hazardHeader } from '@gb/runs';
import { Browser } from '@gb/screen';
import { Agent as Dispatcher, setGlobalDispatcher } from 'undici';
import { z } from 'zod';
import { TURN_MS } from './agent.js';
import { decided, gate } from './gate.js';
import type { Sandbox } from './hazard-check.js';
import { memoryClient } from './memory.js';
import { ROLE_SETTINGS, rolesOf } from './models.js';
import { factoryRun, type Mode } from './run.js';

const cfg = loadConfig(
  {
    CONTROL_DATABASE_URL: z.string().startsWith('postgresql://'),
    FACTORY_URL: z.string().url().default('http://factory:8200'),
    FACTORY_GATEWAY_TOKEN: secret(),
    MINIO_ENDPOINT: z.string().url().default('http://minio:9000'),
    MINIO_ROOT_USER: z.string().min(3),
    MINIO_ROOT_PASSWORD: secret(),
    BANK_SERVICE_PASSWORD: z.string().min(16),
    BANK_OPERATOR_ID: z.string().min(8),
    ANSWER_SEAL_KEY: secret(),
    HAZARD_HMAC_KEY: secret(),
    BANK_ADMIN_TOKEN: secret(),
    BANK_ADMIN_PORT: z.coerce.number().int().default(9000),
    FACTORY_MEMBER: z
      .string()
      .regex(/^\d{8}$/)
      .default('40017732'),
    CONSOLE_PORT: z.coerce.number().int().default(8080),
    MEMORY_URL: z.url().default('http://memory:8470'),
    MEMORY_TOKEN_FACTORY: secret(),
    MEMORY_SIGNING_KEY: secret(),
    ...ROLE_SETTINGS,
  },
  process.env,
  [
    'FACTORY_GATEWAY_TOKEN',
    'MINIO_ROOT_PASSWORD',
    'ANSWER_SEAL_KEY',
    'HAZARD_HMAC_KEY',
    'MEMORY_TOKEN_FACTORY',
    'MEMORY_SIGNING_KEY',
  ],
);

// The gateway answers a turn once the model has finished, and Node's fetch gives up on headers after
// five minutes: a turn may take as long as TURN_MS.
setGlobalDispatcher(new Dispatcher({ headersTimeout: TURN_MS, bodyTimeout: TURN_MS }));

const [command, arg] = process.argv.slice(2);
if (!['onboard', 'repair', 'gate'].includes(command ?? '') || !arg) {
  console.error('usage: cli.js onboard <bank> | repair <bank> | gate <recommendation>');
  process.exit(2);
}

const sql = connect(cfg.CONTROL_DATABASE_URL);
const store = s3Store({
  endpoint: cfg.MINIO_ENDPOINT,
  bucket: 'evidence',
  accessKey: cfg.MINIO_ROOT_USER,
  secretKey: cfg.MINIO_ROOT_PASSWORD,
});
const credentials = { operatorId: cfg.BANK_OPERATOR_ID, password: cfg.BANK_SERVICE_PASSWORD };
const memory = memoryClient({
  url: cfg.MEMORY_URL,
  token: cfg.MEMORY_TOKEN_FACTORY,
  signingKey: cfg.MEMORY_SIGNING_KEY,
});
const log = (line: string) => console.log(line);
const browser = await Browser.launch();

/** The bank's ground truth, for the hazard check: its ledger, and the codes it sent. */
async function sandboxAt(bank: string): Promise<Sandbox> {
  const url = (await sql.query<{ url: string }>('SELECT url FROM "Bank" WHERE id = $1', [bank]))
    .rows[0]?.url;
  if (!url) throw new Error(`no bank ${bank} in the registry`);
  const admin = `http://${new URL(url).hostname}:${cfg.BANK_ADMIN_PORT}`;
  const get = async <T>(path: string) => {
    const r = await fetch(`${admin}${path}`, {
      headers: { authorization: `Bearer ${cfg.BANK_ADMIN_TOKEN}` },
    });
    if (!r.ok) throw new Error(`the bank's admin answered ${r.status} for ${path}`);
    return (await r.json()) as T;
  };
  return {
    browser,
    forced: (names) => hazardHeader(names, cfg.HAZARD_HMAC_KEY),
    credentials: async () => credentials,
    // The bank's own word for the teller's code: the one it sent, or its authenticator's.
    code: async () => (await get<{ code: string }>(`/operators/${cfg.BANK_OPERATOR_ID}/code`)).code,
    ledger: async (member, account) =>
      (
        await get<{ nickname: string; availableCents: number }[]>(`/members/${member}/balances`)
      ).find((a) => a.nickname === account)?.availableCents ?? null,
  };
}

async function gateOf(recommendationId: string) {
  log(
    `Approve or reject ${recommendationId} in the Console: http://localhost:${cfg.CONSOLE_PORT}/recommendations`,
  );
  if (!(await decided(sql, recommendationId))) {
    log('Not approved: nothing changes.');
    return;
  }
  const bank = (
    await sql.query<{ tenant: string }>(`SELECT tenant FROM "Recommendation" WHERE id = $1`, [
      recommendationId,
    ])
  ).rows[0]!.tenant;
  const v = await gate(
    { sql, sandbox: await sandboxAt(bank), store, memory, log },
    recommendationId,
  );
  log(`version ${v.id} is ${v.state}`);
}

try {
  if (command === 'gate') await gateOf(arg);
  else {
    const { recommendationId } = await factoryRun(
      {
        sql,
        store,
        browser,
        factoryUrl: cfg.FACTORY_URL,
        gatewayToken: cfg.FACTORY_GATEWAY_TOKEN,
        roles: rolesOf(cfg),
        credentials,
        answerKey: cfg.ANSWER_SEAL_KEY,
        member: cfg.FACTORY_MEMBER,
        memory,
        log,
      },
      { bank: arg, mode: (command === 'onboard' ? 'build' : 'repair') as Mode },
    );
    if (recommendationId) await gateOf(recommendationId);
    else process.exitCode = 1;
  }
} finally {
  await browser.close();
}
process.exit();
