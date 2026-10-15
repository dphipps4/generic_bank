// Download Statements, the Runner's side: each month the driver kept is stored as a document before
// the run settles, and the result names it by a reference the API serves (plan, §D.1). A month the
// bank does not have carries the bank's own words for it.
import type { Outcome, Statements } from '@gb/drivers';
import type { FrameStore } from '@gb/evidence';
import { type Ending, statementKey, statementRef } from '@gb/runs';

export async function keepStatements(
  runId: string,
  out: Outcome<Statements>,
  store: FrameStore,
): Promise<Ending> {
  if (out.status !== 'succeeded')
    return {
      status: out.status,
      code: out.code,
      ...(out.retryable !== undefined ? { retryable: out.retryable } : {}),
    };
  const months = [];
  for (const m of out.data.months) {
    if ('pdf' in m) {
      await store.put(statementKey(runId, m.month), m.pdf, 'application/pdf');
      months.push({ month: m.month, statement: statementRef(runId, m.month) });
    } else months.push({ month: m.month, statement: null, note: m.notAvailable });
  }
  return { status: 'succeeded', data: { months } };
}
