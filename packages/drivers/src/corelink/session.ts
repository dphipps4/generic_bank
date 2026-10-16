// The way to a member, on CoreLink Branch Console: every screen any job meets between the sign-in
// page and the member's summary, and how each is answered. A job (Check Balance, Transfer) runs its
// own loop, hands each screen here first, and handles only its own screens. Recoverable conditions
// are handled inside the run, bounded and recorded; the bank's answers become the job's outcome.
import {
  button,
  click,
  field,
  normalize,
  recognize,
  type ScreenModel,
  TargetError,
  type,
  typeSecret,
} from '@gb/screen';
import { type DriverContext, type Seen, see, stop } from '../sdk.js';
import { signatures } from './signatures.js';

export interface Session {
  ctx: DriverContext;
  sigs: ReturnType<typeof signatures>;
  counts: {
    signIns: number;
    codeRounds: number;
    retries: number;
    inUse: number;
    reloads: number;
    sessionRestarts: number;
    steps: number;
    searches: number;
    notices: number;
  };
  /** The last address the run was on, for a reload or a retry. */
  lastUrl: string;
  stepStart: number;
  record(
    name: string,
    screen: string | null,
    model: ScreenModel | null,
    action?: string,
    outcome?: string,
  ): Promise<void> | void;
}

export function startSession(ctx: DriverContext): Session {
  const s: Session = {
    ctx,
    sigs: signatures(ctx.profile),
    counts: {
      signIns: 0,
      codeRounds: 0,
      retries: 0,
      inUse: 0,
      reloads: 0,
      sessionRestarts: 0,
      steps: 0,
      searches: 0,
      notices: 0,
    },
    lastUrl: ctx.profile.url,
    stepStart: Date.now(),
    record: (name, screen, model, action, outcome) =>
      ctx.step({ name, screen, action, outcome, ms: Date.now() - s.stepStart }, model),
  };
  return s;
}

/** A notice bar's own way out: the product draws some notices over the page, covering its buttons. */
const DISMISS = 'Dismiss';
const dismissable = (m: ScreenModel) => m.controls.some((c) => c.name === DISMISS);

/** The next screen, fully rendered and recognized; a dialog is answered with the non-committal choice. */
export async function next(sess: Session): Promise<Seen | null> {
  sess.stepStart = Date.now();
  const s = await see(sess.ctx, sess.sigs, {
    until: (m) => dismissable(m) || recognize(m, sess.sigs).screen !== null,
  });
  if (s.dialog) {
    await sess.ctx.page.answerDialog(false);
    await sess.record('dialog', null, null, `answered "${s.dialog.type}" with Cancel`, 'recovered');
    return null;
  }
  // A notice drawn over the page hides what is under it: dismiss it, a bounded number of times.
  if (dismissable(s.model) && sess.counts.notices++ < 5) {
    await click(sess.ctx.page, button(s.model, DISMISS));
    await sess.record(
      'notice',
      s.screen,
      s.model,
      'dismissed a notice drawn over the page',
      'recovered',
    );
    return null;
  }
  sess.lastUrl = s.model.url || sess.lastUrl;
  // Retries are per read: a good screen ends the streak, so three errors spread over a long run are
  // three recoveries, not a failure.
  if (s.screen && !s.screen.startsWith('error.')) sess.counts.retries = 0;
  return s;
}

/** A drop-down menu's title, drawn with a downward arrow after it. */
export const MENU = /\s[▾▼]$/;

/**
 * Presses the control with one of these names. One that sits in a closed drop-down menu is found
 * as a person finds it: by opening each menu in turn, and closing it again if it is not there.
 */
export async function openFromMenu(sess: Session, m: ScreenModel, names: string[]): Promise<void> {
  const page = sess.ctx.page;
  const wanted = names.map(normalize);
  const has = (x: ScreenModel) => x.controls.some((c) => wanted.includes(normalize(c.name)));
  if (has(m)) {
    await click(page, button(m, names));
    return;
  }
  for (const menu of m.controls.filter((c) => MENU.test(c.name.trim()))) {
    await click(page, menu);
    const open = await see(sess.ctx, [], { until: has, limitMs: 3_000 });
    if (has(open.model)) {
      await click(page, button(open.model, names));
      return;
    }
    await click(page, menu);
  }
  throw new TargetError('none', `button "${names.join('" or "')}"`);
}

/**
 * Presses the button with one of these names, on the screen as it is now: a notice drawn over it
 * since the screen was read is dismissed first.
 */
