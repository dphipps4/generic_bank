// A factory run, start to recommendation (plan, §M.1): build mode onboards a bank, from its base
// profile, toward each of the product's three goals; repair mode starts from the open repair case,
// the profile of the version that faulted and the frames of the run where it stopped, toward the
// goal of the task that broke. Either way the Scout and the Supervisor walk the bank as it is now,
// every page a frame, and the run ends with the Supervisor's recommendation awaiting a person.
import { randomBytes } from 'node:crypto';
import { BASES, type Credentials } from '@gb/drivers';
import type { FrameStore } from '@gb/evidence';
import { openRepairCase, profileOf, type Sql } from '@gb/runs';
import type { Browser } from '@gb/screen';
import type { Agent, Conversation } from './agent.js';
import type { Role, Roles } from './models.js';
import { personCode } from './person.js';
import { recommend, type RepairOf } from './recommend.js';
import { scout } from './scout.js';
import { type Goal, GOALS, runGoal } from './supervisor.js';
import { framesOf, openTrail } from './trail.js';

export type Mode = 'build' | 'repair';

export interface FactoryDeps {
  sql: Sql;
  store: FrameStore;
  browser: Browser;
  /** The factory's address, where each role's gateway is: …/gateway/<run>/<role>. */
  factoryUrl: string;
  gatewayToken: string;
  roles: Roles;
  /** The staff service account; the Scout's tools type it, and no model sees it. */
  credentials: Credentials;
  /** Opens a person's code from the Console's inbox. */
  answerKey: string;
  /** The member whose accounts the goals are on. */
  member: string;
  log?: (line: string) => void;
}

/** The task a factory run serves: the one the hazard check and the outcome table cover. */
export const TASK = 'check-balance';
const BUILD_GOALS: Goal[] = ['check-balance', 'download-statements', 'transfer'];

export async function factoryRun(
  deps: FactoryDeps,
  o: { bank: string; mode: Mode; runId?: string },
): Promise<{ runId: string; recommendationId: string | null }> {
  const { sql, store } = deps;
  const log = deps.log ?? (() => undefined);
  const bank = (await sql.query<{ url: string }>('SELECT url FROM "Bank" WHERE id = $1', [o.bank]))
    .rows[0];
  if (!bank) throw new Error(`no bank ${o.bank} in the registry`);

  // What the run starts from: the bank's base, or the version that faulted and where it stopped.
  let base = BASES[o.bank] ?? null;
  let baseVersionId: string | null = null;
  let repair: RepairOf | undefined;
  if (o.mode === 'repair') {
    const c = await openRepairCase(sql, o.bank, TASK);
    if (!c?.versionId || !c.runId)
      throw new Error(`no open repair case for ${TASK} at ${o.bank}: nothing to repair`);
    baseVersionId = c.versionId;
    base = await profileOf(sql, c.versionId);
    if (base) repair = { profile: base, failing: await framesOf(sql, store, c.runId) };
  }
  if (!base) throw new Error(`no profile to start from at ${o.bank}`);

  const runId = o.runId ?? `${o.mode}-${o.bank}-${randomBytes(4).toString('hex')}`;
  await sql.query(
    `INSERT INTO "FactoryRun" (id, tenant, task, mode, phase, status, "baseVersionId")
     VALUES ($1, $2, $3, $4, 'SCOUT', 'running', $5)`,
    [runId, o.bank, TASK, o.mode, baseVersionId],
  );
  log(`factory run ${runId}: ${o.mode} at ${o.bank}`);
  const trail = await openTrail({ sql, store, runId, task: TASK, bank: o.bank, known: [] });
  const page = await deps.browser.newPage();
  const agent = (role: Role): Agent => ({
    model: deps.roles[role],
    url: `${deps.factoryUrl}/gateway/${runId}/${role}`,
    token: deps.gatewayToken,
  });
  const goals = o.mode === 'build' ? BUILD_GOALS : [TASK as Goal];
  try {
    const s = scout({
      page,
      start: bank.url,
      hosts: [new URL(bank.url).host],
      trail,
      credentials: deps.credentials,
      code: personCode({ sql, runId, bank: o.bank, answerKey: deps.answerKey }),
      never: base.words.submitTransfer,
      pictures: base.pictures,
    });
    let conversation: Conversation | undefined;
    for (const goal of goals) {
      log(`goal: ${goal}`);
      const r = await runGoal({
        scoutAgent: agent('scout'),
        supervisorAgent: agent('supervisor'),
        scout: s,
        trail,
        goal,
        member: deps.member,
        conversation,
      });
      conversation = r.conversation;
      log(`  ended: ${r.ended ?? 'without a word'}`);
    }
    await sql.query(
      `UPDATE "FactoryRun" SET phase = 'RECOMMEND', "lastActivityAt" = now() WHERE id = $1`,
      [runId],
    );
    const claims = await recommend({
      agent: agent('supervisor'),
      sql,
      trail,
      runId,
      bank: o.bank,
      goals: goals.map((g) => GOALS[g](deps.member)),
      repair,
    });
    const rec = (
      await sql.query<{ id: string }>(`SELECT id FROM "Recommendation" WHERE "factoryRunId" = $1`, [
        runId,
      ])
    ).rows[0];
    await sql.query(
      `UPDATE "FactoryRun" SET phase = 'REVIEW GATE', status = $2, "lastActivityAt" = now() WHERE id = $1`,
      [runId, claims ? 'review' : 'failed'],
    );
    log(
      claims
        ? `recommendation ${rec!.id}: ${claims.length} claims, awaiting a person`
        : 'no recommendation',
    );
    return { runId, recommendationId: rec?.id ?? null };
  } catch (e) {
    await sql.query(`UPDATE "FactoryRun" SET status = 'failed' WHERE id = $1`, [runId]);
    throw e;
  } finally {
    await page.close();
  }
}
