// The Scout's tools (prompts, part 2, §3). The Scout works the site in one live browser, as a teller
// would, and writes the crawler: code and data that do the task with no reasoning. Every tool
// returns the page once it is ready: its masked picture, its visible controls (each with an id and a
// box), and its words. It acts on one control at a time, by its id or by a position read from the
// picture. It never sees a secret: the server types the sign-in and a person's code. It never presses
// a control that could send money. A tool refuses only for safety and timing, never for what the
// Scout says about a page: what is true is decided by trying the crawler.
import {
  checkBalance,
  inHistory,
  isWritten,
  leaf,
  leaves,
  lint,
  load,
  nameBeside,
  partsOf,
  signInWritten,
  prepareTransfer,
  type Session,
  type Written,
} from '@gb/crawler';
import { decideWritten, GuardError } from '@gb/guardrails';
import {
  type Box,
  type Browser,
  chooseAt,
  choose,
  clickAt,
  control,
  type Control,
  cropOf,
  field,
  type Frame,
  maskText,
  newPage,
  NotReady,
  type Page,
  press,
  see,
  TargetError,
  type,
  typeAt,
} from '@gb/runtime';
import { z } from 'zod';
import type { Role } from './models.js';
import { refusal, type Tool, ToolRefusal, type ToolResult } from './tools.js';
import type { Trail } from './trail.js';

/** The parts a crawler does, each tried on its own. */
export const PARTS = ['balance', 'transfer', 'history'] as const;
export type Part = (typeof PARTS)[number];
/** What may be tried: each part, and sign-in on its own, as soon as it is written. */
export const TRY_PARTS = ['signin', ...PARTS] as const;
export type TryPart = (typeof TRY_PARTS)[number];

/** What the crawler is for: the task's values, as a teller is given them. */
export interface Task {
  member: string;
  from: string;
  to: string;
  amountCents: number;
  memo: string;
}

export interface ScoutDeps {
  page: Page;
  /** For a try that starts from nothing: a browser with no cookies of this run. */
  browser?: Browser;
  /** The site's start page; only its host is ever opened. */
  start: string;
  trail: Trail;
  credentials: { operatorId: string; password: string };
  /** A person's code, once the site has sent one. */
  code(): Promise<string>;
  /** The Supervisor's judgment of each action, before the next. */
  judge(j: Judging): Promise<Judgment>;
  /** A crawler to start from: the broken one, for a repair. */
  crawler?: Written;
}

export interface Judging {
  action: string;
  why: string;
  frame: Frame;
  ref: string | null;
  /** Every call the Scout made since the last judgment, in order, failures included. */
  record: Entry[];
  /** The crawler as written, when the action wrote it, tried it, or declared it ready. */
  crawler?: string;
  /** What each part's latest try of this version did. */
  tried?: string;
  /** A try's last page, where it stopped: the Supervisor reads it before it diagnoses. */
  tryFrame?: { ref: string | null; frame: Frame };
  /** At "crawler ready": the Supervisor checks the crawler against the evidence before it counts. */
  checking?: boolean;
}

/** One call of the Scout's, as the Supervisor sees it: what it asked, and what came back. */
export interface Entry {
  tool: string;
  input: unknown;
  result?: string;
  error?: string;
  /** A close-up of what the Scout acted on, taken after it acted. */
  image?: Buffer;
}

export interface Judgment {
  verdict: 'continue' | 'wait' | 'stop' | 'end';
  says: string;
  extendSeconds?: number;
}

const centre = (b: Box) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
const within = (p: { x: number; y: number }, b: Box) =>
  p.x >= b.x && p.y >= b.y && p.x <= b.x + b.w && p.y <= b.y + b.h;
const wordsOf = (f: Frame) =>
  f.tree
    .split('\n')
    .map(leaf)
    .filter((t): t is string => !!t);

