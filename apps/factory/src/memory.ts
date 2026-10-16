// Memory, as the factory reads and writes it (plan §K.4, §M.4): the knowledge pack a run starts
// from, `memory_query` for both roles, `record_lesson` for the Supervisor, and, at the run's end,
// its lessons sent as proposals with what it relied on and contradicted. The factory only
// proposes; memory's own rules decide what a lesson becomes. Every write is signed with a key only
// this code holds: no model sees it, or the factory's token.
import { createHash, createHmac } from 'node:crypto';
import type { Sql } from '@gb/runs';
import { z } from 'zod';
import { type Agent, turn } from './agent.js';
import { type Tool, ToolRefusal, toolsOf } from './tools.js';
import type { Trail } from './trail.js';

/** Where a run is: its bank, and the product the bank runs. */
export interface At {
  bank: string;
  vendor: string | null;
}

/** The knowledge pack, as memory serves it: lessons, facts and episodes in tiers, best first. */
export interface Pack {
  bank: string;
  vendor: string | null;
  budget: number;
  size: number;
  tiers: Record<string, Record<string, unknown>[]>;
  omitted: Record<string, number>;
}

/** The pack's size, in characters of JSON: the Supervisor reads it with every step. */
export const PACK_BUDGET = 12_000;

/** What memory answers to a write: its status, and its body. */
export interface Written {
  status: number;
  body: { error?: string; reason?: string; message?: string } & Record<string, unknown>;
}

const sign = (key: string, path: string, body: string) =>
  createHmac('sha256', key).update(`POST ${path}\n${body}`).digest('hex');

export function memoryClient(o: { url: string; token: string; signingKey: string }) {
  const auth = { authorization: `Bearer ${o.token}` };
  async function get<T>(path: string, query: Record<string, string | number | null | undefined>) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) q.set(k, `${v}`);
    const r = await fetch(`${o.url}${path}?${q}`, {
      headers: auth,
      signal: AbortSignal.timeout(30_000),
    });
    if (!r.ok) throw new Error(`memory answered ${r.status} for ${path}`);
    return (await r.json()) as T;
  }
  return {
    pack: (at: At, q: string) =>
      get<Pack>('/knowledge/pack', { bank: at.bank, vendor: at.vendor, q, budget: PACK_BUDGET }),
    query: (at: At, q: string) =>
      get<{ items: Record<string, unknown>[]; facts: unknown[] }>('/knowledge/query', {
        bank: at.bank,
        vendor: at.vendor,
        q,
      }),
    async write(write: string, body: unknown): Promise<Written> {
      const path = `/${write}`;
      const payload = JSON.stringify(body);
      const r = await fetch(`${o.url}${path}`, {
        method: 'POST',
        headers: {
          ...auth,
          'content-type': 'application/json',
          'x-memory-signature': sign(o.signingKey, path, payload),
        },
        body: payload,
        signal: AbortSignal.timeout(30_000),
      });
      return { status: r.status, body: (await r.json().catch(() => ({}))) as Written['body'] };
    },
  };
}

export type Memory = ReturnType<typeof memoryClient>;

/** The product a bank runs, as memory names a vendor: `corelink` for "CoreLink 4.3". */
export async function vendorOf(sql: Sql, bank: string): Promise<string | null> {
  const r = await sql.query<{ vendor: string }>(
    `SELECT lower(split_part("productVersion", ' ', 1)) AS vendor FROM "Bank" WHERE id = $1`,
    [bank],
  );
  return r.rows[0]?.vendor || null;
}

/** The lessons a pack serves, by id. */
export function servedBy(pack: Pack): Map<string, string> {
  const out = new Map<string, string>();
  for (const items of Object.values(pack.tiers))
    for (const i of items)
      if (typeof i.id === 'string' && typeof i.text === 'string') out.set(i.id, i.text);
  return out;
}

/** `memory_query`: read-only, at most eight lessons and scenarios and three facts. A lesson it
 *  serves can be named as relied on or contradicted. */
