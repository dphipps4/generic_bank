// The Scout (prompts, part 2, §3): it owns the job and works like a person. Every tool returns the
// page once the runtime calls it ready: the masked picture, and the visible controls with an id
// and a box each. It acts on one control at a time, by its id or by a position read from the
// picture, and says why; the runtime's own targeting must find that same control, or the action
// is refused and the Scout is told. As it goes it writes the bank's table: it names each page by
// words the page shows, code files each step it takes under that page, and it notes the bank's
// answers and where a value is read, each checked against the page. The Supervisor judges every
// action before the next one. The server types the sign-in and a person's code; the model never
// sees either. It never presses a control that could move money.
import type { Answer, At, Goal, Row, Step, Table } from '@gb/crawler';
import { leaf, readOf } from '@gb/crawler';
import {
  type Box,
  choose,
  control,
  type Control,
  clickAt,
  cropOf,
  field,
  findCrop,
  type Frame,
  knows,
  labelPicture,
  NotReady,
  type Page,
  press,
  see,
  TargetError,
  type,
  typeAt,
  UnknownPage,
  whatIsAt,
} from '@gb/runtime';
import { z } from 'zod';
import type { Role } from './models.js';
import { refusal, type Tool, ToolRefusal, type ToolResult } from './tools.js';
import type { Trail } from './trail.js';

/** What a run is for, and the values a teller is given for it. */
export interface Task {
  goal: Goal;
  member: string;
  /** Accounts by name or last four; for a transfer, and for its history. */
  from?: string;
  to?: string;
  amountCents?: number;
  memo?: string;
}

export interface ScoutDeps {
  page: Page;
  /** The bank's start page; only its host is ever opened. */
  start: string;
  trail: Trail;
  credentials: { operatorId: string; password: string };
  /** A person's code, once the bank has sent one. */
  code(): Promise<string>;
  /** The Supervisor's judgment of each action, before the next. */
  judge(j: Judging): Promise<Judgment>;
  /** The table so far: an empty one for a bank never learned, the broken one for a repair. */
  table?: Table;
}

export interface Judging {
  action: string;
  why: string;
  frame: Frame;
  ref: string | null;
  /** Every call the Scout made since the last judgment, in order, failures included. */
  record: Entry[];
}

/** One call of the Scout's, as the Supervisor sees it: what it asked, and what came back. */
export interface Entry {
  tool: string;
  input: unknown;
  /** What the tool answered; absent while the call is the one being judged. */
  result?: string;
  /** Why the call was refused, in the runtime's or the guard's own words. */
  error?: string;
  /** A close-up the Scout read from, for the Supervisor to see with its own eyes. */
  image?: Buffer;
}

/** One thing the Scout sees on a page, as it lists it: its kind, its label as read, and where. */
export interface Item {
  id: string;
  kind: string;
  label: string;
  labelFrom: 'text' | 'image' | 'none';
  box: Box;
  labelBox?: Box;
  state?: string;
  /** What the browser has at the middle of the box, as a fact. */
  found?: string;
}

export interface Judgment {
  verdict: 'continue' | 'wait' | 'stop' | 'end';
  /** What the Supervisor sees, citing a frame; the Scout reads it. */
  says: string;
}

// Words that could move money or change an account: never pressed by the factory.
const MONEY =
  /\b(confirm|submit|send\s+(money|payment|funds|transfer)|pay|authori[sz]e|approve|transfer\s+now|waive|close account|change address|add payee)\b/i;

const centre = (b: Box) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
const within = (p: { x: number; y: number }, b: Box) =>
  p.x >= b.x && p.y >= b.y && p.x <= b.x + b.w && p.y <= b.y + b.h;
const words = (f: Frame) =>
  f.tree
    .split('\n')
    .map(leaf)
    .filter((t): t is string => !!t);
const shows = (f: Frame, w: string) => f.tree.toLowerCase().includes(w.toLowerCase());

/** An account as a page draws it: a name as it is, last four digits as "ending in" them. */
const account = (ref = '') => (/^\d{4}$/.test(ref) ? `ending in ${ref}` : ref);

