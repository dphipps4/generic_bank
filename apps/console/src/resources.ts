// What the Console shows through AdminJS, newest first. The audit log is read-only: nothing in
// it can be edited or deleted from the Console.
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

/** An API client's scopes by name, in one column: AdminJS would show a list as a count. */
export function withScopeNames<T extends ActionResponse>(response: T): T {
  for (const r of [response.record, ...(response.records ?? [])]) {
    if (!r?.params) continue;
    const p = r.params;
    p.scopeNames = Object.keys(p)
      .filter((k) => /^scopes\.\d+$/.test(k))
      .sort((a, b) => Number(a.split('.')[1]) - Number(b.split('.')[1]))
      .map((k) => String(p[k]))
      .join(', ');
  }
  return response;
}

// The runs, the inbox, approvals and freezes have pages of their own. Here: what a person manages
// (API clients and Console users) and the audit log, read-only.
const MODELS: { name: string; sortBy: string; nav: string; evidence?: boolean }[] = [
  { name: 'ApiClient', sortBy: 'createdAt', nav: 'API' },
  { name: 'ConsoleUser', sortBy: 'createdAt', nav: 'Safety' },
  { name: 'AuditEntry', sortBy: 'at', nav: 'Safety', evidence: true },
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
    const secrets = ['ConsoleUser', 'ApiClient'].includes(m.name);
    const actions = {
      ...(secrets ? hideSecrets.after : {}),
      ...(m.evidence ? readOnly : {}),
      ...(m.name === 'ApiClient'
        ? {
            ...apiClients,
            list: { after: [stripSecrets, withScopeNames] },
            // Strip hashes first, then add the once-only fields: both run, in order.
            show: {
              ...(apiClients.show ?? {}),
              after: [
                stripSecrets,
                withScopeNames,
                (apiClients.show as { after?: unknown })?.after,
              ].filter(Boolean),
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
                scopes: {
                  isArray: true,
                  availableValues: SCOPE_CHOICES,
                  isVisible: { list: false, show: false, edit: true, filter: false },
                },
                scopeNames: {
                  type: 'string',
                  isVisible: { list: true, show: true, edit: false, filter: false },
                  position: 2,
                },
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
