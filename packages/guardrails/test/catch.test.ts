import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

// Guard errors always propagate (plan, §J.2): the repository's own lint configuration fails code
// that catches one, as it would fail it in a driver or in the Runner.

const eslint = new ESLint({ cwd: fileURLToPath(new URL('../../..', import.meta.url)) });

const lint = async (body: string, where = 'packages/drivers/src/corelink/probe.ts') => {
  const code = `import { click, type Control, type Page } from '@gb/screen';
import { GuardError } from '@gb/guardrails';
export async function act(page: Page, c: Control) {
${body}
}
export const keep = GuardError;
`;
  const [r] = await eslint.lintText(code, { filePath: where });
  return r!.messages.filter((m) => m.ruleId === 'no-restricted-syntax').map((m) => m.message);
};

describe('catching a guard error', () => {
  it('fails lint when a catch handles the guard’s error by name', async () => {
    expect(
      await lint(`  try {
    await click(page, c);
  } catch (e) {
    if (e instanceof GuardError) return;
    throw e;
  }`),
    ).toEqual(['A guard error is never caught: it trips the guard and ends the run.']);
    expect(
      await lint(
        `  await click(page, c).catch((e) => { if (!(e instanceof GuardError)) throw e; });`,
        'apps/runner/src/probe.ts',
      ),
    ).toEqual(['A guard error is never caught: it trips the guard and ends the run.']);
  });

  it('fails lint when a catch around an action swallows what it threw', async () => {
    expect(
      await lint(`  try {
    await click(page, c);
  } catch {
    return;
  }`),
    ).toEqual([
      'A catch around an action rethrows what it does not handle: it may hold a guard error.',
    ]);
  });

  it('passes a catch that handles its own error and rethrows the rest', async () => {
    expect(
      await lint(`  try {
    await click(page, c);
  } catch (e) {
    if (e instanceof RangeError) return;
    throw e;
  }`),
    ).toEqual([]);
  });
});
