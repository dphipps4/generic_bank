// Transfer on CoreLink Branch Console, up to the review page (plan, §F.1 step 1): sign in, find the
// member, open the transfer form, choose both accounts by identity, type the amount and a memo that
// carries the run's own memo token, press the bank's Continue, and read the review page back. It
// never presses the bank's submit: that click needs a person's approval and a grant, and is a step
// of its own. A refusal in the bank's own words ends the run as the business outcome it is, with
// nothing submitted.
import {
  button,
  choose,
  click,
  field,
  type ScreenModel,
  TargetError,
  type,
  withText,
} from '@gb/screen';
import { type DriverContext, type Outcome, type Profile, see, stop, Stop } from '../sdk.js';
import { lastFour, readTile } from './check-balance.js';
import { next, onTheWay, pressOnScreen, type Session, startSession, unknown } from './session.js';

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

/** The field for a label, or null when this screen has none. */
function fieldOrNull(m: ScreenModel, label: string) {
  try {
    return field(m, label);
  } catch (e) {
    if (e instanceof TargetError && e.kind === 'none') return null;
    throw e;
  }
}

/** Does this option of the bank's account list name the account the caller meant? */
export function isAccount(option: string, ref: string, wording: RegExp): boolean {
  const digits = lastFour(wording, option);
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
  const filled = { accounts: false, amount: false };
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
          // A form opened from the summary is blank, even after an outage sent the run back here.
          filled.accounts = false;
          filled.amount = false;
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
          // A bank may split the form over pages (the amount, then the accounts): each page is
          // filled with what it asks for, and a page that asks again for what was filled is stuck.
          // A field of a pair without the other is a form this driver does not know.
          const asks = (label: string) => fieldOrNull(s.model, label) !== null;
          const pair = (a: string, b: string) => {
            if (asks(a) !== asks(b))
              stop('escalated', 'unknown_screen', `the form asks for ${asks(a) ? a : b} alone`);
            return asks(a);
          };
          const accounts = pair('From', 'To');
          const amount = pair('Amount', 'Memo');
          if ((!accounts && !amount) || (accounts && filled.accounts) || (amount && filled.amount))
            return stop('escalated', 'stuck', 'the form came back with no reason given');
          const pick = async (label: string, ref: string) => {
            const list = field(s.model, label);
            const matches = (list.options ?? []).filter((o) =>
              isAccount(o, ref, ctx.profile.accountWording),
            );
            if (matches.length !== 1) {
              await sess.record('transfer', s.screen, s.model, undefined, 'no such account');
              stop('business_outcome', 'no_such_account');
            }
            await choose(page, list, matches[0]!);
          };
          const did: string[] = [];
          if (accounts) {
            await pick('From', input.from);
            await pick('To', input.to);
            filled.accounts = true;
            did.push('chose both accounts');
          }
          if (amount) {
            await type(page, field(s.model, 'Amount'), dollars(input.amountCents));
            await type(page, field(s.model, 'Memo'), memoFor(input));
            filled.amount = true;
            did.push('typed the amount and the memo');
          }
          await pressOnScreen(sess, w.continue);
          await sess.record('transfer', s.screen, s.model, `${did.join(', ')}; pressed Continue`);
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

/** What the run gives the submit: the grant check, the journal, and a person's supervisor code. */
export interface SubmitHooks {
  /**
   * Uses the run's approval grant if, and only if, it matches the review page as read now. The
   * click happens only after this says yes; it can say yes once (plan, §F.1 step 4).
   */
  consume(review: Review): Promise<{ ok: true } | { ok: false; reason: string }>;
  journal(line: { intent: string; action?: string; result?: string }): Promise<void>;
  /** Over the bank's threshold: the code the bank sent the supervisor, from a person. */
  supervisorCode(): Promise<string>;
  supervisorId: string;
}

/**
 * The journal's line for the submit, written before the click. A run that finds it in its journal
 * has pressed, or may have: it reads the history and never presses again (plan, §F.2).
 */
export const pressIntent = (profile: Pick<Profile, 'words'>, memoToken: string) =>
  `press ${profile.words.submitTransfer[0]} for ${memoToken}`;

/** How long the bank gets to answer the submit before the run reads the history instead. */
export const AFTER_PRESS_MS = 10_000;

export interface Posted {
  confirmation: string;
  seenInHistory: boolean;
}

/**
 * Submits a prepared transfer once, under the run's grant, and confirms it in the account's own
 * history by its memo token. Starts from the review page if the browser is on it; otherwise (a
 * lost session, a fresh browser) prepares it again first, and checks the screen against the grant
 * before the click. The bank's submit is pressed at most once, whatever happens after.
 */
export async function submitTransfer(
  ctx: DriverContext,
  input: TransferInput,
  hooks: SubmitHooks,
): Promise<Outcome<Posted>> {
  const sess = startSession(ctx);
  const w = ctx.profile.words;
  const page = ctx.page;
  let pressed = false;
  try {
    let s = await next(sess);
    if (s?.screen !== 'transfer.review') {
      const again = await prepareTransfer(ctx, input);
      if (again.status !== 'succeeded') return again;
      s = await next(sess);
    }
    while (sess.counts.steps++ < 40) {
      if (!s) {
        // After the press, an answer that has not come in 10 s is unclear: read the history.
        s = await next(sess, pressed ? AFTER_PRESS_MS : undefined);
        continue;
      }
      switch (s.screen) {
        case 'transfer.review': {
          if (pressed)
            return stop('escalated', 'ambiguous_outcome', 'the review page came back after submit');
          const review: Review = {
            from: beside(s.model, 'From:') ?? '',
            to: beside(s.model, 'To:') ?? '',
            amountCents: cents(beside(s.model, 'Amount:') ?? 'NaN'),
            memo: beside(s.model, 'Memo:') ?? '',
          };
          const grant = await hooks.consume(review);
          if (!grant.ok) {
            await sess.record('submit', s.screen, s.model, undefined, `refused: ${grant.reason}`);
            await hooks.journal({ intent: 'press submit', result: `refused: ${grant.reason}` });
            return stop('escalated', 'guard_tripped', grant.reason);
          }
          // The intent is written before the click, so a crash between the two is known.
          const intent = pressIntent(ctx.profile, input.memoToken);
          await hooks.journal({ intent });
          pressed = true;
          await click(page, button(s.model, w.submitTransfer));
          await hooks.journal({ intent, action: 'pressed' });
          await sess.record('submit', s.screen, s.model, 'pressed submit, under the grant');
          break;
        }
        case 'transfer.supervisor': {
          const code = await hooks.supervisorCode();
          await type(page, field(s.model, 'Supervisor ID'), hooks.supervisorId);
          await type(page, field(s.model, 'Approval code'), code);
          await click(page, button(s.model, 'Approve'));
          await sess.record(
            'supervisor',
            s.screen,
            s.model,
            'typed the supervisor code a person gave',
          );
          break;
        }
        case 'transfer.posted': {
          const confirmation =
            /Confirmation number ([A-Z0-9-]+)/.exec(
              s.model.texts.map((t) => t.text).join(' '),
            )?.[1] ?? '';
          await hooks.journal({ intent: 'read the confirmation', result: confirmation || 'none' });
          await sess.record('submit', s.screen, s.model, 'read the confirmation', 'posted');
          const found = await inHistory(sess, input);
          await hooks.journal({
            intent: 'find the memo token in the history',
            result: `${found} found`,
          });
          if (found !== 1)
            return stop('escalated', 'ambiguous_outcome', `${found} entries carry the memo token`);
          return { status: 'succeeded', data: { confirmation, seenInHistory: true } };
        }
        default: {
          if (!pressed) {
            if (await onTheWay(sess, s, input.memberId)) break;
            return await unknown(sess, s);
          }
          // After the click, anything but the confirmation is unclear: never press again; read the
          // account's history for the memo token instead (plan, §F.2).
          await sess.record('submit', s.screen, s.model, undefined, 'no confirmation');
          const found = await inHistory(sess, input);
          await hooks.journal({
            intent: 'find the memo token in the history',
            result: `${found} found`,
          });
          if (found === 1)
            return {
              status: 'succeeded',
              data: { confirmation: input.memoToken, seenInHistory: true },
            };
          return stop('escalated', 'ambiguous_outcome', `${found} entries carry the memo token`);
        }
      }
      s = null;
    }
    return stop('escalated', 'stuck', 'too many steps without finishing');
  } catch (e) {
    if (e instanceof Stop) return e.outcome;
    // A failure after the click is an unclear result, never a reason to press again.
    if (pressed) {
      const found = await inHistory(startSession(ctx), input).catch(() => -1);
      if (found === 1)
        return {
          status: 'succeeded',
          data: { confirmation: input.memoToken, seenInHistory: true },
        };
      return {
        status: 'escalated',
        code: 'ambiguous_outcome',
        note: `${found} entries carry the memo token`,
      };
    }
    throw e;
  }
}

/** The history check alone, in a session of its own: for a run that resumes after its press. */
export const countInHistory = (ctx: DriverContext, input: TransferInput) =>
  inHistory(startSession(ctx), input);

/**
 * How many entries in the from-account's activity carry the memo token: 1 is the transfer, 0 or 2
 * is for a person to look at. Reads only; signs in again first if the session was lost.
 */
export async function inHistory(sess: Session, input: TransferInput): Promise<number> {
  const { ctx } = sess;
  const page = ctx.page;
  await page.goto(ctx.profile.url);
  for (let i = 0; i < 30; i++) {
    const s = await next(sess);
    if (!s || (await onTheWay(sess, s, input.memberId))) continue;
    if (s.screen === 'member.summary') {
      const tile = readTile(s.model, ctx.profile.accountWording, input.from);
      if (typeof tile === 'string') return -1;
      await click(page, withText(s.model, tile.accountLabel, ctx.profile.words.activity));
      // The rows arrive by a late request after the page draws.
      const rows = await see(ctx, sess.sigs, {
        until: (m) => m.texts.some((t) => t.text === 'Description') && m.texts.length > 12,
        limitMs: 30_000,
      });
      await sess.record('history', 'member.activity', rows.model, 'read the activity');
      return rows.model.texts.filter((t) => t.text.includes(input.memoToken)).length;
    }
    return -1;
  }
  return -1;
}
