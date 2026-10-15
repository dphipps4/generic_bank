import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Bank } from '../context.js';
import { accountsOf, activity, balanceAt, dollars, findMember } from '../ledger.js';
import { readFields } from '../markup/dialect.js';
import {
  esc,
  font,
  form,
  heading,
  js,
  linkButton,
  message,
  nest,
  row,
  select,
  submit,
} from '../markup/html.js';
import { documentPdf, otherDocuments, statementPdf, statementsFor } from '../statements.js';
import { has } from '../tenants.js';
import { apiOperator, mainFrame, onSignedOut } from './frame.js';

// Statements: an account picker, a table drawn by script, and a Statement button per row that
// opens a new window, which receives the PDF by a plain GET.

/** What the page says about the months it does not list: the bank's own wording for "not available". */
export const KEPT_ONLINE = 'Only the last 12 months of statements are available online.';

/** Bank 4's per-window statement tokens: token to the session, account and month it opened. */
const windowTokens = new Map<
  string,
  { session: string; account: string; month: string; expires: number }
>();

export function statementRoutes(app: FastifyInstance, bank: Bank) {
  const base = bank.t.basePath;
  const L = bank.t.labels;

  app.get<{ Params: { n: string }; Querystring: { account?: string } }>(
    `${base}members/:n/statements`,
    async (req, reply) =>
      mainFrame(
        bank,
        req,
        reply,
        { page: 'statements', title: L.statements, member: req.params.n },
        async ({ c, d, member }) => {
          const n = member!.number;
          const accounts = await accountsOf(bank.db, n);
          const account = accounts.find((a) => String(a.id) === req.query.account) ?? accounts[0];
          if (!account) return { body: nest(c, d, message(c, 'This member has no accounts.')) };
          const picker = row(
            c,
            d,
            'Account',
            select(
              c,
              'account',
              accounts.map((a) => ({
                value: String(a.id),
                text: `${a.nickname}, ${bank.t.accountWording(a.number)}`,
                selected: a.id === account.id,
              })),
            ),
          );
          const box = d.cls('statements');
          const late = c.hz.on('late-rows') ? 3000 : 250;
          const viewMore = has(bank.t, 'view-more');
          const detached = has(bank.t, 'detached-menu');
          const viewer = has(bank.t, 'html-statement-viewer');
          const menu = d.cls('options');
          const script = `var CL_ALL = [];
function CL_render(limit) {
  var all = CL_ALL, h = '<table border="1" cellpadding="3" cellspacing="0"><tr><th><font size="1">Statement Date</font></th><th><font size="1">Statement Balance</font></th><th><font size="1">Document Type</font></th><th></th></tr>';
  for (var i = 0; i < all.length && i < limit; i++) {
    var x = all[i];
    var act = ${detached}
      ? '<a href="javascript:void(0)" onclick="CL_options(' + i + '); return false;"><font size="2">Options &#9662;</font></a>'
      : ${viewer}
        ? '<input type="button" value="Statement" onclick="location.href = \\'' + x.url + '\\'">'
        : '<input type="button" value="Statement" onclick="window.open(\\'' + x.url + '\\', \\'statement\\', \\'width=700,height=800\\')">';
    h += '<tr><td><font size="2">' + x.date + '</font></td><td align="right"><font size="2">' + (x.balance === null ? '&nbsp;' : CL.money(x.balance)) + '</font></td><td><font size="2">' + x.type + '</font></td><td>' + act + '</td></tr>';
  }
  h += '</table>';
  if (all.length > limit) { h += '<p><a href="javascript:void(0)" onclick="CL_render(1000); return false;"><font size="2">View more statements</font></a></p>'; }
  CL.byClass('div', ${js(box)})[0].innerHTML = h;
}
// Bank 3's Options menu is drawn at the end of the page, away from its row.
function CL_options(i) {
  var x = CL_ALL[i], m = CL.byClass('div', ${js(menu)})[0];
  if (!m) { m = document.createElement('div'); m.className = ${js(menu)}; m.style.cssText = 'margin:16px;border:1px solid #999;background:#FFFDF0;padding:6px;font:12px Arial;width:260px'; document.body.appendChild(m); }
  m.innerHTML = '<b>' + x.type + ', ' + x.date + '</b><br><a href="javascript:void(0)" onclick="window.open(\\'' + x.url + '\\', \\'statement\\', \\'width=700,height=800\\'); return false;">View</a> &nbsp; <a href="' + x.url + '&download=1" target="_blank">Download PDF</a>';
}
setTimeout(function () {
  CL.get(${js(`${base}api/members/${n}/accounts/${account.id}/statements`)}, function (err, r) {
    if (err) { (${onSignedOut(base)})(err); return; }
    CL_ALL = r.rows;
    CL_render(${viewMore ? 12 : 1000});
  });
}, ${late});`;
          return {
            body: nest(
              c,
              d,
              `${heading(c, d, L.statements)}${form(c, d, `${base}members/${n}/statements`, picker, submit(c, d, 'Show'))}<DIV CLASS="${box}"></DIV>
<P>${font(c, esc(KEPT_ONLINE))}</P>
<P>${linkButton(c, `${base}members/${n}/estatements`, 'Enroll in eStatements')} &nbsp; ${font(c, '|')} &nbsp; ${linkButton(c, `${base}members/${n}`, 'Back to member summary')}</P>`,
            ),
            script,
          };
        },
      ),
  );

  app.post<{ Params: { n: string }; Body: Record<string, string> }>(
    `${base}members/:n/statements`,
    async (req, reply) => {
      const { account } = readFields(req.body ?? {}, req.nonce, ['account'] as const);
      return reply.redirect(
        `${base}members/${encodeURIComponent(req.params.n)}/statements?account=${encodeURIComponent(account)}`,
      );
    },
  );

  app.get<{ Params: { n: string; id: string } }>(
    `${base}api/members/:n/accounts/:id/statements`,
    async (req, reply) => {
      if (!(await apiOperator(bank, req, reply))) return;
      const account = (await accountsOf(bank.db, req.params.n)).find(
        (a) => String(a.id) === req.params.id,
      );
      if (!account) return reply.code(404).send({ error: 'No such account for this member.' });
      const now = bank.now();
      const rows: {
        month: string;
        date: string;
        balance: number | null;
        type: string;
        url: string;
      }[] = (await statementsFor(bank.db, account.id, now)).map((r) => ({
        month: r.month,
        date: r.statementDate.toISOString().slice(0, 10),
        balance: r.balanceCents,
        type: r.documentType,
        // Bank 4 opens an HTML viewer in the main frame instead of a PDF window.
        url: `${base}${has(bank.t, 'html-statement-viewer') ? `members/${req.params.n}/statements/view?account=${account.id}&month=${r.month}` : `statement?member=${req.params.n}&account=${account.id}&month=${r.month}`}`,
      }));
      // Bank 3 lists notices and tax forms in the same table, between the statements.
      if (has(bank.t, 'documents-among-statements')) {
        for (const doc of otherDocuments(now)) {
          rows.push({
            month: doc.date.slice(0, 7),
            date: doc.date,
            balance: null,
            type: doc.type,
            url: `${base}document?kind=${doc.kind}&date=${doc.date}`,
          });
        }
        rows.sort((x, y) => (x.date < y.date ? 1 : x.date > y.date ? -1 : 0));
      }
      return { rows };
    },
  );

  app.get<{ Querystring: { kind?: string; date?: string } }>(
    `${base}document`,
    async (req, reply) => {
      if (!(await apiOperator(bank, req, reply))) return;
      const pdf = await documentPdf(
        bank.t,
        String(req.query.kind ?? ''),
        String(req.query.date ?? ''),
      );
      if (!pdf) return reply.code(404).type('text/plain').send('Document not found.');
      return reply.type('application/pdf').send(Buffer.from(pdf));
    },
  );

  // The PDF, by a plain GET in the window the button opened.
  app.get<{ Querystring: { member?: string; account?: string; month?: string; wt?: string } }>(
    `${base}statement`,
    async (req, reply) => {
      const who = await apiOperator(bank, req, reply);
      if (!who) return;
      // Bank 4: the PDF answers only the window the viewer opened, by its token.
      if (has(bank.t, 'window-token')) {
        const k = windowTokens.get(String(req.query.wt ?? ''));
        const ok =
          k &&
          k.session === who.session.token &&
          k.account === req.query.account &&
          k.month === req.query.month &&
          k.expires > bank.now().getTime();
        if (!ok)
          return reply
            .code(403)
            .type('text/plain')
            .send('This link has expired. Open the statement again.');
      }
      const member = await findMember(bank.db, String(req.query.member ?? ''));
      const account =
        member &&
        (await accountsOf(bank.db, member.number)).find((a) => String(a.id) === req.query.account);
      const pdf =
        member && account
          ? await statementPdf(bank.db, bank.t, member, account, String(req.query.month ?? ''))
          : null;
      if (!pdf) return reply.code(404).type('text/plain').send('Statement not found.');
      return reply
        .type('application/pdf')
        .header('content-disposition', `inline; filename="statement-${req.query.month}.pdf"`)
        .send(Buffer.from(pdf));
    },
  );
  // Bank 4's statement viewer: the statement as HTML in the main frame, with its own Download
  // button. The Download link carries a token for this window only.
  if (has(bank.t, 'html-statement-viewer')) {
    app.get<{ Params: { n: string }; Querystring: { account?: string; month?: string } }>(
      `${base}members/:n/statements/view`,
      async (req, reply) =>
        mainFrame(
          bank,
          req,
          reply,
          { page: 'statements', title: L.statements, member: req.params.n },
          async ({ c, d, member, session }) => {
            const account = (await accountsOf(bank.db, member!.number)).find(
              (a) => String(a.id) === req.query.account,
            );
            const month = String(req.query.month ?? '');
            const m = /^(\d{4})-(\d{2})$/.exec(month);
            if (!account || !m) return { body: nest(c, d, message(c, 'Statement not found.')) };
            const start = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1));
            const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
            const rows = (await activity(bank.db, account.id, start, end))
              .filter((r) => !r.pending)
              .reverse();
            const wt = randomBytes(12).toString('base64url');
            windowTokens.set(wt, {
              session: session.token,
              account: String(account.id),
              month,
              expires: bank.now().getTime() + 10 * 60_000,
            });
            if (windowTokens.size > 5000)
              windowTokens.delete(windowTokens.keys().next().value as string);
            const table = rows
              .map(
                (r) =>
                  `<TR><TD>${font(c, r.postedAt.toISOString().slice(0, 10))}</TD><TD>${font(c, esc(r.description))}</TD><TD ALIGN="right">${font(c, dollars(r.amountCents))}</TD></TR>`,
              )
              .join('');
            const download = `${base}statement?member=${member!.number}&account=${account.id}&month=${month}&wt=${wt}`;
            return {
              body: nest(
                c,
                d,
                `${heading(c, d, `${L.statements}: ${month}`)}<P>${font(c, `${esc(account.nickname)}, ${esc(bank.t.accountWording(account.number))}`)}</P>
<P>${font(c, `Opening balance ${dollars(await balanceAt(bank.db, account.id, start))}`)}</P>
<TABLE BORDER="1" CELLPADDING="3" CELLSPACING="0">${table}</TABLE>
<P>${font(c, `Closing balance ${dollars(await balanceAt(bank.db, account.id, end))}`)}</P>
<P><A HREF="${download}" TARGET="_blank">${font(c, '<B>Download</B>')}</A> &nbsp; ${linkButton(c, `${base}members/${member!.number}/statements?account=${account.id}`, 'Back to statements')}</P>`,
              ),
            };
          },
        ),
    );
  }
}
