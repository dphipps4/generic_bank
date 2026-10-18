// The context a model is shown stays the same size however long the run, and a verdict is read
// wherever the Supervisor gave it.
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { describe, expect, it } from 'vitest';
import { compacted } from '../src/agent.js';
import { findJudgment } from '../src/supervisor.js';

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
