import { readdirSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Browser, type Page } from '../src/browser.js';
import { readScreen, type ScreenModel } from '../src/model.js';

// Small pages with the traits of the banks: legacy markup, hidden twins, covered controls,
// content drawn by the page's own script, framesets, and a frame from another origin.
const PAGES: Record<string, string> = {
  '/form': `<HTML><BODY>
<TABLE><TR><TD><TABLE><TR><TD>
<FORM><TABLE>
<TR><TD><FONT>Operator ID:</FONT></TD><TD><INPUT TYPE="text" NAME="f1" VALUE="secret-value-123"></TD></TR>
<TR><TD><B><FONT>Password:</FONT></B></TD><TD><INPUT TYPE="password" NAME="f2"></TD></TR>
<TR><TD></TD><TD><SELECT NAME="f3"><OPTION VALUE="1">Everyday Checking</OPTION><OPTION VALUE="2">Rainy Day Savings</OPTION></SELECT></TD></TR>
<TR><TD></TD><TD><INPUT TYPE="checkbox" NAME="f4" CHECKED> <FONT>Trust this workstation</FONT></TD></TR>
<TR><TD></TD><TD><INPUT TYPE="image" SRC="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" ALT="Sign In" WIDTH="80" HEIGHT="22"></TD></TR>
<TR><TD></TD><TD><A HREF="javascript:void(0)" ONCLICK="return false"><FONT><B>Continue</B></FONT></A></TD></TR>
<TR><TD></TD><TD><TABLE><TR><TD ONCLICK="void 0" STYLE="border:2px outset #ddd;padding:2px 10px">Submit transfer</TD></TR></TABLE></TD></TR>
<TR><TD></TD><TD><BUTTON TYPE="submit" DISABLED>Approve</BUTTON></TD></TR>
</TABLE></FORM></TD></TR></TABLE></TD></TR></TABLE>
</BODY></HTML>`,
  '/hidden': `<HTML><BODY>
<DIV STYLE="display:none"><BUTTON>Sign In</BUTTON></DIV>
<BUTTON STYLE="visibility:hidden">Sign In</BUTTON>
<BUTTON STYLE="opacity:0">Sign In</BUTTON>
<BUTTON STYLE="width:0;height:0;padding:0;border:0;overflow:hidden">Sign In</BUTTON>
<BUTTON STYLE="position:absolute;left:-500px">Sign In</BUTTON>
<BUTTON>Sign In</BUTTON>
<DIV STYLE="height:60px"></DIV>
<DIV STYLE="position:relative;display:inline-block"><BUTTON>Covered</BUTTON>
<DIV STYLE="position:absolute;left:0;top:0;right:0;bottom:0;background:transparent"></DIV></DIV>
</BODY></HTML>`,
  '/drawn': `<HTML><BODY><DIV CLASS="box"></DIV>
<SCRIPT>setTimeout(function(){ document.getElementsByTagName('div')[0].innerHTML = '<a href="/x">Account ending in 7890</a>'; }, 50);</SCRIPT>
</BODY></HTML>`,
  '/frames': `<HTML><FRAMESET ROWS="80,*"><FRAME SRC="/banner" NAME="banner"><FRAMESET COLS="200,*"><FRAME SRC="/nav" NAME="nav"><FRAME SRC="/form" NAME="main"></FRAMESET></FRAMESET></HTML>`,
  '/banner': `<HTML><BODY><B>Generic Bank</B></BODY></HTML>`,
  '/nav': `<HTML><BODY><A HREF="/form" TARGET="main">Member Search</A></BODY></HTML>`,
};

let browser: Browser;
let base: string;
let other: string;
const servers: Server[] = [];
const listen = (handler: (path: string) => string) =>
  new Promise<string>((done) => {
    const s = createServer((req, res) => {
      res.setHeader('content-type', 'text/html');
      res.end(handler(req.url ?? '/'));
    });
    servers.push(s);
    s.listen(0, '127.0.0.1', () => done(`${(s.address() as AddressInfo).port}`));
  });

beforeAll(async () => {
  const otherPort = await listen(
    () =>
      '<HTML><BODY><FORM><INPUT TYPE="password"> <BUTTON>Continue</BUTTON></FORM></BODY></HTML>',
  );
  other = `http://localhost:${otherPort}/`;
  const port = await listen((p) =>
    p === '/xorigin'
      ? `<HTML><BODY><H1>Shell</H1><IFRAME SRC="${other}" WIDTH="400" HEIGHT="120" STYLE="margin-left:50px"></IFRAME></BODY></HTML>`
      : (PAGES[p] ?? 'not found'),
  );
  base = `http://127.0.0.1:${port}`;
  browser = await Browser.launch();
}, 60_000);
afterAll(async () => {
  await browser?.close();
  for (const s of servers) s.close();
});

