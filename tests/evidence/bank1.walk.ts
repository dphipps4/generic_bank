// The arrow's first prompt: walk bank 1 as a teller would, seeing first and then clicking, and keep
// every page. The steps are in bank1.json, one scenario at a time (WALK=<name>), written as the
// pages showed the way. Each step's frame is kept masked under docs/evidence/bank-1/<scenario>/.
// The crawler never imports this file or the bank: the evidence is what it is written from.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { afterAll, beforeAll, it } from 'vitest';
import type { HazardName } from '../../apps/bank/src/hazards.js';
import { MEMBERS, OPERATORS } from '../../apps/bank/src/seed.js';
import {
  choose,
  type Frame,
  launch,
  newPage,
  press,
  see,
  type,
} from '../../packages/runtime/src/index.js';
import { type LiveBank, liveBank, PASSWORDS } from '../support/banks.js';

type Step =
  | { open: string }
  | { type: string; value: string }
  | { press: string; near?: string }
  | { choose: string; containing: string }
  | { see: true };
interface Scenario {
  hazards?: HazardName[];
  steps: Step[];
}

const ROOT = join(import.meta.dirname, '../..');
const SCENARIOS = JSON.parse(
  readFileSync(join(import.meta.dirname, 'bank1.json'), 'utf8'),
) as Record<string, Scenario>;
const name = process.env.WALK ?? 'happy';
const scenario = SCENARIOS[name];
if (!scenario) throw new Error(`no scenario ${name}: one of ${Object.keys(SCENARIOS).join(', ')}`);

let bank: LiveBank;
let browser: Browser;
beforeAll(async () => {
  [bank, browser] = await Promise.all([liveBank('generic'), launch()]);
});
afterAll(async () => {
  await browser?.close();
  await bank?.close();
});

/** What a teller is given, never read off a page: the sign-in, the code from their phone, the member. */
async function value(v: string): Promise<string> {
  if (v === '$operator') return OPERATORS.service.id;
  if (v === '$password') return PASSWORDS.service;
  if (v === '$code')
    return (await bank.admin<{ code: string }>(`/operators/${OPERATORS.service.id}/code`)).code;
  if (v.startsWith('$member.')) return MEMBERS[v.slice(8) as keyof typeof MEMBERS];
  return v;
}

/** Every seeded name and secret, so none lands in the evidence. */
async function known(): Promise<string[]> {
  const m = await bank.db.query<{ first: string; last: string }>(
    'SELECT first_name AS first, last_name AS last FROM members',
  );
  return [
    OPERATORS.service.id,
    OPERATORS.supervisor.id,
    PASSWORDS.service,
    PASSWORDS.supervisor,
    ...m.rows.flatMap((r) => [
      `${r.first} ${r.last}`,
      `${r.first[0]}. ${r.last}`,
      `${r.last}, ${r.first}`,
    ]),
  ];
}

it(`walks bank 1: ${name}`, async () => {
  // One file per walk (<name>.json) holds every frame; the pictures sit in a folder beside it.
  const base = join(ROOT, 'docs/evidence/bank-1');
  const out = join(base, name);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const hide = await known();
  const page: Page = await newPage(
    browser,
    scenario.hazards ? { headers: bank.forced(scenario.hazards) } : {},
  );
  const frames: Record<string, unknown>[] = [];
  let stopped: string | undefined;
  // A page the happy walk already kept at the same step, word for word, is kept once: here, a
  // pointer to it.
  const happy = existsSync(join(base, 'happy.json'))
    ? (JSON.parse(readFileSync(join(base, 'happy.json'), 'utf8')) as {
        frames: { frame: string; did: string; tree?: string }[];
      })
    : { frames: [] };
  const keep = async (did: string, f: Frame) => {
    const frame = String(frames.length + 1).padStart(2, '0');
    const { picture: _, ...rest } = f;
    const twin = happy.frames.find((h) => h.frame === frame);
    if (name !== 'happy' && !f.dialogs.length && twin?.did === did && twin.tree === f.tree) {
      frames.push({ frame, did, same: `happy/${frame}` });
      return;
    }
    writeFileSync(join(out, `${frame}.png`), f.picture);
    frames.push({ frame, picture: `${name}/${frame}.png`, did, ...rest });
  };
  for (const s of scenario.steps) {
    let did = '';
    try {
      if ('open' in s) {
        await page.goto(new URL(s.open, bank.url).href);
        did = `open ${s.open}`;
      } else if ('type' in s) {
        await type(page, s.type, await value(s.value));
        did = `type ${s.value.startsWith('$') ? s.value : 'text'} into "${s.type}"`;
      } else if ('choose' in s) {
        await choose(page, s.choose, s.containing);
        did = `choose "${s.containing}" in "${s.choose}"`;
      } else if ('press' in s) {
        await press(page, s.press, s.near ? { near: s.near } : {});
        did = `press "${s.press}"${s.near ? ` near "${s.near}"` : ''}`;
      } else did = 'look';
      await keep(did, await see(page, { known: hide, limitMs: 60_000 }));
    } catch (e) {
      // Where a step could not be done is evidence too: what the page showed instead.
      stopped = `${did || JSON.stringify(s)}: ${(e as Error).message.split('\n')[0]}`;
      const after = await see(page, { known: hide, limitMs: 30_000 }).catch(() => null);
      if (after) await keep(`after: ${(e as Error).message.split('\n')[0]}`, after);
      break;
    }
  }
  const walk = { walk: name, frames, ...(stopped && { stopped }) };
  writeFileSync(join(base, `${name}.json`), `${JSON.stringify(walk, null, 1)}\n`);
});
