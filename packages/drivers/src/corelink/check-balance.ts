// Check Balance on CoreLink Branch Console: sign in as the staff service account, find the member,
// read one account's balances off its tile. A state machine over recognized screens: every screen
// it can meet has an answer, recoverable conditions are handled inside the run, bounded and
// recorded, and a screen it does not know stops the run.
import { button, click, field, type ScreenModel, type, withText } from '@gb/screen';
import { type DriverContext, type Outcome, see, stop, Stop } from '../sdk.js';
import { signatures } from './signatures.js';

export interface BalanceInput {
  memberId: string;
  /** The account's last four digits, or its nickname. */
  account: string;
}

export interface Balance {
  accountLabel: string;
  availableCents: number;
  currentCents: number;
  asOf: string;
}

const cents = (s: string) => Math.round(Number(s.replace(/[$,]/g, '')) * 100);

/** One account's tile on the member summary: its label and balances, read from what is drawn. */
export function readTile(
  m: ScreenModel,
  wording: RegExp,
  account: string,
): Balance | 'no-such-account' | 'widget-broken' {
  const labels = m.texts.filter((t) => wording.test(t.text));
  const byDigits = labels.filter((t) => wording.exec(t.text)?.[1] === account);
  let anchor = byDigits[0];
  if (!anchor) {
    // By nickname: the label drawn just above an account's wording.
    const nick = m.texts.find((t) => t.text.trim().toLowerCase() === account.trim().toLowerCase());
    if (nick)
      anchor = labels
        .filter((l) => l.box.y > nick.box.y - 2 && Math.abs(l.box.x - nick.box.x) < 30)
        .sort((a, b) => a.box.y - b.box.y)[0];
  }
  if (!anchor || byDigits.length > 1) return 'no-such-account';
  // The tile's column: everything drawn below the label, before the next tile's label, in its column.
  const next = labels
    .filter(
      (l) => l !== anchor && Math.abs(l.box.x - anchor!.box.x) < 30 && l.box.y > anchor!.box.y,
    )
    .sort((a, b) => a.box.y - b.box.y)[0];
  const inTile = m.texts
    .filter(
      (t) =>
        t.box.y >= anchor!.box.y - 2 &&
        t.box.y < (next?.box.y ?? anchor!.box.y + 150) &&
        t.box.x >= anchor!.box.x - 10 &&
        t.box.x < anchor!.box.x + 260,
    )
    .sort((a, b) => Math.round(a.box.y / 4) - Math.round(b.box.y / 4) || a.box.x - b.box.x)
    .map((t) => t.text)
    .join(' ');
  const avail = /Available balance:?\s*(--|-?\$[\d,]+\.\d{2})/.exec(inTile);
  const current = /Current balance:?\s*(-?\$[\d,]+\.\d{2})/.exec(inTile);
  if (avail?.[1] === '--') return 'widget-broken';
  if (!avail || !current) return 'widget-broken';
  return {
    accountLabel: anchor.text,
    availableCents: cents(avail[1]!),
    currentCents: cents(current[1]!),
    asOf: '',
  };
}

