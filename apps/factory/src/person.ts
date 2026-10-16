// A person's code for the Scout, the way the Runner gets one: a staff-code task in the Console's
// inbox, answered by a person and sealed until the Scout types it. The model never sees it.
import { awaitAnswer, openHumanTask, type Sql } from '@gb/runs';
import { ToolRefusal } from './tools.js';

export function personCode(o: {
  sql: Sql;
  runId: string;
  bank: string;
  /** Opens the person's sealed answer. */
  answerKey: string;
  deadlineMs?: number;
}): () => Promise<string> {
  return async () => {
    const deadline = new Date(Date.now() + (o.deadlineMs ?? 15 * 60_000));
    const task = await openHumanTask(
      o.sql,
      o.runId,
      'staff_code',
      { bank: o.bank, prompt: 'The bank sent a sign-in code to the staff phone. Enter it here.' },
      deadline,
    );
    const a = await awaitAnswer(o.sql, task, o.answerKey, deadline);
    if (a.status !== 'answered') throw new ToolRefusal(`the person's code was ${a.status}`);
    return a.answer;
  };
}
