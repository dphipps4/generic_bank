// The guard's own words, for a route the factory writes. In service, every step of a route is
// judged by the job's allowlist: by the kind of screen it is taken on, and by the control's name in
// the guard's words. So a learned route has to speak them. The Scout gives each screen its kind and
// says which allowed control each press stands for; every step is judged while it learns, as it
// will be in service; and a route the guard would refuse never reaches a person.
import { type Action, type Goal, routeActions, type Table } from '@gb/crawler';
import { ALLOWLISTS, ANY, decide, type Verdict } from '@gb/guardrails';

/** The job each goal runs under in service: the activity is read by the transfer's run. */
export const JOB = { balance: 'check-balance', transfer: 'transfer', history: 'transfer' } as const;

/** The guard's kinds of screen, as name_page offers them. */
export const SCREEN_KINDS = [
  ...new Set(
    Object.values(ALLOWLISTS)
      .flat()
      .map((e) => e.screen)
      .filter((s) => s !== ANY),
  ),
].sort() as [string, ...string[]];

/**
 * The screens a task meets because of the browser's state or the bank's, not because of the task:
 * signing in, its code, a notice. Which of them a run meets depends on whether the bank trusts the
 * browser, so their steps serve every goal, as bank 1's route files them.
 */
export const EVERY_GOAL = new Set(['sign_in', 'staff_code', 'notice', 'promo', 'session_warning']);

/** The value each typed field holds, and each list's account, by the guard's name for it. */
export const LISTED = {
  user_id: 'Operator ID',
  password: 'Password',
  code: 'Code',
  member: 'Member number',
  amount: 'Amount',
  memo: 'Memo',
  from: 'From',
  to: 'To',
} as const;

/** What the guard says of one action under a goal's job, with the route's names for controls. */
export const judge = (t: Pick<Table, 'names'>, goal: Goal, a: Action): Verdict =>
  decide(JOB[goal], a.screen, a.verb, a.control, {
    names: t.names ?? {},
    ...(a.secret ? { secret: true } : { typed: a.typed ?? '' }),
  });

/** The presses the guard allows for a goal on a kind of screen (every kind's, with none). */
export const pressesOn = (goal: Goal, screen?: string) => [
  ...new Set(
    ALLOWLISTS[JOB[goal]]
      .filter((e) => ['press', 'open'].includes(e.verb) && !e.money)
      .filter((e) => !screen || e.screen === screen || e.screen === ANY)
      .map((e) => e.control),
  ),
];

/**
 * Each step of a route the guard would refuse in service, goal by goal, with its rule. A goal the
 * route has no end for is not served, so there is nothing of it to judge.
 */
export function refusals(t: Table, goals: Goal[] = ['balance', 'transfer', 'history']) {
  const seen = new Set<string>();
  return goals
    .filter((goal) => t.ends[goal])
    .flatMap((goal) =>
      routeActions(t, goal).flatMap((a) => {
        const v = judge(t, goal, a);
        const said = v.allowed ? '' : `${a.page}: ${v.rule}`;
        if (v.allowed || seen.has(said)) return [];
        seen.add(said);
        return [{ goal, page: a.page, rule: v.rule }];
      }),
    );
}

const same = (a: string, b: string) =>
  a.trim().replace(/:$/, '').toLowerCase() === b.trim().replace(/:$/, '').toLowerCase();

/**
 * The route's names with one more: the guard's `listed` control drawn as `label`. A label is one
 * label, and an allowed name stands for one drawn label: run 28 drew "Member Search" as five
 * different controls, and took run-on text that held several labels for one.
 */
export function nameFor(
  names: Record<string, string[]>,
  listed: string,
  label: string,
): Record<string, string[]> | string {
  if (label.trim().length > 40 || (label.match(/:/g) ?? []).length > 1 || /:\s*\S/.test(label))
    return `"${label}" is not one label: name the control by its own label, as the picture draws it`;
  if (same(listed, label)) return names;
  const drawn = names[listed] ?? [];
  const other = drawn.find((d) => !same(d, label));
  if (other)
    return `the guard's "${listed}" is already drawn here as "${other}", so "${label}" is another control: say which allowed control it is`;
  return { ...names, [listed]: drawn.some((d) => same(d, label)) ? drawn : [...drawn, label] };
}
