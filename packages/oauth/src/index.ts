// OAuth2 for the Task API (plan, §A.7). An admin creates a client in the Console and receives its
// secret and a one-time code, once. The code becomes a 15-minute access token and a 30-day refresh
// token; refresh tokens rotate, and presenting a spent one revokes its whole family. Only keyed
// hashes of secrets, codes and tokens are ever stored.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** A database to run SQL on: Postgres in the services, an in-process Postgres in tests. */
export interface Sql {
  query<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: R[] }>;
}

export const TASK_SCOPES = ['tasks:read', 'tasks:balance', 'tasks:transfer'] as const;
export type TaskScope = (typeof TASK_SCOPES)[number];

/** A task scope, or `bank:<id>` to limit a client to named banks. */
export const isScope = (s: string) =>
  (TASK_SCOPES as readonly string[]).includes(s) || /^bank:[a-z][a-z0-9-]{1,30}$/.test(s);

export const ACCESS_TTL_MS = 15 * 60_000;
/** A program's own token (client credentials), as curl and Swagger UI use: a working day. */
export const CLIENT_ACCESS_TTL_MS = 8 * 3_600_000;
export const REFRESH_TTL_MS = 30 * 86_400_000;
export const CODE_TTL_MS = 24 * 3_600_000;

export type OAuthErrorCode =
  | 'invalid_request'
  | 'invalid_client'
  | 'invalid_grant'
  | 'unsupported_grant_type'
  | 'invalid_scope';

/** An error in the OAuth2 vocabulary, with the HTTP status RFC 6749 gives it. */
export class OAuthError extends Error {
  constructor(
    public readonly error: OAuthErrorCode,
    public readonly description: string,
  ) {
    super(description);
    this.name = 'OAuthError';
  }
  get status() {
    return this.error === 'invalid_client' ? 401 : 400;
  }
}

export interface Tokens {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
  scope: string;
}

export interface Caller {
  clientId: string;
  scopes: string[];
  familyId: string;
}

const id = () => `c${randomBytes(12).toString('hex')}`;
const secretOf = (prefix: string) => `${prefix}_${randomBytes(32).toString('base64url')}`;

