import { loadConfig, port, secret } from '@gb/config';
import { buildServer } from './server.js';

const cfg = loadConfig({ API_KEY: secret(), API_PORT: port(8000) });
const app = buildServer({ apiKey: cfg.API_KEY, logger: true });
await app.listen({ host: '0.0.0.0', port: cfg.API_PORT });
