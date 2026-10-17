// Where the gateway's answers come from: the model itself, through its provider's SDK. With no
// key for a provider, a call to it is refused and names the key; nothing stands in for the model.
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { TURN_MS } from './agent.js';
import type { Provider, Usage } from './models.js';

export type Request = Record<string, unknown>;

/** The bytes the agent gets back, and what they used. */
export interface Answer {
  status: number;
  body: string;
  usage?: Usage;
}

export interface Upstream {
  answer(provider: Provider, request: Request): Promise<Answer>;
}

/** A request the gateway turns away, as an Anthropic error body (OpenAI's SDK reads it too). */
export class Refusal extends Error {
  constructor(
    readonly status: number,
    readonly type: string,
    message: string,
  ) {
    super(message);
  }
  get body(): string {
    return JSON.stringify({ type: 'error', error: { type: this.type, message: this.message } });
  }
}

/** A picture in a request, in either provider's form. */
export const isPicture = (v: unknown) => {
  const type = (v as { type?: unknown } | null)?.type;
  return type === 'image' || type === 'image_url';
};

async function anthropic(client: Anthropic, request: Request): Promise<Answer> {
  const { stream: streamed, ...params } = request;
  try {
    // Always streamed upstream, so a long answer cannot time out the request. Betas the agent
    // asked for travel as `betas`, which the SDK sends as the header.
    const stream = client.beta.messages.stream(params as never);
    // Each event is written down as it arrives: the SDK goes on to build the final message
    // inside the first event's object.
    const events: string[] = [];
    for await (const e of stream) events.push(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
    const m = await stream.finalMessage();
    const u = m.usage;
    return {
      status: 200,
      body: streamed ? events.join('') : JSON.stringify(m),
      usage: {
        input: u.input_tokens,
        output: u.output_tokens,
        cacheRead: u.cache_read_input_tokens ?? 0,
        cacheWrite: u.cache_creation_input_tokens ?? 0,
      },
    };
  } catch (e) {
    if (!(e instanceof Anthropic.APIError)) throw e;
    const error = e.error ?? { type: 'error', error: { type: 'api_error', message: e.message } };
    return { status: e.status ?? 502, body: JSON.stringify(error) };
  }
}

const usageOf = (u: OpenAI.CompletionUsage): Usage => {
  const cached = u.prompt_tokens_details?.cached_tokens ?? 0;
  return {
    input: u.prompt_tokens - cached,
    output: u.completion_tokens,
    cacheRead: cached,
    cacheWrite: 0,
  };
};

async function openai(client: OpenAI, request: Request): Promise<Answer> {
  try {
    if (request.stream !== true) {
      const c = await client.chat.completions.create(
        request as unknown as OpenAI.ChatCompletionCreateParamsNonStreaming,
      );
      if (!c.usage) throw new Error('the model reported no usage');
      return { status: 200, body: JSON.stringify(c), usage: usageOf(c.usage) };
    }
    // The last chunk carries the usage, whether or not the agent asked for it.
    const stream = await client.chat.completions.create({
      ...request,
      stream_options: { ...(request.stream_options as object), include_usage: true },
    } as unknown as OpenAI.ChatCompletionCreateParamsStreaming);
    const chunks: string[] = [];
    let usage: OpenAI.CompletionUsage | undefined;
    for await (const c of stream) {
      chunks.push(`data: ${JSON.stringify(c)}\n\n`);
      usage = c.usage ?? usage;
    }
    // Unmetered, the call stays held at its worst case.
    if (!usage) throw new Error('the model reported no usage');
    return { status: 200, body: `${chunks.join('')}data: [DONE]\n\n`, usage: usageOf(usage) };
  } catch (e) {
    if (!(e instanceof OpenAI.APIError)) throw e;
    const error = e.error ?? { type: 'api_error', message: e.message };
    return { status: e.status ?? 502, body: JSON.stringify({ error }) };
  }
}

const KEYS = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
} as const;

/** Each provider's model, through its SDK. */
export function live(clients: {
  anthropic?: Anthropic;
  openai?: OpenAI;
  openrouter?: { anthropic: Anthropic; openai: OpenAI };
}): Upstream {
  return {
    async answer(provider, request) {
      if (provider === 'openrouter') {
        const or = clients.openrouter;
        if (!or)
          return {
            status: 401,
            body: new Refusal(401, 'authentication_error', `${KEYS[provider]} is not set`).body,
          };
        // pi puts the system prompt at the top level only in Anthropic Messages.
        return 'system' in request ? anthropic(or.anthropic, request) : openai(or.openai, request);
      }
      const client = clients[provider];
      if (!client)
        return {
          status: 401,
          body: new Refusal(401, 'authentication_error', `${KEYS[provider]} is not set`).body,
        };
      return provider === 'anthropic'
        ? anthropic(client as Anthropic, request)
        : openai(client as OpenAI, request);
    },
  };
}

/** OpenRouter's base URL, with two API surfaces: /api for Anthropic Messages, /api/v1 for OpenAI. */
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api';

/** A client for each provider whose key is set; a call to any other is refused. */
export function upstreamFor(keys: {
  anthropic?: string;
  openai?: string;
  openrouter?: string;
}): Upstream {
  return live({
    anthropic: keys.anthropic
      ? new Anthropic({ apiKey: keys.anthropic, timeout: TURN_MS })
      : undefined,
    openai: keys.openai ? new OpenAI({ apiKey: keys.openai, timeout: TURN_MS }) : undefined,
    openrouter: keys.openrouter
      ? {
          anthropic: new Anthropic({
            apiKey: keys.openrouter,
            baseURL: OPENROUTER_BASE_URL,
            timeout: TURN_MS,
          }),
          openai: new OpenAI({
            apiKey: keys.openrouter,
            baseURL: `${OPENROUTER_BASE_URL}/v1`,
            timeout: TURN_MS,
          }),
        }
      : undefined,
  });
}
