// Each provider's model as a fake fetch behind OpenAI's real SDK, for the gateway's live upstream.
// Nothing leaves the process and the key is not one. The test's answer function sees each request
// in one form, whichever provider it was sent to, and answers with text or one tool call.
import OpenAI from 'openai';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { ROLE_SETTINGS, type Roles, rolesOf } from '../src/models.js';

/** Each role's model as config/app.env sets it: the one place a model is named. */
const appEnv = Object.fromEntries(
  readFileSync(new URL('../../../config/app.env', import.meta.url), 'utf8')
    .split('\n')
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);
export const DEFAULT_ROLES: Roles = rolesOf(z.object(ROLE_SETTINGS).parse(appEnv));

/** An OpenAI model, priced for tests only: no OpenAI price ships. */
export const OPENAI_TEST_MODEL = 'gpt-test';
export const TEST_PRICE = { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 0 };

export type Reply =
  | { text: string }
  | { tool: string; input: object }
  /** Several calls in one reply, in order. */
  | { calls: { tool: string; input: object }[] }
  /** The provider fails the request with this status and message. */
  | { fail: number; message: string };

/** A request as a script reads it: the system prompt, then the user's words and tool results in order. */
export interface Seen {
  system: string;
  items: ({ user: string } | { result: string })[];
}

type Block = { type: string; text?: string; content?: unknown };
const textOf = (c: unknown): string =>
  typeof c === 'string'
    ? c
    : ((c ?? []) as Block[]).flatMap((b) => (b.type === 'text' ? [b.text!] : [])).join('\n');

export function seen(body: Record<string, unknown>): Seen {
  const out: Seen = { system: '', items: [] };
  const messages = body.messages as { role: string; content: unknown }[];
  for (const m of messages) {
    if (m.role === 'system' || m.role === 'developer') {
      if (!out.system) out.system = textOf(m.content);
    } else if (m.role === 'tool') out.items.push({ result: textOf(m.content) });
    else if (m.role === 'user')
      for (const b of typeof m.content === 'string'
        ? [{ type: 'text', text: m.content }]
        : (m.content as Block[]))
        if (b.type === 'text') out.items.push({ user: b.text! });
  }
  return out;
}

const USAGE = { input: 2000, output: 50 };

function openaiSse(n: number, model: string, reply: Reply): string {
  const delta =
    'text' in reply
      ? { role: 'assistant', content: reply.text }
      : {
          role: 'assistant',
          tool_calls: ('calls' in reply ? reply.calls : [reply]).map((c, index) => ({
            index,
            id: `call_${n}_${index}`,
            type: 'function',
            function: { name: c.tool, arguments: JSON.stringify(c.input) },
          })),
        };
  const finish = 'text' in reply ? 'stop' : 'tool_calls';
  const chunks = [
    { choices: [{ index: 0, delta, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: finish }] },
    {
      choices: [],
      usage: {
        prompt_tokens: USAGE.input,
        completion_tokens: USAGE.output,
        total_tokens: USAGE.input + USAGE.output,
      },
    },
  ].map((c) => ({ id: `chatcmpl-${n}`, object: 'chat.completion.chunk', created: 1, model, ...c }));
  return `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('')}data: [DONE]\n\n`;
}

/**
 * Both providers' clients, answering every request with the script's reply. Each request body
 * is kept in `sent`, in order.
 */
export function fakeModels(
  script: (request: Seen, body: Record<string, unknown>) => Reply,
  sent: Record<string, unknown>[] = [],
): { openai: OpenAI; openrouter: OpenAI } {
  const fetch = async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    sent.push(body);
    const reply = script(seen(body), body);
    if ('fail' in reply)
      return new Response(JSON.stringify({ error: { message: reply.message } }), {
        status: reply.fail,
        headers: { 'content-type': 'application/json' },
      });
    return new Response(openaiSse(sent.length, String(body.model), reply), {
      headers: { 'content-type': 'text/event-stream' },
    });
  };
  const client = () =>
    new OpenAI({ apiKey: 'not-a-real-key', fetch: fetch as never, maxRetries: 0 });
  return { openai: client(), openrouter: client() };
}
