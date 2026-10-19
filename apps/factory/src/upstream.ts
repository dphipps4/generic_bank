// Where the gateway's answers come from: the model itself, through its provider's SDK. With no
// key for a provider, a call to it is refused and names the key; nothing stands in for the model.
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

/** A request the gateway turns away, as an error body OpenAI's SDK reads. */
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

/** A picture in a request. */
export const isPicture = (v: unknown) => (v as { type?: unknown } | null)?.type === 'image_url';

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
  openai: 'OPENAI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
} as const;

/** Each provider's model, through OpenAI's SDK. */
export function live(clients: { openai?: OpenAI; openrouter?: OpenAI }): Upstream {
  return {
    async answer(provider, request) {
      const client = clients[provider];
      if (!client)
        return {
          status: 401,
          body: new Refusal(401, 'authentication_error', `${KEYS[provider]} is not set`).body,
        };
      return openai(client, request);
    },
  };
}

/** OpenRouter's OpenAI-compatible base URL. */
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

/** A client for each provider whose key is set; a call to any other is refused. */
export function upstreamFor(keys: { openai?: string; openrouter?: string }): Upstream {
  return live({
    openai: keys.openai ? new OpenAI({ apiKey: keys.openai, timeout: TURN_MS }) : undefined,
    openrouter: keys.openrouter
      ? new OpenAI({ apiKey: keys.openrouter, baseURL: OPENROUTER_BASE_URL, timeout: TURN_MS })
      : undefined,
  });
}
