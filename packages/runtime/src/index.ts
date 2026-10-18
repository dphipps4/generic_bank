// The runtime every crawler uses: see the page first, then click what is drawn.
export { dialogsSince, findChrome, launch, newPage, type PageOptions } from './browser.js';
export { choose, control, field, press, TargetError, type } from './act.js';
export { type Box, maskAddress, maskBoxes, maskText, paint, spans } from './mask.js';
export {
  distance,
  fingerprint,
  type KnownPicture,
  labelPicture,
  labels,
  matchPicture,
  NEAR,
} from './picture.js';
export {
  type Control,
  type Expected,
  type Frame,
  knows,
  NotReady,
  read,
  see,
  UnknownPage,
} from './see.js';
export type { Browser, Page } from 'playwright-core';
