import { DBOSClient } from '@dbos-inc/dbos-sdk';
import { loadConfig, port, secret } from '@gb/config';
import { sql } from '@gb/db';
import { oauth } from '@gb/oauth';
import { WORKFLOW } from '@gb/runs';
import { z } from 'zod';
import { buildServer } from './server.js';

const cfg = loadConfig({
  API_TOKEN_HASH_KEY: secret(),
  RUN_SEAL_KEY: secret(),
  CONTROL_DATABASE_URL: z.string().startsWith('postgresql://'),
  API_PORT: port(8000),
});
const control = sql(cfg.CONTROL_DATABASE_URL);
// Runs go to the Runner through the workflow queue; the run id is the workflow's id, so a run is
// enqueued at most once.
const workflows = await DBOSClient.create({
  systemDatabaseUrl: cfg.CONTROL_DATABASE_URL,
  systemDatabaseSchemaName: 'dbos',
});
const app = await buildServer({
  oauth: oauth(control, cfg.API_TOKEN_HASH_KEY),
  sql: control,
  sealKey: cfg.RUN_SEAL_KEY,
  enqueue: async (runId) =>
    void (await workflows.enqueue(
      { workflowName: WORKFLOW.name, queueName: WORKFLOW.queue, workflowID: runId },
      runId,
    )),
  logger: true,
});
await app.listen({ host: '0.0.0.0', port: cfg.API_PORT });
