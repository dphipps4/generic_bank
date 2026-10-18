// A transfer run (plan, §6): prepared up to the bank's review page, parked for a person's
// approval while the Runner holds the browser, submitted once under the grant the approval issued,
// and confirmed in the account's history. Where a run resumes is decided by what it wrote down: a
// press whose intent is in the trail goes to the history and never to the button (§6, §A.2), and
// an approval already asked for is waited on again, never asked twice.
import {
  inHistory,
  prepareTransfer,
  type Review as Shown,
  type Session,
  submitTransfer,
} from '@gb/crawler';
import { consumeGrant, type GrantCheck, type TransferValues } from '@gb/guardrails';
import {
  approvalOf,
  awaitDecision,
  type Ending,
  openHumanTask,
  type Review,
  type Sql,
  stepTaken,
} from '@gb/runs';
import { maskText } from '@gb/runtime';

/** A transfer run's sealed inputs, with the memo token the API minted. */
export interface TransferTask {
  memberId: string;
  from: string;
  to: string;
  amountCents: number;
  memo?: string;
  memoToken: string;
}

export interface TransferRun {
  sql: Sql;
  runId: string;
  input: TransferTask;
  /** Values masked wherever they appear. */
  known: string[];
  /**
   * The page the run holds, or a fresh browser's when it holds none or lost the one it had.
   * `fresh` says which: a fresh page is not on the review page.
   */
  hold(): Promise<{ s: Session; fresh: boolean }>;
  /** A step in the trail with no frame of its own. */
  note(name: string, action: string): Promise<void>;
  /** The masked frame of the last step, if it has a picture. */
  lastFrame(): { runId: string; seq: number } | undefined;
  /** Hands the guard the grant check, which alone lets it allow the money-moving press. */
  granted?(g: GrantCheck): void;
  deadline(): Date;
  pollMs?: number;
}

/** The bank's memo field holds 32 characters: the token first, then the member's words. */
export const memoFor = (i: Pick<TransferTask, 'memo' | 'memoToken'>) =>
  (i.memo ? `${i.memoToken} ${i.memo}` : i.memoToken).slice(0, 32);
/** What the trail says before the one press, so a resumed run never presses again. */
export const pressIntent = (memoToken: string) => `press Submit transfer for ${memoToken}`;

/** An account as a grant binds it and a person sees it: its label under the one masking rule. */
const masked = (label: string) => maskText(label);
/** What the screen shows, in the grant's terms. A memo without the run's token is another memo. */
const valuesOf = (r: Shown, memoToken: string): TransferValues => ({
  fromRef: masked(r.from),
  toRef: masked(r.to),
  amountCents: r.amountCents,
  memoToken: r.memo.includes(memoToken) ? memoToken : r.memo,
});
/** The memo as a person sees it: the token as it is (it is ours), the member's words masked. */
const memoShown = (memo: string, memoToken: string, known: string[]) =>
  memo.startsWith(memoToken)
    ? memoToken + maskText(memo.slice(memoToken.length), known)
    : maskText(memo, known);

const AMBIGUOUS: Ending = { status: 'escalated', code: 'ambiguous_outcome' };

const taskOf = (i: TransferTask) => ({
  member: i.memberId,
  from: i.from,
  to: i.to,
  amountCents: i.amountCents,
  memo: memoFor(i),
});

export async function runTransfer(r: TransferRun): Promise<Ending> {
  // The token was minted once, with the run: every attempt and every resume looks for that one.
  if (!/^GBX [0-9A-Z]{4}$/.test(r.input.memoToken ?? ''))
    throw new Error('a transfer run carries the memo token it was created with');
  const intent = pressIntent(r.input.memoToken);
  try {
    if (await stepTaken(r.sql, r.runId, intent)) return await fromHistory(r);
    return await prepareAndSubmit(r, intent);
  } catch (e) {
    // After the press, a failure of our own is an unclear result like any other. A guard's refusal
    // still ends the run as a trip: the Runner reads the guard, not this result.
    if (await stepTaken(r.sql, r.runId, intent).catch(() => true)) return AMBIGUOUS;
    throw e;
  }
}

async function prepareAndSubmit(r: TransferRun, intent: string): Promise<Ending> {
  const task = taskOf(r.input);
  let approval = await approvalOf(r.sql, r.runId);
  if (!approval) {
    const { s } = await r.hold();
    const shown = await prepareTransfer(s, task);
    const frame = r.lastFrame();
    const review: Review = {
      from: masked(shown.from),
      to: masked(shown.to),
      amountCents: shown.amountCents,
      memo: memoShown(shown.memo, r.input.memoToken, r.known),
      memoToken: r.input.memoToken,
    };
    const deadline = r.deadline();
    const id = await openHumanTask(
      r.sql,
      r.runId,
      'approval',
      {
        prompt: 'Check the transfer with the member, then approve it, or not.',
        review,
        ...(frame ? { frame } : {}),
      },
      deadline,
    );
    approval = { id, deadline };
  }

  const decision = await awaitDecision(r.sql, approval.id, approval.deadline, r.pollMs);
  switch (decision.status) {
    case 'rejected':
      return { status: 'business_outcome', code: 'approval_rejected' };
    case 'taken_over':
      return { status: 'handed_off', code: 'taken_over' };
    case 'cancelled':
      return { status: 'cancelled', code: 'cancelled' };
    case 'expired':
      return { status: 'expired', code: 'expired' };
    case 'approved':
      break;
  }

  const { s, fresh } = await r.hold();
  if (fresh) {
    // The grant binds values, not a browser: sign in again, prepare again, and the press checks
    // the page against the grant (plan, §6).
    await r.note('resume', 'no browser holds the review page; signing in again to prepare it');
    await prepareTransfer(s, task);
  }
  const done = await submitTransfer(s, task, async (shown) => {
    const g = await consumeGrant(r.sql, {
      runId: r.runId,
      screen: valuesOf(shown, r.input.memoToken),
    });
    r.granted?.(g);
    // The intent is written before the press: from here on, a resumed run reads the history.
    if (g.ok) await r.note('submit', intent);
  });
  return {
    status: 'succeeded',
    data: { confirmation: done.confirmation ?? r.input.memoToken, seenInHistory: true },
  };
}

/** A run that resumes after its press: the history decides, and the button is never pressed. */
async function fromHistory(r: TransferRun): Promise<Ending> {
  await r.note(
    'resume',
    "the submit's intent is in the trail from before the run stopped; reading the history",
  );
  const { s } = await r.hold();
  const found = await inHistory(s, taskOf(r.input)).catch(() => -1);
  await r.note('history', `${found} found carrying the memo token`);
  return found === 1
    ? { status: 'succeeded', data: { confirmation: r.input.memoToken, seenInHistory: true } }
    : AMBIGUOUS;
}
