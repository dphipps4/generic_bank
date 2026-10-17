// Evidence: masking, and the trail every run leaves.
export { type Frame, frameOf } from './frame.js';
export {
  maskBoxes,
  type MaskedModel,
  maskModel,
  type MaskPolicy,
  maskScreenshot,
  maskText,
  sensitive,
} from './mask.js';
export { fileStore, type FrameStore, memoryStore } from './store.js';
