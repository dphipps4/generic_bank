// Transfer on CoreLink Branch Console, up to the review page (plan, §F.1 step 1): sign in, find the
// member, open the transfer form, choose both accounts by identity, type the amount and a memo that
// carries the run's own memo token, press the bank's Continue, and read the review page back. It
// never presses the bank's submit: that click needs a person's approval and a grant, and is a step
// of its own. A refusal in the bank's own words ends the run as the business outcome it is, with
// nothing submitted.
import { button, choose, click, field, type ScreenModel, type } from '@gb/screen';
import { type DriverContext, type Outcome, stop, Stop } from '../sdk.js';
import { next, onTheWay, startSession, unknown } from './session.js';

export interface TransferInput {
  memberId: string;
  /** Each account's last four digits, or its nickname. */
  from: string;
  to: string;
  amountCents: number;
  memo?: string;
  /** Our own marker for this transfer inside the bank's data (plan, §F.2), typed into the memo. */
  memoToken: string;
}

/** The review page, as the bank shows it. */
export interface Review {
  from: string;
  to: string;
  amountCents: number;
  memo: string;
}

const cents = (s: string) => Math.round(Number(s.replace(/[$,]/g, '')) * 100);
const dollars = (c: number) => (c / 100).toFixed(2);

/** The memo the bank receives: the token first, so it survives the bank's length limit. */
export const memoFor = (i: Pick<TransferInput, 'memo' | 'memoToken'>) =>
  (i.memo ? `${i.memoToken} ${i.memo}` : i.memoToken).slice(0, 32);

/** The value drawn to the right of a label on the same row ("Amount:" → "$125.00"). */
export function beside(m: ScreenModel, label: string): string | null {
  const l = m.texts.find((t) => t.text.trim() === label);
  if (!l) return null;
  const mid = l.box.y + l.box.h / 2;
  const right = m.texts
    .filter((t) => t !== l && t.box.x > l.box.x && Math.abs(t.box.y + t.box.h / 2 - mid) < 8)
    .sort((a, b) => a.box.x - b.box.x)[0];
  return right ? right.text.trim() : null;
}

/** Does this option of the bank's account list name the account the caller meant? */
function isAccount(option: string, ref: string, wording: RegExp): boolean {
  const digits = wording.exec(option)?.[1];
  if (/^\d{4}$/.test(ref)) return digits === ref;
  return option.toLowerCase().startsWith(`${ref.toLowerCase()},`);
}

export async function prepareTransfer(
  ctx: DriverContext,
  input: TransferInput,
): Promise<Outcome<Review>> {
  const sess = startSession(ctx);
  const w = ctx.profile.words;
  const page = ctx.page;
  let filled = false;
  try {
    await page.goto(ctx.profile.url);
    while (sess.counts.steps++ < 60) {
      const s = await next(sess);
      if (!s || (await onTheWay(sess, s, input.memberId))) continue;
      switch (s.screen) {
        case 'member.summary': {
          // The menu's Transfer opens a blank member search; the summary's own opens this member's
          // transfer. It is the one drawn in the same frame as the member's account tiles.
          const tiles = s.model.texts.find((t) => /Available balance/.test(t.text));
          const own = s.model.controls.filter(
            (c) =>
              c.frame === tiles?.frame &&
              w.transfer.some((n) => n.toLowerCase() === c.name.trim().toLowerCase()),
          );
          if (own.length !== 1)
            return stop('escalated', 'unknown_screen', 'the summary has no transfer of its own');
          await click(page, own[0]!);
          await sess.record('transfer', s.screen, s.model, 'opened the transfer form');
          break;
        }
        case 'transfer.form': {
          // The bank's answer to what was filled in comes back on the same form, in its own words.
          const refused = ctx.profile.refusals.find((r) =>
            s.model.texts.some((t) => t.text.includes(r.text)),
          );
          if (refused) {
            await sess.record('transfer', s.screen, s.model, undefined, refused.code);
            return stop('business_outcome', refused.code);
          }
          if (filled) return stop('escalated', 'stuck', 'the form came back with no reason given');
          const options = (label: string) => field(s.model, label);
          const pick = async (label: string, ref: string) => {
            const list = options(label);
            const matches = (list.options ?? []).filter((o) =>
              isAccount(o, ref, ctx.profile.accountWording),
            );
            if (matches.length !== 1) {
              await sess.record('transfer', s.screen, s.model, undefined, 'no such account');
              stop('business_outcome', 'no_such_account');
            }
            await choose(page, list, matches[0]!);
          };
          await pick('From', input.from);
          await pick('To', input.to);
          await type(page, field(s.model, 'Amount'), dollars(input.amountCents));
          await type(page, field(s.model, 'Memo'), memoFor(input));
          await click(page, button(s.model, w.continue));
          filled = true;
          await sess.record(
            'transfer',
            s.screen,
            s.model,
            'chose both accounts, typed the amount and the memo; pressed Continue',
          );
          break;
        }
        case 'transfer.review': {
          const review = {
            from: beside(s.model, 'From:') ?? '',
            to: beside(s.model, 'To:') ?? '',
            amountCents: cents(beside(s.model, 'Amount:') ?? 'NaN'),
            memo: beside(s.model, 'Memo:') ?? '',
          };
          if (!review.from || !review.to || !Number.isFinite(review.amountCents))
            return stop('escalated', 'unknown_screen', 'the review page could not be read back');
          await sess.record('transfer', s.screen, s.model, 'read the review page back', 'prepared');
          return { status: 'succeeded', data: review };
        }
        default:
          return await unknown(sess, s);
      }
    }
    return stop('escalated', 'stuck', 'too many steps without finishing');
  } catch (e) {
    if (e instanceof Stop) return e.outcome;
    throw e;
  }
}
