// The loop that runs any bank's table: look at the page, return the bank's answer if it gives one,
// start again from home on trouble, else do the steps of the one row the page shows. It goes by
// what is on screen, not by the order it expects, so a page that shows up early, late or twice
// gets its row. Submit is never in a row: it is pressed once, after a person approves.
import { CODES, type ResultCode } from '@gb/contracts';
import {
  choose,
  chooseAt,
  clickAt,
  findCrop,
  type Frame,
  knows,
  NotReady,
  type Page,
  press,
  read,
  see,
  TargetError,
  type,
  typeAt,
  UnknownPage,
  whatIsAt,
} from '@gb/runtime';
import { type At, type Goal, readOf, type Step, type Table } from './table.js';

/**
 * Where a step learned by sight acts now: its anchor found in a fresh screenshot, plus its offset,
 * and the browser's own word that the right kind of control is there. Anything else is a target
 * not found, and the loop looks again.
 */
async function pointOf(page: Page, at: At): Promise<{ x: number; y: number }> {
  const found = findCrop(await page.screenshot(), Buffer.from(at.anchor, 'base64'));
  if (!found) throw new TargetError('its anchor is not clearly on the screen');
  const p = { x: found.box.x + found.box.w / 2 + at.dx, y: found.box.y + found.box.h / 2 + at.dy };
  const there = await whatIsAt(page, p);
  if (there.kind !== at.kind)
    throw new TargetError(`a ${there.kind} where its ${at.kind} should be`);
  return p;
}

export interface Session {
  page: Page;
  /** Where the bank's console is. */
  url: string;
  table: Table;
  /**
   * Values never kept in evidence. The crawler adds the sign-in, the member's number, and the
   * member's name once the bank shows it, here, so whoever holds this list masks them too.
   */
  known: string[];
  credentials(): Promise<{ operatorId: string; password: string }>;
  /** The code the bank sent to the staff phone: a person gives it. */
  code(): Promise<string>;
  /** Each page seen, already masked: what was done before it, and the row it is, if any. */
  keep?(seen: Seen, frame: Frame): Promise<void> | void;
  /**
   * Judges each action before it reaches the browser; throws to refuse. Nothing in the crawler
   * catches a refusal: it ends the run.
   */
  guard?(action: Action): void;
  /** A step with no page of its own, such as the one press of Submit. */
  note?(name: string, action: string): Promise<void> | void;
  /** How long a page may take to be ready. */
  limitMs?: number;
  /**
   * Keep a frame after every step, not only after the last step on a page: the gate's replay is
   * evidence, step by step.
   */
  everyStep?: boolean;
}

export interface Task {
  member: string;
  /** An account: its name as the bank shows it, or its last four digits. */
  from?: string;
  to?: string;
  amountCents?: number;
  /** What is typed in the memo: the run's token, then the member's words. */
  memo?: string;
}

export interface Seen {
  did: string;
  page: string | null;
  /** The allowlist's name for the page. */
  screen: string | null;
}

/** An action as the guard judges it: on which page, what, and the control's drawn name. */
export interface Action {
  screen: string;
  verb: 'type' | 'press' | 'choose' | 'read';
  control: string;
  /** Typed from a stored secret (the sign-in), never as plain text. */
  secret?: boolean;
  /** What is typed as plain text. */
  typed?: string;
}

export interface Ended {
  status: 'business_outcome' | 'failed' | 'escalated';
  code: ResultCode;
  retryable?: boolean;
  note?: string;
}

export class Stop extends Error {
  constructor(readonly ended: Ended) {
    super(`${ended.status}: ${ended.code}${ended.note ? ` (${ended.note})` : ''}`);
  }
}

const statusOf = (code: ResultCode): Ended['status'] =>
  code in CODES.business_outcome
    ? 'business_outcome'
    : code in CODES.escalated
      ? 'escalated'
      : 'failed';
const stop = (code: ResultCode, note?: string, retryable?: boolean): never => {
  throw new Stop({
    status: statusOf(code),
    code,
    ...(note && { note }),
    ...(retryable && { retryable }),
  });
};

/**
 * Whether one account, read off a page, is the one asked for: its last four digits anywhere in its
 * number as the page draws it, or its name, ignoring case. Exactly one account must match; the
 * caller stops on any other count.
 */
