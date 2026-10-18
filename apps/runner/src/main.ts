// The Runner (the crawler): it takes task runs from the queue, a browser for each (two at a time),
// and carries them out.
import { DBOS } from '@dbos-inc/dbos-sdk';
import Fastify from 'fastify';
import { z } from 'zod';
import { loadConfig, port, secret } from '@gb/config';
import { sql } from '@gb/db';
import { fileStore } from '@gb/evidence';
import { WORKFLOW } from '@gb/runs';
import { startRecorder } from './recorder.js';
import { registerTaskWorkflow } from './workflow.js';

const cfg = loadConfig(
  {
    RUNNER_PORT: port(8100),
    RUNNER_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(1),
    CONTROL_DATABASE_URL: z.string().startsWith('postgresql://'),
    RUN_SEAL_KEY: secret(),
    ANSWER_SEAL_KEY: secret(),
    EVIDENCE_DIR: z.string().min(1).default('/data/evidence'),
    SESSIONS_DIR: z.string().min(1).default('/data/sessions'),
    BANK_SERVICE_PASSWORD: z.string().min(16),
    BANK_OPERATOR_ID: z.string().min(8),
    BANK_SUPERVISOR_ID: z.string().min(8),
    HAZARDS_FORCEABLE: z.enum(['true', 'false']).default('false'),
    HAZARD_HMAC_KEY: secret().optional(),
    MEMORY_URL: z.url(),
    MEMORY_TOKEN_RUNNER: secret(),
    MEMORY_SIGNING_KEY: secret(),
  },
  process.env,
  ['RUN_SEAL_KEY', 'ANSWER_SEAL_KEY', 'MEMORY_TOKEN_RUNNER', 'MEMORY_SIGNING_KEY'],
);

const store = fileStore(cfg.EVIDENCE_DIR);

DBOS.setConfig({
  name: 'generic-bank',
  systemDatabaseUrl: cfg.CONTROL_DATABASE_URL,
  systemDatabaseSchemaName: 'dbos',
});
// The banks obey a forced hazard only when they too are forceable; the key never leaves the Runner.
const forceable = cfg.HAZARDS_FORCEABLE === 'true';
if (forceable && !cfg.HAZARD_HMAC_KEY) throw new Error('HAZARDS_FORCEABLE needs HAZARD_HMAC_KEY');
const control = sql(cfg.CONTROL_DATABASE_URL);
registerTaskWorkflow(
  {
    sql: control,
    store,
    sessions: cfg.SESSIONS_DIR,
    sealKey: cfg.RUN_SEAL_KEY,
    answerKey: cfg.ANSWER_SEAL_KEY,
    // The staff service account: the same operator at every bank, from the Runner's secrets.
    // The supervisor is the one whose approval code a person reads over a transfer's threshold.
    credentials: async () => ({
      operatorId: cfg.BANK_OPERATOR_ID,
      password: cfg.BANK_SERVICE_PASSWORD,
      supervisorId: cfg.BANK_SUPERVISOR_ID,
    }),
  },
  forceable ? cfg.HAZARD_HMAC_KEY : undefined,
);
await DBOS.launch();
await DBOS.registerQueue(WORKFLOW.queue, { workerConcurrency: cfg.RUNNER_CONCURRENCY });

const app = Fastify({ logger: true });
// The recorder: settled runs' episodes, from the outbox to memory, whenever memory answers.
startRecorder(
  control,
  { url: cfg.MEMORY_URL, token: cfg.MEMORY_TOKEN_RUNNER, signingKey: cfg.MEMORY_SIGNING_KEY },
  { onError: (e) => app.log.warn(e, 'the recorder could not read the outbox') },
);
app.get('/healthz', async () => ({
  ok: true,
  service: 'runner',
  concurrency: cfg.RUNNER_CONCURRENCY,
}));
await app.listen({ host: '0.0.0.0', port: cfg.RUNNER_PORT });
