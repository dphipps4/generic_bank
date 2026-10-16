// Without a model key, a scripted mock plays the model: the SDK's fetch answers from a script
// instead of Anthropic, so the tool runner, the tools and the API calls are the real ones. The
// script reads each tool result and makes the call a model would make next.
import { randomUUID } from 'node:crypto';

type Body = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
interface Move {
  name: string;
  input: Record<string, unknown>;
}

export interface Turn {
  /** What the member says. */
  member: string;
  /** The call the line asks for. */
  start: Move;
  /** Once a task has settled: the next call, if there is one. */
  next?: (last: Body) => Move | undefined;
  /** The assistant's words when nothing is left to call. */
  reply: (last: Body, results: Body[]) => string;
}

const dollars = (cents: number) =>
  (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

/** The words for anything that did not succeed: the API's own sentence. */
const otherwise = (b: Body) =>
  `I could not do that: ${b.message ?? b.detail ?? b.title ?? 'the bank system did not answer'}.`;

/** The demo conversation (plan, §D.5) with a member of Generic Bank. */
export function demoScript(now = new Date()): Turn[] {
  const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))
    .toISOString()
    .slice(0, 7);
  const member = { bank: 'generic', memberId: '40017732' };
  return [
    {
      member: 'Which banks can you reach for me?',
      start: { name: 'list_banks', input: {} },
      reply: (b) =>
        Array.isArray(b)
          ? `I can reach ${b.map((x: Body) => `${x.brand} (${x.tasks.map((t: Body) => t.task).join(', ') || 'nothing yet'})`).join('; ')}.`
          : otherwise(b),
    },
    {
      member: "I'm member 40017732 at Generic Bank. What's the balance in my Everyday Checking?",
      start: { name: 'check_balance', input: { ...member, account: 'Everyday Checking' } },
      reply: (b) =>
        b.status === 'succeeded'
          ? `Your Everyday Checking has ${dollars(b.data.availableCents)} available (${dollars(b.data.currentCents)} current).`
          : otherwise(b),
    },
    {
      member: "Please send me last month's statement for it.",
      start: {
        name: 'download_statements',
        input: { ...member, account: 'Everyday Checking', months: [lastMonth] },
      },
      next: (b) => {
        const ref = b.data?.months?.[0]?.statement;
        return ref ? { name: 'get_statement', input: { ref } } : undefined;
      },
      reply: (b, all) =>
        b.saved
          ? `Here is your statement for ${lastMonth}: ${b.saved}.`
          : (all.at(-1)?.data?.months?.[0]?.note ?? otherwise(b)),
    },
    {
      member: 'Move $200 from Everyday Checking to Rainy Day Savings, please.',
      start: {
        name: 'transfer',
        input: {
          ...member,
          from: 'Everyday Checking',
          to: 'Rainy Day Savings',
          amountCents: 20_000,
          memo: 'From the assistant',
          idempotencyKey: `demo-${randomUUID()}`,
        },
      },
      reply: (b) =>
        b.status === 'succeeded'
          ? `Done: ${dollars(20_000)} moved to Rainy Day Savings. The bank's confirmation is ${b.data.confirmation}.`
          : otherwise(b),
    },
  ];
}

/** A fetch that answers the Messages API from the script. */
export function mockModel(script: Turn[]): typeof fetch {
  let n = 0;
  return async (_url, init) => {
    const req = JSON.parse(String(init?.body)) as { model: string; messages: Body[] };
    // The member's lines are the user messages that are plain text.
    const lines = req.messages.flatMap((m, i) =>
      m.role === 'user' && typeof m.content === 'string' ? [i] : [],
    );
    const turn = script[lines.length - 1]!;
    const results = req.messages
      .slice(lines.at(-1)! + 1)
      .flatMap((m) => (m.role === 'user' ? m.content : []))
      .filter((b: Body) => b.type === 'tool_result')
      .map((b: Body) => JSON.parse(typeof b.content === 'string' ? b.content : b.content[0].text));
    const last = results.at(-1) as Body | undefined;

    const content: Body[] = [];
    let move: Move | undefined;
    if (!last) move = turn.start;
    else if (last.status === 'running' || last.status === 'needs_human') {
      // Told once that a person must act, then asked again until the task settles.
      const waiting = results.filter((r) => r.status === 'needs_human').length;
      if (last.status === 'needs_human' && waiting === 1)
        content.push({ type: 'text', text: `${last.message} I will let you know.` });
      move = { name: 'get_task', input: { runId: last.runId, wait: 30 } };
    } else move = turn.next?.(last);

    if (move) content.push({ type: 'tool_use', id: `toolu_mock_${++n}`, ...move });
    else content.push({ type: 'text', text: turn.reply(last!, results) });
    const message = {
      id: `msg_mock_${++n}`,
      type: 'message',
      role: 'assistant',
      model: req.model,
      content,
      stop_reason: move ? 'tool_use' : 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    };
    return new Response(JSON.stringify(message), {
      headers: { 'content-type': 'application/json' },
    });
  };
}
