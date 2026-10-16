// The factory's two models, scripted, for a run at a bank in the bank's own words: the Supervisor
// answers each step in its form, recommends from the run's frames and records what the run taught;
// the Scout follows a plan for each instruction. Behind the gateway's live upstream, they make the
// recordings `just onboard` and `just repair` replay with no key (FACTORY_RECORD=1). Nothing
// reaches a model.
import { TENANTS, type TenantId } from '../../apps/bank/src/tenants.js';
import type { Lesson } from '../../apps/factory/src/memory.js';
import type { Claim } from '../../apps/factory/src/recommend.js';
import { fakeModels } from '../../apps/factory/test/fakes.js';

/** The page as a tool result or an instruction shows it to the model. */
type View = {
  controls: { ref: string; role: string; name: string; options?: string[] }[];
  texts: string[];
};
const pageOf = (text: string): View | undefined => {
  try {
    return JSON.parse(text.slice(text.lastIndexOf('\n') + 1)) as View;
  } catch {
    return undefined;
  }
};
const has = (p: View, name: string) => p.controls.some((c) => c.name === name);
const ref = (p: View, role: string | null, name?: string) => {
  const c = p.controls.findLast(
    (x) => (role === null || x.role === role) && (name === undefined || x.name === name),
  );
  if (!c) throw new Error(`no ${role ?? 'control'} ${name ?? ''} on ${JSON.stringify(p)}`);
  return c.ref;
};
const lists = (p: View) => p.controls.filter((c) => c.options);
type Use = { tool: string; input: Record<string, unknown> };

/** A frame of the run as the Supervisor is shown it, at the end of the run. */
type Shown = { ref: string; controls: string[]; texts: string[] };
const framesIn = (text: string): Shown[] =>
  [...text.matchAll(/^(f\d+): (\{.*\})$/gm)].map(([, r, json]) => ({
    ref: r!,
    ...(JSON.parse(json!) as { controls: string[]; texts: string[] }),
  }));
const where = (frames: Shown[], pred: (f: Shown) => boolean, what: string) => {
  const f = frames.find(pred);
  if (!f) throw new Error(`no frame shows ${what}`);
  return f.ref;
};
const showsText = (value: string) => (f: Shown) => f.texts.some((t) => t.includes(value));