/** What the crawler must define, said once for the Scout and the Supervisor. */
export const CONTRACT = `The crawler is plain JavaScript that defines:
- async function signIn(site, task): from wherever the site starts, reach a signed-in page (optional; tried on its own as "signin");
- async function balance(site, task): reach the member's balances and return { account, available, current }, as the page draws them, for the account task.from names;
- async function transfer(site, task): fill in a transfer of task.amount from task.from to task.to with task.memo, and stop on its review page;
- async function review(site, task): read the review page and return { from, to, amount, memo }, as drawn;
- async function history(site, task): reach the activity of the account task.from names;
- function name(lines, member): where the member's name shows, return it as drawn, or null; it is hidden from then on;
- const send: the control on the review page that would send the transfer, by name or { x, y }. It is never pressed by the factory.
Write it in parts as you go: a crawler being written may lack parts; each try needs its own part, and the crawler is ready only with all of them. Helper functions of your own are fine. task holds member, from, to, amount and memo; read values from it, never write them in.
It acts only through site, and every site call but stop returns a promise: always await it.
- await site.open(path?) opens the start page;
- const { lines, controls } = await site.look(): the page's text lines, every frame's, and its controls, each { role, name, box };
- if (await site.shows('words')) …: whether a line holds those words;
- await site.press(target), await site.type(target, value), await site.choose(target, 'from' | 'to');
- await site.wait(seconds);
- site.stop(code, why) ends with the site's own answer (no_such_member, insufficient_funds, ...).
A target is a control's drawn name ("Find"), { name, near } when two share a name, { field: n } for the n-th visible field (from 0), or { x, y }.
A value to type is named, never written: user_id, password, code, member, amount, memo.
Start each part from await site.open(): the page may be the sign-in, a page asking for a code, or one already signed in; read it and act on what it shows.`;

