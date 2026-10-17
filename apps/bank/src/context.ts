import { randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { loadSession, type Operator, operatorByPk, type Session, touch } from './auth.js';
import type { Db } from './db.js';
import type { HazardName, Hazards, RequestHazards } from './hazards.js';
import type { Ctx } from './markup/html.js';
import type { Tenant } from './tenants.js';

// What every route shares: the bank, the request's hazards and form nonce, cookies and the
// signed-in operator.

/** Everything a bank needs to answer a request. */
export interface Bank {
  t: Tenant;
  db: Db;
  hazards: Hazards;
  now: () => Date;
  /** BANK_UI_VERSION: bumping it relabels and moves things, for the repair loop. */
  uiVersion: number;
  /** The ports the bank answers on. A different port is a different origin. */
  ports?: { main: number; second?: number };
}

/**
 * The bank's two origins, built from the host the request came to, so a frame's URL is right
 * both from a person's browser (localhost) and from inside the compose network (bank-example).
 */
export function origins(bank: Bank, req: FastifyRequest) {
  const host = String(req.headers.host ?? 'localhost');
  const name = host.replace(/:\d+$/, '');
  const hostPort = Number(/:(\d+)$/.exec(host)?.[1] ?? 0);
  // Which of the bank's two servers answered: the port the request arrived on, inside the container.
  const local = req.socket?.localPort ?? hostPort;
  const main = bank.ports?.main ?? local;
  const second = bank.ports?.second ?? main + 10;
  // A second copy of the stack publishes every port moved by the same amount (just fork-ports):
  // links keep that shift, so a person's browser stays on the copy it is looking at.
  const shift = hostPort && local ? hostPort - local : 0;
  return {
    main: `http://${name}:${main + shift}`,
    second: `http://${name}:${second + shift}`,
  };
}

declare module 'fastify' {
  interface FastifyRequest {
    hz: RequestHazards;
    nonce: string;
  }
}

export const COOKIE = { session: 'CLSESS', form: 'CLFORM', workstation: 'CLWS' } as const;

export const ctxOf = (bank: Bank, req: FastifyRequest): Ctx => ({
  t: bank.t,
  base: bank.t.basePath,
  uiVersion: bank.uiVersion,
  nonce: req.nonce,
  hz: req.hz,
});

export const cookieOptions = (bank: Bank, maxAgeSeconds?: number) => ({
  path: bank.t.basePath,
  httpOnly: true,
  sameSite: 'lax' as const,
  ...(maxAgeSeconds ? { maxAge: maxAgeSeconds } : {}),
});

/** A fresh form nonce: field names change with it. Set at every new session. */
export function rotateNonce(bank: Bank, req: FastifyRequest, reply: FastifyReply) {
  req.nonce = randomBytes(12).toString('base64url');
  reply.setCookie(COOKIE.form, req.nonce, cookieOptions(bank));
}

/** The signed-in operator, or null. An idle or expired session ends here. */
export async function current(
  bank: Bank,
  req: FastifyRequest,
): Promise<{ session: Session; operator: Operator } | null> {
  const s = await loadSession(bank.db, req.cookies[COOKIE.session]);
  if (!s || s.state !== 'active' || s.operatorPk === null) return null;
  if (!(await touch(bank.db, s, bank.now()))) return null;
  const operator = await operatorByPk(bank.db, s.operatorPk);
  return operator ? { session: s, operator } : null;
}

/** Writes each hazard that fires to the bank's own hazard log. */
export const hazardLog =
  (db: Db, now: () => Date) =>
  (hazard: HazardName, path: string, forced: boolean): void => {
    db.query('INSERT INTO hazard_events (hazard, path, forced, at) VALUES ($1, $2, $3, $4)', [
      hazard,
      path,
      forced,
      now(),
    ]).catch(() => undefined);
  };

/** Writes a request the bot screen turned away to the hazard log, with the reason. */
export const refusalLog = (bank: Bank, path: string, reason: string) =>
  bank.db
    .query(
      'INSERT INTO hazard_events (hazard, path, forced, detail, at) VALUES ($1, $2, $3, $4, $5)',
      ['bot-screen', path, false, reason, bank.now()],
    )
    .catch(() => undefined);
