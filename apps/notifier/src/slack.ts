// Slack's Web API, with a token. SLACK_TOKEN where one is set; on Replit, the token of the Slack
// connection linked to the app, asked of Replit's connectors each time, since Replit refreshes it.

export type Token = () => Promise<string>;

export function tokenFrom(env: {
  SLACK_TOKEN?: string | undefined;
  REPLIT_CONNECTORS_HOSTNAME?: string | undefined;
  REPL_IDENTITY?: string | undefined;
}): Token {
  if (env.SLACK_TOKEN) return async () => env.SLACK_TOKEN!;
  const { REPLIT_CONNECTORS_HOSTNAME: host, REPL_IDENTITY: identity } = env;
  if (!host || !identity)
    throw new Error('No Slack token: set SLACK_TOKEN, or link Slack to the app on Replit.');
  return async () => {
    const res = await fetch(
      `https://${host}/api/v2/connection?include_secrets=true&connector_names=slack`,
      { headers: { Accept: 'application/json', X_REPLIT_TOKEN: `repl ${identity}` } },
    );
    const body = (await res.json()) as {
      items?: {
        settings?: { access_token?: string; oauth?: { credentials?: { access_token?: string } } };
      }[];
    };
    const s = body.items?.[0]?.settings;
    const token = s?.access_token ?? s?.oauth?.credentials?.access_token;
    if (!token) throw new Error('Slack is not linked to this app on Replit.');
    return token;
  };
}

// Form-encoded, which every method takes; Slack's read methods take no JSON body.
async function call<R>(token: Token, method: string, body: Record<string, unknown>): Promise<R> {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await token()}` },
    body: new URLSearchParams(Object.entries(body).map(([k, v]) => [k, String(v)])),
  });
  const out = (await res.json()) as { ok: boolean; error?: string } & R;
  if (!out.ok) throw new Error(`Slack ${method}: ${out.error ?? res.status}`);
  return out;
}

/** A channel's id, from its name or its id. */
export async function channelId(token: Token, channel: string): Promise<string> {
  const name = channel.replace(/^#/, '');
  for (let cursor = ''; ;) {
    const page = await call<{
      channels: { id: string; name: string }[];
      response_metadata?: { next_cursor?: string };
    }>(token, 'conversations.list', {
      types: 'public_channel,private_channel',
      exclude_archived: true,
      limit: 1000,
      ...(cursor ? { cursor } : {}),
    });
    const found = page.channels.find((c) => c.name === name || c.id === name);
    if (found) return found.id;
    cursor = page.response_metadata?.next_cursor ?? '';
    if (!cursor) throw new Error(`No Slack channel ${channel} that this account can post to.`);
  }
}

/** Post a message; Slack's id for it, which is also its thread's. */
export async function post(token: Token, channel: string, text: string): Promise<string> {
  const out = await call<{ ts: string }>(token, 'chat.postMessage', {
    channel,
    text,
    unfurl_links: false,
    unfurl_media: false,
  });
  return out.ts;
}
