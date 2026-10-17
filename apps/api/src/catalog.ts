// What the API says about itself: the banks and what each supports, the tool definitions an agent
// loads, and the OpenAPI document. All three are generated from the same zod contracts as the
// endpoints, so they cannot drift apart (a test holds them to it).
import { z } from 'zod';
import {
  BankInfo,
  CODES,
  GetStatementInput,
  GetTaskInput,
  ProblemDetails,
  TASKS,
  type TaskName,
  TaskResult,
} from '@gb/contracts';
import type { Sql, TaskScope } from '@gb/oauth';

export type Task = TaskName;

/** The OAuth2 scope each task needs (plan, §A.7). */
export const TASK_SCOPE: Record<Task, TaskScope> = {
  'check-balance': 'tasks:balance',
  transfer: 'tasks:transfer',
  'download-statements': 'tasks:statements',
};

/**
 * Each bank in the registry, with the tasks a promoted driver serves on it today. A frozen bank
 * serves none until a person clears the freeze (plan, §7).
 */
export async function banks(sql: Sql): Promise<BankInfo[]> {
  const r = await sql.query<{
    id: string;
    brand: string;
    productVersion: string;
    task: string | null;
    version: number | null;
  }>(
    `SELECT b.id, b.brand, b."productVersion", d.task, v.version
       FROM "Bank" b
       LEFT JOIN "Driver" d ON d.tenant = b.id AND d.state = 'promoted'
             AND NOT EXISTS (SELECT 1 FROM "Freeze" f WHERE f.tenant = b.id AND f."clearedAt" IS NULL)
       LEFT JOIN "DriverVersion" v ON v.id = d."activeVersionId"
      ORDER BY b.position, b.id, d.task`,
  );
  const out = new Map<string, BankInfo>();
  for (const row of r.rows) {
    const b = out.get(row.id) ?? {
      id: row.id,
      brand: row.brand,
      productVersion: row.productVersion,
      tasks: [],
    };
    if (row.task && row.task in TASKS && row.version !== null)
      b.tasks.push({ task: row.task as Task, crawlerVersion: `v${row.version}` });
    out.set(row.id, b);
  }
  return [...out.values()];
}

// ── Tools ────────────────────────────────────────────────────────────────────

export interface ToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  /** The endpoint the agent calls itself, with its own access token. */
  endpoint: { method: 'GET' | 'POST'; path: string };
}

const schema = (s: z.ZodType) => {
  const { $schema, ...rest } = z.toJSONSchema(s) as Record<string, unknown>;
  return rest;
};

export const TASK_TOOLS: Record<Task, { tool: string; description: string }> = {
  'check-balance': {
    tool: 'check_balance',
    description:
      "Reads a member's available and current balance for one account, the way a member-services employee would. Never changes anything at the bank, and never shows a full account number.",
  },
  transfer: {
    tool: 'transfer',
    description:
      "Requests a transfer between a member's own accounts. Never moves money until a person approves it in the Console; until then the result is needs_human. To ask again, send the same idempotencyKey: it returns the same run, never a second transfer.",
  },
  'download-statements': {
    tool: 'download_statements',
    description:
      "Fetches an account's monthly statements: one entry per month, either a reference for get_statement or the bank's own words for why it has none. Never changes anything at the bank.",
  },
};

/** One tool: what the agent reads, the schema it fills in, and the endpoint it calls. */
interface Tool {
  name: string;
  description: string;
  input: z.ZodObject;
  endpoint: ToolDef['endpoint'];
}

/** Every tool, each from its own contract: the tool list and the OpenAPI document both read this. */
const TOOLS: Tool[] = [
  {
    name: 'list_banks',
    description:
      'Lists every bank the system knows and the tasks each supports right now. Never contacts a bank.',
    input: z.object({}),
    endpoint: { method: 'GET', path: '/banks' },
  },
  ...(Object.keys(TASKS) as Task[]).map((t) => ({
    name: TASK_TOOLS[t].tool,
    description: TASK_TOOLS[t].description,
    input: TASKS[t],
    endpoint: { method: 'POST' as const, path: `/tasks/${t}` },
  })),
  {
    name: 'get_task',
    description:
      "Reads a task's current result by its runId, waiting up to `wait` seconds for it to settle. Never starts a task, and never repeats one.",
    input: GetTaskInput,
    endpoint: { method: 'GET', path: '/tasks/{runId}' },
  },
  {
    name: 'get_statement',
    description:
      "Fetches a statement a download_statements run kept, by the reference in its result: the PDF exactly as the bank sent it. Needs tasks:statements. Never contacts the bank, and never returns a statement another client's run kept.",
    input: GetStatementInput,
    endpoint: { method: 'GET', path: '/statements/{ref}' },
  },
];

const tool = (name: string) => TOOLS.find((t) => t.name === name)!;

