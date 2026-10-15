import { describe, expect, it } from 'vitest';
import { buildServer } from '../src/server.js';

const apiKey = 'k'.repeat(40);
const app = buildServer({ apiKey });
const auth = { 'x-api-key': apiKey };

describe('Task API', () => {
  it('answers health without a key', async () => {
    const r = await app.inject({ method: 'GET', url: '/healthz' });
    expect(r.statusCode).toBe(200);
  });

  it('refuses a call without the key', async () => {
    const r = await app.inject({ method: 'GET', url: '/tasks' });
    expect(r.statusCode).toBe(401);
  });

  it('lists the task catalog', async () => {
    const r = await app.inject({ method: 'GET', url: '/tasks', headers: auth });
    expect(r.json().tasks.map((t: { name: string }) => t.name)).toContain('transfer');
  });

  it('refuses invalid input with the field that failed', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/tasks/check-balance',
      headers: auth,
      payload: { bank: 'generic', memberId: 'abc', account: '7890' },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().fields[0].path).toBe('memberId');
  });

  it('says plainly that running tasks is not built yet', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/tasks/check-balance',
      headers: auth,
      payload: { bank: 'generic', memberId: '40017732', account: '7890' },
    });
    expect(r.statusCode).toBe(501);
  });
});
