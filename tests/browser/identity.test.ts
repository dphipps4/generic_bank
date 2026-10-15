import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Browser, HEADER_TELLS } from '../../packages/screen/src/index.js';

// The browser's fingerprint (plan, §5.1, §E.8, Appendix W), held to a reference capture from a real
// Mac. A page like the one the capture used reports, with its own script, what a page can see; the
// server records what a bank receives. Every field a page's scripts can see matches the capture, and
// so does every header; the one known difference is where Accept-Language sits (HEADER_TELLS).

const fixture = JSON.parse(
  readFileSync(new URL('../fixtures/browser/mac-chrome.json', import.meta.url), 'utf8'),
);
const IGNORED = new Set(['host', 'connection', 'referer', 'content-length', 'origin', 'cookie']);
// How a navigation started (a typed address or a bookmark, a link, another site) is not identity:
// Sec-Fetch-Site is none, same-origin or cross-site, and Sec-Fetch-User comes with a person's
// action. The capture's page was opened from another site.
const BY_NAVIGATION = new Set(['sec-fetch-site', 'sec-fetch-user']);

const PAGE = (frameFrom: string) => `<!doctype html><html><head><meta charset="utf-8"></head><body>
<iframe src="${frameFrom}/frame"></iframe>
<script>
(async () => {
  const gl = document.createElement('canvas').getContext('webgl');
  const dbg = gl && gl.getExtension('WEBGL_debug_renderer_info');
  const uad = navigator.userAgentData;
  const he = await uad.getHighEntropyValues(['platformVersion','architecture','bitness','model','fullVersionList','uaFullVersion','wow64']);
  const r = {
    userAgent: navigator.userAgent, platform: navigator.platform, vendor: navigator.vendor,
    languages: navigator.languages, language: navigator.language,
    hardwareConcurrency: navigator.hardwareConcurrency, deviceMemory: navigator.deviceMemory,
    webdriver: navigator.webdriver, maxTouchPoints: navigator.maxTouchPoints, pdfViewerEnabled: navigator.pdfViewerEnabled,
    plugins: Array.from(navigator.plugins).map(p => p.name),
    userAgentData: { brands: uad.brands, mobile: uad.mobile, platform: uad.platform, highEntropy: he },
    screen: { width: screen.width, height: screen.height, availWidth: screen.availWidth, availHeight: screen.availHeight, availTop: screen.availTop, colorDepth: screen.colorDepth, pixelDepth: screen.pixelDepth },
    devicePixelRatio: window.devicePixelRatio,
    webgl: dbg ? { vendor: gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL), renderer: gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) } : null,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    locale: Intl.DateTimeFormat().resolvedOptions().locale,
  };
  await fetch('/report', { method: 'POST', body: JSON.stringify(r) });
})();
</script></body></html>`;

interface Seen {
  path: string;
  headers: [string, string][];
}
let main: Server;
let other: Server;
const seen: Seen[] = [];
let report: Record<string, unknown> | null = null;

function record(req: IncomingMessage) {
  const pairs: [string, string][] = [];
  for (let i = 0; i < req.rawHeaders.length; i += 2)
    pairs.push([req.rawHeaders[i]!.toLowerCase(), req.rawHeaders[i + 1]!]);
  seen.push({ path: req.url ?? '', headers: pairs });
}

function serve(handler: (req: IncomingMessage, body: string) => [number, string, string]) {
  return new Promise<Server>((done) => {
    const s = createServer((req, res) => {
      let body = '';
      req
        .on('data', (c) => (body += c))
        .on('end', () => {
          record(req);
          const [code, type, out] = handler(req, body);
          res.writeHead(code, {
            'content-type': type,
            'accept-ch':
              'Sec-CH-UA-Platform-Version, Sec-CH-UA-Arch, Sec-CH-UA-Bitness, Sec-CH-UA-Model, Sec-CH-UA-Full-Version-List, Sec-CH-UA-WoW64',
          });
          res.end(out);
        });
    }).listen(0, '127.0.0.1', () => done(s));
  });
}

let browser: Browser;
let mainUrl = '';
beforeAll(async () => {
  other = await serve(() => [200, 'text/html', '<p>frame</p>']);
  const otherUrl = `http://localhost:${(other.address() as AddressInfo).port}`;
  main = await serve((req, body) => {
    if (req.url === '/report') report = JSON.parse(body);
    return req.url === '/report' ? [204, 'text/plain', ''] : [200, 'text/html', PAGE(otherUrl)];
  });
  mainUrl = `http://127.0.0.1:${(main.address() as AddressInfo).port}`;
  browser = await Browser.launch({ timezone: fixture.page.timezone });
  const page = await browser.newPage();
  // Twice: the second load carries the detailed client hints the first one asked for.
  await page.goto(`${mainUrl}/`);
  await page.goto(`${mainUrl}/again`);
  for (let i = 0; i < 50 && !report; i++) await new Promise((r) => setTimeout(r, 100));
  await page.close();
}, 60_000);
afterAll(async () => {
  await browser?.close();
  main?.close();
  other?.close();
});

// Version numbers are compared as the browser's own, so the capture holds across Chrome releases.
const versions = (s: string) => s.replace(/\b1\d\d(\.\d+\.\d+\.\d+)?\b/g, 'V');
const names = (h: [string, string][]) => h.map(([k]) => k).filter((k) => !IGNORED.has(k));
// Every header's value, and their order; the known tells are compared by value, not by place.
const tell = (k: string) => (HEADER_TELLS as readonly string[]).includes(k);
const values = (h: [string, string][]) =>
  h
    .filter(([k]) => !IGNORED.has(k) && !BY_NAVIGATION.has(k))
    .sort(([a], [b]) => Number(tell(a)) - Number(tell(b)))
    .map(([k, v]) => [k, versions(v)]);
const get = (o: unknown, path: string) =>
  path.split('.').reduce<unknown>((v, k) => (v as Record<string, unknown>)?.[k], o);
const flatten = (o: Record<string, unknown>, prefix = ''): string[] =>
  Object.entries(o).flatMap(([k, v]) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? flatten(v as Record<string, unknown>, `${prefix}${k}.`)
      : [`${prefix}${k}`],
  );

describe('the browser presents Chrome on a Mac', () => {
  it('sends a page load’s headers exactly as the Mac did, in the same order', () => {
    const first = seen.find((r) => r.path === '/')!;
    const again = seen.find((r) => r.path === '/again')!;
    expect(values(first.headers)).toEqual(values(fixture.navigation));
    expect(values(again.headers)).toEqual(values(fixture.navigationWithHints));
  });

  it('gives a frame from another origin the same identity, from its first request', () => {
    const frame = seen.find((r) => r.path === '/frame')!;
    const h = Object.fromEntries(frame.headers);
    expect(h['user-agent']).toBe(get(report, 'userAgent'));
    expect(h['sec-ch-ua-platform']).toBe('"macOS"');
    expect(h['accept-language']).toBe('en-US,en;q=0.9');
    expect(names(frame.headers)).toContain('sec-fetch-dest');
  });

  it('shows a page’s scripts exactly what the Mac showed', () => {
    const differ = flatten(fixture.page)
      .filter((p) => {
        const want = get(fixture.page, p);
        const got = get(report, p);
        return versions(JSON.stringify(want)) !== versions(JSON.stringify(got));
      })
      .map((p) => (p.startsWith('webgl.') ? 'webgl' : p));
    expect([...new Set(differ)]).toEqual([]);
  });
});
