// The Runner (the crawler). In M0 it only reports health; tasks arrive in M3.
import Fastify from 'fastify';
import { loadConfig, port } from '@gb/config';

const cfg = loadConfig({ RUNNER_PORT: port(8100) });
const app = Fastify({ logger: true });
app.get('/healthz', async () => ({ ok: true, service: 'runner', tasks: 'from milestone M3' }));
await app.listen({ host: '0.0.0.0', port: cfg.RUNNER_PORT });
