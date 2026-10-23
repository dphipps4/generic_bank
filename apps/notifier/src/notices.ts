// What the notifier tells Slack: a person's task opened, a run or a factory run that failed, and a
// route waiting for review. Each is told once (SlackNotice keeps what was posted), and only when it
// is recent, so a notifier started late does not post the past. Every notice links to the Console
// page where a person acts on it. Slack sees only what the Console's inbox shows: masked already.
import type { Sql } from '@gb/db';

export interface Links {
  /** The Console, as a person's browser reaches it. */
  console: string;
  /** The simulated staff inbox, where the banks' codes arrive. */
  inbox: string;
}

export interface Notice {
  ref: string;
  kind: string;
  text: string;
}

const RECENT = `now() - interval '1 hour'`;
const untold = (ref: string) => `NOT EXISTS (SELECT 1 FROM "SlackNotice" n WHERE n.ref = ${ref})`;

// Slack's own markup gives &, < and > a meaning; a value from a page shows as written.
const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
const link = (url: string, words: string) => `<${url}|${words}>`;
const dollars = (cents: number) =>
  (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

type Review = { from: string; to: string; amountCents: number; memo: string };

/** Everything the notifier has not told Slack yet, oldest first. */
export async function pending(sql: Sql, links: Links): Promise<Notice[]> {
  const out: Notice[] = [];

  const tasks = await sql.query<{
    id: string;
    kind: string;
    runId: string;
    task: string | null;
    brand: string | null;
    context: { bank?: string; review?: Review } | null;
  }>(
    `SELECT h.id, h.kind::text AS kind, h."runId", r.task, b.brand, h."contextMasked" AS context
       FROM "HumanTask" h
       LEFT JOIN "TaskRun" r ON r.id = h."runId"
       LEFT JOIN "Bank" b ON b.id = COALESCE(r.bank, h."contextMasked"->>'bank')
      WHERE h.status = 'open' AND h."openedAt" > ${RECENT} AND ${untold('h.id')}
      ORDER BY h."openedAt"`,
  );
  for (const t of tasks.rows) {
    const bank = esc(t.brand ?? t.context?.bank ?? 'A bank');
    const inbox = link(`${links.console}/inbox`, "Open the Console's Inbox");
    const run = link(`${links.console}/runs/${t.runId}`, 'Open the run and its frames');
    const r = t.context?.review;
    const text =
      t.kind === 'approval' && r
        ? `*A transfer waits for approval.* ${bank}: ${dollars(r.amountCents)} from ${esc(r.from)} to ${esc(r.to)}, memo "${esc(r.memo)}". ${inbox}`
        : t.kind === 'staff_code'
          ? `*${bank} wants a sign-in code.* It's in the ${link(links.inbox, 'simulated inbox')}. ${inbox}`
          : t.kind === 'supervisor_code'
            ? `*${bank} wants a supervisor's code.* ${inbox}`
            : `*A run needs a person:* ${esc(t.task ?? 'a task')} at ${bank}. ${run}`;
    out.push({ ref: t.id, kind: t.kind, text });
  }

  const runs = await sql.query<{
    id: string;
    task: string;
    brand: string | null;
    bank: string;
    code: string | null;
  }>(
    `SELECT r.id, r.task, b.brand, r.bank, r."resultCode" AS code
       FROM "TaskRun" r LEFT JOIN "Bank" b ON b.id = r.bank
      WHERE r.status = 'failed' AND r."settledAt" > ${RECENT} AND ${untold('r.id')}
      ORDER BY r."settledAt"`,
  );
  for (const r of runs.rows)
    out.push({
      ref: r.id,
      kind: 'run_failed',
      text: `*A run failed:* ${esc(r.task)} at ${esc(r.brand ?? r.bank)} ended \`${esc(r.code ?? 'failed')}\`. ${link(`${links.console}/runs/${r.id}`, 'Open the run and its frames')}`,
    });

  const factory = await sql.query<{ id: string; tenant: string; brand: string | null }>(
    `SELECT f.id, f.tenant, b.brand
       FROM "FactoryRun" f LEFT JOIN "Bank" b ON b.id = f.tenant
      WHERE f.status = 'failed' AND f."lastActivityAt" > ${RECENT} AND ${untold('f.id')}
      ORDER BY f."lastActivityAt"`,
  );
  for (const f of factory.rows)
    out.push({
      ref: f.id,
      kind: 'factory_failed',
      text: `*A factory run failed* at ${esc(f.brand ?? f.tenant)}. ${link(`${links.console}/dashboard`, 'Open the Console')}`,
    });

  const routes = await sql.query<{ id: string; tenant: string; brand: string | null }>(
    `SELECT c.id, c.tenant, b.brand
       FROM "Recommendation" c LEFT JOIN "Bank" b ON b.id = c.tenant
      WHERE c.status = 'open' AND c."createdAt" > ${RECENT} AND ${untold('c.id')}
      ORDER BY c."createdAt"`,
  );
  for (const c of routes.rows)
    out.push({
      ref: c.id,
      kind: 'route_to_review',
      text: `*A route for ${esc(c.brand ?? c.tenant)} waits for review.* ${link(`${links.console}/recommendations`, 'Open Recommendations')}`,
    });

  return out;
}

/** Keep what was posted, so it is told once, and its thread can be found again. */
export async function told(sql: Sql, n: Notice, channel: string, ts: string): Promise<void> {
  await sql.query(
    `INSERT INTO "SlackNotice" (ref, kind, channel, ts) VALUES ($1, $2, $3, $4) ON CONFLICT (ref) DO NOTHING`,
    [n.ref, n.kind, channel, ts],
  );
}
