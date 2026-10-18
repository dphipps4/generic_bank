// Run 13's gate failed with "0 accounts match" although it read the right page. These are the
// postmortem's proofs, against bank 2's own wording ("Share ****8176-S01") and its review rows.
import { describe, expect, it } from 'vitest';
import { accountsIn, isAccount, readOf } from '../src/index.js';

const SUMMARY = [
  'Everyday Checking Share ****8176-S01 Available balance: $1,000.00 Current balance: $1,000.00',
  'Rainy Day Savings Share ****9433-S01 Available balance: $2,000.00 Current balance: $2,000.00',
  'Money Market Share ****8844-S01 Available balance: $3,000.00 Current balance: $3,000.00',
].join('\n');
const RUN13 = '{name} Share {last4} Available balance: {available} Current balance: {current}';

describe('an account read off a page', () => {
  it("matches run 13's read: the last four anywhere in the number as drawn", () => {
    const { all, matching } = accountsIn(SUMMARY, RUN13, '40017732', '8176');
    expect(all.map((g) => g.last4)).toEqual(['****8176-S01', '****9433-S01', '****8844-S01']);
    expect(matching.map((g) => g.name)).toEqual(['Everyday Checking']);
  });

  it('matches a read written with the last four as its own placeholder', () => {
    const read =
      '{name} Share ****{last4}-S01 Available balance: {available} Current balance: {current}';
    expect(accountsIn(SUMMARY, read, '40017732', '8176').matching.map((g) => g.name)).toEqual([
      'Everyday Checking',
    ]);
  });

  it('matches by name, ignoring case, and never by a part of another number', () => {
    expect(
      isAccount({ name: 'Everyday Checking', last4: '****8176-S01' }, 'everyday checking'),
    ).toBe(true);
    expect(isAccount({ name: 'Everyday Checking', last4: '****8176-S01' }, '9433')).toBe(false);
    expect(isAccount({ name: 'Everyday Checking', last4: '****8176-S01' }, '')).toBe(false);
  });

  it('leaves two matches for the caller to stop on', () => {
    const twice = `${SUMMARY}\nOld Checking Share ****8176-S02 Available balance: $0.00 Current balance: $0.00`;
    expect(accountsIn(twice, RUN13, '40017732', '8176').matching).toHaveLength(2);
  });
});

describe("a review read on bank 2's review rows", () => {
  const REVIEW = [
    'From:',
    'Everyday Checking, Share ****8176-S01',
    'To:',
    'Rainy Day Savings, Share ****9433-S01',
    'Amount:',
    '$1.00',
    'Memo:',
    'GBX 4CBE',
  ].join('\n');

  it("fails with run 13's stars written into it", () => {
    const run13 =
      'From:\n{from}, Share ********-S01\nTo:\n{to}, Share ********-S01\nAmount:\n{amount}\nMemo:\n{memo}';
    expect(readOf(run13).exec(REVIEW)).toBeNull();
  });

  it('reads all four values with whole values as placeholders', () => {
    const m = readOf('From:\n{from}\nTo:\n{to}\nAmount:\n{amount}\nMemo:\n{memo}').exec(REVIEW);
    expect(m?.groups).toEqual({
      from: 'Everyday Checking, Share ****8176-S01',
      to: 'Rainy Day Savings, Share ****9433-S01',
      amount: '$1.00',
      memo: 'GBX 4CBE',
    });
  });
});
