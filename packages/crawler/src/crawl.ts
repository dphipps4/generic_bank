// The loop that runs any bank's table: look at the page, return the bank's answer if it gives one,
// start again from home on trouble, else do the steps of the one row the page shows. It goes by
// what is on screen, not by the order it expects, so a page that shows up early, late or twice
// gets its row. Submit is never in a row: it is pressed once, after a person approves.
import { CODES, type ResultCode } from '@gb/contracts';
import {
  choose,
  type Frame,
  knows,
  NotReady,
  type Page,
  press,
  read,
  see,
  TargetError,
  type,
  UnknownPage,
} from '@gb/runtime';
import { type Goal, readOf, type Step, type Table } from './table.js';

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

/** An account as a page draws it: a name as it is, last four digits as "ending in" them. */
const account = (ref = '') => (/^\d{4}$/.test(ref) ? `ending in ${ref}` : ref);

async function value(s: Session, task: Task, v: string): Promise<string> {
  switch (v) {
    case '$operator':
      return (await s.credentials()).operatorId;
    case '$password':
      return (await s.credentials()).password;
    case '$code':
      return s.code();
    case '$member':
      return task.member;
    case '$from':
      return account(task.from);
    case '$to':
      return account(task.to);
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

/** Does one step, once the guard allows it; says what was done, never with the value. */
async function step(s: Session, task: Task, screen: string, st: Step): Promise<string> {
  if ('type' in st) {
    const v = await value(s, task, st.value);
    const secret = SECRETS.has(st.value);
    s.guard?.({ screen, verb: 'type', control: st.type, ...(secret ? { secret } : { typed: v }) });
    await type(s.page, st.type, v, s.table.pictures);
    return `type ${st.value} into "${st.type}"`;
  }
  if ('choose' in st) {
    s.guard?.({ screen, verb: 'choose', control: st.choose });
    await choose(s.page, st.choose, await value(s, task, st.containing), s.table.pictures);
    return `choose ${st.containing} in "${st.choose}"`;
  }
  const near = st.near && (await value(s, task, st.near));
  s.guard?.({ screen, verb: 'press', control: st.press });
  await press(s.page, st.press, near ? { near } : {});
  return `press "${st.press}"`;
}

/**
 * Learns the member's name where the table says it shows, and adds it (and each of its words) to
 * what is masked. True if it learned something: the frame is then taken again, masked.
 */
async function learn(s: Session, task: Task): Promise<boolean> {
  const text = (await leaves(s.page)).join('\n');
  let learned = false;
  for (const p of s.table.reads.name) {
    const name = readOf(p, task.member).exec(text)?.groups?.name;
    if (!name) continue;
    for (const part of [name, ...name.split(/[\s.,]+/)])
      if (part.trim().length >= 2 && !s.known.includes(part)) {
        s.known.push(part);
        learned = true;
      }
  }
  return learned;
}

/** Sees the page, learning the member's name first if it shows. */
async function look(s: Session, task: Task): Promise<Frame> {
  const o = { known: s.known, limitMs: s.limitMs ?? 60_000 };
  const f = await see(s.page, o);
  return (await learn(s, task)) ? see(s.page, o) : f;
}

/** The sign-in and the member's number join what is masked, before the first page is seen. */
async function knowTask(s: Session, task: Task) {
  const { operatorId, password } = await s.credentials();
  for (const v of [operatorId, password, task.member])
    if (v && !s.known.includes(v)) s.known.push(v);
}

/** Runs the table from home until the goal's page, and returns that page. */
export async function crawl(
  s: Session,
  task: Task,
  goal: Goal,
  o: { submitted?: boolean } = {},
): Promise<Frame> {
  const t = s.table;
  await knowTask(s, task);
  const pages = t.rows.map((r) => ({ name: r.page, shows: r.shows, never: r.never ?? [] }));
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
    if (!at) return stop('unknown_screen', unknown?.message);
    if (at === t.ends[goal]) return f;
    same = at === last ? same + 1 : 0;
    last = at;
    if (same >= 2) return stop('stuck', `the ${at} page three times running`);
    const row = t.rows.find((r) => r.page === at)!;
    const steps = row.do[goal] ?? row.do.any;
    if (!steps?.length) return stop('stuck', `nothing to do on the ${at} page`);
    try {
      for (const st of steps) did = await step(s, task, screenOf(t, at), st);
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

/** The visible words, one leaf per line, unmasked: for reading a value, never kept. */
const leaves = async (page: Page) =>
  (await read(page))
    .split('\n')
    .map(leaf)
    .filter((l): l is string => l !== null);

export async function checkBalance(s: Session, task: Task & { account: string }) {
  await crawl(s, task, 'balance');
  s.guard?.({ screen: screenOf(s.table, s.table.ends.balance), verb: 'read', control: 'Page' });
  const text = (await leaves(s.page)).join('\n');
  const tiles = [...text.matchAll(readOf(s.table.reads.balance, task.member))]
    .map((m) => m.groups!)
    .filter((g) => g.name === task.account || g.last4 === task.account);
  const names = new Set(tiles.map((g) => `${g.name}/${g.last4}`));
  if (names.size !== 1) return stop('no_such_account', `${names.size} accounts match`);
  const g = tiles[0]!;
  return {
    accountLabel: `${g.name}, ending in ****`,
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
  await knowTask(s, task);
  await approve(await readReview(s));
  const t = s.table;
  s.guard?.({ screen: screenOf(t, t.ends.transfer), verb: 'press', control: t.submit.press });
  await press(s.page, t.submit.press);
  await s.note?.('submit', 'pressed submit, under the grant');
  let confirmation: string | undefined;
  try {
    const f = await look(s, task);
    const pages = t.rows.map((r) => ({ name: r.page, shows: r.shows, never: r.never ?? [] }));
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
    if (at) {
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