export function memoryQueryTool(memory: Memory, at: At, served: Map<string, string>): Tool {
  const Input = z.object({
    question: z.string().trim().min(3).max(500).describe('What to ask, in a few words'),
  });
  return {
    name: 'memory_query',
    description:
      'Asks memory what the factory knows: at most eight lessons and scenarios, and three facts about this bank. Read-only.',
    input: Input,
    async run(input) {
      const { question } = Input.parse(input);
      try {
        const a = await memory.query(at, question);
        for (const i of a.items)
          if (i.kind === 'lesson' && typeof i.id === 'string') served.set(i.id, String(i.text));
        return { text: JSON.stringify(a) };
      } catch (e) {
        throw new ToolRefusal(`memory did not answer: ${(e as Error).message}`);
      }
    },
  };
}

/** The areas a lesson may be about: the seed's own. */
export const AREAS = [
  'sign-in',
  'navigation',
  'targeting',
  'rendering',
  'pacing',
  'session',
  'enumeration',
  'documents',
  'outcomes',
  'code',
  'safety',
  'evidence',
  'legacy-surface',
  'factory',
  'testing',
  'memory',
] as const;

/** The most lessons one run records. */
export const MAX_LESSONS = 5;

const sentences = (t: string) => t.split(/(?<=[.!?])\s+/).filter(Boolean).length;

export const Lesson = z.object({
  text: z
    .string()
    .trim()
    .min(1)
    .max(600)
    .refine((t) => sentences(t) <= 3, 'a lesson is one to three sentences')
    .describe(
      'The advice, in one to three sentences, stated generally: no names, numbers, codes or page data',
    ),
  area: z.enum(AREAS),
  scope: z
    .enum(['tenant', 'vendor', 'pattern'])
    .describe(
      'tenant: true of this bank; vendor: of every bank on its product; pattern: everywhere',
    ),
  confidence: z.enum(['low', 'medium', 'high']),
  basis: z
    .enum(['seen', 'guess'])
    .describe('seen: shown by the frames cited; guess: inferred from them'),
  frames: z
    .array(z.string())
    .max(20)
    .describe('The frames of this run that show it, such as f3; a lesson with none is refused'),
});
export type Lesson = z.infer<typeof Lesson>;

/** What is wrong with a lesson's frames, or null when each is a frame of this run. */
export function framesWrong(frames: string[], trail: Trail): string | null {
  if (!frames.length)
    return 'a lesson cites the frames of this run that show it, and this cites none';
  const foreign = frames.filter((f) => !trail.has(f));
  return foreign.length ? `${foreign.join(', ')} is not a frame of this run` : null;
}

/** `record_lesson`: the Supervisor's lesson, kept with the run until its end. */
export function recordLessonTool(trail: Trail, kept: Lesson[]): Tool {
  return {
    name: 'record_lesson',
    description:
      'Records one lesson of this run: one to three sentences of advice, its area and scope, a confidence, the frames of this run that show it, and whether it was seen there or is a guess. It goes to memory as a proposal when the run ends.',
    input: Lesson,
    async run(input) {
      const l = Lesson.parse(input);
      const wrong =
        framesWrong(l.frames, trail) ??
        (kept.length >= MAX_LESSONS ? `a run records at most ${MAX_LESSONS} lessons` : null);
      if (wrong) {
        await trail.step({ name: 'record_lesson', action: 'refused', outcome: wrong }, null);
        throw new ToolRefusal(`Refused, and nothing was kept: ${wrong}`);
      }
      kept.push(l);
      await trail.step(
        {
          name: 'record_lesson',
          action: 'recorded',
          outcome: `${l.basis}, ${l.confidence} confidence, ${l.scope} [${l.frames.join(', ')}]`,
        },
        null,
      );
      return { text: `Recorded lesson ${kept.length}. It goes to memory when the run ends.` };
    },
  };
}

const LESSONS = `You are the Supervisor, and the run at this bank has ended. Write down what it taught, for the factory's next runs at this bank and at banks like it.

Record each lesson with record_lesson: one to three sentences of advice, stated generally, with no names, numbers, codes or page data; its area; its scope (tenant: true of this bank; vendor: of every bank on the same product; pattern: everywhere); a confidence; the frames of this run that show it; and whether it was seen on them or is a guess. A lesson with no frame of this run is refused. Record only what the run taught.

Then answer with the lessons memory served that the run relied on, by id, and those it contradicted, each with why in one line and the frames of this run that show it.`;

