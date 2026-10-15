// The task contract: typed inputs, one typed result. The caller never sees the UI.
import { z } from 'zod';

// ── Inputs ───────────────────────────────────────────────────────────────────

/** A bank's id in the registry. Which banks exist is the registry's answer, not this file's. */
export const BankId = z
  .string()
  .regex(/^[a-z][a-z0-9-]{1,30}$/, 'a bank id from GET /banks')
  .describe('The bank, by its id from GET /banks.');

const MemberId = z
  .string()
  .regex(/^\d{6,10}$/, 'a member number of 6 to 10 digits')
  .describe("The bank's member number, exactly as a member-services employee would type it.");

const AccountRef = z
  .string()
  .min(2)
  .max(40)
  .describe("The account's last four digits, or its nickname as the bank shows it.");

export const CheckBalanceInput = z.object({
  bank: BankId,
  memberId: MemberId,
  account: AccountRef,
});

export const TransferInput = z.object({
  bank: BankId,
  memberId: MemberId,
  from: AccountRef,
  to: AccountRef,
  amountCents: z.number().int().positive().max(2_500_000).describe('The amount in cents.'),
  memo: z.string().max(32).optional(),
  idempotencyKey: z
    .string()
    .min(8)
    .max(80)
    .describe('The same key always returns the same run, so a retry never moves money twice.'),
});

export const DownloadStatementsInput = z.object({
  bank: BankId,
  memberId: MemberId,
  account: AccountRef,
  months: z
    .array(z.string().regex(/^\d{4}-\d{2}$/))
    .min(1)
    .max(24)
    .describe('Months as YYYY-MM.'),
});

/** The catalog an agent reads to discover tasks by name. */
export const TASKS = {
  'check-balance': CheckBalanceInput,
  transfer: TransferInput,
  'download-statements': DownloadStatementsInput,
} as const;
export type TaskName = keyof typeof TASKS;

// ── The result ───────────────────────────────────────────────────────────────

export const TaskStatus = z.enum([
  'running',
  'succeeded',
  'business_outcome',
  'needs_human',
  'handed_off',
  'escalated',
  'failed',
  'expired',
  'cancelled',
]);
export type TaskStatus = z.infer<typeof TaskStatus>;

/**
 * Every code a run can end with, under the one status it belongs to, with the fixed sentence the
 * caller sees. These sentences are ours; nothing the bank or the browser said ever reaches the
 * caller.
 */
export const CODES = {
  business_outcome: {
    no_such_member: 'The bank has no member with that number.',
    member_closed: "The member's membership is closed.",
    no_such_account: 'The member has no account matching that reference.',
    insufficient_funds: 'The account does not have enough available balance.',
    permission_denied: 'The bank does not allow this for that account.',
    account_restricted: 'The account is restricted; the member should visit a branch.',
    limit_exceeded: "The amount is over the bank's daily limit.",
    invalid_amount: 'The bank did not accept that amount.',
    approval_rejected: 'A supervisor did not approve the transfer.',
  },
  needs_human: {
    awaiting_staff_code: 'Waiting for a staff member to enter a sign-in code.',
    awaiting_approval: 'Waiting for a person to approve the transfer.',
  },
  handed_off: {
    taken_over: 'A staff member finished this task by hand.',
  },
  escalated: {
    unknown_screen: 'The bank showed a screen the system does not know; a person is looking.',
    stuck: 'The task stopped making progress; a person is looking.',
    ambiguous_outcome: 'The result was unclear; a person is checking before anything is repeated.',
    guard_tripped: 'A safety check stopped the task; a person is looking.',
  },
  failed: {
    app_error: "The bank's system reported an error.",
    unavailable: "The bank's system is unavailable right now.",
    record_in_use: "The member's record is in use at the bank right now.",
    operator_locked: "The bank has locked the system's staff account.",
    bad_credentials: "The bank did not accept the system's staff credentials.",
    step_timeout: 'The bank took too long to respond.',
    no_driver: 'This task is not available for that bank.',
  },
  expired: { expired: 'Nobody answered in time.' },
  cancelled: { cancelled: 'The task was cancelled.' },
} as const;

