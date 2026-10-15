// The screen model: what an operator sees, read from outside the page (plan, §E.1).
//
// For the top document and every frame, Chromium's own layout (DOMSnapshot), its accessibility
// tree and a screenshot. Frames are flattened into page coordinates so the screen is one picture.
// Only what is visible and on top is kept: a hit test at each control's center drops anything
// hidden, covered or off-screen, so a hidden twin of the real button is never in the model. Each
// visible control gets a stable reference (c1, c2, ...) with its role, name, box and state, and
// never its value.
import { createHash } from 'node:crypto';
import type { Page } from './browser.js';

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Role =
  | 'textbox'
  | 'password'
  | 'checkbox'
  | 'radio'
  | 'select'
  | 'button'
  | 'image-button'
  | 'link'
  | 'clickable'
  | 'image';

export interface Control {
  ref: string;
  role: Role;
  /** Visible text, accessible name or alt text; empty when the control is a picture of text. */
  name: string;
  box: Box;
  enabled: boolean;
  checked?: boolean;
  /** Where the name came from, when not from text: a picture matched by its fingerprint. */
  namedBy?: 'fingerprint';
  /** Whether a value is present; the value itself is never read. */
  hasValue?: boolean;
  /** For selects: the options' text, which is what an operator reads, and the one selected. */
  options?: string[];
  selected?: string;
  frame: string;
  /** For the browser, not for drivers: where to find this node again. */
  backendNodeId: number;
  session: string;
}

export interface Text {
  text: string;
  box: Box;
  frame: string;
}

export interface FrameInfo {
  id: string;
  url: string;
  box: Box;
  readable: boolean;
}

export interface ScreenModel {
  url: string;
  title: string;
  frames: FrameInfo[];
  controls: Control[];
  texts: Text[];
  /** Changes when the layout's structure changes; the same page drawn twice keeps it. */
  structureKey: string;
  screenshot: Buffer;
  /** Controls in the layout that were not visible or not on top. */
  dropped: number;
  /** Regions the page itself animates (marquees, animated images): ignored when comparing pictures. */
  animated: Box[];
}

interface Snapshot {
  documents: SnapDoc[];
  strings: string[];
}
interface SnapDoc {
  documentURL: number;
  title: number;
  frameId: number;
  scrollOffsetX?: number;
  scrollOffsetY?: number;
  nodes: {
    parentIndex: number[];
    nodeName: number[];
    nodeValue: number[];
    backendNodeId: number[];
    attributes: number[][];
    inputValue?: { index: number[]; value: number[] };
    inputChecked?: { index: number[] };
    optionSelected?: { index: number[] };
    isClickable?: { index: number[] };
    contentDocumentIndex?: { index: number[]; value: number[] };
    shadowRootType?: { index: number[]; value: number[] };
  };
  layout: {
    nodeIndex: number[];
    styles: number[][];
    bounds: number[][];
    text: number[];
    clientRects?: number[][];
  };
  textBoxes: { layoutIndex: number[]; bounds: number[][] };
}

const STYLES = ['visibility', 'opacity', 'pointer-events'];

interface Origin {
  dx: number;
  dy: number;
  clip: Box;
}

const inside = (b: Box, c: Box) =>
  b.x + b.w / 2 >= c.x &&
  b.x + b.w / 2 <= c.x + c.w &&
  b.y + b.h / 2 >= c.y &&
  b.y + b.h / 2 <= c.y + c.h;

