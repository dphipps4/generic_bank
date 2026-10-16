import { randomInt } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  checkAuthenticator,
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
import { has } from '../tenants.js';
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
import {
  type Bank,
  COOKIE,
  cookieOptions,
  ctxOf,
  current,
  origins,
  rotateNonce,
} from '../context.js';

// The operator's way in: a loading shell, the sign-in page (two layouts), the code chooser, the
// code, and a hand-off page that is mid-sign-in, not signed in.

const html = (reply: FastifyReply, body: string) =>
  reply.type('text/html; charset=utf-8').send(body);

/**
 * The script that enables the page's forms only after the page has "hydrated". Every form: bank 3's
 * hidden copy comes first, and the form a person sees must still come alive.
 */
const hydrate = (ms: number) =>
  `setTimeout(function () { for (var k = 0; k < document.forms.length; k++) { var f = document.forms[k]; for (var i = 0; i < f.elements.length; i++) { f.elements[i].disabled = false; } } }, ${ms});`;

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
    return doc(c, d, { title: L.signIn, body, script: hydrate(randomInt(300, 900)) });
  }
  const d = dialect(bank.t, bank.uiVersion, 'signin');
  const rows =
    row(c, d, L.operatorId, input(c, 'operator', { size: 12, disabled: true })) +
    row(c, d, L.password, input(c, 'password', { type: 'password', size: 16, disabled: true }));
  const banner =
    bank.t.theme === 'y2003'
      ? `<MARQUEE SCROLLAMOUNT="3">${font(c, `Welcome to ${esc(bank.t.brand)} Online Branch &nbsp;&middot;&nbsp; Branch hours are 9 to 5 &nbsp;&middot;&nbsp; Remember to sign out when you leave your workstation`)}</MARQUEE>`
      : '';
  // Bank 3: a hidden copy of the password field and the button, earlier in the page. Whatever is
  // typed there is never sent.
  const shadow = has(bank.t, 'hidden-duplicate')
    ? // Its rows sit in a table of their own: a stray <TR> makes the HTML parser move them out of
      // the hidden block, which would draw the "hidden" copy on screen.
      `<DIV STYLE="display:none"><FORM METHOD="post" ACTION="${c.base}signin"><TABLE>${row(c, d, L.password, input(c, 'password-shadow', { type: 'password' }))}</TABLE>${submit(c, d, L.signIn, 'button')}</FORM></DIV>`
    : '';
  const body = nest(
    c,
    d,
    `${banner}${heading(c, d, `${bank.t.brand}: CoreLink Branch Console`)}${o.error ? message(c, o.error) : ''}${o.note ? `<P>${font(c, esc(o.note))}</P>` : ''}
${shadow}${form(c, d, `${c.base}signin`, rows, submit(c, d, L.signIn), '_top')}`,
  );
  return doc(c, d, { title: L.signIn, body, script: hydrate(randomInt(300, 900)) });
}

/**
 * The sign-in page as the operator meets it. Bank 4 shows a shell on its main origin whose sign-in
 * form is an inline frame from its second origin; everywhere else it is the form itself.
 */
export async function signInEntry(
  bank: Bank,
  req: FastifyRequest,
  o: { other?: boolean; note?: string },
) {
  const where = origins(bank, req);
  if (bank.t.secondOrigin === 'signin' && !where.onSecond) {
    const c = ctxOf(bank, req);
    const d = dialect(bank.t, bank.uiVersion, 'signin-shell');
    const q = new URLSearchParams({
      embedded: '1',
      ...(o.other ? { other: '1' } : {}),
      ...(o.note ? { expired: '1' } : {}),
    });
    return doc(c, d, {
      title: bank.t.labels.signIn,
      body: nest(
        c,
        d,
        `${heading(c, d, `${bank.t.brand}: CoreLink Branch Console`)}<IFRAME SRC="${where.second}${bank.t.basePath}signin?${q}" WIDTH="600" HEIGHT="320" FRAMEBORDER="0" SCROLLING="no"></IFRAME>`,
      ),
    });
  }
  const trusted = o.other
    ? null
    : await trustedOperator(bank.db, req.cookies[COOKIE.workstation], bank.now());
  return signInPage(bank, req, {
    trusted: trusted && { id: trusted.operatorId, name: trusted.displayName },
    note: o.note,
  });
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
  const app = bank.t.codeStyle === 'authenticator';
  const rows =
    row(c, d, 'Code', input(c, 'code', { size: 8 })) +
    `<TR><TD COLSPAN="2"></TD><TD>${input(c, 'trust', { type: 'checkbox', value: '1' })} ${font(c, `Trust this workstation for ${WORKSTATION_DAYS} days`)}</TD></TR>`;
  return doc(c, d, {
    title: 'Enter Code',
    body: nest(
      c,
      d,
      `${heading(c, d, app ? 'Enter the 6-digit code from your authenticator app.' : 'Enter the 6-digit code we sent.')}${o.error ? message(c, o.error) : ''}
${form(c, d, `${c.base}code/enter`, rows, submit(c, d, 'Verify'), '_top')}
${app ? '' : `<P>${linkButton(c, `${c.base}code`, 'Send a new code', '_top')}</P>`}`,
    ),
  });
}

