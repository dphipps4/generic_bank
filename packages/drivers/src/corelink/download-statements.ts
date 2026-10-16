// Download Statements on CoreLink Branch Console (plan, §5): sign in, find the member, open the
// account's statements from its tile, press "Statement" on each requested month's row, and keep the
// PDF the window it opens receives, byte for byte. A month the bank does not list is "not available"
// only in the bank's own words (plan, Appendix A, 14); without them, the run stops for a person. The
// PDF is never read: what it says is for Part 2.
//
// Banks differ in how a statement opens: a button on its row, or an entry in the row's drop-down
// menu; a window that receives the PDF, or a page of its own whose Download brings it. Each is met
// as it is drawn.
import {
  button,
  click,
  type Control,
  field,
  normalize,
  type OpenedDocument,
  type ScreenModel,
  type Text,
  withText,
} from '@gb/screen';
import { type DriverContext, type Outcome, see, stop, Stop } from '../sdk.js';
import { readTile } from './check-balance.js';
import { next, onTheWay, type Session, startSession, unknown } from './session.js';
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

/** The product's document type for a statement: a bank may list notices and tax forms among them. */
const STATEMENT = 'Statement';
/** A drop-down menu's title, drawn with a downward arrow after it. */
const MENU = /\s[▾▼]$/;
/** The way to the rest of a list that shows its latest rows only. */
const MORE = /^view more\b/i;
const mid = (b: { y: number; h: number }) => b.y + b.h / 2;
const onRow = (row: Text, b: { y: number; h: number }) =>
  Math.abs(mid(b) - mid(row.box)) <= b.h / 2 + 4;

/**
 * The date drawn on the row of a month's statement ("2026-05-31" for 2026-05): null when no row is
 * that month's statement, 'ambiguous' when more than one is.
 */
export function statementRow(m: ScreenModel, month: string): Text | null | 'ambiguous' {
  const rows = m.texts.filter((d) => {
    const t = d.text.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(t) || !t.startsWith(`${month}-`)) return false;
    return m.texts.some((x) => onRow(d, x.box) && normalize(x.text) === normalize(STATEMENT));
  });
  return rows.length === 1 ? rows[0]! : rows.length ? 'ambiguous' : null;
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

  async function collect(first: ScreenModel): Promise<Outcome<Statements>> {
    let m = first;
    // The page must be showing the account asked for.
    const shows = (x: ScreenModel) => {
      const picker = field(x, 'Account');
      return (
        !!picker.selected && isAccount(picker.selected, input.account, ctx.profile.accountWording)
      );
    };
    if (!shows(m))
      return stop('escalated', 'unknown_screen', 'the statements page shows another account');
    const out: StatementMonth[] = [];
    for (const month of months) {
      let row = statementRow(m, month);
      const more = m.controls.find((c) => MORE.test(c.name.trim()));
      if (row === null && more) {
        await click(page, more);
        m = (
          await see(ctx, sess.sigs, {
            until: (x) => !x.controls.some((c) => MORE.test(c.name.trim())),
            limitMs: 30_000,
          })
        ).model;
        await sess.record('statements', 'statements', m, 'showed the rest of the statements');
        row = statementRow(m, month);
      }
      if (row === 'ambiguous')
        return stop('escalated', 'unknown_screen', `more than one statement for ${month}`);
      if (!row) {
        const said = m.texts.find((t) => t.text.trim() === ctx.profile.statementsKept);
        if (!said)
          return stop('escalated', 'unknown_screen', `no row for ${month}, and no reason given`);
        await sess.record('statement', 'statements', m, undefined, `${month} not available`);
        out.push({ month, notAvailable: said.text.trim() });
        continue;
      }
      const opened = await open(sess, m, row, month);
      const doc = opened.doc;
      const isPdf =
        doc.status === 200 &&
        /^application\/pdf\b/i.test(doc.contentType) &&
        doc.body.subarray(0, 5).toString('latin1') === '%PDF-';
      if (!isPdf) {
        await sess.record('statement', 'statements', m, `opened ${month}'s statement`, 'no PDF');
        return stop('escalated', 'unknown_screen', `the window for ${month} received no PDF`);
      }
      await sess.record(
        'statement',
        'statements',
        m,
        `opened ${month}'s statement; kept the PDF its window received`,
        'kept',
      );
      out.push({ month, pdf: doc.body });
      // Back on the list after a statement page of its own: it must still be this account's.
      if (opened.back) {
        m = opened.back;
        if (!shows(m))
          return stop('escalated', 'unknown_screen', 'the statements page shows another account');
      }
    }
    return { status: 'succeeded', data: { months: out } };
  }
}

/**
 * Opens one month's statement and returns the document it brings: from the row's own button, or
 * from the statement's entry in the row's drop-down menu; in a new window, or on a page of its own
 * whose Download brings it, after which the run goes back to the list (`back`, as drawn again).
 */
async function open(
  sess: Session,
  m: ScreenModel,
  row: Text,
  month: string,
): Promise<{ doc: OpenedDocument; back?: ScreenModel }> {
  const { ctx } = sess;
  const page = ctx.page;
  const words = ctx.profile.words.statement;
  const date = row.text.trim();
  const own = m.controls.filter(
    (c) => words.some((n) => normalize(n) === normalize(c.name)) && onRow(row, c.box),
  );
  let press: Control;
  if (own.length === 1) press = own[0]!;
  else {
    const menus = m.controls.filter((c) => MENU.test(c.name.trim()) && onRow(row, c.box));
    if (own.length > 1 || menus.length !== 1)
      return stop('escalated', 'unknown_screen', `the row for ${month} has no statement button`);
    // The menu may be drawn away from its row: it names the document and the date it is for.
    const title = (t: string) => t.trim().endsWith(`, ${date}`);
    await click(page, menus[0]!);
    const shown = await see(ctx, sess.sigs, {
      until: (x) => x.texts.some((t) => title(t.text)),
      limitMs: 30_000,
    });
    await sess.record('statement', 'statements', shown.model, `opened the menu on ${month}'s row`);
    press = withText(shown.model, title, words);
  }
  const doc = await page.openedDocument(() => click(page, press), 30_000, { orNavigation: true });
  if (doc) return { doc };
  // The statement is a page of its own, with its own way to the PDF.
  const v = await next(sess);
  if (v?.screen !== 'statement.viewer' || !v.model.texts.some((t) => t.text.includes(month)))
    return stop('escalated', 'unknown_screen', `the statement for ${month} did not open`);
  const pdf = await page.openedDocument(() => click(page, button(v.model, 'Download')));
  await sess.record('statement', v.screen, v.model, `pressed Download on ${month}'s statement`);
  await click(page, button(v.model, 'Back to statements'));
  const back = await next(sess);
  if (back?.screen !== 'statements')
    return stop('escalated', 'unknown_screen', 'the statements did not come back');
  return { doc: pdf, back: back.model };
}
