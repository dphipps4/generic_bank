// The recorder (plan §K.4, §K.6): every run the system settles leaves one attempt of its episode in
// the outbox, in the same statement as the settlement, and this sends them to memory as the runner,
// signed. A task never waits on memory: while memory is down, episodes wait here, in order, and go
// once it answers. Memory holds each run and each attempt once, so sending one again is harmless,
// and the outbox marks it sent either way.
import { createHmac } from 'node:crypto';
import type { Sql } from '@gb/runs';

export interface MemoryWriter {
  url: string;
  /** The runner role's token. */
  token: string;
  /** The key only deterministic code holds; memory's door checks every write against it. */
  signingKey: string;
}

/** Memory's signature: an HMAC of the method, the path and the exact body (memory's door.ts). */
const sign = (key: string, path: string, body: string) =>
  createHmac('sha256', key).update(`POST ${path}\n${body}`).digest('hex');

type Pending = {
  runId: string;
  n: number;
  outcome: string;
  failure: string | null;
  at: Date;
  bank: string;
  task: string;
  startedAt: Date;
  vendor: string | null;
};

/** Held already, or written now: either way memory has it. */
const HELD = new Set(['run_exists', 'attempt_exists']);

/**
 * Sends what waits in the outbox, oldest first, and returns how many left it. It stops at the first
 * episode memory cannot take now (down, read-only, or not answering), to try again later; one memory
 * refuses for good (its privacy screen, a malformed body) is marked refused and never sent again.
 */
export async function sendEpisodes(sql: Sql, memory: MemoryWriter, limit = 100): Promise<number> {
  const pending = (
    await sql.query<Pending>(
      `SELECT o."runId", o.n, o.outcome, o.failure, o.at, r.bank, r.task, r."startedAt",
              lower(split_part(b."productVersion", ' ', 1)) AS vendor
         FROM "EpisodeOutbox" o JOIN "TaskRun" r ON r.id = o."runId" LEFT JOIN "Bank" b ON b.id = r.bank
        WHERE o."sentAt" IS NULL AND o.refused IS NULL
        ORDER BY o.at, o."runId", o.n LIMIT $1`,
      [limit],
    )
  ).rows;
  let sent = 0;
  for (const p of pending) {
    // The run first, so its attempt always has a run to belong to.
    const run = await post(memory, 'episodes/runs', {
      id: p.runId,
      kind: 'task',
      bank: p.bank,
      ...(p.vendor ? { vendor: p.vendor } : {}),
      task: p.task,
      outcome: p.outcome,
      startedAt: p.startedAt,
      endedAt: p.at,
    });
    const attempt =
      run === 'held' &&
      (await post(memory, 'episodes/attempts', {
        runId: p.runId,
        n: p.n,
        outcome: p.outcome,
        ...(p.failure ? { failure: p.failure } : {}),
        at: p.at,
      }));
    const out = attempt || run;
    if (out === 'later') break;
    if (out === 'held')
      await sql.query(`UPDATE "EpisodeOutbox" SET "sentAt" = now() WHERE "runId" = $1 AND n = $2`, [
        p.runId,
        p.n,
      ]);
    else
      await sql.query(`UPDATE "EpisodeOutbox" SET refused = $3 WHERE "runId" = $1 AND n = $2`, [
        p.runId,
        p.n,
        out.refused,
      ]);
    sent++;
  }
  return sent;
}

async function post(
  memory: MemoryWriter,
  write: string,
  body: unknown,
): Promise<'held' | 'later' | { refused: string }> {
  const path = `/${write}`;
  const payload = JSON.stringify(body);
  let res: Response;
  try {
    res = await fetch(`${memory.url}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${memory.token}`,
        'x-memory-signature': sign(memory.signingKey, path, payload),
      },
      body: payload,
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return 'later';
  }
  if (res.ok) return 'held';
  const e = (await res.json().catch(() => ({}))) as { error?: string; reason?: string };
  if (res.status === 409 && HELD.has(e.error ?? '')) return 'held';
  // The screen names its rule, never the value.
  if (res.status === 400 || res.status === 422)
    return { refused: [e.error, e.reason].filter(Boolean).join(': ') || String(res.status) };
  return 'later';
}

/** Sends the outbox every `everyMs` until stopped. */
export function startRecorder(
  sql: Sql,
  memory: MemoryWriter,
  opts: { everyMs?: number; onError?: (e: unknown) => void } = {},
) {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const tick = async () => {
    try {
      await sendEpisodes(sql, memory);
    } catch (e) {
      opts.onError?.(e);
    }
    if (!stopped) timer = setTimeout(tick, opts.everyMs ?? 5000);
  };
  void tick();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
