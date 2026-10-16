import { describe, expect, it } from 'vitest';
import {
  AMBIENT,
  type HazardName,
  hazards,
  type HazardOptions,
  signHazards,
} from '../src/hazards.js';

const KEY = 'k'.repeat(32);
const make = (o: Partial<HazardOptions> = {}) => {
  const log: [HazardName, string, boolean][] = [];
  const h = hazards({
    profile: 'default',
    seed: 7,
    forceable: true,
    hmacKey: KEY,
    log: (...a) => log.push(a),
    ...o,
  });
  return { h, log };
};
const fire = (h: ReturnType<typeof make>['h'], n: number) => {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const r = h.forRequest(undefined, '/p');
    if (r === 'bad-signature') throw new Error('unexpected');
    for (const name of Object.keys(AMBIENT) as HazardName[])
      if (r.on(name)) out.push(`${i}:${name}`);
  }
  return out;
};

describe('ambient hazards', () => {
  it('are the same for the same seed and different for another', () => {
    expect(fire(make().h, 200)).toEqual(fire(make().h, 200));
    expect(fire(make({ seed: 8 }).h, 200)).not.toEqual(fire(make().h, 200));
  });

  it('fire at about the plan’s rates', () => {
    const hits = fire(make().h, 4000).filter((s) => s.endsWith(':js-error-harmless')).length;
    expect(hits / 4000).toBeGreaterThan(0.08);
    expect(hits / 4000).toBeLessThan(0.12);
  });

  it('are a quarter as frequent when gentle, and twice when harsh', () => {
    const n = (p: HazardOptions['profile']) => fire(make({ profile: p }).h, 4000).length;
    expect(n('gentle')).toBeLessThan(n('default') / 2);
    expect(n('harsh')).toBeGreaterThan(n('default') * 1.5);
  });

  it('delay every response by up to 150 ms, and never when none', () => {
    const r = make().h.forRequest(undefined, '/p');
    if (r === 'bad-signature') throw new Error('unexpected');
    expect(r.latencyMs()).toBeGreaterThanOrEqual(0);
    expect(r.latencyMs()).toBeLessThanOrEqual(150);
    expect(fire(make({ profile: 'none' }).h, 500)).toEqual([]);
  });

  it('never fire a forced-only hazard', () => {
    const r = make({ profile: 'harsh' }).h.forRequest(undefined, '/p');
    if (r === 'bad-signature') throw new Error('unexpected');
    expect(r.on('swallowed-submit')).toBe(false);
  });

  it('log every hazard that fires', () => {
    const { h, log } = make();
    const fired = fire(h, 300);
    expect(fired.length).toBeGreaterThan(0);
    expect(log.length).toBe(fired.length);
    expect(log.every(([, path, forced]) => path === '/p' && !forced)).toBe(true);
  });
});

describe('forced hazards', () => {
  it('give exactly the named hazards and nothing random', () => {
    const { h, log } = make({ profile: 'harsh' });
    const r = h.forRequest(signHazards(['swallowed-submit'], KEY), '/submit');
    if (r === 'bad-signature') throw new Error('unexpected');
    expect(r.forced).toBe(true);
    expect(r.on('swallowed-submit')).toBe(true);
    expect(r.on('js-error-fatal')).toBe(false);
    expect(r.latencyMs()).toBe(0);
    expect(log).toEqual([['swallowed-submit', '/submit', true]]);
  });

  it('an empty signed list means no hazards at all', () => {
    const r = make({ profile: 'harsh' }).h.forRequest(signHazards([], KEY), '/p');
    expect(r !== 'bad-signature' && r.on('promo')).toBe(false);
  });

  it('are refused with a wrong signature, an unknown name, or a bank not started forceable', () => {
    const { h } = make();
    expect(h.forRequest(signHazards(['promo'], 'x'.repeat(32)), '/p')).toBe('bad-signature');
    expect(h.forRequest('promo;00', '/p')).toBe('bad-signature');
    expect(h.forRequest(signHazards(['nonsense' as HazardName], KEY), '/p')).toBe('bad-signature');
    expect(make({ forceable: false }).h.forRequest(signHazards(['promo'], KEY), '/p')).toBe(
      'bad-signature',
    );
  });
});
