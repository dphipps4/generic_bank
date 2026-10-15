import { describe, expect, it } from 'vitest';
import { buildServer } from '../src/server.js';
import { TENANTS } from '../src/tenants.js';

describe('bank placeholder', () => {
  it('serves each bank at its own base path', async () => {
    for (const t of Object.values(TENANTS)) {
      const app = buildServer(t);
      const r = await app.inject({ method: 'GET', url: t.basePath });
      expect(r.statusCode).toBe(200);
      expect(r.body).toContain(t.brand);
    }
  });

  it('looks like 2003 at Generic Bank', async () => {
    const r = await buildServer(TENANTS.generic).inject({ method: 'GET', url: '/corelink/' });
    expect(r.body).toContain('MARQUEE');
  });
});