type CodesOf<S extends keyof typeof CODES> = keyof (typeof CODES)[S];
export type ResultCode = { [S in keyof typeof CODES]: CodesOf<S> }[keyof typeof CODES];

/** Failed codes a retry may help with. Every other failure is final. */
export const RETRYABLE: ReadonlySet<ResultCode> = new Set<ResultCode>([
  'app_error',
  'unavailable',
  'record_in_use',
  'step_timeout',
]);

export function statusOf(code: ResultCode): keyof typeof CODES {
  for (const s of Object.keys(CODES) as (keyof typeof CODES)[]) if (code in CODES[s]) return s;
  throw new Error(`unknown code ${String(code)}`);
}

export const messageFor = (code: ResultCode): string =>
  (CODES[statusOf(code)] as Record<string, string>)[code as string]!;

export const BalanceData = z.object({
  accountLabel: z.string().describe('The account as the bank names it, masked.'),
  availableCents: z.number().int(),
  currentCents: z.number().int(),
  asOf: z.iso.datetime(),
});

export const TransferData = z.object({
  confirmation: z.string(),
  seenInHistory: z.boolean().describe('The transfer was read back from the account history.'),
});

export const StatementsData = z.object({
  months: z.array(
    z.object({
      month: z.string(),
      statement: z.string().nullable().describe('A stored statement reference, or null.'),
      note: z.string().optional(),
    }),
  ),
});

export const TaskResult = z.object({
  runId: z.string(),
  task: z.enum(['check-balance', 'transfer', 'download-statements']),
  status: TaskStatus,
  code: z.string().optional(),
  retryable: z.boolean().optional(),
  message: z.string().optional().describe('A fixed, customer-safe sentence.'),
  data: z.union([BalanceData, TransferData, StatementsData]).optional(),
  escalationId: z.string().optional(),
  resolvable: z.boolean().optional(),
  pending: z
    .object({
      kind: z.enum(['staff_code', 'approval', 'supervisor_code']),
      deadline: z.iso.datetime(),
    })
    .optional()
    .describe('While waiting on a person: what kind of answer is pending, and until when.'),
  resolvedBy: z.string().optional().describe('Who finished the task by hand.'),
  resolvedAt: z.iso.datetime().optional(),
});
export type TaskResult = z.infer<typeof TaskResult>;

// ── Human steps ──────────────────────────────────────────────────────────────

/**
 * What a person is asked for (plan, §F.3, §D.8). A staff code or a supervisor code is something only
 * a person can read; an approval is the only key to a money-moving click; an escalation is a run
 * that stopped because it could not safely go on.
 */
export const HumanTaskKind = z.enum(['staff_code', 'approval', 'supervisor_code', 'escalation']);
export type HumanTaskKind = z.infer<typeof HumanTaskKind>;

export const HumanAction = z.enum([
  'answer',
  'approve',
  'reject',
  'take_over',
  'resume',
  'finish',
  'cancel',
]);
export type HumanAction = z.infer<typeof HumanAction>;

/** The actions each kind of task offers. Nothing else can be done to it. */
export const ACTIONS: Record<HumanTaskKind, readonly HumanAction[]> = {
  staff_code: ['answer', 'cancel'],
  supervisor_code: ['answer', 'cancel'],
  approval: ['approve', 'reject', 'take_over', 'cancel'],
  escalation: ['resume', 'finish', 'cancel'],
};

/** Every state-changing action but typing a code carries a written reason (plan, §G.1). */
const Reason = z.string().trim().min(10, 'a reason of at least ten characters');