export function isAccount(g: { name?: string; last4?: string }, asked: string): boolean {
  const a = asked.trim().toLowerCase();
  if (/^\d{4}$/.test(a)) return (g.last4 ?? '').includes(a);
  return a.length > 0 && (g.name ?? '').toLowerCase().includes(a);
}

/** The accounts a balance read finds in a page's words, and the ones that are the account asked for. */
export function accountsIn(words: string, read: string, member: string, asked: string) {
  const all = [...words.matchAll(readOf(read, member))].map((m) => m.groups!);
  return { all, matching: all.filter((g) => isAccount(g, asked)) };
}

/**
 * A person's code, asked for once for each code the bank sends. Typed again before anything is
 * pressed (a second field, a step taken twice), it is the code already given; a press may submit it
 * or have the bank send another, so the next ask goes to the person. An ask that fails is not kept.
 */
export function oneCode(ask: () => Promise<string>) {
  let given: Promise<string> | null = null;
  return {
    code: () => {
      if (!given) {
        const asked = ask();
        given = asked;
        asked.catch(() => {
          if (given === asked) given = null;
        });
      }
      return given;
    },
    pressed: () => {
      given = null;
    },
  };
}

async function value(s: Session, task: Task, v: string): Promise<string> {
  switch (v) {
    case '$operator':
      return (await s.credentials()).operatorId;
    case '$password':
      return (await s.credentials()).password;
    case '$code': {
      // A code is a secret: hidden whole wherever it shows, not as a number that keeps its last four.
      const c = await s.code();
      if (c && !s.known.includes(c)) s.known.push(c);
      return c;
    }
    case '$member':
      return task.member;
    case '$from':
      return task.from ?? '';
    case '$to':
      return task.to ?? '';
    case '$amount':
      return ((task.amountCents ?? 0) / 100).toFixed(2);
    case '$memo':
      return task.memo ?? '';
    default:
      return v;
  }
}

const SECRETS = new Set(['$operator', '$password']);
const screenOf = (t: Table, page: string) => t.rows.find((r) => r.page === page)?.screen ?? page;

/** The action a step asks the guard for: what is typed as plain text is `typed`, once known. */
export function actionOf(screen: string, st: Step, typed = ''): Action {
  if ('type' in st)
    return SECRETS.has(st.value)
      ? { screen, verb: 'type', control: st.type, secret: true }
      : { screen, verb: 'type', control: st.type, typed };
  if ('choose' in st) return { screen, verb: 'choose', control: st.choose };
  return { screen, verb: 'press', control: st.press };
}

/**
 * Every action a route asks the guard for on one goal, before any value is known: each row's
 * steps, then the read where the goal ends. Submit is not among them: only a person's grant
 * lets it through.
 */
export function routeActions(t: Table, goal: Goal): (Action & { page: string })[] {
  const steps = t.rows.flatMap((r) =>
    [...(r.do.any ?? []), ...(r.do[goal] ?? [])].map((st) => ({
      ...actionOf(r.screen ?? r.page, st),
      page: r.page,
    })),
  );
  const end = t.ends[goal];
  return [...steps, { screen: screenOf(t, end), verb: 'read', control: 'Page', page: end }];
}

/** Does one step, once the guard allows it; says what was done, never with the value. */
async function step(s: Session, task: Task, screen: string, st: Step): Promise<string> {
  if ('type' in st) {
    const v = await value(s, task, st.value);
    s.guard?.(actionOf(screen, st, v));
    if (st.at) await typeAt(s.page, await pointOf(s.page, st.at), v);
    else await type(s.page, st.type, v);
    return `type ${st.value} into "${st.type}"`;
  }
  if ('choose' in st) {
    s.guard?.(actionOf(screen, st));
    const v = await value(s, task, st.containing);
    if (st.at) await chooseAt(s.page, await pointOf(s.page, st.at), v);
    else await choose(s.page, st.choose, v);
    return `choose ${st.containing} in "${st.choose}"`;
  }
  const near = st.near && (await value(s, task, st.near));
  s.guard?.(actionOf(screen, st));
  if (st.at) await clickAt(s.page, await pointOf(s.page, st.at));
  else await press(s.page, st.press, near ? { near } : {});
  return `press "${st.press}"`;
}

