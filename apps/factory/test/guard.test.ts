// A route the factory writes speaks the guard's words, or the guard refuses it in service: each
// screen's kind, and the guard's name for each control the bank draws with other words.
import { bank1, type Table } from '@gb/crawler';
import { describe, expect, it } from 'vitest';
import { refusals, SCREEN_KINDS } from '../src/guard.js';

/** A learned route in the Scout's own words: screens without a kind, controls by their drawn names. */
const learned = (): Table => ({
  bank: 'test',
  home: '',
  rows: [
    {
      page: 'entry',
      shows: ['Staff entry'],
      do: {
        balance: [
          { type: 'Staff name', value: '$operator' },
          { type: 'Secret word', value: '$password' },
          { press: 'Go' },
        ],
      },
      frame: 'f1',
    },
    { page: 'totals', shows: ['Totals'], do: {}, frame: 'f2' },
  ],
  ends: { balance: 'totals', transfer: 'totals', history: 'totals' },
  answers: [],
  trouble: [],
  submit: { press: 'Send', frame: 'f2' },
  reads: { balance: '{name} {last4} {available} {current}', review: '{from}', name: [] },
});

describe("a learned route, against the guard's words", () => {
  it('is refused in service when its screens have no kind', () => {
    expect(refusals(learned(), ['balance'])).toEqual([
      { goal: 'balance', page: 'entry', rule: 'check-balance does not type "Staff name" on entry' },
      {
        goal: 'balance',
        page: 'entry',
        rule: 'check-balance does not type "Secret word" on entry',
      },
      { goal: 'balance', page: 'entry', rule: 'check-balance does not press "Go" on entry' },
      { goal: 'balance', page: 'totals', rule: 'check-balance does not read "Page" on totals' },
    ]);
  });

  it("passes once each screen has its kind and each control the guard's name", () => {
    const t = learned();
    t.rows[0]!.screen = 'sign_in';
    t.rows[1]!.screen = 'member.summary';
    t.names = { 'Operator ID': ['Staff name'], Password: ['Secret word'], 'Sign In': ['Go'] };
    expect(refusals(t, ['balance'])).toEqual([]);
  });

  it("holds for bank 1's own route, every goal", () => {
    expect(refusals(bank1)).toEqual([]);
  });

  it('offers every kind of screen the allowlists name', () => {
    expect(SCREEN_KINDS).toEqual(
      expect.arrayContaining(['sign_in', 'member.summary', 'transfer.review']),
    );
    expect(SCREEN_KINDS).not.toContain('any');
  });
});
