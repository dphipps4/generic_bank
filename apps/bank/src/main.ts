import { buildServer } from './server.js';
import { TENANTS, type Tenant } from './tenants.js';

const id = (process.env.TENANT ?? '') as Tenant['id'];
const tenant = TENANTS[id];
if (!tenant) {
  console.error(`TENANT must be one of: ${Object.keys(TENANTS).join(', ')}`);
  process.exit(1);
}
const port = Number(process.env.PORT ?? 8081);
await buildServer(tenant, true).listen({ host: '0.0.0.0', port });
