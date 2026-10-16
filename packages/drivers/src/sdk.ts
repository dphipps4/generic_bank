// The driver SDK (plan, §E.5). A driver is the crawler's knowledge of one product's screens, as a
// state machine per task; a profile adapts it to one bank. Drivers never touch the browser
// directly: they see screen models and act through the screen package, by meaning.
import type { ResultCode } from '@gb/contracts';
import {
  type KnownPicture,
  namePictures,
  type Page,
  recognize,
  type Recognition,
  type ScreenModel,
  type Signature,
  waitFullyRendered,
} from '@gb/screen';

/** One bank, as a driver needs to know it. Data only: onboarding a bank is writing one of these. */
export interface Profile {
  bank: string;
  /** Where the console starts. */
  url: string;
  /** The bank's words for each thing, with synonyms. */
  words: {
    operatorId: string[];
    password: string[];
    signIn: string[];
    memberSearch: string[];
    memberNumber: string[];
    search: string[];
    /** The way to the transfer form, its button to the review page, and the review's submit. */
    transfer: string[];
    continue: string[];
    submitTransfer: string[];
    /** An account tile's way to its statements, and a statement row's button. */
    statements: string[];
    statement: string[];
    /** An account tile's way to its activity. */
    activity: string[];
    /** The control that opens a menu holding the places to go; none when they are on the page. */
    menu: string[];
    /** The button that moves past a notice after sign-in (the screen `login.notice`). */
    dismiss: string[];
  };
  /**
   * The bank's own words that mark a screen, by screen id, where they differ from the product's:
   * `console.home`, or `login.notice` for a page after sign-in that is passed with `dismiss`.
   */
  screens?: Record<string, string>;
  /** The bank's own words when it refuses a transfer, and the business outcome each one is. */
  refusals: { text: string; code: ResultCode }[];
  /** The bank's own words, on its statements page, for the months it does not list. */
  statementsKept: string;
  /**
   * An account's wording on screen. Its groups, read in order, are the account's last four digits:
   * one group, or several when the bank draws a dash among them ("Acct 1234-5678-90").
   */
  accountWording: RegExp;
  /** How codes arrive: sent (with or without a chooser), or from an authenticator app. */
  codeStyle: 'sent' | 'authenticator';
  /** Where member search shows what it found: on its own page, or in a window it opens. */
  searchResults: 'page' | 'window';
  /** Pictures of text the factory has named, by fingerprint. */
  pictures: KnownPicture[];
  /** Pictures safe to show unmasked in evidence (a learned button, not a value). */
  safePictures: string[];
}

export interface Credentials {
  operatorId: string;
  password: string;
}

/** A step, as the trail records it. */
export interface StepRecord {
  name: string;
  screen: string | null;
  action?: string;
  outcome?: string;
  ms: number;
}

/** What a run gives a driver. */
export interface DriverContext {
  page: Page;
  profile: Profile;
  credentials(): Promise<Credentials>;
  /** Asks a person for something the automation cannot know (a staff code); waits for the answer. */
  askHuman(request: { kind: 'staff_code'; prompt: string }): Promise<string>;
  /**
   * Personal values the bank showed that were not known before the run (the member's name). From
   * now on they are masked wherever they appear, starting with the next step's frame.
   */
  learn(values: string[]): void;
  /** Records a step; the runner adds the frame and the journal. */
  step(record: StepRecord, model: ScreenModel | null): Promise<void> | void;
  now(): Date;
}

/** How a task ended, in the contract's terms. */
export type Outcome<D> =
  | { status: 'succeeded'; data: D }
  | {
      status: 'business_outcome' | 'failed' | 'escalated';
      code: ResultCode;
      retryable?: boolean;
      note?: string;
    };

export class Stop extends Error {
  constructor(readonly outcome: Outcome<never>) {
    super(`${outcome.status}: ${'code' in outcome ? outcome.code : ''}`);
    this.name = 'Stop';
  }
}

export const stop = (
  status: 'business_outcome' | 'failed' | 'escalated',
  code: ResultCode,
  note?: string,
  retryable?: boolean,
): never => {
  throw new Stop({ status, code, note, ...(retryable !== undefined ? { retryable } : {}) });
};

export interface Seen {
  model: ScreenModel;
  screen: string | null;
  recognition: Recognition;
  rendered: boolean;
  dialog?: { type: string; message: string };
}

/** Waits until the screen is fully rendered, names its pictures, and recognizes it. */
export async function see(
  ctx: DriverContext,
  signatures: Signature[],
  o: { limitMs?: number; until?: (m: ScreenModel) => boolean } = {},
): Promise<Seen> {
  const r = await waitFullyRendered(ctx.page, {
    // A slow page gets a minute; past that, the bank is too slow to wait for.
    limitMs: o.limitMs ?? 60_000,
    until: (m) => {
      const named = namePictures(m, ctx.profile.pictures);
      if (o.until) return o.until(named);
      return recognize(named, signatures).screen !== null;
    },
  });
  const model = namePictures(r.model, ctx.profile.pictures);
  const recognition = recognize(model, signatures);
  return {
    model,
    screen: recognition.screen,
    recognition,
    rendered: r.rendered,
    ...(r.dialog ? { dialog: r.dialog } : {}),
  };
}
