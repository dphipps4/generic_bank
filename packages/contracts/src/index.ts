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

/** The longest memo a caller may send: the bank's 32 characters, less our memo token and a space. */
export const MEMO_MAX = 23;

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
  // The bank's memo holds 32 letters, digits, spaces and hyphens; our memo token and a space take
  // the first nine (plan, §6), so the member's words are never cut short.
  memo: z
    .string()
    .max(MEMO_MAX)
    .regex(/^[A-Za-z0-9 -]*$/, 'letters, digits, spaces and hyphens only')
    .optional()
    .describe(
      `What the member wants the transfer to say, up to ${MEMO_MAX} characters. The bank sees it after our own marker.`,
    ),
  idempotencyKey: z
    .string()
    .min(8)
    .max(80)
    .describe(
      'The same key from the same client always returns the same run, so a retry never moves money twice.',
    ),
});

/** The catalog an agent reads to discover tasks by name. */
export const TASKS = {
  'check-balance': CheckBalanceInput,
  transfer: TransferInput,
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

/** The success data of each task: what a run returns, and what a person finishing by hand records. */
export const RESULT_DATA = {
  'check-balance': BalanceData,
  transfer: TransferData,
} as const satisfies Record<TaskName, z.ZodType>;

export const TaskResult = z.object({
  runId: z.string(),
  task: z.enum(['check-balance', 'transfer']),
  status: TaskStatus,
  code: z.string().optional(),
  retryable: z.boolean().optional(),
  message: z.string().optional().describe('A fixed, customer-safe sentence.'),
  data: z.union([BalanceData, TransferData]).optional(),
  escalationId: z
    .string()
    .optional()
    .describe('While escalated: the task in the Console inbox where a person resolves it.'),
  resolvable: z
    .boolean()
    .optional()
    .describe(
      'While escalated: whether a person can let the run resume. After a guard trip it cannot.',
    ),
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
 * What a person is asked for (plan, §6, §3). A staff code or a supervisor code is something only
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

/** Every state-changing action but typing a code carries a written reason (plan, §2). */
const Reason = z.string().trim().min(10, 'a reason of at least ten characters');

export const HUMAN_BODIES = {
  answer: z.object({ code: z.string().regex(/^\d{4,8}$/, 'the code as the bank sent it') }),
  // Over the bank's threshold, the bank sends the supervisor's code only after the submit, so it
  // is answered as its own supervisor_code task, not here.
  approve: z.object({ reason: Reason }),
  reject: z.object({ reason: Reason }),
  take_over: z.object({ reason: Reason }),
  resume: z.object({ reason: Reason }),
  finish: z.object({
    reason: Reason,
    data: z
      .union([BalanceData, TransferData])
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

/** The HTTP status for a result (plan, §A.1). */
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
  escalationId: z
    .string()
    .optional()
    .describe('A 409: the inbox task where a person resumes, finishes by hand or cancels.'),
  resolvable: z
    .boolean()
    .optional()
    .describe('A 409: whether the run can resume; false after a guard trip.'),
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

// ── Tools ────────────────────────────────────────────────────────────────────

/** Reading a run's result: what the get_task tool takes. */
export const GetTaskInput = z.object({
  runId: z.string().describe('The runId a task call returned.'),
  wait: z
    .number()
    .int()
    .min(0)
    .max(30)
    .optional()
    .describe('Seconds to wait for the run to settle, up to 30.'),
});

/**
 * A tool call's result (plan, §A.1): the endpoint's answer as it is, flagged as an error for every
 * answer but succeeded and handed_off (200) and the waiting states (202). A refusal (400, 401, 403,
 * 404, 409, 429) is an error too.
 */
export function toolResult<T>(httpStatus: number, body: T): { isError: boolean; content: T } {
  return { isError: httpStatus !== 200 && httpStatus !== 202, content: body };
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
  stub: z
    .boolean()
    .describe(
      'The institution exists, but no crawler has been built for it yet: it serves nothing.',
    ),
  tasks: z.array(
    z.object({
      task: z.enum(['check-balance', 'transfer']),
      crawlerVersion: z.string(),
    }),
  ),
});
export type BankInfo = z.infer<typeof BankInfo>;

// ── Hazards ──────────────────────────────────────────────────────────────────

// Every hazard a bank can be forced into, and the one typed result each must give (plan, §A.3,
// §A.3, §B.4). The outcome table proves these results and the hazard lab shows them; both
// read this one list. The bank shares no code with us, so a test checks its names against these.

export const HAZARDS = [
  'latency',
  'js-error-harmless',
  'js-error-widget',
  'js-error-fatal',
  'service-unavailable',
  'confirm-dialog',
  'promo',
  'record-in-use',
  'early-expiry',
  'slow-handoff',
  'swallowed-submit',
  'swallowed-click',
  'late-rows',
  'injected-instruction',
  'unknown-screen',
  'permission-denial',
  'record-not-found',
  'validation-error',
] as const;
export type HazardName = (typeof HAZARDS)[number];

export const isHazard = (s: string): s is HazardName => (HAZARDS as readonly string[]).includes(s);

/** A result as the outcome table states it: the status, and the code for every status but success. */
export interface Expected {
  readonly status: TaskStatus;
  readonly code?: ResultCode;
}

export interface HazardCase {
  readonly hazard: HazardName;
  /** What the bank does when it is forced. */
  readonly does: string;
  readonly expected: Expected;
}

/** A seeded member, the account asked about, and the result the bank's own data gives. */
export interface MemberCase {
  readonly name: string;
  readonly memberId: string;
  readonly account: string;
  readonly expected: Expected;
}

export interface Outcomes {
  /** The first member is the healthy one every hazard is forced on. */
  readonly members: readonly MemberCase[];
  readonly hazards: readonly HazardCase[];
}

const ok: Expected = { status: 'succeeded' };
const end = (status: TaskStatus, code: ResultCode): Expected => ({ status, code });

const CHECK_BALANCE: Outcomes = {
  members: [
    {
      name: 'A healthy member: checking, savings and a money market',
      memberId: '40017732',
      account: 'Everyday Checking',
      expected: ok,
    },
    {
      name: 'No member by that number',
      memberId: '40099999',
      account: '1234',
      expected: end('business_outcome', 'no_such_member'),
    },
    {
      name: 'A closed membership',
      memberId: '40029907',
      account: '1234',
      expected: end('business_outcome', 'member_closed'),
    },
    {
      name: 'An account the member does not have',
      memberId: '40017732',
      account: '0000',
      expected: end('business_outcome', 'no_such_account'),
    },
  ],
  hazards: [
    { hazard: 'latency', does: 'Every response waits 1.8 seconds.', expected: ok },
    {
      hazard: 'js-error-harmless',
      does: 'An uncaught script error; the page still works.',
      expected: ok,
    },
    {
      hazard: 'confirm-dialog',
      does: 'A dialog about unread alerts opens over the member summary.',
      expected: ok,
    },
    {
      hazard: 'promo',
      does: 'A "New in CoreLink" notice stands before the console.',
      expected: ok,
    },
    {
      hazard: 'slow-handoff',
      does: 'The sign-in hand-off holds for 2 to 3 seconds.',
      expected: ok,
    },
    {
      hazard: 'early-expiry',
      does: 'The session ends early and the sign-in page appears inside the frame.',
      expected: ok,
    },
    {
      hazard: 'swallowed-click',
      does: 'The first click on a chosen button is cancelled by script.',
      expected: ok,
    },
    {
      hazard: 'swallowed-submit',
      does: 'A transfer is committed and its response is lost; a balance is untouched.',
      expected: ok,
    },
    { hazard: 'late-rows', does: 'Activity rows arrive a second after the page.', expected: ok },
    {
      hazard: 'injected-instruction',
      does: 'Text on the page asks "automated assistants" for a payment.',
      expected: ok,
    },
    {
      hazard: 'validation-error',
      does: 'The transfer form refuses its values; a balance has no form.',
      expected: ok,
    },
    {
      hazard: 'js-error-widget',
      does: 'One widget fails to draw: the balance shows "--".',
      expected: end('escalated', 'unknown_screen'),
    },
    {
      hazard: 'js-error-fatal',
      does: 'The main frame shows "An unexpected error has occurred."',
      expected: end('failed', 'app_error'),
    },
    {
      hazard: 'service-unavailable',
      does: 'The gateway answers 503.',
      expected: end('failed', 'unavailable'),
    },
    {
      hazard: 'record-in-use',
      does: "The member's record is in use by another operator.",
      expected: end('failed', 'record_in_use'),
    },
    {
      hazard: 'record-not-found',
      does: 'The member search finds nobody.',
      expected: end('business_outcome', 'no_such_member'),
    },
    {
      hazard: 'permission-denial',
      does: 'The bank does not let the operator view the member.',
      expected: end('business_outcome', 'permission_denied'),
    },
    {
      hazard: 'unknown-screen',
      does: 'A page the product has never shown: "System maintenance".',
      expected: end('escalated', 'unknown_screen'),
    },
  ],
};

/** Each task the outcome table covers, measured on Generic Bank. */
export const OUTCOMES = {
  'check-balance': CHECK_BALANCE,
} satisfies Partial<Record<TaskName, Outcomes>>;
export type OutcomeTask = keyof typeof OUTCOMES;

/**
 * The one result a lab run must give: the member's own when nothing is forced, and the hazard's
 * when one is forced on the healthy member. Any other mix has no single expected result.
 */
export function expectedFor(
  task: OutcomeTask,
  member: MemberCase,
  hazards: readonly HazardName[],
): Expected | null {
  const healthy = OUTCOMES[task].members[0]!;
  if (hazards.length === 0) return member.expected;
  if (hazards.length > 1 || member.memberId !== healthy.memberId) return null;
  if (member.account !== healthy.account) return null;
  return OUTCOMES[task].hazards.find((h) => h.hazard === hazards[0])?.expected ?? null;
}

/** "succeeded", or "failed: app_error". */
export const describeExpected = (e: Pick<Expected, 'status' | 'code'>) =>
  e.code ? `${e.status}: ${e.code}` : e.status;
