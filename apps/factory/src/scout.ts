// The Scout (plan, §M.2): it navigates, one simple step at a time, as the Supervisor directs, and
// every page it reaches is a frame. Its tools (§M.4) work over our own browser: they open only the
// run's hosts, act by control reference from the screen model, press keys from a fixed set, never
// type a secret as text, and never run script in a page. The server types a credential and a
// person's code; the model never sees either.
import type Anthropic from '@anthropic-ai/sdk';
import type { BetaRunnableTool } from '@anthropic-ai/sdk/lib/tools/BetaRunnableTool';
import { ToolError } from '@anthropic-ai/sdk/lib/tools/ToolError';
import type { Frame } from '@gb/evidence';
import {
  ActError,
  type Box,
  click,
  type Control,
  type Page,
  press,
  type ScreenModel,
  SPECIAL_KEYS,
  type,
  waitFullyRendered,
} from '@gb/screen';
import { z } from 'zod';
import { CAPS } from './caps.js';
import { ROLES, type Role } from './models.js';
import { refusal } from './tools.js';
import type { Trail } from './trail.js';

export interface ScoutDeps {
  /** A page of a browser launched with `hosts`, so nothing the page does reaches another host. */
  page: Page;
  /** The bank's start page. */
  start: string;
  /** The hosts (host and port) the run may reach: the bank's own, and nothing a model proposes. */
  hosts: string[];
  trail: Trail;
  /** The staff service account; typed by the server, masked in every frame. */
  credentials: { operatorId: string; password: string };
  /** A person's code, once the bank has sent one. */
  code(): Promise<string>;
}

type Result = string | Anthropic.Beta.Messages.BetaToolResultContentBlockParam[];

/** A call the Scout may not make; the model is told why. */
class Refused extends Error {}

// The bank says it sent a code, or asks for one from the authenticator app.
const CODE_SENT =
  /\bcode (we|was|has been) sent\b|\bsent (you )?a code\b|\bcode from your authenticator\b/i;

const ref = z
  .string()
  .regex(/^c\d{1,4}$/)
  .describe('A control reference from the latest page, such as c3');

const inside = (b: Box, a: Box) =>
  b.x >= a.x && b.y >= a.y && b.x + b.w <= a.x + a.w && b.y + b.h <= a.y + a.h;

/** The frame as the model reads it: the masked page, its controls by reference, its text. */
function view(f: Frame, m: ScreenModel) {
  return {
    page: `${f.host}${f.path}`,
    title: f.model.title,
    controls: f.model.controls.map((c) => ({
      ref: c.ref,
      role: c.role,
      name: c.name,
      ...(c.enabled ? {} : { enabled: false }),
      ...(c.checked !== undefined ? { checked: c.checked } : {}),
      ...(c.hasValue ? { hasValue: true } : {}),
      ...(c.selected ? { selected: c.selected } : {}),
    })),
    // Text the page itself animates (a marquee) moves from one reading to the next.
    texts: f.model.texts
      .filter((t) => !m.animated.some((a) => inside(t.box, a)))
      .map((t) => t.text),
    ...(f.withheld ? { withheld: f.withheld } : {}),
  };
}

