// Where the gateway's answers come from: the model itself, each call recorded, or a recording
// replayed (mock mode). A recording is one file per run, one call per line, in order.
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import Anthropic from '@anthropic-ai/sdk';
import { DEFAULT_ROLES, type Role, type Roles } from './models.js';

export type Request = Record<string, unknown>;

/** The bytes the agent gets back, and what they used. */
export interface Answer {
  status: number;
  body: string;
  usage?: Anthropic.Usage;
}

/** One line of a recording. */
export interface Recorded extends Answer {
  role: Role;
  request: Request;
}

export interface Upstream {
  /** False when nothing is spent: a replay. */
  readonly spends: boolean;
  answer(runId: string, role: Role, request: Request): Promise<Answer>;
}

/** A request the gateway turns away, as an Anthropic error body. */
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

const file = (dir: string, runId: string) => join(dir, `${runId}.jsonl`);
const sse = (e: Anthropic.MessageStreamEvent) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`;

/** The model, through the SDK. The role sets the effort; every call is recorded. */
export function live(
  client: Anthropic,
  recordings: string,
  roles: Roles = DEFAULT_ROLES,
): Upstream {
  return {
    spends: true,
    async answer(runId, role, request) {
      const { stream: streamed, ...params } = request;
      const output_config = { ...(params.output_config as object), effort: roles[role].effort };
      let answer: Answer;
      try {
        // Always streamed upstream, so a long answer cannot time out the request.
        const stream = client.messages.stream({ ...params, output_config } as never);
        // Each event is written down as it arrives: the SDK goes on to build the final message
        // inside the first event's object.
        const events: string[] = [];
        for await (const e of stream) events.push(sse(e));
        const message = await stream.finalMessage();
        const body = streamed ? events.join('') : JSON.stringify(message);
        answer = { status: 200, body, usage: message.usage };
      } catch (e) {
        if (!(e instanceof Anthropic.APIError)) throw e;
        const error = e.error ?? {
          type: 'error',
          error: { type: 'api_error', message: e.message },
        };
        answer = { status: e.status ?? 502, body: JSON.stringify(error) };
      }
      await mkdir(recordings, { recursive: true });
      const line: Recorded = { role, request, ...answer };
      await appendFile(file(recordings, runId), `${JSON.stringify(line)}\n`);
      return answer;
    },
  };
}

/** With a key, the model; without one, mock mode, and no client is ever made. */
export const upstreamFor = (apiKey: string, recordings: string, roles?: Roles): Upstream =>
  apiKey ? live(new Anthropic({ apiKey }), recordings, roles) : replay(recordings);

// What a replayed request must repeat exactly: the model's own turns, the order and shape of the
// conversation, the tool calls and the request's settings. What the bank showed (the page text,
// the screenshots and the tool results read from a live page) may differ between the recording and
// the replay, where the page moves or the bank's state is not the same, so only its shape is kept.
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
type Message = { role: string; content: unknown };
const unpictured = (r: Request): unknown => ({
  ...r,
  messages: ((r.messages ?? []) as Message[]).map((m) =>
    m.role === 'assistant'
      ? m
      : {
          role: m.role,
          content: Array.isArray(m.content) ? m.content.map(shapeOf) : shapeOf(m.content),
        },
  ),
});

/** Mock mode: each request must be the next one in the run's recording, which answers it. */
export function replay(recordings: string): Upstream {
  const runs = new Map<string, { calls: Recorded[]; next: number }>();
  return {
    spends: false,
    async answer(runId, role, request) {
      let run = runs.get(runId);
      if (!run) {
        const text = await readFile(file(recordings, runId), 'utf8').catch(() => {
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
      if (call.role !== role || !isDeepStrictEqual(unpictured(call.request), unpictured(request)))
        throw new Refusal(400, 'invalid_request_error', `call ${n} differs from the recording`);
      run.next = n;
      return call;
    },
  };
}