export async function checkBalance(
  ctx: DriverContext,
  input: BalanceInput,
): Promise<Outcome<Balance>> {
  const sigs = signatures(ctx.profile);
  const w = ctx.profile.words;
  const page = ctx.page;
  const counts = {
    signIns: 0,
    codeRounds: 0,
    retries: 0,
    inUse: 0,
    reloads: 0,
    sessionRestarts: 0,
    steps: 0,
  };
  let searched = false;
  let lastUrl = ctx.profile.url;
  const record = async (
    name: string,
    screen: string | null,
    model: ScreenModel | null,
    action?: string,
    outcome?: string,
    t0 = Date.now(),
  ) => ctx.step({ name, screen, action, outcome, ms: Date.now() - t0 }, model);

  try {
    await page.goto(ctx.profile.url);
    while (counts.steps++ < 60) {
      const t0 = Date.now();
      const s = await see(ctx, sigs, { limitMs: 45_000 });
      // A dialog freezes the page: answer it with the non-committal choice, and carry on.
      if (s.dialog) {
        await page.answerDialog(false);
        await record(
          'dialog',
          null,
          null,
          `answered "${s.dialog.type}" with Cancel`,
          'recovered',
          t0,
        );
        continue;
      }
      lastUrl = s.model.url || lastUrl;
      switch (s.screen) {
        case 'login.signin':
        case 'login.welcome_back':
        case 'login.session_ended': {
          if (s.screen === 'login.session_ended' || counts.signIns > 0) {
            // Signed out under us: sign in once more, then go back to the member.
            if (counts.sessionRestarts++ >= 1)
              stop('failed', 'unavailable', 'the session ended twice', true);
            searched = false;
          }
          if (counts.signIns++ >= 3)
            stop('failed', 'bad_credentials', 'signed in three times without getting in');
          const creds = await ctx.credentials();
          if (s.screen !== 'login.welcome_back')
            await type(page, field(s.model, w.operatorId), creds.operatorId);
          await type(page, field(s.model, w.password), creds.password);
          await click(page, button(s.model, w.signIn));
          await record(
            'sign in',
            s.screen,
            s.model,
            'typed the operator ID and password; pressed sign in',
            undefined,
            t0,
          );
          break;
        }
        case 'login.bad_credentials':
          await record('sign in', s.screen, s.model, undefined, 'refused', t0);
          return stop('failed', 'bad_credentials');
        case 'login.locked':
          await record('sign in', s.screen, s.model, undefined, 'locked', t0);
          return stop('failed', 'operator_locked');
        case 'login.code_choose':
          await click(page, button(s.model, 'Send code'));
          await record('staff code', s.screen, s.model, 'asked for the code by text');
          break;
        case 'login.code_enter':
        case 'login.code_wrong':
        case 'login.code_expired': {
          if (s.screen !== 'login.code_enter' && counts.codeRounds >= 3)
            return stop('failed', 'bad_credentials', 'three codes were refused');
          if (s.screen === 'login.code_expired' && ctx.profile.codeStyle === 'sent') {
            await click(page, button(s.model, 'Send a new code'));
            await record('staff code', s.screen, s.model, 'the code expired; asked for a new one');
            break;
          }
          counts.codeRounds++;
          const code = await ctx.askHuman({
            kind: 'staff_code',
            prompt: 'The bank sent a sign-in code to the staff phone. Enter it here.',
          });
          await type(page, field(s.model, 'Code'), code);
          await click(page, button(s.model, 'Verify'));
          await record('staff code', s.screen, s.model, 'typed the code a person gave');
          break;
        }
        case 'login.terms':
          await click(page, button(s.model, 'Acknowledge'));
          await record('terms', s.screen, s.model, 'acknowledged the updated terms');
          break;
        case 'dialog.promo':
          await click(page, button(s.model, 'Not now'));
          await record('interstitial', s.screen, s.model, 'pressed Not now', 'recovered');
          break;
        case 'console.home':
          await click(page, button(s.model, w.memberSearch));
          await record('console', s.screen, s.model, 'opened member search');
          break;
        case 'member.search': {
          if (searched && counts.inUse === 0) {
            // Back on the search form after a search: the result screen did not come.
            return stop(
              'escalated',
              'unknown_screen',
              'the search returned to the form without a result',
            );
          }
          await type(page, field(s.model, w.memberNumber), input.memberId);
          await click(page, button(s.model, w.search));
          searched = true;
          await record('member search', s.screen, s.model, 'searched by member number');
          // The result is drawn by script into the same page.
          const r = await see(ctx, sigs, {
            until: (m) =>
              m.controls.some((c) => c.name === 'Open') ||
              m.texts.some((t) =>
                /No member found|Member status: Closed|in use by another operator|Enter an 8-digit/.test(
                  t.text,
                ),
              ),
          });
          if (r.model.controls.some((c) => c.name === 'Open')) {
            await click(page, button(r.model, 'Open'));
            await record('member search', 'member.found', r.model, 'opened the member');
          } else {
            // The outcome screens are handled on the next turn of the loop.
            await record('member search', r.screen, r.model, undefined, r.screen ?? 'no result');
          }
          break;
        }
        case 'member.no_such_member':
          await record('member search', s.screen, s.model, undefined, 'no such member');
          return stop('business_outcome', 'no_such_member');
        case 'member.closed':
          await record('member search', s.screen, s.model, undefined, 'member closed');
          return stop('business_outcome', 'member_closed');
        case 'member.permission':
          await record('member', s.screen, s.model, undefined, 'permission denied');
          return stop('business_outcome', 'permission_denied');
        case 'member.in_use': {
          await record('member search', s.screen, s.model, undefined, 'record in use');
          if (counts.inUse++ >= 2) return stop('failed', 'record_in_use', undefined, true);
          await new Promise((r) => setTimeout(r, 1000 * counts.inUse));
          await type(page, field(s.model, w.memberNumber), input.memberId);
          await click(page, button(s.model, w.search));
          break;
        }
        case 'member.summary': {
          const tile = readTile(s.model, ctx.profile.accountWording, input.account);
          if (tile === 'no-such-account') {
            await record('balance', s.screen, s.model, undefined, 'no such account');
            return stop('business_outcome', 'no_such_account');
          }
          if (tile === 'widget-broken') {
            if (counts.reloads++ >= 1)
              return stop('escalated', 'unknown_screen', 'the balance did not draw after a reload');
            await page.goto(lastUrl);
            await record(
              'balance',
              s.screen,
              s.model,
              'a balance did not draw; reloaded',
              'recovered',
            );
            break;
          }
          // The Activity link of that tile must exist: it proves the tile is the account's own.
          withText(s.model, tile.accountLabel, 'Activity');
          await record('balance', s.screen, s.model, 'read the balances', 'succeeded');
          return { status: 'succeeded', data: { ...tile, asOf: ctx.now().toISOString() } };
        }
        case 'error.unavailable':
        case 'error.fatal': {
          const code = s.screen === 'error.fatal' ? 'app_error' : 'unavailable';
          await record('error', s.screen, s.model, undefined, code);
          // Reads only, and never more than twice, with backoff.
          if (counts.retries++ >= 2) return stop('failed', code, undefined, true);
          await new Promise((r) => setTimeout(r, 750 * counts.retries));
          await page.goto(lastUrl);
          break;
        }
        default:
          await record('unknown', null, s.model, undefined, 'unknown screen');
          return stop(
            'escalated',
            'unknown_screen',
            s.recognition.closest.map((c) => `${c.id}: missing ${c.missing.join(', ')}`).join('; '),
          );
      }
    }
    return stop('escalated', 'stuck', 'too many steps without finishing');
  } catch (e) {
    if (e instanceof Stop) return e.outcome;
    throw e;
  }
}
