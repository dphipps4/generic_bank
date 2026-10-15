// The Console's own pages: plain server-rendered HTML for what AdminJS cannot show without custom
// components (a run, screen by screen; later the inbox and approvals). They sit behind the same
// sign-in as AdminJS, and a bar links the two.

export interface Sql {
  query<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: R[] }>;
}

/** Who is signed in to the Console, and with which role (plan, §G.1). */
export interface Viewer {
  email: string;
  role: 'viewer' | 'approver' | 'admin';
}

export const esc = (s: unknown) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

const NAV = [
  ['/inbox', 'Inbox'],
  ['/runs', 'Runs'],
  ['/journal', 'Journal'],
  ['/admin', 'Data'],
] as const;

export function page(
  title: string,
  body: string,
  o: { active?: string; admin?: string; waiting?: number } = {},
): string {
  const banner = o.waiting
    ? `<div class="banner"><div class="in"><a href="/inbox">${o.waiting === 1 ? 'One task has' : `${o.waiting} tasks have`} waited more than five minutes for a person.</a></div></div>`
    : '';
  const nav = NAV.map(
    ([href, label]) => `<a href="${href}"${o.active === href ? ' class="on"' : ''}>${label}</a>`,
  ).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer"><title>${esc(title)} · Console</title>
<style>
:root{--ink:#1a1a1a;--soft:#5b6470;--line:#e3e6ea;--bg:#f6f7f9;--card:#fff;--accent:#1f4d7a;--ok:#2e7d4f;--warn:#a46a00;--bad:#b23b3b;--esc:#7a3fa0}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}
header{background:#fff;border-bottom:1px solid var(--line);position:sticky;top:0;z-index:5}
header .in{max-width:1180px;margin:0 auto;padding:10px 16px;display:flex;gap:18px;align-items:center}
header b{font-size:15px}header a{color:var(--soft);text-decoration:none;padding:4px 8px;border-radius:6px}header a.on,header a:hover{background:#eef3f8;color:var(--accent)}
header .who{margin-left:auto;color:var(--soft);font-size:13px}
main{max-width:1180px;margin:0 auto;padding:18px 16px 60px}h1{font-size:20px;margin:6px 0 14px}h2{font-size:14px;text-transform:uppercase;letter-spacing:.05em;color:var(--accent);margin:26px 0 8px}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:8px;overflow:hidden}
th,td{text-align:left;padding:7px 10px;border-bottom:1px solid var(--line);vertical-align:top}th{font-size:12px;color:var(--soft);font-weight:600;background:#fafbfc}
tr:last-child td{border-bottom:0}a{color:var(--accent)}code{font:12px ui-monospace,Menlo,monospace}
.pill{display:inline-block;padding:1px 8px;border-radius:10px;font-size:12px;font-weight:600;background:#eef1f4;color:var(--soft)}
.succeeded{background:#e6f4ec;color:var(--ok)}.business_outcome{background:#fdf3e1;color:var(--warn)}.failed{background:#fbe9e9;color:var(--bad)}
.escalated{background:#f3eaf8;color:var(--esc)}.needs_human,.running{background:#e9f1fa;color:var(--accent)}
.facts{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:10px}.fact{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:8px 12px}
.fact span{display:block;font-size:12px;color:var(--soft)}
.frames-pop{width:min(1200px,96vw);max-height:94vh;padding:0;border:1px solid var(--line);border-radius:8px}.frames-pop::backdrop{background:rgba(0,0,0,.4)}
.frames-pop .bar{display:flex;gap:10px;align-items:center;padding:8px 10px;border-bottom:1px solid var(--line);font-size:13px}.frames-pop .bar span{flex:1}.frames-pop img{display:block;width:100%}
.frame .cap{padding:8px 10px;font-size:13px}.frame .cap small{color:var(--soft)}.withheld{padding:30px 12px;text-align:center;color:var(--soft);background:repeating-linear-gradient(45deg,#fafafa,#fafafa 8px,#f1f1f1 8px,#f1f1f1 16px)}
.empty{color:var(--soft);padding:12px 0}.soft{color:var(--soft)}
.banner{background:#fdf3e1;border-bottom:1px solid #f0d9a8}.banner .in{max-width:1180px;margin:0 auto;padding:8px 16px}.banner a{color:var(--warn);font-weight:600}
.note{padding:8px 12px;border-radius:8px;margin:0 0 14px}.note.ok{background:#e6f4ec;color:var(--ok)}.note.bad{background:#fbe9e9;color:var(--bad)}
form.row{display:flex;gap:6px;align-items:center;margin:0 0 6px}input{font:inherit;padding:5px 8px;border:1px solid var(--line);border-radius:6px}
button{font:inherit;padding:5px 12px;border-radius:6px;border:1px solid var(--accent);background:var(--accent);color:#fff;cursor:pointer}button.quiet{background:#fff;color:var(--bad);border-color:var(--bad)}
details summary{color:var(--soft);cursor:pointer;font-size:13px}
dl.review{display:grid;grid-template-columns:auto 1fr;gap:2px 12px;margin:6px 0}dl.review dt{color:var(--soft);font-size:12px}dl.review dd{margin:0}
img.thumb{display:block;max-width:260px;border:1px solid var(--line);border-radius:6px;margin:4px 0}
</style></head><body><header><div class="in"><b>Generic Bank Console</b>${nav}<span class="who">${o.admin ? esc(o.admin) : ''}</span></div></header>${banner}
<main>${body}</main></body></html>`;
}

/** Injected into AdminJS's pages: a bar back to the Console's pages, and a trail link on a run. */
export const ADMIN_BAR_JS = `(function () {
  function bar() {
    if (document.getElementById('gb-bar')) return;
    var b = document.createElement('div');
    b.id = 'gb-bar';
    b.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:9999;background:#1f4d7a;border-radius:20px;padding:6px 14px;font:13px -apple-system,Segoe UI,Arial;box-shadow:0 2px 8px rgba(0,0,0,.2)';
    b.innerHTML = '<a href="/runs" style="color:#fff;text-decoration:none">Runs, screen by screen</a>';
    document.body.appendChild(b);
  }
  function trail() {
    var m = location.pathname.match(/\\/admin\\/resources\\/TaskRun\\/records\\/([^/]+)\\/show/);
    var link = document.getElementById('gb-trail');
    if (!m) { if (link) link.remove(); return; }
    if (link && link.dataset.run === m[1]) return;
    if (link) link.remove();
    var a = document.createElement('a');
    a.id = 'gb-trail'; a.dataset.run = m[1]; a.href = '/runs/' + encodeURIComponent(m[1]);
    a.textContent = 'Open this run, screen by screen';
    a.style.cssText = 'position:fixed;right:16px;bottom:56px;z-index:9999;background:#fff;color:#1f4d7a;border:1px solid #1f4d7a;border-radius:20px;padding:6px 14px;font:13px -apple-system,Segoe UI,Arial;text-decoration:none';
    document.body.appendChild(a);
  }
  setInterval(function () { bar(); trail(); }, 500);
})();`;
