import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assistant } from '../../apps/agent/src/agent.js';
import { type Api, connect } from '../../apps/agent/src/api.js';
import { agentConfig } from '../../apps/agent/src/config.js';
import { demoScript, mockModel, type Turn } from '../../apps/agent/src/mock.js';
import { tools } from '../../apps/api/src/catalog.js';
import { buildServer } from '../../apps/api/src/server.js';
import { inboxPages } from '../../apps/console/src/pages/inbox.js';
import { executeRun, type RunDeps } from '../../apps/runner/src/execute.js';
import { memoryStore } from '../../packages/evidence/src/index.js';
import { oauth, TASK_SCOPES } from '../../packages/oauth/src/index.js';
import { controlDb } from '../../packages/oauth/test/control.js';
import { statementKey, statementOf } from '../../packages/runs/src/index.js';
import { accountsOf } from '../../apps/bank/src/ledger.js';
import { MEMBERS, OPERATORS } from '../../apps/bank/src/seed.js';
import { type LiveBank, liveBank, PASSWORDS } from '../support/banks.js';

// The demo agent, end to end, with the scripted mock in the model's place: its tools come from the
// real Task API's GET /tools, it calls the API with its own OAuth2 client, the Runner carries out
// every run against the real Generic Bank, and a person approves the transfer in the Console.

const SEAL = 's'.repeat(40);
const ANSWER_KEY = 'q'.repeat(40);
let db: Awaited<ReturnType<typeof controlDb>>;
let bank: LiveBank;
let server: Awaited<ReturnType<typeof buildServer>>;
let apiUrl: string;
let answering: NodeJS.Timeout;
let saveTo: string;
const consoleApp = Fastify();
const store = memoryStore();
const tokens = () => oauth(db, 't'.repeat(40));

beforeAll(async () => {
  [db, bank] = await Promise.all([controlDb(), liveBank('generic')]);
  await db.query('UPDATE "Bank" SET url = $1 WHERE id = $2', [bank.url, 'generic']);
  saveTo = await mkdtemp(join(tmpdir(), 'agent-'));
  const deps: RunDeps = {
    sql: db,
    store,
    sealKey: SEAL,
    answerKey: ANSWER_KEY,
    credentials: async () => ({
      operatorId: OPERATORS.service.id,
      password: PASSWORDS.service,
      supervisorId: OPERATORS.supervisor.id,
    }),
    pollMs: 250,
  };
  // The queue, in-process: the Runner takes each run as its workflow would.
  const enqueue = async (runId: string) => void executeRun(runId, deps);
  server = await buildServer({
    oauth: tokens(),
    sql: db,
    sealKey: SEAL,
    enqueue,
    documents: store,
  });
  await server.listen({ host: '127.0.0.1', port: 0 });
  apiUrl = `http://127.0.0.1:${(server.server.address() as { port: number }).port}`;

  inboxPages(consoleApp, {
    sql: db,
    answerKey: ANSWER_KEY,
    whoIs: () => ({ email: 'staff@test', role: 'approver' }),
  });
  await consoleApp.ready();
  // The person at the staff phone answers each staff code in the inbox.
  answering = setInterval(async () => {
    const open = await db.query<{ id: string }>(
      `SELECT id FROM "HumanTask" WHERE status = 'open' AND kind = 'staff_code'`,
    );
    for (const t of open.rows) {
      const m = await bank.db.query<{ body: string }>(
        `SELECT m.body FROM messages m JOIN operators o ON m.address IN (o.phone, o.email)
          WHERE o.operator_id = $1 ORDER BY m.id DESC LIMIT 1`,
        [OPERATORS.service.id],
      );
      const code = /(\d{6})/.exec(m.rows[0]?.body ?? '')?.[1];
      if (code)
        await consoleApp.inject({
          method: 'POST',
          url: `/human-tasks/${t.id}/answer`,
          payload: { code },
        });
    }
  }, 500);
}, 120_000);
afterAll(async () => {
  clearInterval(answering);
  await consoleApp.close();
  await server?.close();
  await bank?.close();
  await db?.close();
  if (saveTo) await rm(saveTo, { recursive: true, force: true });
});

/** The agent's own client, as an admin creates it in the Console, and its way into the API. */
async function agentApi(): Promise<Api> {
  const c = await tokens().createClient({
    name: 'Demo agent',
    scopes: [...TASK_SCOPES],
    createdBy: 'ada@generic-bank.local',
  });
  return connect(apiUrl, c, saveTo);
}

/** The configured model, as `just agent` reads it from config/app.env. */
const { AGENT_MODEL } = agentConfig({ ...appEnv(), AGENT_CLIENT: '{}' });

/** The mock in the configured model's place, keeping every request the tool runner sent it. */
function recording(script: Turn[]) {
  const sent: { model: string; messages: { role: string; content: unknown }[] }[] = [];
  const answer = mockModel(script);
  const fetch: typeof globalThis.fetch = async (url, init) => {
    sent.push(JSON.parse(String(init?.body)));
    return answer(url, init);
  };
  return { model: { client: new Anthropic({ apiKey: 'mock', fetch }), name: AGENT_MODEL }, sent };
}

const until = async <T>(read: () => Promise<T | undefined> | T | undefined, ms = 180_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (v) return v;
    if (Date.now() > end) throw new Error('waited too long');
    await new Promise((r) => setTimeout(r, 250));
  }
};

