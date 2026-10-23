// Replit's `just show`: ACCESS.html, the page with every address and login, served to Replit's
// Preview pane. The preview address answers only the app's owner, signed in to Replit, so the
// logins stay theirs. Each link on the page opens in a tab of its own, outside the pane.
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import process from 'node:process';

const port = Number(process.env.PORT ?? 8090);
createServer(async (_req, res) => {
  const page = await readFile('ACCESS.html', 'utf8').catch(() => null);
  res.writeHead(page ? 200 : 503, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(
    page ??
      '<!doctype html><meta http-equiv="refresh" content="3"><p>Generic Bank is starting. This page appears once the banks are up.</p>',
  );
}).listen(port, '0.0.0.0');