export function tools(): ToolDef[] {
  return TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: schema(t.input),
    endpoint: t.endpoint,
  }));
}

/** A GET tool's input as OpenAPI parameters: in the path where the path names it, else the query. */
function parameters(t: Tool) {
  const s = schema(t.input) as { properties: Record<string, unknown>; required?: string[] };
  return Object.entries(s.properties).map(([name, p]) => {
    const inPath = t.endpoint.path.includes(`{${name}}`);
    return {
      name,
      in: inPath ? 'path' : 'query',
      required: inPath || (s.required ?? []).includes(name),
      schema: p,
    };
  });
}

/** The operation's id and summary are its tool's name and description. */
const about = (name: string) => ({ operationId: name, summary: tool(name).description });

// ── OpenAPI ──────────────────────────────────────────────────────────────────

const problemResponse = (description: string) => ({
  description,
  content: {
    'application/problem+json': { schema: { $ref: '#/components/schemas/ProblemDetails' } },
  },
});

/** The result codes under each status, as the examples in the document. */
const example = (status: keyof typeof CODES) => Object.keys(CODES[status]).join(', ');

/**
 * A transfer asked again with its idempotency key answers with its run's current result, so it can
 * end in any of a run's status codes; and the same transfer under a new key is refused while the
 * first is open (plan, §3).
 */
const AGAIN = {
  '200': {
    description: 'Asked again with the same key: succeeded or handed_off.',
    content: { 'application/json': { schema: { $ref: '#/components/schemas/TaskResult' } } },
  },
  '409': problemResponse(
    'duplicate_transfer: the same member, accounts and amount are already in an open transfer, which runId and Location name. Or, asked again with the same key: escalated (' +
      example('escalated') +
      ').',
  ),
  '410': problemResponse('Asked again with the same key: expired or cancelled.'),
  '422': problemResponse(
    'Asked again with the same key: business_outcome (' + example('business_outcome') + ').',
  ),
  '502': problemResponse('Asked again with the same key: failed, and a retry will not help.'),
  '503': problemResponse(
    'Asked again with the same key: failed, and a retry may help; see Retry-After.',
  ),
};

/**
 * Requests that work on a fresh stack, one per bank that serves the task, so Swagger UI's Try it
 * out starts from one (a dropdown when there are several). Bank 3 shows what a bank the factory
 * hasn't learned yet answers.
 */
type Example = { summary: string; value: Record<string, unknown> };
const demo = { memberId: '40017732' };
const EXAMPLES: Record<Task, Record<string, Example>> = {
  'check-balance': {
    bank1: {
      summary: 'Bank 1, Generic Bank',
      value: { bank: 'generic', ...demo, account: 'Everyday Checking' },
    },
    bank2: {
      summary: 'Bank 2, Example Credit Union: an account by its last four digits',
      value: { bank: 'example', ...demo, account: '7255' },
    },
    bank3: {
      summary: 'Bank 3, Sample Savings Bank: no crawler until the factory learns it (404)',
      value: { bank: 'sample', ...demo, account: 'Everyday Checking' },
    },
  },
  transfer: {
    bank1: {
      summary: 'Bank 1, Generic Bank: $25 to savings, waiting for a person to approve',
      value: {
        bank: 'generic',
        ...demo,
        from: 'Everyday Checking',
        to: 'Rainy Day Savings',
        amountCents: 2500,
        memo: 'rent',
        idempotencyKey: 'try-transfer-0001',
      },
    },
  },
  'download-statements': {
    bank1: {
      summary: "Bank 1, Generic Bank: one month's statement",
      value: { bank: 'generic', ...demo, account: 'Everyday Checking', months: ['2026-09'] },
    },
  },
};

