// The Runner (the crawler): it takes task runs from the queue, one browser at a time by default,
// and carries them out.
import { DBOS } from '@dbos-inc/dbos-sdk';
import Fastify from 'fastify';
import { z } from 'zod';
import { loadConfig, port, secret } from '@gb/config';
import { sql } from '@gb/db';
import { s3Store } from '@gb/evidence';
import { WORKFLOW } from '@gb/runs';
import { registerTaskWorkflow } from './workflow.js';

const cfg = loadConfig(
  {
    RUNNER_PORT: port(8100),
    RUNNER_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(1),
    CONTROL_DATABASE_URL: z.string().startsWith('postgresql://'),
    RUN_SEAL_KEY: secret(),
    ANSWER_SEAL_KEY: secret(),
    MINIO_ENDPOINT: z.string().url().default('http://minio:9000'),
    MINIO_ROOT_USER: z.string().min(3),
    MINIO_ROOT_PASSWORD: secret(),
    BANK_SERVICE_PASSWORD: z.string().min(16),
  },
  process.env,
  ['RUN_SEAL_KEY', 'ANSWER_SEAL_KEY', 'MINIO_ROOT_PASSWORD'],
);

const store = s3Store({
  endpoint: cfg.MINIO_ENDPOINT,
  bucket: 'evidence',
  accessKey: cfg.MINIO_ROOT_USER,
  secretKey: cfg.MINIO_ROOT_PASSWORD,
});
await store.ensureBucket();

DBOS.setConfig({
  name: 'generic-bank',
  systemDatabaseUrl: cfg.CONTROL_DATABASE_URL,
  systemDatabaseSchemaName: 'dbos',
});
registerTaskWorkflow({
  sql: sql(cfg.CONTROL_DATABASE_URL),
  store,
  sealKey: cfg.RUN_SEAL_KEY,
  answerKey: cfg.ANSWER_SEAL_KEY,
  // The staff service account: the same operator at every bank here; from Vault in the plan.
  credentials: async () => ({ operatorId: '0412', password: cfg.BANK_SERVICE_PASSWORD }),
});
await DBOS.launch();
await DBOS.registerQueue(WORKFLOW.queue, { workerConcurrency: cfg.RUNNER_CONCURRENCY });

const app = Fastify({ logger: true });
app.get('/healthz', async () => ({
  ok: true,
  service: 'runner',
  concurrency: cfg.RUNNER_CONCURRENCY,
}));
await app.listen({ host: '0.0.0.0', port: cfg.RUNNER_PORT });
