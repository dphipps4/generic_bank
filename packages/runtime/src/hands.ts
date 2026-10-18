// Acting at a place on the screen, as a person's hands do: the mouse moves to a point and clicks,
// and the keyboard types. What is at a point is asked of the browser itself, through Chrome's
// DevTools protocol: no script of ours runs in the bank's page, and no selector picks anything.
import type { Page } from 'playwright-core';

export interface Point {
  x: number;
  y: number;
}

/** What is drawn at a point, as the browser knows it. */
export interface AtPoint {
  /** field, password field, button, link, checkbox, list, image, text, or nothing. */
  kind: string;
  /** The element's own name for itself, as the browser reports it: tag and type, for evidence. */
  element: string;
}

/** The kind of a node the browser found at a point, from its tag and attributes. */
function kindOf(tag: string, attrs: Record<string, string>): string {
  const type = (attrs.type ?? '').toLowerCase();
  switch (tag) {
    case 'input':
      if (type === 'password') return 'password field';
      if (type === 'checkbox' || type === 'radio') return 'checkbox';
      if (['submit', 'button', 'image', 'reset'].includes(type)) return 'button';
      return 'field';
    case 'textarea':
      return 'field';
    case 'select':
      return 'list';
    case 'button':
      return 'button';
    case 'a':
      return 'link';
    case 'img':
      return 'image';
    default:
      return 'text';
  }
}

/**
 * What the browser has at this point of the page (page pixels), frames included. The node found
 * is walked up a few levels so that text inside a link or a button reports the link or button.
 */
export async function whatIsAt(page: Page, p: Point): Promise<AtPoint> {
  const cdp = await page.context().newCDPSession(page);
  type Node = { nodeName: string; nodeType: number; attributes?: string[]; parentId?: number };
  try {
    await cdp.send('DOM.getDocument', { depth: 0 });
    const hit = (await cdp
      .send('DOM.getNodeForLocation', {
        x: Math.round(p.x),
        y: Math.round(p.y),
        includeUserAgentShadowDOM: false,
        ignorePointerEventsNone: true,
      })
      .catch(() => null)) as { backendNodeId: number } | null;
    if (!hit) return { kind: 'nothing', element: 'nothing' };
    const { nodeIds } = (await cdp.send('DOM.pushNodesByBackendIdsToFrontend', {
      backendNodeIds: [hit.backendNodeId],
    })) as { nodeIds: number[] };
    let nodeId: number | undefined = nodeIds[0];
    let first: AtPoint | null = null;
    // Up a few levels, so text inside a link or a button reports the link or the button.
    for (let up = 0; up < 4 && nodeId; up++) {
      const { node } = (await cdp.send('DOM.describeNode', { nodeId, depth: 0 })) as {
        node: Node;
      };
      const tag = node.nodeName.toLowerCase();
      const attrs: Record<string, string> = {};
      for (let i = 0; i + 1 < (node.attributes?.length ?? 0); i += 2)
        attrs[node.attributes![i]!.toLowerCase()] = node.attributes![i + 1]!;
      const at = {
        kind: node.nodeType === 1 ? kindOf(tag, attrs) : 'text',
        element: attrs.type ? `${tag}[type=${attrs.type}]` : tag,
      };
      first ??= at;
      if (at.kind !== 'text') return at;
      nodeId = node.parentId;
    }
    return first ?? { kind: 'nothing', element: 'nothing' };
  } finally {
    await cdp.detach().catch(() => undefined);
  }
}

/** Moves the mouse to a point and clicks there, as a person would. */
export async function clickAt(page: Page, p: Point): Promise<void> {
  await page.mouse.move(p.x, p.y, { steps: 8 });
  await page.mouse.click(p.x, p.y);
}

/** Clicks into the field at a point, clears it with the keyboard, and types key by key. */
export async function typeAt(page: Page, p: Point, text: string): Promise<void> {
  await clickAt(page, p);
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.press('Backspace');
  await page.keyboard.type(text, { delay: 20 });
}
