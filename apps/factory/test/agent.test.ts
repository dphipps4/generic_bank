// A role's turn as a pi session, on each provider behind the real gateway: its tools run one at a
// time, a call pi turns away is reported, the turn stops at its call limit, and a tool that breaks
// stops the turn. The models are scripted fakes; no request leaves the process.
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { controlDb } from '../../../packages/oauth/test/control.js';
import { type Agent, turn, unwrapped } from '../src/agent.js';
import { gateway } from '../src/gateway.js';
import { sqlLedger } from '../src/ledger.js';
import { PRICES, type Provider } from '../src/models.js';
import { DEFAULT_ROLES } from './fakes.js';
import { buildServer } from '../src/server.js';
import { ToolRefusal, type Tool } from '../src/tools.js';
import { live } from '../src/upstream.js';
import { fakeModels, OPENAI_TEST_MODEL, type Reply, TEST_PRICE } from './fakes.js';

const TOKEN = 'gateway-token-for-tests-0123456789abcdef';

let db: Awaited<ReturnType<typeof controlDb>>;
let dir: string;
let app: ReturnType<typeof buildServer>;
let replies: Reply[];

beforeEach(async () => {
  db = await controlDb();
  await db.query(
    `INSERT INTO "FactoryRun" (id, tenant, task, mode, phase, status)
     VALUES ('run1', 'generic', 'check-balance', 'build', 'SCOUT', 'running')`,
  );
  dir = await mkdtemp(join(tmpdir(), 'gb-agent-'));
  replies = [];
  app = buildServer({
    gateway: gateway({
      ledger: sqlLedger(db),
      upstream: live(
        fakeModels(() => replies.shift() ?? { text: 'Done.' }),
        dir,
      ),
      prices: { ...PRICES, [OPENAI_TEST_MODEL]: TEST_PRICE },
    }),
    token: TOKEN,
    mode: 'live',
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
});

afterEach(async () => {
  await app.close();
  await db.close();
  await rm(dir, { recursive: true, force: true });
});

describe.each([DEFAULT_ROLES.scout.provider] as const)('a turn on %s', (provider: Provider) => {
  const agent = (): Agent => ({
    model:
      provider === 'anthropic' || provider === 'openrouter'
        ? DEFAULT_ROLES.scout
        : { ...DEFAULT_ROLES.scout, provider, model: OPENAI_TEST_MODEL },
    url: `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/gateway/run1/scout`,
    token: TOKEN,
  });
  const ran: string[] = [];
  const echo: Tool = {
    name: 'echo',
    description: 'Says the text back.',
    input: z.object({ text: z.string() }),
    run: async (i) => {
      const { text } = i as { text: string };
      if (text === 'refuse') throw new ToolRefusal('not that');
      if (text === 'break') throw new Error('the browser is gone');
      ran.push(text);
      return { text };
    },
  };

  it('runs its tools, reports the calls pi turned away, and stops at its call limit', async () => {
    ran.length = 0;
    replies = [
      { tool: 'nope', input: {} },
      { tool: 'echo', input: { words: 1 } },
      { tool: 'echo', input: { text: 'refuse' } },
      { tool: 'echo', input: { text: 'one' } },
      { text: 'Echoed.' },
    ];
    const t = await turn(agent(), {
      system: 'You echo.',
      say: 'Echo one.',
      tools: [echo],
      calls: 5,
      maxTokens: 1000,
    });
    expect(t.text).toBe('Echoed.');
    expect(ran).toEqual(['one']);
    // The refusal reached the tool; the other two never did.
    expect(t.refused.map((r) => r.name)).toEqual(['nope', 'echo']);
    expect(t.refused[1]!.why).toMatch(/text/);

    // The conversation goes on in the next turn, and the limit ends a turn that would not.
    replies = [
      { tool: 'echo', input: { text: 'two' } },
      { tool: 'echo', input: { text: 'three' } },
    ];
    await turn(agent(), {
      system: 'You echo.',
      conversation: t.conversation,
      say: 'Echo two and three.',
      tools: [echo],
      calls: 1,
      maxTokens: 1000,
    });
    expect(ran).toEqual(['one', 'two']);
  });

  it('stops when a tool breaks, with the tool’s error', async () => {
    replies = [{ tool: 'echo', input: { text: 'break' } }];
    await expect(
      turn(agent(), { system: 'You echo.', say: 'Break.', tools: [echo], maxTokens: 1000 }),
    ).rejects.toThrow('the browser is gone');
  });
});

describe('an answer a model fenced or listed', () => {
  it('is read as the answer inside', () => {
    const a = '{"next":"wait","reason":"loading","frames":["f1"]}';
    expect(unwrapped(a)).toBe(a);
    expect(unwrapped(`\`\`\`json\n${a}\n\`\`\``)).toBe(a);
    expect(unwrapped(` \`\`\`\n[${a}]\n\`\`\` `)).toBe(a);
    expect(unwrapped(`[${a},${a}]`)).toBe(`[${a},${a}]`);
    expect(unwrapped('not an answer')).toBe('not an answer');
  });
});
