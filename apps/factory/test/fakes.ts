// Each provider's model as a scripted fake fetch behind its real SDK, for the gateway's live
// upstream. Nothing leaves the process and the key is not one. A script sees each request in one
// form, whichever provider it was sent to, and answers with text or one tool call.
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { type Provider, ROLE_SETTINGS, type Roles, rolesOf } from '../src/models.js';

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

export type Reply = { text: string } | { tool: string; input: object };

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

export function seen(provider: Provider, body: Record<string, unknown>): Seen {
  const out: Seen = { system: '', items: [] };
  const messages = body.messages as { role: string; content: unknown }[];
  if (provider === 'anthropic') out.system = textOf(body.system);
  for (const m of messages) {
    if (m.role === 'system' || m.role === 'developer') {
      if (provider === 'openai' && !out.system) out.system = textOf(m.content);
    } else if (m.role === 'tool') out.items.push({ result: textOf(m.content) });
    else if (m.role === 'user')
      for (const b of typeof m.content === 'string'
        ? [{ type: 'text', text: m.content }]
        : (m.content as Block[]))
        if (b.type === 'text') out.items.push({ user: b.text! });
        else if (b.type === 'tool_result') out.items.push({ result: textOf(b.content) });
  }
  return out;
}

const USAGE = { input: 2000, output: 50 };

function anthropicSse(n: number, model: string, reply: Reply): string {
  const [block, delta, stop] =
    'text' in reply
      ? [{ type: 'text', text: '' }, { type: 'text_delta', text: reply.text }, 'end_turn']
      : [
          { type: 'tool_use', id: `toolu_${n}`, name: reply.tool, input: {} },
          { type: 'input_json_delta', partial_json: JSON.stringify(reply.input) },
          'tool_use',
        ];
  return [
    {
      type: 'message_start',
      message: {
        id: `msg_${n}`,
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: USAGE.input, output_tokens: 1 },
      },
    },
    { type: 'content_block_start', index: 0, content_block: block },
    { type: 'content_block_delta', index: 0, delta },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: { stop_reason: stop, stop_sequence: null },
      usage: { output_tokens: USAGE.output },
    },
    { type: 'message_stop' },
  ]
    .map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
    .join('');
}

function openaiSse(n: number, model: string, reply: Reply): string {
  const delta =
    'text' in reply
      ? { role: 'assistant', content: reply.text }
      : {
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id: `call_${n}`,
              type: 'function',
              function: { name: reply.tool, arguments: JSON.stringify(reply.input) },
            },
          ],
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
  script: (provider: Provider, request: Seen, body: Record<string, unknown>) => Reply,
  sent: Record<string, unknown>[] = [],
): { anthropic: Anthropic; openai: OpenAI } {
  const fetch = (provider: Provider) => async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    sent.push(body);
    const reply = script(provider, seen(provider, body), body);
    const model = String(body.model);
    const sse = provider === 'anthropic' ? anthropicSse : openaiSse;
    return new Response(sse(sent.length, model, reply), {
      headers: { 'content-type': 'text/event-stream' },
    });
  };
  return {
    anthropic: new Anthropic({
      apiKey: 'not-a-real-key',
      fetch: fetch('anthropic') as never,
      maxRetries: 0,
    }),
    openai: new OpenAI({
      apiKey: 'not-a-real-key',
      fetch: fetch('openai') as never,
      maxRetries: 0,
    }),
  };
}
