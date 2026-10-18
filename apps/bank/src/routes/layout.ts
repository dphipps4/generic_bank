import type { FastifyInstance } from 'fastify';
import { type Bank, ctxOf, current } from '../context.js';
import { dialect } from '../markup/dialect.js';
import { type Ctx, doc, esc, font, js, linkButton, palette } from '../markup/html.js';
import { html } from './frame.js';

// The console's shape, a tenant setting. Both shapes offer the same places to go; only how they
// are laid out differs: a nav frame or a tab strip. After the vendor's redesign, every bank has
// one shape: a single Menu at the top right, the notices on the left.

interface NavItem {
  href: string;
  text: string;
  group: 'members' | 'money' | 'out';
  isNew?: boolean;
}

export function navItems(bank: Bank): NavItem[] {
  const base = bank.t.basePath;
  const L = bank.t.labels;
  return [
    { href: `${base}members/search`, text: L.memberSearch, group: 'members' },
    { href: `${base}members/search?next=transfer`, text: L.transferFunds, group: 'money' },
    {
      href: `${base}members/search?next=statements`,
      text: L.statements,
      group: 'money',
      isNew: true,
    },
    { href: `${base}signout`, text: 'Sign Out', group: 'out' },
  ];
}

const target = (i: NavItem) => (i.group === 'out' ? '_top' : 'main');
const newGif = (base: string) =>
  ` <IMG SRC="${base}img/new.svg" WIDTH="34" HEIGHT="14" ALT="NEW!">`;

function frameset(bank: Bank): string {
  const base = bank.t.basePath;
  const f = (src: string, name: string, extra = '') =>
    `<FRAME SRC="${base}${src}" NAME="${name}"${extra}>`;
  const banner = f('frame/banner', 'banner', ' SCROLLING="no" NORESIZE');
  const body =
    bank.t.layout === 'nav'
      ? `<FRAMESET ROWS="84,*" BORDER="1">${banner}<FRAMESET COLS="230,*">${f('frame/nav', 'nav')}${f('home', 'main')}</FRAMESET></FRAMESET>`
      : `<FRAMESET ROWS="84,52,*" BORDER="0">${banner}${f('frame/tabs', 'tabs', ' SCROLLING="no" NORESIZE')}${f('home', 'main')}</FRAMESET>`;
  return `<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Frameset//EN">
<HTML><HEAD><TITLE>CoreLink Branch Console - ${esc(bank.t.brand)}</TITLE></HEAD>
${body}</HTML>`;
}

const NOTICES = [
  'Lobby hours change next Monday.',
  'Verify photo ID for every withdrawal over $5,000.',
  'The rate sheet was updated this morning.',
];

/**
 * The redesign's console, the same for every bank: one Menu at the top right that opens on click
 * and holds every place to go, the notices in a column on the left, the main page on the right.
 */
