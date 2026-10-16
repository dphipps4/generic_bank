// The durable run (plan, §D, DBOS). The workflow holds only the run id: the inputs stay sealed in
// our own table, and the result is settled there too, so nothing personal lands in the workflow
// engine's tables. The crawl is one step: a browser cannot be checkpointed, so a run that resumes
// after a crash starts a fresh browser and signs in again, as the plan says. A transfer resumes from
// what it wrote down: an approval already asked for is waited on again, and a journaled submit goes
// to the account's history, never to the button (§F.2).
import { DBOS } from '@dbos-inc/dbos-sdk';
import { WORKFLOW } from '@gb/runs';
import { executeRun, type RunDeps } from './execute.js';
import { withForcedHazards } from './forced.js';

/** `hazardKey` signs a lab run's forced hazards; it is set only when the banks are forceable. */
export function registerTaskWorkflow(deps: RunDeps, hazardKey?: string) {
  async function taskRun(runId: string): Promise<void> {
    await DBOS.runStep(
      async () => void (await executeRun(runId, await withForcedHazards(runId, deps, hazardKey))),
      { name: 'crawl', retriesAllowed: false },
    );
  }
  return DBOS.registerWorkflow(taskRun, { name: WORKFLOW.name });
}
