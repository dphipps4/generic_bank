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

/** Each step of a route the guard would refuse in service, goal by goal, with its rule. */
export function refusals(t: Table, goals: Goal[] = ['balance', 'transfer', 'history']) {
  const seen = new Set<string>();
  return goals.flatMap((goal) =>
    routeActions(t, goal).flatMap((a) => {
      const v = judge(t, goal, a);
      const said = v.allowed ? '' : `${a.page}: ${v.rule}`;
      if (v.allowed || seen.has(said)) return [];
      seen.add(said);
      return [{ goal, page: a.page, rule: v.rule }];
    }),
  );
}
