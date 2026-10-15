// Fully rendered, not "network idle" (plan, §E.2). Legacy pages poll, stream and keep connections
// open; a quiet network says nothing about what is drawn. A page is fully rendered when every frame
// has loaded, two readings 700 ms apart show the same picture (outside what the page animates on
// its own) and the same structure, nothing says it is still loading, and there is something to act
// on. An empty shell that has stopped changing is "not drawn yet", until the limit says otherwise.
import type { Page } from './browser.js';
import { readScreen, type ScreenModel } from './model.js';
import { decodePng, type Image, sameOutside } from './png.js';

export interface Rendered {
  model: ScreenModel;
  rendered: boolean;
  waitedMs: number;
  /** Why it is not rendered, when it is not. */
  reason?: string;
  /** A JavaScript dialog is open: the page is frozen until someone answers it. */
  dialog?: { type: string; message: string };
}

const LOADING = /^(loading|processing|please wait|one moment|signing in)\b/i;

/** Signs that a page is still being drawn, in the operator's terms. */
export function loadingSignals(m: ScreenModel): string[] {
  const out: string[] = [];
  const short = m.texts.filter((t) => t.text.length <= 60 && LOADING.test(t.text));
  if (short.length) out.push(`it says "${short[0]!.text}"`);
  if (m.controls.some((c) => c.role === 'select' && c.options?.some((o) => LOADING.test(o))))
    out.push('a list is still loading');
  const fields = m.controls.filter((c) => c.role === 'textbox' || c.role === 'password');
  if (fields.length > 0 && fields.every((c) => !c.enabled))
    out.push('the form is waiting for its script to enable it');
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const emptyModel = (): ScreenModel => ({
  url: '',
  title: '',
  frames: [],
  controls: [],
  texts: [],
  structureKey: '',
  screenshot: Buffer.alloc(0),
  dropped: 0,
  animated: [],
});

export async function waitFullyRendered(
  page: Page,
  o: {
    limitMs?: number;
    quietMs?: number;
    /**
     * What this screen looks like when it is complete, from whoever knows the screen (a driver's
     * signature). A page can sit perfectly still while its data is still on the way; only the
     * screen's own definition can tell.
     */
    until?: (m: ScreenModel) => boolean;
  } = {},
): Promise<Rendered> {
  const limit = o.limitMs ?? 45_000;
  const quiet = o.quietMs ?? 700;
  const start = Date.now();
  let prev: { image: Image; key: string } | null = null;
  let last: ScreenModel | null = null;
  let reason = 'not read yet';
  while (Date.now() - start < limit) {
    // A dialog freezes the page, screenshots included: hand it back to the caller to answer.
    if (page.dialog) {
      return {
        model: last ?? emptyModel(),
        rendered: false,
        waitedMs: Date.now() - start,
        reason: 'a dialog is open',
        dialog: { type: page.dialog.type, message: page.dialog.message },
      };
    }
    if (!page.allLoaded()) {
      reason = 'a frame is still loading';
      await sleep(150);
      continue;
    }
    let model: ScreenModel;
    try {
      model = await readScreen(page);
    } catch {
      // The page changed under the reading (a navigation, a frame going away): read again.
      reason = 'the page changed while it was being read';
      prev = null;
      await sleep(200);
      continue;
    }
    const image = decodePng(model.screenshot);
    const signals = loadingSignals(model);
    const complete = !o.until || o.until(model);
    // Something to act on: a usable control, or a screen the caller recognizes (an error page may
    // have no controls at all, and is still an answer).
    const actionable = model.controls.some((c) => c.enabled) || (o.until !== undefined && complete);
    const still =
      prev !== null &&
      prev.key === model.structureKey &&
      sameOutside(prev.image, image, model.animated);
    if (still && signals.length === 0 && actionable && complete)
      return { model, rendered: true, waitedMs: Date.now() - start };
    reason =
      signals[0] ??
      (!actionable
        ? 'nothing to act on yet'
        : !complete
          ? 'the screen is not complete yet'
          : 'the page is still changing');
    prev = { image, key: model.structureKey };
    last = model;
    await sleep(quiet);
  }
  return {
    model: last ?? (await readScreen(page)),
    rendered: false,
    waitedMs: Date.now() - start,
    reason,
  };
}