/** Reads one session's snapshot and AX names, adding its controls and texts to the model. */
async function readSession(
  page: Page,
  session: string,
  origin: Origin,
  frameLabel: string,
  out: {
    controls: Omit<Control, 'ref'>[];
    texts: Text[];
    frames: FrameInfo[];
    dropped: number;
    keys: string[];
    title: string;
    animated: Box[];
  },
  oopifOwners: Map<number, { dx: number; dy: number; clip: Box }>,
) {
  const call = <R>(m: string, p: Record<string, unknown> = {}) =>
    page.cdp.call<R>(m, p, { sessionId: session });
  const snap = await call<Snapshot>('DOMSnapshot.captureSnapshot', {
    computedStyles: STYLES,
    includeDOMRects: true,
  });
  const ax = await call<{
    nodes: {
      backendDOMNodeId?: number;
      ignored: boolean;
      name?: { value?: string };
      role?: { value?: string };
    }[];
  }>('Accessibility.getFullAXTree').catch(() => ({ nodes: [] }));
  const axName = new Map<number, string>();
  for (const n of ax.nodes)
    if (n.backendDOMNodeId && n.name?.value) axName.set(n.backendDOMNodeId, n.name.value.trim());
  const S = (i: number | undefined) => (i === undefined || i < 0 ? '' : (snap.strings[i] ?? ''));

  // Each document's offset in page coordinates, from its owner frame's content box.
  const origins = new Map<number, Origin>([[0, origin]]);
  const docs = snap.documents;

  const process = (di: number) => {
    const doc = docs[di]!;
    const o = origins.get(di)!;
    const n = doc.nodes;
    const sx = doc.scrollOffsetX ?? 0;
    const sy = doc.scrollOffsetY ?? 0;
    const attrs = (i: number) => {
      const a = n.attributes[i] ?? [];
      const m: Record<string, string> = {};
      for (let k = 0; k < a.length; k += 2) m[S(a[k]).toLowerCase()] = S(a[k + 1]);
      return m;
    };
    const layoutOf = new Map<number, number>();
    doc.layout.nodeIndex.forEach((ni, li) => layoutOf.set(ni, li));
    const toPage = (b: number[]): Box => ({
      x: o.dx + b[0]! - sx,
      y: o.dy + b[1]! - sy,
      w: b[2]!,
      h: b[3]!,
    });
    const clickable = new Set(n.isClickable?.index ?? []);
    const values = new Map<number, string>();
    n.inputValue?.index.forEach((ni, k) => values.set(ni, S(n.inputValue!.value[k])));
    const checked = new Set(n.inputChecked?.index ?? []);
    const optionSelected = new Set(n.optionSelected?.index ?? []);
    const children = new Map<number, number>();
    n.contentDocumentIndex?.index.forEach((ni, k) =>
      children.set(ni, n.contentDocumentIndex!.value[k]!),
    );
    const label = `${frameLabel}${di === 0 ? '' : `/${di}`}`;

    // A page's own shadow roots are left out: frameworks rewrite them constantly, so what is in
    // them is not evidence of what the page shows. The browser's built-in ones (inside an input
    // or a list) stay, since they draw the control itself.
    const shadowRoots = new Set<number>();
    n.shadowRootType?.index.forEach((ni, k) => {
      const t = S(n.shadowRootType!.value[k]);
      if (t === 'open' || t === 'closed') shadowRoots.add(ni);
    });
    // Opacity is not inherited: a node is only as visible as its most transparent ancestor.
    const opacityOf = new Map<number, number>();
    const effectiveOpacity = (ni: number): number => {
      if (ni < 0) return 1;
      const known = opacityOf.get(ni);
      if (known !== undefined) return known;
      const li = layoutOf.get(ni);
      const own = li === undefined ? 1 : Number(S(doc.layout.styles[li]?.[1]) || '1');
      const v = own * effectiveOpacity(n.parentIndex[ni]!);
      opacityOf.set(ni, v);
      return v;
    };
    const inShadow = (ni: number) => {
      for (let p = ni; p >= 0; p = n.parentIndex[p]!) if (shadowRoots.has(p)) return true;
      return false;
    };

    // Ancestors that are links or buttons make their text part of one control, not two.
    const insideControl = (ni: number) => {
      for (let p = n.parentIndex[ni]!; p >= 0; p = n.parentIndex[p]!) {
        const tag = S(n.nodeName[p]);
        if (tag === 'A' || tag === 'BUTTON' || tag === 'SELECT') return true;
      }
      return false;
    };

    for (let ni = 0; ni < n.nodeName.length; ni++) {
      const tag = S(n.nodeName[ni]);
      const li = layoutOf.get(ni);
      // Frames: the child document starts at the owner's content box.
      if (children.has(ni) && li !== undefined) {
        const b = toPage(doc.layout.bounds[li]!);
        const cr = doc.layout.clientRects?.[li];
        const child = children.get(ni)!;
        const box = {
          x: b.x + (cr?.[0] ?? 0),
          y: b.y + (cr?.[1] ?? 0),
          w: cr?.[2] || b.w,
          h: cr?.[3] || b.h,
        };
        origins.set(child, { dx: box.x, dy: box.y, clip: box });
        out.frames.push({
          id: `${label}>${S(docs[child]!.frameId).slice(0, 8)}`,
          url: S(docs[child]!.documentURL),
          box,
          readable: true,
        });
      }
      if ((tag === 'IFRAME' || tag === 'FRAME') && !children.has(ni) && li !== undefined) {
        const b = toPage(doc.layout.bounds[li]!);
        const cr = doc.layout.clientRects?.[li];
        oopifOwners.set(n.backendNodeId[ni]!, {
          dx: b.x + (cr?.[0] ?? 0),
          dy: b.y + (cr?.[1] ?? 0),
          clip: { x: b.x, y: b.y, w: b.w, h: b.h },
        });
      }
      if (li === undefined) continue;
      if (shadowRoots.size > 0 && inShadow(ni)) {
        if (tag !== '#text') out.dropped++;
        continue;
      }
      const box = toPage(doc.layout.bounds[li]!);
      // Things that move on their own: a marquee, or an image that may be animated.
      if (
        tag === 'MARQUEE' ||
        tag === 'BLINK' ||
        (tag === 'IMG' && /\.(gif|svg)(\?|$)/i.test(attrs(ni).src ?? ''))
      )
        out.animated.push(box);
      const styles = doc.layout.styles[li] ?? [];
      const visible =
        S(styles[0]) !== 'hidden' && S(styles[0]) !== 'collapse' && effectiveOpacity(ni) > 0.05;

      // Text runs: what an operator reads.
      if (tag === '#text') {
        const t = S(doc.layout.text[li]).replace(/\s+/g, ' ').trim();
        if (t && visible && box.w > 0 && box.h > 0 && inside(box, o.clip))
          out.texts.push({ text: t, box, frame: label });
        continue;
      }

      const a = attrs(ni);
      const type = (a.type ?? '').toLowerCase();
      let role: Role | null = null;
      if (tag === 'INPUT') {
        role =
          type === 'hidden'
            ? null
            : type === 'password'
              ? 'password'
              : type === 'checkbox'
                ? 'checkbox'
                : type === 'radio'
                  ? 'radio'
                  : type === 'image'
                    ? 'image-button'
                    : type === 'submit' || type === 'button' || type === 'reset'
                      ? 'button'
                      : 'textbox';
      } else if (tag === 'TEXTAREA') role = 'textbox';
      else if (tag === 'SELECT') role = 'select';
      else if (tag === 'BUTTON') role = 'button';
      else if (tag === 'A' && (a.href !== undefined || a.onclick !== undefined)) role = 'link';
      else if (tag === 'IMG' && !insideControl(ni)) role = 'image';
      else if (
        // A click listener on the document or a container is not a control: only an element
        // drawn as one thing to press is.
        clickable.has(ni) &&
        !insideControl(ni) &&
        !tag.startsWith('#') &&
        !['HTML', 'BODY', 'FORM', 'FRAMESET'].includes(tag)
      )
        role = 'clickable';
      if (!role) continue;

      const backendNodeId = n.backendNodeId[ni]!;
      const textInside = () => {
        const parts: string[] = [];
        for (let k = ni + 1; k < n.nodeName.length; k++) {
          let p = n.parentIndex[k]!;
          while (p >= 0 && p !== ni) p = n.parentIndex[p]!;
          if (p !== ni) break;
          const parentTag = S(n.nodeName[n.parentIndex[k]!]);
          if (S(n.nodeName[k]) === '#text' && parentTag !== 'SCRIPT' && parentTag !== 'STYLE')
            parts.push(S(n.nodeValue[k]));
          if (S(n.nodeName[k]) === 'IMG' && attrs(k).alt) parts.push(attrs(k).alt!);
        }
        return parts.join(' ').replace(/\s+/g, ' ').trim();
      };
      const name =
        role === 'image-button' || role === 'image'
          ? (a.alt ?? '').trim()
          : role === 'button' && tag === 'INPUT'
            ? (a.value ?? '').trim()
            : role === 'link' || role === 'button' || role === 'clickable'
              ? textInside() || axName.get(backendNodeId) || ''
              : (axName.get(backendNodeId) ?? '');
      // A list's options, in order, and which one is selected (read from the layout, not the value).
      let options: string[] | undefined;
      let selected: string | undefined;
      if (role === 'select') {
        options = [];
        const isInside = (k: number) => {
          for (let p = n.parentIndex[k]!; p >= 0; p = n.parentIndex[p]!) if (p === ni) return true;
          return false;
        };
        for (let k = ni + 1; k < n.nodeName.length && isInside(k); k++) {
          if (S(n.nodeName[k]) !== 'OPTION') continue;
          const t = n.nodeName.findIndex(
            (_, j) => j > k && n.parentIndex[j] === k && S(n.nodeName[j]) === '#text',
          );
          const label = t > 0 ? S(n.nodeValue[t]).trim() : '';
          options.push(label);
          if (optionSelected.has(k)) selected = label;
        }
        selected ??= options[0];
      }
      const enabled = a.disabled === undefined;
      const usable =
        visible && box.w >= 2 && box.h >= 2 && inside(box, o.clip) && S(styles[2]) !== 'none';
      if (!usable) {
        out.dropped++;
        continue;
      }
      out.controls.push({
        role,
        name,
        box,
        enabled,
        ...(role === 'checkbox' || role === 'radio' ? { checked: checked.has(ni) } : {}),
        ...(role === 'textbox' || role === 'password'
          ? { hasValue: (values.get(ni) ?? '').length > 0 }
          : {}),
        ...(options ? { options, selected } : {}),
        frame: label,
        backendNodeId,
        session,
      });
    }
  };

  // Documents in order: a child's origin is known once its parent has been read.
  for (let di = 0; di < docs.length; di++) if (origins.has(di)) process(di);
  out.keys.push(...docs.map((d) => `${S(d.documentURL)}:${d.layout.nodeIndex.length}`));
  if (frameLabel === 'top' && docs[0]) out.title = S(docs[0].title);
}