async function read(path: string, settle = 300): Promise<{ m: ScreenModel; page: Page }> {
  const page = await browser.newPage();
  await page.goto(`${base}${path}`);
  await new Promise((r) => setTimeout(r, settle));
  return { m: await readScreen(page), page };
}
const named = (m: ScreenModel, name: string) => m.controls.filter((c) => c.name === name);

describe('the screen model', () => {
  it('reads legacy controls with their roles, names and state, but never their values', async () => {
    const { m, page } = await read('/form');
    const roles = m.controls.map((c) => `${c.role}:${c.name}`);
    expect(roles).toEqual(
      expect.arrayContaining([
        'textbox:',
        'password:',
        'checkbox:',
        'image-button:Sign In',
        'link:Continue',
        'clickable:Submit transfer',
        'button:Approve',
      ]),
    );
    expect(m.controls.find((c) => c.role === 'textbox')!.hasValue).toBe(true);
    expect(m.controls.find((c) => c.role === 'checkbox')!.checked).toBe(true);
    expect(m.controls.find((c) => c.role === 'select')!.options).toEqual([
      'Everyday Checking',
      'Rainy Day Savings',
    ]);
    expect(named(m, 'Approve')[0]!.enabled).toBe(false);
    expect(JSON.stringify({ ...m, screenshot: undefined })).not.toContain('secret-value-123');
    expect(m.texts.map((t) => t.text)).toEqual(
      expect.arrayContaining(['Operator ID:', 'Password:']),
    );
    await page.close();
  });

  it('gives stable references top to bottom, and the same structure key when nothing changed', async () => {
    const { m, page } = await read('/form');
    expect(m.controls.map((c) => c.ref)).toEqual(m.controls.map((_, i) => `c${i + 1}`));
    const ys = m.controls.map((c) => c.box.y);
    expect([...ys].sort((a, b) => a - b)).toEqual(ys);
    expect((await readScreen(page)).structureKey).toBe(m.structureKey);
    await page.close();
  });

  it('keeps only the one visible, uncovered button: hidden twins and covered controls are not in it', async () => {
    const { m, page } = await read('/hidden');
    expect(named(m, 'Sign In')).toHaveLength(1);
    expect(named(m, 'Covered')).toHaveLength(0);
    expect(m.dropped).toBeGreaterThanOrEqual(5);
    await page.close();
  });

  it('sees what the page’s own script drew', async () => {
    const { m, page } = await read('/drawn', 400);
    expect(named(m, 'Account ending in 7890')).toHaveLength(1);
    await page.close();
  });

  it('flattens a frameset into one picture in page coordinates', async () => {
    const { m, page } = await read('/frames', 600);
    const search = named(m, 'Member Search')[0]!;
    const password = m.controls.find((c) => c.role === 'password')!;
    expect(search.box.y).toBeGreaterThanOrEqual(80);
    expect(password.box.x).toBeGreaterThanOrEqual(200);
    expect(password.box.y).toBeGreaterThanOrEqual(80);
    expect(m.texts.some((t) => t.text === 'Generic Bank' && t.box.y < 80)).toBe(true);
    await page.close();
  });

  it('reads a frame from another origin through its own session, placed where it is drawn', async () => {
    const { m, page } = await read('/xorigin', 800);
    const pw = m.controls.find((c) => c.role === 'password');
    expect(pw).toBeDefined();
    expect(pw!.box.x).toBeGreaterThanOrEqual(50);
    expect(m.frames.find((f) => f.url === other)?.readable).toBe(true);
    expect(named(m, 'Continue')).toHaveLength(1);
    await page.close();
  });
});

describe('reading from outside', () => {
  it('never runs script in the page: no method that evaluates code is called anywhere in the screen package', () => {
    const dir = join(import.meta.dirname, '../src');
    const src = readdirSync(dir)
      .map((f) => readFileSync(join(dir, f), 'utf8'))
      .join('\n');
    for (const m of [
      'Runtime.evaluate',
      'Runtime.callFunctionOn',
      'Page.addScriptToEvaluateOnNewDocument',
      'Runtime.compileScript',
      'Page.createIsolatedWorld',
    ]) {
      expect(src, m).not.toContain(m);
    }
  });
});
