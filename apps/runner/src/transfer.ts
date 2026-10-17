// A transfer run (plan, §6): prepared up to the bank's review page, parked for a person's
// approval while the Runner holds the browser, submitted once under the grant the approval issued,
// and confirmed in the account's history. Where a run resumes is decided by what it wrote down: a
// press whose intent is in the trail goes to the history and never to the button (§6, §A.2), and
// an approval already asked for is waited on again, never asked twice.
import {
  countInHistory,
  type DriverContext,
  type Outcome,
  prepareTransfer,
  pressIntent,
  type Profile,
  type Review as Read,
  type SubmitHooks,
  submitTransfer,
  type TransferInput,
} from '@gb/drivers';
import { maskText } from '@gb/evidence';
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

/** A transfer run's sealed inputs: the driver's input, with the memo token the API minted. */
export type TransferTask = TransferInput;

export interface TransferRun {
  sql: Sql;
  runId: string;
  profile: Pick<Profile, 'words'>;
  input: TransferTask;
  /** Values masked wherever they appear; a supervisor code joins them once a person gives it. */
  known: string[];
  supervisorId: string;
  /**
   * The page the run holds, or a fresh browser's when it holds none or lost the one it had.
   * `fresh` says which: a fresh page is not on the review page.
   */
  hold(): Promise<{ ctx: DriverContext; fresh: boolean }>;
  /** A step in the trail with no frame of its own. */
  note(name: string, action: string): Promise<void>;
  /** The masked frame of the last step, if it has a picture. */
  lastFrame(): { runId: string; seq: number } | undefined;
  /** Asks a person for a code; throws if the task is cancelled or expires. */
  ask(kind: 'supervisor_code', prompt: string): Promise<string>;
  /** Hands the guard the grant check, which alone lets it allow the money-moving press. */
  granted?(g: GrantCheck): void;
  deadline(): Date;
  pollMs?: number;
}

/** An account as a grant binds it: its label with every digit masked. */
const masked = (label: string) => label.replace(/\d/g, '*');

/** What the screen shows, in the grant's terms. A memo without the run's token is another memo. */
const valuesOf = (r: Read, memoToken: string): TransferValues => ({
  fromRef: masked(r.from),
  toRef: masked(r.to),
  amountCents: r.amountCents,
  memoToken: r.memo.includes(memoToken) ? memoToken : r.memo,
});

/** The memo as a person sees it: the token as it is (it is ours), the member's words masked. */
const memoShown = (memo: string, memoToken: string, known: string[]) =>
  memo.startsWith(memoToken)
    ? memoToken + maskText(memo.slice(memoToken.length), { known })
    : maskText(memo, { known });

const endingOf = (o: Exclude<Outcome<unknown>, { status: 'succeeded' }>): Ending => ({
  status: o.status,
  code: o.code,
  ...(o.retryable !== undefined ? { retryable: o.retryable } : {}),
});

const AMBIGUOUS: Ending = { status: 'escalated', code: 'ambiguous_outcome' };

export async function runTransfer(r: TransferRun): Promise<Ending> {
  // The token was minted once, with the run: every attempt and every resume looks for that one.
  if (!/^GBX [0-9A-Z]{4}$/.test(r.input.memoToken ?? ''))
    throw new Error('a transfer run carries the memo token it was created with');
  const input: TransferInput = { ...r.input };
  const intent = pressIntent(r.profile, input.memoToken);
  try {
    if (await stepTaken(r.sql, r.runId, intent)) return await fromHistory(r, input);
    return await prepareAndSubmit(r, input);
  } catch (e) {
    // After the press, a failure of our own is an unclear result like any other.
    if (await stepTaken(r.sql, r.runId, intent).catch(() => true)) return AMBIGUOUS;
    throw e;
  }
}

async function prepareAndSubmit(r: TransferRun, input: TransferInput): Promise<Ending> {
  let approval = await approvalOf(r.sql, r.runId);
  if (!approval) {
    const { ctx } = await r.hold();
    const prepared = await prepareTransfer(ctx, input);
    if (prepared.status !== 'succeeded') return endingOf(prepared);
    const frame = r.lastFrame();
    const review: Review = {
      from: masked(prepared.data.from),
      to: masked(prepared.data.to),
      amountCents: prepared.data.amountCents,
      memo: memoShown(prepared.data.memo, input.memoToken, r.known),
      memoToken: input.memoToken,
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

  const { ctx, fresh } = await r.hold();
  if (fresh) {
    // The grant binds values, not a browser: sign in again, prepare again, and the click checks
    // the screen against the grant (plan, §6).
    await r.note('resume', 'no browser holds the review page; signing in again to prepare it');
    const again = await prepareTransfer(ctx, input);
    if (again.status !== 'succeeded') return endingOf(again);
  }
  const hooks: SubmitHooks = {
    consume: async (seen) => {
      const g = await consumeGrant(r.sql, {
        runId: r.runId,
        screen: valuesOf(seen, input.memoToken),
      });
      r.granted?.(g);
      return g.ok ? { ok: true } : { ok: false, reason: g.reason };
    },
    intend: (intent) => r.note('submit', intent),
    supervisorCode: async () => {
      const code = await r.ask(
        'supervisor_code',
        'The bank sent the supervisor an approval code for this transfer. Enter it here.',
      );
      r.known.push(code);
      return code;
    },
    supervisorId: r.supervisorId,
  };
  const out = await submitTransfer(ctx, input, hooks);
  return out.status === 'succeeded' ? { status: 'succeeded', data: out.data } : endingOf(out);
}

/** A run that resumes after its press: the history decides, and the button is never pressed. */
async function fromHistory(r: TransferRun, input: TransferInput): Promise<Ending> {
  await r.note(
    'resume',
    "the submit's intent is in the trail from before the run stopped; reading the history",
  );
  const { ctx } = await r.hold();
  const found = await countInHistory(ctx, input).catch(() => -1);
  await r.note('history', `${found} found carrying the memo token`);
  return found === 1
    ? { status: 'succeeded', data: { confirmation: input.memoToken, seenInHistory: true } }
    : AMBIGUOUS;
}
