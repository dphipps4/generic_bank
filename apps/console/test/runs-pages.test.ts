import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addFrame, addStep, createRun, memoryStore, openHumanTask, settleRun } from '@gb/runs';
import { controlDb } from '../../../packages/oauth/test/control.js';
import { runPages } from '../src/pages/runs.js';

let db: Awaited<ReturnType<typeof controlDb>>;
const store = memoryStore();
let signedIn = true;
let app: ReturnType<typeof Fastify>;
let runId: string;

beforeAll(async () => {
  db = await controlDb();
  app = Fastify();
  runPages(app, {
    sql: db,
    store,
    whoIs: () => (signedIn ? { email: 'admin@generic-bank.local', role: 'admin' } : null),
  });
  ({ runId } = await createRun(
    db,
    {
      task: 'check-balance',
      bank: 'generic',
      clientId: 'gbc_agent',
      inputs: { bank: 'generic', memberId: '40017732', account: '7890' },
    },
    'k'.repeat(40),
  ));
  await addStep(db, runId, 1, {
    name: 'sign in',
    screen: 'login.signin',
    action: 'typed the operator ID and password',
    ms: 900,
  });
  await addStep(db, runId, 2, {
    name: 'balance',
    screen: 'member.summary',
    outcome: 'succeeded',
    ms: 400,
  });
  await store.put(`runs/${runId}/001.png`, Buffer.from('\x89PNG fake'), 'image/png');
  await store.put(`runs/${runId}/001.json`, Buffer.from('{"texts":[]}'), 'application/json');
  await addFrame(db, runId, 1, {
    stepSeq: 1,
    imageKey: `runs/${runId}/001.png`,
    modelKey: `runs/${runId}/001.json`,
    host: 'bank-generic:8081',
    path: '/corelink/signin',
  });
  await addFrame(db, runId, 2, {
    stepSeq: 2,
    imageKey: null,
    modelKey: null,
    withheld: 'a frame on this screen could not be read',
    host: 'bank-generic:8081',
    path: '/corelink/members/********',
  });
  await openHumanTask(db, runId, 'staff_code', {}, new Date(Date.now() + 60_000));
  await settleRun(db, runId, { status: 'business_outcome', code: 'no_such_member' });
});
afterAll(() => db.close());

describe('runs in the Console', () => {
  it('send anyone signed out to the sign-in page, frames included', async () => {
    signedIn = false;
    expect((await app.inject({ url: '/runs' })).headers.location).toBe('/admin/login');
    expect((await app.inject({ url: `/runs/${runId}/frames/1.png` })).statusCode).toBe(302);
    signedIn = true;
  });

  it('list the runs with their results', async () => {
    const r = await app.inject({ url: '/runs' });
    expect(r.body).toContain(runId);
    expect(r.body).toContain('business outcome');
  });

  it('show one run: facts, what the caller was told, steps, people asked, and a Frames button', async () => {
    const r = (await app.inject({ url: `/runs/${runId}` })).body;
    for (const s of [
      'check-balance',
      'no_such_member',
      'The bank has no member with that number.',
      'typed the operator ID and password',
      'staff code',
      'Frames (2)',
      `data-base="/runs/${runId}/frames/"`,
      'a frame on this screen could not be read',
    ]) {
      expect(r).toContain(s);
    }
    expect(r).not.toContain('40017732');
  });

  it('serve a frame’s masked picture from the store', async () => {
    const r = await app.inject({ url: `/runs/${runId}/frames/1.png` });
    expect([r.statusCode, r.headers['content-type']]).toEqual([200, 'image/png']);
    expect((await app.inject({ url: `/runs/${runId}/frames/2.png` })).statusCode).toBe(404);
  });

  it('serve a frame’s masked screen model as JSON', async () => {
    const r = await app.inject({ url: `/runs/${runId}/frames/1.json` });
    expect([r.statusCode, r.headers['content-type'], r.body]).toEqual([
      200,
      'application/json',
      '{"texts":[]}',
    ]);
  });
});
