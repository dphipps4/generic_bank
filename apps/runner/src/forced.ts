// A run started from the hazard lab carries its forced hazards to the bank in the signed header the
// bank checks (plan, §A.3); every other run carries none. Only the Runner holds the signing key.
import { forcedHazardsOf, hazardHeader } from '@gb/runs';
import type { RunDeps } from './execute.js';

export async function withForcedHazards(
  runId: string,
  deps: RunDeps,
  hazardKey: string | undefined,
): Promise<RunDeps> {
  if (!hazardKey) return deps;
  const names = await forcedHazardsOf(deps.sql, runId);
  if (!names.length) return deps;
  return { ...deps, headers: { ...deps.headers, ...hazardHeader(names, hazardKey) } };
}
