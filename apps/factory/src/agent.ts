// A role's turn with its model, as a pi session (plan §7): the one place the factory calls a
// model, and the only code that knows the provider. The role's provider, model and effort come
// from its settings; every request goes to the gateway, which meters it, and never to the
// provider itself.
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

/** A turn whose model spent its whole allowance thinking and gave no answer. */
export class ThoughtTooLong extends Error {}

/** The Supervisor ended the turn: its clock ran out, or it judged the Scout should go. */
export class Ended extends Error {}

export interface TurnInput {
  system: string;
  conversation?: Conversation;
  /** What the role is told now, with a picture when there is one. */
  say: string;
  image?: Buffer | null;
  /** More pictures with it: close-ups the Scout read from. */
  images?: Buffer[];
  tools?: Tool[];
  /** At most this many model calls in the turn. */
  calls?: number;
  /** A JSON schema the answer must follow. */
  answer?: Record<string, unknown>;
  maxTokens: number;
  /** Aborting it ends the turn at once: the model call in flight, and any tool. */
  signal?: AbortSignal;
  /**
   * Keep only the latest this many tool results whole, pictures and all; older ones shrink to their
   * first line, and older thinking is dropped. Each call then costs about what the first did.
   */
  keep?: number;
  /** Each reply of the model as it comes, its thinking and its words: the evidence of its reasoning. */
  onReply?(r: { thinking: string; text: string }): void | Promise<void>;
}

export interface TurnOutput {
  /** The model's last words: its report, or its answer as JSON. */
  text: string;
  /** The model's thinking in this turn, every reply's, in order. */
  thinking: string;
  conversation: Conversation;
}

/** The longest one model call may take: a profile drafted at high effort can think for many minutes. */
export const TURN_MS = 30 * 60_000;

/** What a reply thought and said. */
const partsOf = (m: AssistantMessage) => ({
  thinking: m.content
    .flatMap((b) => (b.type === 'thinking' ? [(b as { thinking?: string }).thinking ?? ''] : []))
    .join('\n'),
  text: m.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n'),
});

/**
 * The conversation as the model is shown it: every message, in order, but only the latest `keep`
 * tool results whole. An older result keeps its first line, without its picture, and an older reply
 * keeps its words and its calls, not its thinking.
 */
export function compacted(messages: AgentMessage[], keep: number): AgentMessage[] {
  const results = messages.flatMap((m, k) => (m.role === 'toolResult' ? [k] : []));
  const old = new Set(results.slice(0, Math.max(0, results.length - keep)));
  const lastUser = messages.map((m) => m.role).lastIndexOf('user');
  const cutoff = results.length > keep ? results[results.length - keep]! : messages.length;
  return messages.map((m, k) => {
    if (old.has(k) && m.role === 'toolResult') {
      const first = m.content
        .flatMap((c) => (c.type === 'text' ? [c.text] : []))
        .join(' ')
        .split('\n')[0]!
        .slice(0, 240);
      return { ...m, content: [{ type: 'text', text: `${first} (older result, shortened)` }] };
    }
    if (k < cutoff && m.role === 'user' && k !== lastUser && Array.isArray(m.content))
      return { ...m, content: m.content.filter((c) => c.type !== 'image') };
    if (k < cutoff && m.role === 'assistant')
      return { ...m, content: m.content.filter((c) => c.type !== 'thinking') };
    return m;
  }) as AgentMessage[];
}

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

/** A provider's error that passes: tried again, in the same conversation. */
export const TRANSIENT =
  /\b(5\d\d|429)\b|timed? ?out|timeout|overloaded|rate.?limit|ECONNRESET|socket hang up|temporarily/i;
const TRANSIENT_TRIES = 3;

