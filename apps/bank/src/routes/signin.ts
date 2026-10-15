import { randomInt } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  checkCode,
  checkPassword,
  createSession,
  endSession,
  loadSession,
  maskEmail,
  maskPhone,
  operatorByPk,
  sendCode,
  setSession,
  token,
  trustedOperator,
  trustWorkstation,
  WORKSTATION_DAYS,
} from '../auth.js';
import { dialect, readFields } from '../markup/dialect.js';
import {
  type Ctx,
  doc,
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
import { type Bank, COOKIE, cookieOptions, ctxOf, current, rotateNonce } from '../context.js';

// The operator's way in: a loading shell, the sign-in page (two layouts), the code chooser, the
// code, and a hand-off page that is mid-sign-in, not signed in.

const html = (reply: FastifyReply, body: string) =>
  reply.type('text/html; charset=utf-8').send(body);

/** The script that enables a form only after the page has "hydrated". */
const hydrate = (ms: number) =>
  `setTimeout(function () { var f = document.forms[0]; if (!f) { return; } for (var i = 0; i < f.elements.length; i++) { f.elements[i].disabled = false; } }, ${ms});`;

export function signInPage(
  bank: Bank,
  req: FastifyRequest,
  o: { trusted: { id: string; name: string } | null; error?: string; note?: string },
) {
  const c = ctxOf(bank, req);
  const L = bank.t.labels;
  if (o.trusted) {
    const d = dialect(bank.t, bank.uiVersion, 'signin-welcome');
    const rows =
      row(c, d, L.password, input(c, 'password', { type: 'password', size: 16, disabled: true })) +
      row(c, d, L.operatorId, `${font(c, `<B>${esc(o.trusted.id)}</B>`)}`);
    const body = nest(
      c,
      d,
      `${heading(c, d, `Welcome back, ${o.trusted.name}`)}${o.error ? message(c, o.error) : ''}${o.note ? `<P>${font(c, esc(o.note))}</P>` : ''}
${form(c, d, `${c.base}signin`, rows, submit(c, d, L.signIn), '_top')}
<P>${linkButton(c, `${c.base}signin?other=1`, `Not ${o.trusted.name}? Sign in as someone else`, '_top')}</P>`,
    );
    return doc(c, d, { title: 'Sign In', body, script: hydrate(randomInt(300, 900)) });
  }
  const d = dialect(bank.t, bank.uiVersion, 'signin');
  const rows =
    row(c, d, L.operatorId, input(c, 'operator', { size: 12, disabled: true })) +
    row(c, d, L.password, input(c, 'password', { type: 'password', size: 16, disabled: true }));
  const banner =
    bank.t.theme === 'y2003'
      ? `<MARQUEE SCROLLAMOUNT="3">${font(c, `Welcome to ${esc(bank.t.brand)} Online Branch &nbsp;&middot;&nbsp; Branch hours are 9 to 5 &nbsp;&middot;&nbsp; Remember to sign out when you leave your workstation`)}</MARQUEE>`
      : '';
  const body = nest(
    c,
    d,
    `${banner}${heading(c, d, `${bank.t.brand}: CoreLink Branch Console`)}${o.error ? message(c, o.error) : ''}${o.note ? `<P>${font(c, esc(o.note))}</P>` : ''}
${form(c, d, `${c.base}signin`, rows, submit(c, d, L.signIn), '_top')}`,
  );
  return doc(c, d, { title: 'Sign In', body, script: hydrate(randomInt(300, 900)) });
}

/** A session waiting for its code, or null. */
async function codeSession(bank: Bank, req: FastifyRequest) {
  const s = await loadSession(bank.db, req.cookies[COOKIE.session]);
  if (!s || s.state !== 'code' || s.operatorPk === null) return null;
  const operator = await operatorByPk(bank.db, s.operatorPk);
  return operator ? { session: s, operator } : null;
}

async function handOff(bank: Bank, reply: FastifyReply, sessionToken: string) {
  const h = token();
  await setSession(bank.db, sessionToken, { state: 'handoff', handoff: h });
  return reply.redirect(`${bank.t.basePath}auth/callback?code=${encodeURIComponent(h)}`);
}

function codePage(c: Ctx, bank: Bank, o: { error?: string }) {
  const d = dialect(bank.t, bank.uiVersion, 'code-enter');
  const rows =
    row(c, d, 'Code', input(c, 'code', { size: 8 })) +
    `<TR><TD COLSPAN="2"></TD><TD>${input(c, 'trust', { type: 'checkbox', value: '1' })} ${font(c, `Trust this workstation for ${WORKSTATION_DAYS} days`)}</TD></TR>`;
  return doc(c, d, {
    title: 'Enter Code',
    body: nest(
      c,
      d,
      `${heading(c, d, 'Enter the 6-digit code we sent.')}${o.error ? message(c, o.error) : ''}
${form(c, d, `${c.base}code/enter`, rows, submit(c, d, 'Verify'), '_top')}
<P>${linkButton(c, `${c.base}code`, 'Send a new code', '_top')}</P>`,
    ),
  });
}

export function signInRoutes(app: FastifyInstance, bank: Bank) {
  const base = bank.t.basePath;
  const L = bank.t.labels;

  // Entry: a blank "Loading..." shell; a script moves on to the sign-in page after a delay.
  app.get(base, async (req, reply) => {
    const c = ctxOf(bank, req);
    const d = dialect(bank.t, bank.uiVersion, 'shell');
    return html(
      reply,
      doc(c, d, {
        title: 'CoreLink Branch Console',
        body: `<P>&nbsp;</P><P>${font(c, 'Loading&hellip;')}</P>`,
        script: `setTimeout(function () { location.replace(${js(`${base}signin`)}); }, ${randomInt(600, 1400)});`,
        footer: false,
      }),
    );
  });

  app.get<{ Querystring: { expired?: string; other?: string; signedout?: string } }>(
    `${base}signin`,
    async (req, reply) => {
      const trusted = req.query.other
        ? null
        : await trustedOperator(bank.db, req.cookies[COOKIE.workstation], bank.now());
      const note = req.query.expired ? 'Your session has ended. Sign in again.' : undefined;
      return html(
        reply,
        signInPage(bank, req, {
          trusted: trusted && { id: trusted.operatorId, name: trusted.displayName },
          note,
        }),
      );
    },
  );

  app.post<{ Body: Record<string, string> }>(`${base}signin`, async (req, reply) => {
    const now = bank.now();
    const trusted = await trustedOperator(bank.db, req.cookies[COOKIE.workstation], now);
    const f = readFields(req.body ?? {}, req.nonce, ['operator', 'password'] as const);
    const operatorId = f.operator || trusted?.operatorId || '';
    const r = await checkPassword(bank.db, operatorId, f.password, now);
    const shownTrusted =
      !f.operator && trusted ? { id: trusted.operatorId, name: trusted.displayName } : null;
    if (!r.ok) {
      const error =
        r.reason === 'locked'
          ? 'This operator is locked. Contact your administrator.'
          : `The ${L.operatorId} and ${L.password.toLowerCase()} do not match.`;
      return html(reply, signInPage(bank, req, { trusted: shownTrusted, error }));
    }
    const skipCode = trusted?.pk === r.operator.pk;
    const s = await createSession(bank.db, r.operator.pk, skipCode ? 'handoff' : 'code', now);
    reply.setCookie(COOKIE.session, s, cookieOptions(bank));
    rotateNonce(bank, req, reply);
    if (skipCode) return handOff(bank, reply, s);
    return reply.redirect(`${base}code`);
  });

  // "Where should we send your code?"
  app.get(`${base}code`, async (req, reply) => {
    const cs = await codeSession(bank, req);
    if (!cs) return reply.redirect(`${base}signin`);
    if (bank.t.codeChannels.length === 1) {
      await sendCode(
        bank.db,
        cs.operator,
        'sign-in',
        bank.t.codeChannels[0]!,
        bank.t.brand,
        bank.now(),
      );
      return reply.redirect(`${base}code/enter`);
    }
    const c = ctxOf(bank, req);
    const d = dialect(bank.t, bank.uiVersion, 'code');
    const choice = (channel: 'text' | 'email', text: string, first: boolean) =>
      `<TR><TD COLSPAN="2"></TD><TD>${input(c, 'channel', { type: 'radio', value: channel, checked: first })} ${font(c, esc(text))}</TD></TR>`;
    const rows =
      choice('text', `Text message to ${maskPhone(cs.operator.phone)}`, true) +
      choice('email', `Email to ${maskEmail(cs.operator.email)}`, false);
    return html(
      reply,
      doc(c, d, {
        title: 'Verify',
        body: nest(
          c,
          d,
          `${heading(c, d, 'Where should we send your code?')}${form(c, d, `${base}code`, rows, submit(c, d, 'Send code'), '_top')}`,
        ),
      }),
    );
  });

  app.post<{ Body: Record<string, string> }>(`${base}code`, async (req, reply) => {
    const cs = await codeSession(bank, req);
    if (!cs) return reply.redirect(`${base}signin`);
    const { channel } = readFields(req.body ?? {}, req.nonce, ['channel'] as const);
    const ch =
      channel === 'email' && bank.t.codeChannels.includes('email')
        ? 'email'
        : (bank.t.codeChannels[0] ?? 'text');
    await sendCode(bank.db, cs.operator, 'sign-in', ch, bank.t.brand, bank.now());
    return reply.redirect(`${base}code/enter`);
  });

  app.get(`${base}code/enter`, async (req, reply) => {
    if (!(await codeSession(bank, req))) return reply.redirect(`${base}signin`);
    return html(reply, codePage(ctxOf(bank, req), bank, {}));
  });

  app.post<{ Body: Record<string, string> }>(`${base}code/enter`, async (req, reply) => {
    const cs = await codeSession(bank, req);
    if (!cs) return reply.redirect(`${base}signin`);
    const now = bank.now();
    const f = readFields(req.body ?? {}, req.nonce, ['code', 'trust'] as const);
    const r = await checkCode(bank.db, cs.operator.pk, 'sign-in', f.code, now);
    if (r !== 'ok') {
      const error = r === 'wrong' ? 'That code is not correct.' : 'That code has expired.';
      return html(reply, codePage(ctxOf(bank, req), bank, { error }));
    }
    if (f.trust === '1') {
      const w = await trustWorkstation(bank.db, cs.operator.pk, now);
      reply.setCookie(COOKIE.workstation, w, cookieOptions(bank, WORKSTATION_DAYS * 86_400));
    }
    return handOff(bank, reply, cs.session.token);
  });

  // The hand-off: a blank page that holds for a moment. Mid-sign-in, not signed in.
  app.get<{ Querystring: { code?: string } }>(`${base}auth/callback`, async (req, reply) => {
    const c = ctxOf(bank, req);
    const d = dialect(bank.t, bank.uiVersion, 'callback');
    const wait = c.hz.on('slow-handoff') ? randomInt(5000, 8001) : randomInt(400, 1000);
    const next = `${base}auth/complete?code=${encodeURIComponent(String(req.query.code ?? ''))}`;
    return html(
      reply,
      doc(c, d, {
        title: 'Signing in',
        body: '&nbsp;',
        footer: false,
        script: `setTimeout(function () { location.replace(${js(next)}); }, ${wait});`,
      }),
    );
  });

  app.get<{ Querystring: { code?: string } }>(`${base}auth/complete`, async (req, reply) => {
    const s = await loadSession(bank.db, req.cookies[COOKIE.session]);
    if (!s || s.state !== 'handoff' || !s.handoff || s.handoff !== req.query.code)
      return reply.redirect(`${base}signin`);
    const now = bank.now();
    const early = req.hz.on('early-expiry')
      ? new Date(now.getTime() + randomInt(60_000, 8 * 60_000))
      : null;
    await setSession(bank.db, s.token, {
      state: 'active',
      handoff: null,
      last_seen: now,
      expires_early_at: early,
    });
    return reply.redirect(`${base}console`);
  });

  app.post(`${base}keepalive`, async (req, reply) =>
    reply.code((await current(bank, req)) ? 204 : 401).send(),
  );

  app.get(`${base}signout`, async (req, reply) => {
    const t = req.cookies[COOKIE.session];
    if (t) await endSession(bank.db, t);
    reply.clearCookie(COOKIE.session, { path: base });
    const c = ctxOf(bank, req);
    const d = dialect(bank.t, bank.uiVersion, 'signout');
    return html(
      reply,
      doc(c, d, {
        title: 'Signed Out',
        body: nest(
          c,
          d,
          `${heading(c, d, 'You have signed out.')}<P>${linkButton(c, `${base}signin`, `${L.signIn} again`, '_top')}</P>`,
        ),
      }),
    );
  });
}
