// Runs: what the API starts and the Runner carries out. A run's real inputs are sealed with a key
// only the API and the Runner hold; what anyone else can read is masked. A run ends in exactly one
// of the contract's results. Human tasks carry what a person was asked, and a person's answer (a
// staff code) is sealed and cleared once used; a person's approval issues the run's one grant. A run
// that stops escalated is handed to a person, who resumes it, finishes it by hand or cancels it.
import { HIDDEN, maskText } from '@gb/runtime/rule';
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import {
  type HazardName,
  HUMAN_BODIES,
  type HumanAction,
  type HumanTaskKind,
  messageFor,
  refusal,
  RESULT_DATA,
  type ResultCode,
  RETRYABLE,
  type TaskName,
  type TaskResult,
} from '@gb/contracts';
import { issueGrant, tripGuard } from '@gb/guardrails';

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
    // The one masking rule: a member number keeps its last four, an account's last four stay.
    if (k === 'bank') out[k] = v;
    // Money, and the caller's key, are hidden whole.
    else if (k === 'amountCents' || k === 'idempotencyKey')
      out[k] = HIDDEN.repeat(String(v).length);
    else if (typeof v === 'string') out[k] = maskText(v);
    else out[k] = v;
  }
  return out;
}

/** A second request for something already open: the run it would duplicate. */
export class DuplicateRun extends Error {
  constructor(readonly runId: string) {
    super(`run ${runId} is already open for the same request`);
  }
}

/** The statuses in which a run is open: it may still act, or a person may let it act again. */
export const OPEN = ['running', 'needs_human', 'escalated'] as const;

/** A keyed hash, so the stored value says nothing about the member, the accounts or the amount. */
const dedupeKey = (parts: readonly unknown[], secret: string) =>
  createHmac('sha256', createHash('sha256').update(`dedupe:${secret}`).digest())
    .update(JSON.stringify(parts))
    .digest('base64url');

const MEMO_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * Our marker for one transfer inside the bank's own data (plan, §6), such as `GBX 7Q4M`. It is
 * minted once, with the run, so every retry, resume and history read looks for the same one.
 */
export const newMemoToken = () =>
  `GBX ${[...randomBytes(4)].map((b) => MEMO_ALPHABET[b % 32]).join('')}`;

const isUniqueViolation = (e: unknown) => (e as { code?: string } | null)?.code === '23505';

/**
 * Starts a run, or finds the one this request already started. The same idempotency key from the
 * same client is the same run. With `dedupeOn`, a second run with the same parts is refused with
 * `DuplicateRun` while the first is open; the database's partial unique index is the judge, so
 * two requests at the same moment cannot both get through.
 */
export async function createRun(
  sql: Sql,
  o: {
    task: TaskName;
    bank: string;
    clientId: string | null;
    inputs: Record<string, unknown>;
    idempotencyKey?: string;
    /** What makes two runs the same request, such as a transfer's member, accounts and amount. */
    dedupeOn?: readonly unknown[];
    /** A hazard-lab run's forced hazards, even none; kept readable, beside the masked inputs. */
    forcedHazards?: readonly HazardName[];
  },
  secret: string,
): Promise<{ runId: string; existing: boolean }> {
  const byKey = async () =>
    o.idempotencyKey
      ? (
          await sql.query<{ id: string }>(
            'SELECT id FROM "TaskRun" WHERE "idempotencyKey" = $1 AND "clientId" IS NOT DISTINCT FROM $2',
            [o.idempotencyKey, o.clientId],
          )
        ).rows[0]?.id
      : undefined;
  const dedupe = o.dedupeOn ? dedupeKey([o.task, o.bank, ...o.dedupeOn], secret) : null;
  const byDedupe = async () =>
    dedupe
      ? (
          await sql.query<{ id: string }>(
            `SELECT id FROM "TaskRun" WHERE "dedupeKey" = $1 AND status::text = ANY($2)`,
            [dedupe, OPEN],
          )
        ).rows[0]?.id
      : undefined;

  const same = await byKey();
  if (same) return { runId: same, existing: true };
  const open = await byDedupe();
  if (open) throw new DuplicateRun(open);
  const runId = id('r');
  const masked = maskInputs(o.inputs);
  delete masked.forcedHazards;
  if (o.forcedHazards) masked.forcedHazards = [...o.forcedHazards];
  try {
    await sql.query(
      `INSERT INTO "TaskRun" (id, task, bank, "clientId", "inputsMasked", "inputsSealed", "idempotencyKey", "dedupeKey", status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'running')`,
      [
        runId,
        o.task,
        o.bank,
        o.clientId,
        JSON.stringify(masked),
        seal(o.inputs, secret),
        o.idempotencyKey ?? null,
        dedupe,
      ],
    );
  } catch (e) {
    // Another request got there first, between our look and our insert.
    if (!isUniqueViolation(e)) throw e;
    const first = await byKey();
    if (first) return { runId: first, existing: true };
    const other = await byDedupe();
    if (other) throw new DuplicateRun(other);
    throw e;
  }
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
      status: 'business_outcome' | 'handed_off' | 'failed' | 'escalated' | 'expired' | 'cancelled';
      code: ResultCode;
      retryable?: boolean;
      /** A guard trip: the layer that refused and its rule, kept with the freeze. */
      guard?: { layer: string; rule: string };
    };

