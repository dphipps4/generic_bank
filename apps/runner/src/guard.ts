// The guard on every action the Runner takes (plan, §9): each step the crawler takes, each typed
// field, choice, press and read, is judged against the job's allowlist before it reaches the
// browser. It judges the page as the bank's table names it, the verb, and the control's drawn name
// from the table, and nothing a page says. The first refusal trips it for good: every action after
// it is refused too, and the run ends `escalated: guard_tripped`, which freezes the bank.
import type { Action } from '@gb/crawler';
import { decide, type GrantCheck, GuardError, type JOBS, type Layer } from '@gb/guardrails';

type Job = (typeof JOBS)[number];

export interface RunGuard {
  guard(a: Action): void;
  /** The grant check made for the money-moving press that follows it. */
  granted(g: GrantCheck): void;
  /** The refusal that tripped the guard, with its layer and rule; null while none has. */
  tripped(): { layer: Layer; rule: string } | null;
}

export function runGuard(o: {
  job: Job;
  /** The bank's own names for the controls the lists name. */
  names?: Record<string, string[]>;
  /** The operator's password: typed only by the secret path, never as plain text. */
  secrets: string[];
}): RunGuard {
  let grant: GrantCheck | undefined;
  let refusal: { layer: Layer; rule: string } | null = null;
  const guard = (a: Action) => {
    if (refusal) throw new GuardError(refusal.layer, `the guard has tripped: ${refusal.rule}`);
    const v = decide(o.job, a.screen, a.verb, a.control, {
      names: o.names ?? {},
      secrets: o.secrets,
      ...(a.secret ? { secret: true } : {}),
      ...(a.typed !== undefined ? { typed: a.typed } : {}),
      ...(grant ? { grant } : {}),
    });
    if (!v.allowed) {
      refusal = { layer: v.layer, rule: v.rule };
      throw new GuardError(v.layer, v.rule);
    }
  };
  return { guard, granted: (g) => void (grant = g), tripped: () => refusal };
}
