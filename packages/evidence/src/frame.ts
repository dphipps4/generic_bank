// A trail frame (plan, §9): a masked screenshot, the masked screen model, host and path, the step
// and the time. A frame that cannot be proven clean is withheld: stored as a placeholder with the
// reason, never as an image.
import type { ScreenModel } from '@gb/screen';
import {
  maskBoxes,
  type MaskedModel,
  maskModel,
  maskScreenshot,
  maskText,
  type MaskPolicy,
} from './mask.js';

export interface Frame {
  step: number;
  at: string;
  host: string;
  path: string;
  screen: string | null;
  model: MaskedModel;
  /** The masked screenshot, or null when the frame is withheld. */
  image: Buffer | null;
  withheld?: string;
}

export function frameOf(
  m: ScreenModel,
  policy: MaskPolicy,
  o: { step: number; at?: Date; screen?: string | null },
): Frame {
  const u = new URL(m.url || 'about:blank');
  const base = {
    step: o.step,
    at: (o.at ?? new Date()).toISOString(),
    host: u.host,
    // No query strings, ever; numbers in the path are masked like any other.
    path: maskText(u.pathname, policy),
    screen: o.screen ?? null,
    model: maskModel(m, policy),
  };
  const unreadable = m.frames.find((f) => !f.readable);
  if (unreadable)
    return {
      ...base,
      image: null,
      withheld: 'a frame on this screen could not be read, so masking cannot be proven',
    };
  try {
    return { ...base, image: maskScreenshot(m.screenshot, maskBoxes(m, policy)) };
  } catch {
    return { ...base, image: null, withheld: 'the screenshot could not be masked' };
  }
}
