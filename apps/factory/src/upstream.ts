// Where the gateway's answers come from: the model itself, each call recorded, or a recording
// replayed (mock mode). A recording is one file per run, one call per line, in order.
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import type { Provider, Role, Usage } from './models.js';

export type Request = Record<string, unknown>;

/** The bytes the agent gets back, and what they used. */
export interface Answer {
  status: number;
  body: string;
  usage?: Usage;
}

/** One line of a recording. */
export interface Recorded extends Answer {
  role: Role;
  provider: Provider;
  request: Request;
}

export interface Upstream {
  /** False when nothing is spent: a replay. */
  readonly spends: boolean;
  answer(runId: string, role: Role, provider: Provider, request: Request): Promise<Answer>;
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

const file = (dir: string, runId: string) => join(dir, `${runId}.jsonl`);

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

const KEYS = { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY' } as const;

/** Each provider's model, through its SDK; every call is recorded. */
export function live(
  clients: { anthropic?: Anthropic; openai?: OpenAI },
  recordings: string,
): Upstream {
  return {
    spends: true,
    async answer(runId, role, provider, request) {
      const client = clients[provider];
      if (!client)
        return {
          status: 401,
          body: new Refusal(401, 'authentication_error', `${KEYS[provider]} is not set`).body,
        };
      const answer =
        provider === 'anthropic'
          ? await anthropic(client as Anthropic, request)
          : await openai(client as OpenAI, request);
      await mkdir(recordings, { recursive: true });
      const line: Recorded = { role, provider, request, ...answer };
      await appendFile(file(recordings, runId), `${JSON.stringify(line)}\n`);
      return answer;
    },
  };
}

/** With a key, the model; with none at all, mock mode, and no client is ever made. */
export function upstreamFor(
  keys: { anthropic?: string; openai?: string },
  recordings: string,
): Upstream {
  if (!keys.anthropic && !keys.openai) return replay(recordings);
  return live(
    {
      anthropic: keys.anthropic ? new Anthropic({ apiKey: keys.anthropic }) : undefined,
      openai: keys.openai ? new OpenAI({ apiKey: keys.openai }) : undefined,
    },
    recordings,
  );
}

// What a replayed request must repeat exactly: the agents' own turns (system and assistant), the
// order and shape of the conversation, the tool calls and the request's settings. What the bank
// showed (page text, screenshots, tool results read from a live page) may differ between the
// recording and the replay, where the page moves or the bank's state is not the same, so only its
// shape is kept. The same rule serves Anthropic's Messages and OpenAI's Chat Completions.
type Block = { type?: unknown; tool_use_id?: unknown; is_error?: unknown };
const shapeOf = (b: unknown): unknown => {
  if (typeof b === 'string') return { type: 'text' };
  const block = b as Block;
  if (block.type === 'tool_result')
    return {
      type: 'tool_result',
      tool_use_id: block.tool_use_id,
      is_error: block.is_error ?? false,
    };
  return { type: block.type };
};
type Message = { role: string; content: unknown; tool_call_id?: unknown };
export const unpictured = (r: Request): unknown => ({
  ...r,
  messages: ((r.messages ?? []) as Message[]).map((m) =>
    m.role === 'assistant' || m.role === 'system'
      ? m
      : {
          role: m.role,
          ...(m.tool_call_id !== undefined ? { tool_call_id: m.tool_call_id } : {}),
          content: Array.isArray(m.content) ? m.content.map(shapeOf) : shapeOf(m.content),
        },
  ),
});

/** Where two requests first differ, as a path such as messages[3].content[0].is_error; or null. */
function differs(a: unknown, b: unknown, path: string): string | null {
  if (isDeepStrictEqual(a, b)) return null;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null)
    return path || 'the request';
  if (Array.isArray(a) !== Array.isArray(b)) return path || 'the request';
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
  for (const k of keys) {
    const at = Array.isArray(a) ? `${path}[${k}]` : path ? `${path}.${k}` : k;
    const d = differs((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], at);
    if (d) return d;
  }
  return path || 'the request';
}

/** Mock mode: each request must be the next one in the run's recording, which answers it. */
export function replay(recordings: string): Upstream {
  const runs = new Map<string, { calls: Recorded[]; next: number }>();
  return {
    spends: false,
    async answer(runId, role, provider, request) {
      let run = runs.get(runId);
      if (!run) {
        // A run with no recording of its own replays the one kept for its kind: repair-generic
        // for the run repair-generic-1a2b3c4d.
        const kind = runId.replace(/-[0-9a-f]{8}$/, '');
        const text = await readFile(file(recordings, runId), 'utf8')
          .catch(() => readFile(file(recordings, kind), 'utf8'))
          .catch(() => {
            throw new Refusal(400, 'invalid_request_error', `no recording for run ${runId}`);
          });
        const calls = text
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l) as Recorded);
        run = { calls, next: 0 };
        runs.set(runId, run);
      }
      const n = run.next + 1;
      const call = run.calls[run.next];
      if (!call)
        throw new Refusal(400, 'invalid_request_error', `the recording ends before call ${n}`);
      const where =
        call.role !== role
          ? `the role (${role}, recorded ${call.role})`
          : call.provider !== provider
            ? `the provider (${provider}, recorded ${call.provider})`
            : differs(unpictured(call.request), unpictured(request), '');
      if (where)
        throw new Refusal(
          400,
          'invalid_request_error',
          `call ${n} differs from the recording at ${where}`,
        );
      run.next = n;
      return call;
    },
  };
}
