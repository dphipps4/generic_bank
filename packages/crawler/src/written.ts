// A crawler the factory's Scout writes: code and data that need no reasoning to run. It is plain
// JavaScript, kept as text, and run here with nothing but a `site` to act through. Every action it
// takes is judged by the guard and kept as a frame, and what it returns is checked by code before
// anything is believed: the account it read is the task's, the amounts are money, the review holds
// the task's own accounts, amount and memo.
import { runInNewContext } from 'node:vm';
import type { ResultCode } from '@gb/contracts';
import { CODES } from '@gb/contracts';
import {
  type Box,
  chooseAt,
  clickAt,
  type Control,
  type Frame,
  press as pressByName,
  see,
  type as typeByLabel,
  choose as chooseByLabel,
  typeAt,
} from '@gb/runtime';

/** A written crawler as it is stored, in place of a table. */
export interface Written {
  kind: 'written';
  source: string;
}

export const isWritten = (t: unknown): t is Written =>
  !!t && typeof t === 'object' && (t as Written).kind === 'written';

/** What a written crawler defines. `send` names the control that would send a transfer. */
export interface Module {
  balance(
    site: Site,
    task: Facts,
  ): Promise<{ account: string; available: string; current: string }>;
  transfer(site: Site, task: Facts): Promise<void>;
  review(
    site: Site,
    task: Facts,
  ): Promise<{ from: string; to: string; amount: string; memo: string }>;
  history(site: Site, task: Facts): Promise<void>;
  name?(lines: string[], member: string): string | null | undefined;
  send: Target;
}

/** What the crawler is told of its task: never a secret. */
export interface Facts {
  member: string;
  from?: string;
  to?: string;
  amount?: string;
  memo?: string;
}

/** A control: its drawn name, the n-th visible field (from 0), or a point on the page. */
export type Target =
  string | { name: string; near?: string } | { field: number } | { x: number; y: number };

/** The values a crawler may type or choose, by name: code supplies them, the crawler never sees a secret. */
export const VALUES = ['user_id', 'password', 'code', 'member', 'amount', 'memo'] as const;
export type Value = (typeof VALUES)[number];

/** The one thing a written crawler acts through. */
export interface Site {
  open(path?: string): Promise<void>;
  look(): Promise<{ lines: string[]; controls: Control[] }>;
  shows(words: string): Promise<boolean>;
  wait(seconds: number): Promise<void>;
  press(target: Target): Promise<void>;
  type(target: Target, value: Value): Promise<void>;
  choose(target: Target, account: 'from' | 'to'): Promise<void>;
  stop(code: string, why: string): never;
}

/** What the crawler may not hold: anything that reaches past `site`, or runs code of its own. */
const FORBIDDEN =
  /\b(require|import|export|process|globalThis|global|eval|Function|constructor|prototype|__proto__|fetch|XMLHttpRequest|WebSocket|setInterval|setTimeout|Proxy|Reflect|this|window|document|Buffer|module|exports)\b/;
const NEEDS = ['balance', 'transfer', 'review', 'history', 'send'] as const;

/** Strings and comments out, so a word in a string is not taken for code. */
const codeOnly = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/`(?:\\[\s\S]|[^`\\])*`|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g, '""');

/**
 * What is wrong with a crawler's source, before it ever runs: empty when nothing is. It may not reach
 * past `site`, may not hold the task's own values (they come in `task`), and must define every part.
 */
export function lint(
  source: string,
  task?: { member?: string; from?: string; to?: string },
): string[] {
  const out: string[] = [];
  if (source.length > 30_000) out.push('it is over 30,000 characters');
  const code = codeOnly(source);
  const bad = code.match(new RegExp(FORBIDDEN, 'g'));
  if (bad) out.push(`it uses ${[...new Set(bad)].join(', ')}: a crawler acts only through site`);
  for (const n of NEEDS)
    if (!new RegExp(`\\b(async\\s+function\\s+${n}\\b|(const|let|var)\\s+${n}\\b)`).test(code))
      out.push(`it does not define ${n}`);
  for (const v of [task?.member, task?.from, task?.to])
    if (v && source.includes(v)) out.push(`it holds the task's own value ${v}: read it from task`);
  if (/\d{5,}/.test(code))
    out.push('it holds a number of five or more digits: values come from task');
  try {
    runInNewContext(`(async () => {\n${source}\n})`, {}, { timeout: 1000 });
  } catch (e) {
    out.push(`it does not parse: ${(e as Error).message}`);
  }
  return out;
}

/** The crawler's parts, from its source, in a context that holds nothing but the language itself. */
export function load(source: string): Module {
  const problems = lint(source);
  if (problems.length) throw new Error(`the crawler is refused: ${problems.join('; ')}`);
  const body = `${source}
;({ balance, transfer, review, history, send,
    name: typeof name === 'function' ? name : undefined })`;
  return runInNewContext(`"use strict";\n${body}`, Object.create(null), {
    timeout: 1000,
  }) as Module;
}

/** Thrown by a crawler's `site.stop`: the bank's own answer, with the code it means. */
export class Answered extends Error {
  constructor(
    readonly code: ResultCode,
    why: string,
  ) {
    super(why);
  }
}

const allCodes = new Set<string>(Object.values(CODES).flatMap((g) => Object.keys(g)));

/** The task's value for a name; a secret only from the credentials or a person, never from the crawler. */
export interface Supply {
  value(v: Value): Promise<string>;
  account(which: 'from' | 'to'): string;
}