const ANSWER_SCHEMA = {
  type: 'object',
  properties: {
    reliedOn: {
      type: 'array',
      items: { type: 'string' },
      description: 'The ids of served lessons the run relied on',
    },
    contradicted: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          lesson: { type: 'string', description: 'The id of a served lesson' },
          reason: { type: 'string', description: 'Why it does not hold here, in one line' },
          frames: { type: 'array', items: { type: 'string' } },
        },
        required: ['lesson', 'reason', 'frames'],
        additionalProperties: false,
      },
    },
  },
  required: ['reliedOn', 'contradicted'],
  additionalProperties: false,
};

const Answer = z.object({
  reliedOn: z.array(z.string()).max(100),
  contradicted: z
    .array(
      z.object({
        lesson: z.string(),
        reason: z
          .string()
          .trim()
          .min(1)
          .max(300)
          .refine((s) => !s.includes('\n')),
        frames: z.array(z.string()).max(20),
      }),
    )
    .max(20),
});

/** What a run taught, ready for memory. */
export interface Learned {
  lessons: Lesson[];
  reliedOn: string[];
  contradicted: { lesson: string; reason: string; frames: string[] }[];
}

/**
 * The LESSONS phase: the Supervisor records what the run taught with record_lesson, and names the
 * served lessons it relied on and contradicted. A name memory did not serve, or a contradiction
 * with no frame of this run, is dropped, and the trail says so.
 */
export async function writeLessons(o: {
  agent: Agent;
  memory: Memory;
  at: At;
  trail: Trail;
  /** How each goal ended, and the recommendation. */
  ended: string[];
  served: Map<string, string>;
}): Promise<Learned> {
  const frames: string[] = [];
  for (let i = 1; o.trail.has(`f${i}`); i++) {
    const s = await o.trail.shown(`f${i}`);
    if (s) frames.push(`f${i}: ${JSON.stringify(s)}`);
  }
  const lessons: Lesson[] = [];
  const said = await turn(o.agent, {
    system: LESSONS,
    say: [
      `How the run ended:\n${o.ended.map((e) => `- ${e}`).join('\n')}`,
      `Lessons memory served this run:\n${
        [...o.served].map(([id, text]) => `${id}: ${text}`).join('\n') || '(none)'
      }`,
      `Frames of this run, each as its page and the words on it:\n${frames.join('\n')}`,
    ].join('\n\n'),
    tools: toolsOf('lessons', [
      recordLessonTool(o.trail, lessons),
      memoryQueryTool(o.memory, o.at, o.served),
    ]),
    answer: ANSWER_SCHEMA,
    calls: MAX_LESSONS + 3,
    maxTokens: 16_000,
  });
  const learned: Learned = { lessons, reliedOn: [], contradicted: [] };
  let a: z.infer<typeof Answer> | null = null;
  try {
    const p = Answer.safeParse(JSON.parse(said.text));
    if (p.success) a = p.data;
  } catch {
    // An unreadable answer names nothing.
  }
  if (!a) {
    await o.trail.step(
      { name: 'lessons', action: 'unreadable', outcome: 'the answer names no lesson relied on' },
      null,
    );
    return learned;
  }
  const dropped: string[] = [];
  for (const id of new Set(a.reliedOn))
    if (o.served.has(id)) learned.reliedOn.push(id);
    else dropped.push(`${id}: memory did not serve it`);
  for (const c of a.contradicted) {
    const wrong = o.served.has(c.lesson)
      ? framesWrong(c.frames, o.trail)
      : 'memory did not serve it';
    if (wrong) dropped.push(`${c.lesson}: ${wrong}`);
    else learned.contradicted.push(c);
  }
  if (dropped.length)
    await o.trail.step({ name: 'lessons', action: 'dropped', outcome: dropped.join('; ') }, null);
  return learned;
}

