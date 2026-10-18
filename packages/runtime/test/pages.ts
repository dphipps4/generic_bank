// Synthetic pages, each with one legacy trouble the runtime must handle. No bank code: these are
// the shapes the evidence showed, written small.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

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

  // A badge that a script recolours forever, through seven colours every 200 ms, so no two
  // pictures 700 ms apart are alike; beside it, a link: the page is ready all the same.
  '/blink': doc(
    `<a href="/blink">Statements</a> <span id="b" style="color:#fff">NEW!</span>`,
    `<script>var n=0,c=['#f60','#c00','#090','#00c','#909','#099','#990'];setInterval(function(){document.getElementById('b').style.background=c[n++%7]},200)</script>`,
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

  // The same link twice: in the nav, and in the section a person means.
  '/twice': doc(
    `<div style="float:left;width:150px"><a href="#" onclick="document.getElementById('out').textContent='from the nav'">Transfer Funds</a></div>
     <div style="margin-left:300px"><b>Member Summary</b><br><a href="#" onclick="document.getElementById('out').textContent='from the summary'">Transfer Funds</a></div>
     <p id="out">nothing yet</p>`,
  ),

  // An error page: words, and nothing to act on. It is a page all the same.
  '/unavailable': doc(`<h1>Service Unavailable</h1><p>Please try again later.</p>`),

  // A page that moves on by itself as it is being looked at.
  '/moves-on': doc(
    `<p>One moment</p>`,
    `<script>setTimeout(function(){location.href='/label'},300)</script>`,
  ),

  // A submit the bank swallowed: it says it is processing, forever.
  '/processing': doc(
    `<p>Processing your request… please wait.</p><a href="/processing">Refresh</a>`,
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
     <a href="/mask?token=abc123">Account 40017732</a>
     <p id="member">Member 40017732 · J. Doe</p>
     <form><input type="image" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width="60" height="20"></form>`,
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
