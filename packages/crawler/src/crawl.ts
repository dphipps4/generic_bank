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
import type { Goal, Step, Table } from './table.js';

export interface Session {
  page: Page;
  /** Where the bank's console is. */
  url: string;
  table: Table;
  /** Values never kept in evidence; the crawler adds the sign-in and the member's number. */
  known: string[];
  credentials(): Promise<{ operatorId: string; password: string }>;
  /** The code the bank sent to the staff phone: a person gives it. */
  code(): Promise<string>;
  /** Each page seen, already masked, with what was done before it. */
  keep?(did: string, frame: Frame): Promise<void> | void;
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

/** Does one step; says what was done, never with the value. */
async function step(s: Session, task: Task, st: Step): Promise<string> {
  if ('type' in st) {
    await type(s.page, st.type, await value(s, task, st.value));
    return `type ${st.value} into "${st.type}"`;
  }
  if ('choose' in st) {
    await choose(s.page, st.choose, await value(s, task, st.containing));
    return `choose ${st.containing} in "${st.choose}"`;
  }
  const near = st.near && (await value(s, task, st.near));
  await press(s.page, st.press, near ? { near } : {});
  return `press "${st.press}"`;
}

/** Runs the table from home until the goal's page, and returns that page. */
export async function crawl(
  s: Session,
  task: Task,
  goal: Goal,
  o: { submitted?: boolean } = {},
): Promise<Frame> {
  const t = s.table;
  const { operatorId, password } = await s.credentials();
  const known = [...s.known, operatorId, password, task.member];
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
      f = await see(s.page, { known, limitMs: s.limitMs ?? 60_000 });
    } catch (e) {
      if (!(e instanceof NotReady)) throw e;
      if (o.submitted || (again.get('not ready') ?? 0) >= 2) return stop('step_timeout', e.message);
      again.set('not ready', (again.get('not ready') ?? 0) + 1);
      did = await home('start again from home: the page never became ready');
      continue;
    }
    await s.keep?.(did, f);
    const text = f.tree.toLowerCase();
    const answer = t.answers.find((a) => text.includes(a.says.toLowerCase()));
    if (answer) return stop(answer.code, answer.says, answer.retryable);
    const trouble = t.trouble.find((x) => text.includes(x.says.toLowerCase()));
    if (trouble) {
      const n = again.get(trouble.says) ?? 0;
      if (o.submitted || n >= trouble.again) return stop(trouble.code, trouble.says, true);
      again.set(trouble.says, n + 1);
      did = await home(`start again from home: "${trouble.says}"`);
      continue;
    }
    let at: string;
    try {
      at = knows(f, pages);
    } catch (e) {
      if (e instanceof UnknownPage) return stop('unknown_screen', e.message);
      throw e;
    }
    if (at === t.ends[goal]) return f;
    same = at === last ? same + 1 : 0;
    last = at;
    if (same >= 2) return stop('stuck', `the ${at} page three times running`);
    const row = t.rows.find((r) => r.page === at)!;
    const steps = row.do[goal] ?? row.do.any;
    if (!steps?.length) return stop('stuck', `nothing to do on the ${at} page`);
    try {
      for (const st of steps) did = await step(s, task, st);
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
  const text = (await leaves(s.page)).join('\n');
  const tiles = [...text.matchAll(s.table.reads.balance)]
    .map((m) => m.groups!)
    .filter((g) => g.name === task.account || g.last4 === task.account);
  const names = new Set(tiles.map((g) => `${g.name}/${g.last4}`));
  if (names.size !== 1) return stop('no_such_account', `${names.size} accounts match`);
  const g = tiles[0]!;
  return {
    accountLabel: `${g.name}, Account ending in ****`,
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
  const m = (await leaves(s.page)).join(' ').match(s.table.reads.review);
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
 */
export async function submitTransfer(s: Session, task: Task & { memo: string }) {
  const known = [...s.known, task.member];
  await press(s.page, s.table.submit.press);
  let confirmation: string | undefined;
  try {
    const f = await see(s.page, { known, limitMs: s.limitMs ?? 60_000 });
    await s.keep?.(`press "${s.table.submit.press}"`, f);
    const text = f.tree.toLowerCase();
    const answer = s.table.answers.find((a) => text.includes(a.says.toLowerCase()));
    if (answer) return stop(answer.code, answer.says, answer.retryable);
    confirmation = (await leaves(s.page)).join(' ').match(s.table.reads.confirmation)
      ?.groups?.confirmation;
  } catch (e) {
    if (e instanceof Stop) throw e;
    // A Submit that hangs is read back from the history, never pressed again.
  }
  await crawl(s, task, 'history', { submitted: true });
  const row = s.table.reads.history.replace('$memo', task.memo);
  const rows = (await leaves(s.page)).filter((l) => l.startsWith(row)).length;
  if (rows !== 1)
    return stop('ambiguous_outcome', `${rows} rows in the activity hold the transfer's memo`);
  return { confirmation: confirmation ?? task.memo, seenInHistory: true };
}
