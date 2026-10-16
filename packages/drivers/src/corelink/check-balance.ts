// Check Balance on CoreLink Branch Console: sign in as the staff service account, find the member,
// read one account's balances off its tile. The way to the member is the session's (session.ts);
// this job handles only the summary, and a screen nobody knows stops the run.
import { type ScreenModel, withText } from '@gb/screen';
import { type DriverContext, type Outcome, stop, Stop } from '../sdk.js';
import { next, onTheWay, startSession, unknown } from './session.js';

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
  const sess = startSession(ctx);
  try {
    await ctx.page.goto(ctx.profile.url);
    while (sess.counts.steps++ < 60) {
      const s = await next(sess);
      if (!s || (await onTheWay(sess, s, input.memberId))) continue;
      if (s.screen !== 'member.summary') return await unknown(sess, s);
      // The summary's banner names the member too.
      const banner = s.model.texts.find((t) => /^Member \d+ · /.test(t.text));
      if (banner) ctx.learn([banner.text.replace(/^Member \d+ · /, '')]);
      const tile = readTile(s.model, ctx.profile.accountWording, input.account);
      if (tile === 'no-such-account') {
        await sess.record('balance', s.screen, s.model, undefined, 'no such account');
        return stop('business_outcome', 'no_such_account');
      }
      if (tile === 'widget-broken') {
        if (sess.counts.reloads++ >= 1)
          return stop('escalated', 'unknown_screen', 'the balance did not draw after a reload');
        await ctx.page.goto(sess.lastUrl);
        await sess.record(
          'balance',
          s.screen,
          s.model,
          'a balance did not draw; reloaded',
          'recovered',
        );
        continue;
      }
      // The Activity link of that tile must exist: it proves the tile is the account's own.
      withText(s.model, tile.accountLabel, ctx.profile.words.activity);
      await sess.record('balance', s.screen, s.model, 'read the balances', 'succeeded');
      return { status: 'succeeded', data: { ...tile, asOf: ctx.now().toISOString() } };
    }
    return stop('escalated', 'stuck', 'too many steps without finishing');
  } catch (e) {
    if (e instanceof Stop) return e.outcome;
    throw e;
  }
}
