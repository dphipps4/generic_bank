// Serves one folder of static pages on this machine only, and opens it in Chrome: the API
// reference reads openapi.json beside it, which a file:// page cannot fetch.
import { createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import process from 'node:process';
import { URL } from 'node:url';

const [dir = 'docs/api', port = '8099'] = process.argv.slice(2);
const root = resolve(dir);
const types = {
  '.html': 'text/html',
  '.json': 'application/json',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.svg': 'image/svg+xml',
};

createServer((req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname));
  let file = join(root, path);
  if (!file.startsWith(root)) return void res.writeHead(403).end();
  try {
    if (statSync(file).isDirectory()) file = join(file, 'index.html');
    statSync(file);
  } catch {
    return void res.writeHead(404).end('not found');
  }
  res.writeHead(200, {
    'content-type': types[extname(file)] ?? 'application/octet-stream',
    'cache-control': 'no-store',
  });
  createReadStream(file).pipe(res);
}).listen(Number(port), '127.0.0.1', () => {
  const url = `http://localhost:${port}/`;
  process.stdout.write(`  serving ${dir} at ${url} (Ctrl-C to stop)\n`);
  execFile('open', ['-a', 'Google Chrome', url], (e) => e && execFile('open', [url], () => {}));
});
