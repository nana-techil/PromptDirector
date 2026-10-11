// Manifest sandbox: opaque origin, no extension APIs. This page accepts only
// document data from its parent; it exposes no command bridge to the library.
const frame = document.getElementById('preview');
window.addEventListener('message', event => {
  if (event.source === frame.contentWindow && event.data?.type === 'code-preview-error') {
    parent.postMessage({ type: 'code-preview-error' }, '*'); return;
  }
  if (event.source !== parent || event.data?.type !== 'code-preview' || typeof event.data.html !== 'string') return;
  const policy = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'";
  const monitor = `<script>window.addEventListener('error',()=>parent.postMessage({type:'code-preview-error'},'*'));window.addEventListener('unhandledrejection',()=>parent.postMessage({type:'code-preview-error'},'*'));</script>`;
  frame.srcdoc = `<!doctype html><meta http-equiv="Content-Security-Policy" content="${policy}">${monitor}${event.data.html}`;
});
