// A factory run's trail, kept as the Runner keeps a task run's: a step for every tool call and a
// masked frame for every page reached, at most 60. It is kept under a task run with the factory
// run's own id, so the Console's run page and its Frames button show it.
import { seen } from '@gb/crawler';
import { addFrame, addStep, failIfOpen, type FrameStore, type Sql } from '@gb/runs';
import { type Frame, maskText } from '@gb/runtime';

const MAX_FRAMES = 60;

export interface Trail {
  readonly runId: string;
  /** Values masked wherever they appear; the runtime masks each frame by them as it is taken. */
  readonly known: string[];
  /** Records a step and, for a page, its frame (masked already); returns the frame's reference. */
  step(
    s: { name: string; action?: string; outcome?: string },
    frame: Frame | null,
  ): Promise<Seen | null>;
  /** Whether a frame reference, such as f3, names a stored frame of this run. */
  has(ref: string): boolean;
  /**
   * Keeps anything else a judgment or a look was made from (a packet, a close-up), beside the run's
   * frames, so it can be replayed exactly; returns its key.
   */
  keep(name: string, body: Buffer, contentType: string): Promise<string | null>;
  /**
   * Masks the run's kept step text again with the values known now: a member's name learned late
   * is hidden in what was written before it was learned.
   */
  remask(): Promise<number>;
  /** What a stored frame of this run shows, masked: its page and its words; null for any other. */
  shown(ref: string): Promise<Shown | null>;
  /** Ends the trail's run, so the Console never shows it running after it ended. */
  settle(ok: boolean): Promise<void>;
}

/** A frame's page and the words on it: its controls' names and its visible text. */
export interface Shown {
  page: string;
  controls: string[];
  texts: string[];
}

/** A frame's reference, or null when it was not stored. */
export interface Seen {
  ref: string | null;
}

export async function openTrail(o: {
  sql: Sql;
  store: FrameStore;
  runId: string;
  task: string;
  bank: string;
  /** Values masked wherever they appear: the credentials, and each code as it is typed. */
  known: string[];
}): Promise<Trail> {
  const { sql, store, runId } = o;
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

  return {
    runId,
    known: o.known,
    async step(s, frame) {
      stepSeq++;
      // Every step's text is masked as it is kept, with every value known by then.
      await addStep(sql, runId, stepSeq, {
        ...s,
        ...(s.action != null ? { action: maskText(s.action, o.known) } : {}),
        ...(s.outcome != null ? { outcome: maskText(s.outcome, o.known) } : {}),
        screen: null,
        ms: Date.now() - since,
      });
      since = Date.now();
      if (!frame) return null;
      if (frameSeq >= MAX_FRAMES) return { ref: null };
      try {
        const base = `runs/${runId}/${String(frameSeq + 1).padStart(3, '0')}`;
        const { picture, ...page } = frame;
        await store.put(`${base}.png`, picture, 'image/png');
        await store.put(`${base}.json`, Buffer.from(JSON.stringify(page)), 'application/json');
        const address = new URL(frame.address);
        await addFrame(sql, runId, frameSeq + 1, {
          stepSeq,
          imageKey: `${base}.png`,
          modelKey: `${base}.json`,
          host: address.host,
          path: address.pathname,
        });
        frameSeq++;
        return { ref: `f${frameSeq}` };
      } catch {
        // A capture failure is recorded by its absence and never breaks the run.
        return { ref: null };
      }
    },
    has,
    async settle(ok) {
      if (!ok) {
        await failIfOpen(sql, runId);
        return;
      }
      await sql.query(
        `UPDATE "TaskRun" SET status = 'succeeded', "settledAt" = now() WHERE id = $1 AND "settledAt" IS NULL`,
        [runId],
      );
    },
    async remask() {
      const rows = await sql.query<{ seq: number; action: string | null; outcome: string | null }>(
        `SELECT seq, action, outcome FROM "Step" WHERE "runId" = $1`,
        [runId],
      );
      let changed = 0;
      for (const r of rows.rows) {
        const action = r.action === null ? null : maskText(r.action, o.known);
        const outcome = r.outcome === null ? null : maskText(r.outcome, o.known);
        if (action === r.action && outcome === r.outcome) continue;
        changed++;
        await sql.query(
          `UPDATE "Step" SET action = $3, outcome = $4 WHERE "runId" = $1 AND seq = $2`,
          [runId, r.seq, action, outcome],
        );
      }
      return changed;
    },
    async keep(name, body, contentType) {
      const key = `runs/${runId}/${name}`;
      try {
        await store.put(key, body, contentType);
        return key;
      } catch {
        return null;
      }
    },
    async shown(ref) {
      return has(ref) ? shownAt(sql, store, runId, Number(ref.slice(1))) : null;
    },
  };

  function has(ref: string) {
    const n = /^f(\d{1,3})$/.exec(ref);
    return n !== null && Number(n[1]) >= 1 && Number(n[1]) <= frameSeq;
  }
}

/** What frame `seq` of a run shows, masked as it was stored: its page and its words. */
async function shownAt(sql: Sql, store: FrameStore, runId: string, seq: number) {
  const f = (
    await sql.query<{ host: string; path: string; key: string }>(
      `SELECT host, path, "screenModelKey" AS key FROM "TrailFrame" WHERE "runId" = $1 AND seq = $2`,
      [runId, seq],
    )
  ).rows[0];
  const body = f && (await store.get(f.key));
  if (!body) return null;
  const m = JSON.parse(body.toString()) as Omit<Frame, 'picture'>;
  return {
    page: `${f.host}${f.path}`,
    controls: m.controls.map((c) => c.name).filter(Boolean),
    texts: seen(m.tree),
  } satisfies Shown;
}

/** A stored frame of any run, picture and words, as masked when it was kept; null if there is none. */
export async function frameAt(
  sql: Sql,
  store: FrameStore,
  runId: string,
  seq: number,
): Promise<{ shown: Shown; picture: Buffer | null } | null> {
  const shown = await shownAt(sql, store, runId, seq);
  if (!shown) return null;
  const k = (
    await sql.query<{ key: string | null }>(
      `SELECT "imageKey" AS key FROM "TrailFrame" WHERE "runId" = $1 AND seq = $2`,
      [runId, seq],
    )
  ).rows[0]?.key;
  return { shown, picture: (k && (await store.get(k))) || null };
}

/** Every stored frame of a run, in order: what a repair is shown of the run that failed. */
export async function framesOf(sql: Sql, store: FrameStore, runId: string): Promise<Shown[]> {
  const r = await sql.query<{ seq: number }>(
    `SELECT seq FROM "TrailFrame" WHERE "runId" = $1 ORDER BY seq`,
    [runId],
  );
  const out: Shown[] = [];
  for (const { seq } of r.rows) {
    const s = await shownAt(sql, store, runId, seq);
    if (s) out.push(s);
  }
  return out;
}
