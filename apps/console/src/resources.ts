// What the Console shows in M0: every model, newest first. Evidence is read-only: nothing in
// the trail, the journal or the audit log can be edited or deleted from the Console.
import { getModelByName } from '@adminjs/prisma';
import type { PrismaClient } from '@gb/db';
import { SCOPE_CHOICES } from './api-clients.js';

const readOnly = {
  new: { isAccessible: false },
  edit: { isAccessible: false },
  delete: { isAccessible: false },
  bulkDelete: { isAccessible: false },
};

type Rec = { params?: Record<string, unknown> };
type ActionResponse = { record?: Rec; records?: Rec[] };

/** Columns that hold a hash of a secret: never sent to the browser, even hidden. */
const SECRET_COLUMNS = ['passwordHash', 'secretHash', 'codeHash', 'tokenHash'];

/** Remove secret columns from records before they leave the server. */
export function stripSecrets<T extends ActionResponse>(response: T): T {
  for (const r of [response.record, ...(response.records ?? [])]) {
    if (!r?.params) continue;
    for (const k of SECRET_COLUMNS) delete r.params[k];
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
  // Decided on the Recommendations page, with a reason; never edited here.
  { name: 'Recommendation', sortBy: 'createdAt', nav: 'Factory', evidence: true },
  { name: 'RepairCase', sortBy: 'openedAt', nav: 'Drivers' },
  // Cleared on the Freezes page, with a reason; never edited here.
  { name: 'Freeze', sortBy: 'frozenAt', nav: 'Drivers', evidence: true },
  { name: 'SignInAttempt', sortBy: 'at', nav: 'Safety', evidence: true },
  { name: 'AuditEntry', sortBy: 'at', nav: 'Safety', evidence: true },
  { name: 'ConsoleUser', sortBy: 'createdAt', nav: 'Safety' },
  { name: 'ApiClient', sortBy: 'createdAt', nav: 'API' },
  { name: 'TokenFamily', sortBy: 'createdAt', nav: 'API', evidence: true },
  { name: 'ApiToken', sortBy: 'createdAt', nav: 'API', evidence: true },
  { name: 'ApiCode', sortBy: 'expiresAt', nav: 'API', evidence: true },
];

const hideSecrets = {
  properties: Object.fromEntries(SECRET_COLUMNS.map((k) => [k, { isVisible: false }])),
  // Hidden is not enough: AdminJS still sends every column to the browser. Strip the hashes from
  // every response that carries a record.
  after: {
    list: { after: stripSecrets },
    show: { after: stripSecrets },
    search: { after: stripSecrets },
    edit: { after: stripSecrets },
  },
};

export function resources(client: PrismaClient, apiClients: Record<string, object> = {}) {
  return MODELS.map((m) => {
    const secrets = ['ConsoleUser', 'ApiClient', 'ApiCode', 'ApiToken'].includes(m.name);
    const actions = {
      ...(secrets ? hideSecrets.after : {}),
      ...(m.evidence ? readOnly : {}),
      ...(m.name === 'ApiClient'
        ? {
            ...apiClients,
            // Strip hashes first, then add the once-only fields: both run, in order.
            show: {
              ...(apiClients.show ?? {}),
              after: [stripSecrets, (apiClients.show as { after?: unknown })?.after].filter(
                Boolean,
              ),
            },
            edit: { isAccessible: false },
            delete: { isAccessible: false },
            bulkDelete: { isAccessible: false },
          }
        : {}),
    };
    return {
      resource: { model: getModelByName(m.name), client },
      options: {
        navigation: { name: m.nav },
        sort: { sortBy: m.sortBy, direction: 'desc' as const },
        ...(secrets ? { properties: hideSecrets.properties } : {}),
        ...(m.name === 'ApiClient'
          ? {
              properties: {
                ...hideSecrets.properties,
                clientId: { isVisible: { list: true, show: true, edit: false, filter: true } },
                createdBy: { isVisible: { list: true, show: true, edit: false, filter: true } },
                createdAt: { isVisible: { list: true, show: true, edit: false, filter: true } },
                revokedAt: { isVisible: { list: true, show: true, edit: false, filter: true } },
                scopes: { isArray: true, availableValues: SCOPE_CHOICES },
                // Shown once, on the client's page right after it is created; never stored.
                clientSecretOnce: {
                  type: 'string',
                  isVisible: { list: false, show: true, edit: false, filter: false },
                  description: 'Shown once. Copy it now.',
                },
                codeOnce: {
                  type: 'string',
                  isVisible: { list: false, show: true, edit: false, filter: false },
                  description: 'Shown once; single use within 24 hours.',
                },
              },
            }
          : {}),
        actions,
      },
    };
  });
}

export const MODEL_NAMES = MODELS.map((m) => m.name);
