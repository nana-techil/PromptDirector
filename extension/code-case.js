import { t } from './i18n.js';
import { renderMarkdownDocument } from './markdown-renderer.js';

// Runnable previews are distinct from the source code. Both travel through the
// existing case text/export chain, without introducing a second asset store.
const language = 'promptdirector-preview-html';
export function codePreviewText(html) {
  const fence = '`'.repeat(Math.max(3, ...(html.match(/`+/gu) || []).map(run => run.length + 1)));
  return `${fence}${language}\n${html}\n${fence}`;
}
export function codePreviewHtml(text = '') {
  if (!text.includes(language)) return '';
  const lines = text.replace(/\r\n?/gu, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^(`{3,})promptdirector-preview-html\s*$/u);
    if (!match) continue;
    const end = lines.indexOf(match[1], i + 1);
    if (end > i) return lines.slice(i + 1, end).join('\n');
  }
  return '';
}
export function updateCodePreviewText(text = '', html) {
  // Replace only the generated preview block; source text keeps its exact bytes.
  const block = /^(`{3,})promptdirector-preview-html[^\S\r\n]*\r?\n[\s\S]*?\r?\n\1(?=\r?\n|$)/mu;
  return block.test(text) ? text.replace(block, () => codePreviewText(html)) : `${text}\n\n${codePreviewText(html)}`;
}
let galleryObserver, galleryPaused = false;
const galleryPreviews = new Map();
function observeGalleryPreview(section, activate) {
  if (!galleryObserver) {
    galleryObserver = new IntersectionObserver(records => {
      for (const record of records) {
        const preview = galleryPreviews.get(record.target);
        if (preview) { preview.visible = record.isIntersecting; preview.activate(preview.visible && !document.hidden && !galleryPaused); }
      }
    });
    document.addEventListener('visibilitychange', () => {
      for (const preview of galleryPreviews.values()) preview.activate(preview.visible && !document.hidden && !galleryPaused);
    });
  }
  galleryPreviews.set(section, { visible: false, activate });
  galleryObserver.observe(section);
  return () => { galleryObserver.unobserve(section); galleryPreviews.delete(section); activate(false); };
}

export function setCodeCaseGalleryPaused(value) {
  galleryPaused = Boolean(value);
  for (const preview of galleryPreviews.values()) preview.activate(preview.visible && !document.hidden && !galleryPaused);
}

export function createCodeCaseView(entry, { onCopy, compact = false, html = codePreviewHtml(entry.text) } = {}) {
  const section = document.createElement('section'); section.className = compact ? 'case-image-wrap case-code-preview' : 'detail-section code-case-view';
  section.codeSourceText = entry.text;
  if (html) {
    const frame = document.createElement('iframe'); frame.className = 'code-case-frame'; frame.title = t('交互预览'); frame.tabIndex = compact ? -1 : 0;
    frame.style.opacity = '0'; frame.style.pointerEvents = 'none';
    frame.setAttribute('sandbox', 'allow-scripts');
    const url = chrome.runtime.getURL('code-preview-sandbox.html');
    const activate = visible => {
      if (visible) { if (!frame.getAttribute('src')) { status.textContent = t('加载预览…'); frame.src = url; } }
      else { frame.removeAttribute('src'); frame.style.opacity = '0'; frame.style.pointerEvents = 'none'; delete frame.dataset.previewReady; status.hidden = false; }
    };
    const status = document.createElement('p'); status.className = 'code-case-status'; status.textContent = t('加载预览…'); status.setAttribute('role', 'status');
    frame.addEventListener('load', () => {
      if (frame.getAttribute('src') === url) frame.contentWindow.postMessage({ type: 'code-preview', html, contain: compact }, '*');
    });
    // Only status text can return. A preview cannot ask the host to run tools.
    const receive = event => {
      if (!section.isConnected) { window.removeEventListener('message', receive); return; }
      if (event.source !== frame.contentWindow || frame.getAttribute('src') !== url) return;
      if (event.data?.type === 'code-preview-ready' && frame.dataset.previewReady !== 'error') {
        frame.style.opacity = '1';
        // Enable interaction after the newly visible nested frame has painted.
        requestAnimationFrame(() => {
          if (!section.isConnected || frame.getAttribute('src') !== url || frame.dataset.previewReady === 'error') return;
          frame.style.pointerEvents = ''; frame.dataset.previewReady = 'true'; status.textContent = t('复现预览'); status.hidden = compact;
        });
      } else if (event.data?.type === 'code-preview-error') {
        frame.dataset.previewReady = 'error'; status.hidden = false; status.textContent = t('预览运行失败，源码已保留');
      }
    };
    window.addEventListener('message', receive);
    section.append(frame, status);
    const release = compact ? observeGalleryPreview(section, activate) : () => activate(false);
    if (!compact) activate(true);
    section.dispose = () => { release(); window.removeEventListener('message', receive); };
  } else {
    const status = document.createElement('p'); status.textContent = t('尚未保存可运行预览'); section.append(status);
  }
  if (compact) return section;
  const details = document.createElement('details'); const summary = document.createElement('summary'); summary.textContent = t('查看源码');
  details.append(summary); details.addEventListener('toggle', () => {
    if (details.open && details.childElementCount === 1) details.append(renderMarkdownDocument(entry.text));
  }); section.append(details);
  if (onCopy) {
    const copy = document.createElement('button'); copy.type = 'button'; copy.className = 'button-secondary'; copy.textContent = t('复制源码');
    copy.addEventListener('click', () => onCopy(copy, entry.text)); section.append(copy);
  }
  return section;
}