export function scout(deps: ScoutDeps) {
  const { page, trail } = deps;
  const known = trail.policy.known;
  known.push(deps.credentials.operatorId, deps.credentials.password);
  let last: ScreenModel | null = null;
  let signIns = 0;
  // Where the list of refused requests stood when the current call began.
  let mark = 0;

  const control = (r: string): Control => {
    const c = last?.controls.find((x) => x.ref === r);
    if (!c) throw new Refused(`there is no control ${r} on the latest page; look again`);
    return c;
  };

  /** After an action: the page once it is drawn, recorded as a step with its frame. */
  async function see(name: string, action: string, picture = false): Promise<Result> {
    let r = await waitFullyRendered(page, { limitMs: 60_000 });
    let did = action;
    if (r.dialog) {
      await page.answerDialog(false);
      did += `; a dialog opened and was answered with Cancel`;
      r = await waitFullyRendered(page, { limitMs: 60_000 });
    }
    last = r.model;
    const left = page.refused.slice(mark).filter((x) => x.document);
    for (const x of left)
      await trail.step(
        { name: 'refused', action: `open ${x.host}`, outcome: `${x.host} is not on the allowlist` },
        null,
      );
    if (left.length)
      did += `; the page tried to open ${left[0]!.host}, which is not on the allowlist, and was stopped`;
    const f = await trail.step({ name, action: did }, r.model);
    const text = `${did}.\n${JSON.stringify(view(f!, r.model))}`;
    if (!picture || !f!.image) return text;
    return [
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: f!.image.toString('base64') },
      },
      { type: 'text', text },
    ];
  }

  const tools = {
    browser_open: {
      description:
        "Opens a page of the bank being learned: its start page, or a path on the bank's own site. The host is set by the run; no other site can be opened.",
      input: z.object({
        path: z
          .string()
          .max(300)
          .optional()
          .describe('A path on the bank’s site, such as /corelink/'),
      }),
      async run({ path }: { path?: string }) {
        const url = new URL(path ?? deps.start, deps.start);
        if (!/^https?:$/.test(url.protocol) || !deps.hosts.includes(url.host))
          throw new Refused(`${url.host || url.protocol} is not on the allowlist`);
        await page.goto(url.href).catch((e: Error) => {
          throw new ActError(e.message);
        });
        return see('open', `opened ${url.pathname}`);
      },
    },
    browser_look: {
      description: 'Shows the current page: its masked picture and its controls and text.',
      input: z.object({}),
      run: () => see('look', 'looked at the page', true),
    },
    browser_click: {
      description: 'Clicks a control on the latest page, by its reference.',
      input: z.object({ ref }),
      async run(i: { ref: string }) {
        const c = control(i.ref);
        await click(page, c);
        return see('click', `clicked the ${c.role} ${c.ref}`);
      },
    },
    browser_type: {
      description:
        'Types text into a field, by its reference, replacing what it holds. Never a credential or a code: those have their own tools.',
      input: z.object({ ref, text: z.string().min(1).max(100) }),
      async run(i: { ref: string; text: string }) {
        const c = control(i.ref);
        if (c.role !== 'textbox') throw new Refused(`${c.ref} is a ${c.role}, not a text field`);
        const lower = i.text.toLowerCase();
        if (known.some((k) => k.length >= 2 && lower.includes(k.toLowerCase())))
          throw new Refused(
            'that text holds a secret; a credential is typed with browser_type_credential',
          );
        await type(page, c, i.text);
        return see('type', `typed ${i.text.length} characters into ${c.ref}`);
      },
    },
    browser_press: {
      description: 'Presses one key, from a fixed set, in whatever has the focus.',
      input: z.object({ key: z.enum(SPECIAL_KEYS) }),
      async run(i: { key: (typeof SPECIAL_KEYS)[number] }) {
        await press(page, i.key);
        await page.settle();
        return see('press', `pressed ${i.key}`);
      },
    },
    browser_wait: {
      description: 'Waits at least the given seconds, then until the page has finished drawing.',
      input: z.object({ seconds: z.number().int().min(1).max(30).optional() }),
      async run(i: { seconds?: number }) {
        await new Promise((r) => setTimeout(r, (i.seconds ?? 1) * 1000));
        return see('wait', `waited ${i.seconds ?? 1} s`);
      },
    },
    browser_type_credential: {
      description:
        "Types the staff service account's user ID or password into a field, by its reference. The server types the value; it is never shown.",
      input: z.object({ ref, credential: z.enum(['user_id', 'password']) }),
      async run(i: { ref: string; credential: 'user_id' | 'password' }) {
        const c = control(i.ref);
        const want = i.credential === 'password' ? 'password' : 'textbox';
        if (c.role !== want)
          throw new Refused(
            `the ${i.credential.replace('_', ' ')} goes into a ${want} field, and ${c.ref} is a ${c.role}`,
          );
        if (i.credential === 'password' && signIns++ >= CAPS.liveSignInsPerRun)
          throw new Refused(`the run has signed in ${CAPS.liveSignInsPerRun} times, its limit`);
        const { operatorId, password } = deps.credentials;
        await type(page, c, i.credential === 'password' ? password : operatorId);
        return see('type credential', `typed the ${i.credential.replace('_', ' ')} into ${c.ref}`);
      },
    },
    browser_enter_code: {
      description:
        'Types the code a person gives into a field, by its reference, once the bank shows it sent a code. The code is never shown.',
      input: z.object({ ref }),
      async run(i: { ref: string }) {
        if (!last?.texts.some((t) => CODE_SENT.test(t.text)))
          throw new Refused('the bank has not shown that it sent a code');
        const c = control(i.ref);
        if (c.role !== 'textbox') throw new Refused(`${c.ref} is a ${c.role}, not a text field`);
        const code = (await deps.code()).trim();
        if (!/^\d{4,10}$/.test(code)) throw new Refused('the person gave no code');
        known.push(code);
        await type(page, c, code);
        return see('enter code', `typed the code a person gave into ${c.ref}`);
      },
    },
  } satisfies Record<
    string,
    { description: string; input: z.ZodType; run(i: never): Promise<Result> }
  >;

  type Name = keyof typeof tools;
  const isTool = (n: string): n is Name => Object.hasOwn(tools, n);

  /** Every call: the role's list first, then the input, then the tool. A refusal is recorded. */
  async function call(role: Role, name: string, input: unknown): Promise<Result> {
    const refuse = async (why: string): Promise<never> => {
      await trail.step({ name: 'refused', action: name, outcome: why }, null);
      throw new ToolError(why);
    };
    const no = refusal(role, name) ?? (isTool(name) ? null : `there is no tool ${name}`);
    if (no) return refuse(no);
    const tool = tools[name as Name];
    const parsed = tool.input.safeParse(input);
    if (!parsed.success)
      return refuse(`the input does not fit ${name}: ${z.prettifyError(parsed.error)}`);
    mark = page.refused.length;
    try {
      return await (tool.run as (i: unknown) => Promise<Result>)(parsed.data);
    } catch (e) {
      if (e instanceof Refused) return refuse(e.message);
      // The page did not do what was asked (a control gone, a key outside the set): the model is told.
      if (e instanceof ActError) {
        await trail.step({ name, outcome: e.message }, null);
        throw new ToolError(e.message);
      }
      throw e;
    }
  }

  /** The role's tools, for the SDK's tool runner; each call goes through `call`. */
  function runnable(role: Role): BetaRunnableTool[] {
    return Object.entries(tools)
      .filter(([n]) => refusal(role, n) === null)
      .map(([n, t]) => {
        const { $schema: _s, ...schema } = z.toJSONSchema(t.input) as Record<string, unknown>;
        return {
          type: 'custom',
          name: n,
          description: t.description,
          input_schema: schema as Anthropic.Beta.Messages.BetaTool.InputSchema,
          parse: (x: unknown) => x,
          run: (x: unknown) => call(role, n, x),
        };
      });
  }

  return { call, runnable };
}

