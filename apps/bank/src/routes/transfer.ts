import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { checkCode, operatorById, sendCode, setSession } from '../auth.js';
import type { Bank } from '../context.js';
import { has } from '../tenants.js';
import {
  accountsOf,
  checkTransfer,
  dollars,
  parseDollars,
  postTransfer,
  REFUSAL_TEXT,
} from '../ledger.js';
import { dialect, fieldName, readFields } from '../markup/dialect.js';
import {
  type Ctx,
  esc,
  font,
  form,
  heading,
  input,
  js,
  linkButton,
  message,
  nest,
  row,
  submit,
} from '../markup/html.js';
import { type MainArgs, mainFrame, onSignedOut } from './frame.js';

// A transfer between the member's own accounts: the form, a review page that repeats it with
// Submit transfer, Edit and Cancel, supervisor approval above the bank's threshold, and the
// confirmation number. The one irreversible step, and the one the swallowed-submit hazard hits.

interface Pending {
  member: string;
  fromId: number;
  toId: number;
  amountCents: number;
  memo: string;
  ref: string;
  awaitingApproval?: boolean;
}

const MEMO = /^[A-Za-z0-9 -]{0,32}$/;

/** The confirmation prefix: the brand's initials, "GB" for Generic Bank. */
export const prefixOf = (brand: string) =>
  brand
    .split(/\s+/)
    .map((w) => w.charAt(0))
    .join('')
    .toUpperCase();

const pendingFor = (a: MainArgs) => {
  const p = a.session.pending as Pending | null;
  return p && p.member === a.member!.number ? p : null;
};