/**
 * Learns the member's name where the table says it shows, and adds it (and each of its words) to
 * what is masked. True if it learned something: the frame is then taken again, masked.
 */
async function learn(s: Session, task: Task): Promise<boolean> {
  const text = (await leaves(s.page)).join('\n');
  let learned = false;
  for (const part of namesIn(text, s.table.reads.name, task.member))
    if (!s.known.includes(part)) {
      s.known.push(part);
      learned = true;
    }
  return learned;
}

/** The member's name and each of its words, where a name read finds it in a page's words. */
export function namesIn(words: string, reads: string[], member: string): string[] {
  const out: string[] = [];
  for (const p of reads) {
    const name = readOf(p, member).exec(words)?.groups?.name;
    if (!name) continue;
    for (const part of [name, ...name.split(/[\s.,]+/)])
      if (part.trim().length >= 2 && !out.includes(part)) out.push(part);
  }
  return out;
}

/** Sees the page, learning the member's name first if it shows. */
async function look(s: Session, task: Task): Promise<Frame> {
  const o = { known: s.known, limitMs: s.limitMs ?? 60_000 };
  const f = await see(s.page, o);
  return (await learn(s, task)) ? see(s.page, o) : f;
}

/**
 * The sign-in joins what is hidden whole, before the first page is seen. The member's number is an
 * identifier, and the masking rule keeps its last four, like any other.
 */
async function knowTask(s: Session) {
  const { operatorId, password } = await s.credentials();
  for (const v of [operatorId, password]) if (v && !s.known.includes(v)) s.known.push(v);
}

/** A table's pages, as `knows` tells them apart. */
export const pagesOf = (t: Pick<Table, 'rows'>) =>
  t.rows.map((r) => ({
    name: r.page,
    shows: r.shows,
    never: r.never ?? [],
    looks: r.looks ?? [],
  }));

/** Runs the table from home until the goal's page, and returns that page. */
export async function crawl(
  s: Session,
  task: Task,
  goal: Goal,
  o: { submitted?: boolean } = {},
): Promise<Frame> {
  const t = s.table;
  await knowTask(s);
  const pages = pagesOf(t);
  const again = new Map<string, number>();
  const home = async (why: string) => {
    // Never a reload after Submit: the console's home is a fresh request, and sends nothing.
    await s.page.goto(new URL(t.home, s.url).href);
    return why;
  };
  let did = await home('open home');
  let last = '';
  let same = 0;
  for (let looks = 0; looks < 40; looks++) {
    let f: Frame;
    try {
      f = await look(s, task);
    } catch (e) {
      if (!(e instanceof NotReady)) throw e;
      if (o.submitted || (again.get('not ready') ?? 0) >= 2) return stop('step_timeout', e.message);
      again.set('not ready', (again.get('not ready') ?? 0) + 1);
      did = await home('start again from home: the page never became ready');
      continue;
    }
    const text = f.tree.toLowerCase();
    const answer = t.answers.find((a) => text.includes(a.says.toLowerCase()));
    const trouble = t.trouble.find((x) => text.includes(x.says.toLowerCase()));
    let at: string | null = null;
    let unknown: UnknownPage | null = null;
    try {
      at = knows(f, pages);
    } catch (e) {
      if (!(e instanceof UnknownPage)) throw e;
      unknown = e;
    }
    await s.keep?.({ did, page: at, screen: at && screenOf(t, at) }, f);
    if (answer) return stop(answer.code, answer.says, answer.retryable);
    if (trouble) {
      const n = again.get(trouble.says) ?? 0;
      if (o.submitted || n >= trouble.again) return stop(trouble.code, trouble.says, true);
      again.set(trouble.says, n + 1);
      did = await home(`start again from home: "${trouble.says}"`);
      continue;
    }
    if (!at) {
      // A page the table doesn't know may be one that comes and goes (a notice, a promotion): one
      // fresh start from home before the crawler is called broken. Never after Submit.
      if (!o.submitted && !again.get('unknown page')) {
        again.set('unknown page', 1);
        did = await home('start again from home: a page the table does not know');
        continue;
      }
      return stop('unknown_screen', unknown?.message);
    }
    if (at === t.ends[goal]) return f;
    same = at === last ? same + 1 : 0;
    last = at;
    if (same >= 2) return stop('stuck', `the ${at} page three times running`);
    const row = t.rows.find((r) => r.page === at)!;
    // A goal's own steps on this page, else any goal's, else the balance goal's: a learned route crosses
    // the sign-in and the search once, for the balance, and that way through serves every goal.
    const steps = row.do[goal] ?? row.do.any ?? row.do.balance;
    if (!steps?.length) return stop('stuck', `nothing to do on the ${at} page`);
    // One code for this visit to the page: a route that types it twice asks for it once (a learned
    // route held the code page's field twice, by its label and by its position, and asked twice).
    const visit: Session = { ...s, code: oneCode(() => s.code()).code };
    try {
      for (const [i, st] of steps.entries()) {
        did = await step(visit, task, screenOf(t, at), st);
        // The last step's frame is the next look's.
        if (s.everyStep && i < steps.length - 1)
          await s.keep?.(
            { did, page: at, screen: screenOf(t, at) },
            await see(s.page, { known: s.known, limitMs: s.limitMs ?? 60_000, everyMs: 150 }),
          );
      }
    } catch (e) {
      // A control that isn't there: look again, and the page that shows gets its row.
      if (!(e instanceof TargetError)) throw e;
      did = `could not: ${e.message}`;
    }
  }
  return stop('stuck', 'forty pages and no end');
}