/** A hash of what the cited frames show, as memory keeps with a citation. */
async function evidenceHash(trail: Trail, frames: string[]): Promise<string> {
  const shown = await Promise.all(frames.map((f) => trail.shown(f)));
  return createHash('sha256').update(JSON.stringify(shown)).digest('hex');
}

const why = (w: Written) =>
  [w.status, w.body.error, w.body.reason ?? w.body.message].filter(Boolean).join(' ');

/**
 * The run's episode, then its lessons as proposals, what it relied on, and each contradiction,
 * through memory's door as the factory. Returns what memory refused; a lesson memory refuses (its
 * privacy screen, say) is said on the trail and goes no further.
 */
export async function sendLearned(
  memory: Memory,
  trail: Trail,
  run: {
    id: string;
    at: At;
    task: string;
    /** The version this run's recommendation becomes, if a person approves it. */
    driver: string;
    outcome: string;
    startedAt: Date;
    model: string;
  },
  learned: Learned,
): Promise<string[]> {
  const refused: string[] = [];
  const note = async (action: string, w: Written) => {
    const ok = w.status < 300;
    if (!ok) refused.push(`${action}: ${why(w)}`);
    await trail.step({ name: 'memory', action, outcome: ok ? 'taken' : why(w) }, null);
  };
  const episode = await memory.write('episodes/runs', {
    id: run.id,
    kind: 'factory',
    bank: run.at.bank,
    ...(run.at.vendor ? { vendor: run.at.vendor } : {}),
    task: run.task,
    driver: run.driver,
    outcome: run.outcome,
    startedAt: run.startedAt,
    endedAt: new Date(),
    model: run.model,
  });
  if (!(episode.status < 300 || episode.body.error === 'run_exists')) {
    await note('the run', episode);
    return refused;
  }
  for (const l of learned.lessons)
    await note(
      'propose a lesson',
      await memory.write('lessons/proposals', {
        runId: run.id,
        text: l.text,
        area: l.area,
        scope: l.scope,
        confidence: l.confidence,
        seen: l.basis === 'seen',
        frames: l.frames,
        evidenceHash: await evidenceHash(trail, l.frames),
        model: run.model,
      }),
    );
  if (learned.reliedOn.length)
    await note(
      'relied on',
      await memory.write('lessons/relied-on', { runId: run.id, lessonIds: learned.reliedOn }),
    );
  for (const c of learned.contradicted)
    await note(
      'contradicts a lesson',
      await memory.write('facts/invalidate', {
        lessonId: c.lesson,
        runId: run.id,
        reason: c.reason,
        frames: c.frames,
        evidenceHash: await evidenceHash(trail, c.frames),
      }),
    );
  return refused;
}

/**
 * A promotion, as memory's rules read it: the version's clean probation runs, each a run of the
 * task by the promoted driver at its bank, the last marked promoted. Memory holds each run once, so
 * sending them again is harmless. Returns why memory did not take it, or null.
 */
export async function sendPromotion(
  memory: Memory,
  sql: Sql,
  v: { id: string; tenant: string; task: string },
  clean: number,
): Promise<string | null> {
  const runs = (
    await sql.query<{ id: string; at: Date }>(
      `SELECT id, at FROM "EvalResult" WHERE "driverVersionId" = $1 AND rung = 'E5'
        ORDER BY (details->>'n')::int DESC LIMIT $2`,
      [v.id, clean],
    )
  ).rows.reverse();
  const vendor = await vendorOf(sql, v.tenant);
  try {
    for (const [i, r] of runs.entries()) {
      const w = await memory.write('episodes/runs', {
        id: r.id,
        kind: 'task',
        bank: v.tenant,
        ...(vendor ? { vendor } : {}),
        task: v.task,
        driver: v.id,
        outcome: 'succeeded',
        ...(i === runs.length - 1 ? { mark: 'promoted' } : {}),
        startedAt: r.at,
      });
      if (w.status >= 300 && w.body.error !== 'run_exists') return why(w);
    }
    return null;
  } catch (e) {
    return `memory did not answer: ${(e as Error).message}`;
  }
}
