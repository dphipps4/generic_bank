// A small legacy site for the factory's tests, in no bank's words: pages that name themselves only
// in their titles, labels in a neighbouring cell, a search whose results appear on the same page,
// and a sign-in that a browser the site knows meets in a shorter form, under the same title.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export const SITE = {
  member: '40017732',
  name: 'Pat Lee',
  account: 'Everyday Checking',
  last4: '1234',
  availableCents: 123_456,
  currentCents: 130_000,
};

const page = (title: string, body: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body style="font:14px Arial;margin:8px">${body}</body></html>`;

const cookies = (req: IncomingMessage) =>
  Object.fromEntries(
    (req.headers.cookie ?? '')
      .split(';')
      .map((c) => c.trim().split('='))
      .filter((kv) => kv.length === 2),
  );

const money = (cents: number) =>
  `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;

/** Sessions that have been shown the promotion: once each, as a site shows it. */
const promoted = new Set<string>();
let sessions = 0;

function route(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://site');
  const c = cookies(req);
  // Hazards forced by the test, by name, in the header the banks read (unsigned here).
  const forced = String(req.headers['x-hazards'] ?? '')
    .split(';')[0]!
    .split(',');
  const send = (html: string, headers: Record<string, string> = {}) => {
    res.writeHead(200, { 'content-type': 'text/html', ...headers });
    res.end(html);
  };
  const go = (to: string, headers: Record<string, string | string[]> = {}) => {
    res.writeHead(302, { location: to, ...headers });
    res.end();
  };
  if (url.pathname === '/') return go('/signon');
  if (url.pathname === '/signon' && req.method === 'POST')
    return go('/home', { 'set-cookie': [`sid=${++sessions}; Path=/`, 'known=1; Path=/'] });
  if (url.pathname === '/signon')
    return send(
      page(
        'Branch Sign In',
        c.known
          ? `<p><b>Welcome back</b></p><form method="post" action="/signon"><table>
             <tr><td>Password:</td><td><input type="password" name="p${Date.now() % 97}"></td></tr>
             </table><button type="submit">Sign In</button></form>`
          : `<p><b>Branch Console</b></p><form method="post" action="/signon"><table>
             <tr><td>Operator ID:</td><td><input name="u${Date.now() % 89}"></td></tr>
             <tr><td>Password:</td><td><input type="password" name="p${Date.now() % 97}"></td></tr>
             </table><button type="submit">Sign In</button></form>`,
      ),
    );
  if (!c.sid) return go('/signon');
  // A promotion in place of the page asked for, under that page's own title, once a session.
  if (forced.includes('promo') && !promoted.has(c.sid)) {
    promoted.add(c.sid);
    const title = { '/home': 'Branch Home', '/search': 'Member Search' }[url.pathname] ?? 'Branch';
    return send(
      page(title, `<p><b>Have a look at what is new</b></p><a href="${url.pathname}">Not now</a>`),
    );
  }
  if (url.pathname === '/home')
    return send(
      page(
        'Branch Home',
        `<p>Pick a task.</p><a href="/search">Member Search</a> <a href="/">Sign Out</a>`,
      ),
    );
  if (url.pathname === '/search') {
    // The field's name changes on every page, as a legacy form's may: its value is the first one sent.
    const n = [...url.searchParams.values()][0];
    const found =
      n && forced.includes('record-in-use')
        ? '<p><b>This record is in use by another operator.</b></p>'
        : n === SITE.member
          ? `<table border="1"><tr><td>${SITE.member}</td><td>${SITE.name}</td><td>Active</td><td><a href="/member?n=${SITE.member}">Open</a></td></tr></table>`
          : '';
    return send(
      page(
        'Member Search',
        `<form method="get" action="/search"><table><tr><td>Member number:</td><td><input name="q${Date.now() % 83}"></td></tr></table>
         <button type="submit">Search</button></form>${found}`,
      ),
    );
  }
  if (url.pathname === '/member')
    return send(
      page(
        'Member Summary',
        `<p>Member ${SITE.member} · ${SITE.name}</p>
         <p>${SITE.account} Account ending in ${SITE.last4} Available balance: ${money(SITE.availableCents)} Current balance: ${money(SITE.currentCents)}</p>
         <a href="/search">Member Search</a> <a href="/">Sign Out</a>`,
      ),
    );
  res.writeHead(404);
  res.end();
}

/** The site, on a free port; close it when done. */
export async function legacySite(): Promise<{ url: string; close(): Promise<void> }> {
  const server = createServer(route);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