export function scout(deps: ScoutDeps, task: Task) {
  const { page, trail } = deps;
  const known = trail.known;
  let source: string | null = deps.crawler?.source ?? null;
  /** The member's name has been read beside their number, and is hidden from then on. */
  let named = false;
  /** Each part's latest try of the crawler as written now. */
  let tried: Partial<Record<TryPart, { ok: boolean; said: string }>> = {};
  let latest: { frame: Frame; ref: string | null; controls: Control[] } | null = null;
  let waiting = false;
  let stopped = false;
  let record: Entry[] = [];
  let current: Entry | null = null;
  let closeUp: Box | null = null;

  const taken = () => {
    const r = record;
    record = [];
    return r;
  };
  const triedText = () =>
    TRY_PARTS.map(
      (p) =>
        `${p}: ${tried[p] ? `${tried[p]!.ok ? 'passed' : 'failed'}, ${tried[p]!.said}` : 'not tried'}`,
    ).join('\n');

  /** The crawler's own `name`, on a page's real lines: the member's name, hidden from then on. */
  /** The member's name, read from the page now by the crawler's own name: true when it is new. */
  const learnName = async (): Promise<boolean> => {
    if (!source) return false;
    try {
      // Every frame's lines, as the crawler reads them: a console in frames shows nothing at its top.
      const lines = await leaves(page);
      const n = nameBeside(
        lines,
        task.member,
        load(source, { partial: true }).name?.(lines, task.member),
      );
      if (n && !known.includes(n)) {
        named = true;
        known.push(n);
        await trail.remask();
        return true;
      }
    } catch {
      // A crawler whose name fails hides nothing new; its tries say why.
    }
    return false;
  };

  /**
   * Before an action: stopped refuses it; after a "wait", the page is looked at first (kept, not
   * judged again) and the action goes on, rather than being refused for want of a look.
   */
  const mayAct = async () => {
    if (stopped) throw new ToolRefusal('the Supervisor stopped this goal');
    if (!waiting) return;
    waiting = false;
    const o = { known, limitMs: 15_000, everyMs: 150 };
    let f = await see(page, o).catch(() => null);
    if (!f) return;
    if (await learnName()) f = await see(page, o);
    const k = await trail.step(
      { name: 'scout', action: 'looked first, as the Supervisor said wait' },
      f,
    );
    latest = {
      frame: f,
      ref: k?.ref ?? null,
      controls: f.controls.filter((c) => c.name || c.role !== 'link'),
    };
  };

  /** After an action: the page once ready, a step in the trail, the Supervisor's judgment. */
  async function look(
    action: string,
    why: string,
    extra: Partial<Judging> = {},
  ): Promise<ToolResult> {
    let f: Frame;
    try {
      // The page once ready; then its member's name, and the page again if the name was new.
      const o = { known, limitMs: 15_000, everyMs: 150 };
      f = await see(page, o);
      if (await learnName()) f = await see(page, o);
    } catch (e) {
      if (!(e instanceof NotReady)) throw e;
      await trail.step({ name: 'not ready', action, outcome: e.message }, null);
      return { text: `${action}. The page never became ready: ${e.message}` };
    }
    const asked = current ? ` · input ${maskText(JSON.stringify(current.input), known)}` : '';
    // A page showing the member's number before their name is hidden could show the name: its frame
    // is kept once the crawler's `name` has hidden it.
    const unhidden = !named && f.tree.includes(maskText(task.member, known));
    const seen = await trail.step(
      {
        name: 'scout',
        action: `${action} (${why})${asked}${unhidden ? " · not kept until the crawler's name hides the member's name" : ''}`,
      },
      unhidden ? null : f,
    );
    const ref = seen?.ref ?? null;
    const controls = f.controls.filter((c) => c.name || c.role !== 'link');
    latest = { frame: f, ref, controls };
    if (current && closeUp) current.image = cropOf(f.picture, closeUp);
    closeUp = null;
    const j =
      action === 'looked'
        ? null
        : await deps.judge({ action, why, frame: f, ref, record: taken(), ...extra });
    if (j?.verdict === 'stop') stopped = true;
    waiting = j?.verdict === 'wait';
    const view = {
      frame: ref,
      controls: controls.map((c, i) => ({
        id: `c${i + 1}`,
        role: c.role,
        name: c.name,
        box: c.box,
      })),
      words: wordsOf(f),
      ...(f.dialogs.length ? { dialogs: f.dialogs } : {}),
    };
    const said = j ? `\nThe Supervisor: ${j.verdict}. ${j.says}` : '';
    return { text: `${action}.${said}\n${JSON.stringify(view)}`, image: f.picture };
  }

  /** The control an action names: by id, or the one a position in the picture lands on. */
  const chosen = (i: { id?: string; x?: number; y?: number }): Control => {
    if (!latest) throw new ToolRefusal('look at the page first');
    if (i.id) {
      const c = latest.controls[Number(i.id.slice(1)) - 1];
      if (!c) throw new ToolRefusal(`there is no ${i.id} on the latest page`);
      return c;
    }
    if (i.x !== undefined && i.y !== undefined) {
      const c = latest.controls.find((x) => within({ x: i.x!, y: i.y! }, x.box));
      if (!c) throw new ToolRefusal(`${i.x},${i.y} lands on no visible control`);
      return c;
    }
    throw new ToolRefusal('name a control by its id, or by a position on the picture');
  };
  const at = (found: Box, c: Control) =>
    within(centre(found), c.box) || within(centre(c.box), found);

  const valueOf = async (v: string) =>
    v === 'user_id'
      ? deps.credentials.operatorId
      : v === 'password'
        ? deps.credentials.password
        : v === 'code'
          ? (await deps.code()).trim()
          : v === 'member'
            ? task.member
            : v === 'amount'
              ? (task.amountCents / 100).toFixed(2)
              : task.memo;

  const which = z.object({
    id: z
      .string()
      .regex(/^c\d{1,3}$/)
      .optional()
      .describe('A control id from the latest page'),
    x: z.number().optional().describe('Or a position on the picture'),
    y: z.number().optional(),
    why: z.string().min(3).max(200).describe('One line: why this action'),
  });

  /** One try of one part of the crawler, live, with no model, in a page of its own. */
  async function tryPart(
    part: TryPart,
    cold: boolean,
  ): Promise<{
    ok: boolean;
    said: string;
    refs: string[];
    last: { ref: string | null; frame: Frame } | null;
  }> {
    if (!source) throw new ToolRefusal('write the crawler first');
    const has = partsOf(source);
    const needs = {
      signin: ['signIn'],
      balance: ['balance'],
      transfer: ['transfer', 'review'],
      history: ['history'],
    }[part];
    const lacking = needs.filter((n) => !has.includes(n as never));
    if (lacking.length)
      throw new ToolRefusal(`the crawler has no ${lacking.join(' or ')} yet: write it first`);
    if (cold && !deps.browser) throw new ToolRefusal('a try from nothing is not available here');
    const tryPage = cold ? await newPage(deps.browser!) : await page.context().newPage();
    const refs: string[] = [];
    let last: { ref: string | null; frame: Frame } | null = null;
    let withheld = false;
    const s: Session = {
      page: tryPage,
      url: deps.start,
      table: { kind: 'written', source, partial: true },
      named,
      known,
      limitMs: 20_000,
      guard: (a) => {
        const v = decideWritten(a.verb, a.control, {
          secrets: [deps.credentials.password],
          ...(a.typed !== undefined ? { typed: a.typed } : {}),
        });
        if (!v.allowed) throw new GuardError(v.layer, v.rule);
      },
      keep: async (seen, f) => {
        // As in the Scout's own view: a page showing the member's number is kept once their name is hidden.
        const hold = !s.named && f.tree.includes(maskText(task.member, known));
        withheld ||= hold;
        const k = await trail.step(
          {
            name: `try ${part}`,
            action: `${seen.did}${hold ? " · not kept until the crawler's name hides the member's name" : ''}`,
          },
          hold ? null : f,
        );
        if (k?.ref) refs.push(k.ref);
        last = { ref: k?.ref ?? null, frame: f };
      },
      credentials: async () => deps.credentials,
      code: deps.code,
    };
    const last4 = (a: string) => a.match(/\d{4}$/)?.[0] ?? a;
    const unnamed = () =>
      withheld && !s.named
        ? " Its name found no name beside the member's number, so pages showing that number were not kept."
        : '';
    try {
      if (part === 'signin') {
        const words = await signInWritten(s, { ...task });
        return {
          ok: true,
          said: `it reached a page showing: ${words.slice(0, 16).join(' · ')}${unnamed()}`,
          refs,
          last,
        };
      }
      if (part === 'balance') {
        const b = await checkBalance(s, { member: task.member, account: task.from });
        return {
          ok: true,
          said: `it read an amount of money for ${maskText(b.accountLabel, known)}${unnamed()}`,
          refs,
          last,
        };
      }
      if (part === 'transfer') {
        const r = await prepareTransfer(s, { ...task });
        const wrong = [
          ...(r.from.includes(last4(task.from)) ||
          r.from.toLowerCase().includes(task.from.toLowerCase())
            ? []
            : ['From']),
          ...(r.to.includes(last4(task.to)) || r.to.toLowerCase().includes(task.to.toLowerCase())
            ? []
            : ['To']),
          ...(r.amountCents === task.amountCents ? [] : ['Amount']),
          ...(r.memo.includes(task.memo) ? [] : ['Memo']),
        ];
        const read = maskText(`From "${r.from}", To "${r.to}", Memo "${r.memo}"`, known);
        return wrong.length
          ? {
              ok: false,
              said: `the review it read doesn't match the task in ${wrong.join(', ')}: ${read}${unnamed()}`,
              refs,
              last,
            }
          : {
              ok: true,
              said: `the review it read holds the task's accounts, amount and memo: ${read}${unnamed()}`,
              refs,
              last,
            };
      }
      const n = await inHistory(s, { ...task });
      return {
        ok: true,
        said: `it reached the account's activity (${n} lines hold this run's memo)${unnamed()}`,
        refs,
        last,
      };
    } catch (e) {
      // The try is over: what stopped it, a refusal of its own guard too, is what the Scout reads.
      return {
        ok: false,
        said: `${maskText(e instanceof Error ? e.message : String(e), known)}${unnamed()}`,
        refs,
        last,
      };
    } finally {
      if (s.named) named = true;
      await tryPage.close().catch(() => undefined);
    }
  }

  const tools = {
    browser_open: {
      description: "Opens the site's start page, or a path on its own host. Nothing else opens.",
      input: z.object({ path: z.string().max(200).optional() }),
      async run(i: { path?: string }) {
        await mayAct();
        const url = new URL(i.path ?? deps.start, deps.start);
        if (url.host !== new URL(deps.start).host)
          throw new ToolRefusal(`${url.host} is not the site being learned`);
        await page.goto(url.href);
        return look(`opened ${url.pathname}`, 'to start');
      },
    },
    browser_look: {
      description: 'Shows the page now: its picture, its controls with ids and boxes, its words.',
      input: z.object({}),
      run: async () => {
        waiting = false;
        return look('looked', 'to see the page');
      },
    },
    browser_wait: {
      description: 'Waits the given seconds, then shows the page.',
      input: z.object({ seconds: z.number().int().min(1).max(3) }),
      async run(i: { seconds: number }) {
        await new Promise((r) => setTimeout(r, i.seconds * 1000));
        waiting = false;
        return look(`waited ${i.seconds} s`, 'the Supervisor or the page asked for it');
      },
    },
    browser_press: {
      description:
        'Presses a button or a link, or text drawn like one, by its id or a position on the picture. `near` is words drawn close to it, when two share a name.',
      input: which.extend({ near: z.string().max(80).optional() }),
      async run(i: { id?: string; x?: number; y?: number; near?: string; why: string }) {
        await mayAct();
        const c = chosen(i);
        const v = decideWritten('press', c.name);
        if (!v.allowed) throw new ToolRefusal(`"${c.name}": ${v.rule}`);
        closeUp = c.box;
        const found = c.name ? await control(page, c.name, i.near).catch(() => null) : null;
        if (found && at(found.box, c)) {
          await press(page, c.name, i.near ? { near: i.near } : {});
          return look(`pressed "${c.name}"`, i.why);
        }
        await clickAt(page, centre(c.box));
        return look(
          `pressed ${i.id ?? 'the control'} "${c.name}" at its position ${Math.round(centre(c.box).x)},${Math.round(centre(c.box).y)}`,
          i.why,
        );
      },
    },
    browser_type: {
      description:
        "Types one of the task's values into the field you choose, by its id or position. `label` is the words beside it when the page's words hold them. The sign-in and a person's code are typed by the server and never shown: you name them.",
      input: which.extend({
        label: z.string().max(60).optional(),
        value: z.enum(['user_id', 'password', 'code', 'member', 'amount', 'memo']),
      }),
      async run(i: {
        id?: string;
        x?: number;
        y?: number;
        label?: string;
        value: string;
        why: string;
      }) {
        await mayAct();
        const c = chosen(i);
        const text = await valueOf(i.value);
        if (i.value === 'code' && !known.includes(text)) known.push(text);
        closeUp = c.box;
        const f = i.label ? await field(page, i.label).catch(() => null) : null;
        if (f && at(f.box, c)) await type(page, i.label!, text);
        else await typeAt(page, centre(c.box), text);
        const secret = i.value === 'password' || i.value === 'user_id' || i.value === 'code';
        return look(
          `typed the ${i.value.replace('_', ' ')} into ${i.id ?? 'the field'}${secret ? '; the field is filled' : ''}`,
          i.why,
        );
      },
    },
    browser_choose: {
      description:
        "Chooses the task's from or to account in the list you choose, by its id or position: the one option holding the account.",
      input: which.extend({
        label: z.string().max(60).optional(),
        account: z.enum(['from', 'to']),
      }),
      async run(i: {
        id?: string;
        x?: number;
        y?: number;
        label?: string;
        account: 'from' | 'to';
        why: string;
      }) {
        await mayAct();
        const c = chosen(i);
        const want = i.account === 'from' ? task.from : task.to;
        closeUp = c.box;
        const f = i.label ? await field(page, i.label).catch(() => null) : null;
        if (f && at(f.box, c)) await choose(page, i.label!, want);
        else await chooseAt(page, centre(c.box), want);
        return look(`chose the ${i.account} account in ${i.id ?? 'the list'}`, i.why);
      },
    },
    write_crawler: {
      description: `Writes the crawler, the whole of it, replacing any earlier version. Code checks it can run safely; then the Supervisor reads it against the evidence. ${CONTRACT}`,
      input: z.object({ source: z.string().min(50).max(30_000), why: z.string().min(3).max(300) }),
      async run(i: { source: string; why: string }) {
        const problems = lint(i.source, task, { partial: true });
        if (problems.length) throw new ToolRefusal(`the crawler can't run: ${problems.join('; ')}`);
        source = i.source;
        const has = partsOf(source);
        tried = {};
        await trail.keep(
          `crawler-${String(++versions).padStart(2, '0')}.js`,
          Buffer.from(i.source),
          'text/javascript',
        );
        await trail.step(
          { name: 'crawler written', action: `version ${versions}: ${i.why}` },
          null,
        );
        return look(
          `wrote version ${versions} of the crawler, with ${has.join(', ') || 'no parts yet'}`,
          i.why,
          {
            crawler: source,
            tried: triedText(),
          },
        );
      },
    },
    try_crawler: {
      description:
        'Runs one part of the crawler as written (signin, balance, transfer or history), live, with no model, in a page of its own, and says what it did: each step is kept as a frame. A failure says which line of the crawler threw and what the page showed. `cold` starts from a browser that has never signed in (a person may be asked for a code).',
      input: z.object({ part: z.enum(TRY_PARTS), cold: z.boolean().optional() }),
      async run(i: { part: TryPart; cold?: boolean }) {
        await mayAct();
        const r = await tryPart(i.part, i.cold ?? false);
        tried[i.part] = { ok: r.ok, said: r.said };
        await trail.step(
          {
            name: 'crawler tried',
            action: i.part,
            outcome: `${r.ok ? 'passed' : 'failed'}: ${r.said}`,
          },
          null,
        );
        const frames = r.refs.length ? ` Its frames: ${r.refs.join(', ')}.` : '';
        return look(
          `tried ${i.part}: ${r.ok ? 'passed' : 'failed'}, ${r.said}.${frames}`,
          `try ${i.part}`,
          {
            crawler: source!,
            tried: triedText(),
            ...(r.last ? { tryFrame: r.last } : {}),
          },
        );
      },
    },
    crawler_ready: {
      description:
        'Says the crawler is done: every part passed its latest try of this version. The Supervisor checks it against the evidence before it counts.',
      input: z.object({ why: z.string().min(3).max(300) }),
      async run(i: { why: string }) {
        if (!source) throw new ToolRefusal('write the crawler first');
        const problems = lint(source, task);
        if (problems.length)
          throw new ToolRefusal(`the crawler isn't whole yet: ${problems.join('; ')}`);
        const failing = PARTS.filter((p) => !tried[p]?.ok);
        if (failing.length)
          throw new ToolRefusal(
            `these parts have not passed a try of this version: ${failing.join(', ')}`,
          );
        const r = await look('says the crawler is ready', i.why, {
          crawler: source,
          tried: triedText(),
          checking: true,
        });
        return stopped ? { ...r, text: `The crawler is ready. Stop now.\n${r.text}` } : r;
      },
    },
  } satisfies Record<
    string,
    { description: string; input: z.ZodType; run(i: never): Promise<ToolResult> }
  >;
  let versions = 0;

  type Name = keyof typeof tools;
  const isTool = (n: string): n is Name => Object.hasOwn(tools, n);

  /** Every call: the role's list, then the input, then the tool. A refusal is recorded. */
  async function call(role: Role, name: string, input: unknown): Promise<ToolResult> {
    const entry: Entry = { tool: name, input };
    record.push(entry);
    current = entry;
    const refuse = async (why: string): Promise<never> => {
      entry.error = why;
      await trail.step(
        {
          name: 'refused',
          action: `${name} · input ${maskText(JSON.stringify(input), known).slice(0, 2000)}`,
          outcome: why,
        },
        null,
      );
      if (latest && role === 'scout') {
        const j = await deps.judge({
          action: `${name} was refused`,
          why: String((input as { why?: unknown } | null)?.why ?? ''),
          frame: latest.frame,
          ref: latest.ref,
          record: taken(),
        });
        if (j.verdict === 'stop') stopped = true;
        waiting = j.verdict === 'wait';
        throw new ToolRefusal(`${why}. The Supervisor: ${j.says}`);
      }
      throw new ToolRefusal(why);
    };
    const no = refusal(role, name) ?? (isTool(name) ? null : `there is no tool ${name}`);
    if (no) return refuse(no);
    const tool = tools[name as Name];
    const parsed = tool.input.safeParse(input);
    if (!parsed.success)
      return refuse(`the input does not fit ${name}: ${z.prettifyError(parsed.error)}`);
    try {
      const r = await (tool.run as (i: unknown) => Promise<ToolResult>)(parsed.data);
      entry.result =
        r.text.length > 4000
          ? `${r.text.slice(0, 4000)} (cut by the factory: ${r.text.length - 4000} more characters)`
          : r.text;
      return r;
    } catch (e) {
      if (e instanceof ToolRefusal) return refuse(e.message);
      if (e instanceof TargetError) return refuse(e.message);
      throw e;
    }
  }

  return {
    call,
    tools: (role: Role): Tool[] =>
      Object.entries(tools)
        .filter(([n]) => refusal(role, n) === null)
        .map(([n, x]) => ({
          name: n,
          description: x.description,
          input: x.input,
          run: (v: unknown) => call(role, n, v),
        })),
    /** The crawler as written, once every part passed and the Supervisor agreed; else null. */
    crawler: (): Written | null =>
      stopped && source && !lint(source, task).length && PARTS.every((p) => tried[p]?.ok)
        ? { kind: 'written', source }
        : null,
    /** The parts that passed their latest try. */
    passed: (): Part[] => PARTS.filter((p) => tried[p]?.ok),
    latest: () => latest,
    done: () => stopped,
  };
}

export type Scout = ReturnType<typeof scout>;
export { isWritten };
