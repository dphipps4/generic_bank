// The hazard lab's door into the Task API (plan, §A.3): a task with the same input, scope and
// registry checks as POST /tasks/:name, started with hazards forced on its run. It is mounted only
// on a stack whose banks are forceable, and it is not in the agents' catalog: it is for people
// reproducing an error path, from the Console's hazard lab.
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { HAZARDS, problem, TASKS, type TaskName } from '@gb/contracts';
import { allows, type Sql } from '@gb/oauth';
import { createRun, resultOf } from '@gb/runs';
import { banks } from './catalog.js';
import { TASK_SCOPE } from './server.js';

const LabRun = z.object({
  task: z.enum(Object.keys(TASKS) as [TaskName, ...TaskName[]]),
  input: z.record(z.string(), z.unknown()),
  hazards: z.array(z.enum(HAZARDS)).max(HAZARDS.length),
});

const refuse = (reply: FastifyReply, p: ReturnType<typeof problem>) =>
  reply.code(p.status).type('application/problem+json').send(p);

export function labRoutes(
  app: FastifyInstance,
  opts: { sql: Sql; sealKey: string; enqueue: (runId: string) => Promise<void> },
) {
  app.post('/lab/runs', async (req, reply) => {
    const body = LabRun.safeParse(req.body);
    const input = body.success ? TASKS[body.data.task].safeParse(body.data.input) : null;
    if (!body.success || !input?.success) {
      const issues = body.success ? input!.error!.issues : body.error.issues;
      return reply
        .code(400)
        .type('application/problem+json')
        .send({
          ...problem(400, 'invalid_input', 'The lab run did not match its schema.'),
          fields: issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        });
    }
    const { task, hazards } = body.data;
    const data = input.data as Record<string, unknown> & { bank: string; idempotencyKey?: string };
    if (!allows(req.caller!, TASK_SCOPE[task], data.bank)) {
      return refuse(
        reply,
        problem(403, 'insufficient_scope', `This client may not use ${TASK_SCOPE[task]}.`),
      );
    }
    const bank = (await banks(opts.sql)).find((b) => b.id === data.bank);
    if (!bank?.tasks.some((t) => t.task === task)) {
      return refuse(
        reply,
        problem(
          404,
          bank ? 'task_not_available' : 'unknown_bank',
          bank
            ? `No promoted crawler serves ${task} on ${bank.id} yet.`
            : 'There is no bank by that id; GET /banks lists them.',
        ),
      );
    }
    const r = await createRun(
      opts.sql,
      {
        task,
        bank: data.bank,
        clientId: req.caller!.clientId,
        inputs: data,
        idempotencyKey: data.idempotencyKey,
        forcedHazards: [...new Set(hazards)],
      },
      opts.sealKey,
    );
    if (!r.existing) await opts.enqueue(r.runId);
    return reply
      .code(202)
      .header('location', `/tasks/${r.runId}`)
      .send(await resultOf(opts.sql, r.runId));
  });
}
