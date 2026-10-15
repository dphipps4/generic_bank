// The software factory. In M0 it only reports health and which mode it would run in.
import Fastify from 'fastify';
import { z } from 'zod';
import { loadConfig, port } from '@gb/config';

const cfg = loadConfig({ FACTORY_PORT: port(8200), ANTHROPIC_API_KEY: z.string().default('') });
const mode = cfg.ANTHROPIC_API_KEY ? 'live' : 'mock';
const app = Fastify({ logger: true });
app.get('/healthz', async () => ({
  ok: true,
  service: 'factory',
  mode,
  runs: 'from milestone M7',
}));
await app.listen({ host: '0.0.0.0', port: cfg.FACTORY_PORT });
