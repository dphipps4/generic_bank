// The Scout (plan, §M.2): it navigates, one simple step at a time, as the Supervisor directs, and
// every page it reaches is a frame. Its tools (§M.4) work over our own browser: they open only the
// run's hosts, act by control reference from the screen model, press keys from a fixed set, never
// type a secret as text, and never run script in a page. The server types a credential and a
// person's code; the model never sees either. It never presses the bank's submit for a transfer
// (on the transfer path, no control named with a money word at all), and never clicks a picture no
// one has named (§E.1).
import { maskText } from '@gb/evidence';
import {
  ActError,
  type Box,
  choose,
  click,
  type Control,
  type KnownPicture,
  namePictures,
  normalize,
  type Page,
  press,
  type ScreenModel,
  SPECIAL_KEYS,
  type,
  waitFullyRendered,
} from '@gb/screen';
import { z } from 'zod';
import { type Agent, type Conversation, turn } from './agent.js';
import { CAPS } from './caps.js';
import type { Role } from './models.js';
import { refusal, type Tool, ToolRefusal, type ToolResult } from './tools.js';
import type { Seen, Trail } from './trail.js';

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
  /** The bank's submit for a transfer, in the profile's words, if there is a profile. */
  never: string[];
  /** The profile's named pictures of text; any other picture stays unnamed. */
  pictures?: KnownPicture[];
}

/** The latest page as the Scout last read it, for the Supervisor. */
export interface Latest {
  ref: string | null;
  image: Buffer | null;
  /** The page as the model reads it. */
  view: ReturnType<typeof view>;
}

