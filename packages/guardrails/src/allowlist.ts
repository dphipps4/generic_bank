// The allowlist (plan, §J.1) and the decision every action passes before it reaches the browser.
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
  /** Typed only from the vault by the Runner, never as plain text. */
  secret?: true;
}

export type Layer = 'task allowlist' | 'element' | 'approval grant' | 'secret typing';

export type Verdict = { allowed: true } | { allowed: false; rule: string; layer: Layer };

export interface Context {
  /** What consumeGrant returned for this click, for a money-moving press. */
  grant?: GrantCheck;
  /** The Runner is typing a value from the vault, not text it was given. */
  secret?: boolean;
}

export const JOBS = [
  'check-balance',
  'download-statements',
  'transfer',
] as const satisfies readonly TaskName[];

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
 * Words that move money or change an account (plan, §J.2, "Session guard: element"), matched at
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

const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();

const moneyish = (screen: string, control: string) =>
  MONEY_WORDS.test(control) || (MONEY_SCREENS.has(screen) && norm(control) === 'continue');

/** Whether the job may take this action on this screen, and if not, which rule and layer refuse. */
export function decide(
  job: TaskName,
  screen: string,
  verb: Verb,
  control: string,
  ctx: Context = {},
): Verdict {
  const entry = ALLOWLISTS[job]?.find(
    (e) => e.screen === screen && e.verb === verb && norm(e.control) === norm(control),
  );
  const what = `${job} does not ${verb} "${control}" on ${screen}`;
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
      rule: `"${entry.control}" is typed only from the vault`,
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
