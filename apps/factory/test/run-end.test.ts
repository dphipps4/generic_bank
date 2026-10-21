// A run's end, kept on its trail where the Console shows it: a refused model call by its status
// and the provider's words, masked as every step is.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { memoryStore } from '../../../packages/runs/src/index.js';
import { controlDb } from '../../../packages/oauth/test/control.js';
import { recordEnd } from '../src/run.js';
import { openTrail } from '../src/trail.js';

let db: Awaited<ReturnType<typeof controlDb>>;
beforeAll(async () => {
  db = await controlDb();
});
afterAll(async () => {
  await db?.close();
});

describe("a run's end", () => {
  it("is a step on its trail, with the provider's status and words, masked", async () => {
    const trail = await openTrail({
      sql: db,
      store: memoryStore(),
      runId: 'build-ended',
      task: 'factory',
      bank: 'generic',
      known: ['40017732'],
    });
    await recordEnd(
      trail,
      'balance not reached',
      'balance stopped: the model provider (openrouter) refused the call: 403 Key limit exceeded for member 40017732',
    );
    const { rows } = await db.query<{ name: string; action: string; outcome: string }>(
      `SELECT name, action, outcome FROM "Step" WHERE "runId" = 'build-ended'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe('run ended');
    expect(rows[0]!.action).toBe('balance not reached');
    expect(rows[0]!.outcome).toMatch(/refused the call: 403 Key limit exceeded/);
    expect(rows[0]!.outcome).not.toContain('40017732');
  });
});
