// A role's turn with its model, as a pi session (plan §7): the one place the factory calls a
// model, and the only code that knows the provider. The role's provider, model and effort come
// from its settings; every request goes to the gateway, which meters it and replays it in mock
// mode, and never to the provider itself.
import { Agent as PiAgent, type AgentMessage, type AgentTool } from '@earendil-works/pi-agent-core';
import type {
  Api,
  AssistantMessage,
  ImageContent,
  Model,
  TextContent,
} from '@earendil-works/pi-ai';
import { streamSimple as anthropicStream } from '@earendil-works/pi-ai/api/anthropic-messages';
import { streamSimple as openaiStream } from '@earendil-works/pi-ai/api/openai-completions';
import { ANTHROPIC_MODELS } from '@earendil-works/pi-ai/providers/anthropic.models';
import { OPENAI_MODELS } from '@earendil-works/pi-ai/providers/openai.models';
import { OPENROUTER_MODELS } from '@earendil-works/pi-ai/providers/openrouter.models';
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
  /** Calls refused before they reached the tool (no such tool, or input that does not fit). */
  refused: { name: string; why: string }[];
}

/** The longest one model call may take: a profile drafted at high effort can think for many minutes. */
export const TURN_MS = 30 * 60_000;

const png = (b: Buffer): ImageContent => ({
  type: 'image',
  data: b.toString('base64'),
  mimeType: 'image/png',
});

// Each provider's wire protocol in pi. OpenAI is spoken as Chat Completions, which most
// OpenAI-compatible servers speak too. OpenRouter speaks both; its Anthropic models use Anthropic
// Messages, the rest use OpenAI Completions. The gateway path for OpenRouter is /openrouter so the
// gateway routes the request to the OpenRouter client, not to Anthropic's or OpenAI's.
const API = {
  'anthropic-messages': { path: '', send: anthropicStream },
  'openai-completions': { path: '/v1', send: openaiStream },
} as const;
const PROVIDER = {
  anthropic: { api: 'anthropic-messages' as const, prefix: '', models: ANTHROPIC_MODELS },
  openai: { api: 'openai-completions' as const, prefix: '', models: OPENAI_MODELS },
  openrouter: { api: null, prefix: '/openrouter', models: OPENROUTER_MODELS },
};

/** Which wire format a model speaks: from its provider, or from the model's own catalog entry. */
export function apiOf(m: RoleModel): keyof typeof API {
  const p = PROVIDER[m.provider];
  if (p.api) return p.api;
  const known = (p.models as Record<string, Model<Api>>)[m.model];
  return (known?.api as keyof typeof API) ?? 'openai-completions';
}

/** The role's model as pi knows it, pointed at the gateway. A model pi does not list still runs. */
function modelOf(a: Agent): Model<Api> {
  const p = PROVIDER[a.model.provider];
  const api = apiOf(a.model);
  const id = a.model.model;
  const known = (p.models as Record<string, Model<Api>>)[id];
  return {
    ...(known ?? {
      id,
      name: id,
      reasoning: true,
      input: ['text', 'image'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: 32_000,
    }),
    api,
    provider: a.model.provider,
    baseUrl: `${a.url}${p.prefix}${API[api].path}`,
  } as Model<Api>;
}

/** Some models fence an answer as code or wrap it in a one-item list, schema or not; the answer is inside. */
export function unwrapped(text: string): string {
  const t = text.trim();
  const inner = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(t)?.[1] ?? t;
  try {
    const v: unknown = JSON.parse(inner);
    return Array.isArray(v) && v.length === 1 ? JSON.stringify(v[0]) : inner;
  } catch {
    return inner;
  }
}

/** The answer's schema in the request, in the provider's own form. */
function withAnswer(api: keyof typeof API, schema: Record<string, unknown>) {
  return (payload: unknown) => {
    const p = payload as Record<string, unknown>;
    if (api === 'anthropic-messages')
      return {
        ...p,
        output_config: { ...(p.output_config as object), format: { type: 'json_schema', schema } },
      };
    return {
      ...p,
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'answer', schema, strict: true },
      },
    };
  };
}

export async function turn(a: Agent, i: TurnInput): Promise<TurnOutput> {
  const model = modelOf(a);
  const api = apiOf(a.model);
  const send = API[api].send as typeof anthropicStream;
  // A tool that fails for any reason but a refusal stops the turn, and the error is the turn's.
  let failure: unknown;
  const ran = new Set<string>();
  const tools: AgentTool[] = (i.tools ?? []).map((t) => {
    const { $schema: _s, ...schema } = z.toJSONSchema(t.input) as Record<string, unknown>;
    return {
      name: t.name,
      label: t.name,
      description: t.description,
      parameters: schema as never,
      async execute(id, input) {
        ran.add(id);
        try {
          const r = await t.run(input);
          const text: TextContent = { type: 'text', text: r.text };
          return { content: r.image ? [png(r.image), text] : [text], details: {} };
        } catch (e) {
          if (!(e instanceof ToolRefusal)) {
            failure ??= e;
            session.abort();
          }
          throw e;
        }
      },
    };
  });
  let calls = 0;
  const session = new PiAgent({
    initialState: {
      systemPrompt: i.system,
      model,
      thinkingLevel: a.model.effort,
      tools,
      messages: [...((i.conversation ?? []) as AgentMessage[])],
    },
    // One browser: its tools run one at a time.
    toolExecution: 'sequential',
    streamFn: (m, context, options) =>
      send(m as never, context, {
        ...options,
        apiKey: a.token,
        maxTokens: i.maxTokens,
        timeoutMs: TURN_MS,
        ...(i.answer ? { onPayload: withAnswer(api, i.answer) } : {}),
      }),
    finishTurn: () => (i.calls !== undefined && ++calls >= i.calls ? { action: 'end' } : undefined),
  });
  const before = session.state.messages.length;
  await session.prompt({
    role: 'user',
    content: i.image ? [png(i.image), { type: 'text', text: i.say }] : i.say,
    timestamp: Date.now(),
  });
  if (failure !== undefined) throw failure;
  const messages = session.state.messages;
  const added = messages.slice(before);
  const replies = added.filter((m): m is AssistantMessage => m.role === 'assistant');
  const last = replies.at(-1);
  if (!last || last.stopReason === 'error' || last.stopReason === 'aborted')
    throw new Error(`the ${a.model.provider} model failed: ${last?.errorMessage ?? 'no answer'}`);
  // A model that spends its whole allowance thinking says nothing; that is a failure, not an answer.
  if (last.stopReason === 'length' && !last.content.some((b) => b.type !== 'thinking'))
    throw new Error(
      `the ${a.model.provider} model used all ${i.maxTokens} tokens thinking and gave no answer`,
    );
  const refused = added.flatMap((m) =>
    m.role === 'toolResult' && m.isError && !ran.has(m.toolCallId)
      ? [
          {
            name: m.toolName,
            why: m.content.flatMap((c) => (c.type === 'text' ? [c.text] : [])).join('\n'),
          },
        ]
      : [],
  );
  const text = last.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n');
  return {
    text: i.answer ? unwrapped(text) : text,
    conversation: [...messages],
    refused,
  };
}
