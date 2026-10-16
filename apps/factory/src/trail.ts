// A factory run's trail, kept as the Runner keeps a task run's: a step for every tool call and a
// masked frame for every page reached, at most 60. It is kept under a task run with the factory
// run's own id, so the Console's run page and its Frames button show it.
import { type Frame, type FrameStore, frameOf, type MaskPolicy } from '@gb/evidence';
import { addFrame, addStep, type Sql } from '@gb/runs';
import type { ScreenModel } from '@gb/screen';

const MAX_FRAMES = 60;

export interface Trail {
  /** Masks what is known, from the next frame on. */
  readonly policy: MaskPolicy;
  /** Records a step and, for a page, its frame; returns the frame, stored or not. */
  step(
    s: { name: string; action?: string; outcome?: string },
    model: ScreenModel | null,
  ): Promise<Frame | null>;
}

export async function openTrail(o: {
  sql: Sql;
  store: FrameStore;
  runId: string;
  task: string;
  bank: string;
  /** Values masked wherever they appear: the credentials, and each code as it is typed. */
  known: string[];
  now?: () => Date;
}): Promise<Trail> {
  const { sql, store, runId } = o;
  const now = o.now ?? (() => new Date());
  await sql.query(
    `INSERT INTO "TaskRun" (id, task, bank, "inputsMasked", status)
     VALUES ($1, $2, $3, $4, 'running') ON CONFLICT (id) DO NOTHING`,
    [runId, o.task, o.bank, JSON.stringify({ factoryRun: runId })],
  );
  // A trail picks up where it left off.
  const last = await sql.query<{ steps: number; frames: number }>(
    `SELECT (SELECT COALESCE(MAX(seq), 0)::int FROM "Step" WHERE "runId" = $1) AS steps,
            (SELECT COALESCE(MAX(seq), 0)::int FROM "TrailFrame" WHERE "runId" = $1) AS frames`,
    [runId],
  );
  let stepSeq = last.rows[0]!.steps;
  let frameSeq = last.rows[0]!.frames;
  let since = Date.now();
  const policy: MaskPolicy = { known: o.known };

  return {
    policy,
    async step(s, model) {
      stepSeq++;
      await addStep(sql, runId, stepSeq, { ...s, screen: null, ms: Date.now() - since });
      since = Date.now();
      if (!model) return null;
      const f = frameOf(model, policy, { step: stepSeq, at: now() });
      if (frameSeq >= MAX_FRAMES) return f;
      try {
        const base = `runs/${runId}/${String(frameSeq + 1).padStart(3, '0')}`;
        if (f.image) await store.put(`${base}.png`, f.image, 'image/png');
        await store.put(`${base}.json`, Buffer.from(JSON.stringify(f.model)), 'application/json');
        await addFrame(sql, runId, frameSeq + 1, {
          stepSeq,
          imageKey: f.image ? `${base}.png` : null,
          modelKey: `${base}.json`,
          withheld: f.withheld,
          host: f.host,
          path: f.path,
        });
        frameSeq++;
      } catch {
        // A capture failure is recorded by its absence and never breaks the run.
      }
      return f;
    },
  };
}
