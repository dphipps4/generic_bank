// Every response a task call can give, on a page of its own: Swagger UI shows only the answer a
// call really gave, and links here, so the call itself stays a few lines long. The examples are
// what this API answers, not placeholders.

const RUN = 'r_0821fe3049b16133';

/** Each status, what it means, and an example body. */
const ROWS: [status: string, means: string, example: unknown][] = [
  [
    '200',
    'Done. A balance comes back in the same call, within 60 seconds.',
    {
      runId: RUN,
      task: 'check-balance',
      status: 'succeeded',
      data: {
        accountLabel: 'Everyday Checking, ending in 9706',
        availableCents: 3978241,
        currentCents: 3979777,
        asOf: '2026-10-18T02:28:58.000Z',
      },
    },
  ],
  [
    '202',
    'Waiting on a person (a transfer to approve), or still running. Location names the run: GET it later.',
    {
      runId: RUN,
      task: 'transfer',
      status: 'needs_human',
      code: 'awaiting_approval',
      message: 'Waiting for a person to approve the transfer.',
      pending: { kind: 'approval', deadline: '2026-10-18T02:45:49.000Z' },
    },
  ],
  [
    '422',
    "The bank's own answer: no such member, insufficient funds, a closed member, and so on.",
    {
      type: 'about:blank',
      title: 'business_outcome',
      status: 422,
      code: 'no_such_member',
      detail: 'The bank has no member with that number.',
      runId: RUN,
    },
  ],
  [
    '409',
    'Stopped, and a person has it in the Console: an unknown page, stuck, or an unclear transfer.',
    {
      type: 'about:blank',
      title: 'escalated',
      status: 409,
      code: 'unknown_screen',
      detail: 'The bank showed a screen the system does not know; a person is looking.',
      runId: RUN,
      escalationId: 'h_63be6ab62e3f78f8',
      resolvable: true,
    },
  ],
  [
    '503',
    'A failure a retry may fix, such as the bank being unavailable. Retry-After says when.',
    {
      type: 'about:blank',
      title: 'failed',
      status: 503,
      code: 'unavailable',
      detail: "The bank's system is unavailable right now.",
      runId: RUN,
      retryable: true,
    },
  ],
  [
    '502',
    "A failure a retry won't fix.",
    {
      type: 'about:blank',
      title: 'failed',
      status: 502,
      code: 'app_error',
      detail: "The bank's system reported an error.",
      runId: RUN,
      retryable: false,
    },
  ],
  ['410', 'Nobody answered in time, or it was cancelled.', { status: 410, code: 'expired' }],
  ['400', "The input didn't match; the field is named.", { status: 400, code: 'invalid_input' }],
  ['401', 'Authorize first.', { status: 401, code: 'unauthorized' }],
  [
    '403',
    "The client doesn't have that task's scope.",
    { status: 403, code: 'insufficient_scope' },
  ],
  [
    '404',
    'No such bank, or no crawler serves the task there yet.',
    { status: 404, code: 'task_not_available' },
  ],
];

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export const RESPONSES_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Every response a task can give</title>
<style>
body{margin:0;background:#fafafa;color:#1a1a1a;font:15px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}
main{max-width:980px;margin:0 auto;padding:24px 16px 40px}h1{font-size:26px;margin:0 0 6px}p.lead{color:#555;margin:0 0 18px}
table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #e3e5e8}
th,td{text-align:left;vertical-align:top;padding:10px 12px;border-top:1px solid #e3e5e8}th{background:#f3f5f8;font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:#555}
td.code{font:600 16px ui-monospace,Menlo,monospace;width:56px}pre{margin:0;font:12.5px/1.4 ui-monospace,Menlo,monospace;white-space:pre-wrap}
</style></head><body><main><h1>Every response a task can give</h1>
<p class="lead">The same for both tasks, check balance and transfer. Errors are RFC 9457 problem details.</p>
<table><tr><th>Status</th><th>Means</th><th>Example</th></tr>
${ROWS.map(
  ([s, m, e]) =>
    `<tr><td class="code">${s}</td><td>${esc(m)}</td><td><pre>${esc(JSON.stringify(e, null, 2))}</pre></td></tr>`,
).join('')}
</table></main></body></html>`;

/**
 * Swagger UI, shorter: a call shows its inputs and the answer it really gave, never the documented
 * responses; the request box fits its JSON; and the empty "No parameters" row goes.
 */
export const SWAGGER_CSS = `
.responses-wrapper .responses-table:not(.live-responses-table) { display: none; }
.responses-wrapper .responses-inner > div > h4 { display: none; }
.parameters-container .opblock-description-wrapper { display: none; }
.opblock-body textarea.body-param__text { min-height: 0; height: 9em; }
.opblock .opblock-section-header { min-height: 0; padding: 6px 20px; }
.opblock-body .execute-wrapper { padding: 8px 20px; }
.opblock-body .body-param-options { padding-top: 4px; }
.swagger-ui .opblock-description-wrapper p a { font-weight: 600; }
`;
