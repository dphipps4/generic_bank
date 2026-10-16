// The hazard check (plan, §7, §C.4, E2): the approved profile run against the bank with each
// hazard forced alone, after a control run with none. Each run must give the outcome table's result
// for its hazard (the same table the hazard lab shows), and a balance it read must be the one in
// the bank's own ledger: the bank's word, never the crawler's. Every hazard that gives another
// result is named.
import { type Expected, describeExpected, type HazardName, OUTCOMES } from '@gb/contracts';
import {
  type Balance,
  checkBalance,
  type Credentials,
  type Outcome,
  type Profile,
} from '@gb/drivers';
import type { Browser } from '@gb/screen';

// The profile from approved claims is the drivers' own, so the Runner serves what this checked.
export { profileFrom } from '@gb/drivers';

/** The bank the check runs against, as the sandbox reaches it. */
export interface Sandbox {
  browser: Browser;
  /** The signed header that makes the bank force these hazards. */
  forced(hazards: HazardName[]): Record<string, string>;
  credentials(): Promise<Credentials>;
  /** A sign-in code: the one the bank sent, or the authenticator's at a bank that uses one. */
  code(): Promise<string>;
  /** The account's available balance in the bank's own ledger. */
  ledger(memberId: string, account: string): Promise<number | null>;
}

/** One run of the profile's driver with these hazards forced, in a page of its own. */
export type Attempt = (hazards: HazardName[]) => Promise<Outcome<Balance>>;

const CASES = OUTCOMES['check-balance'];
/** Every hazard is forced on the outcome table's healthy member. */
export const HEALTHY = CASES.members[0]!;

export function attemptOn(sandbox: Sandbox, profile: Profile): Attempt {
  return async (hazards) => {
    const page = await sandbox.browser.newPage();
    try {
      if (hazards.length)
        await page.call('Network.setExtraHTTPHeaders', { headers: sandbox.forced(hazards) });
      return await checkBalance(
        {
          page,
          profile,
          credentials: sandbox.credentials,
          askHuman: sandbox.code,
          learn: () => undefined,
          step: () => undefined,
          now: () => new Date(),
        },
        { memberId: HEALTHY.memberId, account: HEALTHY.account },
      );
    } finally {
      await page.close();
    }
  };
}

/** One run's result beside the one the table expects: null for the control run. */
export interface Verdict {
  hazard: HazardName | null;
  expected: string;
  got: string;
  passed: boolean;
}

/** One run, judged: the table's status and code, and for a balance, the bank's ledger. */
export async function judge(
  attempt: Attempt,
  ledger: Sandbox['ledger'],
  hazard: HazardName | null,
  want: Expected,
): Promise<Verdict> {
  const expected = describeExpected(want);
  let got: string;
  let passed = false;
  try {
    const o = await attempt(hazard ? [hazard] : []);
    got = describeExpected(o.status === 'succeeded' ? o : { status: o.status, code: o.code });
    passed = o.status === want.status && (o.status === 'succeeded' || o.code === want.code);
    if (passed && o.status === 'succeeded') {
      const cents = await ledger(HEALTHY.memberId, HEALTHY.account);
      if (cents !== o.data.availableCents) {
        got += `, but it read ${o.data.availableCents} cents where the bank's ledger has ${cents}`;
        passed = false;
      }
    }
  } catch (e) {
    got = `it threw: ${e instanceof Error ? e.message : String(e)}`;
  }
  return { hazard, expected, got, passed };
}

export interface HazardCheck {
  passed: boolean;
  /** The control run, then each hazard in the table's order; none after a failed control. */
  verdicts: Verdict[];
  /** The hazards whose result was not the table's; `control` when the control run failed. */
  failed: (HazardName | 'control')[];
}

/**
 * The control run, and if it passes, every hazard in the outcome table forced alone, or only
 * those named (a test's short list).
 */
export async function hazardCheck(
  attempt: Attempt,
  ledger: Sandbox['ledger'],
  only?: readonly HazardName[],
): Promise<HazardCheck> {
  const control = await judge(attempt, ledger, null, HEALTHY.expected);
  if (!control.passed) return { passed: false, verdicts: [control], failed: ['control'] };
  const verdicts = [control];
  // One at a time: one staff operator signing in from two places invalidates their own codes.
  const cases = only ? CASES.hazards.filter((c) => only.includes(c.hazard)) : CASES.hazards;
  for (const c of cases) verdicts.push(await judge(attempt, ledger, c.hazard, c.expected));
  const failed = verdicts.filter((v) => !v.passed).map((v) => v.hazard!);
  return { passed: !failed.length, verdicts, failed };
}
