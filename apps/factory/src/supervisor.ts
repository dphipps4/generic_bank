// The Supervisor (plan, §7): after every Scout step it looks at the latest frame, the masked
// picture and the page as JSON, reasons about where the Scout stands against the goal, and answers
// in a fixed form: the next step, wait, or stop; why, in one line; and the frames of this run it
// relied on. An unreadable answer counts as wait; three in a row stop the run, and so does the same
// step asked three times in a row, and so does the run's hours cap.
import { maskText } from '@gb/evidence';
import { z } from 'zod';
import { type Agent, type Conversation, turn } from './agent.js';
import { CAPS } from './caps.js';
import { runScout, type Scout, type Supervisor } from './scout.js';
import { type Tool, toolsOf } from './tools.js';
import type { Trail } from './trail.js';

/** The three things the product does, as goals for a run on a member's accounts. */
export const GOALS = {
  'check-balance': (member: string) =>
    `Find member ${member} and reach the page that shows the balances of the member's accounts.`,
  transfer: (member: string) =>
    `Find member ${member} and prepare a transfer of $1.00 from the member's first account to their second, up to the review page. The review page is the end: never submit the transfer.`,
  'download-statements': (member: string) =>
    `Find member ${member} and reach the list of statements for the member's first account.`,
} as const;

export type Goal = keyof typeof GOALS;

const UNREADABLE_IN_A_ROW = 3;
// The stall rule (§7): no progress for three turns ends the run. A page whose content comes back
// unchanged is no progress either, however the step is worded: three steps on it, and no fourth.
const STALL = 3;
// The most questions to memory in one step, before the answer.
const QUERIES = 2;

// For the model: structured output takes no length limits, so those are checked after.
const ANSWER_SCHEMA = {
  type: 'object',
  properties: {
    next: {
      type: 'string',
      description: 'One simple instruction for the Scout, or exactly "wait" or "stop"',
    },
    reason: { type: 'string', description: 'Why, in one line' },
    frames: {
      type: 'array',
      items: { type: 'string' },
      description: 'The frames the answer relies on, such as f3',
    },
  },
  required: ['next', 'reason', 'frames'],
  additionalProperties: false,
};

const Answer = z.object({
  next: z.string().trim().min(1).max(400),
  reason: z
    .string()
    .trim()
    .min(1)
    .max(300)
    .refine((s) => !s.includes('\n'), 'the reason is one line'),
  frames: z.array(z.string()).min(1).max(20),
});
export type Answer = z.infer<typeof Answer>;

/** The answer, or why it cannot be read: not the form, or a frame that is not of this run. */
export function readAnswer(text: string, isFrame: (ref: string) => boolean): Answer | string {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return 'the answer is not JSON';
  }
  const a = Answer.safeParse(json);
  if (!a.success) return `the answer does not fit: ${z.prettifyError(a.error)}`;
  const foreign = a.data.frames.filter((f) => !isFrame(f));
  if (foreign.length) return `${foreign.join(', ')} is not a frame of this run`;
  return a.data;
}

const SYSTEM = `You are the Supervisor. A Scout drives one browser at a staff console for you, one simple step at a time; you never touch the browser yourself.

After every step you see the latest frame: the masked picture of the page, and the page as JSON with its controls by reference. Look at the evidence, reason about where the Scout is against the goal, and answer with:
- next: one simple instruction for the Scout, in the page's own words (a control's name, a field's label); or "wait" when the page is still changing; or "stop" when the goal's page is on screen, or the goal cannot be reached;
- reason: why, in one line;
- frames: the frames you relied on, from the ones you were shown.

The Scout types the staff credentials and any code the site sends with its own tools: tell it to sign in or to enter the code, never the values. Never tell it to submit a transfer: the review page is where a transfer ends.

You are also shown what the factory's memory knows about this site and sites like it, best first. A lesson labeled "verify before relying" is not yet proven, and a disputed one says why: weigh it against the frames. To ask memory something more, call memory_query; it changes nothing.`;

