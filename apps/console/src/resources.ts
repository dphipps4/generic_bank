// What the Console shows in M0: every model, newest first. Evidence is read-only: nothing in
// the trail, the journal or the audit log can be edited or deleted from the Console.
import { getModelByName } from '@adminjs/prisma';
import type { PrismaClient } from '@gb/db';

const readOnly = {
  new: { isAccessible: false },
  edit: { isAccessible: false },
  delete: { isAccessible: false },
  bulkDelete: { isAccessible: false },
};

type Rec = { params?: Record<string, unknown> };
type ActionResponse = { record?: Rec; records?: Rec[] };

/** Remove secret columns from records before they leave the server. */
export function stripSecrets<T extends ActionResponse>(response: T): T {
  for (const r of [response.record, ...(response.records ?? [])]) {
    if (r?.params) delete r.params.passwordHash;
  }
  return response;
}

const MODELS: { name: string; sortBy: string; nav: string; evidence?: boolean }[] = [
  { name: 'TaskRun', sortBy: 'startedAt', nav: 'Runs', evidence: true },
  { name: 'Step', sortBy: 'startedAt', nav: 'Runs', evidence: true },
  { name: 'TrailFrame', sortBy: 'at', nav: 'Runs', evidence: true },
  { name: 'HumanTask', sortBy: 'openedAt', nav: 'Inbox' },
  { name: 'ApprovalGrant', sortBy: 'expiresAt', nav: 'Inbox', evidence: true },
  { name: 'JournalEntry', sortBy: 'at', nav: 'Runs', evidence: true },
  { name: 'Driver', sortBy: 'tenant', nav: 'Drivers' },
  { name: 'DriverVersion', sortBy: 'createdAt', nav: 'Drivers' },
  { name: 'RegistryEvent', sortBy: 'at', nav: 'Drivers', evidence: true },
  { name: 'FactoryRun', sortBy: 'startedAt', nav: 'Factory', evidence: true },
  { name: 'ModelCall', sortBy: 'at', nav: 'Factory', evidence: true },
  { name: 'EvalResult', sortBy: 'at', nav: 'Factory', evidence: true },
  { name: 'RepairCase', sortBy: 'openedAt', nav: 'Drivers' },
  { name: 'Freeze', sortBy: 'frozenAt', nav: 'Drivers' },
  { name: 'SignInAttempt', sortBy: 'at', nav: 'Safety', evidence: true },
  { name: 'AuditEntry', sortBy: 'at', nav: 'Safety', evidence: true },
  { name: 'ConsoleUser', sortBy: 'createdAt', nav: 'Safety' },
];

export function resources(client: PrismaClient) {
  return MODELS.map((m) => ({
    resource: { model: getModelByName(m.name), client },
    options: {
      navigation: { name: m.nav },
      sort: { sortBy: m.sortBy, direction: 'desc' as const },
      ...(m.name === 'ConsoleUser'
        ? {
            properties: { passwordHash: { isVisible: false } },
            // Hidden is not enough: AdminJS still sends every column to the browser. Strip the
            // hash from every response that carries a record.
            actions: {
              list: { after: stripSecrets },
              show: { after: stripSecrets },
              search: { after: stripSecrets },
              edit: { after: stripSecrets },
            },
          }
        : {}),
      ...(m.evidence ? { actions: readOnly } : {}),
    },
  }));
}

export const MODEL_NAMES = MODELS.map((m) => m.name);
