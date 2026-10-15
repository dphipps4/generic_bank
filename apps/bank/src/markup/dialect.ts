import { createHmac } from 'node:crypto';
import { hash32 } from '../rng.js';
import type { Tenant } from '../tenants.js';

// Every page renders its controls in its own dialect, fixed by the tenant's markup seed, the UI
// version and the page's name. The same tenant and version always produce the same markup, as a
// real enterprise UI does; a version bump moves things, which is what the repair loop is for.

export type SubmitStyle = 'image' | 'button' | 'jslink' | 'cell';
export type LabelStyle = 'plain' | 'bold' | 'split';

export interface Dialect {
  page: string;
  submit: SubmitStyle;
  label: LabelStyle;
  depth: number;
  upper: boolean;
  /** A class name hashed per tenant, version and page: stable, and meaningless. */
  cls(role: string): string;
}

const SUBMITS: SubmitStyle[] = ['image', 'button', 'jslink', 'cell'];

/**
 * The product's pages, in a fixed order. Their submit dialects rotate through all four styles, so
 * every bank uses every style; the rotation's starting point is fixed per tenant and version.
 * Hashing each page on its own could leave a style unused.
 */
export const PAGES = [
  'signin',
  'code',
  'code-enter',
  'search',
  'summary',
  'activity',
  'statements',
  'transfer',
  'review',
  'approve',
  'decoy',
] as const;
const LABELS: LabelStyle[] = ['plain', 'bold', 'split'];

export function dialect(t: Tenant, uiVersion: number, page: string): Dialect {
  const h = (k: string) => hash32(t.markupSeed, uiVersion, page, k);
  return {
    page,
    submit: SUBMITS[
      ((PAGES as readonly string[]).includes(page)
        ? hash32(t.markupSeed, uiVersion, 'rotation') + (PAGES as readonly string[]).indexOf(page)
        : h('submit')) % SUBMITS.length
    ] as SubmitStyle,
    label: LABELS[h('label') % LABELS.length] as LabelStyle,
    depth: 4 + (h('depth') % 4),
    upper: h('case') % 2 === 0,
    cls: (role) => `c${h(`cls:${role}`).toString(36).slice(0, 5)}`,
  };
}

/**
 * Form field names are random per session; the server maps them back. A field's name is a keyed
 * hash of the session's form nonce and the field's meaning.
 */
export function fieldName(nonce: string, logical: string): string {
  return `f${createHmac('sha256', nonce).update(logical).digest('hex').slice(0, 8)}`;
}

export function readFields<K extends string>(
  body: Record<string, unknown>,
  nonce: string,
  logicals: readonly K[],
): Record<K, string> {
  const out = {} as Record<K, string>;
  for (const k of logicals) {
    const v = body[fieldName(nonce, k)];
    out[k] = typeof v === 'string' ? v : '';
  }
  return out;
}
