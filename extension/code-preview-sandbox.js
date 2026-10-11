// Manifest sandbox: opaque origin, no extension APIs. This page accepts only
// document data from its parent; it exposes no command bridge to the library.
const frame = document.getElementById('preview');
function fitPreview() {
  const body = document.body;
  if (!body) return;
  const originalZoom = body.style.zoom, originalMinHeight = body.style.minHeight;
  function fit() {
    body.style.zoom = originalZoom; body.style.minHeight = originalMinHeight;
    const width = innerWidth, height = Math.max(innerHeight, body.getBoundingClientRect().height);
    // Centered fixed-width demos can overflow on both sides; scrollWidth alone
    // misses the inaccessible left half. Preserve the source's own layout.
    const boxes = [...body.children].filter(node => !['SCRIPT', 'STYLE'].includes(node.tagName)).map(node => node.getBoundingClientRect());
    const overflow = Math.max(0, ...boxes.map(box => Math.max(-box.left, box.right - width)));
    const contentWidth = Math.max(body.scrollWidth, width + overflow * 2);
    if (contentWidth > width && width > 0) {
      const ratio = width / contentWidth;
      body.style.zoom = String(ratio); body.style.minHeight = `${height / ratio}px`;
    }
  }
  addEventListener('resize', fit);
  requestAnimationFrame(() => {
    fit();
    requestAnimationFrame(() => parent.postMessage({ type: 'code-preview-ready' }, '*'));
  });
}
window.addEventListener('message', event => {
  if (event.source === frame.contentWindow && event.data?.type === 'code-preview-error') {
    parent.postMessage({ type: 'code-preview-error' }, '*'); return;
  }
  if (event.source === frame.contentWindow && event.data?.type === 'code-preview-ready') {
    parent.postMessage({ type: 'code-preview-ready' }, '*'); return;
  }
  if (event.source !== parent || event.data?.type !== 'code-preview' || typeof event.data.html !== 'string') return;
  const policy = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'";
  const monitor = `<script>window.addEventListener('error',()=>parent.postMessage({type:'code-preview-error'},'*'));window.addEventListener('unhandledrejection',()=>parent.postMessage({type:'code-preview-error'},'*'));window.addEventListener('load',${fitPreview.toString()});</script>`;
  frame.srcdoc = `<!doctype html><meta http-equiv="Content-Security-Policy" content="${policy}">${monitor}${event.data.html}`;
});
