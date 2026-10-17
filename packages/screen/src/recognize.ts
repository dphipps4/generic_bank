// Screen recognition (plan, §5). Every screen a product can show is a named signature: phrases it
// must show, phrases it must not, controls it must have, and an optional path hint that is only
// weak evidence. Exactly one signature must match; none, or two, is an unknown screen, and the run
// escalates instead of guessing. Error and outcome screens are signatures too, which is how
// business outcomes are read from the UI.
import type { Role, ScreenModel } from './model.js';

export interface ControlNeed {
  role?: Role | Role[];
  /** The control's name, matched like a phrase; omitted means any name. */
  name?: string | string[];
}

export interface Signature {
  id: string;
  /** Every entry must be on screen; an entry that is a list is satisfied by any one of it. */
  requires?: (string | string[])[];
  /** None of these may be on screen. */
  forbids?: string[];
  controls?: ControlNeed[];
  /** Weak evidence: breaks no ties on its own, but adds to a match. */
  pathHint?: RegExp;
}

export interface Recognition {
  /** The screen, or null when no signature, or more than one, matched. */
  screen: string | null;
  matched: string[];
  /** For an unknown screen: the closest signatures and what each was missing, for the person who looks. */
  closest: { id: string; missing: string[] }[];
}

/** What a person reads: lower case, single spaces, no trailing colons. */
export const normalize = (s: string) =>
  s
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ')
    .replace(/\s*:\s*/g, ' ')
    .trim();

/** The screen as one reading: its text in reading order, then its controls' names. */
export function reading(m: ScreenModel): string {
  const texts = [...m.texts].sort(
    (a, b) => Math.round(a.box.y / 6) - Math.round(b.box.y / 6) || a.box.x - b.box.x,
  );
  return normalize([...texts.map((t) => t.text), ...m.controls.map((c) => c.name)].join(' '));
}

const anyOf = (x: string | string[]) => (Array.isArray(x) ? x : [x]);

function check(sig: Signature, m: ScreenModel, text: string) {
  const missing: string[] = [];
  for (const need of sig.requires ?? []) {
    if (!anyOf(need).some((p) => text.includes(normalize(p))))
      missing.push(`text "${anyOf(need).join('" or "')}"`);
  }
  for (const f of sig.forbids ?? []) if (text.includes(normalize(f))) missing.push(`not "${f}"`);
  for (const need of sig.controls ?? []) {
    const roles = need.role ? anyOf(need.role) : null;
    const names = need.name ? anyOf(need.name).map(normalize) : null;
    const found = m.controls.some(
      (c) => (!roles || roles.includes(c.role)) && (!names || names.includes(normalize(c.name))),
    );
    if (!found)
      missing.push(
        `a ${roles?.join('/') ?? 'control'}${names ? ` named "${names.join('" or "')}"` : ''}`,
      );
  }
  return missing;
}

export function recognize(m: ScreenModel, signatures: Signature[]): Recognition {
  const text = reading(m);
  const results = signatures.map((sig) => {
    // Only what a screen must show counts toward closeness; what it must not show only rules it out.
    const needs = (sig.requires?.length ?? 0) + (sig.controls?.length ?? 0);
    const missing = check(sig, m, text);
    const lacking = missing.filter((x) => !x.startsWith('not ')).length;
    return {
      id: sig.id,
      missing,
      met: needs ? (needs - lacking) / needs : 0,
      hint: sig.pathHint?.test(m.url) ?? false,
    };
  });
  const full = results.filter((r) => r.missing.length === 0);
  let matched = full.map((r) => r.id);
  // A path hint never decides alone, but it settles a tie between full matches.
  if (matched.length > 1) {
    const hinted = full.filter((r) => r.hint).map((r) => r.id);
    if (hinted.length === 1) matched = hinted;
  }
  // Closest is the screen most of whose checks the page meets: a near miss, not a screen with one
  // check that the page fails outright.
  const closest = results
    .filter((r) => r.missing.length > 0)
    .sort((a, b) => b.met - a.met || a.missing.length - b.missing.length)
    .slice(0, 3)
    .map(({ id, missing }) => ({ id, missing }));
  return { screen: matched.length === 1 ? matched[0]! : null, matched, closest };
}
