// Download Statements on CoreLink Branch Console (plan, §5): sign in, find the member, open the
// account's statements from its tile, press "Statement" on each requested month's row, and keep the
// PDF the window it opens receives, byte for byte. A month the bank does not list is "not available"
// only in the bank's own words (plan, Appendix A, 14); without them, the run stops for a person. The
// PDF is never read: what it says is for Part 2.
import { click, field, inRow, normalize, type ScreenModel, withText } from '@gb/screen';
import { type DriverContext, type Outcome, stop, Stop } from '../sdk.js';
import { readTile } from './check-balance.js';
import { next, onTheWay, startSession, unknown } from './session.js';
import { isAccount } from './transfer.js';

export interface StatementsInput {
  memberId: string;
  /** The account's last four digits, or its nickname. */
  account: string;
  /** Months as YYYY-MM. */
  months: string[];
}

export type StatementMonth =
  { month: string; pdf: Buffer } | { month: string; notAvailable: string };

export interface Statements {
  months: StatementMonth[];
}

/** The date drawn on the row of a month's statement ("2026-05-31" for 2026-05), or null. */
export function rowDate(m: ScreenModel, month: string): string | null {
  const dates = m.texts
    .map((t) => t.text.trim())
    .filter((t) => /^\d{4}-\d{2}-\d{2}$/.test(t) && t.startsWith(`${month}-`));
  return dates.length === 1 ? dates[0]! : null;
}

export async function downloadStatements(
  ctx: DriverContext,
  input: StatementsInput,
): Promise<Outcome<Statements>> {
  const sess = startSession(ctx);
  const w = ctx.profile.words;
  const page = ctx.page;
  const months = [...new Set(input.months)];
  try {
    await page.goto(ctx.profile.url);
    while (sess.counts.steps++ < 60) {
      const s = await next(sess);
      if (!s || (await onTheWay(sess, s, input.memberId))) continue;
      switch (s.screen) {
        case 'member.summary': {
          const banner = s.model.texts.find((t) => /^Member \d+ · /.test(t.text));
          if (banner) ctx.learn([banner.text.replace(/^Member \d+ · /, '')]);
          const tile = readTile(s.model, ctx.profile.accountWording, input.account);
          if (tile === 'no-such-account') {
            await sess.record('statements', s.screen, s.model, undefined, 'no such account');
            return stop('business_outcome', 'no_such_account');
          }
          if (tile === 'widget-broken') {
            if (sess.counts.reloads++ >= 1)
              return stop('escalated', 'unknown_screen', 'the account tiles did not draw');
            await page.goto(sess.lastUrl);
            continue;
          }
          // The tile's own Statements: beside its Activity, on the same line.
          const activity = withText(s.model, tile.accountLabel, ctx.profile.words.activity);
          const mid = (b: { y: number; h: number }) => b.y + b.h / 2;
          const own = s.model.controls
            .filter(
              (c) =>
                w.statements.some((n) => normalize(n) === normalize(c.name)) &&
                c.box.x > activity.box.x &&
                Math.abs(mid(c.box) - mid(activity.box)) < 4,
            )
            .sort((a, b) => a.box.x - b.box.x)[0];
          if (!own)
            return stop('escalated', 'unknown_screen', 'the tile has no statements of its own');
          await click(page, own);
          await sess.record('statements', s.screen, s.model, "opened the account's statements");
          break;
        }
        case 'statements':
          return await collect(s.model);
        default:
          return await unknown(sess, s);
      }
    }
    return stop('escalated', 'stuck', 'too many steps without finishing');
  } catch (e) {
    if (e instanceof Stop) return e.outcome;
    throw e;
  }

  async function collect(m: ScreenModel): Promise<Outcome<Statements>> {
    // The page must be showing the account asked for.
    const picker = field(m, 'Account');
    if (!picker.selected || !isAccount(picker.selected, input.account, ctx.profile.accountWording))
      return stop('escalated', 'unknown_screen', 'the statements page shows another account');
    const out: StatementMonth[] = [];
    for (const month of months) {
      const date = rowDate(m, month);
      if (!date) {
        const said = m.texts.find((t) => t.text.trim() === ctx.profile.statementsKept);
        if (!said)
          return stop('escalated', 'unknown_screen', `no row for ${month}, and no reason given`);
        await sess.record('statement', 'statements', m, undefined, `${month} not available`);
        out.push({ month, notAvailable: said.text.trim() });
        continue;
      }
      const doc = await page.openedDocument(() => click(page, inRow(m, date, w.statement)));
      const isPdf =
        doc.status === 200 &&
        /^application\/pdf\b/i.test(doc.contentType) &&
        doc.body.subarray(0, 5).toString('latin1') === '%PDF-';
      if (!isPdf) {
        await sess.record('statement', 'statements', m, `pressed Statement for ${month}`, 'no PDF');
        return stop('escalated', 'unknown_screen', `the window for ${month} received no PDF`);
      }
      await sess.record(
        'statement',
        'statements',
        m,
        `pressed Statement for ${month}; kept the PDF its window received`,
        'kept',
      );
      out.push({ month, pdf: doc.body });
    }
    return { status: 'succeeded', data: { months: out } };
  }
}
