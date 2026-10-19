// A bank, as the crawler knows it: data only. Each row is a page, known by the words visible on it,
// and the steps a teller takes there, per task. The bank's answers and its trouble are words too.
// Every entry cites the evidence frame it was read from. Writing a bank's table is onboarding it;
// editing rows is repairing it.
import type { ResultCode } from '@gb/contracts';

/** What a run is for: a balance, a transfer up to its review, or the transfer in the history. */
export type Goal = 'balance' | 'transfer' | 'history';

/**
 * A teller's step. Values are the task's: `$operator`, `$password`, `$code` (a person gives it),
 * `$member`, `$from`, `$to` (an account's name, or its last four digits, however a bank words them),
 * `$amount`, `$memo`.
 */
/**
 * Where a step acts, when it was learned by sight: the anchor (a small crop of the screen, a
 * label drawn as text or as a picture, as a base64 PNG), the offset from the anchor's middle to
 * the point to act on, and the kind of control the browser must have there.
 */
export interface At {
  anchor: string;
  dx: number;
  dy: number;
  kind: string;
}

export type Step =
  | { type: string; value: string; at?: At }
  | { press: string; near?: string; at?: At }
  | { choose: string; containing: string; at?: At };

export interface Row {
  page: string;
  /** The allowlist's name for this page, where it differs: the guard judges every step by it. */
  screen?: string;
  shows: string[];
  never?: string[];
  /** Pictures the page shows (words drawn as images), as cut-outs: it is known by sight too. */
  looks?: string[];
  /** The steps, per goal; `any` for every goal. A row with none for a goal is where it ends. */
  do: Partial<Record<Goal | 'any', Step[]>>;
  frame: string;
}

export interface Answer {
  says: string;
  code: ResultCode;
  retryable?: boolean;
  frame: string;
}

/** Trouble: start again from home, at most `again` times, and only before Submit; then `code`. */
export interface Trouble {
  says: string;
  code: ResultCode;
  again: number;
  frame: string;
}

/**
 * A read as the pattern it matches against the page's visible words, one per line: the text as it
 * is, each `{placeholder}` the words on its line up to what follows it.
 */
export function readOf(template: string, member = ''): RegExp {
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const src = template
    .split(/(\{\w+\})/)
    .map((p) => {
      const ph = /^\{(\w+)\}$/.exec(p);
      return ph ? `(?<${ph[1]}>.+?)` : escape(p).replace(/\\\$member/g, escape(member));
    })
    .join('');
  return new RegExp(`^${src}$`, 'gm');
}

export interface Table {
  bank: string;
  /** The console's home, an address the frames show, from the bank's URL; the sign-in follows if it must. */
  home: string;
  rows: Row[];
  /** The bank's own names for controls the allowlists name ("Open" for "Matching member"). */
  names?: Record<string, string[]>;
  /** Where each goal ends. */
  ends: Record<Goal, string>;
  answers: Answer[];
  trouble: Trouble[];
  /** The one press that moves money: never in a row, pressed once under a person's approval. */
  submit: { press: string; frame: string; at?: At };
  /**
   * Reading values off a page. Each read is visible text, one line per `\n`, with `{placeholders}`
   * for the values and `$member` for the member's number; see `readOf`.
   */
  reads: {
    /** On the summary, per account: `{name}`, `{last4}`, `{available}`, `{current}`. */
    balance: string;
    /** On the review: `{from}`, `{to}`, `{amount}`, `{memo}`. */
    review: string;
    /** On the posted page: `{confirmation}`. */
    confirmation: string;
    /** Where the member's name shows, `{name}`: learned when it first shows, masked from then on. */
    name: string[];
  };
}