/** config/app.env, as just reads it. */
function appEnv(): Record<string, string> {
  const text = readFileSync(new URL('../../config/app.env', import.meta.url), 'utf8');
  return Object.fromEntries(
    text
      .split('\n')
      .filter((l) => /^[A-Z_]+=/.test(l))
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  );
}

const dollars = (cents: number) =>
  (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

describe('the demo agent, scripted', () => {
  it('holds the conversation through the API’s own tools, and its transfer waits for a person', async () => {
    const api = await agentApi();
    const script = demoScript();
    const { model, sent } = recording(script);
    const say = assistant(model, api);

    // The model is given exactly the tools GET /tools lists, and nothing else.
    expect(api.tools).toEqual(tools());

    expect(await say(script[0]!.member)).toContain('Generic Bank (check-balance');

    const checking = (await accountsOf(bank.db, MEMBERS.demo)).find(
      (a) => a.nickname === 'Everyday Checking',
    )!;
    expect(await say(script[1]!.member)).toContain(`${dollars(checking.availableCents)} available`);

    const statement = await say(script[2]!.member);
    const fetched = api.calls.find((c) => c.tool === 'get_statement')!;
    const ref = fetched.input.ref as string;
    expect(statement).toContain(join(saveTo, `${ref}.pdf`));
    const { runId: ran, month } = statementOf(ref)!;
    const kept = await store.get(statementKey(ran, month));
    expect((await readFile(join(saveTo, `${ref}.pdf`))).equals(kept!)).toBe(true);

    // The transfer: started, parked for approval, and nothing moves until a person approves.
    const posted = async () =>
      Number(
        (
          await bank.db.query<{ n: string }>(
            `SELECT count(*) AS n FROM transfers WHERE memo LIKE '%From the assistant'`,
          )
        ).rows[0]!.n,
      );
    const done = say(script[3]!.member);
    const waiting = await until(() =>
      api.calls.find(
        (c) => c.tool === 'get_task' && (c.body as { status?: string }).status === 'needs_human',
      ),
    );
    expect([waiting.status, waiting.isError, waiting.body]).toMatchObject([
      202,
      false,
      { status: 'needs_human', code: 'awaiting_approval', pending: { kind: 'approval' } },
    ]);
    const runId = (waiting.body as { runId: string }).runId;
    const task = (
      await db.query<{ id: string }>(
        `SELECT id FROM "HumanTask" WHERE "runId" = $1 AND kind = 'approval' AND status = 'open'`,
        [runId],
      )
    ).rows[0]!;
    expect(await posted()).toBe(0);
    const approved = await consoleApp.inject({
      method: 'POST',
      url: `/human-tasks/${task.id}/approve`,
      payload: { reason: 'checked with the member on the phone' },
    });
    expect(approved.statusCode).toBe(200);
    expect(await done).toMatch(
      /Done: \$200\.00 moved to Rainy Day Savings\. The bank's confirmation is GB-/,
    );
    expect(await posted()).toBe(1);

    // The same calls, in the same order, every one answered 200 or 202 and none flagged.
    const order = api.calls.map((c) => c.tool).filter((t, i, all) => t !== all[i - 1]);
    expect(order).toEqual([
      'list_banks',
      'check_balance',
      'get_task',
      'download_statements',
      'get_task',
      'get_statement',
      'transfer',
      'get_task',
    ]);
    expect(api.calls.every((c) => [200, 202].includes(c.status) && !c.isError)).toBe(true);
    expect(api.calls.at(-1)).toMatchObject({ status: 200, body: { runId, status: 'succeeded' } });
    expect(sent.length).toBeGreaterThan(api.calls.length);
    expect(sent.every((r) => r.model === 'claude-opus-5-5')).toBe(true);
    await api.close();
  }, 600_000);

  it('takes its provider and model from config, and only Anthropic until the agents move to pi', () => {
    expect(agentConfig({ AGENT_CLIENT: '{}' })).toMatchObject({
      AGENT_PROVIDER: 'anthropic',
      AGENT_MODEL: 'claude-opus-5-5',
    });
    expect(agentConfig({ AGENT_CLIENT: '{}', AGENT_MODEL: 'claude-sonnet-5-5' }).AGENT_MODEL).toBe(
      'claude-sonnet-5-5',
    );
    expect(() => agentConfig({ AGENT_CLIENT: '{}', AGENT_PROVIDER: 'openai' })).toThrow(
      /AGENT_PROVIDER/,
    );
  });

  it('hands the model a failed call as an error, with the API’s answer as it is', async () => {
    const api = await agentApi();
    const script: Turn[] = [
      {
        member: 'How is run r_nothing doing?',
        start: { name: 'get_task', input: { runId: 'r_nothing' } },
        reply: (b) => String(b.message ?? b.detail),
      },
    ];
    const { model, sent } = recording(script);
    await assistant(model, api)(script[0]!.member);
    expect(api.calls).toMatchObject([{ tool: 'get_task', status: 404, isError: true }]);
    const result = (sent.at(-1)!.messages.at(-1)!.content as Record<string, unknown>[])[0]!;
    expect(result).toMatchObject({ type: 'tool_result', is_error: true });
    expect(JSON.parse(String(result.content))).toMatchObject({ code: 'no_such_run', status: 404 });
    await api.close();
  });
});