/** Money as a page draws it ("$1,234.56", "-$5.00", "($5.00)"), in cents. */
export function cents(drawn: string): number {
  const n = Math.round(Number(drawn.replace(/[^\d.]/g, '')) * 100);
  return /^[-(]|-\$/.test(drawn) ? -n : n;
}

/**
 * One line of the rendered tree as the words drawn there, if it is a leaf: `- text: …`, or a role
 * and its name with nothing nested under it. A line that holds a colon comes wrapped in quotes.
 */
export function leaf(line: string): string | null {
  let t = line.trim();
  const quoted = t.match(/^- '(.*)'(:?)$/);
  if (quoted) t = `- ${quoted[1]!.replace(/''/g, "'")}${quoted[2]}`;
  const text = t.match(/^- (?:text|paragraph): (.*)$/);
  if (text) return text[1]!.replace(/^"(.*)"$/, '$1');
  const named = t.match(/^- [a-z]+ "(.*)"(?: \[[^\]]*\])*$/);
  return named ? named[1]! : null;
}

/**
 * The words a person sees on a page, one per line of its tree. A closed list shows only its chosen
 * option, so its other options are left out: run 28 read a list's first option as its value.
 */
export function seen(tree: string): string[] {
  return tree.split('\n').flatMap((line) => {
    if (/^\s*- option /.test(line) && !line.includes('[selected]')) return [];
    const w = leaf(line);
    return w ? [w] : [];
  });
}

/** Each list's chosen option, in the order the page shows its lists ('' when none is chosen). */
export function chosenIn(tree: string): string[] {
  const lines = tree.split('\n');
  return lines.flatMap((line, i) => {
    if (!/^\s*- combobox\b/.test(line)) return [];
    const indent = line.search(/\S/);
    let pick = '';
    for (let k = i + 1; k < lines.length && lines[k]!.search(/\S/) > indent; k++)
      if (/^\s*- option /.test(lines[k]!) && lines[k]!.includes('[selected]'))
        pick = leaf(lines[k]!) ?? '';
    return [pick];
  });
}

/** The visible words, one leaf per line, unmasked: for reading a value, never kept. */
export const leaves = async (page: Page) =>
  (await read(page))
    .split('\n')
    .map(leaf)
    .filter((l): l is string => l !== null);

/** The last four digits of an account as a page draws it ("Acct ****1234", "1234"). */
const lastFour = (drawn: string) => drawn.match(/\d{4}(?!.*\d{4})/)?.[0] ?? '****';