export interface Hands {
  page: import('playwright-core').Page;
  url: string;
  known: string[];
  limitMs?: number;
  /** Judges each action before it reaches the browser; throws to refuse. */
  guard?(a: {
    screen: string;
    verb: 'type' | 'press' | 'choose' | 'read';
    control: string;
    secret?: boolean;
    typed?: string;
  }): void;
  /** Each page after an action, already masked. */
  keep?(did: string, f: Frame): Promise<void> | void;
  /** Learns names to hide from what a page shows (the crawler's own `name`). */
  learn?(lines: string[]): void;
  /** The crawler's own send control: pressing it is judged as a send, whatever it is called. */
  send?: Target;
}

const centre = (b: Box) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
const within = (p: { x: number; y: number }, b: Box) =>
  p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h;

/** The site a written crawler acts through, for one run. */
export function siteFor(
  h: Hands,
  supply: Supply,
  lines: () => Promise<string[]>,
): Site & { latest(): Frame | null } {
  let latest: Frame | null = null;
  const after = async (did: string) => {
    h.learn?.(await lines());
    latest = await see(h.page, { known: h.known, limitMs: h.limitMs ?? 30_000 });
    await h.keep?.(did, latest);
  };
  const fields = async () => {
    const f = latest ?? (await see(h.page, { known: h.known, limitMs: h.limitMs ?? 30_000 }));
    latest = f;
    return f.controls.filter((c) => ['textbox', 'password', 'select', 'combobox'].includes(c.role));
  };
  /** A point's control, for the guard to judge by its drawn name. */
  const nameAt = (p: { x: number; y: number }) =>
    latest?.controls.find((c) => within(p, c.box))?.name ?? '';
  const pointOf = async (t: Target): Promise<{ x: number; y: number } | null> => {
    if (typeof t === 'object' && 'x' in t) return { x: t.x, y: t.y };
    if (typeof t === 'object' && 'field' in t) {
      const f = (await fields())[t.field];
      if (!f) throw new Error(`there is no field ${t.field} on this page`);
      return centre(f.box);
    }
    return null;
  };
  const describe = (t: Target) => (typeof t === 'string' ? `"${t}"` : JSON.stringify(t));
  return {
    latest: () => latest,
    async open(path) {
      const url = new URL(path ?? h.url, h.url);
      if (url.host !== new URL(h.url).host) throw new Error(`${url.host} is not this site`);
      await h.page.goto(url.href);
      await after(`opened ${url.pathname}`);
    },
    async look() {
      h.learn?.(await lines());
      latest = await see(h.page, { known: h.known, limitMs: h.limitMs ?? 30_000 });
      return { lines: await lines(), controls: latest.controls };
    },
    async shows(words) {
      return (await lines()).some((l) => l.includes(words));
    },
    async wait(seconds) {
      await new Promise((r) => setTimeout(r, Math.min(10, Math.max(0, seconds)) * 1000));
      await after(`waited ${seconds} s`);
    },
    async press(t) {
      const p = await pointOf(t);
      const name = p ? nameAt(p) : typeof t === 'string' ? t : (t as { name: string }).name;
      const sends = h.send !== undefined && JSON.stringify(t) === JSON.stringify(h.send);
      h.guard?.({
        screen: 'written',
        verb: 'press',
        control: sends
          ? `Submit (the crawler's send control, ${describe(t)})`
          : name || describe(t),
      });
      if (p) await clickAt(h.page, p);
      else if (typeof t === 'string') await pressByName(h.page, t);
      else {
        const n = t as { name: string; near?: string };
        await pressByName(h.page, n.name, n.near ? { near: n.near } : {});
      }
      await after(`pressed ${describe(t)}`);
    },
    async type(t, v) {
      if (!VALUES.includes(v)) throw new Error(`${String(v)} is not a value a crawler may type`);
      const text = await supply.value(v);
      if (v === 'code' && !h.known.includes(text)) h.known.push(text);
      const secret = v === 'password' || v === 'user_id';
      h.guard?.({
        screen: 'written',
        verb: 'type',
        control: typeof t === 'string' ? t : describe(t),
        ...(secret ? { secret: true } : { typed: text }),
      });
      const p = await pointOf(t);
      if (p) await typeAt(h.page, p, text);
      else
        await typeByLabel(h.page, typeof t === 'string' ? t : (t as { name: string }).name, text);
      await after(`typed the ${v.replace('_', ' ')} into ${describe(t)}`);
    },
    async choose(t, which) {
      const want = supply.account(which);
      h.guard?.({
        screen: 'written',
        verb: 'choose',
        control: typeof t === 'string' ? t : describe(t),
      });
      const p = await pointOf(t);
      if (p) await chooseAt(h.page, p, want);
      else
        await chooseByLabel(h.page, typeof t === 'string' ? t : (t as { name: string }).name, want);
      await after(`chose the ${which} account in ${describe(t)}`);
    },
    stop(code, why) {
      if (!allCodes.has(code)) throw new Error(`${code} is not a result code`);
      throw new Answered(code as ResultCode, why);
    },
  };
}

/** The send control, for the one press a person's grant allows: by name or at its place. */
export async function pressSend(h: Hands, send: Target) {
  const site = siteFor(h, { value: async () => '', account: () => '' }, async () => []);
  await site.look();
  await site.press(send);
}
