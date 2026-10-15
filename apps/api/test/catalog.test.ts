import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { TASKS, type TaskName } from '@gb/contracts';
import { oauth } from '@gb/oauth';
import { controlDb } from '../../../packages/oauth/test/control.js';
import { openapi, tools } from '../src/catalog.js';
import { buildServer } from '../src/server.js';

let db: Awaited<ReturnType<typeof controlDb>>;
let app: Awaited<ReturnType<typeof buildServer>>;
let token: string;
let o: ReturnType<typeof oauth>;

beforeAll(async () => {
  db = await controlDb();
  o = oauth(db, 'k'.repeat(40));
  app = await buildServer({ oauth: o, sql: db });
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
      const url = tool.endpoint.path.replace('{runId}', 'r_none');
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
    ]);
  });
});

describe('the registry decides which banks can do what', () => {
  it('lists the four banks, and no task until a crawler is promoted', async () => {
    const banks = (await get('/banks')).json();
    expect(banks.map((b: { id: string }) => b.id)).toEqual([
      'generic',
      'example',
      'sample',
      'placeholder',
    ]);
    expect(banks.every((b: { tasks: unknown[] }) => b.tasks.length === 0)).toBe(true);
  });

  it('refuses a task on a bank with no promoted crawler, naming the banks that have one', async () => {
    await promote('generic', 'check-balance', 3);
    const call = (bank: string) =>
      app.inject({
        method: 'POST',
        url: '/tasks/check-balance',
        headers: { authorization: `Bearer ${token}` },
        payload: { bank, memberId: '40017732', account: '7890' },
      });
    expect((await get('/banks')).json()[0].tasks).toEqual([
      { task: 'check-balance', crawlerVersion: 'v3' },
    ]);
    const notYet = await call('example');
    expect([notYet.statusCode, notYet.json().code, notYet.json().banksThatSupportIt]).toEqual([
      404,
      'task_not_available',
      ['generic'],
    ]);
    const unknown = await call('nonesuch');
    expect([unknown.statusCode, unknown.json().code]).toEqual([404, 'unknown_bank']);
    expect((await call('generic')).statusCode).toBe(501);
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
  it('is the document the code generates: run make api-docs after changing the API', async () => {
    const { readFileSync } = await import('node:fs');
    const committed = JSON.parse(
      readFileSync(new URL('../../../docs/api/openapi.json', import.meta.url), 'utf8'),
    );
    expect(committed).toEqual(JSON.parse(JSON.stringify(openapi())));
  });
});
