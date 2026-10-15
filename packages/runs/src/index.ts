// Runs: what the API starts and the Runner carries out. A run's real inputs are sealed with a key
// only the API and the Runner hold; what anyone else can read is masked. A run ends in exactly one
// of the contract's results. Human tasks carry what a person was asked, and a person's answer (a
// staff code) is sealed and cleared once used.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import {
  type HumanTaskKind,
  messageFor,
  type ResultCode,
  RETRYABLE,
  type TaskName,
  type TaskResult,
} from '@gb/contracts';

export interface Sql {
  query<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: R[] }>;
}

export const WORKFLOW = { name: 'task-run', queue: 'tasks' } as const;

const id = (prefix: string) => `${prefix}_${randomBytes(8).toString('hex')}`;

// ── Sealing ──────────────────────────────────────────────────────────────────

const keyOf = (secret: string) => {
  if (secret.length < 32) throw new Error('the sealing key must be at least 32 characters');
  return createHash('sha256').update(secret).digest();
};

/** AES-256-GCM: iv, tag and ciphertext, base64url. */
export function seal(value: unknown, secret: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', keyOf(secret), iv);
  const body = Buffer.concat([c.update(JSON.stringify(value), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]).toString('base64url');
}

export function unseal<T>(sealed: string, secret: string): T {
  const b = Buffer.from(sealed, 'base64url');
  const d = createDecipheriv('aes-256-gcm', keyOf(secret), b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return JSON.parse(Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8')) as T;
}

// ── Runs ─────────────────────────────────────────────────────────────────────

/** What anyone may read about a run's inputs: shape, never the values. */
export function maskInputs(inputs: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(inputs)) {
    if (k === 'bank') out[k] = v;
    else if (typeof v === 'string' && /\d{4}/.test(v)) out[k] = '*'.repeat(v.length);
    else if (k === 'amountCents' || k === 'idempotencyKey') out[k] = '***';
    else out[k] = v;
  }
  return out;
}

export async function createRun(
  sql: Sql,
  o: {
    task: TaskName;
    bank: string;
    clientId: string | null;
    inputs: Record<string, unknown>;
    idempotencyKey?: string;
  },
  secret: string,
): Promise<{ runId: string; existing: boolean }> {
  if (o.idempotencyKey) {
    const r = await sql.query<{ id: string }>(
      'SELECT id FROM "TaskRun" WHERE "idempotencyKey" = $1',
      [o.idempotencyKey],
    );
    if (r.rows[0]) return { runId: r.rows[0].id, existing: true };
  }
  const runId = id('r');
  await sql.query(
    `INSERT INTO "TaskRun" (id, task, bank, "clientId", "inputsMasked", "inputsSealed", "idempotencyKey", status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'running')`,
    [
      runId,
      o.task,
      o.bank,
      o.clientId,
      JSON.stringify(maskInputs(o.inputs)),
      seal(o.inputs, secret),
      o.idempotencyKey ?? null,
    ],
  );
  return { runId, existing: false };
}

export interface RunRow {
  id: string;
  task: TaskName;
  bank: string;
  status: TaskResult['status'];
  resultCode: string | null;
  retryable: boolean | null;
  result: unknown;
  inputsSealed: string | null;
}

export async function loadRun(sql: Sql, runId: string): Promise<RunRow | null> {
  const r = await sql.query<RunRow>(
    'SELECT id, task, bank, status, "resultCode", retryable, result, "inputsSealed" FROM "TaskRun" WHERE id = $1',
    [runId],
  );
  return r.rows[0] ?? null;
}

export async function inputsOf<T>(sql: Sql, runId: string, secret: string): Promise<T> {
  const run = await loadRun(sql, runId);
  if (!run?.inputsSealed) throw new Error(`run ${runId} has no inputs`);
  return unseal<T>(run.inputsSealed, secret);
}

export type Ending =
  | { status: 'succeeded'; data: unknown }
  | {
      status: 'business_outcome' | 'failed' | 'escalated' | 'expired' | 'cancelled';
      code: ResultCode;
      retryable?: boolean;
    };

/** Ends a run with exactly one result. Its sealed inputs are no longer needed, so they go. */
export async function settleRun(sql: Sql, runId: string, e: Ending) {
  const code = e.status === 'succeeded' ? null : e.code;
  const retryable = e.status === 'failed' ? (e.retryable ?? RETRYABLE.has(e.code)) : null;
  await sql.query(
    `UPDATE "TaskRun" SET status = $2, "resultCode" = $3, retryable = $4, result = $5, "settledAt" = now(), "inputsSealed" = NULL WHERE id = $1`,
    [runId, e.status, code, retryable, e.status === 'succeeded' ? JSON.stringify(e.data) : null],
  );
}

export async function setStatus(
  sql: Sql,
  runId: string,
  status: 'running' | 'needs_human',
  code: string | null = null,
) {
  await sql.query(
    'UPDATE "TaskRun" SET status = $2, "resultCode" = $3 WHERE id = $1 AND "settledAt" IS NULL',
    [runId, status, code],
  );
}

/** A run as the contract's result, with our own words. */
export async function resultOf(sql: Sql, runId: string): Promise<TaskResult | null> {
  const run = await loadRun(sql, runId);
  if (!run) return null;
  const base = { runId: run.id, task: run.task, status: run.status };
  if (run.status === 'running') return base;
  if (run.status === 'succeeded') return { ...base, data: run.result as TaskResult['data'] };
  const code = (run.resultCode ?? undefined) as ResultCode | undefined;
  // The person's side of it: the open task a waiting run waits on, the escalation a stopped run
  // hands over, or who finished it by hand.
  const task =
    run.status === 'escalated' || run.status === 'needs_human' || run.status === 'handed_off'
      ? (
          await sql.query<{
            id: string;
            kind: HumanTaskKind;
            deadline: Date;
            resolvable: boolean;
            answeredBy: string | null;
            answeredAt: Date | null;
          }>(
            `SELECT id, kind, deadline, resolvable, "answeredBy", "answeredAt" FROM "HumanTask"
              WHERE "runId" = $1 ORDER BY "openedAt" DESC LIMIT 1`,
            [runId],
          )
        ).rows[0]
      : undefined;
  return {
    ...base,
    ...(code ? { code, message: messageFor(code) } : {}),
    ...(run.status === 'failed' ? { retryable: !!run.retryable } : {}),
    ...(run.status === 'escalated' && task
      ? { escalationId: task.id, resolvable: task.resolvable && code !== 'guard_tripped' }
      : {}),
    ...(run.status === 'needs_human' && task && task.kind !== 'escalation'
      ? { pending: { kind: task.kind, deadline: new Date(task.deadline).toISOString() } }
      : {}),
    ...(run.status === 'handed_off'
      ? {
          ...(run.result ? { data: run.result as TaskResult['data'] } : {}),
          ...(task?.answeredBy ? { resolvedBy: task.answeredBy } : {}),
          ...(task?.answeredAt ? { resolvedAt: new Date(task.answeredAt).toISOString() } : {}),
        }
      : {}),
  };
}

/**
 * Waits up to `seconds` for a run to settle (to leave running, or waiting on a person); returns its
 * result either way. A client waiting on a person is long-polled like any other.
 */
export async function waitForResult(
  sql: Sql,
  runId: string,
  seconds: number,
): Promise<TaskResult | null> {
  const until = Date.now() + Math.min(Math.max(seconds, 0), 30) * 1000;
  for (;;) {
    const r = await resultOf(sql, runId);
    if (!r || (r.status !== 'running' && r.status !== 'needs_human') || Date.now() >= until)
      return r;
    await new Promise((res) => setTimeout(res, 300));
  }
}

// ── The trail ────────────────────────────────────────────────────────────────

export async function addStep(
  sql: Sql,
  runId: string,
  seq: number,
  s: { name: string; screen: string | null; action?: string; outcome?: string; ms: number },
) {
  await sql.query(
    'INSERT INTO "Step" (id, "runId", seq, name, screen, action, outcome, ms) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
    [id('s'), runId, seq, s.name, s.screen, s.action ?? null, s.outcome ?? null, s.ms],
  );
}

export async function addFrame(
  sql: Sql,
  runId: string,
  seq: number,
  f: {
    stepSeq: number;
    imageKey: string | null;
    modelKey: string | null;
    withheld?: string;
    host: string;
    path: string;
  },
) {
  await sql.query(
    `INSERT INTO "TrailFrame" (id, "runId", seq, "stepSeq", "imageKey", "screenModelKey", "withheldReason", host, path) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [id('f'), runId, seq, f.stepSeq, f.imageKey, f.modelKey, f.withheld ?? null, f.host, f.path],
  );
}

// ── People ───────────────────────────────────────────────────────────────────

/** The needs_human code a waiting run shows for each kind of task; an escalation is not a wait. */
const AWAITING: Record<Exclude<HumanTaskKind, 'escalation'>, ResultCode> = {
  staff_code: 'awaiting_staff_code',
  approval: 'awaiting_approval',
  supervisor_code: 'awaiting_approval',
};

export async function openHumanTask(
  sql: Sql,
  runId: string,
  kind: Exclude<HumanTaskKind, 'escalation'>,
  context: Record<string, unknown>,
  deadline: Date,
): Promise<string> {
  const taskId = id('h');
  await sql.query(
    'INSERT INTO "HumanTask" (id, "runId", kind, "contextMasked", deadline) VALUES ($1, $2, $3, $4, $5)',
    [taskId, runId, kind, JSON.stringify(context), deadline],
  );
  await setStatus(sql, runId, 'needs_human', AWAITING[kind]);
  return taskId;
}

/** A person answers a human task. The answer is sealed until the run reads it. */
export async function answerHumanTask(
  sql: Sql,
  taskId: string,
  answer: string,
  by: string,
  secret: string,
): Promise<boolean> {
  const r = await sql.query<{ id: string }>(
    `UPDATE "HumanTask" SET status = 'answered', "answerSealed" = $2, "answeredAt" = now(), "answeredBy" = $3 WHERE id = $1 AND status = 'open' RETURNING id`,
    [taskId, seal(answer, secret), by],
  );
  return r.rows.length === 1;
}

/** The run waits for a person's answer, until the deadline; the answer is cleared once read. */
export async function awaitAnswer(
  sql: Sql,
  taskId: string,
  secret: string,
  deadline: Date,
  pollMs = 1000,
): Promise<string | null> {
  for (;;) {
    const r = await sql.query<{ status: string; answerSealed: string | null; runId: string }>(
      'SELECT status, "answerSealed", "runId" FROM "HumanTask" WHERE id = $1',
      [taskId],
    );
    const t = r.rows[0];
    if (t?.status === 'answered' && t.answerSealed) {
      await sql.query('UPDATE "HumanTask" SET "answerSealed" = NULL WHERE id = $1', [taskId]);
      await setStatus(sql, t.runId, 'running');
      return unseal<string>(t.answerSealed, secret);
    }
    if (!t || t.status !== 'open' || Date.now() >= deadline.getTime()) {
      if (t?.status === 'open')
        await sql.query(`UPDATE "HumanTask" SET status = 'expired' WHERE id = $1`, [taskId]);
      return null;
    }
    await new Promise((res) => setTimeout(res, pollMs));
  }
}
