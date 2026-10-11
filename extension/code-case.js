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
export function createCodeCaseView(entry, { onCopy } = {}) {
  const section = document.createElement('section'); section.className = 'detail-section code-case-view';
  section.codeSourceText = entry.text;
  const html = codePreviewHtml(entry.text);
  if (html) {
    const frame = document.createElement('iframe'); frame.className = 'code-case-frame'; frame.title = t('交互预览');
    frame.style.opacity = '0'; frame.style.pointerEvents = 'none';
    frame.setAttribute('sandbox', 'allow-scripts'); frame.src = chrome.runtime.getURL('code-preview-sandbox.html');
    const status = document.createElement('p'); status.className = 'code-case-status'; status.textContent = t('加载预览…'); status.setAttribute('role', 'status');
    frame.addEventListener('load', () => frame.contentWindow.postMessage({ type: 'code-preview', html }, '*'), { once: true });
    // Only status text can return. A preview cannot ask the host to run tools.
    const receive = event => {
      if (!section.isConnected) { window.removeEventListener('message', receive); return; }
      if (event.source !== frame.contentWindow) return;
      if (event.data?.type === 'code-preview-ready' && frame.dataset.previewReady !== 'error') {
        frame.style.opacity = '1';
        // Enable interaction after the newly visible nested frame has painted.
        requestAnimationFrame(() => {
          if (!section.isConnected || frame.dataset.previewReady === 'error') return;
          frame.style.pointerEvents = ''; frame.dataset.previewReady = 'true'; status.textContent = t('复现预览');
        });
      } else if (event.data?.type === 'code-preview-error') {
        frame.dataset.previewReady = 'error'; status.textContent = t('预览运行失败，源码已保留');
      }
    };
    window.addEventListener('message', receive);
    section.dispose = () => window.removeEventListener('message', receive);
    section.append(frame, status);
  } else {
    const status = document.createElement('p'); status.textContent = t('尚未保存可运行预览'); section.append(status);
  }
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
