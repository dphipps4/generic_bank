// A role's turn with its model: the one place the factory calls a model, and the only code that
// knows the provider. A pi session takes its place (plan §M.6); nothing else changes. Every request
// goes through the gateway, which meters it, sets the effort, and replays it in mock mode.
import Anthropic from '@anthropic-ai/sdk';
import type { BetaRunnableTool } from '@anthropic-ai/sdk/lib/tools/BetaRunnableTool';
import { ToolError } from '@anthropic-ai/sdk/lib/tools/ToolError';
import { z } from 'zod';
import type { RoleModel } from './models.js';
import { type Tool, ToolRefusal } from './tools.js';

export interface Agent {
  model: RoleModel;
  /** The gateway's address for this run and role: …/gateway/<run>/<role>. */
  url: string;
  /** The gateway token, never a provider's key. */
  token: string;
}

/** A role's conversation so far, as a turn returned it. Only this file reads it. */
export type Conversation = readonly unknown[];

export interface TurnInput {
  system: string;
  conversation?: Conversation;
  /** What the role is told now, with a picture when there is one. */
  say: string;
  image?: Buffer | null;
  tools?: Tool[];
  /** At most this many model calls in the turn. */
  calls?: number;
  /** A JSON schema the answer must follow. */
  answer?: Record<string, unknown>;
  maxTokens: number;
}

export interface TurnOutput {
  /** The model's last words: its report, or its answer as JSON. */
  text: string;
  conversation: Conversation;
  /** Every tool the model asked for, offered or not. */
  called: string[];
}

type Message = Anthropic.Beta.Messages.BetaMessageParam;
type Block = Anthropic.Beta.Messages.BetaContentBlock;

const textOf = (content: Block[]) =>
  content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n');

function runnable(t: Tool): BetaRunnableTool {
  const { $schema: _s, ...schema } = z.toJSONSchema(t.input) as Record<string, unknown>;
  return {
    type: 'custom',
    name: t.name,
    description: t.description,
    input_schema: schema as Anthropic.Beta.Messages.BetaTool.InputSchema,
    parse: (x: unknown) => x,
    async run(x: unknown) {
      try {
        const r = await t.run(x);
        if (!r.image) return r.text;
        return [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: r.image.toString('base64') },
          },
          { type: 'text', text: r.text },
        ];
      } catch (e) {
        if (e instanceof ToolRefusal) throw new ToolError(e.message);
        throw e;
      }
    },
  };
}

export async function turn(a: Agent, i: TurnInput): Promise<TurnOutput> {
  const client = new Anthropic({ apiKey: a.token, baseURL: a.url });
  const said: Message = {
    role: 'user',
    content: i.image
      ? [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: i.image.toString('base64') },
          },
          { type: 'text', text: i.say },
        ]
      : i.say,
  };
  const messages = [...((i.conversation ?? []) as Message[]), said];
  const params = {
    model: a.model.model,
    max_tokens: i.maxTokens,
    system: i.system,
    messages,
    ...(i.answer
      ? { output_config: { format: { type: 'json_schema' as const, schema: i.answer } } }
      : {}),
  };
  if (!i.tools?.length) {
    const m = await client.beta.messages.create(params);
    return {
      text: textOf(m.content),
      conversation: [...messages, { role: 'assistant', content: m.content }],
      called: [],
    };
  }
  const runner = client.beta.messages.toolRunner({
    ...params,
    tools: i.tools.map(runnable),
    max_iterations: i.calls,
  });
  const called: string[] = [];
  for await (const m of runner)
    for (const b of m.content) if (b.type === 'tool_use') called.push(b.name);
  const last = await runner.done();
  return { text: textOf(last.content), conversation: [...runner.params.messages], called };
}