export function scout(deps: ScoutDeps, task: Task) {
  const { page, trail } = deps;
  const known = trail.known;
  for (const v of [deps.credentials.operatorId, deps.credentials.password, task.member])
    if (!known.includes(v)) known.push(v);

  // The table as the Scout writes it; a repair starts from the broken one.
  const t: Table = deps.table
    ? structuredClone(deps.table)
    : {
        bank: '',
        home: '',
        rows: [],
        ends: {} as Table['ends'],
        answers: [],
        trouble: [],
        submit: { press: '', frame: '' },
        reads: {} as Table['reads'],
      };
  let latest: { frame: Frame; ref: string | null; controls: Control[] } | null = null;
  let previous: Buffer | null = null;
  let row: Row | null = null;
  let visit: Step[] = [];
  let waiting = false;
  let stopped = false;

  const pages = () => t.rows.map((r) => ({ name: r.page, shows: r.shows, never: r.never ?? [] }));
  /** Which named page this is, if one. */
  const rowOf = (f: Frame): Row | null => {
    try {
      const name = knows(f, pages());
      return t.rows.find((r) => r.page === name) ?? null;
    } catch (e) {
      if (e instanceof UnknownPage) return null;
      throw e;
    }
  };
  /**
   * A visit's steps become the steps of the page it was on, for the goal: the latest visit to a
   * page that got somewhere wins. Steps on a page not yet named are kept until it is.
   */
  const fileVisit = (on: Row | null) => {
    if (on && visit.length) on.do[task.goal] = visit;
    visit = [];
  };

  /** After an action: the page once ready, a step in the trail, the Supervisor's judgment. */
  async function look(action: string, why: string): Promise<ToolResult> {
    let f: Frame;
    try {
      // No long waits: a page that will not settle is given up on in seconds.
      f = await see(page, { known, limitMs: 15_000 });
    } catch (e) {
      if (!(e instanceof NotReady)) throw e;
      await trail.step({ name: 'not ready', action, outcome: e.message }, null);
      return { text: `${action}. The page never became ready: ${e.message}` };
    }
    const seen = await trail.step({ name: task.goal, action: `${action} (${why})` }, f);
    const ref = seen?.ref ?? null;
    const was = row;
    row = rowOf(f);
    if (row !== was) fileVisit(was);
    const controls = f.controls.filter((c) => c.name || c.role !== 'link');
    const before = previous;
    previous = f.picture;
    latest = { frame: f, ref, controls };
    inventory = null;
    const j =
      action === 'looked'
        ? null
        : await deps.judge({ action, why, frame: f, ref, record: taken() });
    if (j?.verdict === 'stop') stopped = true;
    waiting = j?.verdict === 'wait';
    const view = {
      frame: ref,
      page: row?.page ?? null,
      controls: controls.map((c, i) => ({
        id: `c${i + 1}`,
        role: c.role,
        name: c.name,
        box: c.box,
      })),
      words: words(f),
      ...(f.dialogs.length ? { dialogs: f.dialogs } : {}),
      ...(before ? { before: 'the picture before this one is in the previous result' } : {}),
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
  /** The runtime's targeting must land on the control the Scout chose. */
  const same = (found: Box, c: Control, what: string) => {
    if (!within(centre(found), c.box) && !within(centre(c.box), found))
      throw new ToolRefusal(
        `${what} finds another control than the one you chose; name it by words drawn nearer to it`,
      );
  };
  /** The calls since the Supervisor last judged; each judgment takes them all. */
  let record: Entry[] = [];
  /** The call in progress, so a tool can attach a close-up to it. */
  let current: Entry | null = null;
  /** What the Scout listed on the latest page, checked by the browser; reset on every new page. */
  let inventory: Item[] | null = null;
  const taken = () => {
    const r = record;
    record = [];
    return r;
  };
  /** Sign-ins typed this run: a third means the first two were refused. */
  let signIns = 0;
  /** An item of the Scout's list, of a kind it may be acted on as, confirmed by the browser. */
  const itemOf = (id: string, kinds: string[]): Item => {
    if (!inventory) throw new ToolRefusal('list_page first: nothing is listed for this page');
    const it = inventory.find((x) => x.id === id);
    if (!it) throw new ToolRefusal(`there is no ${id} in your list of this page`);
    if (!kinds.includes(it.kind))
      throw new ToolRefusal(`${id} is a ${it.kind}, not a ${kinds.join(' or ')}`);
    if (it.found !== it.kind)
      throw new ToolRefusal(
        `${id}: the browser has ${it.found ?? 'nothing'} at the middle of its box, not a ${it.kind}: look at the picture again, and list its box where it is drawn`,
      );
    return it;
  };
  /**
   * The step's anchor, for the crawler to find this place again with no model: a crop of the
   * label (or of the control itself) from the masked picture, and the offset from its middle to
   * the control's. The anchor must be clearly found, once, where it was cut from.
   */
  const anchorOf = async (it: Item, from: Box): Promise<At> => {
    const pad = 2;
    const box = { x: from.x - pad, y: from.y - pad, w: from.w + 2 * pad, h: from.h + 2 * pad };
    const crop = cropOf(latest!.frame.picture, box);
    const found = findCrop(latest!.frame.picture, crop);
    if (!found || Math.abs(found.box.x - box.x) > 3 || Math.abs(found.box.y - box.y) > 3)
      throw new ToolRefusal(
        `the label of ${it.id} is not unique on the page, so it cannot be found again: give a box that holds more of it`,
      );
    // What the Supervisor sees: the label and the control together, close up.
    const near = {
      x: Math.min(box.x, it.box.x) - 6,
      y: Math.min(box.y, it.box.y) - 6,
      w: Math.max(box.x + box.w, it.box.x + it.box.w) - Math.min(box.x, it.box.x) + 12,
      h: Math.max(box.y + box.h, it.box.y + it.box.h) - Math.min(box.y, it.box.y) + 12,
    };
    if (current) current.image = cropOf(latest!.frame.picture, near);
    const a = centre(box);
    const c = centre(it.box);
    return {
      anchor: crop.toString('base64'),
      dx: Math.round(c.x - a.x),
      dy: Math.round(c.y - a.y),
      kind: it.kind,
    };
  };
  const mayAct = () => {
    if (stopped) throw new ToolRefusal('the Supervisor said stop');
    if (waiting) throw new ToolRefusal('the Supervisor said wait: wait or look first');
  };

  const BOX = z.object({
    x: z.number(),
    y: z.number(),
    w: z.number().positive(),
    h: z.number().positive(),
  });
  const which = z
    .object({
      id: z
        .string()
        .regex(/^c\d{1,3}$/)
        .optional()
        .describe('A control id from the latest page'),
      x: z.number().optional().describe('Or a position on the picture'),
      y: z.number().optional(),
      why: z.string().min(3).max(200).describe('One line: why this action'),
    })
    .describe('One control, by id or position');

  const tools = {
    browser_open: {
      description: "Opens the site's start page, or a path on its own host. Nothing else opens.",
      input: z.object({ path: z.string().max(200).optional() }),
      async run(i: { path?: string }) {
        mayAct();
        const url = new URL(i.path ?? deps.start, deps.start);
        if (url.host !== new URL(deps.start).host)
          throw new ToolRefusal(`${url.host} is not the site being learned`);
        await page.goto(url.href);
        if (!t.home) t.home = url.pathname.replace(new URL(deps.start).pathname, '') || '';
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
      input: z.object({ seconds: z.number().int().min(1).max(30) }),
      async run(i: { seconds: number }) {
        await new Promise((r) => setTimeout(r, i.seconds * 1000));
        waiting = false;
        return look(`waited ${i.seconds} s`, 'the Supervisor or the page asked for it');
      },
    },
    browser_press: {
      description:
        'Presses a button or a link, or text drawn like one. `near` is words drawn close to it, when two share a name.',
      input: which.extend({ near: z.string().max(80).optional() }),
      async run(i: { id?: string; x?: number; y?: number; near?: string; why: string }) {
        mayAct();
        const c = chosen(i);
        if (!c.name) throw new ToolRefusal('that control has no drawn name to press it by');
        if (MONEY.test(c.name))
          throw new ToolRefusal(`"${c.name}" could move money or change an account: never pressed`);
        const found = await control(page, c.name, i.near).catch((e: Error) => {
          throw new ToolRefusal(`the runtime cannot find "${c.name}": ${e.message}`);
        });
        same(found.box, c, `"${c.name}"`);
        await press(page, c.name, i.near ? { near: i.near } : {});
        // Near the task's own account, the step says so, and fits any member's account.
        const near =
          i.near && [task.from, account(task.from)].includes(i.near)
            ? '$from'
            : i.near && [task.to, account(task.to)].includes(i.near)
              ? '$to'
              : i.near;
        visit.push({ press: c.name, ...(near ? { near } : {}) });
        return look(`pressed "${c.name}"`, i.why);
      },
    },
    browser_type: {
      description:
        "Types one of the task's values into the field you choose, by id or position, and the label beside it: its words, or, where the label is a picture of words, the words the picture shows. The sign-in and a person's code are typed by the server and never shown.",
      input: which.extend({
        label: z
          .string()
          .min(1)
          .max(60)
          .describe("The label's words, as drawn or as its picture shows them"),
        value: z.enum(['user_id', 'password', 'code', 'member', 'amount', 'memo']),
      }),
      async run(i: {
        id?: string;
        x?: number;
        y?: number;
        label: string;
        value: 'user_id' | 'password' | 'code' | 'member' | 'amount' | 'memo';
        why: string;
      }) {
        mayAct();
        const c = chosen(i);
        const label = i.label;
        // Words beside the field first. Where there are none, the label is a picture of words: it
        // is known from now on by its fingerprint, under the words the Scout read off it.
        const f = await field(page, label, t.pictures).catch(async (e: Error) => {
          const pic = await labelPicture(page, c.box);
          if (!pic)
            throw new ToolRefusal(
              `no words "${label}" beside a field, and no label picture beside the field you chose (${c.role} at ${Math.round(c.box.x)},${Math.round(c.box.y)}): ${e.message}`,
            );
          t.pictures = [
            ...(t.pictures ?? []).filter((p) => p.name !== label),
            { name: label, print: pic.print, ratio: pic.ratio },
          ];
          return field(page, label, t.pictures).catch((e2: Error) => {
            throw new ToolRefusal(
              `learned the label picture beside the field you chose as "${label}", but could not find it again: ${e2.message}`,
            );
          });
        });
        same(f.box, c, `the field by "${label}"`);
        // A password typed a third time means the first two sign-ins were refused.
        if (i.value === 'password' && ++signIns > 2)
          throw new Error('two sign-ins did not get past the sign-in page: stopping for a person');
        const text =
          i.value === 'user_id'
            ? deps.credentials.operatorId
            : i.value === 'password'
              ? deps.credentials.password
              : i.value === 'code'
                ? (await deps.code()).trim()
                : i.value === 'member'
                  ? task.member
                  : i.value === 'amount'
                    ? ((task.amountCents ?? 0) / 100).toFixed(2)
                    : (task.memo ?? '');
        if (i.value === 'code' && !known.includes(text)) known.push(text);
        await type(page, label, text, t.pictures);
        // The sign-in and the code go into fields the allowlists know by their own names: the bank's
        // name for each is kept, so the guard knows them when the table runs.
        const listed = { user_id: 'Operator ID', password: 'Password', code: 'Code' }[
          i.value as 'user_id' | 'password' | 'code'
        ];
        if (listed && listed !== label) {
          t.names ??= {};
          t.names[listed] = [...new Set([...(t.names[listed] ?? []), label])];
        }
        const token = {
          user_id: '$operator',
          password: '$password',
          code: '$code',
          member: '$member',
          amount: '$amount',
          memo: '$memo',
        }[i.value];
        visit.push({ type: label, value: token });
        return look(`typed the ${i.value.replace('_', ' ')} into "${label}"`, i.why);
      },
    },
    list_page: {
      description:
        "Lists everything you can see on the latest page's picture: each field, button, link, checkbox, list, message and heading, with its label as you read it (words drawn as text, or a picture of words), and its box in the picture's pixels. For a field, also give the box of its label. The browser checks what it has at the middle of each box. Use it when a tool cannot find what you are looking for by its words; then act on an item with type_item or press_item.",
      input: z.object({
        items: z
          .array(
            z.object({
              id: z.string().regex(/^i\d{1,3}$/),
              kind: z.enum([
                'field',
                'password field',
                'button',
                'link',
                'checkbox',
                'list',
                'message',
                'heading',
                'text',
                'image',
              ]),
              label: z.string().max(120),
              labelFrom: z.enum(['text', 'image', 'none']),
              box: BOX,
              labelBox: BOX.optional(),
              state: z.string().max(60).optional(),
            }),
          )
          .min(1)
          .max(80),
      }),
      async run(i: { items: Item[] }) {
        if (!latest) throw new ToolRefusal('look at the page first');
        const checked: Item[] = [];
        for (const it of i.items) {
          const acts = ['field', 'password field', 'button', 'link', 'checkbox', 'list'];
          const found = acts.includes(it.kind)
            ? (await whatIsAt(page, centre(it.box))).kind
            : undefined;
          checked.push({ ...it, ...(found ? { found } : {}) });
        }
        inventory = checked;
        await trail.step(
          { name: 'inventory', action: JSON.stringify(checked).slice(0, 4000) },
          null,
        );
        const line = (it: Item) =>
          `${it.id} ${it.kind} "${it.label}" (${it.labelFrom}) at ${Math.round(it.box.x)},${Math.round(it.box.y)} ${Math.round(it.box.w)}x${Math.round(it.box.h)}` +
          (it.found === undefined
            ? ''
            : it.found === it.kind
              ? `: the browser has a ${it.found} there`
              : `: NOT CONFIRMED, the browser has ${it.found === 'nothing' ? 'nothing' : `a ${it.found}`} there`);
        return {
          text: `The page as you listed it, checked by the browser:\n${checked.map(line).join('\n')}`,
        };
      },
    },
    type_item: {
      description:
        "Types one of the task's values into a field from your list_page, by its position: the mouse clicks the middle of its box, the keyboard clears it and types. The sign-in and a person's code are typed by the server and never shown.",
      input: z.object({
        item: z.string().regex(/^i\d{1,3}$/),
        value: z.enum(['user_id', 'password', 'code', 'member', 'amount', 'memo']),
        why: z.string().min(3).max(200),
      }),
      async run(i: {
        item: string;
        value: 'user_id' | 'password' | 'code' | 'member' | 'amount' | 'memo';
        why: string;
      }) {
        mayAct();
        const it = itemOf(i.item, ['field', 'password field']);
        if (!it.labelBox)
          throw new ToolRefusal(
            `${it.id} has no label box: list the page again with its label's box`,
          );
        const at = await anchorOf(it, it.labelBox);
        if (i.value === 'password' && ++signIns > 2)
          throw new Error('two sign-ins did not get past the sign-in page: stopping for a person');
        const text =
          i.value === 'user_id'
            ? deps.credentials.operatorId
            : i.value === 'password'
              ? deps.credentials.password
              : i.value === 'code'
                ? (await deps.code()).trim()
                : i.value === 'member'
                  ? task.member
                  : i.value === 'amount'
                    ? ((task.amountCents ?? 0) / 100).toFixed(2)
                    : (task.memo ?? '');
        if (i.value === 'code' && !known.includes(text)) known.push(text);
        const p = centre(it.box);
        await typeAt(page, p, text);
        const listed = { user_id: 'Operator ID', password: 'Password', code: 'Code' }[
          i.value as 'user_id' | 'password' | 'code'
        ];
        if (listed && listed !== it.label) {
          t.names ??= {};
          t.names[listed] = [...new Set([...(t.names[listed] ?? []), it.label])];
        }
        const token = {
          user_id: '$operator',
          password: '$password',
          code: '$code',
          member: '$member',
          amount: '$amount',
          memo: '$memo',
        }[i.value];
        visit.push({ type: it.label, value: token, at });
        return look(
          `typed the ${i.value.replace('_', ' ')} into ${it.id}, the ${it.kind} labeled "${it.label}" (${it.labelFrom}), by clicking ${Math.round(p.x)},${Math.round(p.y)}`,
          i.why,
        );
      },
    },
    press_item: {
      description:
        'Presses a button, link or checkbox from your list_page, by its position: the mouse moves to the middle of its box and clicks.',
      input: z.object({
        item: z.string().regex(/^i\d{1,3}$/),
        why: z.string().min(3).max(200),
      }),
      async run(i: { item: string; why: string }) {
        mayAct();
        const it = itemOf(i.item, ['button', 'link', 'checkbox']);
        if (MONEY.test(it.label))
          throw new ToolRefusal(
            `"${it.label}" could move money or change an account: never pressed`,
          );
        const at = await anchorOf(it, it.labelBox ?? it.box);
        const p = centre(it.box);
        await clickAt(page, p);
        visit.push({ press: it.label, at });
        return look(
          `pressed ${it.id}, the ${it.kind} "${it.label}" (${it.labelFrom}), by clicking ${Math.round(p.x)},${Math.round(p.y)}`,
          i.why,
        );
      },
    },
    browser_choose: {
      description: "Chooses the task's from or to account in the list a label names.",
      input: which.extend({
        label: z.string().min(1).max(60),
        account: z.enum(['from', 'to']),
      }),
      async run(i: {
        id?: string;
        x?: number;
        y?: number;
        label: string;
        account: 'from' | 'to';
        why: string;
      }) {
        mayAct();
        const c = chosen(i);
        const f = await field(page, i.label).catch((e: Error) => {
          throw new ToolRefusal(`the runtime finds no list by "${i.label}": ${e.message}`);
        });
        same(f.box, c, `the list by "${i.label}"`);
        await choose(page, i.label, account(i.account === 'from' ? task.from : task.to)).catch(
          (e: Error) => {
            if (e instanceof TargetError) throw new ToolRefusal(e.message);
            throw e;
          },
        );
        visit.push({ choose: i.label, containing: i.account === 'from' ? '$from' : '$to' });
        return look(`chose the ${i.account} account in "${i.label}"`, i.why);
      },
    },
    name_page: {
      description:
        'Names the page now, by words it shows that tell it apart from every other page; `never` are words that would mean another page. Steps you take here are filed under it.',
      input: z.object({
        name: z.string().min(2).max(40),
        shows: z.array(z.string().min(2).max(80)).min(1).max(4),
        never: z.array(z.string().min(2).max(80)).max(4).optional(),
      }),
      async run(i: { name: string; shows: string[]; never?: string[] }) {
        if (!latest?.ref) throw new ToolRefusal('look at the page first');
        const f = latest.frame;
        const missing = i.shows.filter((w) => !shows(f, w));
        if (missing.length) throw new ToolRefusal(`the page does not show: ${missing.join('; ')}`);
        const wrong = (i.never ?? []).filter((w) => shows(f, w));
        if (wrong.length)
          throw new ToolRefusal(`the page shows what you said it never does: ${wrong.join('; ')}`);
        const old = t.rows.find((r) => r.page === i.name);
        const next: Row = {
          page: i.name,
          shows: i.shows,
          ...(i.never?.length ? { never: i.never } : {}),
          do: old?.do ?? {},
          frame: latest.ref,
        };
        const rows = [...t.rows.filter((r) => r.page !== i.name), next];
        try {
          if (
            knows(
              f,
              rows.map((r) => ({ name: r.page, shows: r.shows, never: r.never ?? [] })),
            ) !== i.name
          )
            throw new ToolRefusal('those words also show another named page');
        } catch (e) {
          if (e instanceof UnknownPage)
            throw new ToolRefusal(
              `those words fit more than one named page: ${e.closest.join(', ')}`,
            );
          throw e;
        }
        t.rows = rows;
        row = next;
        await trail.step({ name: 'name page', action: `${i.name}: ${i.shows.join('; ')}` }, null);
        return { text: `This page is "${i.name}", at ${latest.ref}.` };
      },
    },
    note_answer: {
      description:
        'Notes the bank\'s own answer on this page ("No member found") and the outcome it means. The words must be on the page.',
      input: z.object({
        says: z.string().min(4).max(120),
        means: z.enum([
          'no_such_member',
          'member_closed',
          'no_such_account',
          'insufficient_funds',
          'permission_denied',
          'account_restricted',
          'limit_exceeded',
          'invalid_amount',
          'record_in_use',
        ]),
      }),
      async run(i: { says: string; means: Answer['code'] }) {
        if (!latest?.ref || !shows(latest.frame, i.says))
          throw new ToolRefusal('the page does not show those words');
        t.answers = [
          ...t.answers.filter((a) => a.says !== i.says),
          {
            says: i.says,
            code: i.means,
            frame: latest.ref,
            ...(i.means === 'record_in_use' ? { retryable: true } : {}),
          },
        ];
        await trail.step({ name: 'note answer', action: `${i.means}: ${i.says}` }, null);
        return { text: `Noted, citing ${latest.ref}.` };
      },
    },
    note_read: {
      description:
        "Notes how a value is read on this page: the visible text, one line per \\n, with {placeholders}. balance: one account's line, {name} {last4} {available} {current}. review: {from} {to} {amount} {memo}. confirmation: {confirmation}. name: where the member's name shows, {name}, with $member for their number. Masked values read as stars.",
      input: z.object({
        what: z.enum(['balance', 'review', 'confirmation', 'name']),
        text: z.string().min(5).max(300),
      }),
      async run(i: { what: 'balance' | 'review' | 'confirmation' | 'name'; text: string }) {
        if (!latest?.ref) throw new ToolRefusal('look at the page first');
        const need = {
          balance: ['name', 'last4', 'available', 'current'],
          review: ['from', 'to', 'amount', 'memo'],
          confirmation: ['confirmation'],
          name: ['name'],
        }[i.what];
        const has = [...i.text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
        const lacking = need.filter((n) => !has.includes(n));
        if (lacking.length) throw new ToolRefusal(`the text needs {${lacking.join('}, {')}}`);
        // Frames are masked: the member's number shows as stars, like every value.
        if (!readOf(i.text, '********').test(words(latest.frame).join('\n')))
          throw new ToolRefusal('no visible text on this page fits that');
        t.reads =
          i.what === 'name'
            ? { ...t.reads, name: [...(t.reads.name ?? []).filter((n) => n !== i.text), i.text] }
            : { ...t.reads, [i.what]: i.text };
        await trail.step({ name: 'note read', action: `${i.what}: ${i.text}` }, null);
        return { text: `Noted, citing ${latest.ref}.` };
      },
    },
    goal_reached: {
      description:
        "Says the goal is reached on the page now (the balance shows; the transfer's review; the account's activity). For a transfer, `submit` is the control that would send it: named, never pressed.",
      input: z.object({ submit: z.string().max(60).optional() }),
      async run(i: { submit?: string }) {
        if (!latest?.ref || !row) throw new ToolRefusal('name this page first');
        if (task.goal === 'transfer') {
          if (!i.submit || !latest.controls.some((c) => c.name === i.submit))
            throw new ToolRefusal('name the control on this page that would send the transfer');
          t.submit = { press: i.submit, frame: latest.ref };
        }
        fileVisit(row);
        t.ends = { ...t.ends, [task.goal]: row.page };
        stopped = true;
        await trail.step({ name: 'goal reached', action: `${task.goal} on ${row.page}` }, null);
        return { text: `The ${task.goal} goal is reached on "${row.page}". Stop now.` };
      },
    },
  } satisfies Record<
    string,
    { description: string; input: z.ZodType; run(i: never): Promise<ToolResult> }
  >;

  type Name = keyof typeof tools;
  const isTool = (n: string): n is Name => Object.hasOwn(tools, n);

  /** Every call: the role's list, then the input, then the tool. A refusal is recorded. */
  async function call(role: Role, name: string, input: unknown): Promise<ToolResult> {
    const entry: Entry = { tool: name, input };
    record.push(entry);
    current = entry;
    const refuse = async (why: string): Promise<never> => {
      entry.error = why;
      await trail.step({ name: 'refused', action: name, outcome: why }, null);
      // A failure is judged at once, on the latest picture: the Scout never moves on unseen.
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
      entry.result = r.text.length > 600 ? `${r.text.slice(0, 599)}…` : r.text;
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
    /** The table as written so far. */
    table: () => t,
    latest: () => latest,
    done: () => stopped,
  };
}

export type Scout = ReturnType<typeof scout>;
