// A one-frame experiment: the real Scout or the real Supervisor, on one kept frame of a run, its
// instructions and tools as they are, or changed by a variant. Nothing reaches a browser: the
// Scout's tools record its first call and act on nothing; the Supervisor judges through its own
// judge(). Each sample is a few cents and seconds; a change to an agent's instructions, tools or
// view passes one on the frame where it failed before it merges.
//
//   frame.js <run> <frame> <scout|supervisor> [samples] [variant.json]
//
// A variant may set: instructions (added to the agent's own), effort, picture (another PNG for the
// frame), action and why (what the Scout just did), said (the Supervisor's words the Scout read),
// record (the Scout's calls since the last judgment), clock, goal (balance, transfer or history:
// the goal the run was on at that frame). It must set the run's task:
// member, from and to. The bank comes from the run's own record. Three samples run at a time.
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { leaf } from '@gb/crawler';
import { loadConfig, secret } from '@gb/config';
import { sql as connect } from '@gb/db';
import { fileStore } from '@gb/runs';
import type { Frame } from '@gb/runtime';
import { Agent as Dispatcher, setGlobalDispatcher } from 'undici';
import { z } from 'zod';
import { TURN_MS, turn } from './agent.js';
import { memoryClient, memoryQueryTool, servedBy, vendorOf } from './memory.js';
import { ROLE_SETTINGS, rolesOf } from './models.js';
import { GOALS, SCOUT } from './run.js';
import { type Entry, scout } from './scout.js';
import { supervisor } from './supervisor.js';
import type { Trail } from './trail.js';

const cfg = loadConfig(
  {
    CONTROL_DATABASE_URL: z.string().startsWith('postgresql://'),
    FACTORY_URL: z.string().url().default('http://factory:8200'),
    FACTORY_GATEWAY_TOKEN: secret(),
    EVIDENCE_DIR: z.string().min(1).default('/data/evidence'),
    MEMORY_URL: z.url().default('http://memory:8470'),
    MEMORY_TOKEN_FACTORY: secret(),
    MEMORY_SIGNING_KEY: secret(),
    ...ROLE_SETTINGS,
  },
  process.env,
  ['FACTORY_GATEWAY_TOKEN', 'MEMORY_TOKEN_FACTORY', 'MEMORY_SIGNING_KEY'],
);
setGlobalDispatcher(new Dispatcher({ headersTimeout: TURN_MS, bodyTimeout: TURN_MS }));

const Variant = z
  .object({
    instructions: z.string().optional(),
    effort: z.enum(['low', 'medium', 'high']).optional(),
    picture: z.string().optional(),
    action: z.string().optional(),
    why: z.string().optional(),
    said: z.string().optional(),
    record: z
      .array(z.object({ tool: z.string(), input: z.unknown(), error: z.string().optional() }))
      .optional(),
    clock: z.string().optional(),
    goal: z.enum(['balance', 'transfer', 'history']).optional(),
    // The run's task: the member and the accounts it was given.
    member: z.string().min(1),
    from: z.string().min(1),
    to: z.string().min(1),
  })
  .strict();

const [run, frameArg, role, samplesArg = '5', variantPath] = process.argv.slice(2);
if (!run || !frameArg || (role !== 'scout' && role !== 'supervisor')) {
  console.error('usage: frame.js <run> <frame> <scout|supervisor> <samples> <variant.json>');
  process.exit(2);
}
if (!variantPath) {
  console.error("a variant is required: it names the run's member and accounts");
  process.exit(2);
}
const variant = Variant.parse(JSON.parse(readFileSync(variantPath, 'utf8')));
const samples = Number(samplesArg);
const n = Number(frameArg.replace(/^f/, ''));
const store = fileStore(cfg.EVIDENCE_DIR);
const sql = connect(cfg.CONTROL_DATABASE_URL);
const base = `runs/${run}/${String(n).padStart(3, '0')}`;
const page = JSON.parse(String(await store.get(`${base}.json`))) as Omit<Frame, 'picture'>;
const picture = variant.picture ? readFileSync(variant.picture) : (await store.get(`${base}.png`))!;
const frame: Frame = { ...page, picture };

// The run's bank, from its own record (a gate's frames belong to the run it checked).
const tenant = (
  await sql.query<{ tenant: string }>('SELECT tenant FROM "FactoryRun" WHERE id = $1', [
    run.replace(/-check$/, ''),
  ])
).rows[0]?.tenant;
if (!tenant) throw new Error(`no factory run ${run}`);
const bank: string = tenant;