export const HUMAN_BODIES = {
  answer: z.object({ code: z.string().regex(/^\d{4,8}$/, 'the code as the bank sent it') }),
  approve: z.object({
    reason: Reason,
    supervisorCode: z
      .string()
      .regex(/^\d{4,8}$/)
      .optional()
      .describe("Over the bank's threshold: the code the bank sent the supervisor."),
  }),
  reject: z.object({ reason: Reason }),
  take_over: z.object({ reason: Reason }),
  resume: z.object({ reason: Reason }),
  finish: z.object({
    reason: Reason,
    data: z
      .union([BalanceData, TransferData, StatementsData])
      .optional()
      .describe('What the person did, in the same shape as an automatic result.'),
  }),
  cancel: z.object({ reason: Reason }),
} as const satisfies Record<HumanAction, z.ZodType>;

/**
 * Why an action cannot be taken now, or null if it can. Only an open task can be acted on, only with
 * one of its own actions, and an escalation that cannot resume (a guard trip) offers no Resume.
 */
export function refusal(
  task: { kind: HumanTaskKind; status: string; resolvable?: boolean },
  action: HumanAction,
): string | null {
  if (task.status !== 'open') return `the task is ${task.status}`;
  if (!ACTIONS[task.kind].includes(action))
    return `a ${task.kind.replace('_', ' ')} task cannot be answered with ${action.replace('_', ' ')}`;
  if (action === 'resume' && task.resolvable === false)
    return 'this run cannot resume; a person must clear the freeze and the agent start again';
  return null;
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

/** The HTTP status for a result (plan, §D.7). */
export function httpStatus(r: Pick<TaskResult, 'status' | 'retryable'>): number {
  switch (r.status) {
    case 'running':
    case 'needs_human':
      return 202;
    case 'succeeded':
    case 'handed_off':
      return 200;
    case 'business_outcome':
      return 422;
    case 'escalated':
      return 409;
    case 'expired':
    case 'cancelled':
      return 410;
    case 'failed':
      return r.retryable ? 503 : 502;
  }
}

/** RFC 9457 problem details, with our three members. */
export const ProblemDetails = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  detail: z.string().optional(),
  code: z.string(),
  runId: z.string().optional(),
  retryable: z.boolean(),
});
export type ProblemDetails = z.infer<typeof ProblemDetails>;

export function problem(
  status: number,
  code: string,
  detail: string,
  extra: { runId?: string; retryable?: boolean } = {},
): ProblemDetails {
  return {
    type: `https://generic-bank.local/problems/${code}`,
    title: code.replace(/_/g, ' '),
    status,
    detail: safeMessage(detail),
    code,
    ...(extra.runId ? { runId: extra.runId } : {}),
    retryable: extra.retryable ?? false,
  };
}

// ── The caller gets our words ────────────────────────────────────────────────

const LEAKS = [
  /<[a-z!/][^>]*>/i, // markup
  /\bat [\w.<>$]+ \(/, // a stack frame
  /https?:\/\//i, // a URL, internal or not
  /\b(localhost|127\.0\.0\.1|bank-[a-z]+|postgres|vault|minio)\b/i, // our hosts
  /[#.][a-z][\w-]*\s*[>{[]/i, // a selector
  /\b(TypeError|ReferenceError|SyntaxError|ECONNREFUSED|ETIMEDOUT)\b/,
];

export const CANNED = {
  generic: 'The task could not be completed.',
  bank: "The bank's system reported a problem.",
  ours: 'Something went wrong on our side.',
} as const;

/** Any message that carries a trace of raw page text, code or our hosts becomes a canned one. */
export function safeMessage(m: string, fallback: keyof typeof CANNED = 'generic'): string {
  return LEAKS.some((re) => re.test(m)) ? CANNED[fallback] : m;
}

// ── Banks ────────────────────────────────────────────────────────────────────

export const BankInfo = z.object({
  id: BankId,
  brand: z.string(),
  productVersion: z.string(),
  tasks: z.array(
    z.object({
      task: z.enum(['check-balance', 'transfer', 'download-statements']),
      crawlerVersion: z.string(),
    }),
  ),
});
export type BankInfo = z.infer<typeof BankInfo>;
