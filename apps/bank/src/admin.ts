import { timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Bank } from './context.js';
import { accountsOf } from './ledger.js';

// Ground truth, for the test harness only. Tests never trust the automation's own account of what
// happened: they read the bank's ledger, its state changes and its hazard log here. It listens on
// its own port and answers only to the bank-admin token, which no service of ours holds.

function tokenMatches(header: string | undefined, token: string): boolean {
  const got = Buffer.from((header ?? '').replace(/^Bearer /, ''));
  const want = Buffer.from(token);
  return got.length === want.length && timingSafeEqual(got, want);
}

export async function buildAdmin(bank: Bank, token: string): Promise<FastifyInstance> {
  if (token.length < 32) throw new Error('the bank-admin token must be at least 32 characters');
  const app = Fastify({ logger: false });
  app.addHook('onRequest', async (req, reply) => {
    if (req.url === '/healthz') return;
    if (!tokenMatches(req.headers.authorization, token))
      return reply.code(401).send({ error: 'unauthorized' });
  });
  app.get('/healthz', async () => ({ ok: true, service: 'bank-admin', tenant: bank.t.id }));

  app.get('/state', async () => {
    const kinds = await bank.db.query<{ kind: string; n: number }>(
      'SELECT kind, count(*)::int AS n FROM state_changes GROUP BY kind ORDER BY kind',
    );
    const transfers = await bank.db.query<{
      confirmation: string;
      member_number: string;
      amount_cents: number;
      memo: string;
      approved_by: number | null;
      created_at: Date;
    }>(
      'SELECT confirmation, member_number, amount_cents, memo, approved_by, created_at FROM transfers ORDER BY id',
    );
    return {
      stateChanges: kinds.rows.reduce((s, r) => s + r.n, 0),
      byKind: Object.fromEntries(kinds.rows.map((r) => [r.kind, r.n])),
      transfers: transfers.rows.map((t) => ({
        confirmation: t.confirmation,
        member: t.member_number,
        amountCents: t.amount_cents,
        memo: t.memo,
        approved: t.approved_by !== null,
        at: new Date(t.created_at).toISOString(),
      })),
    };
  });

  app.get<{ Params: { member: string } }>('/members/:member/balances', async (req) =>
    (await accountsOf(bank.db, req.params.member)).map((a) => ({
      type: a.type,
      number: a.number,
      currentCents: a.currentCents,
      availableCents: a.availableCents,
    })),
  );

  app.get<{ Querystring: { limit?: string } }>('/hazards', async (req) => {
    const limit = Math.min(500, Math.max(1, Number(req.query.limit ?? 100) || 100));
    const r = await bank.db.query(
      'SELECT hazard, path, forced, detail, at FROM hazard_events ORDER BY id DESC LIMIT $1',
      [limit],
    );
    return r.rows;
  });

  app.get<{ Querystring: { address?: string } }>('/messages', async (req) => {
    const r = await bank.db.query(
      "SELECT mailbox, address, body, at FROM messages WHERE ($1 = '' OR address = $1) ORDER BY id DESC LIMIT 50",
      [String(req.query.address ?? '')],
    );
    return r.rows;
  });

  return app;
}
