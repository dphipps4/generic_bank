import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TENANTS, type TenantId } from '../src/tenants.js';
import { type Client, signIn, type TestBank, testBank } from './harness.js';

const IDS = Object.keys(TENANTS) as TenantId[];
const at = {} as Record<TenantId, { b: TestBank; c: Client }>;
beforeAll(async () => {
  for (const id of IDS) {
    const b = await testBank(id);
    at[id] = { b, c: await signIn(b) };
  }
}, 120_000);
afterAll(async () => {
  for (const id of IDS) await at[id].b.close();
});

const frames = (html: string) =>
  [...html.matchAll(/<FRAME SRC="[^"]*?(frame\/\w+|home)" NAME="(\w+)"/g)].map((m) => m[2]);
const scriptsParse = (html: string) => {
  for (const m of html.matchAll(/<script>([\s\S]*?)<\/script>/gi))
    expect(() => new Function(m[1]!)).not.toThrow();
};

describe('the console’s shape, per bank', () => {
  it('Generic Bank: banner, a nav frame on the left, the main frame', async () => {
    const r = await at.generic.c.get('console');
    expect(frames(r.body)).toEqual(['banner', 'nav', 'main']);
    expect(r.body).toContain('<FRAMESET COLS="170,*">');
  });

  it('Example Credit Union: banner, a tab strip across the top, the main frame', async () => {
    const r = await at.example.c.get('console');
    expect(frames(r.body)).toEqual(['banner', 'tabs', 'main']);
    const tabs = await at.example.c.get('frame/tabs');
    for (const w of ['Find Member', 'Move Money', 'Statements', 'Sign Out'])
      expect(tabs.body).toContain(w);
  });

  it('Sample Savings Bank: the tab strip, the main frame, and a notices frame on the right', async () => {
    const r = await at.sample.c.get('console');
    expect(frames(r.body)).toEqual(['banner', 'tabs', 'main', 'notices']);
    expect((await at.sample.c.get('frame/notices')).body).toContain('Notices');
  });

  it('Placeholder FCU: no frameset; a drop-down menu bar over an inline frame', async () => {
    const r = await at.placeholder.c.get('console');
    expect(r.body).not.toMatch(/<frameset/i);
    expect(r.body).toMatch(/<iframe NAME="main"/i);
    for (const w of ['Members', 'Money', 'Tools', 'Sign Out']) expect(r.body).toContain(w);
    expect(r.body).toMatch(/display:none;position:absolute/);
    scriptsParse(r.body);
  });

  it('every shape offers the same places to go', async () => {
    const places = (html: string) =>
      new Set(
        [...html.matchAll(/HREF="([^"]+)"/gi)].map((m) =>
          m[1]!.replace(/^https?:\/\/[^/]+/, '').replace(/^\/[^?]*?(members|area|signout)/, '$1'),
        ),
      );
    const nav = places((await at.generic.c.get('frame/nav')).body.replace(/\\"/g, '"'));
    const tabs = places((await at.example.c.get('frame/tabs')).body);
    const bar = places((await at.placeholder.c.get('console')).body);
    expect(tabs).toEqual(nav);
    for (const p of nav) expect(bar.has(p)).toBe(true);
  });

  it('gives a console only to a signed-in operator, in every bank', async () => {
    for (const id of IDS)
      expect((await at[id].b.client().get('console')).location).toBe(
        `${TENANTS[id].basePath}signin`,
      );
  });
});