/** How long an escalation waits in the inbox before it shows as due. */
const ESCALATION_DEADLINE_MS = 24 * 60 * 60_000;

/**
 * Ends a run with exactly one result. Its sealed inputs are no longer needed, so they go, except
 * while a person may still let an escalated run resume.
 */
export async function settleRun(sql: Sql, runId: string, e: Ending) {
  const code = e.status === 'succeeded' ? null : e.code;
  const retryable = e.status === 'failed' ? (e.retryable ?? RETRYABLE.has(e.code)) : null;
  const resumable = e.status === 'escalated' && e.code !== 'guard_tripped';
  const r = await sql.query<{ bank: string }>(
    `UPDATE "TaskRun" SET status = $2, "resultCode" = $3, retryable = $4, result = $5, "settledAt" = now(),
            "inputsSealed" = CASE WHEN $6 THEN "inputsSealed" END
      WHERE id = $1 RETURNING bank`,
    [
      runId,
      e.status,
      code,
      retryable,
      e.status === 'succeeded' ? JSON.stringify(e.data) : null,
      resumable,
    ],
  );
  if (e.status === 'escalated' && r.rows[0]) await escalate(sql, runId, r.rows[0].bank, e);
}

/**
 * A stopped run goes to a person (plan, §3): an escalation task in the inbox. A guard trip also
 * freezes the bank (plan, §9), and its escalation cannot resume.
 */