export function supervisor(o: {
  agent: Agent;
  scout: Scout;
  trail: Trail;
  goal: string;
  /** When the run started; the run stops at CAPS.activeHoursPerRun after it. */
  startedAt?: Date;
  /** The knowledge pack, as the Supervisor reads it with every step. */
  knowledge?: string;
  /** Tools beside the answer, such as memory_query; only those the Supervisor may call are given. */
  tools?: Tool[];
}): Supervisor & { ended(): string | null } {
  const until = (o.startedAt?.getTime() ?? Date.now()) + CAPS.activeHoursPerRun * 3_600_000;
  const steps: string[] = [];
  let asked: string | null = null;
  let repeats = 0;
  const stepsOn = new Map<string, number>();
  let ended: string | null = null;
  const mask = (s: string) => maskText(s, o.trail.policy);
  const tools = toolsOf('supervisor', o.tools ?? []);

  return {
    ended: () => ended,
    async next(report) {
      let unreadable = 0;
      for (;;) {
        if (Date.now() >= until) {
          ended = `the run has been active ${CAPS.activeHoursPerRun} hours, its cap`;
          await o.trail.step({ name: 'supervisor', action: 'stop', outcome: ended }, null);
          return null;
        }
        const f = o.scout.latest();
        if (!f) throw new Error('the Supervisor has no frame to look at');
        if (asked !== null)
          steps.push(
            `${steps.length + 1}. ${asked}: ${report ?? ''} (frame ${f.ref ?? 'not kept'})`,
          );
        const said = await turn(o.agent, {
          system: SYSTEM,
          say: [
            `Goal: ${o.goal}`,
            ...(o.knowledge ? [`What memory knows, best first:\n${o.knowledge}`] : []),
            `Steps so far:\n${steps.join('\n') || '(none)'}`,
            `Latest frame, ${f.ref ?? 'not kept'}:\n${JSON.stringify(f.view)}`,
          ].join('\n\n'),
          image: f.image,
          tools,
          calls: tools.length ? QUERIES + 1 : undefined,
          answer: ANSWER_SCHEMA,
          maxTokens: 16_000,
        });
        const a = readAnswer(said.text, (r) => o.trail.has(r));
        if (typeof a === 'string') {
          unreadable++;
          await o.trail.step(
            { name: 'supervisor', action: 'wait', outcome: `unreadable: ${a}` },
            null,
          );
          if (unreadable >= UNREADABLE_IN_A_ROW) {
            ended = `${UNREADABLE_IN_A_ROW} unreadable answers in a row`;
            return null;
          }
        } else {
          unreadable = 0;
          await o.trail.step(
            {
              name: 'supervisor',
              action: mask(a.next),
              outcome: mask(`${a.reason} [${a.frames.join(', ')}]`),
            },
            null,
          );
          if (a.next === 'stop') {
            ended = a.reason;
            return null;
          }
          if (a.next !== 'wait') {
            repeats = a.next === asked ? repeats + 1 : 1;
            if (repeats >= STALL) {
              ended = `the same step ${STALL} times in a row: no progress`;
              return null;
            }
            const content = JSON.stringify(f.view);
            const on = (stepsOn.get(content) ?? 0) + 1;
            stepsOn.set(content, on);
            if (on > STALL) {
              ended = `${STALL} steps on the same page already: no progress`;
              return null;
            }
            asked = a.next;
            return a.next;
          }
        }
        // Waiting is the Scout's wait, which leaves a new frame; no model is asked.
        asked = 'wait';
        report = (await o.scout.call('scout', 'browser_wait', { seconds: 1 })).text.split('\n')[0]!;
      }
    },
  };
}

/** The Supervisor and the Scout toward one goal, until the goal's page or a stop. */
export async function runGoal(o: {
  scoutAgent: Agent;
  supervisorAgent: Agent;
  scout: Scout;
  trail: Trail;
  goal: Goal;
  /** The member whose accounts the goal is on. */
  member: string;
  conversation?: Conversation;
  startedAt?: Date;
  /** The knowledge pack, as the Supervisor reads it. */
  knowledge?: string;
  /** Memory's tools, given to each role that may call them. */
  tools?: Tool[];
}): Promise<{ conversation: Conversation; ended: string | null }> {
  o.scout.onTransferPath(o.goal === 'transfer');
  if (!o.scout.latest()) await o.scout.call('scout', 'browser_open', {});
  const s = supervisor({
    agent: o.supervisorAgent,
    scout: o.scout,
    trail: o.trail,
    goal: GOALS[o.goal](o.member),
    startedAt: o.startedAt,
    knowledge: o.knowledge,
    tools: o.tools,
  });
  const conversation = await runScout({
    agent: o.scoutAgent,
    scout: o.scout,
    supervisor: s,
    trail: o.trail,
    conversation: o.conversation,
    extra: o.tools,
  });
  return { conversation, ended: s.ended() };
}
