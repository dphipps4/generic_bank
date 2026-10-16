import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assistant } from '../../apps/agent/src/agent.js';
import { connect } from '../../apps/agent/src/api.js';
import { mockModel, type Turn } from '../../apps/agent/src/mock.js';
import { tools } from '../../apps/api/src/catalog.js';
import { buildServer } from '../../apps/api/src/server.js';
import { oauth, TASK_SCOPES } from '../../packages/oauth/src/index.js';
import { controlDb } from '../../packages/oauth/test/control.js';

// The demo agent against the real Task API, with the scripted mock in the model's place: its tools
// are exactly the ones GET /tools lists, it calls the API with its own OAuth2 client, and a failed
// call reaches the model as an error, with the API's answer as it is.

let db: Awaited<ReturnType<typeof controlDb>>;
let server: Awaited<ReturnType<typeof buildServer>>;
let apiUrl: string;
let saveTo: string;

beforeAll(async () => {
  db = await controlDb();
  saveTo = await mkdtemp(join(tmpdir(), 'agent-'));
  server = await buildServer({
    oauth: oauth(db, 't'.repeat(40)),
    sql: db,
    sealKey: 's'.repeat(40),
    enqueue: async () => undefined,
  });
  await server.listen({ host: '127.0.0.1', port: 0 });
  apiUrl = `http://127.0.0.1:${(server.server.address() as { port: number }).port}`;
});
afterAll(async () => {
  await server?.close();
  await db?.close();
  if (saveTo) await rm(saveTo, { recursive: true, force: true });
});

describe('the demo agent', () => {
  it('has only the API’s own tools, and hands the model a failed call as an error', async () => {
    const client = await oauth(db, 't'.repeat(40)).createClient({
      name: 'Demo agent',
      scopes: [...TASK_SCOPES],
      createdBy: 'ada@generic-bank.local',
    });
    const api = await connect(apiUrl, client, saveTo);
    expect(api.tools).toEqual(tools());

    const script: Turn[] = [
      {
        member: 'How is run r_nothing doing?',
        start: { name: 'get_task', input: { runId: 'r_nothing' } },
        reply: (b) => String(b.message ?? b.detail),
      },
    ];
    const sent: { messages: { role: string; content: unknown }[] }[] = [];
    const answer = mockModel(script);
    const fetch: typeof globalThis.fetch = async (url, init) => {
      sent.push(JSON.parse(String(init?.body)));
      return answer(url, init);
    };
    const model = { client: new Anthropic({ apiKey: 'mock', fetch }), name: 'claude-opus-5-5' };
    await assistant(model, api)(script[0]!.member);
    expect(api.calls).toMatchObject([{ tool: 'get_task', status: 404, isError: true }]);
    const result = (sent.at(-1)!.messages.at(-1)!.content as Record<string, unknown>[])[0]!;
    expect(result).toMatchObject({ type: 'tool_result', is_error: true });
    expect(JSON.parse(String(result.content))).toMatchObject({ code: 'no_such_run', status: 404 });
    await api.close();
  });
});