// Words that move money, for every bank, on the transfer path. "Continue" only reaches the review,
// and "Send" alone is the bank sending a code.
const MONEY =
  /\b(confirm|submit|send\s+(money|payment|funds|transfer)|pay|authori[sz]e|approve|transfer\s+now)\b/i;

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
function view(f: Seen, m: ScreenModel, mask: (s: string) => string) {
  return {
    page: `${f.host}${f.path}`,
    title: f.model.title,
    controls: f.model.controls.map((c) => {
      // A list's options are read, masked, from the live page: a closed list shows only its choice.
      const options = m.controls.find((x) => x.ref === c.ref)?.options;
      return {
        ref: c.ref,
        role: c.role,
        name: c.name,
        ...(c.enabled ? {} : { enabled: false }),
        ...(c.checked !== undefined ? { checked: c.checked } : {}),
        ...(c.hasValue ? { hasValue: true } : {}),
        ...(c.selected ? { selected: c.selected } : {}),
        ...(options ? { options: options.map(mask) } : {}),
      };
    }),
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
  let latest: Latest | null = null;
  let signIns = 0;
  let transferPath = false;
  // Where the list of refused requests stood when the current call began.
  let mark = 0;

  const control = (r: string): Control => {
    const c = last?.controls.find((x) => x.ref === r);
    if (!c) throw new ToolRefusal(`there is no control ${r} on the latest page; look again`);
    return c;
  };
  const submits = (c: Control) =>
    deps.never.some((w) => normalize(c.name).includes(normalize(w))) ||
    (transferPath && MONEY.test(c.name));
  const unnamed = (c: Control) => (c.role === 'image' || c.role === 'image-button') && !c.name;

  /** After an action: the page once it is drawn, recorded as a step with its frame. */
  async function see(name: string, action: string, picture = false): Promise<ToolResult> {
    let r = await waitFullyRendered(page, { limitMs: 60_000 });
    let did = action;
    if (r.dialog) {
      await page.answerDialog(false);
      did += `; a dialog opened and was answered with Cancel`;
      r = await waitFullyRendered(page, { limitMs: 60_000 });
    }
    const model = namePictures(r.model, deps.pictures ?? []);
    last = model;
    const left = page.refused.slice(mark).filter((x) => x.document);
    for (const x of left)
      await trail.step(
        { name: 'refused', action: `open ${x.host}`, outcome: `${x.host} is not on the allowlist` },
        null,
      );
    if (left.length)
      did += `; the page tried to open ${left[0]!.host}, which is not on the allowlist, and was stopped`;
    const f = (await trail.step({ name, action: did }, model))!;
    const v = view(f, model, (s) => maskText(s, trail.policy));
    latest = { ref: f.ref, image: f.image, view: v };
    const text = `${did}.\n${JSON.stringify(v)}`;
    return picture && f.image ? { text, image: f.image } : { text };
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
          throw new ToolRefusal(`${url.host || url.protocol} is not on the allowlist`);
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
        if (submits(c))
          throw new ToolRefusal(
            `${c.ref} could move money; the factory stops at the transfer's review page`,
          );
        if (unnamed(c))
          throw new ToolRefusal(
            `${c.ref} is a picture no one has named, and an unnamed picture is never clicked`,
          );
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
        if (c.role !== 'textbox')
          throw new ToolRefusal(`${c.ref} is a ${c.role}, not a text field`);
        const lower = i.text.toLowerCase();
        if (known.some((k) => k.length >= 2 && lower.includes(k.toLowerCase())))
          throw new ToolRefusal(
            'that text holds a secret; a credential is typed with browser_type_credential',
          );
        await type(page, c, i.text);
        return see('type', `typed ${i.text.length} characters into ${c.ref}`);
      },
    },
    browser_choose: {
      description:
        'Chooses an option in a list, by the list’s reference and the option’s position.',
      input: z.object({
        ref,
        option: z.number().int().min(1).max(100).describe('The option’s position, from 1'),
      }),
      async run(i: { ref: string; option: number }) {
        const c = control(i.ref);
        const want = c.options?.[i.option - 1];
        if (!c.options) throw new ToolRefusal(`${c.ref} is a ${c.role}, not a list`);
        if (want === undefined)
          throw new ToolRefusal(`${c.ref} has ${c.options.length} options, not ${i.option}`);
        await choose(page, c, (o) => o === want);
        return see('choose', `chose option ${i.option} in ${c.ref}`);
      },
    },
    browser_press: {
      description: 'Presses one key, from a fixed set, in whatever has the focus.',
      input: z.object({ key: z.enum(SPECIAL_KEYS) }),
      async run(i: { key: (typeof SPECIAL_KEYS)[number] }) {
        // Enter on a page with the bank's submit, or an unnamed picture button, could press it.
        if (i.key === 'Enter' && last?.controls.some(submits))
          throw new ToolRefusal(
            "Enter is not pressed on a page with a control that could move money; the factory stops at the transfer's review page",
          );
        if (
          i.key === 'Enter' &&
          last?.controls.some((c) => c.role === 'image-button' && unnamed(c))
        )
          throw new ToolRefusal(
            'Enter is not pressed on a page with a picture button no one has named; it could press it',
          );
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
          throw new ToolRefusal(
            `the ${i.credential.replace('_', ' ')} goes into a ${want} field, and ${c.ref} is a ${c.role}`,
          );
        if (i.credential === 'password' && signIns++ >= CAPS.liveSignInsPerRun)
          throw new ToolRefusal(`the run has signed in ${CAPS.liveSignInsPerRun} times, its limit`);
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
          throw new ToolRefusal('the bank has not shown that it sent a code');
        const c = control(i.ref);
        if (c.role !== 'textbox')
          throw new ToolRefusal(`${c.ref} is a ${c.role}, not a text field`);
        const code = (await deps.code()).trim();
        if (!/^\d{4,10}$/.test(code)) throw new ToolRefusal('the person gave no code');
        known.push(code);
        await type(page, c, code);
        return see('enter code', `typed the code a person gave into ${c.ref}`);
      },
    },
  } satisfies Record<
    string,
    { description: string; input: z.ZodType; run(i: never): Promise<ToolResult> }
  >;

  type Name = keyof typeof tools;
  const isTool = (n: string): n is Name => Object.hasOwn(tools, n);

  /** Every call: the role's list first, then the input, then the tool. A refusal is recorded. */
  async function call(role: Role, name: string, input: unknown): Promise<ToolResult> {
    const refuse = async (why: string): Promise<never> => {
      await trail.step({ name: 'refused', action: name, outcome: why }, null);
      throw new ToolRefusal(why);
    };
    const no = refusal(role, name) ?? (isTool(name) ? null : `there is no tool ${name}`);
    if (no) return refuse(no);
    const tool = tools[name as Name];
    const parsed = tool.input.safeParse(input);
    if (!parsed.success)
      return refuse(`the input does not fit ${name}: ${z.prettifyError(parsed.error)}`);
    mark = page.refused.length;
    try {
      return await (tool.run as (i: unknown) => Promise<ToolResult>)(parsed.data);
    } catch (e) {
      if (e instanceof ToolRefusal) return refuse(e.message);
      // The page did not do what was asked (a control gone, a key outside the set): the model is told.
      if (e instanceof ActError) {
        await trail.step({ name, outcome: e.message }, null);
        throw new ToolRefusal(e.message);
      }
      throw e;
    }
  }

  /** The role's tools, each call going through `call`. */
  function toolsFor(role: Role): Tool[] {
    return Object.entries(tools)
      .filter(([n]) => refusal(role, n) === null)
      .map(([n, t]) => ({
        name: n,
        description: t.description,
        input: t.input,
        run: (x: unknown) => call(role, n, x),
      }));
  }

  return {
    call,
    tools: toolsFor,
    latest: () => latest,
    /** On the transfer path, every control named with a money word is refused. */
    onTransferPath(on: boolean) {
      transferPath = on;
    },
  };
}

