// Synthetic pages, each with one legacy trouble the runtime must handle. No bank code: these are
// the shapes the evidence showed, written small.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PNG } from 'pngjs';

/** A small PNG of stripes, so two different ones have different fingerprints. */
function stripes(vertical: boolean): string {
  const img = new PNG({ width: 90, height: 20 });
  for (let y = 0; y < 20; y++)
    for (let x = 0; x < 90; x++) {
      const on = vertical ? Math.floor(x / 6) % 2 === 0 : x < 45;
      img.data.fill(on ? 0 : 255, (y * 90 + x) * 4, (y * 90 + x) * 4 + 3);
      img.data[(y * 90 + x) * 4 + 3] = 255;
    }
  return `data:image/png;base64,${PNG.sync.write(img).toString('base64')}`;
}

const doc = (body: string, head = '') =>
  `<!doctype html><html><head><meta charset="utf-8">${head}</head><body style="font:14px Arial;margin:8px">${body}</body></html>`;

export const PAGES: Record<string, string> = {
  '/frames': `<!doctype html><html><frameset cols="200,*"><frame name="nav" src="/nav"><frame name="main" src="/main-a"></frameset></html>`,
  '/nav': doc(`<a href="/main-b" target="main">Member Search</a>`),
  '/main-a': doc(`<p>Welcome</p><a href="/main-a">Home</a>`),
  '/main-b': doc(`<p>Search for a member</p><a href="/main-b">Again</a>`),

  // A label in a cell of its own, the box beside it with no name, and a decoy box far below.
  '/label': doc(
    `<table><tr><td>Member number:</td><td><input id="m"></td></tr></table>
     <div style="height:200px"></div><table><tr><td>Notes</td><td><input id="decoy"></td></tr></table>`,
  ),

  // A "button" that is styled text with a click handler, beside a real submit.
  '/font': doc(
    `<font style="border:2px outset #ccc;padding:2px 8px;background:#eee;cursor:pointer"
       onclick="document.getElementById('out').textContent='font pressed'">Search</font>
     <input type="submit" value="Send" onclick="document.getElementById('out').textContent='send pressed'">
     <p id="out">nothing yet</p>`,
  ),

  // A marquee that never stops, and a page ready all the same.
  '/marquee': doc(
    `<marquee scrollamount="20">Branch hours are 9 to 5</marquee><button>Ready</button>`,
  ),

  // Blank and still for two seconds, then drawn: blank is not ready.
  '/late': doc(
    `<div id="x"></div>`,
    `<script>setTimeout(function(){document.getElementById('x').innerHTML='<button>Go</button>'},2000)</script>`,
  ),

  // A hidden twin and a zero-size twin of the visible button.
  '/hidden': doc(
    `<button style="display:none">Save</button><button style="width:0;height:0;padding:0;border:0;overflow:hidden">Save</button>
     <button onclick="document.getElementById('out').textContent='saved'">Save</button><p id="out">not saved</p>`,
  ),

  // A visible button with something drawn over it.
  '/covered': doc(
    `<button id="b" style="position:absolute;left:20px;top:20px">Pay</button>
     <div style="position:absolute;left:0;top:0;width:300px;height:100px;background:rgba(0,0,0,.4)"></div>`,
  ),

  // A surprise confirm as the page loads.
  '/confirm': doc(
    `<p>Done</p><a href="/confirm">Again</a>`,
    `<script>confirm('Leave unsaved changes?')</script>`,
  ),

  // Money and a name as loose text in a cell; a long number in a link.
  '/mask': doc(
    `<table><tr><td>Current balance: $41,231.65 for Alex Sample</td></tr></table>
     <a href="/mask?token=abc123">Account 40017732</a>`,
  ),

  // Two pictures of text.
  '/pictures': doc(
    `<img src="${stripes(true)}"><br><img src="${stripes(false)}"><br><a href="/pictures">Again</a>`,
  ),
};

export async function serve(): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const page = PAGES[(req.url ?? '/').split('?')[0]!];
    res.writeHead(page ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
    res.end(page ?? 'not found');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((r) => server.close(() => r())),
  };
}
