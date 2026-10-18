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
import { accountsIn, cents, leaf, leaves, namesIn, readOf } from '@gb/crawler';
import {
  type Box,
  choose,
  control,
  type Control,
  chooseAt,
  clickAt,
  cropOf,
  field,
  findCrop,
  type Frame,
  knows,
  maskText,
  NotReady,
  type Page,
  press,
  see,
  TargetError,
  type,
  typeAt,
  UnknownPage,
  valueAt,
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
  /** At "goal reached": the route so far, for the Supervisor to check before it counts. */
  route?: Table;
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
  /** More time for the goal, when it is close: seconds to add to its clock. */
  extendSeconds?: number;
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

/** An account as the lists hold it: its last four digits, whatever words a bank puts around them. */
const account = (ref = '') => ref;

/**
 * A read written from the page's own lines, where the Scout points: each placeholder after a label
 * it sees, or at words it sees. It finds them in the lines as the masking rule shows them (what the
 * Scout sees) and writes the pattern from the same lines as the crawler reads them (the same
 * characters, one for one). The task's own member number becomes $member, and a balance's account
 * number its {last4} where the Scout did not point at it.
 */
export function pointed(
  what: string,
  parts: { placeholder: string; after?: string; is?: string }[],
  real: string[],
  shown: string[],
  task: { member: string; from?: string },
): string {
  const spans = new Map<number, [number, number, string][]>();
  /** Lines a read holds without a value of their own: a label that is a line by itself. */
  const labels = new Set<number>();
  const add = (line: number, a: number, b: number, ph: string) => {
    if (b <= a) throw new ToolRefusal(`{${ph}} points at nothing`);
    spans.set(line, [...(spans.get(line) ?? []), [a, b, ph]]);
  };
  for (const p of parts) {
    if (p.is) {
      const line = shown.findIndex((l) => l.includes(p.is!));
      if (line < 0) throw new ToolRefusal(`no line shows "${p.is}"`);
      const a = shown[line]!.indexOf(p.is);
      add(line, a, a + p.is.length, p.placeholder);
    } else if (p.after) {
      const label = p.after.trim();
      const line = shown.findIndex((l) => l.includes(label));
      if (line < 0) throw new ToolRefusal(`no line shows the label "${label}"`);
      const l = shown[line]!;
      const from = l.indexOf(label) + label.length;
      if (!l.slice(from).trim()) {
        // The label is a line of its own: its value is the next line, whole.
        if (line + 1 >= shown.length) throw new ToolRefusal(`nothing follows "${label}"`);
        labels.add(line);
        add(line + 1, 0, shown[line + 1]!.length, p.placeholder);
      } else {
        // On the same line: the value runs to the next label pointed at, or to the end.
        const start = from + (l.slice(from).length - l.slice(from).trimStart().length);
        const next = parts
          .filter((q) => q.after && q !== p)
          .map((q) => l.indexOf(q.after!.trim(), start))
          .filter((k) => k > start);
        const stop = next.length ? Math.min(...next) : l.length;
        add(line, start, start + l.slice(start, stop).trimEnd().length, p.placeholder);
      }
    } else
      throw new ToolRefusal(`{${p.placeholder}}: give the label before it, or the words you see`);
  }
  if (!spans.size) throw new ToolRefusal('point at the values on this screen');
  // A name read reaches back to the line with the member's number, within a few lines: it is
  // anchored on it, so it never takes another line for a name.
  if (what === 'name') {
    const [line] = [...spans.keys()];
    if (!real[line!]!.includes(task.member)) {
      const back = [1, 2, 3]
        .map((d) => line! - d)
        .find((k) => k >= 0 && real[k]!.includes(task.member));
      if (back !== undefined) labels.add(back);
    }
  }
  // A balance's account number, where the Scout did not point at it: the task's last four, on the
  // line it pointed at.
  if (what === 'balance' && !parts.some((p) => p.placeholder === 'last4') && task.from) {
    const [line] = [...spans.keys()];
    const at = real[line!]!.indexOf(task.from);
    if (at >= 0) add(line!, at, at + task.from.length, 'last4');
  }
  const lines = [...spans.keys(), ...labels];
  const lo = Math.min(...lines);
  const hi = Math.max(...lines);
  if (hi - lo > 12) throw new ToolRefusal('those values are too far apart to be one read');
  const out: string[] = [];
  for (let k = lo; k <= hi; k++) {
    const ss = (spans.get(k) ?? []).sort((x, y) => x[0] - y[0]);
    let line = '';
    let at = 0;
    for (const [n, [a, b, ph]] of ss.entries()) {
      if (a < at)
        throw new ToolRefusal(
          `{${ph}} overlaps {${ss[n - 1]![2]}} on the line "${shown[k]}": a value pointed at with after runs to the next label you point at, so point at a value you can see with is`,
        );
      line += real[k]!.slice(at, a) + `{${ph}}`;
      at = b;
    }
    out.push(line + real[k]!.slice(at));
  }
  // The member's own number is the task's, never kept: any member's number fits there.
  return out.join('\n').split(task.member).join('$member');
}

export function scout(deps: ScoutDeps, task: Task) {
  const { page, trail } = deps;
  const known = trail.known;
  // The sign-in is hidden whole. The member's number is an identifier: the masking rule keeps its
  // last four, the same for the gate and every run. The member's name joins once a read finds it.
  for (const v of [deps.credentials.operatorId, deps.credentials.password])
    if (!known.includes(v)) known.push(v);
  /** Learns the member's name where a noted name read finds it, as the crawler does. */
  const learnName = async () => {
    if (!t.reads.name?.length) return;
    const words = (await leaves(page)).join('\n');
    for (const part of namesIn(words, t.reads.name, task.member))
      if (!known.includes(part)) known.push(part);
  };

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
      await learnName();
      // No long waits: a page that will not settle is given up on in seconds.
      f = await see(page, { known, limitMs: 15_000, everyMs: 150 });
    } catch (e) {
      if (!(e instanceof NotReady)) throw e;
      await trail.step({ name: 'not ready', action, outcome: e.message }, null);
      return { text: `${action}. The page never became ready: ${e.message}` };
    }
    // The call's own input goes with its step, masked: the evidence shows what was asked for.
    const asked = current ? ` · input ${maskText(JSON.stringify(current.input), known)}` : '';
    // A page that shows the member's number before their name is known could show their name: it is
    // not kept until a name read hides the name. The Scout's next step is that read.
    nameFirst =
      !t.reads.name?.length && words(f).some((w) => w.includes(maskText(task.member, known)));
    const seen = await trail.step(
      {
        name: task.goal,
        action: `${action} (${why})${asked}${nameFirst ? " · not kept until the member's name is hidden" : ''}`,
      },
      nameFirst ? null : f,
    );
    const ref = seen?.ref ?? null;
    const was = row;
    row = rowOf(f);
    if (row !== was) fileVisit(was);
    const controls = f.controls.filter((c) => c.name || c.role !== 'link');
    const before = previous;
    previous = f.picture;
    // The Scout's list holds while the page's controls stay where they were: typing into a field
    // keeps it; a new page clears it.
    const layout = JSON.stringify(
      controls.map((c) => [c.role, Math.round(c.box.x), Math.round(c.box.y)]),
    );
    if (layout !== lastLayout) inventory = null;
    lastLayout = layout;
    latest = { frame: f, ref, controls };
    // The close-up the Supervisor judges by is taken after the action, from the new picture.
    if (current && closeUp) current.image = cropOf(f.picture, closeUp);
    closeUp = null;
    const j =
      action === 'looked'
        ? null
        : await deps.judge({ action, why, frame: f, ref, record: taken(), route: t });
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
        // A field the words don't name: structure can't find it by a label, sight can by its id.
        ...(!c.name && ['textbox', 'password', 'select'].includes(c.role)
          ? {
              label:
                'none in the words: if it has one, it is drawn as a picture; act on it by this id',
            }
          : {}),
      })),
      words: words(f),
      ...(f.dialogs.length ? { dialogs: f.dialogs } : {}),
      ...(before ? { before: 'the picture before this one is in the previous result' } : {}),
    };
    const said = j ? `\nThe Supervisor: ${j.verdict}. ${j.says}` : '';
    // The view as the Scout reads it, kept so this look can be replayed exactly.
    await trail.keep(
      `view-${String(++viewed).padStart(3, '0')}.json`,
      Buffer.from(JSON.stringify({ action, frame: ref, said: j?.says ?? null, view })),
      'application/json',
    );
    const first = nameFirst
      ? "\nThis page shows the member's number, and maybe their name: before anything else, note_read name, pointing at where the member's name shows. The page is kept once their name is hidden."
      : '';
    return { text: `${action}.${said}${first}\n${JSON.stringify(view)}`, image: f.picture };
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
  /** Where the latest page's controls were: the list holds while they stay put. */
  let lastLayout = '';
  /** The region an action works on, cut again from the picture after it, for the Supervisor. */
  let closeUp: Box | null = null;
  /** What a field holds after typing, by length only: the typing is confirmed, the value unseen. */
  const holds = async (p: { x: number; y: number }, secret = false) => {
    const v = await valueAt(page, p).catch(() => '');
    if (!v) return '; the field reports no value';
    // A secret's length is part of it: the field is said to be filled, nothing more.
    return secret ? '; the field is filled' : `; the field now holds ${v.length} characters`;
  };
  /** Whether a value is a secret: the sign-in and a person's code. */
  const secretValue = (v: string) => v === 'user_id' || v === 'password' || v === 'code';
  /** Whether the page's own words hold a label, colon or not: then structure can find it. */
  const inWords = (label: string) => {
    const want = label.trim().replace(/:$/, '').toLowerCase();
    return words(latest!.frame).some((w) => w.trim().replace(/:$/, '').toLowerCase() === want);
  };
  /**
   * The anchor of a control with no words of its own: a crop of it and the label drawn to its left,
   * found once on the page. The crawler finds it there again by sight.
   */
  const sightAnchor = async (c: Control, label: string): Promise<At> => {
    const kind = (await whatIsAt(page, centre(c.box))).kind;
    const it: Item = { id: 'c', kind, label, labelFrom: 'image', box: c.box };
    const region = {
      x: Math.max(0, c.box.x - 140),
      y: c.box.y - 4,
      w: c.box.w + Math.min(140, c.box.x) + 8,
      h: c.box.h + 8,
    };
    return anchorOf(it, region);
  };
  const taken = () => {
    const r = record;
    record = [];
    return r;
  };
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
    closeUp = near;
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
    if (nameFirst)
      throw new ToolRefusal(
        "this page shows the member's number: note_read name first, pointing at where their name shows",
      );
  };
  /** A page showing the member's number before a name read hides their name: kept only after it. */
  let nameFirst = false;
  let viewed = 0;

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
      input: z.object({ seconds: z.number().int().min(1).max(3) }),
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
        if (MONEY.test(c.name))
          throw new ToolRefusal(`"${c.name}" could move money or change an account: never pressed`);
        // By its name when the name finds it alone; otherwise (no name, or a name two controls share)
        // by its position, with an anchor the crawler finds it by again.
        const found = c.name ? await control(page, c.name, i.near).catch(() => null) : null;
        if (!found || !(within(centre(found.box), c.box) || within(centre(c.box), found.box))) {
          const it: Item = {
            id: i.id ?? 'c',
            kind: (await whatIsAt(page, centre(c.box))).kind,
            label: c.name,
            labelFrom: 'text',
            box: c.box,
          };
          // Two controls can look alike (a menu's "Move Money" and the panel's): a wider crop holds
          // what is around it too, and is found once.
          const wide = { x: c.box.x - 40, y: c.box.y - 12, w: c.box.w + 80, h: c.box.h + 24 };
          const at = await anchorOf(it, c.box).catch(() => anchorOf(it, wide));
          await clickAt(page, centre(c.box));
          visit.push({ press: c.name || 'Submit', at });
          return look(
            `pressed ${i.id ?? 'the control'} "${c.name}" by its position ${Math.round(centre(c.box).x)},${Math.round(centre(c.box).y)}`,
            i.why,
          );
        }
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
        "Types one of the task's values into the field you choose, by its id, and the label beside it. When the page's words hold the label, the field is found by it; when they don't (a label drawn as a picture), the field the id names is typed at its position. The sign-in and a person's code are typed by the server and never shown.",
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
        const token = {
          user_id: '$operator',
          password: '$password',
          code: '$code',
          member: '$member',
          amount: '$amount',
          memo: '$memo',
        }[i.value];
        // Structure first: the label's words, when the page's words hold them. Otherwise sight, in
        // the same call: the field the id names, typed at its position, with an anchor of it and the
        // label drawn beside it. A failed lookup costs milliseconds, not a refusal and a judgment.
        const f = inWords(label) ? await field(page, label).catch(() => null) : null;
        let how: string;
        let at: { x: number; y: number };
        if (f) {
          same(f.box, c, `the field by "${label}"`);
          await type(page, label, text);
          visit.push({ type: label, value: token });
          at = centre(f.box);
          how = `"${label}"`;
        } else {
          if (!['textbox', 'password'].includes(c.role))
            throw new ToolRefusal(
              `the page's words don't hold "${label}", and ${i.id ?? 'that position'} is a ${c.role}, not a field: choose the field by its id`,
            );
          const anchor = await sightAnchor(c, label);
          at = centre(c.box);
          await typeAt(page, at, text);
          visit.push({ type: label, value: token, at: anchor });
          how = `${i.id ?? 'the field'}, by its position (the label "${label}" is not in the page's words)`;
        }
        // The sign-in and the code go into fields the allowlists know by their own names: the bank's
        // name for each is kept, so the guard knows them when the table runs.
        const listed = { user_id: 'Operator ID', password: 'Password', code: 'Code' }[
          i.value as 'user_id' | 'password' | 'code'
        ];
        if (listed && listed !== label) {
          t.names ??= {};
          t.names[listed] = [...new Set([...(t.names[listed] ?? []), label])];
        }
        const held = await holds(at, secretValue(i.value));
        return look(`typed the ${i.value.replace('_', ' ')} into ${how}${held}`, i.why);
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
        const held = await holds(p, secretValue(i.value));
        return look(
          `typed the ${i.value.replace('_', ' ')} into ${it.id}, the ${it.kind} labeled "${it.label}" (${it.labelFrom}), by clicking ${Math.round(p.x)},${Math.round(p.y)}${held}`,
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
    choose_item: {
      description:
        "Chooses the task's from or to account in a list from your list_page, by its position: the browser reads the list's options, the mouse clicks the list, and the keyboard types the option holding the account.",
      input: z.object({
        item: z.string().regex(/^i\d{1,3}$/),
        account: z.enum(['from', 'to']),
        why: z.string().min(3).max(200),
      }),
      async run(i: { item: string; account: 'from' | 'to'; why: string }) {
        mayAct();
        const it = itemOf(i.item, ['list']);
        if (!it.labelBox)
          throw new ToolRefusal(
            `${it.id} has no label box: list the page again with its label's box`,
          );
        const at = await anchorOf(it, it.labelBox);
        const p = centre(it.box);
        await chooseAt(page, p, account(i.account === 'from' ? task.from : task.to)).catch(
          (e: Error) => {
            if (e instanceof TargetError) throw new ToolRefusal(e.message);
            throw e;
          },
        );
        visit.push({
          choose: it.label,
          containing: i.account === 'from' ? '$from' : '$to',
          at,
        });
        return look(
          `chose the ${i.account} account in ${it.id}, the list labeled "${it.label}" (${it.labelFrom}), at ${Math.round(p.x)},${Math.round(p.y)}`,
          i.why,
        );
      },
    },
    browser_choose: {
      description:
        "Chooses the task's from or to account in the list you choose, by its id, and the label beside it. When the page's words hold the label, the list is found by it; when they don't, the list the id names is chosen at its position.",
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
        const want = account(i.account === 'from' ? task.from : task.to);
        const refuse = (e: Error) => {
          if (e instanceof TargetError) throw new ToolRefusal(e.message);
          throw e;
        };
        const containing = i.account === 'from' ? '$from' : '$to';
        // Structure first, sight in the same call, as browser_type.
        const f = inWords(i.label) ? await field(page, i.label).catch(() => null) : null;
        if (f) {
          same(f.box, c, `the list by "${i.label}"`);
          await choose(page, i.label, want).catch(refuse);
          visit.push({ choose: i.label, containing });
          return look(`chose the ${i.account} account in "${i.label}"`, i.why);
        }
        if (c.role !== 'select')
          throw new ToolRefusal(
            `the page's words don't hold "${i.label}", and ${i.id ?? 'that position'} is a ${c.role}, not a list: choose the list by its id`,
          );
        const anchor = await sightAnchor(c, i.label);
        await chooseAt(page, centre(c.box), want).catch(refuse);
        visit.push({ choose: i.label, containing, at: anchor });
        return look(
          `chose the ${i.account} account in ${i.id ?? 'the list'}, by its position (the label "${i.label}" is not in the page's words)`,
          i.why,
        );
      },
    },
    name_page: {
      description:
        'Names the screen now, for your route, by words it shows as text that tell it apart from every other screen. Name each screen before you leave it: the steps you take here are filed under it. Leave `never` out: the tool adds words of your other screens that this one does not show.',
      input: z.object({
        name: z.string().min(2).max(40),
        shows: z.array(z.string().min(2).max(80)).min(1).max(4),
        never: z.array(z.string().min(2).max(80)).max(4).optional(),
      }),
      async run(i: { name: string; shows: string[]; never?: string[] }) {
        if (nameFirst)
          throw new ToolRefusal(
            "this page shows the member's number: note_read name first, then name the page",
          );
        if (!latest?.ref) throw new ToolRefusal('look at the page first');
        const f = latest.frame;
        const missing = i.shows.filter((w) => !shows(f, w));
        if (missing.length) {
          // Words drawn as pictures are not text the crawler can find: say which words are.
          const text = f.tree
            .split('\n')
            .map(leaf)
            .filter((w): w is string => !!w && w.length >= 3)
            .slice(0, 15);
          throw new ToolRefusal(
            `the page does not show as text: ${missing.join('; ')}. Words it does show as text include: ${text.join('; ')}`,
          );
        }
        const wrong = (i.never ?? []).filter((w) => shows(f, w));
        if (wrong.length)
          throw new ToolRefusal(
            `the page shows what you said it never does: ${wrong.join('; ')}. Leave never out: the tool adds it`,
          );
        // Never-words: the other screens' own words that this screen does not show, so a menu that
        // repeats on every screen is never one of them.
        const never =
          i.never ??
          t.rows
            .filter((r) => r.page !== i.name)
            .flatMap((r) => r.shows)
            .filter((w, k, all) => !shows(f, w) && all.indexOf(w) === k)
            .slice(0, 3);
        const old = t.rows.find((r) => r.page === i.name);
        const next: Row = {
          page: i.name,
          shows: i.shows,
          ...(never.length ? { never } : {}),
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
        "Notes how a value is read on this screen, for code to read it again. Point at each value: `parts` gives each placeholder with the label just before its value (`after`), or the words you see (`is`), and the tool writes the pattern from the page's own lines. Or write the pattern yourself in `text`: the visible lines, one per \\n, each value as a {placeholder}. balance: one account's line, {name} {last4} {available} {current}. review: {from} {to} {amount} {memo}. confirmation: {confirmation}. name: where the member's name shows, {name}. Characters shown as █ are hidden by us: a placeholder goes there, never the █. The tool reads the page with the crawler's own code, with the task's accounts, and keeps the read only if it works.",
      input: z.object({
        what: z.enum(['balance', 'review', 'confirmation', 'name']),
        text: z.string().min(5).max(400).optional(),
        parts: z
          .array(
            z.object({
              placeholder: z.string().min(2).max(20),
              after: z.string().min(1).max(60).optional(),
              is: z.string().min(1).max(80).optional(),
            }),
          )
          .min(1)
          .max(6)
          .optional(),
      }),
      async run(i: {
        what: 'balance' | 'review' | 'confirmation' | 'name';
        text?: string;
        parts?: { placeholder: string; after?: string; is?: string }[];
      }) {
        if (!latest) throw new ToolRefusal('look at the page first');
        const need = {
          balance: ['name', 'last4', 'available', 'current'],
          review: ['from', 'to', 'amount', 'memo'],
          confirmation: ['confirmation'],
          name: ['name'],
        }[i.what];
        // The page's lines, as the crawler reads them, and as the masking rule shows them: the same
        // lines, character for character, so what the Scout sees points into what the crawler reads.
        const real = await leaves(page);
        const shown = real.map((l) => maskText(l, known));
        const around = (hint: string) => {
          const k = Math.max(
            0,
            shown.findIndex((l) => hint && l.includes(hint)),
          );
          return shown
            .slice(Math.max(0, k - 3), k + 9)
            .map((l, n) => `  ${Math.max(0, k - 3) + n + 1}: ${l}`)
            .join('\n');
        };
        if (i.text && i.parts)
          throw new ToolRefusal('give the read as parts or as text, not both: parts are best');
        let text = i.text;
        if (!text && i.parts) text = pointed(i.what, i.parts, real, shown, task);
        if (!text) throw new ToolRefusal('give the read as parts, or as text');
        if (text.includes('█'))
          throw new ToolRefusal(
            `█ is our masking, not the page's words: put a placeholder where a hidden value is. The page's lines:\n${around(text.split('█')[0]!.split('\n').at(-1)!.trim())}`,
          );
        const has = [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
        const lacking = need.filter((n) => !has.includes(n));
        if (lacking.length)
          throw new ToolRefusal(`the read needs {${lacking.join('}, {')}}: ${text}`);
        const literal = text.replace(/\{\w+\}/g, '').replace(/\$member/g, '');
        if (maskText(literal, known) !== literal)
          throw new ToolRefusal(
            `the pattern keeps a value the masking rule hides (${maskText(literal, known)}): put a placeholder there`,
          );
        const words = real.join('\n');
        const first = text
          .split('\n')[0]!
          .split(/\{\w+\}|\$member/)[0]!
          .trim();
        const fail = (what: string): never => {
          throw new ToolRefusal(
            `the crawler, reading this page with your pattern, ${what}. Your pattern: ${JSON.stringify(text)}. The page's lines, as the crawler reads them, one pattern line each:\n${around(first)}`,
          );
        };
        let found: string;
        if (i.what === 'balance') {
          const { all, matching } = accountsIn(words, text, task.member, task.from ?? '');
          if (!all.length) fail('finds no account');
          // With no account to check, it can only say the accounts are read.
          if (!task.from) matching.splice(0, matching.length, all[0]!);
          if (matching.length !== 1)
            fail(
              `finds ${all.length} accounts (${all.map((g) => maskText(`${g.name} / ${g.last4}`, known)).join('; ')}), and ${matching.length} of them hold the task's account ${task.from}`,
            );
          const g = matching[0]!;
          if (Number.isNaN(cents(g.available ?? '')) || Number.isNaN(cents(g.current ?? '')))
            fail('reads balances that are not amounts of money');
          found = `${all.length} accounts; the task's account ${task.from} is "${g.name}" (${g.last4})`;
        } else if (i.what === 'review') {
          const g = readOf(text).exec(words)?.groups;
          if (!g) fail('matches nothing');
          const r = g!;
          const holds = (v: string | undefined, a: string | undefined) =>
            !!a && !!v && v.includes(a);
          if (!holds(r.from, task.from) || !holds(r.to, task.to))
            fail(
              `reads From ${maskText(r.from ?? '', known)} and To ${maskText(r.to ?? '', known)}, which should hold ${task.from} and ${task.to}`,
            );
          if (cents(r.amount ?? '') !== task.amountCents)
            fail("reads an amount that is not the task's");
          if (task.memo && !(r.memo ?? '').includes(task.memo))
            fail("reads a memo that is not the task's");
          found = `From ${maskText(r.from!, known)}, To ${maskText(r.to!, known)}, the task's amount and memo`;
        } else if (i.what === 'name') {
          // A name read is anchored on the member's own number: it can never take another line.
          if (!text.includes('$member'))
            fail(
              "is not anchored on the member's number: point at the name on a line next to the member's number",
            );
          if (!readOf(text, task.member).exec(words)?.groups?.name) fail('finds no name');
          found = "the member's name, which is hidden from now on";
        } else {
          if (!readOf(text).exec(words)?.groups?.confirmation) fail('finds no confirmation');
          found = 'a confirmation';
        }
        t.reads =
          i.what === 'name'
            ? { ...t.reads, name: [...(t.reads.name ?? []).filter((n) => n !== text), text] }
            : { ...t.reads, [i.what]: text };
        await trail.step(
          { name: 'note read', action: `${i.what}: ${text}`, outcome: found! },
          null,
        );
        if (i.what === 'name') {
          await learnName();
          if (nameFirst) {
            // The page again, with the member's name hidden: now it is kept.
            nameFirst = false;
            const again = await see(page, { known, limitMs: 15_000, everyMs: 150 });
            const kept = await trail.step(
              { name: task.goal, action: "the page again, the member's name hidden" },
              again,
            );
            latest = { frame: again, ref: kept?.ref ?? null, controls: latest.controls };
          }
        }
        return { text: `Noted, citing ${latest.ref}: ${text}\nThe crawler reads ${found!}.` };
      },
    },
    goal_reached: {
      description:
        "Says the goal is reached on the screen now (the balance shows; the transfer's review; the account's activity). The Supervisor checks your route first: every screen from the start named, each with its own steps. For a transfer, `submit` is the control that would send it, by its id (c3, or i2 from your list_page) or its name: named, never pressed.",
      input: z.object({ submit: z.string().max(60).optional() }),
      async run(i: { submit?: string }) {
        if (!latest?.ref || !row) throw new ToolRefusal('name this page first');
        if (task.goal === 'transfer') {
          const s = i.submit?.trim() ?? '';
          // By id or by name; a send button drawn as a picture has a place, and the crawler finds it
          // there by sight.
          const c = /^c\d{1,3}$/.test(s)
            ? latest.controls[Number(s.slice(1)) - 1]
            : latest.controls.find((x) => x.name === s);
          const it = /^i\d{1,3}$/.test(s) ? inventory?.find((x) => x.id === s) : undefined;
          const box = c?.box ?? it?.box;
          if (!box)
            throw new ToolRefusal(
              `name the control on this page that would send the transfer, by its id or its name; the buttons here: ${
                latest.controls
                  .flatMap((x, k) => (x.role === 'button' ? [`c${k + 1} "${x.name}"`] : []))
                  .join(', ') || 'none'
              }`,
            );
          const kind = (await whatIsAt(page, centre(box))).kind;
          const wide = { x: box.x - 40, y: box.y - 12, w: box.w + 80, h: box.h + 24 };
          const item: Item = {
            id: s,
            kind,
            label: c?.name ?? it?.label ?? '',
            labelFrom: 'text',
            box,
          };
          const at = await anchorOf(item, box).catch(() => anchorOf(item, wide));
          t.submit = { press: c?.name || it?.label || 'Submit', frame: latest.ref, at };
        }
        fileVisit(row);
        // The Supervisor checks the route before the goal counts: every screen named, each with its
        // own steps. A "wait" sends the Scout back to fix it.
        const j = await deps.judge({
          action: `goal reached: ${task.goal} on "${row.page}"`,
          why: 'the goal screen shows',
          frame: latest.frame,
          ref: latest.ref,
          record: taken(),
          route: { ...t, ends: { ...t.ends, [task.goal]: row.page } },
        });
        if (j.verdict === 'wait' || j.verdict === 'end')
          throw new ToolRefusal(`the Supervisor has not accepted the route yet: ${j.says}`);
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
      await trail.step(
        {
          name: 'refused',
          action: `${name} · input ${maskText(JSON.stringify(input), known).slice(0, 2000)}`,
          outcome: why,
        },
        null,
      );
      // A failure is judged at once, on the latest picture: the Scout never moves on unseen.
      if (latest && role === 'scout') {
        const j = await deps.judge({
          action: `${name} was refused`,
          why: String((input as { why?: unknown } | null)?.why ?? ''),
          frame: latest.frame,
          ref: latest.ref,
          record: taken(),
          route: t,
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
      // What the Supervisor reads of a result: whole, or said to be cut, never cut unseen.
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
    /** The table as written so far. */
    table: () => t,
    latest: () => latest,
    done: () => stopped,
  };
}

export type Scout = ReturnType<typeof scout>;