export type Scout = ReturnType<typeof scout>;

/** Who tells the Scout its next step: the Supervisor. Null is stop. */
export interface Supervisor {
  next(report: string | null): Promise<string | null>;
}

const SYSTEM = `You are the Scout. You drive one browser at a bank's staff console, one simple step at a time, as the Supervisor directs.

Do only the step you are given, with the fewest tool calls, then reply in one or two sentences: what you did and what page you are on now. Every tool returns the page after it: its controls, each with a reference such as c3, and its text. Act on controls by those references; choose in a list by the option's position.

You never see credentials or codes. Type the user ID or password with browser_type_credential, and a code the bank sent with browser_enter_code. If a step cannot be done, say why and stop.`;

/**
 * The Scout's side of a run: each instruction from the Supervisor is one turn of the Scout's model
 * over its tools, at most CAPS.scoutTurns model calls, in one conversation for the whole run.
 */
export async function runScout(o: {
  agent: Agent;
  scout: Scout;
  supervisor: Supervisor;
  trail: Trail;
  conversation?: Conversation;
}): Promise<Conversation> {
  const tools = o.scout.tools('scout');
  const offered = new Set(tools.map((t) => t.name));
  let conversation = o.conversation ?? [];
  let report: string | null = null;
  for (;;) {
    const instruction = await o.supervisor.next(report);
    if (instruction === null) return conversation;
    // The Scout starts each step on the page as it last read it.
    const now = o.scout.latest();
    const t = await turn(o.agent, {
      system: SYSTEM,
      conversation,
      say: now ? `${instruction}\n\nThe page now:\n${JSON.stringify(now.view)}` : instruction,
      tools,
      calls: CAPS.scoutTurns,
      maxTokens: 8000,
    });
    // A call pi turned away before the tool (one the Scout was not given, or input that does not
    // fit) is refused all the same.
    for (const r of t.refused)
      await o.trail.step(
        {
          name: 'refused',
          action: r.name,
          outcome: offered.has(r.name) ? r.why : `${r.name} is not one of the scout's tools`,
        },
        null,
      );
    conversation = t.conversation;
    report = t.text;
  }
}