function refreshedPage(bank: Bank, c: Ctx, operator: string): string {
  const base = bank.t.basePath;
  const p = palette(bank.t);
  const d = dialect(bank.t, bank.uiVersion, 'refreshed-console');
  const items = navItems(bank)
    .map(
      (i) =>
        `<A HREF="${i.href}" TARGET="${target(i)}" STYLE="display:block;padding:6px 12px;color:#000;text-decoration:none">${esc(i.text)}</A>`,
    )
    .join('');
  const menu = `<TD ALIGN="right" STYLE="position:relative;padding:8px 14px;cursor:pointer" ONCLICK="CL.menu(this)">${font(c, '<B>Menu &#9662;</B>', ` COLOR="${p.headText}"`)}<DIV CLASS="${d.cls('menu')}" STYLE="display:none;position:absolute;right:0;top:32px;text-align:left;background:#FFF;border:1px solid #999;min-width:200px;z-index:5">${items}</DIV></TD>`;
  const bar = `<TABLE WIDTH="100%" CELLPADDING="0" CELLSPACING="0" BORDER="0" BGCOLOR="${p.head}"><TR>
<TD STYLE="padding:8px 12px">${font(c, `<B>${esc(bank.t.brand)}</B> &middot; Online Banking`, ` COLOR="${p.headText}"`)}</TD>
<TD ALIGN="right" STYLE="padding:8px 4px">${font(c, esc(operator), ` COLOR="${p.headText}"`)}</TD>${menu}</TR></TABLE>`;
  const notices = `<TD WIDTH="190" VALIGN="top" BGCOLOR="${p.panel}" STYLE="padding:8px">${font(c, '<B>Notices</B>')}${NOTICES.map((n) => `<P>${font(c, esc(n))}</P>`).join('')}</TD>`;
  const script = `CL.menu = function (td) {
  var m = td.getElementsByTagName('div')[0];
  m.style.display = m.style.display === 'none' ? 'block' : 'none';
};`;
  return doc(c, d, {
    title: 'Online Banking',
    footer: false,
    body: `${bar}<TABLE WIDTH="100%" CELLPADDING="0" CELLSPACING="0" BORDER="0"><TR>${notices}<TD VALIGN="top"><IFRAME NAME="main" SRC="${base}home" WIDTH="100%" HEIGHT="640" FRAMEBORDER="0"></IFRAME></TD></TR></TABLE>`,
    script,
  });
}

export function layoutRoutes(app: FastifyInstance, bank: Bank) {
  const base = bank.t.basePath;
  const p = palette(bank.t);

  app.get(`${base}console`, async (req, reply) => {
    const cur = await current(bank, req);
    if (!cur) return reply.redirect(`${base}signin`);
    if (bank.t.redesigned)
      return html(reply, refreshedPage(bank, ctxOf(bank, req), cur.operator.displayName));
    return html(reply, frameset(bank));
  });

  // Bank 1's nav frame, an older page that writes itself with document.write.
  app.get(`${base}frame/nav`, async (req, reply) => {
    const c = ctxOf(bank, req);
    const d = dialect(bank.t, bank.uiVersion, 'nav');
    const items = navItems(bank);
    const rows = items
      .map((i, k) => {
        const gap = k > 0 && items[k - 1]!.group !== i.group && i.group === 'out';
        const spacer = gap
          ? `<TR><TD><IMG SRC="${base}img/spacer.gif" WIDTH="1" HEIGHT="12" ALT=""></TD></TR>`
          : '';
        return `${spacer}<TR><TD NOWRAP>${linkButton(c, i.href, i.text, target(i))}${i.isNew ? newGif(base) : ''}</TD></TR>`;
      })
      .join('');
    const table = `<TABLE CELLPADDING="3" CELLSPACING="0" BORDER="0" CLASS="${d.cls('nav')}">${rows}</TABLE>`;
    return html(
      reply,
      doc(c, d, {
        title: 'Navigation',
        body: '',
        footer: false,
        script: `document.write(${js(table)});`,
      }),
    );
  });

  // Bank 2: a tab strip across the top.
  app.get(`${base}frame/tabs`, async (req, reply) => {
    const c = ctxOf(bank, req);
    const d = dialect(bank.t, bank.uiVersion, 'tabs');
    const tabs = navItems(bank)
      .map(
        (i) =>
          `<TD BGCOLOR="${i.group === 'out' ? p.body : p.panel}" STYLE="border:1px solid ${p.head};border-bottom:0;padding:8px 16px" NOWRAP>${linkButton(c, i.href, i.text, target(i))}</TD><TD WIDTH="3"></TD>`,
      )
      .join('');
    return html(
      reply,
      doc(c, d, {
        title: 'Tabs',
        footer: false,
        body: `<TABLE CELLPADDING="0" CELLSPACING="0" BORDER="0" CLASS="${d.cls('tabs')}"><TR>${tabs}</TR></TABLE>`,
      }),
    );
  });
}
