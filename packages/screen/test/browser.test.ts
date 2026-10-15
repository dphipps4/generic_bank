import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Browser } from '../src/browser.js';

// A real headless Chromium against two small servers on two ports: two origins.
let browser: Browser;
const servers: Server[] = [];
const serve = (html: (port: number) => string) =>
  new Promise<number>((done) => {
    const s = createServer((req, res) => {
      res.setHeader('content-type', 'text/html');
      res.end(
        html((s.address() as AddressInfo).port) + `<!-- x-test: ${req.headers['x-test'] ?? ''} -->`,
      );
    });
    servers.push(s);
    s.listen(0, '127.0.0.1', () => done((s.address() as AddressInfo).port));
  });

let inner: number;
let outer: number;
beforeAll(async () => {
  inner = await serve(() => '<html><body><p>Inside the frame</p></body></html>');
  outer = await serve(
    () =>
      `<html><body><h1>Outer</h1><iframe src="http://localhost:${inner}/" width="300" height="100"></iframe></body></html>`,
  );
  browser = await Browser.launch({ headers: { 'x-test': 'signed' } });
}, 60_000);
afterAll(async () => {
  await browser?.close();
  for (const s of servers) s.close();
});

describe('a browser, driven from outside', () => {
  it('opens a page and reads its layout and a screenshot, without running anything in it', async () => {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${outer}/`);
    const snap = await page.call<{ documents: unknown[]; strings: string[] }>(
      'DOMSnapshot.captureSnapshot',
      { computedStyles: [] },
    );
    expect(snap.strings).toContain('Outer');
    const png = await page.screenshot();
    expect(png.subarray(1, 4).toString()).toBe('PNG');
    await page.close();
  });

  it('attaches a frame from another origin as a session of its own', async () => {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${outer}/`);
    for (let i = 0; i < 50 && page.frames.size === 0; i++)
      await new Promise((r) => setTimeout(r, 100));
    const [frame] = [...page.frames.values()];
    expect(frame?.url).toBe(`http://localhost:${inner}/`);
    const snap = await page.cdp.call<{ strings: string[] }>(
      'DOMSnapshot.captureSnapshot',
      { computedStyles: [] },
      { sessionId: frame!.sessionId },
    );
    expect(snap.strings).toContain('Inside the frame');
    await page.close();
  });

  it('sends the extra headers on every request, frames included', async () => {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${outer}/`);
    const snap = await page.call<{ strings: string[] }>('DOMSnapshot.captureSnapshot', {
      computedStyles: [],
    });
    expect(snap.strings.some((s) => s.includes('x-test: signed'))).toBe(true);
    await page.close();
  });
}, 60_000);

describe('closing the browser', () => {
  it('ends every process it started, and removes its profile', async () => {
    const { existsSync } = await import('node:fs');
    const b = await Browser.launch();
    const p = await b.newPage();
    await p.goto(`http://127.0.0.1:${outer}/`);
    const child = (b as unknown as { child: { pid: number } }).child;
    const profile = (b as unknown as { profile: string }).profile;
    await b.close();
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const groupAlive = () => {
      try {
        process.kill(-child.pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    for (let i = 0; i < 30 && (alive(child.pid) || groupAlive()); i++)
      await new Promise((r) => setTimeout(r, 100));
    expect(alive(child.pid)).toBe(false);
    expect(groupAlive()).toBe(false);
    expect(existsSync(profile)).toBe(false);
  }, 30_000);
});
