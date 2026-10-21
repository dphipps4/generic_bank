// A person is asked once for each code the bank sends: a route or a Scout that types the code twice
// on one page asks once.
import { describe, expect, it } from 'vitest';
import { oneCode } from '../src/index.js';

const asker = (...answers: (string | Error)[]) => {
  let asked = 0;
  return {
    ask: async () => {
      const a = answers[asked++] ?? 'none';
      if (a instanceof Error) throw a;
      return a;
    },
    asked: () => asked,
  };
};

describe('a code', () => {
  it('typed twice before a press is asked for once', async () => {
    const p = asker('123456');
    const c = oneCode(p.ask);
    expect(await c.code()).toBe('123456');
    expect(await c.code()).toBe('123456');
    expect(p.asked()).toBe(1);
  });

  it('asked for at once twice is asked for once', async () => {
    const p = asker('123456');
    const c = oneCode(p.ask);
    expect(await Promise.all([c.code(), c.code()])).toEqual(['123456', '123456']);
    expect(p.asked()).toBe(1);
  });

  it('after a press is asked for again: the bank may have sent another', async () => {
    const p = asker('123456', '654321');
    const c = oneCode(p.ask);
    await c.code();
    c.pressed();
    expect(await c.code()).toBe('654321');
    expect(p.asked()).toBe(2);
  });

  it('that was never given is asked for again', async () => {
    const p = asker(new Error('the person did not answer in time'), '123456');
    const c = oneCode(p.ask);
    await expect(c.code()).rejects.toThrow(/did not answer/);
    expect(await c.code()).toBe('123456');
    expect(p.asked()).toBe(2);
  });
});