export function oauth(sql: Sql, hashKey: string, now: () => Date = () => new Date()) {
  if (hashKey.length < 32) throw new Error('the token-hashing key must be at least 32 characters');
  const hash = (v: string) => createHmac('sha256', hashKey).update(v).digest('hex');
  const same = (a: string, b: string) => {
    const x = Buffer.from(a);
    const y = Buffer.from(b);
    return x.length === y.length && timingSafeEqual(x, y);
  };

  async function audit(actor: string, action: string, target: string, reason = '') {
    await sql.query(
      'INSERT INTO "AuditEntry" (id, actor, action, target, reason) VALUES ($1, $2, $3, $4, $5)',
      [id(), actor, action, target, reason],
    );
  }

  /** The client, if the id and secret are right and it is not revoked. */
  async function client(clientId: string, clientSecret: string) {
    const r = await sql.query<{
      id: string;
      secretHash: string;
      scopes: string[];
      revokedAt: Date | null;
    }>('SELECT id, "secretHash", scopes, "revokedAt" FROM "ApiClient" WHERE "clientId" = $1', [
      clientId,
    ]);
    const c = r.rows[0];
    // Hash the secret even when there is no client, so timing says nothing about which ids exist.
    const ok = same(hash(clientSecret), c?.secretHash ?? hash('no such client'));
    if (!c || !ok || c.revokedAt)
      throw new OAuthError('invalid_client', 'The client id or secret is not valid.');
    return c;
  }

  async function issue(
    familyId: string,
    scopes: string[],
    clientId: string,
    action: string,
    accessTtlMs = ACCESS_TTL_MS,
  ): Promise<Tokens> {
    const t = now().getTime();
    const access = secretOf('gbat');
    const refresh = secretOf('gbrt');
    await sql.query(
      `INSERT INTO "ApiToken" (id, "familyId", kind, "tokenHash", scopes, "expiresAt") VALUES
         ($1, $2, 'access', $3, $4, $5), ($6, $2, 'refresh', $7, $4, $8)`,
      [
        id(),
        familyId,
        hash(access),
        scopes,
        new Date(t + accessTtlMs),
        id(),
        hash(refresh),
        new Date(t + REFRESH_TTL_MS),
      ],
    );
    await audit(clientId, action, familyId);
    return {
      access_token: access,
      token_type: 'Bearer',
      expires_in: accessTtlMs / 1000,
      refresh_token: refresh,
      scope: scopes.join(' '),
    };
  }

  async function revokeFamily(familyId: string, actor: string, reason: string) {
    await sql.query(
      'UPDATE "TokenFamily" SET "revokedAt" = $2, "revokedReason" = $3 WHERE id = $1 AND "revokedAt" IS NULL',
      [familyId, now(), reason],
    );
    await audit(actor, 'family.revoked', familyId, reason);
  }

  return {
    /** A new client. Its secret and starting code are returned once and never stored. */
    async createClient(o: { name: string; scopes: string[]; createdBy: string }) {
      const bad = o.scopes.filter((s) => !isScope(s));
      if (!o.scopes.length || bad.length)
        throw new OAuthError('invalid_scope', `Not a scope: ${bad.join(', ') || '(none given)'}`);
      if (!o.name.trim()) throw new OAuthError('invalid_request', 'A client needs a name.');
      const clientId = `gbc_${randomBytes(9).toString('base64url')}`;
      const clientSecret = secretOf('gbcs');
      const pk = id();
      await sql.query(
        'INSERT INTO "ApiClient" (id, name, "clientId", "secretHash", scopes, "createdBy") VALUES ($1, $2, $3, $4, $5, $6)',
        [pk, o.name.trim(), clientId, hash(clientSecret), o.scopes, o.createdBy],
      );
      await audit(o.createdBy, 'client.created', clientId, o.scopes.join(' '));
      const code = await this.newCode(clientId, o.createdBy);
      return { id: pk, clientId, clientSecret, code };
    },

    /** Another one-time starting code for a client, for an admin (24 hours, single use). */
    async newCode(clientId: string, by: string) {
      const r = await sql.query<{ id: string }>(
        'SELECT id FROM "ApiClient" WHERE "clientId" = $1 AND "revokedAt" IS NULL',
        [clientId],
      );
      if (!r.rows[0]) throw new OAuthError('invalid_client', 'No such client.');
      const code = secretOf('gbcode');
      await sql.query(
        'INSERT INTO "ApiCode" (id, "clientPk", "codeHash", "expiresAt") VALUES ($1, $2, $3, $4)',
        [id(), r.rows[0].id, hash(code), new Date(now().getTime() + CODE_TTL_MS)],
      );
      await audit(by, 'code.issued', clientId);
      return code;
    },

    /** grant_type=client_credentials: a program's own id and secret become an access token. */
    async clientCredentials(clientId: string, clientSecret: string): Promise<Tokens> {
      const c = await client(clientId, clientSecret);
      const familyId = id();
      await sql.query('INSERT INTO "TokenFamily" (id, "clientPk") VALUES ($1, $2)', [
        familyId,
        c.id,
      ]);
      return issue(familyId, c.scopes, clientId, 'token.issued', CLIENT_ACCESS_TTL_MS);
    },

    /**
     * A client with this id and secret, made if it is missing and brought up to date if it is not:
     * the local client that just setup configures for curl and Swagger UI.
     */
    async ensureClient(o: {
      clientId: string;
      clientSecret: string;
      name: string;
      scopes: string[];
    }) {
      await sql.query(
        `INSERT INTO "ApiClient" (id, name, "clientId", "secretHash", scopes, "createdBy")
           VALUES ($1, $2, $3, $4, $5, 'just setup')
         ON CONFLICT ("clientId") DO UPDATE
           SET "secretHash" = EXCLUDED."secretHash", scopes = EXCLUDED.scopes, "revokedAt" = NULL`,
        [id(), o.name, o.clientId, hash(o.clientSecret), o.scopes],
      );
    },

    /** grant_type=authorization_code: a starting code becomes the first pair of tokens. */
    async exchangeCode(clientId: string, clientSecret: string, code: string): Promise<Tokens> {
      const c = await client(clientId, clientSecret);
      const r = await sql.query<{ id: string; expiresAt: Date; usedAt: Date | null }>(
        'SELECT id, "expiresAt", "usedAt" FROM "ApiCode" WHERE "codeHash" = $1 AND "clientPk" = $2',
        [hash(code), c.id],
      );
      const k = r.rows[0];
      if (!k || k.usedAt || new Date(k.expiresAt) <= now())
        throw new OAuthError(
          'invalid_grant',
          'The code is not valid, has been used, or has expired.',
        );
      await sql.query('UPDATE "ApiCode" SET "usedAt" = $2 WHERE id = $1', [k.id, now()]);
      const familyId = id();
      await sql.query('INSERT INTO "TokenFamily" (id, "clientPk") VALUES ($1, $2)', [
        familyId,
        c.id,
      ]);
      return issue(familyId, c.scopes, clientId, 'token.issued');
    },

    /** grant_type=refresh_token: a refresh token works once. A second use revokes its family. */
    async refresh(clientId: string, clientSecret: string, refreshToken: string): Promise<Tokens> {
      const c = await client(clientId, clientSecret);
      const r = await sql.query<{
        id: string;
        familyId: string;
        scopes: string[];
        expiresAt: Date;
        spentAt: Date | null;
        revokedAt: Date | null;
        clientPk: string;
      }>(
        `SELECT t.id, t."familyId", t.scopes, t."expiresAt", t."spentAt", f."revokedAt", f."clientPk"
           FROM "ApiToken" t JOIN "TokenFamily" f ON f.id = t."familyId"
          WHERE t."tokenHash" = $1 AND t.kind = 'refresh'`,
        [hash(refreshToken)],
      );
      const t = r.rows[0];
      if (!t || t.clientPk !== c.id)
        throw new OAuthError('invalid_grant', 'The refresh token is not valid.');
      if (t.spentAt) {
        await revokeFamily(
          t.familyId,
          clientId,
          'a spent refresh token was presented again: possible theft',
        );
        throw new OAuthError(
          'invalid_grant',
          'The refresh token has already been used; every token from it is now revoked.',
        );
      }
      if (t.revokedAt || new Date(t.expiresAt) <= now())
        throw new OAuthError('invalid_grant', 'The refresh token has expired or been revoked.');
      await sql.query('UPDATE "ApiToken" SET "spentAt" = $2 WHERE id = $1', [t.id, now()]);
      return issue(t.familyId, t.scopes, clientId, 'token.refreshed');
    },

    /** RFC 7009: revoking a token revokes its family. An unknown token is not an error. */
    async revoke(clientId: string, clientSecret: string, token: string) {
      const c = await client(clientId, clientSecret);
      const r = await sql.query<{ familyId: string; clientPk: string }>(
        'SELECT t."familyId", f."clientPk" FROM "ApiToken" t JOIN "TokenFamily" f ON f.id = t."familyId" WHERE t."tokenHash" = $1',
        [hash(token)],
      );
      const t = r.rows[0];
      if (t && t.clientPk === c.id)
        await revokeFamily(t.familyId, clientId, 'revoked by the client');
    },

    /** Who is calling, from a bearer access token; null if it is not valid now. */
    async authenticate(accessToken: string): Promise<Caller | null> {
      const r = await sql.query<{
        scopes: string[];
        expiresAt: Date;
        familyId: string;
        famRevoked: Date | null;
        clientRevoked: Date | null;
        clientId: string;
      }>(
        `SELECT t.scopes, t."expiresAt", t."familyId", f."revokedAt" AS "famRevoked", c."revokedAt" AS "clientRevoked", c."clientId"
           FROM "ApiToken" t JOIN "TokenFamily" f ON f.id = t."familyId" JOIN "ApiClient" c ON c.id = f."clientPk"
          WHERE t."tokenHash" = $1 AND t.kind = 'access'`,
        [hash(accessToken)],
      );
      const t = r.rows[0];
      if (!t || t.famRevoked || t.clientRevoked || new Date(t.expiresAt) <= now()) return null;
      return { clientId: t.clientId, scopes: t.scopes, familyId: t.familyId };
    },

    /**
     * Tokens for a client without a starting code, for an admin on the server itself
     * (`just api-token`). Audited as issued by that admin.
     */
    async issueDirect(clientId: string, by: string): Promise<Tokens> {
      const r = await sql.query<{ id: string; scopes: string[] }>(
        'SELECT id, scopes FROM "ApiClient" WHERE "clientId" = $1 AND "revokedAt" IS NULL',
        [clientId],
      );
      const c = r.rows[0];
      if (!c) throw new OAuthError('invalid_client', 'No such client.');
      const familyId = id();
      await sql.query('INSERT INTO "TokenFamily" (id, "clientPk") VALUES ($1, $2)', [
        familyId,
        c.id,
      ]);
      return issue(familyId, c.scopes, by, 'token.issued.admin');
    },

    /** An admin revokes a client: every token it holds stops working at once. */
    async revokeClient(clientId: string, by: string) {
      await sql.query(
        'UPDATE "ApiClient" SET "revokedAt" = $2 WHERE "clientId" = $1 AND "revokedAt" IS NULL',
        [clientId, now()],
      );
      await audit(by, 'client.revoked', clientId);
    },
  };
}
export type OAuth = ReturnType<typeof oauth>;

/** May this caller use this task on this bank? A client with no bank: scope may use every bank. */
export function allows(caller: Caller, scope: TaskScope, bank?: string): boolean {
  if (!caller.scopes.includes(scope)) return false;
  const banks = caller.scopes.filter((s) => s.startsWith('bank:')).map((s) => s.slice(5));
  return !bank || banks.length === 0 || banks.includes(bank);
}