/** Operators whose hand-off has bounced today, per bank (bank 4). */
const bouncedBy = new WeakMap<Bank, Set<string>>();

export function signInRoutes(app: FastifyInstance, bank: Bank) {
  const bounced = bouncedBy.get(bank) ?? new Set<string>();
  bouncedBy.set(bank, bounced);
  const base = bank.t.basePath;
  const L = bank.t.labels;
  // Where a sign-in lands: the console, or after a redesign, the page that announces it first.
  const landing = bank.t.redesigned ? 'refreshed' : 'console';

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

  app.get<{ Querystring: { expired?: string; other?: string; embedded?: string } }>(
    `${base}signin`,
    async (req, reply) => {
      const note = req.query.expired ? 'Your session has ended. Sign in again.' : undefined;
      return html(reply, await signInEntry(bank, req, { other: !!req.query.other, note }));
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
    // Bank 4: the code is already on the operator's authenticator app; nothing to send.
    if (bank.t.codeStyle === 'authenticator') return reply.redirect(`${base}code/enter`);
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
    const r =
      bank.t.codeStyle === 'authenticator'
        ? await checkAuthenticator(bank.db, cs.operator.pk, f.code, now)
        : await checkCode(bank.db, cs.operator.pk, 'sign-in', f.code, now);
    if (r !== 'ok') {
      // Bank 4: an expired code just clears the field, with no message.
      const silent = r === 'expired' && has(bank.t, 'silent-code-clear');
      const error = silent
        ? undefined
        : r === 'wrong'
          ? 'That code is not correct.'
          : 'That code has expired.';
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
    // Bank 4 signs in on its second origin; the console lives on the main one.
    const to = bank.t.secondOrigin === 'signin' ? origins(bank, req).main : '';
    // Bank 4: the first hand-off of the day draws the console for a moment, then drops the
    // operator back on the sign-in page. Signing in again works.
    const day = `${s.operatorPk}:${now.toISOString().slice(0, 10)}`;
    if (has(bank.t, 'handoff-bounce') && !bounced.has(day)) {
      bounced.add(day);
      await endSession(bank.db, s.token);
      const c = ctxOf(bank, req);
      const d = dialect(bank.t, bank.uiVersion, 'bounce');
      return html(
        reply,
        doc(c, d, {
          title: 'CoreLink',
          footer: false,
          body: `${heading(c, d, bank.t.brand)}<P>${font(c, 'Loading your workspace&hellip;')}</P>`,
          script: `setTimeout(function () { top.location.replace(${js(`${to}${base}signin`)}); }, 900);`,
        }),
      );
    }
    return reply.redirect(`${to}${base}${bank.t.termsAfterSignIn ? 'terms' : landing}`);
  });

  // Bank 3: "Terms updated: Acknowledge" after every sign-in, before the console.
  if (bank.t.termsAfterSignIn) {
    app.get(`${base}terms`, async (req, reply) => {
      if (!(await current(bank, req))) return reply.redirect(`${base}signin`);
      const c = ctxOf(bank, req);
      const d = dialect(bank.t, bank.uiVersion, 'terms');
      return html(
        reply,
        doc(c, d, {
          title: 'Terms updated',
          body: nest(
            c,
            d,
            `${heading(c, d, 'Terms updated')}<P>${font(c, 'The staff terms of use have changed. Read them and acknowledge to continue.')}</P>
<P>${font(c, 'Staff may act for a member only with the member present or on a verified call. Every action is recorded.')}</P>
${form(c, d, `${base}terms`, '', submit(c, d, 'Acknowledge'), '_top')}`,
          ),
        }),
      );
    });
    app.post(`${base}terms`, async (req, reply) =>
      reply.redirect(`${base}${(await current(bank, req)) ? landing : 'signin'}`),
    );
  }

  // The redesign: "We've refreshed Online Banking", once per sign-in, before the console.
  if (bank.t.redesigned) {
    app.get(`${base}refreshed`, async (req, reply) => {
      if (!(await current(bank, req))) return reply.redirect(`${base}signin`);
      const c = ctxOf(bank, req);
      const d = dialect(bank.t, bank.uiVersion, 'refreshed');
      return html(
        reply,
        doc(c, d, {
          title: 'Online Banking',
          body: nest(
            c,
            d,
            `${heading(c, d, "We've refreshed Online Banking")}<P>${font(c, `${esc(bank.t.brand)} has a new look. Everything you use is still here, under clearer names, and the Menu at the top right takes you anywhere.`)}</P>
${form(c, d, `${base}refreshed`, '', submit(c, d, 'Continue to Online Banking'), '_top')}`,
          ),
        }),
      );
    });
    app.post(`${base}refreshed`, async (req, reply) =>
      reply.redirect(`${base}${(await current(bank, req)) ? 'console' : 'signin'}`),
    );
  }

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
