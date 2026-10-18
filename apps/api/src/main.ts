import { DBOSClient } from '@dbos-inc/dbos-sdk';
import { loadConfig, port, secret } from '@gb/config';
import { sql } from '@gb/db';
import { oauth, TASK_SCOPES } from '@gb/oauth';
import { WORKFLOW } from '@gb/runs';
import { z } from 'zod';
import { labRoutes } from './lab.js';
import { buildServer } from './server.js';

const cfg = loadConfig({
  API_TOKEN_HASH_KEY: secret(),
  API_LOCAL_CLIENT_ID: secret(),
  API_LOCAL_CLIENT_SECRET: secret(),
  RUN_SEAL_KEY: secret(),
  CONTROL_DATABASE_URL: z.string().startsWith('postgresql://'),
  API_PORT: port(8000),
  HAZARDS_FORCEABLE: z.enum(['true', 'false']).default('false'),
});
const control = sql(cfg.CONTROL_DATABASE_URL);
// Runs go to the Runner through the workflow queue; the run id is the workflow's id, so a run is
// enqueued at most once.
const workflows = await DBOSClient.create({
  systemDatabaseUrl: cfg.CONTROL_DATABASE_URL,
  systemDatabaseSchemaName: 'dbos',
});
const enqueue = async (runId: string) =>
  void (await workflows.enqueue(
    { workflowName: WORKFLOW.name, queueName: WORKFLOW.queue, workflowID: runId },
    runId,
  ));
// The local client: its id and secret come from just setup, so curl and Swagger UI need no more.
await oauth(control, cfg.API_TOKEN_HASH_KEY).ensureClient({
  clientId: cfg.API_LOCAL_CLIENT_ID,
  clientSecret: cfg.API_LOCAL_CLIENT_SECRET,
  name: 'Local client (just setup)',
  scopes: [...TASK_SCOPES],
});
const app = await buildServer({
  oauth: oauth(control, cfg.API_TOKEN_HASH_KEY),
  sql: control,
  sealKey: cfg.RUN_SEAL_KEY,
  enqueue,
  logger: true,
  // A balance answers in one call: the POST waits up to 60 seconds for it. A run that needs a
  // person answers at once, so time waiting on a person never counts.
  answerWithin: 60,
});
// The hazard lab starts runs with hazards forced, only where the banks obey them (plan, §A.3).
if (cfg.HAZARDS_FORCEABLE === 'true')
  labRoutes(app, { sql: control, sealKey: cfg.RUN_SEAL_KEY, enqueue });
await app.listen({ host: '0.0.0.0', port: cfg.API_PORT });
