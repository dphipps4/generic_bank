// Renders the plan (every Markdown file in docs/plan) as white-template HTML pages with a contents
// sidebar, into .run/plan. Run by `just plan` inside the tools image, which provides marked.
const fs = require('fs');
const path = require('path');
const { Marked } = require('marked');

const ROOT = path.resolve(__dirname, '../..');
const PUB = path.join(ROOT, 'docs/plan');
const OUT = path.join(ROOT, '.run/plan');
const srcOf = (f) => path.join(PUB, f);

// The plan first, then its companions; any other document follows, named by its first heading.
const ORDER = [
  ['GENERIC_BANK_PLAN.md', 'The plan'],
  ['REQUIREMENTS.md', 'Requirements'],
  ['architecture.md', 'Architecture'],
  ['techstack.md', 'Technology'],
];
const firstHeading = (f) =>
  fs.readFileSync(srcOf(f), 'utf8').match(/^# (.+)$/m)?.[1] ?? f.replace(/\.md$/, '');
const present = fs.readdirSync(PUB).filter((f) => f.endsWith('.md'));
const DOCS = [
  ...ORDER.filter(([f]) => present.includes(f)),
  ...present
    .filter((f) => !ORDER.some(([o]) => o === f))
    .sort()
    .map((f) => [f, firstHeading(f)]),
];

const known = new Set(DOCS.map(([f]) => f));

const slug = (t) =>
  t.toLowerCase().replace(/<[^>]+>/g, '').replace(/&[a-z]+;/g, '')
    .replace(/[^a-z0-9\s-]/g, '').trim().replace(/\s+/g, '-');

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function render(file, title) {
  const md = fs.readFileSync(srcOf(file), 'utf8');
  const toc = [];
  const seen = {};
  const marked = new Marked({ gfm: true });
  marked.use({
    renderer: {
      heading({ tokens, depth, text }) {
        const inner = this.parser.parseInline(tokens);
        let id = slug(text) || 'section';
        seen[id] = (seen[id] || 0) + 1;
        if (seen[id] > 1) id += '-' + seen[id];
        if (depth === 2) toc.push({ id, html: inner });
        return `<h${depth} id="${id}">${inner}</h${depth}>\n`;
      },
      codespan({ text }) {
        const raw = text.replace(/&amp;/g, '&');
        if (known.has(raw)) {
          return `<a class="doclink" href="${raw.replace(/\.md$/, '.html')}"><code>${text}</code></a>`;
        }
        return `<code>${text}</code>`;
      },
      code({ text, lang }) {
        const cls = lang === 'text' || !lang ? 'diagram' : 'code';
        return `<pre class="${cls}"><code>${esc(text)}</code></pre>\n`;
      },
      link({ href, title, tokens }) {
        const text = this.parser.parseInline(tokens);
        const h = href.replace(/^([A-Za-z0-9_]+)\.md(#.*)?$/, (m, f, a) => known.has(f + '.md') ? f + '.html' + (a || '') : m);
        return `<a href="${h}"${title ? ` title="${title}"` : ''}>${text}</a>`;
      },
      table(token) {
        const html = marked.Renderer.prototype.table.call(this, token);
        return `<div class="table-wrap">${html}</div>`;
      },
    },
  });
  const body = marked.parse(md);
  const h1 = md.match(/^# (.+)$/m)?.[1] ?? title;
  const nav = DOCS.map(([f, t]) =>
    `<a href="${f.replace(/\.md$/, '.html')}"${f === file ? ' class="here"' : ''}>${t}</a>`).join('');
  const tocHtml = toc.map((t) => `<li><a href="#${t.id}">${t.html}</a></li>`).join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(h1.replace(/[*`]/g, ''))}</title>
<style>
  :root{
    --bg:#ffffff; --ink:#1a1a1a; --ink-2:#444; --ink-3:#777; --rule:#e6e6e6;
    --accent:#1f4d7a; --accent-soft:#eef3f9; --code-bg:#f6f7f9; --quote:#f3f6fa;
    --mono:"SF Mono",ui-monospace,Menlo,Consolas,"DejaVu Sans Mono",monospace;
    --sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;
    --serif:Charter,"Iowan Old Style","Palatino Linotype",Georgia,serif;
  }
  *{box-sizing:border-box}
  html{scroll-behavior:smooth}
  body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--serif);
       font-size:17px;line-height:1.6;-webkit-font-smoothing:antialiased}
  header.top{position:sticky;top:0;z-index:5;background:rgba(255,255,255,.96);
       border-bottom:1px solid var(--rule);backdrop-filter:blur(6px)}
  header.top .in{max-width:1240px;margin:0 auto;padding:10px 16px;display:flex;gap:6px;
       flex-wrap:wrap;align-items:center;font-family:var(--sans);font-size:13px}
  header.top .brand{font-weight:650;letter-spacing:.02em;margin-right:14px;color:var(--ink)}
  header.top a{color:var(--ink-2);text-decoration:none;padding:5px 10px;border-radius:6px}
  header.top a:hover{background:var(--accent-soft);color:var(--accent)}
  header.top a.here{background:var(--accent);color:#fff}
  .wrap{max-width:1240px;margin:0 auto;padding:0 16px;display:grid;
        grid-template-columns:240px minmax(0,1fr);gap:48px}
  @media (max-width:960px){.wrap{grid-template-columns:1fr;gap:0}}
  nav.toc{position:sticky;top:52px;align-self:start;max-height:calc(100vh - 52px);overflow-y:auto;
          padding:28px 0 40px;font-family:var(--sans);font-size:13px;line-height:1.45}
  @media (max-width:960px){nav.toc{position:static;max-height:none;border-bottom:1px solid var(--rule)}}
  nav.toc .tag{font-size:10.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--ink-3);margin:0 0 10px}
  nav.toc ol{list-style:none;margin:0;padding:0}
  nav.toc li{margin:0 0 2px}
  nav.toc a{display:block;padding:4px 8px;color:var(--ink-2);text-decoration:none;border-radius:5px}
  nav.toc a:hover{background:var(--accent-soft);color:var(--accent)}
  nav.toc code{font-size:12px;background:none;padding:0}
  main{padding:28px 0 120px;min-width:0;max-width:900px}
  h1{font-size:38px;line-height:1.15;letter-spacing:-.018em;margin:8px 0 18px;font-weight:600}
  h2{font-family:var(--sans);font-size:15px;font-weight:650;letter-spacing:.05em;
     text-transform:uppercase;color:var(--accent);margin:64px 0 12px;padding-top:14px;
     border-top:1px solid var(--rule)}
  h3{font-size:21px;font-weight:600;margin:36px 0 8px;letter-spacing:-.005em}
  h4{font-family:var(--sans);font-size:15px;font-weight:650;margin:26px 0 6px}
  p,li{color:var(--ink)}
  a{color:var(--accent)}
  hr{border:0;border-top:1px solid var(--rule);margin:40px 0}
  code{font-family:var(--mono);font-size:.84em;background:var(--code-bg);padding:.12em .36em;border-radius:4px}
  a.doclink{text-decoration:none}
  a.doclink code{color:var(--accent);background:var(--accent-soft)}
  pre{font-family:var(--mono);background:var(--code-bg);border:1px solid var(--rule);border-radius:8px;
      padding:16px 18px;overflow-x:auto;margin:20px 0}
  pre code{background:none;padding:0;font-size:12.6px}
  pre.diagram{line-height:1.22;background:#fbfcfd}
  pre.diagram code{font-size:12.4px;color:#1d2b3a}
  pre.code{line-height:1.5}
  blockquote{margin:22px 0;padding:14px 20px;background:var(--quote);border-left:3px solid var(--accent);
             border-radius:0 8px 8px 0;color:var(--ink-2)}
  blockquote p{margin:.4em 0}
  .table-wrap{overflow-x:auto;margin:18px 0}
  table{border-collapse:collapse;width:100%;font-family:var(--sans);font-size:14px;line-height:1.45}
  th{text-align:left;font-weight:650;color:var(--ink-2);background:#fafafa;border-bottom:2px solid var(--rule);
     padding:8px 10px;vertical-align:bottom}
  td{border-bottom:1px solid var(--rule);padding:8px 10px;vertical-align:top}
  tr:hover td{background:#fcfcfd}
  strong{font-weight:650}
  main img{display:block;max-width:100%;height:auto;margin:22px 0;border:1px solid var(--rule);border-radius:12px}
  @media print{header.top,nav.toc{display:none}.wrap{display:block}}
</style>
</head>
<body>
<header class="top"><div class="in"><span class="brand">Generic Bank</span>${nav}</div></header>
<div class="wrap">
<nav class="toc"><p class="tag">Contents</p><ol>${tocHtml}</ol></nav>
<main>
${body}
</main>
</div>
</body>
</html>
`;
}

// Every render starts from an empty folder, so nothing stale survives.
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
// The diagrams, file by file (a recursive copy is refused on some Docker file shares).
const diagrams = path.join(PUB, 'diagrams');
if (fs.existsSync(diagrams)) {
  fs.mkdirSync(path.join(OUT, 'diagrams'), { recursive: true });
  for (const f of fs.readdirSync(diagrams))
    fs.copyFileSync(path.join(diagrams, f), path.join(OUT, 'diagrams', f));
}
for (const [f, t] of DOCS) fs.writeFileSync(path.join(OUT, f.replace(/\.md$/, '.html')), render(f, t));
fs.writeFileSync(
  path.join(OUT, 'index.html'),
  '<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0; url=GENERIC_BANK_PLAN.html"><title>Generic Bank: the plan</title><a href="GENERIC_BANK_PLAN.html">The plan</a>\n',
);
console.log(`  wrote ${DOCS.length} pages into .run/plan/`);