export function openapi(): Record<string, unknown> {
  const taskPaths = Object.fromEntries(
    (Object.keys(TASKS) as Task[]).map((t) => [
      `/tasks/${t}`,
      {
        post: {
          ...about(TASK_TOOLS[t].tool),
          tags: ['tasks'],
          security: [{ client: [] }],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: schema(TASKS[t]), examples: EXAMPLES[t] } },
          },
          responses: {
            '202': {
              description:
                'Accepted: running, or waiting on a person (`pending` names the kind of answer and its deadline). Location names the run.',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/TaskResult' } },
              },
            },
            ...(t === 'transfer' ? AGAIN : {}),
            '400': problemResponse(
              'The input did not match the schema; the field that failed is named.',
            ),
            '401': problemResponse('A valid bearer access token is required.'),
            '403': problemResponse(
              `insufficient_scope: the client lacks ${TASK_SCOPE[t]}, or may not use this bank.`,
            ),
            '404': problemResponse('No such bank, or no promoted crawler serves this task on it.'),
            '429': problemResponse('Too many requests; see Retry-After.'),
          },
        },
      },
    ]),
  );
  return {
    openapi: '3.1.0',
    info: {
      title: 'Generic Bank Task API',
      version: '1',
      description:
        'Typed tasks at banks that have no API, done by operating each bank’s website the way a person would. No money moves without a person’s approval. Get a token with `just api-token`, press Authorize, and paste it.',
    },
    tags: [{ name: 'tasks' }, { name: 'catalog' }, { name: 'oauth' }],
    components: {
      securitySchemes: {
        // One way in, so Swagger UI's Authorize shows one: the client id and secret. The token it
        // gets is a bearer token, the same one curl sends from `just api-token`.
        client: {
          type: 'oauth2',
          description:
            "The Task API's client id and secret, under Task API in secrets/credentials.txt (not a bank login); Swagger UI gets the token.",
          flows: { clientCredentials: { tokenUrl: '/oauth/token', scopes: {} } },
        },
      },
      schemas: {
        TaskResult: schema(TaskResult),
        ProblemDetails: schema(ProblemDetails),
        BankInfo: schema(BankInfo),
      },
    },
    paths: {
      '/banks': {
        get: {
          ...about('list_banks'),
          tags: ['catalog'],
          security: [{ client: [] }],
          responses: {
            '200': {
              description: 'The banks.',
              content: {
                'application/json': {
                  schema: { type: 'array', items: { $ref: '#/components/schemas/BankInfo' } },
                },
              },
            },
          },
        },
      },
      '/tasks': {
        get: {
          operationId: 'list_tasks',
          tags: ['catalog'],
          security: [{ client: [] }],
          summary: 'The tasks and their input schemas.',
          responses: { '200': { description: 'The catalog.' } },
        },
      },
      '/tools': {
        get: {
          operationId: 'list_tools',
          tags: ['catalog'],
          security: [{ client: [] }],
          summary:
            'The API as tool definitions an agent loads directly. A tool call returns the endpoint’s answer, flagged as an error unless it is 200 (succeeded, handed_off) or 202 (waiting).',
          responses: { '200': { description: 'The tools.' } },
        },
      },
      ...taskPaths,
      '/tasks/{runId}': {
        get: {
          ...about('get_task'),
          tags: ['tasks'],
          security: [{ client: [] }],
          parameters: parameters(tool('get_task')),
          responses: {
            '200': {
              description: 'succeeded or handed_off.',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/TaskResult' } },
              },
            },
            '202': { description: 'running or needs_human (' + example('needs_human') + ').' },
            '409': problemResponse(
              'escalated: ' +
                example('escalated') +
                '. escalationId names the task a person resolves in the Console; resolvable says whether the run can resume (not after a guard trip). Ask again: 202 after Resume, 200 handed_off after Finish by hand, 410 after Cancel.',
            ),
            '410': problemResponse('expired or cancelled.'),
            '422': problemResponse('business_outcome: ' + example('business_outcome') + '.'),
            '502': problemResponse('failed, and a retry will not help.'),
            '503': problemResponse('failed, and a retry may help; see Retry-After.'),
          },
        },
      },
      '/statements/{ref}': {
        get: {
          ...about('get_statement'),
          tags: ['tasks'],
          security: [{ client: [] }],
          parameters: parameters(tool('get_statement')),
          responses: {
            '200': {
              description: 'The statement.',
              content: { 'application/pdf': { schema: { type: 'string', format: 'binary' } } },
            },
            '401': problemResponse('A valid bearer access token is required.'),
            '403': problemResponse('The client may not use tasks:statements, or this bank.'),
            '404': problemResponse(
              'No statement by that reference for this client: no_such_statement.',
            ),
          },
        },
      },
      '/oauth/token': {
        post: {
          operationId: 'token',
          tags: ['oauth'],
          summary:
            'Exchange a one-time code, or a refresh token, for tokens. Refresh tokens rotate; a spent one revokes its family.',
          requestBody: {
            content: {
              'application/x-www-form-urlencoded': {
                schema: {
                  type: 'object',
                  properties: {
                    grant_type: {
                      enum: ['client_credentials', 'authorization_code', 'refresh_token'],
                    },
                    client_id: { type: 'string' },
                    client_secret: { type: 'string' },
                    code: { type: 'string' },
                    refresh_token: { type: 'string' },
                  },
                  required: ['grant_type'],
                },
              },
            },
          },
          responses: {
            '200': {
              description:
                'An access token (8 hours for client credentials, 15 minutes otherwise) and a refresh token (30 days).',
            },
            '400': { description: 'invalid_grant' },
            '401': { description: 'invalid_client' },
          },
        },
      },
      '/oauth/revoke': {
        post: {
          operationId: 'revoke',
          tags: ['oauth'],
          summary: 'Revoke a token and its whole family.',
          responses: { '200': { description: 'Revoked, or never valid.' } },
        },
      },
    },
  };
}
