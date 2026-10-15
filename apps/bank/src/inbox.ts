import Fastify, { type FastifyInstance } from 'fastify';
import { totp } from './auth.js';
import type { Db } from './db.js';
import { esc } from './markup/html.js';
import type { Tenant } from './tenants.js';

// The fake phone and email inbox, one mailbox per bank, where staff codes and supervisor approval
// codes arrive. It is for people: the automation cannot reach it, so a code is always a human
// step, exactly as in production.

export interface InboxBank {
  t: Tenant;
  db: Db;
}

interface Message {
  mailbox: 'phone' | 'email';
  address: string;
  body: string;
  at: Date;
}

export async function buildInbox(banks: InboxBank[]): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.get('/healthz', async () => ({
    ok: true,
    service: 'bank-inbox',
    banks: banks.map((b) => b.t.id),
  }));

  app.get('/', async (_req, reply) => {
    const sections: string[] = [];
    for (const b of banks) {
      const r = await b.db
        .query<Message>('SELECT mailbox, address, body, at FROM messages ORDER BY id DESC LIMIT 30')
        .catch(() => ({ rows: [] as Message[] }));
      const items = r.rows
        .map(
          (m) =>
            `<li><span class="when">${esc(new Date(m.at).toISOString().slice(11, 19))} UTC</span> <span class="kind">${m.mailbox === 'phone' ? 'Text' : 'Email'}</span> <span class="to">${esc(m.address)}</span><div class="body">${esc(m.body)}</div></li>`,
        )
        .join('');
      // Bank 4's staff read codes from an authenticator app; this panel is that app.
      let app = '';
      if (b.t.codeStyle === 'authenticator') {
        const ops = await b.db
          .query<{ operator_id: string; display_name: string; totp_secret: string | null }>(
            'SELECT operator_id, display_name, totp_secret FROM operators WHERE totp_secret IS NOT NULL ORDER BY operator_id',
          )
          .catch(() => ({
            rows: [] as { operator_id: string; display_name: string; totp_secret: string | null }[],
          }));
        const now = new Date();
        const left = 30 - (Math.floor(now.getTime() / 1000) % 30);
        app = `<div class="app"><b>Authenticator</b> <span class="when">new codes in ${left} s</span>${ops.rows
          .map(
            (o) =>
              `<div class="code"><span class="to">${esc(o.display_name)}</span> <b>${totp(o.totp_secret!, now)}</b></div>`,
          )
          .join('')}</div>`;
      }
      sections.push(
        `<section><h2>${esc(b.t.brand)}</h2>${app}${items ? `<ul>${items}</ul>` : '<p class="none">No messages yet.</p>'}</section>`,
      );
    }
    return reply.type('text/html; charset=utf-8')
      .send(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="refresh" content="5">
<title>Staff Inbox</title><style>
body{margin:0;background:#f6f7f9;color:#1a1a1a;font:15px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}
header{background:#fff;border-bottom:1px solid #e3e5e8;padding:14px 20px}h1{font-size:17px;margin:0}header p{margin:2px 0 0;color:#666;font-size:13px}
main{max-width:860px;margin:0 auto;padding:12px 16px 40px}h2{font-size:14px;text-transform:uppercase;letter-spacing:.05em;color:#1f4d7a;margin:24px 0 8px}
ul{list-style:none;margin:0;padding:0}li{background:#fff;border:1px solid #e3e5e8;border-radius:8px;padding:10px 12px;margin:6px 0}
.when{color:#888;font-size:12px}.kind{font-size:11px;text-transform:uppercase;letter-spacing:.05em;background:#eef3f8;color:#1f4d7a;padding:1px 6px;border-radius:4px;margin:0 6px}
.to{color:#555;font-size:13px}.app{background:#fff;border:1px solid #c9d6e4;border-radius:8px;padding:10px 12px;margin:6px 0}.code b{font-size:20px;letter-spacing:.12em;font-variant-numeric:tabular-nums}.body{margin-top:4px;font-size:15px}.none{color:#888}
</style></head><body><header><h1>Staff inbox</h1><p>Texts and emails the banks send to their staff. Refreshes every five seconds.</p></header>
<main>${sections.join('')}</main></body></html>`);
  });
  return app;
}
