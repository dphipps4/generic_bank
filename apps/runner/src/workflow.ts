// The durable run (plan, §3, DBOS). The workflow holds only the run id: the inputs stay sealed in
// our own table, and the result is settled there too, so nothing personal lands in the workflow
// engine's tables. The crawl is one step: a browser cannot be checkpointed, so a run that resumes
// after a crash starts a fresh browser and signs in again, as the plan says. A transfer resumes from
// what it wrote down: an approval already asked for is waited on again, and a submit whose intent
// is in the trail goes to the account's history, never to the button (§6).
import { DBOS } from '@dbos-inc/dbos-sdk';
import { failIfOpen, WORKFLOW } from '@gb/runs';
import { executeRun, type RunDeps } from './execute.js';
import { withForcedHazards } from './forced.js';

/** `hazardKey` signs a lab run's forced hazards; it is set only when the banks are forceable. */
export function registerTaskWorkflow(deps: RunDeps, hazardKey?: string) {
  async function taskRun(runId: string): Promise<void> {
    await DBOS.runStep(
      async () => {
        try {
          await executeRun(runId, await withForcedHazards(runId, deps, hazardKey));
        } catch (e) {
          // An error before the crawl could settle the run (its inputs, its bank, its hazards)
          // still ends it: as failed, never left running.
          await failIfOpen(deps.sql, runId);
          throw e;
        }
      },
      { name: 'crawl', retriesAllowed: false },
    );
  }
  return DBOS.registerWorkflow(taskRun, { name: WORKFLOW.name });
}
