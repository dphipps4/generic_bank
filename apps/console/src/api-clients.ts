// API clients in the Console (plan, §A.7). Creating one shows its secret and starting code exactly
// once, on the client's own page; revoking one stops every token it holds. Only hashes are stored,
// so the Console could not show a secret again if it wanted to.
import { isScope, type OAuth, TASK_SCOPES } from '@gb/oauth';

type Admin = { email?: string } | undefined;
interface RecordLike {
  id(): string;
  params: Record<string, unknown>;
  toJSON(a?: Admin): unknown;
}
interface Ctx {
  currentAdmin?: Admin;
  record?: RecordLike;
  resource?: { findOne(id: string): Promise<RecordLike | null> };
  h?: { recordActionUrl(o: { resourceId: string; recordId: string; actionName: string }): string };
}
interface Req {
  method: string;
  payload?: Record<string, unknown>;
}
type Shown = { record?: { id?: string; params?: Record<string, unknown> } };

const ONCE_MS = 5 * 60_000;

/** The fields shown once on a client's page, the next time it is shown, within five minutes. */
export const ONCE_FIELDS = ['clientSecretOnce', 'codeOnce'] as const;

export function onceStore(now: () => number = Date.now) {
  const items = new Map<string, { fields: Record<string, string>; until: number }>();
  return {
    put(recordId: string, fields: Record<string, string>) {
      items.set(recordId, { fields, until: now() + ONCE_MS });
    },
    take(recordId: string) {
      const it = items.get(recordId);
      items.delete(recordId);
      return it && it.until > now() ? it.fields : null;
    },
  };
}
export type OnceStore = ReturnType<typeof onceStore>;

/** The scopes from AdminJS's flattened payload: scopes.0, scopes.1, ... */
export function scopesFrom(payload: Record<string, unknown>): string[] {
  return Object.entries(payload)
    .filter(([k]) => /^scopes\.\d+$/.test(k))
    .map(([, v]) => String(v).trim())
    .filter(Boolean);
}

const showUrl = (context: Ctx, recordId: string) =>
  context.h?.recordActionUrl({ resourceId: 'ApiClient', recordId, actionName: 'show' }) ??
  `/admin/resources/ApiClient/records/${recordId}/show`;

export function apiClientActions(oauth: OAuth, once: OnceStore) {
  return {
    new: {
      handler: async (request: Req, _response: unknown, context: Ctx) => {
        if (request.method !== 'post') return {};
        const p = request.payload ?? {};
        const scopes = scopesFrom(p);
        const bad = scopes.filter((s) => !isScope(s));
        if (!String(p.name ?? '').trim() || !scopes.length || bad.length) {
          return {
            record: {
              params: p,
              errors: { name: { message: 'A client needs a name and at least one scope.' } },
            },
            notice: {
              message: `A client needs a name and at least one scope${bad.length ? `; not a scope: ${bad.join(', ')}` : ''}.`,
              type: 'error',
            },
          };
        }
        const made = await oauth.createClient({
          name: String(p.name),
          scopes,
          createdBy: context.currentAdmin?.email ?? 'console',
        });
        once.put(made.id, { clientSecretOnce: made.clientSecret, codeOnce: made.code });
        const record = (await context.resource?.findOne(made.id))?.toJSON(context.currentAdmin) ?? {
          id: made.id,
          params: {},
          errors: {},
        };
        return {
          record,
          redirectUrl: showUrl(context, made.id),
          notice: {
            message: 'Client created. Copy its secret and code now: they are shown once.',
            type: 'success',
          },
        };
      },
    },
    // The client's page shows the secret and code the first time it is opened after creation.
    show: {
      after: async (response: Shown) => {
        const id = response.record?.id;
        const fields = id ? once.take(id) : null;
        if (fields && response.record)
          response.record.params = { ...response.record.params, ...fields };
        return response;
      },
    },
    revoke: {
      actionType: 'record' as const,
      icon: 'Slash',
      variant: 'danger' as const,
      guard: 'Revoke this client? Every token it holds stops working at once.',
      component: false as const,
      isAccessible: ({ record }: Ctx) => !record?.params.revokedAt,
      handler: async (_request: Req, _response: unknown, context: Ctx) => {
        await oauth.revokeClient(
          String(context.record!.params.clientId),
          context.currentAdmin?.email ?? 'console',
        );
        const fresh = (await context.resource?.findOne(context.record!.id())) ?? context.record!;
        return {
          record: fresh.toJSON(context.currentAdmin),
          notice: {
            message: 'Client revoked: every token it held has stopped working.',
            type: 'success',
          },
        };
      },
    },
    newCode: {
      actionType: 'record' as const,
      icon: 'Key',
      component: false as const,
      isAccessible: ({ record }: Ctx) => !record?.params.revokedAt,
      handler: async (_request: Req, _response: unknown, context: Ctx) => {
        const code = await oauth.newCode(
          String(context.record!.params.clientId),
          context.currentAdmin?.email ?? 'console',
        );
        once.put(context.record!.id(), { codeOnce: code });
        return {
          record: context.record!.toJSON(context.currentAdmin),
          redirectUrl: showUrl(context, context.record!.id()),
          notice: { message: 'A new starting code is on this page, once.', type: 'success' },
        };
      },
    },
  };
}

export const SCOPE_CHOICES = [...TASK_SCOPES].map((s) => ({ value: s, label: s }));
