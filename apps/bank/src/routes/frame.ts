import { randomInt } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { type Operator, type Session, setSession } from '../auth.js';
import { type Bank, ctxOf, current } from '../context.js';
import { findMember, type Member, maskedName } from '../ledger.js';
import { type Dialect, dialect } from '../markup/dialect.js';
import {
  type Ctx,
  doc,
  esc,
  font,
  heading,
  linkButton,
  message,
  nest,
  palette,
} from '../markup/html.js';
import { signInEntry } from './signin.js';

// Every page in the main frame goes through here: the session, the page-level hazards, the
// promotional interstitial, and the member banner the member-scope guard reads.

export const html = (reply: FastifyReply, body: string) =>
  reply.type('text/html; charset=utf-8').send(body);

export interface MainArgs {
  c: Ctx;
  d: Dialect;
  operator: Operator;
  session: Session;
  member: Member | null;
}

/** A page body, or a response of its own (a redirect, a lost answer) that replaces the page. */
export type Rendered = { body: string; script?: string } | { respond: () => unknown };

export interface MainPage {
  page: string;
  title: string;
  /** The member this page is about: it must exist, and its banner heads the page. */
  member?: string;
}

export async function mainFrame(
  bank: Bank,
  req: FastifyRequest,
  reply: FastifyReply,
  o: MainPage,
  render: (a: MainArgs) => Promise<Rendered>,
) {
  const cur = await current(bank, req);
  // Expired or signed out: the sign-in page appears inside the main frame.
  if (!cur)
    return html(
      reply,
      await signInEntry(bank, req, { other: true, note: 'Your session has ended. Sign in again.' }),
    );
  const c = ctxOf(bank, req);
  const d = dialect(bank.t, bank.uiVersion, o.page);
  const page = (body: string, script?: string) =>
    html(reply, doc(c, d, { title: o.title, body, script, main: true }));

  if (c.hz.on('js-error-fatal')) {
    const ref = `ERR-${randomInt(100_000, 999_999)}`;
    return page(
      nest(
        c,
        d,
        `${heading(c, d, 'Error')}${message(c, `An unexpected error has occurred. Reference ${ref}`)}`,
      ),
    );
  }
  if (c.hz.on('unknown-screen')) {
    return page(
      nest(
        c,
        d,
        `${heading(c, d, 'System maintenance')}<P>${font(c, 'System maintenance: please verify your mailing address to continue.')}</P>
<P>${linkButton(c, `${c.base}home`, 'Verify address')}</P>`,
      ),
    );
  }
  if (!cur.session.promoShown) {
    await setSession(bank.db, cur.session.token, { promo_shown: true });
    if (c.hz.on('promo')) {
      return page(
        nest(
          c,
          d,
          `${heading(c, d, 'New in CoreLink')}<P>${font(c, 'CoreLink 4.5 brings faster member lookup and a refreshed look. Ask your administrator about upgrading.')}</P>
<P>${linkButton(c, req.url, 'Not now')} &nbsp; ${linkButton(c, `${c.base}home?learn=1`, 'Learn more')}</P>`,
        ),
      );
    }
  }

  let member: Member | null = null;
  let banner = '';
  if (o.member !== undefined) {
    member = await findMember(bank.db, o.member);
    if (!member) return page(nest(c, d, message(c, 'No member found with that number.')));
    if (c.hz.on('permission-denial'))
      return page(nest(c, d, message(c, 'You do not have permission to view this member.')));
    const p = palette(bank.t);
    banner = `<TABLE WIDTH="620" CELLPADDING="4" CELLSPACING="0" BORDER="0"><TR><TD BGCOLOR="${p.head}">${font(
      c,
      `<B>Member ${esc(member.number)} &middot; ${esc(maskedName(member))}</B>`,
      ` COLOR="${p.headText}"`,
    )}</TD></TR></TABLE>`;
  }
  const r = await render({ c, d, operator: cur.operator, session: cur.session, member });
  if ('respond' in r) return r.respond();
  return page(banner + r.body, r.script);
}

/** For the page scripts' JSON: a signed-in operator, or 401. */
export async function apiOperator(bank: Bank, req: FastifyRequest, reply: FastifyReply) {
  const cur = await current(bank, req);
  if (!cur) {
    reply.code(401).send({ error: 'Your session has ended.' });
    return null;
  }
  return cur;
}

/** What a page script does with a 401: the whole console goes back to sign-in. */
export const onSignedOut = (base: string) =>
  `function (status) { if (status === 401) { top.location.href = ${JSON.stringify(`${base}signin?expired=1`)}; } }`;