export async function pressOnScreen(sess: Session, names: string[]): Promise<void> {
  const page = sess.ctx.page;
  const wanted = names.map(normalize);
  const has = (m: ScreenModel) => m.controls.some((c) => wanted.includes(normalize(c.name)));
  for (let i = 0; i < 3; i++) {
    const s = await see(sess.ctx, sess.sigs, {
      until: (m) => has(m) || dismissable(m),
      limitMs: 30_000,
    });
    if (has(s.model)) {
      await click(page, button(s.model, names));
      return;
    }
    if (!dismissable(s.model)) break;
    await click(page, button(s.model, DISMISS));
    await sess.record(
      'notice',
      s.screen,
      s.model,
      'dismissed a notice drawn over the page',
      'recovered',
    );
  }
  throw new TargetError('none', `button "${names.join('" or "')}"`);
}

/**
 * Answers a screen on the way to the member. Returns true when it was handled here; stops the run
 * (throws) when the bank has given its answer; returns false for a screen the job must handle.
 */
export async function onTheWay(sess: Session, s: Seen, memberId: string): Promise<boolean> {
  const { ctx, counts } = sess;
  const page = ctx.page;
  const w = ctx.profile.words;
  switch (s.screen) {
    case 'login.signin':
    case 'login.welcome_back':
    case 'login.session_ended': {
      if (s.screen === 'login.session_ended' || counts.signIns > 0) {
        // Signed out under us: sign in once more, then go back to the member.
        if (counts.sessionRestarts++ >= 1)
          stop('failed', 'unavailable', 'the session ended twice', true);
      }
      if (counts.signIns++ >= 3)
        stop('failed', 'bad_credentials', 'signed in three times without getting in');
      counts.codeRounds = 0;
      const creds = await ctx.credentials();
      // The credentials go in by the secret path only: the guard refuses them as plain text.
      if (s.screen !== 'login.welcome_back')
        await typeSecret(page, field(s.model, w.operatorId), creds.operatorId);
      await typeSecret(page, field(s.model, w.password), creds.password);
      await click(page, button(s.model, w.signIn));
      await sess.record(
        'sign in',
        s.screen,
        s.model,
        'typed the operator ID and password; pressed sign in',
      );
      return true;
    }
    case 'login.bad_credentials':
      await sess.record('sign in', s.screen, s.model, undefined, 'refused');
      return stop('failed', 'bad_credentials');
    case 'login.locked':
      await sess.record('sign in', s.screen, s.model, undefined, 'locked');
      return stop('failed', 'operator_locked');
    case 'login.code_choose':
      await click(page, button(s.model, 'Send code'));
      await sess.record('staff code', s.screen, s.model, 'asked for the code by text');
      return true;
    case 'login.code_enter':
    case 'login.code_wrong':
    case 'login.code_expired': {
      // Three codes per sign-in, whatever the bank says: a bank that clears the field without a
      // word shows the code page again as if it were new.
      if (counts.codeRounds >= 3)
        return stop('failed', 'bad_credentials', 'three codes were refused');
      if (s.screen === 'login.code_expired' && ctx.profile.codeStyle === 'sent') {
        await click(page, button(s.model, 'Send a new code'));
        await sess.record('staff code', s.screen, s.model, 'the code expired; asked for a new one');
        return true;
      }
      counts.codeRounds++;
      const code = await ctx.askHuman({
        kind: 'staff_code',
        prompt:
          ctx.profile.codeStyle === 'authenticator'
            ? 'The bank asks for the code from the staff authenticator app. Enter it here.'
            : 'The bank sent a sign-in code to the staff phone. Enter it here.',
      });
      await type(page, field(s.model, 'Code'), code);
      await click(page, button(s.model, 'Verify'));
      await sess.record('staff code', s.screen, s.model, 'typed the code a person gave');
      return true;
    }
    case 'login.terms':
      await click(page, button(s.model, 'Acknowledge'));
      await sess.record('terms', s.screen, s.model, 'acknowledged the updated terms');
      return true;
    case 'dialog.promo':
      await click(page, button(s.model, 'Not now'));
      await sess.record('interstitial', s.screen, s.model, 'pressed Not now', 'recovered');
      return true;
    case 'login.notice':
      await click(page, button(s.model, w.dismiss));
      await sess.record('notice', s.screen, s.model, `pressed ${w.dismiss[0]}`);
      return true;
    case 'console.home': {
      if (w.menu.length) {
        // The places to go are behind the bank's menu: open it, then wait for member search.
        await click(page, button(s.model, w.menu));
        const m = (
          await see(ctx, sess.sigs, {
            until: (x) =>
              x.controls.some((c) =>
                w.memberSearch.some((n) => normalize(n) === normalize(c.name)),
              ),
          })
        ).model;
        await sess.record('console', s.screen, m, 'opened the menu');
        await click(page, button(m, w.memberSearch));
      } else {
        // Without a menu of its own, member search may still sit in a closed drop-down.
        await openFromMenu(sess, s.model, w.memberSearch);
      }
      await sess.record('console', s.screen, s.model, 'opened member search');
      return true;
    }
    case 'member.search': {
      // A retry or a reload goes back through the search; three searches without a result is not
      // progress.
      if (counts.searches++ >= 3)
        return stop('escalated', 'stuck', 'searched three times without a result');
      await type(page, field(s.model, w.memberNumber), memberId);
      const press = () => click(page, button(s.model, w.search));
      // The result is drawn by script into the same page, or into a window of its own.
      const inWindow = ctx.profile.searchResults === 'window';
      let where = page;
      if (inWindow) where = await page.openedWindow(press);
      else await press();
      await sess.record('member search', s.screen, s.model, 'searched by member number');
      try {
        const r = await see({ ...ctx, page: where }, sess.sigs, {
          until: (m) =>
            m.controls.some((c) => c.name === 'Open') ||
            m.texts.some((t) =>
              /No member found|Member status: Closed|in use by another operator|Enter an 8-digit|Enter a member number/.test(
                t.text,
              ),
            ),
        });
        // A search that produced a result is progress: only searches that come back empty count.
        // The search page drawn again with no result is not one.
        if (
          r.model.controls.some((c) => c.name === 'Open') ||
          (r.screen && r.screen !== 'member.search')
        )
          counts.searches = 0;
        // The result row names the member: learn it, so it is masked from here on. It is the row
        // with Open on it, or, for a member who cannot be opened (a closed one), with their number.
        const open = r.model.controls.find((c) => c.name === 'Open');
        const anchor = open?.box ?? r.model.texts.find((t) => t.text.includes(memberId))?.box;
        if (anchor) {
          const row = r.model.texts.filter(
            (t) => Math.abs(t.box.y + t.box.h / 2 - (anchor.y + anchor.h / 2)) < 8,
          );
          ctx.learn(
            row
              .map((t) =>
                // A row drawn as one line carries the number and the status around the name.
                t.text
                  .replace(/^\d{8}\s+/, '')
                  .replace(/\s+(Active|Closed)$/i, '')
                  .trim(),
              )
              .filter((t) => t && !/^(Active|Closed|Open)$/i.test(t) && !/^\d+$/.test(t)),
          );
        }
        if (open) {
          await click(where, button(r.model, 'Open'));
          await sess.record('member search', 'member.found', r.model, 'opened the member');
        } else {
          await sess.record('member search', r.screen, r.model, undefined, r.screen ?? 'no result');
          // The bank's answer in a window is read there; on the page, on the next turn of the loop.
          if (inWindow && r.screen && r.screen !== 'member.search')
            await onTheWay(sess, r, memberId);
        }
      } finally {
        if (where !== page) await where.close();
      }
      return true;
    }
    case 'member.no_such_member':
      await sess.record('member search', s.screen, s.model, undefined, 'no such member');
      return stop('business_outcome', 'no_such_member');
    case 'member.closed':
      await sess.record('member search', s.screen, s.model, undefined, 'member closed');
      return stop('business_outcome', 'member_closed');
    case 'member.permission':
      await sess.record('member', s.screen, s.model, undefined, 'permission denied');
      return stop('business_outcome', 'permission_denied');
    case 'member.in_use': {
      await sess.record('member search', s.screen, s.model, undefined, 'record in use');
      if (counts.inUse++ >= 2) return stop('failed', 'record_in_use', undefined, true);
      await new Promise((r) => setTimeout(r, 1000 * counts.inUse));
      await type(page, field(s.model, w.memberNumber), memberId);
      await click(page, button(s.model, w.search));
      return true;
    }
    case 'error.unavailable':
    case 'error.fatal': {
      const code = s.screen === 'error.fatal' ? 'app_error' : 'unavailable';
      await sess.record('error', s.screen, s.model, undefined, code);
      // Reads only, and never more than twice, with backoff.
      if (counts.retries++ >= 2) return stop('failed', code, undefined, true);
      await new Promise((r) => setTimeout(r, 750 * counts.retries));
      await page.goto(sess.lastUrl);
      return true;
    }
    default:
      return false;
  }
}

/** A screen no job knows: stop where it is, with what was closest. */
export async function unknown(sess: Session, s: Seen): Promise<never> {
  await sess.record('unknown', null, s.model, undefined, 'unknown screen');
  return stop(
    'escalated',
    'unknown_screen',
    s.recognition.closest.map((c) => `${c.id}: missing ${c.missing.join(', ')}`).join('; '),
  );
}
