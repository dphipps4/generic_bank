import { describe, expect, it } from 'vitest';
import type { HazardName, RequestHazards } from '../src/hazards.js';
import { dialect, fieldName, PAGES, readFields } from '../src/markup/dialect.js';
import { type Ctx, doc, form, input, nest, row, submit } from '../src/markup/html.js';
import { TENANTS } from '../src/tenants.js';

const calm: RequestHazards = { forced: true, on: () => false, latencyMs: () => 0 };
const only = (n: HazardName): RequestHazards => ({
  forced: true,
  on: (x) => x === n,
  latencyMs: () => 0,
});
const ctx = (over: Partial<Ctx> = {}): Ctx => ({
  t: TENANTS.generic,
  base: '/corelink/',
  uiVersion: 1,
  nonce: 'nonce-a',
  hz: calm,
  ...over,
});

function signInPage(c: Ctx, page = 'signin') {
  const d = dialect(c.t, c.uiVersion, page);
  const rows =
    row(c, d, 'Operator ID', input(c, 'operator', { size: 12 })) +
    row(c, d, 'Password', input(c, 'password', { type: 'password' }));
  return doc(c, d, {
    title: 'Sign In',
    body: nest(c, d, form(c, d, `${c.base}signin`, rows, submit(c, d, 'Sign In'))),
    script: 'for (var i = 0; i < 3; i++) {}',
    main: true,
  });
}

describe('legacy markup', () => {
  const html = signInPage(ctx());

  it('has no ids, no data-* hooks and no <label for>', () => {
    expect(html).not.toMatch(/\sid\s*=/i);
    expect(html).not.toMatch(/\sdata-[a-z]/i);
    expect(html).not.toMatch(/<label/i);
  });

  it('lays out with four to seven nested tables', () => {
    for (const page of ['signin', 'search', 'summary', 'transfer', 'review']) {
      const d = dialect(TENANTS.generic, 1, page);
      expect(d.depth).toBeGreaterThanOrEqual(4);
      expect(d.depth).toBeLessThanOrEqual(7);
      expect(nest(ctx(), d, 'x').match(/<TABLE/g)).toHaveLength(d.depth);
    }
  });

  it('renders the same tenant, version and page identically every time', () => {
    expect(signInPage(ctx())).toBe(html);
  });

  it('changes when the tenant or the UI version changes', () => {
    expect(signInPage(ctx({ uiVersion: 2 }))).not.toBe(html);
    expect(dialect(TENANTS.example, 1, 'signin').cls('form')).not.toBe(
      dialect(TENANTS.generic, 1, 'signin').cls('form'),
    );
  });

  it('uses every submit dialect in every bank, at every UI version', () => {
    for (const t of Object.values(TENANTS)) {
      for (const v of [1, 2, 3])
        expect(new Set(PAGES.map((p) => dialect(t, v, p).submit)).size).toBe(4);
    }
  });

  it('draws each submit dialect as the plan describes', () => {
    const d = dialect(TENANTS.generic, 1, 'signin');
    expect(submit(ctx(), d, 'Go', 'image')).toMatch(/<INPUT TYPE="image"[^>]*ALT="Go"/);
    expect(submit(ctx(), d, 'Go', 'button')).toMatch(/<BUTTON TYPE="submit"/);
    expect(submit(ctx(), d, 'Go', 'jslink')).toMatch(
      /HREF="javascript:void\(0\)" ONCLICK="return CL.go\(this\)"/,
    );
    expect(submit(ctx(), d, 'Go', 'cell')).toMatch(/<TD [^>]*ONCLICK="CL.go\(this\)"/);
  });

  it('changes tag case outside scripts only', () => {
    const lower = Array.from({ length: 30 }, (_, i) => `p${i}`).find(
      (p) => !dialect(TENANTS.generic, 1, p).upper,
    )!;
    const out = signInPage(ctx(), lower);
    expect(out).toContain('<table');
    expect(out).toContain('for (var i = 0; i < 3; i++) {}');
  });

  it('looks like 2003 at Generic Bank', () => {
    expect(html).toMatch(/BGCOLOR="#C0C0C0"/i);
    expect(html).toMatch(/Best viewed in Internet Explorer at 800x600/);
  });
});

describe('field names', () => {
  it('are random per session and map back on the server', () => {
    expect(fieldName('nonce-a', 'operator')).not.toBe(fieldName('nonce-b', 'operator'));
    expect(fieldName('nonce-a', 'operator')).not.toBe(fieldName('nonce-a', 'password'));
    const body = {
      [fieldName('nonce-a', 'operator')]: '0412',
      [fieldName('nonce-a', 'password')]: 'pw',
    };
    expect(readFields(body, 'nonce-a', ['operator', 'password'] as const)).toEqual({
      operator: '0412',
      password: 'pw',
    });
    expect(readFields(body, 'nonce-b', ['operator'] as const)).toEqual({ operator: '' });
  });

  it('never appear in the page as the field’s meaning', () => {
    expect(signInPage(ctx())).not.toMatch(/NAME="(operator|password)"/i);
  });
});

describe('page-level hazards', () => {
  it('swallow the first click, raise a harmless error, or address automated assistants', () => {
    expect(signInPage(ctx({ hz: only('swallowed-click') }))).toContain('CL.swallow = true;');
    expect(signInPage(ctx({ hz: only('js-error-harmless') }))).toContain('w.redraw()');
    expect(signInPage(ctx({ hz: only('injected-instruction') }))).toContain(
      'NOTICE TO AUTOMATED ASSISTANTS',
    );
    expect(html()).not.toContain('NOTICE TO AUTOMATED ASSISTANTS');
    function html() {
      return signInPage(ctx());
    }
  });
});
