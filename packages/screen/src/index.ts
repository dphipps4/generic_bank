// The screen: a browser read from outside the page, and what the crawler makes of what it sees.
export { Cdp, CdpClosed, CdpError, CdpTimeout, DEFAULT_TIMEOUT_MS, type Transport } from './cdp.js';
export { Browser, findChrome, type FrameSession, type LaunchOptions, Page } from './browser.js';
export {
  type Box,
  type Control,
  type FrameInfo,
  readScreen,
  type Role,
  type ScreenModel,
  type Text,
} from './model.js';
export { decodePng, type Image, type Rect, sameOutside } from './png.js';
export { loadingSignals, type Rendered, waitFullyRendered } from './render.js';
export {
  type ControlNeed,
  normalize,
  reading,
  recognize,
  type Recognition,
  type Signature,
} from './recognize.js';