// Its own ledger row: every call metered and capped, apart from any run's.
const ledger = `frame-${run}-f${n}-${randomBytes(3).toString('hex')}`;
await sql.query(
  `INSERT INTO "FactoryRun" (id, tenant, task, mode, phase, status) VALUES ($1, $2, 'check-balance', 'experiment', 'DONE', 'experiment')`,
  [ledger, bank],
);
const roles = rolesOf(cfg);
const agentFor = (r: 'scout' | 'supervisor') => ({
  model: { ...roles[r], ...(variant.effort ? { effort: variant.effort } : {}) },
  url: `${cfg.FACTORY_URL}/gateway/${ledger}/${r}`,
  token: cfg.FACTORY_GATEWAY_TOKEN,
});
const input = { bank, member: variant.member, from: variant.from, to: variant.to };
const goal = variant.goal ?? 'balance';
const goalText = (i: typeof input) => GOALS[goal](i);
const task = {
  goal,
  member: input.member,
  from: input.from,
  to: input.to,
  amountCents: 100,
  memo: 'GBX TEST',
};
const quiet: Trail = {
  runId: ledger,
  known: [],
  step: async () => null,
  has: () => false,
  shown: async () => null,
  keep: async () => null,
  remask: async () => 0,
  settle: async () => undefined,
};
const scoutTools = () =>
  scout(
    {
      page: null as never,
      start: 'http://bank-example:8082/',
      trail: quiet,
      credentials: { operatorId: '', password: '' },
      code: async () => '',
      judge: async () => ({ verdict: 'continue', says: '' }),
    },
    task,
  ).tools('scout');
const words = page.tree
  .split('\n')
  .map(leaf)
  .filter((t): t is string => !!t);

async function scoutSample() {
  const controls = page.controls.filter((c) => c.name || c.role !== 'link');
  const view = {
    frame: `f${n}`,
    page: null,
    controls: controls.map((c, k) => ({
      id: `c${k + 1}`,
      role: c.role,
      name: c.name,
      box: c.box,
      ...(!c.name && ['textbox', 'password', 'select'].includes(c.role)
        ? {
            label:
              'none in the words: if it has one, it is drawn as a picture; act on it by this id',
          }
        : {}),
    })),
    words,
  };
  let chosen: { tool: string; input: unknown } | null = null;
  const tools = scoutTools().map((t) => ({
    ...t,
    run: async (i: unknown) => {
      chosen ??= { tool: t.name, input: i };
      throw new Error('recorded');
    },
  }));
  const said = await turn(agentFor('scout'), {
    system: variant.instructions ? `${SCOUT}\n${variant.instructions}` : SCOUT,
    say: `Goal: ${goalText(input)}\n\nThe tool returned:\n${variant.action ?? 'looked'}.${variant.said ? `\nThe Supervisor: ${variant.said}` : ''}\n${JSON.stringify(view)}\n\nAct now: one tool call.`,
    image: picture,
    tools,
    calls: 1,
    maxTokens: 6000,
  }).catch((e: Error) => ({ text: '', thinking: e.message }));
  return { chosen, thinking: said.thinking.length };
}

async function supervisorSample() {
  const memory = memoryClient({
    url: cfg.MEMORY_URL,
    token: cfg.MEMORY_TOKEN_FACTORY,
    signingKey: cfg.MEMORY_SIGNING_KEY,
  });
  const at = { bank, vendor: await vendorOf(sql, bank) };
  // The Supervisor's own lessons, as a live run gives them.
  const pack = await memory.pack(at, goalText(input), 'supervisor');
  const thoughts: string[] = [];
  const trail: Trail = {
    ...quiet,
    step: async (s) => (s.name === 'supervisor thought' && thoughts.push(s.outcome ?? ''), null),
  };
  const sup = supervisor({
    agent: agentFor('supervisor'),
    trail,
    goal: goalText(input),
    knowledge: JSON.stringify(pack.tiers),
    tools: [memoryQueryTool(memory, at, servedBy(pack), 'supervisor')],
    clock: { text: () => variant.clock ?? '60 s used of 420 s, 360 s left' },
    scoutTools: scoutTools().map((t) => ({ name: t.name, description: t.description })),
    ...(variant.instructions ? { instructions: variant.instructions } : {}),
  });
  const j = await sup.judge({
    action: variant.action ?? 'looked',
    why: variant.why ?? '',
    frame,
    ref: `f${n}`,
    record: (variant.record ?? []) as Entry[],
    route: {
      bank: 'example',
      home: '',
      rows: [],
      ends: {} as never,
      answers: [],
      trouble: [],
      reads: {} as never,
      submit: { press: '', frame: '' },
    },
  });
  return { verdict: j.verdict, says: j.says, thinking: thoughts.join('').length };
}

const results: unknown[] = [];
const one = async (k: number) => {
  const started = Date.now();
  const r = role === 'scout' ? await scoutSample() : await supervisorSample();
  const row = { k, seconds: Math.round((Date.now() - started) / 1000), ...r };
  results.push(row);
  console.log(JSON.stringify(row));
};
// Three at a time: each sample is a model call, and the container's memory is shared.
for (let k = 0; k < samples; k += 3)
  await Promise.all([k, k + 1, k + 2].filter((x) => x < samples).map(one));
const cost = (
  await sql.query<{ usd: string | null }>(
    `SELECT SUM("costUsd") AS usd FROM "ModelCall" WHERE "factoryRunId" = $1`,
    [ledger],
  )
).rows[0]?.usd;
console.log(
  JSON.stringify({
    run,
    frame: `f${n}`,
    role,
    samples,
    cost: Number(cost ?? 0).toFixed(3),
    ledger,
  }),
);
process.exit(0);
