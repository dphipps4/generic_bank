import { randomBytes } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import { esc, palette } from './markup/html.js';
import type { Tenant } from './tenants.js';

// Banks 2, 3 and 4 judge the browser before the password, the way a real bank's bot manager
// does: anything not shaped like a person's browser is answered "403 Access denied" before any
// page. The screen reads only the request's headers (plan, §5.1, Appendix C.4 and Appendix W).

/** Headers Node's own connection handling may add; they say nothing about the client. */
const CONNECTION = new Set(['connection', 'keep-alive', 'proxy-connection']);

/** Every real browser sends these on every request. */
const EVERY_BROWSER = ['accept-language', 'sec-fetch-mode', 'sec-fetch-dest'] as const;

/** Why this request is not a browser's, or null when it is shaped like one. */
export function botReason(h: IncomingHttpHeaders): string | null {
  const ua = String(h['user-agent'] ?? '');
  if (/^curl\//i.test(ua)) return 'curl user agent';
  // curl's whole request: Host, User-Agent and Accept: */*, and nothing else (Appendix W.5).
  const names = Object.keys(h).filter((n) => !CONNECTION.has(n));
  const curlShape = ['accept', 'host', 'user-agent'];
  if (
    names.length === curlShape.length &&
    curlShape.every((n) => names.includes(n)) &&
    h.accept === '*/*'
  )
    return 'curl request';
  if (ua.includes('HeadlessChrome')) return 'headless user agent';
  const missing = EVERY_BROWSER.find((n) => h[n] === undefined);
  if (missing) return `no ${missing}`;
  const platform = h['sec-ch-ua-platform'];
  if (ua.includes('Macintosh') && platform !== undefined && platform !== '"macOS"')
    return `platform hint ${String(platform)} on a Mac user agent`;
  if (h['sec-ch-ua-mobile'] === '?1' && !ua.includes('Mobile'))
    return 'mobile hint on a desktop user agent';
  return null;
}

/** A short reference a person can quote, as a bot manager's refusal page gives. */
export const reference = () => randomBytes(4).toString('hex').toUpperCase();

/** The refusal page, in the bank's colors. It gives the reference and never the reason. */
export function accessDenied(t: Tenant, ref: string): string {
  const p = palette(t);
  const f = (s: string, extra = '') =>
    `<FONT FACE="${p.face}" SIZE="${p.size}"${extra}>${s}</FONT>`;
  return `<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN">
<HTML><HEAD><TITLE>Access denied - ${esc(t.brand)}</TITLE>
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=utf-8"></HEAD>
<BODY BGCOLOR="${p.body}" TEXT="#000000" LEFTMARGIN="8" TOPMARGIN="8"><CENTER>
<TABLE BORDER="0" CELLPADDING="6" CELLSPACING="0" WIDTH="620" BGCOLOR="${p.panel}"><TR><TD>
<TABLE WIDTH="100%" CELLPADDING="3" CELLSPACING="0" BORDER="0"><TR><TD BGCOLOR="${p.head}">${f(`<B>Access denied</B>`, ` COLOR="${p.headText}"`)}</TD></TR></TABLE>
<P>${f(`You don't have permission to access this page.`)}</P>
<P>${f(`Reference #${esc(ref)}`, ' SIZE="1" COLOR="#555555"')}</P>
</TD></TR></TABLE></CENTER></BODY></HTML>`;
}
