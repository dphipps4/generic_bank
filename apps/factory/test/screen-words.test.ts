// A screen's words are ones every visit shows: words holding this task's member, accounts or memo
// name only this task's page.
import { describe, expect, it } from 'vitest';
import { taskValuesIn } from '../src/scout.js';

const task = { member: '51239876', from: '4412', to: '7781', memo: 'GBX 1A2B' };

describe("a screen's words", () => {
  it("are refused when they hold the task's own values", () => {
    expect(
      taskValuesIn(
        ['Activity: Everyday Checking, Share ****4412-S01', 'Date', 'Description'],
        task,
      ),
    ).toEqual([['Activity: Everyday Checking, Share ****4412-S01', 'account']]);
    expect(taskValuesIn(['Member ████9876'], task)).toEqual([
      ['Member ████9876', "member's number"],
    ]);
    expect(taskValuesIn(['Memo: GBX 1A2B'], task)).toEqual([['Memo: GBX 1A2B', 'memo']]);
  });

  it('pass when every such page shows them', () => {
    expect(taskValuesIn(['Member Summary', 'Available balance:', 'Review transfer'], task)).toEqual(
      [],
    );
  });
});
