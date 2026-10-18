// ACCESS.md as a page to read in a browser: the same content, styled, with a Copy button beside
// every value in a table. Only the Markdown ACCESS.md uses: headings, paragraphs, tables, lists,
// bold, code and links. Usage: node access-html.mjs ACCESS.md ACCESS.html
import { readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import { URL } from 'node:url';

const [src = 'ACCESS.md', out = 'ACCESS.html'] = process.argv.slice(2);
const md = readFileSync(src, 'utf8');

/** One named tab per local app (by port): a second click goes to the tab already open. */
const tab = (url) => `gb-${new URL(url).port || '80'}`;

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Bold, code and links, within one line; in a table, each code value gets a Copy button. */
function inline(text, copy = false) {
  const parts = text.split(/(`[^`]+`)/);
  return parts
    .map((p) => {
      if (p.startsWith('`') && p.endsWith('`') && p.length > 1) {
        const v = p.slice(1, -1);
        if (!copy) return `<code>${esc(v)}</code>`;
        return `<code>${esc(v)}</code><button class="copy" data-v="${esc(v).replace(/"/g, '&quot;')}" title="Copy">Copy</button>`;
      }
      return esc(p)
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
        .replace(
          /(^|[\s(])(https?:\/\/[^\s)<|]+)/g,
          (_, pre, url) => `${pre}<a href="${url}" target="${tab(url)}">${url}</a>`,
        );
    })
    .join('');
}

const lines = md.split('\n');
const html = [];
let title = 'Access';
for (let i = 0; i < lines.length;) {
  const line = lines[i];
  if (!line.trim()) {
    i++;
    continue;
  }
  const h = /^(#{1,3}) (.*)$/.exec(line);
  if (h) {
    if (h[1] === '#') title = h[2];
    html.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`);
    i++;
    continue;
  }
  if (line.startsWith('|')) {
    const rows = [];
    while (i < lines.length && lines[i].startsWith('|')) rows.push(lines[i++]);
    const cells = (r) =>
      r
        .replace(/^\||\|$/g, '')
        .split('|')
        .map((c) => c.trim());
    const body = rows.filter((r) => !/^\|[\s|:-]+\|$/.test(r));
    const [head, ...rest] = body;
    html.push(
      `<div class="table"><table><thead><tr>${cells(head)
        .map((c) => `<th>${inline(c)}</th>`)
        .join('')}</tr></thead><tbody>${rest
        .map(
          (r) =>
            `<tr>${cells(r)
              .map((c) => `<td>${inline(c, true)}</td>`)
              .join('')}</tr>`,
        )
        .join('')}</tbody></table></div>`,
    );
    continue;
  }
  const item = /^(\s*)(\d+\.|[-*]) (.*)$/;
  if (item.test(line)) {
    const ordered = /^\s*\d+\./.test(line);
    const items = [];
    while (i < lines.length && item.test(lines[i])) items.push(item.exec(lines[i++])[3]);
    const tag = ordered ? 'ol' : 'ul';
    html.push(`<${tag}>${items.map((t) => `<li>${inline(t)}</li>`).join('')}</${tag}>`);
    continue;
  }
  const para = [];
  while (i < lines.length && lines[i].trim() && !/^(#|\||\s*(\d+\.|[-*]) )/.test(lines[i]))
    para.push(lines[i++]);
  html.push(`<p>${inline(para.join(' '))}</p>`);
}

writeFileSync(
  out,
  `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--ink:#1b2430;--soft:#5b6675;--line:#e1e5ea;--accent:#1f6f5c;--code:#eef2f5}
@media (prefers-color-scheme: dark){:root{--bg:#14181d;--card:#1c2229;--ink:#e6eaef;--soft:#9aa6b2;--line:#2c343d;--accent:#5cc3a6;--code:#242c35}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}
main{max-width:1040px;margin:0 auto;padding:32px 16px 64px}
h1{font-size:30px;margin:0 0 8px}
h2{font-size:15px;text-transform:uppercase;letter-spacing:.06em;color:var(--accent);margin:36px 0 12px}
p{margin:0 0 14px;color:var(--soft)}
p strong{color:var(--ink)}
a{color:var(--accent)}
.table{overflow-x:auto;margin:0 0 16px;background:var(--card);border:1px solid var(--line);border-radius:10px}
table{width:100%;border-collapse:collapse}
th,td{text-align:left;vertical-align:top;padding:10px 14px;border-top:1px solid var(--line)}
thead th{border-top:0;font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:var(--soft);background:var(--code)}
code{font:14px ui-monospace,Menlo,monospace;background:var(--code);padding:2px 6px;border-radius:5px;overflow-wrap:anywhere}
button.copy{margin-left:6px;font:12px -apple-system,sans-serif;padding:2px 8px;border:1px solid var(--line);border-radius:5px;background:var(--card);color:var(--soft);cursor:pointer}
button.copy:hover{color:var(--accent);border-color:var(--accent)}
button.copy.done{color:var(--accent)}
ol,ul{margin:0 0 16px;padding-left:22px}li{margin:6px 0}
</style></head><body><main>
${html.join('\n')}
</main>
<script>
document.addEventListener('click', function (e) {
  var b = e.target.closest('button.copy'); if (!b) return;
  var v = b.getAttribute('data-v');
  function done() { b.textContent = 'Copied'; b.classList.add('done'); setTimeout(function () { b.textContent = 'Copy'; b.classList.remove('done'); }, 1500); }
  if (navigator.clipboard) navigator.clipboard.writeText(v).then(done, fallback); else fallback();
  function fallback() { var t = document.createElement('textarea'); t.value = v; document.body.appendChild(t); t.select(); document.execCommand('copy'); t.remove(); done(); }
});
</script>
</body></html>
`,
);