/** Hit-tests each control at its center: only a control on top of the screen is kept. */
async function onTop(
  page: Page,
  controls: Omit<Control, 'ref'>[],
  origins: Map<string, { dx: number; dy: number }>,
) {
  const kept: Omit<Control, 'ref'>[] = [];
  let dropped = 0;
  const descendants = new Map<string, Map<number, number>>();
  for (const c of controls) {
    const o = origins.get(c.session) ?? { dx: 0, dy: 0 };
    const x = Math.round(c.box.x + c.box.w / 2 - o.dx);
    const y = Math.round(c.box.y + c.box.h / 2 - o.dy);
    try {
      const hit = await page.cdp.call<{ backendNodeId: number }>(
        'DOM.getNodeForLocation',
        { x, y, includeUserAgentShadowDOM: false, ignorePointerEventsNone: true },
        { sessionId: c.session, timeoutMs: 1500 },
      );
      if (await isSelfOrDescendant(page, c, hit.backendNodeId, descendants)) kept.push(c);
      else dropped++;
    } catch {
      dropped++;
    }
  }
  return { kept, dropped };
}

/** Is the node that was hit the control itself, or something drawn inside it? */
async function isSelfOrDescendant(
  page: Page,
  c: Omit<Control, 'ref'>,
  hit: number,
  cache: Map<string, Map<number, number>>,
) {
  if (hit === c.backendNodeId) return true;
  const key = `${c.session}:${c.backendNodeId}`;
  let tree = cache.get(key);
  if (!tree) {
    tree = new Map();
    try {
      const r = await page.cdp.call<{ node: Node }>(
        'DOM.describeNode',
        { backendNodeId: c.backendNodeId, depth: -1 },
        { sessionId: c.session, timeoutMs: 1500 },
      );
      const walk = (nd: Node) => {
        tree!.set(nd.backendNodeId, 1);
        for (const ch of nd.children ?? []) walk(ch);
      };
      walk(r.node);
    } catch {
      // unreadable: treat as not on top
    }
    cache.set(key, tree);
  }
  return tree.has(hit);
}
interface Node {
  backendNodeId: number;
  children?: Node[];
}