export async function turn(a: Agent, i: TurnInput): Promise<TurnOutput> {
  const model = modelOf(a);
  const api = apiOf(a.model);
  const send = API[api].send as typeof anthropicStream;
  // A tool that fails for any reason but a refusal stops the turn, and the error is the turn's.
  let failure: unknown;
  // One thing at a time: once a call in a reply is refused, the reply's later calls are not run, so
  // nothing acts before the refusal is read (run 21: a refused naming, then a press that left the page).
  let refusedInReply = false;
  const tools: AgentTool[] = (i.tools ?? []).map((t) => {
    const { $schema: _s, ...schema } = z.toJSONSchema(t.input) as Record<string, unknown>;
    return {
      name: t.name,
      label: t.name,
      description: t.description,
      parameters: schema as never,
      async execute(id, input) {
        if (refusedInReply)
          throw new ToolRefusal(
            'not run: an earlier call in this reply was refused. Read why, then act again, one call at a time',
          );
        try {
          const r = await t.run(input);
          const text: TextContent = { type: 'text', text: r.text };
          return { content: r.image ? [png(r.image), text] : [text], details: {} };
        } catch (e) {
          if (!(e instanceof ToolRefusal)) {
            failure ??= e;
            session.abort();
          } else refusedInReply = true;
          throw e;
        }
      },
    };
  });
  let calls = 0;
  // Each reply is reported once, as soon as the next call is about to be made, and at the end.
  let reported = (i.conversation ?? []).length;
  const report = async (messages: AgentMessage[]) => {
    for (const m of messages.slice(reported))
      if (m.role === 'assistant') await i.onReply?.(partsOf(m as AssistantMessage));
    reported = messages.length;
  };
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
    transformContext: async (messages) => {
      // A new reply is about to be asked for: its calls run until one is refused.
      refusedInReply = false;
      await report(messages);
      return i.keep === undefined ? messages : compacted(messages, i.keep);
    },
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
  if (i.signal?.aborted) throw new Ended(String(i.signal.reason ?? 'ended'));
  i.signal?.addEventListener('abort', () => session.abort(), { once: true });
  const before = session.state.messages.length;
  await session.prompt({
    role: 'user',
    content:
      i.image || i.images?.length
        ? [
            ...(i.image ? [png(i.image)] : []),
            ...(i.images ?? []).map(png),
            { type: 'text', text: i.say },
          ]
        : i.say,
    timestamp: Date.now(),
  });
  // A provider's passing failure (a 5xx, a timeout, a rate limit) is not the agent's: the failed
  // reply is dropped and the same conversation carries on, a few times at most. A long turn of many
  // calls would otherwise end on one bad call.
  for (let again = 1; again <= TRANSIENT_TRIES; again++) {
    const failed = session.state.messages.at(-1) as AssistantMessage | undefined;
    if (
      i.signal?.aborted ||
      failure !== undefined ||
      failed?.role !== 'assistant' ||
      failed.stopReason !== 'error' ||
      !TRANSIENT.test(failed.errorMessage ?? '')
    )
      break;
    session.state.messages = session.state.messages.slice(0, -1);
    await new Promise((r) => setTimeout(r, 2000 * again));
    await session.continue();
  }
  await report(session.state.messages).catch(() => undefined);
  if (i.signal?.aborted) throw new Ended(String(i.signal.reason ?? 'ended'));
  if (failure !== undefined) throw failure;
  const messages = session.state.messages;
  const added = messages.slice(before);
  const replies = added.filter((m): m is AssistantMessage => m.role === 'assistant');
  const last = replies.at(-1);
  if (!last || last.stopReason === 'error' || last.stopReason === 'aborted')
    throw new Error(`the ${a.model.provider} model failed: ${last?.errorMessage ?? 'no answer'}`);
  // A model that spends its whole allowance thinking says nothing; that is a failure, not an answer.
  if (last.stopReason === 'length' && !last.content.some((b) => b.type !== 'thinking'))
    throw new ThoughtTooLong(
      `the ${a.model.provider} model used all ${i.maxTokens} tokens thinking and gave no answer`,
    );
  const text = last.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n');
  return {
    text: i.answer ? unwrapped(text) : text,
    thinking: replies
      .map((r) => partsOf(r).thinking)
      .filter(Boolean)
      .join('\n'),
    conversation: [...messages],
  };
}
