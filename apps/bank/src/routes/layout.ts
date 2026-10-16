import type { FastifyInstance } from 'fastify';
import { type Bank, ctxOf, current, origins } from '../context.js';
import { dialect } from '../markup/dialect.js';
import { type Ctx, doc, esc, font, js, linkButton, palette } from '../markup/html.js';
import { html } from './frame.js';

// The console's shape, a tenant setting. Every shape offers the same places to go; only how they
// are laid out differs: a nav frame, a tab strip, a tab strip with a notices frame, or a
// drop-down menu bar with no frameset at all. After the vendor's redesign, every bank has one
// shape: a single Menu at the top right, the notices on the left.

interface NavItem {
  href: string;
  text: string;
  group: 'members' | 'money' | 'tools' | 'out';
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
    { href: `${base}area/reports`, text: 'Reports', group: 'tools' },
    { href: `${base}area/admin`, text: 'Admin', group: 'tools' },
    { href: `${base}members/search?next=waive-fee`, text: 'Fee Waivers', group: 'tools' },
    { href: `${base}members/search?next=change-address`, text: 'Address Change', group: 'tools' },
    { href: `${base}signout`, text: 'Sign Out', group: 'out' },
  ];
}

const target = (i: NavItem) => (i.group === 'out' ? '_top' : 'main');
const newGif = (base: string) =>
  ` <IMG SRC="${base}img/new.svg" WIDTH="34" HEIGHT="14" ALT="NEW!">`;

function frameset(bank: Bank, o: ReturnType<typeof origins>): string {
  const base = bank.t.basePath;
  const f = (src: string, name: string, extra = '') =>
    `<FRAME SRC="${base}${src}" NAME="${name}"${extra}>`;
  const banner = f('frame/banner', 'banner', ' SCROLLING="no" NORESIZE');
  // Bank 2's tab strip comes from its second origin: a cross-origin frame.
  const tabsFrom = bank.t.secondOrigin === 'tabs' ? o.second : '';
  const tabs = `<FRAME SRC="${tabsFrom}${base}frame/tabs" NAME="tabs" SCROLLING="no" NORESIZE>`;
  const body =
    bank.t.layout === 'nav'
      ? `<FRAMESET ROWS="64,*" BORDER="1">${banner}<FRAMESET COLS="170,*">${f('frame/nav', 'nav')}${f('home', 'main')}</FRAMESET></FRAMESET>`
      : bank.t.layout === 'tabs'
        ? `<FRAMESET ROWS="56,30,*" BORDER="0">${banner}${tabs}${f('home', 'main')}</FRAMESET>`
        : `<FRAMESET ROWS="56,30,*" BORDER="0">${banner}${tabs}<FRAMESET COLS="*,190">${f('home', 'main')}${f('frame/notices', 'notices')}</FRAMESET></FRAMESET>`;
  // The cross-origin tab strip asks for a page by message; only a page of this console is opened.
  const relay = tabsFrom
    ? `<SCRIPT>window.onmessage = function (e) { var u = String(e.data); if (e.origin === ${js(o.second)} && u.indexOf(${js(`${o.main}${base}`)}) === 0) { frames['main'].location.href = u; } };</SCRIPT>`
    : '';
  return `<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Frameset//EN">
<HTML><HEAD><TITLE>CoreLink Branch Console - ${esc(bank.t.brand)}</TITLE>${relay}</HEAD>
${body}</HTML>`;
}

