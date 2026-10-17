// The recommendation: each claim cites frames of this run and is marked seen or guess; the
// recommend tool refuses a claim with no frame, a frame that is not this run's, and a claim marked
// seen that its frames do not show, and keeps the rest with the run. The Supervisor's model is a
// fake fetch behind the real gateway; no request leaves the process.
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { controlDb } from '../../../packages/oauth/test/control.js';
import { gateway } from '../src/gateway.js';
import { sqlLedger } from '../src/ledger.js';
import { PRICES } from '../src/models.js';
import { DEFAULT_ROLES } from './fakes.js';
import { type Claim, recommend, recommendTool } from '../src/recommend.js';
import { buildServer } from '../src/server.js';
import { ToolRefusal } from '../src/tools.js';
import type { Shown, Trail } from '../src/trail.js';
import { live } from '../src/upstream.js';
import { fakeModels, type Reply, type Seen } from './fakes.js';

const TOKEN = 'k'.repeat(40);

// The run's two frames: the sign-in page and the console's home.
const FRAMES: Record<string, Shown> = {
  f1: {
    page: 'bank/corelink/',
    title: 'CoreLink',
    controls: ['Operator ID', 'Password', 'Sign In'],
    texts: ['Sign in to CoreLink Branch Console'],
  },
  f2: {
    page: 'bank/corelink/home',
    title: 'CoreLink',
    controls: ['Member Search', 'Sign out'],
    texts: ['Select a menu to begin'],
  },
};

let db: Awaited<ReturnType<typeof controlDb>>;
let steps: { name: string; action?: string; outcome?: string }[];
const trail: Trail = {
  policy: { known: [] },
  step: async (s) => {
    steps.push(s);
    return null;
  },
  has: (ref) => ref in FRAMES,
  shown: async (ref) => FRAMES[ref] ?? null,
};

beforeEach(async () => {
  db = await controlDb();
  steps = [];
  await db.query(
    `INSERT INTO "FactoryRun" (id, tenant, task, mode, phase, status)
     VALUES ('run1', 'bank2', 'check-balance', 'build', 'SCOUT', 'running')`,
  );
});
afterEach(async () => {
  await db.close();
});

const seen = (about: string, value: string, frames: string[]): Claim => ({
  about,
  value,
  basis: 'seen',
  frames,
});
const SIGN_IN = seen('words.signIn', 'Sign In', ['f1']);
const SEARCH = seen('words.memberSearch', 'Member Search', ['f2']);
const GUESS: Claim = {
  about: 'refusals.insufficient_funds',
  value: 'The amount is more than the available balance.',
  basis: 'guess',
  frames: ['f2'],
};

const tool = () => recommendTool({ sql: db, trail, runId: 'run1', bank: 'bank2' });
const kept = async () =>
  (
    await db.query<{ claims: Claim[]; status: string }>(
      'SELECT claims, status FROM "Recommendation"',
    )
  ).rows;

describe('the recommend tool', () => {
  it('refuses a claim with no frame, or with a frame that is not this run’s, and keeps nothing', async () => {
    for (const [claim, why] of [
      [{ ...SIGN_IN, frames: [] }, /claim 2 \(words\.signIn\) cites no frame/],
      [
        { ...SIGN_IN, frames: ['f9'] },
        /claim 2 \(words\.signIn\) cites f9, which is not a frame of this run/,
      ],
      [{ ...GUESS, frames: [] }, /claim 2 \(refusals\.insufficient_funds\) cites no frame/],
    ] as const) {
      const run = tool().run({ claims: [SEARCH, claim] });
      await expect(run).rejects.toThrow(ToolRefusal);
      await expect(tool().run({ claims: [SEARCH, claim] })).rejects.toThrow(why);
    }
    expect(await kept()).toEqual([]);
    expect(steps.every((s) => s.name === 'recommend' && s.action === 'refused')).toBe(true);
  });

  it('refuses a claim marked seen that its frames do not show, or about no part of a profile', async () => {
    await expect(
      tool().run({ claims: [seen('words.signIn', 'Sign In', ['f1', 'f2'])] }),
    ).rejects.toThrow(
      /marked seen, but f2 does not show "Sign In": cite the frames that show it, or mark it a guess/,
    );
    await expect(
      tool().run({ claims: [seen('words.colorScheme', 'Sign In', ['f1'])] }),
    ).rejects.toThrow(/is not about a part of the site's profile/);
    expect(await kept()).toEqual([]);
  });

  it('keeps a recommendation whose claims stand, a guess as a guess, with the run', async () => {
    const r = await tool().run({
      claims: [SIGN_IN, SEARCH, seen('screens.console.home', 'to begin', ['f2']), GUESS],
    });
    expect(r.text).toBe(
      'Recommended, 4 claims: 3 seen, 1 guessed. A person reviews it with the frames.',
    );
    const [rec] = await kept();
    expect(rec!.status).toBe('open');
    expect(rec!.claims.map((c) => c.basis)).toEqual(['seen', 'seen', 'seen', 'guess']);
    // A new draft replaces it until someone decides it, and not after.
    await tool().run({ claims: [SIGN_IN] });
    expect((await kept())[0]!.claims).toEqual([SIGN_IN]);
    await db.query(`UPDATE "Recommendation" SET status = 'approved'`);
    await expect(tool().run({ claims: [SEARCH] })).rejects.toThrow(/already decided/);
    expect((await kept())[0]!.claims).toEqual([SIGN_IN]);
  });
});

describe('the Supervisor recommending', () => {
  let dir: string;
  let app: ReturnType<typeof buildServer>;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gb-recommend-'));
  });
  afterEach(async () => {
    await app?.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('drafts from the run’s frames, is refused a claim with no frame, and corrects it', async () => {
    const asked: Seen[] = [];
    const replies: Reply[] = [
      { tool: 'recommend', input: { claims: [SIGN_IN, { ...GUESS, frames: [] }] } },
      { tool: 'recommend', input: { claims: [SIGN_IN, SEARCH, GUESS] } },
      { text: 'Recommended.' },
    ];
    app = buildServer({
      gateway: gateway({
        ledger: sqlLedger(db),
        upstream: live(
          fakeModels((_p, r) => {
            asked.push(r);
            return replies.shift()!;
          }),
          dir,
        ),
        prices: PRICES,
      }),
      token: TOKEN,
      mode: 'live',
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const { port } = app.server.address() as AddressInfo;
    const claims = await recommend({
      agent: {
        model: DEFAULT_ROLES.supervisor,
        url: `http://127.0.0.1:${port}/gateway/run1/supervisor`,
        token: TOKEN,
      },
      sql: db,
      trail,
      runId: 'run1',
      bank: 'bank2',
      goals: ['Reach the balance.'],
    });
    expect(claims).toEqual([SIGN_IN, SEARCH, GUESS]);
    // It was shown every frame of the run, and told why its first draft was refused.
    const said = (asked[0]!.items[0] as { user: string }).user;
    expect(said).toContain(`f1: ${JSON.stringify(FRAMES.f1)}`);
    expect(said).toContain(`f2: ${JSON.stringify(FRAMES.f2)}`);
    expect(asked[1]!.items.at(-1)).toEqual({
      result: expect.stringMatching(/claim 2 \(refusals\.insufficient_funds\) cites no frame/),
    });
    expect(steps.map((s) => s.action)).toEqual(['refused', 'recommended']);
  });
});
