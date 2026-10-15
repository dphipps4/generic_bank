// Statements a run kept (plan, §D.1): where each is stored, and the reference a caller fetches it by.
// A reference names the run and the month and nothing personal; the run says whose it is.
import { STATEMENT_REF } from '@gb/contracts';

/** Where a run's statement for a month is kept, in the evidence store. */
export const statementKey = (runId: string, month: string) => `statements/${runId}/${month}.pdf`;

export const statementRef = (runId: string, month: string) =>
  `st_${runId.replace(/^r_/, '')}_${month}`;

/** The run and month a reference names, or null for anything that is not one. */
export function statementOf(ref: string): { runId: string; month: string } | null {
  const m = STATEMENT_REF.exec(ref);
  return m ? { runId: `r_${m[1]}`, month: m[2]! } : null;
}
