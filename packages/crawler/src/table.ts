// A bank, as the crawler knows it: data only. Each row is a page, known by the words visible on it,
// and the steps a teller takes there, per task. The bank's answers and its trouble are words too.
// Every entry cites the evidence frame it was read from. Writing a bank's table is onboarding it;
// editing rows is repairing it.
import type { ResultCode } from '@gb/contracts';

/** What a run is for: a balance, a transfer up to its review, or the transfer in the history. */
export type Goal = 'balance' | 'transfer' | 'history';

/**
 * A teller's step. Values are the task's: `$operator`, `$password`, `$code` (a person gives it),
 * `$member`, `$from`, `$to` (an account's name, or "ending in" its last four), `$amount`, `$memo`.
 */
export type Step =
  | { type: string; value: string }
  | { press: string; near?: string }
  | { choose: string; containing: string };

export interface Row {
  page: string;
  /** The allowlist's name for this page, where it differs: the guard judges every step by it. */
  screen?: string;
  shows: string[];
  never?: string[];
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
  submit: { press: string; frame: string };
  /** Reading values off a page, unmasked; the groups are named. */
  reads: {
    /** On the summary, per account, one line of visible text each: `name`, `last4`, `available`, `current`. */
    balance: RegExp;
    /** On the review: `from`, `to`, `amount`, `memo`. */
    review: RegExp;
    /** On the posted page: `confirmation`. */
    confirmation: RegExp;
    /** In the activity: a row of the transfer, with `$memo` in place of the memo. */
    history: string;
    /**
     * Where the member's name shows, with `$member` for their number: learned when it first shows,
     * and masked from then on. Each pattern is matched against the visible words, one per line.
     */
    name: string[];
  };
}
