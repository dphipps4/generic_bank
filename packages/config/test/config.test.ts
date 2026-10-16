import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ConfigError, loadConfig, secret } from '../src/index.js';

const shape = { A_SECRET: secret(), B_SECRET: secret(), NAME: z.string().min(1) };
const long = (c: string) => c.repeat(32);

describe('loadConfig', () => {
  it('accepts a complete, distinct configuration', () => {
    const cfg = loadConfig(shape, { A_SECRET: long('a'), B_SECRET: long('b'), NAME: 'x' }, [
      'A_SECRET',
      'B_SECRET',
    ]);
    expect(cfg.NAME).toBe('x');
  });

  it('fails closed on a missing variable', () => {
    expect(() => loadConfig(shape, { A_SECRET: long('a'), B_SECRET: long('b') })).toThrow(
      ConfigError,
    );
  });

  it('refuses a short secret', () => {
    expect(() => loadConfig(shape, { A_SECRET: 'short', B_SECRET: long('b'), NAME: 'x' })).toThrow(
      /at least 32/,
    );
  });

  it('refuses two secrets with the same value', () => {
    expect(() =>
      loadConfig(shape, { A_SECRET: long('a'), B_SECRET: long('a'), NAME: 'x' }, [
        'A_SECRET',
        'B_SECRET',
      ]),
    ).toThrow(/must differ/);
  });

  it('lets two optional secrets both be blank', () => {
    const optional = { A_KEY: z.string().optional(), B_KEY: z.string().optional() };
    const cfg = loadConfig(optional, { A_KEY: '', B_KEY: '' }, ['A_KEY', 'B_KEY']);
    expect(cfg).toEqual({ A_KEY: '', B_KEY: '' });
  });
});
