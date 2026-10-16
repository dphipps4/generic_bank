// The recommendation (plan, §M.4): once a run has reached its goals, the Supervisor drafts the
// bank's profile from the run's frames: the bank's words for each thing, the words that mark its
// screens, and its refusals. Every claim cites frames of this run and says whether it was seen on
// them or is a guess. A claim with no frame, or citing a frame that is not this run's, is refused,
// and so is a claim marked seen that is not on every frame it cites: a person approves this, and a
// guess taken for a fact could be costly. A guess is kept, and shown to that person as a guess.
import { randomBytes } from 'node:crypto';
import { CODES } from '@gb/contracts';
import { GENERIC_BANK } from '@gb/drivers';
import type { Sql } from '@gb/runs';
import { normalize } from '@gb/screen';
import { z } from 'zod';
import { type Agent, turn } from './agent.js';
import { type Tool, ToolRefusal } from './tools.js';
import type { Trail } from './trail.js';

const WORDS = Object.keys(GENERIC_BANK.words);
const REFUSALS = Object.keys(CODES.business_outcome);

/** What a claim can be about: a part of a bank's profile. */
const ABOUT = new RegExp(
  `^(words\\.(${WORDS.join('|')})|refusals\\.(${REFUSALS.join('|')})|screens\\.[a-z_]+(\\.[a-z_]+)*|statementsKept)$`,
);

export const Claim = z.object({
  about: z
    .string()
    .describe(
      `The part of the profile: words.<thing> (${WORDS.join(', ')}), screens.<screen> for words that mark a screen (screens.login.signin), refusals.<code> (${REFUSALS.join(', ')}), or statementsKept`,
    ),
  value: z.string().trim().min(1).max(300).describe('The bank’s own words, as they are on screen'),
  basis: z
    .enum(['seen', 'guess'])
    .describe(
      'seen: on every frame cited; guess: not on any frame, inferred from the frames cited',
    ),
  frames: z
    .array(z.string())
    .max(10)
    .describe(
      'The frames of this run it rests on, such as f3: those that show it, for a guess those it is inferred from',
    ),
});
export type Claim = z.infer<typeof Claim>;

const Input = z.object({ claims: z.array(Claim).min(1).max(80) });

const on = (value: string, s: { title: string; controls: string[]; texts: string[] }) => {
  const v = normalize(value);
  return [s.title, ...s.controls, ...s.texts].some((w) => normalize(w).includes(v));
};

/** What is wrong with each claim, against the run's frames; none when every claim stands. */
export async function check(claims: Claim[], trail: Trail): Promise<string[]> {
  const wrong: string[] = [];
  for (const [i, c] of claims.entries()) {
    const n = `claim ${i + 1} (${c.about})`;
    if (!ABOUT.test(c.about)) wrong.push(`${n} is not about a part of a bank's profile`);
    if (!c.frames.length) {
      wrong.push(`${n} cites no frame: every claim rests on frames of this run`);
      continue;
    }
    for (const ref of c.frames) {
      const s = await trail.shown(ref);
      if (!s) wrong.push(`${n} cites ${ref}, which is not a frame of this run`);
      else if (c.basis === 'seen' && !on(c.value, s))
        wrong.push(
          `${n} is marked seen, but ${ref} does not show "${c.value}": cite the frames that show it, or mark it a guess`,
        );
    }
  }
  return wrong;
}

/** The Supervisor's recommend tool: the claims checked against the run's frames, then stored with the run. */
export function recommendTool(o: { sql: Sql; trail: Trail; runId: string; bank: string }): Tool {
  return {
    name: 'recommend',
    description:
      'Recommends the bank’s profile, as claims, each citing the frames of this run it rests on and marked seen or guess. Refused, with the reasons, if any claim does not stand; then nothing is kept.',
    input: Input,
    async run(input) {
      const { claims } = Input.parse(input);
      const wrong = await check(claims, o.trail);
      if (wrong.length) {
        await o.trail.step(
          { name: 'recommend', action: 'refused', outcome: wrong.join('; ') },
          null,
        );
        throw new ToolRefusal(`Refused, and nothing was kept:\n${wrong.join('\n')}`);
      }
      // A new draft replaces the run's last while no one has decided it.
      const kept = await o.sql.query(
        `INSERT INTO "Recommendation" (id, "factoryRunId", tenant, claims) VALUES ($1, $2, $3, $4)
         ON CONFLICT ("factoryRunId") DO UPDATE SET claims = EXCLUDED.claims, "createdAt" = now()
          WHERE "Recommendation".status = 'open'
         RETURNING id`,
        [`rec_${randomBytes(8).toString('hex')}`, o.runId, o.bank, JSON.stringify(claims)],
      );
      if (!kept.rows.length) throw new ToolRefusal('this run’s recommendation is already decided');
      const guesses = claims.filter((c) => c.basis === 'guess').length;
      const said = `${claims.length} claims: ${claims.length - guesses} seen, ${guesses} guessed`;
      await o.trail.step({ name: 'recommend', action: 'recommended', outcome: said }, null);
      return { text: `Recommended, ${said}. A person reviews it with the frames.` };
    },
  };
}

const SYSTEM = `You are the Supervisor, and the Scout's run at this bank has reached its goals. Draft the bank's profile from the frames of the run, with the recommend tool.

Each claim is one thing about the bank in its own words, exactly as on screen: its word for a thing (its sign-in button, its member search, its transfer form's way to the review page, its statements), words that mark one of its screens, or its words when it refuses a transfer. Each cites the frames it rests on.

Mark a claim seen only when it is on every frame it cites. Anything no frame shows, such as a refusal the bank never made, is a guess: say so, and cite the frames it is inferred from. Never present a guess as seen: a person approves this profile, and a guess taken for a fact could be costly. A claim with no frame is refused.

Call recommend once with every claim. If it is refused, correct what it says and call it again.`;

/**
 * The Supervisor drafts the run's recommendation from its frames, through the recommend tool.
 * Returns the claims kept, or null when the Supervisor did not get one past the tool.
 */
export async function recommend(o: {
  agent: Agent;
  sql: Sql;
  trail: Trail;
  runId: string;
  bank: string;
  /** The goals the run reached. */
  goals: string[];
}): Promise<Claim[] | null> {
  const frames: string[] = [];
  for (let i = 1; o.trail.has(`f${i}`); i++) {
    const s = await o.trail.shown(`f${i}`);
    if (s) frames.push(`f${i}: ${JSON.stringify(s)}`);
  }
  await turn(o.agent, {
    system: SYSTEM,
    say: [
      `Goals reached:\n${o.goals.map((g) => `- ${g}`).join('\n')}`,
      `Frames of this run, each as its page and the words on it:\n${frames.join('\n')}`,
    ].join('\n\n'),
    tools: [recommendTool(o)],
    calls: 3,
    maxTokens: 16_000,
  });
  const r = await o.sql.query<{ claims: Claim[] }>(
    `SELECT claims FROM "Recommendation" WHERE "factoryRunId" = $1`,
    [o.runId],
  );
  return r.rows[0]?.claims ?? null;
}