/** Reads the screen: every frame, flattened, visible and on top, with stable references. */
export async function readScreen(page: Page): Promise<ScreenModel> {
  const out = {
    controls: [] as Omit<Control, 'ref'>[],
    texts: [] as Text[],
    frames: [] as FrameInfo[],
    dropped: 0,
    keys: [] as string[],
    title: '',
    animated: [] as Box[],
  };
  const metrics = await page.call<{
    cssLayoutViewport: { clientWidth: number; clientHeight: number };
  }>('Page.getLayoutMetrics');
  const viewport: Box = {
    x: 0,
    y: 0,
    w: metrics.cssLayoutViewport.clientWidth,
    h: metrics.cssLayoutViewport.clientHeight,
  };
  const oopifOwners = new Map<number, { dx: number; dy: number; clip: Box }>();
  await readSession(
    page,
    page.sessionId,
    { dx: 0, dy: 0, clip: viewport },
    'top',
    out,
    oopifOwners,
  );

  // Frames from other origins: each read through its own session, placed at its owner's box.
  const sessionOrigins = new Map<string, { dx: number; dy: number }>([
    [page.sessionId, { dx: 0, dy: 0 }],
  ]);
  for (const f of page.frames.values()) {
    let owner: { dx: number; dy: number; clip: Box } | undefined;
    try {
      const r = await page.call<{ backendNodeId: number }>('DOM.getFrameOwner', {
        frameId: f.targetId,
      });
      owner = oopifOwners.get(r.backendNodeId);
    } catch {
      owner = undefined;
    }
    if (!owner) {
      out.frames.push({
        id: `frame:${f.targetId.slice(0, 8)}`,
        url: f.url,
        box: { x: 0, y: 0, w: 0, h: 0 },
        readable: false,
      });
      continue;
    }
    try {
      await readSession(
        page,
        f.sessionId,
        { dx: owner.dx, dy: owner.dy, clip: owner.clip },
        `frame:${f.targetId.slice(0, 8)}`,
        out,
        oopifOwners,
      );
      sessionOrigins.set(f.sessionId, { dx: owner.dx, dy: owner.dy });
      out.frames.push({
        id: `frame:${f.targetId.slice(0, 8)}`,
        url: f.url,
        box: owner.clip,
        readable: true,
      });
    } catch {
      // Never guessed at: a frame neither session can read is marked unreadable.
      out.frames.push({
        id: `frame:${f.targetId.slice(0, 8)}`,
        url: f.url,
        box: owner.clip,
        readable: false,
      });
    }
  }

  const { kept, dropped } = await onTop(page, out.controls, sessionOrigins);
  // Stable references: top to bottom, then left to right.
  kept.sort((a, b) => Math.round(a.box.y / 4) - Math.round(b.box.y / 4) || a.box.x - b.box.x);
  const controls = kept.map((c, i) => ({ ref: `c${i + 1}`, ...c }));
  const info = await page.call<{ frameTree: { frame: { url: string } } }>('Page.getFrameTree');
  const structure = createHash('sha256')
    .update(out.keys.join('|'))
    .update(
      controls
        .map(
          (c) =>
            `${c.role}:${c.name}:${Math.round(c.box.x / 4)},${Math.round(c.box.y / 4)},${Math.round(c.box.w / 4)},${Math.round(c.box.h / 4)}`,
        )
        .join('|'),
    )
    .digest('hex')
    .slice(0, 16);
  return {
    url: info.frameTree.frame.url,
    title: out.title,
    frames: out.frames,
    controls,
    texts: out.texts,
    structureKey: structure,
    // A dialog freezes the page; a screenshot would only wait out its timeout.
    screenshot: page.dialog ? Buffer.alloc(0) : await page.screenshot(),
    dropped: out.dropped + dropped,
    animated: out.animated,
  };
}