/** The Supervisor's and the Scout's models at one bank, in its words. */
export function scripted(bank: TenantId, member: string) {
  const w = TENANTS[bank].labels;
  const SEARCH = `Search for member ${member}.`;
  const FILL = `Choose the first account to send from and the second to receive, type 1.00, then press ${w.continue}.`;

  /** The Scout's side: what its model does for each instruction. */
  const PLANS: Record<string, ((p: View) => Use)[]> = {
    'Sign in as the staff service account.': [
      (p) => ({
        tool: 'browser_type_credential',
        input: { ref: ref(p, 'textbox'), credential: 'user_id' },
      }),
      (p) => ({
        tool: 'browser_type_credential',
        input: { ref: ref(p, 'password'), credential: 'password' },
      }),
      (p) => ({ tool: 'browser_click', input: { ref: ref(p, null, w.signIn) } }),
    ],
    'Have the code sent.': [
      (p) => ({ tool: 'browser_click', input: { ref: ref(p, null, 'Send code') } }),
    ],
    'Enter the code the bank sent.': [
      (p) => ({ tool: 'browser_enter_code', input: { ref: ref(p, 'textbox') } }),
      (p) => ({ tool: 'browser_click', input: { ref: ref(p, null, 'Verify') } }),
    ],
    'Press Continue to Online Banking.': [
      (p) => ({
        tool: 'browser_click',
        input: { ref: ref(p, null, 'Continue to Online Banking') },
      }),
    ],
    'Open the Menu.': [(p) => ({ tool: 'browser_click', input: { ref: ref(p, null, 'Menu ▾') } })],
    'Open Member Lookup.': [
      (p) => ({ tool: 'browser_click', input: { ref: ref(p, null, 'Member Lookup') } }),
    ],
    [`Open ${w.memberSearch}.`]: [
      (p) => ({ tool: 'browser_click', input: { ref: ref(p, null, w.memberSearch) } }),
    ],
    [SEARCH]: [
      (p) => ({ tool: 'browser_type', input: { ref: ref(p, 'textbox'), text: member } }),
      (p) => ({ tool: 'browser_click', input: { ref: ref(p, null, w.search) } }),
    ],
    'Open the member.': [(p) => ({ tool: 'browser_click', input: { ref: ref(p, null, 'Open') } })],
    [`Open ${w.statements} on the first account.`]: [
      // The first account's, after its activity: a console may have a tab of the same name.
      (p) => {
        const i = p.controls.findIndex((c) => c.name === w.activity);
        const c =
          p.controls.slice(i + 1).find((x) => x.name === w.statements) ??
          p.controls.find((x) => x.name === w.statements)!;
        return { tool: 'browser_click', input: { ref: c.ref } };
      },
    ],
    [`Open ${w.transferFunds}.`]: [
      (p) => ({ tool: 'browser_click', input: { ref: ref(p, null, w.transferFunds) } }),
    ],
    [FILL]: [
      (p) => ({ tool: 'browser_choose', input: { ref: lists(p)[0]!.ref, option: 2 } }),
      (p) => ({ tool: 'browser_choose', input: { ref: lists(p)[1]!.ref, option: 3 } }),
      // The amount: the first field after the two lists (a memo may follow it).
      (p) => {
        const after = p.controls.indexOf(lists(p)[1]!);
        const amount = p.controls.slice(after + 1).find((c) => c.role === 'textbox')!;
        return { tool: 'browser_type', input: { ref: amount.ref, text: '1.00' } };
      },
      (p) => ({ tool: 'browser_click', input: { ref: ref(p, null, w.continue) } }),
    ],
  };

  /** The Supervisor's side: the next step from the goal and the latest page, on either look. */
  function decide(goal: string, p: View): string {
    if (p.controls.some((c) => c.role === 'password'))
      return 'Sign in as the staff service account.';
    if (has(p, 'Send code')) return 'Have the code sent.';
    if (has(p, 'Verify')) return 'Enter the code the bank sent.';
    if (has(p, 'Continue to Online Banking')) return 'Press Continue to Online Banking.';
    const summary = p.texts.some((t) => t.includes('Available balance'));
    const search = has(p, 'Open')
      ? 'Open the member.'
      : has(p, w.search)
        ? SEARCH
        : has(p, 'Member Lookup')
          ? 'Open Member Lookup.'
          : has(p, 'Menu ▾')
            ? 'Open the Menu.'
            : `Open ${w.memberSearch}.`;
    if (goal.includes('balances')) return summary ? 'stop' : search;
    if (goal.includes('statements')) {
      if (has(p, 'Show')) return 'stop';
      return summary ? `Open ${w.statements} on the first account.` : search;
    }
    if (p.texts.includes('Review transfer')) return 'stop';
    if (lists(p).length === 2) return FILL;
    return summary ? `Open ${w.transferFunds}.` : search;
  }

  /**
   * The recommendation, from the run's frames: at onboarding, the bank's words, each on the first
   * frame that shows it, and a refusal it never made as a guess; at a repair, only what changed,
   * each on the frame of this run that shows it.
   */
  function recommending(text: string, repair: boolean, results: number) {
    if (results) return { text: 'Recommended.' };
    const frames = framesIn(text);
    const control = (about: string, value: string): Claim => ({
      about,
      value,
      basis: 'seen',
      frames: [where(frames, (f) => f.controls.includes(value), value)],
    });
    const text_ = (about: string, value: string): Claim => ({
      about,
      value,
      basis: 'seen',
      frames: [where(frames, showsText(value), value)],
    });
    const claims = repair
      ? [
          control('words.memberSearch', 'Member Lookup'),
          control('words.activity', 'History'),
          control('words.menu', 'Menu ▾'),
          control('words.dismiss', 'Continue to Online Banking'),
          text_('screens.login.notice', "We've refreshed Online Banking"),
          text_('screens.console.home', 'Open the Menu and choose'),
        ]
      : [
          control('words.signIn', w.signIn),
          control('words.memberSearch', w.memberSearch),
          control('words.statements', w.statements),
          control('words.transfer', w.transferFunds),
          control('words.continue', w.continue),
          text_('screens.member.summary', 'Available balance'),
          {
            about: 'refusals.insufficient_funds',
            value: 'The amount is more than the available balance.',
            basis: 'guess',
            frames: [where(frames, (f) => f.controls.includes(w.continue), 'the transfer form')],
          } satisfies Claim,
        ];
    return { tool: 'recommend', input: { claims } };
  }

  /**
   * What the run taught: a lesson seen on the frame that shows it, and one the frames only
   * suggest, as a guess. The first lesson memory served, the run relied on.
   */
  function lessons(text: string, results: number) {
    const frames = framesIn(text);
    const signIn = where(frames, (f) => f.controls.includes(w.signIn), 'the sign-in');
    const taught: Lesson[] = [
      /refreshed Online Banking/.test(text)
        ? {
            text: 'After the redesign, a notice follows every sign-in and must be passed with its own button before the console shows.',
            area: 'navigation',
            scope: 'tenant',
            confidence: 'high',
            basis: 'seen',
            frames: [where(frames, showsText("We've refreshed Online Banking"), 'the notice')],
          }
        : frames.some((f) => f.controls.includes('Send code'))
          ? {
              text: 'This bank waits for the operator to ask for the staff code with a button after the password; nothing arrives until then.',
              area: 'sign-in',
              scope: 'tenant',
              confidence: 'high',
              basis: 'seen',
              frames: [where(frames, (f) => f.controls.includes('Send code'), 'the code page')],
            }
          : {
              text: 'This bank sends the staff code as soon as the password is accepted and asks for it on the next page, with no button to have it sent.',
              area: 'sign-in',
              scope: 'tenant',
              confidence: 'high',
              basis: 'seen',
              frames: [where(frames, (f) => f.controls.includes('Verify'), 'the code page')],
            },
      {
        text: 'Labels drawn as pictures may hide which field is which; tell the fields apart by their kind and order.',
        area: 'targeting',
        scope: 'vendor',
        confidence: 'low',
        basis: 'guess',
        frames: [signIn],
      },
    ];
    if (results < taught.length) return { tool: 'record_lesson', input: taught[results]! };
    const served = /^Lessons memory served this run:\n([^:\n]+):/m.exec(text)?.[1];
    return { text: JSON.stringify({ reliedOn: served ? [served] : [], contradicted: [] }) };
  }

  return fakeModels((_provider, r) => {
    const said = r.items.flatMap((x) => ('user' in x ? [x.user] : []));
    const results = r.items.filter((x) => 'result' in x).length;
    if (r.system.includes('Write down what it taught')) return lessons(said[0]!, results);
    if (r.system.includes('with the recommend tool'))
      return recommending(said[0]!, r.system.includes('the bank has changed'), results);
    if (r.system.startsWith('You are the Supervisor')) {
      const text = said[0]!;
      const goal = /^Goal: (.*)$/m.exec(text)![1]!;
      const [, at, json] = /Latest frame, (f\d+):\n(.*)$/s.exec(text)!;
      return {
        text: JSON.stringify({
          next: decide(goal, JSON.parse(json!) as View),
          reason: `the page in ${at} shows where the Scout is`,
          frames: [at],
        }),
      };
    }
    const at = r.items.findLastIndex((x) => 'user' in x && PLANS[x.user.split('\n')[0]!]);
    const instruction = (r.items[at] as { user: string }).user;
    const plan = PLANS[instruction.split('\n')[0]!]!;
    const done = r.items.slice(at + 1).flatMap((x) => ('result' in x ? [x.result] : []));
    const shown = done.map(pageOf).filter(Boolean).at(-1) ?? pageOf(instruction)!;
    return done.length < plan.length ? plan[done.length]!(shown) : { text: 'Done.' };
  });
}
