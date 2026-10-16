import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { httpStatus, TASKS, type TaskName, TaskStatus, toolResult } from '@gb/contracts';
import { settleRun } from '@gb/runs';
import { oauth } from '@gb/oauth';
import { controlDb } from '../../../packages/oauth/test/control.js';
import { openapi, tools } from '../src/catalog.js';
import { buildServer } from '../src/server.js';

const SEAL = 'r'.repeat(40);
let db: Awaited<ReturnType<typeof controlDb>>;
let app: Awaited<ReturnType<typeof buildServer>>;
let token: string;
let o: ReturnType<typeof oauth>;

beforeAll(async () => {
  db = await controlDb();
  o = oauth(db, 'k'.repeat(40));
  app = await buildServer({ oauth: o, sql: db, sealKey: SEAL, enqueue: async () => undefined });
  const c = await o.createClient({
    name: 't',
    scopes: ['tasks:read', 'tasks:balance', 'tasks:statements', 'tasks:transfer'],
    createdBy: 'a',
  });
  token = (await o.exchangeCode(c.clientId, c.clientSecret, c.code)).access_token;
});
afterAll(() => db.close());

const get = (url: string, t = token) =>
  app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${t}` } });
const strip = (s: z.ZodType) => {
  const { $schema, ...rest } = z.toJSONSchema(s) as Record<string, unknown>;
  return rest;
};

async function promote(bank: string, task: string, version: number) {
  const d = `d_${bank}_${task}`;
  const v = `v_${bank}_${task}`;
  await db.query(
    `INSERT INTO "Driver" (id, tenant, task, state, "activeVersionId") VALUES ($1, $2, $3, 'promoted', $4)`,
    [d, bank, task, v],
  );
  await db.query(
    `INSERT INTO "DriverVersion" (id, "driverId", version, sha256, kind, state) VALUES ($1, $2, $3, 'x', 'profile', 'promoted')`,
    [v, d, version],
  );
}

describe('the API describes itself, and the descriptions agree', () => {
  it('every task tool takes exactly the task’s input schema, and names its endpoint', () => {
    for (const t of Object.keys(TASKS) as TaskName[]) {
      const tool = tools().find((x) => x.endpoint.path === `/tasks/${t}`)!;
      expect(tool.input_schema).toEqual(strip(TASKS[t]));
    }
  });

  it('the OpenAPI document has the same request schemas, and a path for every tool', () => {
    const doc = openapi() as {
      paths: Record<
        string,
        Record<string, { requestBody?: { content: Record<string, { schema: unknown }> } }>
      >;
    };
    for (const t of Object.keys(TASKS) as TaskName[])
      expect(
        doc.paths[`/tasks/${t}`]!.post!.requestBody!.content['application/json']!.schema,
      ).toEqual(strip(TASKS[t]));
    for (const tool of tools())
      expect(
        doc.paths[tool.endpoint.path]?.[tool.endpoint.method.toLowerCase()],
        tool.name,
      ).toBeDefined();
  });

  it('every tool’s endpoint answers, as an endpoint and not as a missing route', async () => {
    for (const tool of tools()) {
      const url = tool.endpoint.path.replace(/\{\w+\}/, 'none');
      const r =
        tool.endpoint.method === 'GET'
          ? await get(url)
          : await app.inject({
              method: 'POST',
              url,
              headers: { authorization: `Bearer ${token}` },
              payload: {},
            });
      expect(r.json().code === undefined && r.statusCode === 404, tool.name).toBe(false);
    }
  });

  it('serves the document and Swagger UI without a token', async () => {
    expect((await app.inject({ url: '/openapi.json' })).json().openapi).toBe('3.1.0');
    const ui = await app.inject({ url: '/docs/' });
    expect(ui.statusCode).toBe(200);
    expect(ui.body).toMatch(/swagger/i);
  });

  it('lists tools for agents', async () => {
    expect((await get('/tools')).json().tools.map((t: { name: string }) => t.name)).toEqual([
      'list_banks',
      'check_balance',
      'transfer',
      'download_statements',
      'get_task',
      'get_statement',
    ]);
  });

  it('every tool says what it never does', () => {
    for (const tool of tools()) expect(tool.description, tool.name).toMatch(/\bNever\b/);
  });

  it('every tool is the document’s operation of the same name, with the same words and input', () => {
    type Op = {
      operationId: string;
      summary: string;
      tags: string[];
      requestBody?: { content: Record<string, { schema: unknown }> };
      parameters?: { name: string; in: string; required: boolean; schema: unknown }[];
    };
    const doc = openapi() as { paths: Record<string, Record<string, Op>> };
    for (const tool of tools()) {
      const op = doc.paths[tool.endpoint.path]![tool.endpoint.method.toLowerCase()]!;
      expect([op.operationId, op.summary], tool.name).toEqual([tool.name, tool.description]);
      if (tool.endpoint.method === 'POST') {
        expect(op.requestBody!.content['application/json']!.schema).toEqual(tool.input_schema);
        continue;
      }
      // A GET tool's input is its parameters: the same names, schemas and required ones.
      const params = op.parameters ?? [];
      expect({
        type: 'object',
        properties: Object.fromEntries(params.map((p) => [p.name, p.schema])),
        ...(params.some((p) => p.required)
          ? { required: params.filter((p) => p.required).map((p) => p.name) }
          : {}),
        additionalProperties: false,
      }).toEqual(tool.input_schema);
      for (const p of params)
        expect(p.in, `${tool.name}.${p.name}`).toBe(
          tool.endpoint.path.includes(`{${p.name}}`) ? 'path' : 'query',
        );
    }
    // And the other way: every task operation in the document is a tool.
    const names = tools().map((t) => t.name);
    for (const ops of Object.values(doc.paths))
      for (const op of Object.values(ops))
        if (op.tags.includes('tasks')) expect(names, op.operationId).toContain(op.operationId);
  });

  it('flags a tool’s result as an error for every status but success, hand-off and waiting', async () => {
    const fine = ['succeeded', 'handed_off', 'running', 'needs_human'];
    for (const status of TaskStatus.options)
      for (const retryable of [true, false])
        expect(toolResult(httpStatus({ status, retryable }), {}).isError, status).toBe(
          !fine.includes(status),
        );
    // As the endpoints answer: waiting, done, refused.
    const start = await app.inject({
      method: 'POST',
      url: '/tasks/check-balance',
      headers: { authorization: `Bearer ${token}` },
      payload: { bank: 'generic', memberId: '40017732', account: '7890' },
    });
    expect(toolResult(start.statusCode, start.json()).isError).toBe(false);
    const runId = start.json().runId;
    await settleRun(db, runId, { status: 'business_outcome', code: 'no_such_account' });
    const said = await get(`/tasks/${runId}`);
    expect([said.statusCode, toolResult(said.statusCode, said.json()).isError]).toEqual([
      422,
      true,
    ]);
    const none = await get('/statements/st_0000000000000000_2026-05');
    expect([none.statusCode, toolResult(none.statusCode, none.json()).isError]).toEqual([
      404,
      true,
    ]);
    const banks = await get('/banks');
    expect(toolResult(banks.statusCode, banks.json()).isError).toBe(false);
  });
});

describe('the registry decides which banks can do what', () => {
  it('lists the four banks; the drivers written by hand, bank 1’s and bank 2’s balance, are promoted from the start', async () => {
    const banks = (await get('/banks')).json();
    expect(banks.map((b: { id: string }) => b.id)).toEqual([
      'generic',
      'example',
      'sample',
      'placeholder',
    ]);
    expect(banks[0].tasks).toEqual([
      { task: 'check-balance', crawlerVersion: 'v1' },
      { task: 'download-statements', crawlerVersion: 'v1' },
      { task: 'transfer', crawlerVersion: 'v1' },
    ]);
    expect(banks[1].tasks).toEqual([{ task: 'check-balance', crawlerVersion: 'v1' }]);
    expect(banks.slice(2).every((b: { tasks: unknown[] }) => b.tasks.length === 0)).toBe(true);
  });

  it('refuses a task on a bank with no promoted crawler, naming the banks that have one', async () => {
    await promote('sample', 'download-statements', 3);
    expect((await get('/banks')).json()[2].tasks).toEqual([
      { task: 'download-statements', crawlerVersion: 'v3' },
    ]);
    const call = (bank: string) =>
      app.inject({
        method: 'POST',
        url: '/tasks/check-balance',
        headers: { authorization: `Bearer ${token}` },
        payload: { bank, memberId: '40017732', account: '7890' },
      });
    const notYet = await call('sample');
    expect([notYet.statusCode, notYet.json().code, notYet.json().banksThatSupportIt]).toEqual([
      404,
      'task_not_available',
      ['generic', 'example'],
    ]);
    const unknown = await call('nonesuch');
    expect([unknown.statusCode, unknown.json().code]).toEqual([404, 'unknown_bank']);
    expect((await call('generic')).statusCode).toBe(202);
  });

  it('shows a client limited to some banks only those banks', async () => {
    const c = await o.createClient({
      name: 'one bank',
      scopes: ['tasks:read', 'bank:example'],
      createdBy: 'a',
    });
    const t = (await o.exchangeCode(c.clientId, c.clientSecret, c.code)).access_token;
    expect((await get('/banks', t)).json().map((b: { id: string }) => b.id)).toEqual(['example']);
  });
});

describe('the published reference', () => {
  it('is the document the code generates: run just api-docs after changing the API', async () => {
    const { readFileSync } = await import('node:fs');
    const committed = JSON.parse(
      readFileSync(new URL('../../../docs/api/openapi.json', import.meta.url), 'utf8'),
    );
    expect(committed).toEqual(JSON.parse(JSON.stringify(openapi())));
  });
});