export async function checkBalance(s: Session, task: Task & { account: string }) {
  await crawl(s, task, 'balance');
  s.guard?.({ screen: screenOf(s.table, s.table.ends.balance), verb: 'read', control: 'Page' });
  const text = (await leaves(s.page)).join('\n');
  const tiles = accountsIn(text, s.table.reads.balance, task.member, task.account).matching;
  const names = new Set(tiles.map((g) => `${g.name}/${g.last4}`));
  if (names.size !== 1) return stop('no_such_account', `${names.size} accounts match`);
  const g = tiles[0]!;
  return {
    accountLabel: `${g.name}, ending in ${lastFour(g.last4 ?? '')}`,
    availableCents: cents(g.available!),
    currentCents: cents(g.current!),
    asOf: new Date().toISOString(),
  };
}

export interface Review {
  from: string;
  to: string;
  amountCents: number;
  memo: string;
}

/** Fills in the transfer and stops at the bank's review: what a person approves. */
export async function prepareTransfer(s: Session, task: Task): Promise<Review> {
  await crawl(s, task, 'transfer');
  return readReview(s);
}

/** The review page's From, To, Amount and Memo, as the bank shows them. */
export async function readReview(s: Session): Promise<Review> {
  s.guard?.({ screen: screenOf(s.table, s.table.ends.transfer), verb: 'read', control: 'Page' });
  const m = readOf(s.table.reads.review).exec((await leaves(s.page)).join('\n'));
  if (!m?.groups) return stop('ambiguous_outcome', 'the review page could not be read');
  return {
    from: m.groups.from!,
    to: m.groups.to!,
    amountCents: cents(m.groups.amount!),
    memo: m.groups.memo!,
  };
}

/**
 * Presses Submit once, on the review page the run holds, then finds the transfer in the
 * from-account's activity by its memo. Exactly one row is success; anything else, a person checks.
 * `approve` runs just before the press, with the values the page shows: it consumes the person's
 * approval, and throws if there is none for them.
 */
export async function submitTransfer(
  s: Session,
  task: Task & { memo: string },
  approve: (shown: Review) => Promise<void>,
) {
  await knowTask(s);
  await approve(await readReview(s));
  const t = s.table;
  s.guard?.({ screen: screenOf(t, t.ends.transfer), verb: 'press', control: t.submit.press });
  // A send button with no words of its own (a picture) is found by sight, like any learned step.
  if (t.submit.at) await clickAt(s.page, await pointOf(s.page, t.submit.at));
  else await press(s.page, t.submit.press);
  await s.note?.('submit', 'pressed submit, under the grant');
  let confirmation: string | undefined;
  try {
    const f = await look(s, task);
    const pages = pagesOf(t);
    const at = (() => {
      try {
        return knows(f, pages);
      } catch {
        return null;
      }
    })();
    await s.keep?.(
      { did: `press "${t.submit.press}"`, page: at, screen: at && screenOf(t, at) },
      f,
    );
    const text = f.tree.toLowerCase();
    const answer = t.answers.find((a) => text.includes(a.says.toLowerCase()));
    if (answer) return stop(answer.code, answer.says, answer.retryable);
    if (at && t.reads.confirmation) {
      s.guard?.({ screen: screenOf(t, at), verb: 'read', control: 'Page' });
      confirmation = readOf(t.reads.confirmation).exec((await leaves(s.page)).join('\n'))?.groups
        ?.confirmation;
    }
  } catch (e) {
    if (!(e instanceof NotReady)) throw e;
    // A Submit that hangs is read back from the history, never pressed again.
  }
  const rows = await inHistory(s, task);
  if (rows !== 1)
    return stop('ambiguous_outcome', `${rows} rows in the activity hold the transfer's memo`);
  // No confirmation when Submit hung: the history alone found it.
  return { ...(confirmation && { confirmation }), seenInHistory: true as const };
}

/** How many rows of the from-account's activity hold the transfer's memo. Never presses Submit. */
export async function inHistory(s: Session, task: Task & { memo: string }): Promise<number> {
  await crawl(s, task, 'history', { submitted: true });
  s.guard?.({ screen: screenOf(s.table, s.table.ends.history), verb: 'read', control: 'Page' });
  // The memo begins with the run's token, which no other transfer carries: any bank's activity
  // shows it in one visible line per transfer.
  return (await leaves(s.page)).filter((l) => l.includes(task.memo)).length;
}
