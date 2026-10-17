// The allowlist (plan, §A.5) and the decision every action passes before it reaches the browser.
// The files in allowlists/ are the list: the guard enforces them and the Console renders them, so
// what a person reads is what runs. A decision judges the job, the screen, the verb and the
// control's visible name, and nothing a page says: injected instructions have no way in.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TaskName } from '@gb/contracts';
import { type GrantCheck, isConsumedGrant } from './grants.js';

export const VERBS = ['type', 'press', 'choose', 'read', 'open'] as const;
export type Verb = (typeof VERBS)[number];

export interface Entry {
  screen: string;
  verb: Verb;
  /** The control's visible name; "Page" for reading the screen itself. */
  control: string;
  /** Moves money: allowed only with a consumed approval grant. */
  money?: true;
  /** Typed only from a stored secret by the Runner, never as plain text. */
  secret?: true;
}

export type Layer = 'task allowlist' | 'element' | 'approval grant' | 'secret typing';

export type Verdict = { allowed: true } | { allowed: false; rule: string; layer: Layer };

/**
 * A bank's own names for the controls the lists name: "Sign In" may be drawn "Log In". The list's
 * name always counts too. A pattern is for a control the product draws with names of its own (a
 * drop-down menu's title).
 */
export type Names = Readonly<Record<string, readonly (string | RegExp)[]>>;

export interface Context {
  /** What consumeGrant returned for this click, for a money-moving press. */
  grant?: GrantCheck;
  /** The Runner is typing a stored secret, not text it was given. */
  secret?: boolean;
  /** What is typed as plain text. */
  typed?: string;
  /** The stored secrets (the operator's password, never the username): plain text that holds one is refused. */
  secrets?: readonly string[];
  /** The bank's names for the listed controls. */
  names?: Names;
}

/** A refusal, thrown. It trips the guard; nothing may catch it to carry on (plan, §9). */
export class GuardError extends Error {
  constructor(
    readonly layer: Layer,
    readonly rule: string,
  ) {
    super(`refused by the ${layer} guard: ${rule}`);
    this.name = 'GuardError';
  }
}

/** The screen an entry names when it holds on every screen, an unknown one too. */
export const ANY = 'any';

export const JOBS = ['check-balance', 'transfer'] as const satisfies readonly TaskName[];

const dir = join(import.meta.dirname, '../allowlists');

function load(file: string): Entry[] {
  const { allowed } = JSON.parse(readFileSync(join(dir, `${file}.json`), 'utf8')) as {
    allowed: Entry[];
  };
  // A list the guard cannot read exactly is not a list: refuse to start rather than guess.
  for (const e of allowed)
    if (!e.screen || !e.control || !VERBS.includes(e.verb))
      throw new Error(`allowlists/${file}.json has an entry the guard cannot read`);
  return allowed;
}

const EVERY_JOB = load('every-job');

/** Each job's whole list: what every job may do, then its own. */
export const ALLOWLISTS: Readonly<Record<TaskName, readonly Entry[]>> = Object.fromEntries(
  JOBS.map((j) => [j, [...EVERY_JOB, ...load(j)]]),
) as Record<TaskName, Entry[]>;

/**
 * Words that move money or change an account (plan, §9, "Session guard: element"), matched at
 * the start of a word, so "Payment" and "Transfers" count too. A wrong match only refuses.
 */
export const MONEY_WORDS =
  /\b(pay|transfer|submit|add payee|enrol|update|go paperless|waive|change address|close account)/i;

/** Screens where money moves: a generic "Continue" here counts as money. */
export const MONEY_SCREENS: ReadonlySet<string> = new Set([
  'transfer.form',
  'transfer.review',
  'supervisor_approval',
]);

/** Never on any list (plan, §A.5): refused on every screen, whatever a bank calls its controls. */
export const NEVER = [
  'Pay now',
  'Add payee',
  'Change address',
  'Waive fee',
  'Enroll in eStatements',
  'Close account',
  'Admin',
  'Reports',
] as const;

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/\s*:\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const moneyish = (screen: string, control: string) =>
  MONEY_WORDS.test(control) || (MONEY_SCREENS.has(screen) && norm(control) === 'continue');

/** A click presses a button or opens a link, and a bank draws either: the list's press or open allows it. */
const CLICK: ReadonlySet<Verb> = new Set(['press', 'open']);
const sameVerb = (a: Verb, b: Verb) => a === b || (CLICK.has(a) && CLICK.has(b));

const named = (e: Entry, control: string, names: Names = {}) =>
  [e.control, ...(names[e.control] ?? [])].some((n) =>
    typeof n === 'string' ? norm(n) === norm(control) : n.test(control.trim()),
  );

/** Whether plain text holds a stored secret; a secret too short to tell apart is not looked for. */
const holdsSecret = (text: string, secrets: readonly string[]) =>
  secrets.some((s) => s.length >= 4 && text.includes(s));

/** Whether the job may take this action on this screen, and if not, which rule and layer refuse. */
export function decide(
  job: TaskName,
  screen: string,
  verb: Verb,
  control: string,
  ctx: Context = {},
): Verdict {
  const what = `${job} does not ${verb} "${control}" on ${screen}`;
  if (NEVER.some((n) => norm(control).startsWith(norm(n))))
    return { allowed: false, layer: 'element', rule: `"${control}" is never on any list` };
  if (ctx.typed !== undefined && holdsSecret(ctx.typed, ctx.secrets ?? []))
    return {
      allowed: false,
      layer: 'secret typing',
      rule: `plain text for "${control}" holds a stored secret`,
    };
  const entry = ALLOWLISTS[job]?.find(
    (e) =>
      (e.screen === screen || e.screen === ANY) &&
      sameVerb(e.verb, verb) &&
      named(e, control, ctx.names),
  );
  if (!entry) {
    if (moneyish(screen, control))
      return {
        allowed: false,
        layer: 'element',
        rule: `"${control}" moves money or changes the account, and ${what}`,
      };
    return { allowed: false, layer: 'task allowlist', rule: what };
  }
  if (entry.secret && ctx.secret !== true)
    return {
      allowed: false,
      layer: 'secret typing',
      rule: `"${entry.control}" is typed only from a stored secret`,
    };
  if (!entry.secret && ctx.secret === true)
    return {
      allowed: false,
      layer: 'secret typing',
      rule: `a secret is typed only into a field the list marks secret, not "${entry.control}"`,
    };
  if (entry.money && !isConsumedGrant(ctx.grant))
    return {
      allowed: false,
      layer: 'approval grant',
      rule: `"${entry.control}" needs an approval grant: ${
        ctx.grant && !ctx.grant.ok ? ctx.grant.reason : 'none was presented'
      }`,
    };
  return { allowed: true };
}
