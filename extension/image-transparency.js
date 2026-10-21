import { ResourceCache } from './resource-cache.js';

// Blob URLs identify immutable bytes. Keep only completed booleans, never pixels
// or image elements, and use the caller's existing preview-cache budget.
export function createImageTransparencyObserver({ maxEntries }) {
  const results = new ResourceCache({ maxEntries });
  return (image, onResult) => observeImageTransparency(image, onResult, results);
}

// Inspect decoded pixels in small tiles so large originals do not require a
// second full-size canvas or block opening the viewer.
export function observeImageTransparency(image, onResult, results) {
  let generation = 0;
  const inspect = async () => {
    const token = ++generation;
    const source = image.currentSrc || image.src;
    const requestedSource = image.src;
    const isCurrent = () => token === generation && image.isConnected &&
      requestedSource === image.src && source === (image.currentSrc || image.src);
    if (!image.naturalWidth || !image.naturalHeight || !isCurrent()) return;
    const cacheable = source.startsWith('blob:');
    const cached = cacheable ? results?.get(source) : undefined;
    if (cached !== undefined) { onResult(cached); return; }
    const finish = transparent => {
      if (!isCurrent()) return;
      if (cacheable) results?.set(source, transparent);
      onResult(transparent);
    };
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 256;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    try {
      for (let y = 0; y < image.naturalHeight; y += canvas.height) {
        for (let x = 0; x < image.naturalWidth; x += canvas.width) {
          if (!isCurrent()) return;
          const width = Math.min(canvas.width, image.naturalWidth - x);
          const height = Math.min(canvas.height, image.naturalHeight - y);
          context.clearRect(0, 0, width, height);
          context.drawImage(image, x, y, width, height, 0, 0, width, height);
          const pixels = context.getImageData(0, 0, width, height).data;
          for (let at = 3; at < pixels.length; at += 4) {
            if (pixels[at] < 255) { finish(true); return; }
          }
        }
        await new Promise(resolve => setTimeout(resolve, 0));
        if (!isCurrent()) return;
      }
      finish(false);
    } catch { /* An unreadable external image keeps the solid viewer background. */ }
  };
  image.addEventListener('load', inspect);
  if (image.complete) void inspect();
}
