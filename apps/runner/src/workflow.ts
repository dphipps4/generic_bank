// The durable run (plan, §D, DBOS). The workflow holds only the run id: the inputs stay sealed in
// our own table, and the result is settled there too, so nothing personal lands in the workflow
// engine's tables. The crawl is one step: a browser cannot be checkpointed, so a run that resumes
// after a crash starts a fresh browser and signs in again, as the plan says.
import { DBOS } from '@dbos-inc/dbos-sdk';
import { WORKFLOW } from '@gb/runs';
import { executeRun, type RunDeps } from './execute.js';

export function registerTaskWorkflow(deps: RunDeps) {
  async function taskRun(runId: string): Promise<void> {
    await DBOS.runStep(async () => void (await executeRun(runId, deps)), {
      name: 'crawl',
      retriesAllowed: false,
    });
  }
  return DBOS.registerWorkflow(taskRun, { name: WORKFLOW.name });
}
