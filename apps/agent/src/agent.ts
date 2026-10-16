// The member assistant: a model, whose only tools are the ones GET /tools lists. Each thing the
// member says is one run of the SDK's tool runner over the whole conversation so far.
import Anthropic from '@anthropic-ai/sdk';
import { type BetaToolRunnerParams, ToolError } from '@anthropic-ai/sdk/resources/beta/messages';
import type { Api, Call } from './api.js';

/** The configured model, and the client that reaches its provider. */
export interface Model {
  client: Anthropic;
  name: string;
}

// The models that take server-side refusal fallbacks.
const FALLBACKS = new Set([
  'claude-fable-5-1',
  'claude-opus-5-5',
  'claude-opus-5',
  'claude-sonnet-5-5',
]);

const SYSTEM = `You are the member-services assistant of a credit union, on the line with one member. You help with their accounts using only your tools, which reach the banks through the Task API.

- A task answers at once with a runId. While its status is running or needs_human, it is not done: ask again with get_task (wait 30) until it settles. Tell the member when a person must act, then keep asking.
- A transfer never moves money until a person approves it. Give each new transfer a new idempotencyKey; to ask about it again, use get_task. Never say money moved until the result says succeeded.
- Amounts are in cents. Say dollars to the member. Never show a full account number.
- When a tool fails, tell the member what the result's message says, in plain words.`;

/** A conversation with the member: say one line, get the assistant's words back. */
export function assistant(
  model: Model,
  api: Api,
  o: { onText?: (t: string) => void; onCall?: (c: Call) => void } = {},
) {
  const tools = api.tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema as Anthropic.Beta.BetaTool.InputSchema,
    parse: (input: unknown) => input as Record<string, unknown>,
    run: async (input: Record<string, unknown>) => {
      const c = await api.call(t.name, input);
      o.onCall?.(c);
      const content = JSON.stringify(c.body);
      if (c.isError) throw new ToolError(content);
      return content;
    },
  }));
  let messages: Anthropic.Beta.BetaMessageParam[] = [];

  return async function say(line: string): Promise<string> {
    const runner = run(model, tools, [...messages, { role: 'user', content: line }]);
    const words: string[] = [];
    for await (const m of runner) {
      const said =
        m.stop_reason === 'refusal'
          ? ['I cannot help with that.']
          : m.content.flatMap((b) => (b.type === 'text' && b.text.trim() ? [b.text] : []));
      for (const t of said) o.onText?.(t);
      words.push(...said);
    }
    messages = [...runner.params.messages];
    return words.join('\n');
  };
}

/** The one call to the model: the tool runner, which loops until the model calls no more tools. */
function run(
  model: Model,
  tools: BetaToolRunnerParams['tools'],
  messages: Anthropic.Beta.BetaMessageParam[],
) {
  return model.client.beta.messages.toolRunner({
    model: model.name,
    max_tokens: 16000,
    output_config: { effort: 'medium' },
    // On a refusal, the API answers from a fallback model in the same call.
    ...(FALLBACKS.has(model.name)
      ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const }
      : {}),
    system: SYSTEM,
    tools,
    messages,
  });
}