/** Bank 4: no frameset. A menu bar whose menus open on click, over an inline frame. */
function menubarPage(bank: Bank, c: Ctx, operator: string): string {
  const base = bank.t.basePath;
  const p = palette(bank.t);
  const d = dialect(bank.t, bank.uiVersion, 'menubar');
  const groups: [NavItem['group'], string][] = [
    ['members', 'Members'],
    ['money', 'Money'],
    ['tools', 'Tools'],
  ];
  const menus = groups
    .map(([g, title]) => {
      const items = navItems(bank)
        .filter((i) => i.group === g)
        .map(
          (i) =>
            `<A HREF="${i.href}" TARGET="main" STYLE="display:block;padding:4px 10px;color:#000;text-decoration:none">${esc(i.text)}</A>`,
        )
        .join('');
      return `<TD STYLE="position:relative;padding:6px 14px;cursor:pointer" ONCLICK="CL.menu(this)">${font(c, `${esc(title)} &#9662;`, ` COLOR="${p.headText}"`)}<DIV CLASS="${d.cls('menu')}" STYLE="display:none;position:absolute;left:0;top:28px;background:#FFF;border:1px solid #999;min-width:170px;z-index:5">${items}</DIV></TD>`;
    })
    .join('');
  const bar = `<TABLE WIDTH="100%" CELLPADDING="0" CELLSPACING="0" BORDER="0" BGCOLOR="${p.head}"><TR>
<TD STYLE="padding:6px 12px">${font(c, `<B>${esc(bank.t.brand)}</B>`, ` COLOR="${p.headText}"`)}</TD>${menus}
<TD ALIGN="right" STYLE="padding:6px 12px">${font(c, `${esc(operator)} &middot; `, ` COLOR="${p.headText}"`)}<A HREF="${base}signout" TARGET="_top">${font(c, 'Sign Out', ` COLOR="${p.headText}"`)}</A></TD></TR></TABLE>`;
  const script = `CL.menu = function (td) {
  var all = CL.byClass('div', ${js(d.cls('menu'))});
  for (var i = 0; i < all.length; i++) { if (all[i].parentNode !== td) { all[i].style.display = 'none'; } }
  var m = td.getElementsByTagName('div')[0];
  m.style.display = m.style.display === 'none' ? 'block' : 'none';
};`;
  return doc(c, d, {
    title: 'CoreLink',
    footer: false,
    body: `${bar}<IFRAME NAME="main" SRC="${base}home" WIDTH="100%" HEIGHT="640" FRAMEBORDER="0"></IFRAME>`,
    script,
  });
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
    if (bank.t.layout === 'menubar')
      return html(reply, menubarPage(bank, ctxOf(bank, req), cur.operator.displayName));
    return html(reply, frameset(bank, origins(bank, req)));
  });

  // Bank 1's nav frame, an older page that writes itself with document.write.
  app.get(`${base}frame/nav`, async (req, reply) => {
    const c = ctxOf(bank, req);
    const d = dialect(bank.t, bank.uiVersion, 'nav');
    const items = navItems(bank);
    const rows = items
      .map((i, k) => {
        const gap =
          k > 0 && items[k - 1]!.group !== i.group && (i.group === 'tools' || i.group === 'out');
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

  // Banks 2 and 3: a tab strip across the top.
  app.get(`${base}frame/tabs`, async (req, reply) => {
    const c = ctxOf(bank, req);
    const d = dialect(bank.t, bank.uiVersion, 'tabs');
    // Served from the second origin, the tabs must name the main origin to navigate it. A browser
    // lets a frame of another origin neither find the main frame by its name (TARGET="main" alone
    // would open a new window) nor navigate it: the tab asks the frameset to, by message.
    const cross = bank.t.secondOrigin === 'tabs';
    const home = cross ? origins(bank, req).main : '';
    const link = (i: NavItem) =>
      cross && target(i) === 'main'
        ? `<A HREF="${home}${i.href}" TARGET="main" ONCLICK="parent.postMessage(this.href, ${esc(js(home))}); return false;">${font(c, esc(i.text))}</A>`
        : linkButton(c, `${home}${i.href}`, i.text, target(i));
    const tabs = navItems(bank)
      .map(
        (i) =>
          `<TD BGCOLOR="${i.group === 'out' ? p.body : p.panel}" STYLE="border:1px solid ${p.head};border-bottom:0;padding:4px 12px" NOWRAP>${link(i)}</TD><TD WIDTH="3"></TD>`,
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

  // Bank 3: a notices frame on the right.
  app.get(`${base}frame/notices`, async (req, reply) => {
    const c = ctxOf(bank, req);
    const d = dialect(bank.t, bank.uiVersion, 'notices');
    return html(
      reply,
      doc(c, d, {
        title: 'Notices',
        footer: false,
        body: `<TABLE WIDTH="100%" CELLPADDING="4" CELLSPACING="0" BORDER="0"><TR><TD BGCOLOR="${p.head}">${font(c, '<B>Notices</B>', ` COLOR="${p.headText}"`)}</TD></TR>${NOTICES.map((n) => `<TR><TD>${font(c, esc(n))}</TD></TR>`).join('')}</TABLE>`,
      }),
    );
  });
}
