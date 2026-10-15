// make try: one task under forced hazards, from the command line (plan, §S.2). It runs inside the API
// container, which holds the hashing key, and starts the run through the same door as the Console's
// hazard lab. It waits for the result and says whether it is the one the outcome table expects.
//
//   node apps/api/dist/try-cli.js TASK HAZARDS MEMBER ACCOUNT BANK   (every argument may be empty)
import { loadConfig, port, secret } from '@gb/config';
import {
  describeExpected,
  expectedFor,
  HAZARDS,
  isHazard,
  OUTCOMES,
  type OutcomeTask,
  type TaskResult,
} from '@gb/contracts';
import { sql } from '@gb/db';
import { oauth, TASK_SCOPES } from '@gb/oauth';
import { z } from 'zod';

const cfg = loadConfig({
  API_TOKEN_HASH_KEY: secret(),
  CONTROL_DATABASE_URL: z.string().startsWith('postgresql://'),
  API_PORT: port(8000),
  CONSOLE_PORT: port(8080),
  HAZARDS_FORCEABLE: z.enum(['true', 'false']).default('false'),
});

const say = (s = '') => console.log(s);
const stop = (s: string, code = 2): never => {
  console.error(s);
  process.exit(code);
};

if (cfg.HAZARDS_FORCEABLE !== 'true')
  stop(
    'The banks are not forceable here. Set HAZARDS_FORCEABLE=true in config/app.env, then make restart.',
  );

const [taskArg, hazardArg, memberArg, accountArg, bankArg] = process.argv.slice(2);
const task = (taskArg || 'check-balance') as OutcomeTask;
if (!(task in OUTCOMES)) stop(`make try covers ${Object.keys(OUTCOMES).join(', ')}; not ${task}.`);
const o = OUTCOMES[task];
const hazards = (hazardArg ?? '').split(',').filter(Boolean);
const unknown = hazards.filter((h) => !isHazard(h));
if (unknown.length)
  stop(`Not a hazard: ${unknown.join(', ')}. The hazards are:\n  ${HAZARDS.join('\n  ')}`);
const memberId = memberArg || o.members[0]!.memberId;
const member = o.members.find(
  (m) => m.memberId === memberId && (!accountArg || m.account === accountArg),
);
const account = accountArg || member?.account || o.members[0]!.account;
const bank = bankArg || 'generic';
const expected = member ? expectedFor(task, member, hazards.filter(isHazard)) : null;

const db = sql(cfg.CONTROL_DATABASE_URL);
const tokens = oauth(db, cfg.API_TOKEN_HASH_KEY);
const NAME = 'Hazard lab (make try)';
const found = await db.query<{ clientId: string }>(
  'SELECT "clientId" FROM "ApiClient" WHERE name = $1 AND "revokedAt" IS NULL LIMIT 1',
  [NAME],
);
const clientId =
  found.rows[0]?.clientId ??
  (await tokens.createClient({ name: NAME, scopes: [...TASK_SCOPES], createdBy: 'make try' }))
    .clientId;
const token = async () => (await tokens.issueDirect(clientId, 'make try')).access_token;
const api = `http://127.0.0.1:${cfg.API_PORT}`;
const consoleAt = `http://localhost:${cfg.CONSOLE_PORT}`;

let bearer = await token();
const started = await fetch(`${api}/lab/runs`, {
  method: 'POST',
  headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
  body: JSON.stringify({ task, input: { bank, memberId, account }, hazards }),
});
const first = (await started.json()) as TaskResult & { detail?: string };
if (started.status !== 202) stop(`The Task API refused: ${first.detail ?? started.status}`, 1);
const runId = first.runId;

say(
  `Run ${runId}: ${task} on ${bank}, ${hazards.length ? `forced ${hazards.join(', ')}` : 'nothing forced'}.`,
);
say(`Expected: ${expected ? describeExpected(expected) : 'no single result for this mix'}.`);
say(`Watch it: ${consoleAt}/runs/${runId}`);

let asked = false;
let result: TaskResult = first;
while (result.status === 'running' || result.status === 'needs_human') {
  const r = await fetch(`${api}/tasks/${runId}?wait=20`, {
    headers: { authorization: `Bearer ${bearer}` },
  });
  if (r.status === 401) {
    bearer = await token();
    continue;
  }
  result = (await r.json()) as TaskResult;
  if (result.status === 'needs_human' && !asked) {
    asked = true;
    say(
      `Waiting for a person: enter the ${result.pending?.kind?.replace('_', ' ') ?? 'answer'} in ${consoleAt}/inbox`,
    );
  }
}
await db.close();

const got = describeExpected({ status: result.status, code: result.code as never });
say(`Result: ${got}.`);
if (!expected) process.exit(0);
if (got === describeExpected(expected)) say('As the outcome table expects.');
else stop(`The outcome table expects ${describeExpected(expected)}.`, 1);
