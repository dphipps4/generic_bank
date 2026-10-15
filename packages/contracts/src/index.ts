// The task contract: typed inputs, one typed result. The caller never sees the UI.
import { z } from 'zod';

export const Tenant = z.enum(['generic', 'example', 'sample', 'placeholder']);
export type Tenant = z.infer<typeof Tenant>;

const MemberId = z.string().regex(/^\d{6,10}$/, 'a member number of 6 to 10 digits');
const AccountRef = z.string().min(2).max(40);

export const CheckBalanceInput = z.object({
  tenant: Tenant,
  memberId: MemberId,
  account: AccountRef,
});

export const TransferInput = z.object({
  tenant: Tenant,
  memberId: MemberId,
  from: AccountRef,
  to: AccountRef,
  amountCents: z.number().int().positive().max(2_500_000),
  memo: z.string().max(60).optional(),
  idempotencyKey: z.string().min(8).max(80),
});

export const DownloadStatementsInput = z.object({
  tenant: Tenant,
  memberId: MemberId,
  account: AccountRef,
  months: z
    .array(z.string().regex(/^\d{4}-\d{2}$/))
    .min(1)
    .max(24),
});

export const TaskStatus = z.enum([
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

export const TaskResult = z.object({
  runId: z.string(),
  status: TaskStatus,
  code: z.string().optional(),
  retryable: z.boolean().optional(),
  message: z.string().optional(),
  data: z.unknown().optional(),
});
export type TaskResult = z.infer<typeof TaskResult>;

/** The catalog an agent reads to discover tasks by name. */
export const TASKS = {
  'check-balance': CheckBalanceInput,
  transfer: TransferInput,
  'download-statements': DownloadStatementsInput,
} as const;
export type TaskName = keyof typeof TASKS;