async function escalate(
  sql: Sql,
  runId: string,
  bank: string,
  e: { code: ResultCode; guard?: { layer: string; rule: string } },
) {
  const tripped = e.code === 'guard_tripped';
  if (tripped)
    await tripGuard(sql, {
      runId,
      bank,
      ...(e.guard ?? { layer: 'unrecorded', rule: 'the run did not say which guard refused' }),
    });
  await sql.query(
    `INSERT INTO "HumanTask" (id, "runId", kind, "contextMasked", deadline, resolvable)
     VALUES ($1, $2, 'escalation', $3, $4, $5)`,
    [
      id('h'),
      runId,
      JSON.stringify({ bank, code: e.code, prompt: messageFor(e.code) }),
      new Date(Date.now() + ESCALATION_DEADLINE_MS),
      !tripped,
    ],
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
  /** Return as soon as a person is needed, rather than wait on them. */
  o: { untilPerson?: boolean } = {},
): Promise<TaskResult | null> {
  const until = Date.now() + Math.min(Math.max(seconds, 0), 60) * 1000;
  for (;;) {
    const r = await resultOf(sql, runId);
    if (
      !r ||
      (r.status !== 'running' && r.status !== 'needs_human') ||
      (o.untilPerson && r.status === 'needs_human') ||
      Date.now() >= until
    )
      return r;
    await new Promise((res) => setTimeout(res, 100));
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

/** Whether a run's trail holds a step with this action: what a resumed run reads before acting. */
export async function stepTaken(sql: Sql, runId: string, action: string): Promise<boolean> {
  const r = await sql.query('SELECT 1 FROM "Step" WHERE "runId" = $1 AND action = $2 LIMIT 1', [
    runId,
    action,
  ]);
  return r.rows.length > 0;
}

/** Where a run's trail ends so far: a run that resumes after a crash carries on from there. */
export async function trailEnd(sql: Sql, runId: string): Promise<{ step: number; frame: number }> {
  const r = await sql.query<{ step: number | null; frame: number | null }>(
    `SELECT (SELECT max(seq) FROM "Step" WHERE "runId" = $1) AS step,
            (SELECT max(seq) FROM "TrailFrame" WHERE "runId" = $1) AS frame`,
    [runId],
  );
  return { step: Number(r.rows[0]?.step ?? 0), frame: Number(r.rows[0]?.frame ?? 0) };
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

/** A transfer's review page as the crawler read it off the screen; the accounts already masked. */
export type Review = {
  from: string;
  to: string;
  amountCents: number;
  memo: string;
  memoToken: string;
};

/** What an approval shows a person: the review, and the frame of the review page, masked. */
export type ApprovalContext = {
  prompt?: string;
  review: Review;
  frame?: { runId: string; seq: number };
};

const isReview = (r: unknown): r is Review => {
  const v = r as Partial<Review> | null;
  return (
    typeof v?.from === 'string' &&
    typeof v.to === 'string' &&
    typeof v.memo === 'string' &&
    typeof v.memoToken === 'string' &&
    Number.isInteger(v.amountCents) &&
    v.amountCents! > 0
  );
};

/**
 * For an approval, the context is an `ApprovalContext`; it is shown to people as it is, and an
 * approval without its review cannot be approved.
 */
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
    `UPDATE "HumanTask" SET status = 'answered', action = 'answer', "answerSealed" = $2, "answeredAt" = now(), "answeredBy" = $3 WHERE id = $1 AND status = 'open' RETURNING id`,
    [taskId, seal(answer, secret), by],
  );
  return r.rows.length === 1;
}

export type ActResult = { ok: true } | { ok: false; status: 400 | 404 | 409; reason: string };

// A person decides an open task: one UPDATE, so of two people deciding at once only one wins.
async function decide(
  sql: Sql,
  taskId: string,
  status: 'answered' | 'cancelled',
  action: HumanAction,
  reason: string,
  by: string,
): Promise<boolean> {
  const r = await sql.query(
    `UPDATE "HumanTask" SET status = $2, action = $3, reason = $4, "answeredAt" = now(), "answeredBy" = $5 WHERE id = $1 AND status = 'open' RETURNING id`,
    [taskId, status, action, reason, by],
  );
  return r.rows.length === 1;
}

/**
 * Approve (plan, §6 step 3): the task is decided and the run's single-use grant issued, bound to
 * the review as read. If the grant cannot be issued, the task is opened again: an approval without
 * a grant would leave the run waiting on a key that does not exist.
 */
async function approve(
  sql: Sql,
  taskId: string,
  task: { runId: string; contextMasked: unknown },
  reason: string,
  by: string,
): Promise<ActResult | boolean> {
  const review = (task.contextMasked as Partial<ApprovalContext> | null)?.review;
  if (!isReview(review))
    return { ok: false, status: 409, reason: 'the task has no review to approve' };
  if (!(await decide(sql, taskId, 'answered', 'approve', reason, by))) return false;
  try {
    await issueGrant(sql, {
      runId: task.runId,
      humanTaskId: taskId,
      fromRef: review.from,
      toRef: review.to,
      amountCents: review.amountCents,
      memoToken: review.memoToken,
    });
  } catch (e) {
    await sql.query(
      `UPDATE "HumanTask" SET status = 'open', action = NULL, reason = NULL, "answeredAt" = NULL, "answeredBy" = NULL WHERE id = $1`,
      [taskId],
    );
    throw e;
  }
  return true;
}

/**
 * Resume (plan, §3): the escalated run goes back to running and to the Runner, which signs in
 * fresh and carries on its trail. If it cannot be handed over, the escalation is opened again: a
 * run marked running that no worker holds would never end.
 */
async function resume(
  sql: Sql,
  taskId: string,
  runId: string,
  reason: string,
  by: string,
  restart: (runId: string, taskId: string) => Promise<void>,
): Promise<boolean> {
  if (!(await decide(sql, taskId, 'answered', 'resume', reason, by))) return false;
  // The code stays until the run settles again: a running run's result shows no code.
  await sql.query(
    `UPDATE "TaskRun" SET status = 'running', "settledAt" = NULL WHERE id = $1 AND status = 'escalated'`,
    [runId],
  );
  try {
    await restart(runId, taskId);
  } catch (e) {
    await sql.query(
      `UPDATE "TaskRun" SET status = 'escalated', "settledAt" = now() WHERE id = $1`,
      [runId],
    );
    await sql.query(
      `UPDATE "HumanTask" SET status = 'open', action = NULL, reason = NULL, "answeredAt" = NULL, "answeredBy" = NULL WHERE id = $1`,
      [taskId],
    );
    throw e;
  }
  return true;
}

/**
 * Finish by hand (plan, §3): the person's result, in the task's own typed shape, ends the run
 * handed_off; the agent reads it with who finished it and when.
 */
async function finish(
  sql: Sql,
  taskId: string,
  runId: string,
  data: unknown,
  reason: string,
  by: string,
): Promise<boolean> {
  if (!(await decide(sql, taskId, 'answered', 'finish', reason, by))) return false;
  const json = data === undefined ? null : JSON.stringify(data);
  await sql.query('UPDATE "HumanTask" SET resolution = $2 WHERE id = $1', [taskId, json]);
  await sql.query(
    `UPDATE "TaskRun" SET status = 'handed_off', "resultCode" = 'taken_over', retryable = NULL, result = $2,
            "settledAt" = now(), "inputsSealed" = NULL
      WHERE id = $1 RETURNING bank`,
    [runId, json],
  );
  return true;
}

/** What the Console can do beyond the database: hand a resumed run back to the Runner. */
export interface ActDeps {
  restart?: (runId: string, taskId: string) => Promise<void>;
}

/**
 * A person acts on a human task, from the Console or its API (plan, §6, §3). The body is
 * checked against the action's contract, the action against the task's kind and state, and every
 * action leaves an audit entry with its reason. A code is sealed and never written to the audit.
 */
export async function actOnHumanTask(
  sql: Sql,
  taskId: string,
  action: HumanAction,
  body: unknown,
  by: string,
  secret: string,
  deps: ActDeps = {},
): Promise<ActResult> {
  const parsed = HUMAN_BODIES[action].safeParse(body ?? {});
  if (!parsed.success)
    return { ok: false, status: 400, reason: parsed.error.issues[0]?.message ?? 'invalid' };
  const task = (
    await sql.query<{
      kind: HumanTaskKind;
      status: string;
      resolvable: boolean;
      runId: string;
      contextMasked: unknown;
      task: TaskName;
    }>(
      `SELECT h.kind, h.status, h.resolvable, h."runId", h."contextMasked", r.task
         FROM "HumanTask" h JOIN "TaskRun" r ON r.id = h."runId" WHERE h.id = $1`,
      [taskId],
    )
  ).rows[0];
  if (!task) return { ok: false, status: 404, reason: 'there is no such task' };
  const refused = refusal(task, action);
  if (refused) return { ok: false, status: 409, reason: refused };

  let done: ActResult | boolean;
  let reason: string;
  switch (action) {
    case 'answer':
      done = await answerHumanTask(sql, taskId, (parsed.data as { code: string }).code, by, secret);
      reason = 'entered the code the bank sent';
      break;
    case 'approve':
      reason = (parsed.data as { reason: string }).reason;
      done = await approve(sql, taskId, task, reason, by);
      break;
    case 'reject':
    case 'take_over':
      reason = (parsed.data as { reason: string }).reason;
      done = await decide(sql, taskId, 'answered', action, reason, by);
      break;
    case 'cancel':
      reason = (parsed.data as { reason: string }).reason;
      done = await decide(sql, taskId, 'cancelled', action, reason, by);
      // A waiting run hears the cancel itself; an escalated run is no longer running to hear it.
      if (done && task.kind === 'escalation')
        await settleRun(sql, task.runId, { status: 'cancelled', code: 'cancelled' });
      break;
    case 'resume':
      if (!deps.restart)
        return { ok: false, status: 409, reason: 'nothing here can hand a run back to the Runner' };
      reason = (parsed.data as { reason: string }).reason;
      done = await resume(sql, taskId, task.runId, reason, by, deps.restart);
      break;
    case 'finish': {
      const f = parsed.data as { reason: string; data?: unknown };
      if (f.data !== undefined && !RESULT_DATA[task.task].safeParse(f.data).success)
        return { ok: false, status: 400, reason: `the result is not in the shape of ${task.task}` };
      reason = f.reason;
      done = await finish(sql, taskId, task.runId, f.data, reason, by);
      break;
    }
  }
  if (typeof done !== 'boolean') return done;
  // Someone else acted first, between the read and the write.
  if (!done) return { ok: false, status: 409, reason: 'the task was answered by someone else' };
  await sql.query(
    'INSERT INTO "AuditEntry" (id, actor, action, target, reason) VALUES ($1, $2, $3, $4, $5)',
    [id('a'), by, `human_task.${action}`, taskId, reason],
  );
  return { ok: true };
}

/** The agent asked about a run again: the inbox shows how often, and how long it has waited. */
export async function noteAsk(sql: Sql, runId: string) {
  await sql.query(
    `UPDATE "HumanTask" SET asks = asks + 1, "lastAskedAt" = now() WHERE "runId" = $1 AND status = 'open'`,
    [runId],
  );
}

export type Answer =
  { status: 'answered'; answer: string } | { status: 'expired' } | { status: 'cancelled' };

/** The run waits for a person's answer, until the deadline; the answer is cleared once read. */
export async function awaitAnswer(
  sql: Sql,
  taskId: string,
  secret: string,
  deadline: Date,
  pollMs = 250,
): Promise<Answer> {
  for (;;) {
    const r = await sql.query<{ status: string; answerSealed: string | null; runId: string }>(
      'SELECT status, "answerSealed", "runId" FROM "HumanTask" WHERE id = $1',
      [taskId],
    );
    const t = r.rows[0];
    if (t?.status === 'answered' && t.answerSealed) {
      await sql.query('UPDATE "HumanTask" SET "answerSealed" = NULL WHERE id = $1', [taskId]);
      await setStatus(sql, t.runId, 'running');
      return { status: 'answered', answer: unseal<string>(t.answerSealed, secret) };
    }
    if (t?.status === 'cancelled') return { status: 'cancelled' };
    if (!t || t.status !== 'open' || Date.now() >= deadline.getTime()) {
      if (t?.status === 'open')
        await sql.query(`UPDATE "HumanTask" SET status = 'expired' WHERE id = $1`, [taskId]);
      return { status: 'expired' };
    }
    await new Promise((res) => setTimeout(res, pollMs));
  }
}

export type Decision =
  | { status: 'approved'; grantId: string }
  | { status: 'rejected' }
  | { status: 'taken_over' }
  | { status: 'cancelled' }
  | { status: 'expired' };

const DECIDED: Record<string, Decision> = {
  reject: { status: 'rejected' },
  take_over: { status: 'taken_over' },
};

/**
 * The run waits for a person's decision on an approval, until the deadline. Approved, it goes back
 * to running and holds the grant's id; every other decision is the run's to settle.
 */
export async function awaitDecision(
  sql: Sql,
  taskId: string,
  deadline: Date,
  pollMs = 250,
): Promise<Decision> {
  for (;;) {
    const t = (
      await sql.query<{
        status: string;
        action: string | null;
        runId: string;
        grantId: string | null;
      }>(
        `SELECT h.status, h.action, h."runId", g.id AS "grantId"
           FROM "HumanTask" h LEFT JOIN "ApprovalGrant" g ON g."humanTaskId" = h.id
          WHERE h.id = $1`,
        [taskId],
      )
    ).rows[0];
    if (t?.status === 'answered' && t.action === 'approve' && t.grantId) {
      await setStatus(sql, t.runId, 'running');
      return { status: 'approved', grantId: t.grantId };
    }
    if (t?.status === 'answered' && t.action && DECIDED[t.action]) return DECIDED[t.action]!;
    if (t?.status === 'cancelled') return { status: 'cancelled' };
    // An approval whose grant is still being issued is not yet a decision.
    const issuing = t?.status === 'answered' && t.action === 'approve';
    if (!t || (t.status !== 'open' && !issuing)) return { status: 'expired' };
    if (Date.now() >= deadline.getTime()) {
      const expired =
        t.status === 'open' &&
        (
          await sql.query(
            `UPDATE "HumanTask" SET status = 'expired' WHERE id = $1 AND status = 'open' RETURNING id`,
            [taskId],
          )
        ).rows.length === 1;
      // Decided at the last moment: read the decision.
      if (t.status === 'open' && !expired) continue;
      return { status: 'expired' };
    }
    await new Promise((res) => setTimeout(res, pollMs));
  }
}

/**
 * The approval a run has already asked for, in whatever state it is now: a run that resumes waits
 * on it again rather than asking twice.
 */
export async function approvalOf(
  sql: Sql,
  runId: string,
): Promise<{ id: string; deadline: Date } | null> {
  const r = await sql.query<{ id: string; deadline: Date }>(
    `SELECT id, deadline FROM "HumanTask" WHERE "runId" = $1 AND kind = 'approval'
      ORDER BY "openedAt" DESC LIMIT 1`,
    [runId],
  );
  const t = r.rows[0];
  return t ? { id: t.id, deadline: new Date(t.deadline) } : null;
}

export { forcedHazardsOf, HAZARD_HEADER, hazardHeader } from './hazards.js';
export {
  closeRepairCase,
  driverFault,
  openRepairCase,
  promoteTable,
  serving,
  tableOf,
} from './registry.js';
