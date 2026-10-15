import type { FastifyInstance } from 'fastify';
import type { Bank } from '../context.js';
import { accountsOf, findMember } from '../ledger.js';
import { readFields } from '../markup/dialect.js';
import {
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
          const menu = d.cls('options');
          const script = `var CL_ALL = [];
function CL_render(limit) {
  var all = CL_ALL, h = '<table border="1" cellpadding="3" cellspacing="0"><tr><th><font size="1">Statement Date</font></th><th><font size="1">Statement Balance</font></th><th><font size="1">Document Type</font></th><th></th></tr>';
  for (var i = 0; i < all.length && i < limit; i++) {
    var x = all[i];
    var act = ${detached}
      ? '<a href="javascript:void(0)" onclick="CL_options(' + i + '); return false;"><font size="2">Options &#9662;</font></a>'
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
        url: `${base}statement?member=${req.params.n}&account=${account.id}&month=${r.month}`,
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
  app.get<{ Querystring: { member?: string; account?: string; month?: string } }>(
    `${base}statement`,
    async (req, reply) => {
      if (!(await apiOperator(bank, req, reply))) return;
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
}
