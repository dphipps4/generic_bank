// The agent's way into the Task API: its own OAuth2 client, and the tools GET /tools lists. A tool
// call is the endpoint's answer as it is, flagged as an error the way toolResult says.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { toolResult } from '@gb/contracts';

/** What the Console shows once when an admin creates the agent's client. */
export interface ClientCredentials {
  clientId: string;
  clientSecret: string;
  code: string;
}

export interface ToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  endpoint: { method: 'GET' | 'POST'; path: string };
}

/** One tool call, as the API answered it. */
export interface Call {
  tool: string;
  input: Record<string, unknown>;
  status: number;
  isError: boolean;
  body: unknown;
}

export type Api = Awaited<ReturnType<typeof connect>>;

/**
 * Trades the one-time code for tokens and loads the tools. A statement comes back as a PDF, which
 * is saved under `saveTo`; the model is told where, never given the bytes.
 */
export async function connect(apiUrl: string, client: ClientCredentials, saveTo: string) {
  const token = async (fields: Record<string, string>) => {
    const r = await fetch(`${apiUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        ...fields,
        client_id: client.clientId,
        client_secret: client.clientSecret,
      }),
    });
    if (!r.ok) throw new Error(`The API refused a token: ${r.status} ${await r.text()}`);
    const t = (await r.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };
    // Refreshed a minute before it expires.
    return { ...t, until: Date.now() + (t.expires_in - 60) * 1000 };
  };
  let tokens = await token({ grant_type: 'authorization_code', code: client.code });
  const bearer = async () => {
    if (Date.now() > tokens.until)
      tokens = await token({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token });
    return { authorization: `Bearer ${tokens.access_token}` };
  };

  const listed = await fetch(`${apiUrl}/tools`, { headers: await bearer() });
  if (!listed.ok) throw new Error(`GET /tools answered ${listed.status}`);
  const tools = ((await listed.json()) as { tools: ToolDef[] }).tools;
  const calls: Call[] = [];

  async function call(name: string, input: Record<string, unknown>): Promise<Call> {
    const def = tools.find((t) => t.name === name)!;
    // Path parameters from the input; for a GET, the rest go in the query.
    const rest = { ...input };
    const path = def.endpoint.path.replace(/\{(\w+)\}/g, (_, k: string) => {
      const v = String(rest[k]);
      delete rest[k];
      return encodeURIComponent(v);
    });
    const query = new URLSearchParams(
      Object.entries(rest).map(([k, v]) => [k, String(v)] as [string, string]),
    ).toString();
    const r =
      def.endpoint.method === 'GET'
        ? await fetch(`${apiUrl}${path}${query ? `?${query}` : ''}`, { headers: await bearer() })
        : await fetch(`${apiUrl}${path}`, {
            method: 'POST',
            headers: { ...(await bearer()), 'content-type': 'application/json' },
            body: JSON.stringify(input),
          });
    let body: unknown;
    if (r.ok && r.headers.get('content-type')?.startsWith('application/pdf')) {
      const pdf = Buffer.from(await r.arrayBuffer());
      await mkdir(saveTo, { recursive: true });
      const file = join(saveTo, `${String(input.ref)}.pdf`);
      await writeFile(file, pdf);
      body = { saved: file, bytes: pdf.length };
    } else {
      const text = await r.text();
      try {
        body = JSON.parse(text);
      } catch {
        body = { status: r.status, message: text };
      }
    }
    const { isError, content } = toolResult(r.status, body);
    const c: Call = { tool: name, input, status: r.status, isError, body: content };
    calls.push(c);
    return c;
  }

  return {
    tools,
    call,
    /** Every call so far, in order. */
    calls,
    /** Revokes the agent's tokens, as it does when it is done. */
    async close() {
      await fetch(`${apiUrl}/oauth/revoke`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          token: tokens.refresh_token,
          client_id: client.clientId,
          client_secret: client.clientSecret,
        }),
      });
    },
  };
}
