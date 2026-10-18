// Run 13's failures, as the postmortem found them, each made impossible: a read is written from the
// page's own lines where the Scout points, a lesson about our masking is refused, and the context a
// model is shown stays the same size however long the run.
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { maskText } from '@gb/runtime';
import { describe, expect, it } from 'vitest';
import { compacted } from '../src/agent.js';
import { aboutMasking } from '../src/memory.js';
import { pointed } from '../src/scout.js';
import { findJudgment } from '../src/supervisor.js';

/** Bank 2's lines as the crawler reads them, unmasked (tenants.ts, console.ts, transfer.ts). */
const SUMMARY = [
  'Member Summary',
  'Everyday Checking Share ****8176-S01 Available balance: $1,000.00 Current balance: $1,000.00',
  'Rainy Day Savings Share ****9433-S01 Available balance: $2,000.00 Current balance: $2,000.00',
];
const REVIEW = [
  'Review transfer',
  'From:',
  'Everyday Checking, Share ****8176-S01',
  'To:',
  'Rainy Day Savings, Share ****9433-S01',
  'Amount:',
  '$1.00',
  'Memo:',
  'GBX 4CBE',
];
const TASK = { member: '40017732', from: '8176' };
const shown = (lines: string[]) => lines.map((l) => maskText(l));

describe('a read written where the Scout points', () => {
  it("is run 13's balance read, with the account's own wording kept", () => {
    const read = pointed(
      'balance',
      [
        { placeholder: 'name', is: 'Everyday Checking' },
        { placeholder: 'available', after: 'Available balance:' },
        { placeholder: 'current', after: 'Current balance:' },
      ],
      SUMMARY,
      shown(SUMMARY),
      TASK,
    );
    expect(read).toBe(
      '{name} Share ****{last4}-S01 Available balance: {available} Current balance: {current}',
    );
  });

  it('is the review read run 13 took four tries to find, from labels alone', () => {
    const read = pointed(
      'review',
      [
        { placeholder: 'from', after: 'From:' },
        { placeholder: 'to', after: 'To:' },
        { placeholder: 'amount', after: 'Amount:' },
        { placeholder: 'memo', after: 'Memo:' },
      ],
      REVIEW,
      shown(REVIEW),
      TASK,
    );
    expect(read).toBe('From:\n{from}\nTo:\n{to}\nAmount:\n{amount}\nMemo:\n{memo}');
  });

  it("puts $member where the member's number shows", () => {
    const lines = ['Member 40017732 · J. Doe'];
    expect(
      pointed('name', [{ placeholder: 'name', is: 'J. Doe' }], lines, shown(lines), TASK),
    ).toBe('Member $member · {name}');
  });
});

describe('a lesson', () => {
  it('about hidden values is refused: run 12 taught our masking as the bank', () => {
    expect(
      aboutMasking(
        'This tenant redacts member numbers, share numbers and balances into asterisk masks.',
      ),
    ).not.toBeNull();
    expect(aboutMasking('Accounts show as ████7732.')).not.toBeNull();
    expect(aboutMasking('Second-factor screens follow the sign-in.')).toBeNull();
  });
});

describe("a model's context", () => {
  const result = (n: number): AgentMessage =>
    ({
      role: 'toolResult',
      toolCallId: `t${n}`,
      toolName: 'browser_look',
      content: [
        { type: 'image', data: 'x'.repeat(5_000), mimeType: 'image/png' },
        { type: 'text', text: `looked ${n}.\n${'{"words":[]}'.repeat(200)}` },
      ],
      isError: false,
      timestamp: n,
    }) as unknown as AgentMessage;
  const size = (m: AgentMessage[]) => JSON.stringify(m).length;

  it('keeps the latest results whole and the older ones in a line, so it stops growing', () => {
    const at10 = compacted(
      Array.from({ length: 10 }, (_, n) => result(n)),
      4,
    );
    const at40 = compacted(
      Array.from({ length: 40 }, (_, n) => result(n)),
      4,
    );
    expect(JSON.stringify(at40.at(-1))).toContain('x'.repeat(5_000));
    expect(JSON.stringify(at40[0])).toContain('older result, shortened');
    // Thirty more results add only their first lines.
    expect(size(at40) - size(at10)).toBeLessThan(30 * 200);
  });
});

describe("the Supervisor's verdict", () => {
  it("is read from its thinking when its answer is prose, as run 14's was", () => {
    const thinking =
      '{ "verdict": "continue", "says": "f1 is the sign-in screen.", "extendSeconds": 0 } ``` Wait, but the Scout {was refused}.';
    expect(findJudgment('Verdict: continue. f1 shows the sign-in', thinking)).toEqual({
      verdict: 'continue',
      says: 'f1 is the sign-in screen.',
      extendSeconds: 0,
    });
  });
  it('takes the last whole verdict, and still says why when there is none', () => {
    const two = '{"verdict":"wait","says":"a"} then {"verdict":"continue","says":"b"}';
    expect(findJudgment('prose', two)).toMatchObject({ verdict: 'continue', says: 'b' });
    expect(findJudgment('prose', 'no verdict here')).toBe('the answer is not JSON');
  });
});

describe('reads, after runs 14 and 15', () => {
  it("anchors a name read on the member's number, a line or two above", () => {
    const lines = ['Member', 'Name', 'Status', '40017732', 'J. Doe', 'Active'];
    expect(
      pointed('name', [{ placeholder: 'name', is: 'J. Doe' }], lines, shown(lines), TASK),
    ).toBe('$member\n{name}');
  });

  it('says which two values overlap, and on which line', () => {
    expect(() =>
      pointed(
        'balance',
        [
          { placeholder: 'name', after: 'Everyday Checking' },
          { placeholder: 'last4', after: 'Share ****' },
          { placeholder: 'available', after: 'Available balance:' },
          { placeholder: 'current', after: 'Current balance:' },
        ],
        SUMMARY,
        shown(SUMMARY),
        TASK,
      ),
    ).toThrow(/\{last4\} overlaps \{name\} on the line "Everyday Checking Share \*\*\*\*8176-S01/);
  });
});