export type Scout = ReturnType<typeof scout>;

/** Who tells the Scout its next step: the Supervisor. Null is stop. */
export interface Supervisor {
  next(report: string | null): Promise<string | null>;
}

const SYSTEM = `You are the Scout. You drive one browser at a bank's staff console, one simple step at a time, as the Supervisor directs.

Do only the step you are given, with the fewest tool calls, then reply in one or two sentences: what you did and what page you are on now. Every tool returns the page after it: its controls, each with a reference such as c3, and its text. Act on controls by those references.

You never see credentials or codes. Type the user ID or password with browser_type_credential, and a code the bank sent with browser_enter_code. If a step cannot be done, say why and stop.`;

/**
 * The Scout as a model loop, through the gateway: each instruction from the Supervisor is one
 * run of the SDK's tool runner over the Scout's tools, at most CAPS.scoutTurns model calls, in one
 * conversation for the whole run.
 */
export async function runScout(o: {
  client: Anthropic;
  scout: Scout;
  supervisor: Supervisor;
  trail: Trail;
}): Promise<Anthropic.Beta.Messages.BetaMessageParam[]> {
  const tools = o.scout.runnable('scout');
  const offered = new Set(tools.map((t) => t.name));
  let messages: Anthropic.Beta.Messages.BetaMessageParam[] = [];
  let report: string | null = null;
  for (;;) {
    const instruction = await o.supervisor.next(report);
    if (instruction === null) return messages;
    const runner = o.client.beta.messages.toolRunner({
      model: ROLES.scout.model,
      max_tokens: 8000,
      system: SYSTEM,
      tools,
      messages: [...messages, { role: 'user', content: instruction }],
      max_iterations: CAPS.scoutTurns,
    });
    for await (const m of runner)
      for (const b of m.content)
        // The runner answers a tool it was not given as not found; it is refused all the same.
        if (b.type === 'tool_use' && !offered.has(b.name))
          await o.trail.step(
            {
              name: 'refused',
              action: b.name,
              outcome: `${b.name} is not one of the scout's tools`,
            },
            null,
          );
    const answer = await runner.done();
    messages = [...runner.params.messages];
    report = answer.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n');
  }
}