export function transferRoutes(app: FastifyInstance, bank: Bank) {
  const base = bank.t.basePath;
  const L = bank.t.labels;
  const at = (n: string, rest = '') => `${base}members/${n}/transfer${rest}`;

  async function formPage(
    a: MainArgs,
    o: { error?: string; values?: Partial<Pending> & { amount?: string } },
  ) {
    const { c, d } = a;
    const n = a.member!.number;
    const v = o.values ?? {};
    const rows =
      row(
        c,
        d,
        'From',
        `<SELECT NAME="${fieldName(c.nonce, 'from')}"><OPTION VALUE="">Loading accounts&hellip;</OPTION></SELECT>`,
      ) +
      row(
        c,
        d,
        'To',
        `<SELECT NAME="${fieldName(c.nonce, 'to')}"><OPTION VALUE="">Loading accounts&hellip;</OPTION></SELECT>`,
      ) +
      row(
        c,
        d,
        'Amount',
        amountControl(c, v.amount ?? (v.amountCents ? (v.amountCents / 100).toFixed(2) : '')),
      ) +
      row(c, d, 'Memo', input(c, 'memo', { size: 24, value: v.memo ?? '' }));
    // The account options exist only after this script has run.
    const script = `CL.get(${js(`${base}api/members/${n}/accounts`)}, function (err, r) {
  if (err) { (${onSignedOut(base)})(err); return; }
  var sel = document.forms[0].getElementsByTagName('select'), want = [${v.fromId ?? 0}, ${v.toId ?? 0}];
  for (var s = 0; s < 2; s++) {
    sel[s].options.length = 0;
    sel[s].options[0] = new Option('Choose an account', '');
    for (var i = 0; i < r.accounts.length; i++) {
      var a = r.accounts[i];
      sel[s].options[sel[s].options.length] = new Option(a.nickname + ', ' + a.wording + ', available ' + CL.money(a.available), String(a.id), false, a.id === want[s]);
    }
  }
});`;
    return {
      script: script + keypressScript(c) + coveringBar(),
      body: nest(
        c,
        d,
        `${heading(c, d, L.transferFunds)}${o.error ? message(c, o.error) : ''}${form(c, d, at(n), rows, submit(c, d, L.continue))}
<P>${linkButton(c, `${base}members/${n}`, 'Back to member summary')}</P>`,
      ),
    };
  }

  /**
   * The amount field. Bank 3's reads its value only from key presses: a value set any other way
   * (pasted, or assigned by a script) shows in the box but is never sent.
   */
  function amountControl(c: Ctx, value: string) {
    if (!has(bank.t, 'keypress-only')) return input(c, 'amount', { size: 12, value });
    return `${input(c, 'amount-typed', { size: 12 })}${input(c, 'amount', { type: 'hidden' })}`;
  }

  function keypressScript(c: Ctx) {
    if (!has(bank.t, 'keypress-only')) return '';
    return `
(function () {
  var f = document.forms[document.forms.length - 1], buf = '';
  var shown = f.elements[${js(fieldName(c.nonce, 'amount-typed'))}], real = f.elements[${js(fieldName(c.nonce, 'amount'))}];
  shown.onkeydown = function (e) {
    e = e || window.event;
    var k = e.key;
    if (k === 'Tab' || k === 'Enter') { return true; }
    if (k === 'Backspace') { buf = buf.slice(0, -1); }
    else if (k && k.length === 1 && /[0-9.,$]/.test(k)) { buf += k; }
    shown.value = buf;
    return false;
  };
  f.onsubmit = function () { real.value = buf; return true; };
})();`;
  }

  /** Bank 3: a notice bar drawn over the submit control, until someone dismisses it. */
  function coveringBar() {
    if (!has(bank.t, 'covering-bar')) return '';
    return `
setTimeout(function () {
  var f = document.forms[document.forms.length - 1], all = f.getElementsByTagName('*'), t = null;
  for (var i = 0; i < all.length && !t; i++) {
    var e = all[i], ty = (e.getAttribute('type') || '').toLowerCase();
    if (e.nodeName === 'BUTTON' || ty === 'image' || ty === 'submit' || (e.getAttribute('onclick') || '').indexOf('CL.go') >= 0) { t = e; }
  }
  if (!t) { return; }
  var r = t.getBoundingClientRect(), bar = document.createElement('div');
  bar.style.cssText = 'position:fixed;left:0;right:0;top:' + (r.top - 8) + 'px;height:' + (r.height + 16) + 'px;background:#FFF5CC;border-top:2px solid #C9A400;border-bottom:2px solid #C9A400;font:12px Arial;padding:4px 10px;z-index:8';
  bar.innerHTML = '<b>Notice:</b> the wire cut-off today is 3:00 PM. &nbsp; <a href="javascript:void(0)">Dismiss</a>';
  bar.getElementsByTagName('a')[0].onclick = function () { bar.parentNode.removeChild(bar); return false; };
  document.body.appendChild(bar);
}, 300);`;
  }

  async function describe(p: Pending) {
    const accounts = await accountsOf(bank.db, p.member);
    const name = (id: number) => {
      const x = accounts.find((y) => y.id === id);
      return x ? `${x.nickname}, ${bank.t.accountWording(x.number)}` : 'unknown account';
    };
    return { from: name(p.fromId), to: name(p.toId) };
  }

  async function summaryRows(c: Ctx, p: Pending) {
    const w = await describe(p);
    const r = (k: string, v: string) =>
      `<TR><TD ALIGN="right">${font(c, `<B>${esc(k)}:</B>`)}</TD><TD>${font(c, esc(v))}</TD></TR>`;
    return `<TABLE CELLPADDING="3" CELLSPACING="0" BORDER="0">${r('From', w.from)}${r('To', w.to)}${r('Amount', dollars(p.amountCents))}${r('Memo', p.memo || '(none)')}</TABLE>`;
  }

  function approvalPage(a: MainArgs, p: Pending, error?: string) {
    const { c, d } = a;
    const dd = dialect(bank.t, bank.uiVersion, 'approve');
    const rows =
      row(c, dd, 'Supervisor ID', input(c, 'supervisor', { size: 8 })) +
      row(c, dd, 'Approval code', input(c, 'code', { size: 8 }));
    return summaryRows(c, p).then((s) => ({
      body: nest(
        c,
        d,
        `${heading(c, d, 'Supervisor approval required')}${error ? message(c, error) : ''}<P>${font(c, `Transfers over ${dollars(bank.t.supervisorThresholdCents)} need a supervisor. An approval code has been sent to the supervisor on duty.`)}</P>${s}
${form(c, dd, at(p.member, '/approve'), rows, submit(c, dd, 'Approve'))}<P>${linkButton(c, at(p.member, '/cancel'), 'Cancel')}</P>`,
      ),
    }));
  }

  async function post(a: MainArgs, p: Pending, approvedBy: number | null) {
    const now = bank.now();
    const refusal = await checkTransfer(
      bank.db,
      {
        memberNumber: p.member,
        fromId: p.fromId,
        toId: p.toId,
        amountCents: p.amountCents,
        memo: p.memo,
        operatorPk: a.operator.pk,
      },
      now,
    );
    if (refusal) {
      await setSession(bank.db, a.session.token, { pending: null });
      return {
        body: nest(
          a.c,
          a.d,
          `${heading(a.c, a.d, L.transferFunds)}${message(a.c, REFUSAL_TEXT[refusal])}`,
        ),
      };
    }
    const confirmation = await postTransfer(
      bank.db,
      {
        memberNumber: p.member,
        fromId: p.fromId,
        toId: p.toId,
        amountCents: p.amountCents,
        memo: p.memo,
        operatorPk: a.operator.pk,
        approvedBy,
        prefix: prefixOf(bank.t.brand),
      },
      now,
    );
    await setSession(bank.db, a.session.token, { pending: null });
    return {
      body: nest(
        a.c,
        a.d,
        `${heading(a.c, a.d, 'Transfer posted')}<P>${font(a.c, `<B>Transfer posted. Confirmation number ${esc(confirmation)}.</B>`)}</P>${await summaryRows(a.c, p)}
<P>${linkButton(a.c, `${base}members/${p.member}`, 'Back to member summary')}</P>`,
      ),
    };
  }

  app.get<{ Params: { n: string }; Querystring: { edit?: string } }>(at(':n'), async (req, reply) =>
    mainFrame(
      bank,
      req,
      reply,
      { page: 'transfer', title: L.transferFunds, member: req.params.n },
      async (a) => {
        const p = req.query.edit ? pendingFor(a) : null;
        return formPage(a, { values: p ?? {} });
      },
    ),
  );

  app.post<{ Params: { n: string }; Body: Record<string, string> }>(at(':n'), async (req, reply) =>
    mainFrame(
      bank,
      req,
      reply,
      { page: 'transfer', title: L.transferFunds, member: req.params.n },
      async (a) => {
        const f = readFields(req.body ?? {}, req.nonce, ['from', 'to', 'amount', 'memo'] as const);
        const values = {
          fromId: Number(f.from) || 0,
          toId: Number(f.to) || 0,
          amount: f.amount,
          memo: f.memo,
        };
        const amountCents = parseDollars(f.amount);
        if (a.c.hz.on('validation-error') || amountCents === null)
          return formPage(a, { error: REFUSAL_TEXT.validation, values });
        if (!values.fromId || !values.toId)
          return formPage(a, { error: 'Choose both accounts.', values });
        if (!MEMO.test(f.memo))
          return formPage(a, {
            error: 'The memo may have up to 32 letters, digits, spaces and dashes.',
            values,
          });
        const refusal = await checkTransfer(
          bank.db,
          {
            memberNumber: a.member!.number,
            fromId: values.fromId,
            toId: values.toId,
            amountCents,
            memo: f.memo,
            operatorPk: a.operator.pk,
          },
          bank.now(),
        );
        if (refusal) return formPage(a, { error: REFUSAL_TEXT[refusal], values });
        const pending: Pending = {
          member: a.member!.number,
          fromId: values.fromId,
          toId: values.toId,
          amountCents,
          memo: f.memo.trim(),
          ref: randomBytes(4).toString('hex').toUpperCase(),
        };
        await setSession(bank.db, a.session.token, { pending });
        return { respond: () => reply.redirect(at(a.member!.number, '/review')) };
      },
    ),
  );

  app.get<{ Params: { n: string } }>(at(':n', '/review'), async (req, reply) =>
    mainFrame(
      bank,
      req,
      reply,
      { page: 'review', title: 'Review Transfer', member: req.params.n },
      async (a) => {
        const p = pendingFor(a);
        if (!p) return { body: nest(a.c, a.d, message(a.c, 'There is no transfer to review.')) };
        return {
          body: nest(
            a.c,
            a.d,
            `${heading(a.c, a.d, 'Review transfer')}<P>${font(a.c, 'Check the details with the member before you submit.')}</P>${await summaryRows(a.c, p)}
${form(a.c, a.d, at(p.member, '/submit'), '', submit(a.c, a.d, L.submitTransfer))}
<P>${linkButton(a.c, at(p.member, '?edit=1'), 'Edit')} &nbsp; ${linkButton(a.c, at(p.member, '/cancel'), 'Cancel')}</P>`,
          ),
          script: coveringBar(),
        };
      },
    ),
  );

  app.post<{ Params: { n: string } }>(at(':n', '/submit'), async (req, reply) =>
    mainFrame(
      bank,
      req,
      reply,
      { page: 'review', title: 'Transfer', member: req.params.n },
      async (a) => {
        const p = pendingFor(a);
        if (!p || p.awaitingApproval)
          return { body: nest(a.c, a.d, message(a.c, 'There is no transfer to submit.')) };
        if (p.amountCents > bank.t.supervisorThresholdCents) {
          const supervisor = await firstSupervisor(bank);
          if (supervisor)
            await sendCode(
              bank.db,
              supervisor,
              'approval',
              'text',
              bank.t.brand,
              bank.now(),
              p.ref,
            );
          const awaiting = { ...p, awaitingApproval: true };
          await setSession(bank.db, a.session.token, { pending: awaiting });
          return approvalPage(a, awaiting);
        }
        const out = await post(a, p, null);
        return a.c.hz.on('swallowed-submit') ? { respond: () => swallow(reply) } : out;
      },
    ),
  );

  app.post<{ Params: { n: string }; Body: Record<string, string> }>(
    at(':n', '/approve'),
    async (req, reply) =>
      mainFrame(
        bank,
        req,
        reply,
        { page: 'approve', title: 'Supervisor Approval', member: req.params.n },
        async (a) => {
          const p = pendingFor(a);
          if (!p || !p.awaitingApproval)
            return {
              body: nest(a.c, a.d, message(a.c, 'There is no transfer waiting for approval.')),
            };
          const f = readFields(req.body ?? {}, req.nonce, ['supervisor', 'code'] as const);
          const sup = await operatorById(bank.db, f.supervisor.trim());
          if (!sup || sup.role !== 'supervisor')
            return approvalPage(a, p, 'That ID is not a supervisor.');
          const r = await checkCode(bank.db, sup.pk, 'approval', f.code, bank.now(), p.ref);
          if (r !== 'ok')
            return approvalPage(
              a,
              p,
              r === 'wrong'
                ? 'The approval code is not correct.'
                : 'The approval code has expired.',
            );
          const out = await post(a, p, sup.pk);
          return a.c.hz.on('swallowed-submit') ? { respond: () => swallow(reply) } : out;
        },
      ),
  );

  app.get<{ Params: { n: string } }>(at(':n', '/cancel'), async (req, reply) =>
    mainFrame(
      bank,
      req,
      reply,
      { page: 'review', title: 'Transfer', member: req.params.n },
      async (a) => {
        await setSession(bank.db, a.session.token, { pending: null });
        return { respond: () => reply.redirect(`${base}members/${a.member!.number}`) };
      },
    ),
  );

  /** The transfer is committed; the answer is lost. Half the time a spinner, half a gateway error. */
  function swallow(reply: FastifyReply) {
    if (randomBytes(1)[0]! % 2 === 0) {
      return reply
        .code(200)
        .type('text/html; charset=utf-8')
        .send(
          `<HTML><BODY BGCOLOR="#FFFFFF"><CENTER><P>&nbsp;</P><FONT FACE="Verdana" SIZE="2">Processing your request&hellip; please wait.</FONT></CENTER></BODY></HTML>`,
        );
    }
    return reply
      .code(502)
      .type('text/html; charset=utf-8')
      .send(
        `<HTML><HEAD><TITLE>502 Bad Gateway</TITLE></HEAD><BODY><H1>Bad Gateway</H1><P>The proxy server received an invalid response from an upstream server.</P><HR><ADDRESS>CoreLink Gateway</ADDRESS></BODY></HTML>`,
      );
  }
}

async function firstSupervisor(bank: Bank) {
  const r = await bank.db.query<{ operator_id: string }>(
    `SELECT operator_id FROM operators WHERE role = 'supervisor' ORDER BY pk LIMIT 1`,
  );
  return r.rows[0] ? operatorById(bank.db, r.rows[0].operator_id) : null;
}
