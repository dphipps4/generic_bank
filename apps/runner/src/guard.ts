// The guard on every action the Runner takes (plan, §9): each click, key press, typed field and
// choice is judged against the job's allowlist before it reaches the browser. The guard reads the
// screen the way the driver does, from the same fresh reading the action would use: it recognizes
// the screen and reads the control's visible name, or a field's label, and nothing a page asks.
// The first refusal trips it for good: every action after it is refused too, and the run ends
// `escalated: guard_tripped`, which freezes the bank.
import { controlNames, type Profile, signatures } from '@gb/drivers';
import {
  ALLOWLISTS,
  ANY,
  decide,
  type GrantCheck,
  GuardError,
  type JOBS,
  type Layer,
  type Names,
  screenOf,
} from '@gb/guardrails';
import {
  type Action,
  field,
  type Guard,
  namePictures,
  recognize,
  type ScreenModel,
} from '@gb/screen';

type Job = (typeof JOBS)[number];

export interface RunGuard {
  guard: Guard;
  /** The grant check made for the money-moving press that follows it. */
  granted(g: GrantCheck): void;
  /** The refusal that tripped the guard, with its layer and rule; null while none has. */
  tripped(): { layer: Layer; rule: string } | null;
}

export function runGuard(o: {
  job: Job;
  profile: Omit<Profile, 'url'>;
  /** The operator's credentials: typed only by the secret path, never as plain text. */
  secrets: string[];
}): RunGuard {
  const sigs = signatures({ ...o.profile, url: '' });
  const names = controlNames(o.profile);
  let grant: GrantCheck | undefined;
  let refusal: { layer: Layer; rule: string } | null = null;

  const guard: Guard = (a) => {
    if (refusal) throw new GuardError(refusal.layer, `the guard has tripped: ${refusal.rule}`);
    const m = namePictures(a.model, o.profile.pictures);
    const screen = screenOf(recognize(m, sigs).screen);
    const v = decide(o.job, screen, a.verb, nameOf(o.job, a, m, screen, names), {
      names,
      secrets: o.secrets,
      ...(a.secret ? { secret: true } : {}),
      ...(a.verb === 'type' && a.text !== undefined ? { typed: a.text } : {}),
      ...(grant ? { grant } : {}),
    });
    if (!v.allowed) {
      refusal = { layer: v.layer, rule: v.rule };
      throw new GuardError(v.layer, v.rule);
    }
  };

  return { guard, granted: (g) => void (grant = g), tripped: () => refusal };
}

/**
 * The name the list judges: a key's own; a button's or link's visible name, its picture named;
 * a field's label, which is the listed field the driver's own targeting finds at that control.
 */
function nameOf(job: Job, a: Action, m: ScreenModel, screen: string, names: Names): string {
  if (!a.control) return `the ${a.key} key`;
  const c = a.control;
  const same = (x: { backendNodeId: number; session: string }) =>
    x.backendNodeId === c.backendNodeId && x.session === c.session;
  if (a.verb === 'press' || a.verb === 'open') return m.controls.find(same)?.name || c.name;
  for (const e of ALLOWLISTS[job]) {
    if ((e.screen !== screen && e.screen !== ANY) || e.verb !== a.verb) continue;
    const labels = [e.control, ...(names[e.control] ?? []).filter((n) => typeof n === 'string')];
    try {
      if (same(field(m, labels))) return e.control;
    } catch {
      // No such label here, or more than one field for it: not this entry.
    }
  }
  return c.name || 'a field with no label on the list';
}
