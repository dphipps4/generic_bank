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
  };
  /** The bank's own words when it refuses a transfer, and the business outcome each one is. */
  refusals: { text: string; code: ResultCode }[];
  /** The bank's own words, on its statements page, for the months it does not list. */
  statementsKept: string;
  /** An account's wording on screen, with its last four digits as the first group. */
  accountWording: RegExp;
  /** How codes arrive: sent (with or without a chooser), or from an authenticator app. */
  codeStyle: 'sent' | 'authenticator';
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
    limitMs: o.limitMs ?? 45_000,
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
