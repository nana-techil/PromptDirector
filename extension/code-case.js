import { t } from './i18n.js';

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
let galleryObserver, retentionObserver, warmObserver, galleryPaused = false;
let warmIdle = 0;
const warming = new Set();
const galleryPreviews = new Map();
function updatePreview(preview) {
  const released = document.hidden || (galleryPaused && preview.pauseWithGallery);
  if (released || !preview.warm) warming.delete(preview);
  preview.activate((preview.visible || warming.has(preview)) && !released, preview.nearby && !released);
}
// Prepare one neighbour per column at a time, after visible previews settle.
// The virtual gallery retains two screens; preparation uses the nearer one.
function scheduleWarmPreviews() {
  if (warmIdle || warming.size || document.hidden) return;
  warmIdle = requestIdleCallback(() => {
    warmIdle = 0;
    const available = [...galleryPreviews.values()].filter(p => !galleryPaused || !p.pauseWithGallery);
    if (available.some(p => p.visible && !p.ready())) return;
    const columns = new Set();
    for (const preview of available.filter(p => p.warm && !p.visible && !p.ready())) {
      const column = preview.section.getBoundingClientRect().left;
      if (columns.has(column)) continue;
      columns.add(column); warming.add(preview); updatePreview(preview);
    }
  });
}
function settledPreview(section) {
  const preview = galleryPreviews.get(section);
  warming.delete(preview);
  if (preview) updatePreview(preview);
  scheduleWarmPreviews();
}
function observeGalleryPreview(section, activate, pauseWithGallery, ready) {
  if (!galleryObserver) {
    galleryObserver = new IntersectionObserver(records => {
      for (const record of records) {
        const preview = galleryPreviews.get(record.target);
        if (preview) { preview.visible = record.isIntersecting; updatePreview(preview); }
      }
      scheduleWarmPreviews();
    });
    // Match the virtual gallery's two-viewport runway. Retain only already loaded
    // neighbours; do not start animations for every card below the fold.
    const observeRetention = () => {
      retentionObserver?.disconnect();
      warmObserver?.disconnect();
      retentionObserver = new IntersectionObserver(records => {
        for (const record of records) {
          const preview = galleryPreviews.get(record.target);
          if (preview) { preview.nearby = record.isIntersecting; updatePreview(preview); }
        }
      }, { rootMargin: `${innerHeight * 2}px 0px` });
      warmObserver = new IntersectionObserver(records => {
        for (const record of records) {
          const preview = galleryPreviews.get(record.target);
          if (preview) { preview.warm = record.isIntersecting; updatePreview(preview); }
        }
        scheduleWarmPreviews();
      }, { rootMargin: `${innerHeight}px 0px` });
      for (const section of galleryPreviews.keys()) { retentionObserver.observe(section); warmObserver.observe(section); }
    };
    observeRetention();
    window.addEventListener('resize', observeRetention, { passive: true });
    document.addEventListener('visibilitychange', () => {
      for (const preview of galleryPreviews.values()) updatePreview(preview);
      scheduleWarmPreviews();
    });
  }
  galleryPreviews.set(section, { section, visible: false, nearby: true, warm: false, activate, pauseWithGallery, ready });
  galleryObserver.observe(section); retentionObserver.observe(section); warmObserver.observe(section);
  return () => {
    galleryObserver.unobserve(section); retentionObserver.unobserve(section); warmObserver.unobserve(section);
    warming.delete(galleryPreviews.get(section));
    galleryPreviews.delete(section); activate(false, false); scheduleWarmPreviews();
  };
}

export function setCodeCaseGalleryPaused(value) {
  galleryPaused = Boolean(value);
  for (const preview of galleryPreviews.values()) updatePreview(preview);
  scheduleWarmPreviews();
}

export function createCodeCaseView(entry, { compact = false, pauseWithGallery = true, html = codePreviewHtml(entry.text) } = {}) {
  const section = document.createElement('section'); section.className = compact ? 'case-image-wrap case-code-preview' : 'code-case-view';
  section.codeSourceText = entry.text;
  if (html) {
    const frame = document.createElement('iframe'); frame.className = 'code-case-frame'; frame.title = t('交互预览'); frame.tabIndex = compact ? -1 : 0;
    frame.style.opacity = '0'; frame.style.pointerEvents = 'none';
    frame.setAttribute('sandbox', 'allow-scripts');
    const url = chrome.runtime.getURL('code-preview-sandbox.html');
    let readyPaint = 0;
    const revealPrepared = () => {
      if (frame.hidden || !frame.dataset.previewPrepared || frame.dataset.previewReady === 'error') return;
      frame.style.opacity = '1'; status.hidden = true;
      if (!frame.dataset.previewPainted || frame.dataset.previewReady || readyPaint) return;
      // Preparation is not a painted hit-test surface. Keep interaction gated on
      // the nested document's own paint, then let the host composite it.
      readyPaint = requestAnimationFrame(() => {
        readyPaint = 0;
        if (frame.hidden || !section.isConnected || !frame.dataset.previewPainted || frame.dataset.previewReady === 'error') return;
        frame.style.pointerEvents = ''; frame.dataset.previewReady = 'true';
      });
    };
    const activate = (visible, retain = false) => {
      // Display-none pauses browser rendering/animation frames without rebuilding
      // the sandbox when a nearby card returns. Far cards are released entirely.
      if (frame.hidden === visible) frame.hidden = !visible;
      if (!visible && readyPaint) { cancelAnimationFrame(readyPaint); readyPaint = 0; }
      if (visible) {
        if (!frame.getAttribute('src')) { status.textContent = t('加载预览…'); frame.src = url; }
        revealPrepared();
      } else if (!retain) {
        frame.removeAttribute('src'); frame.style.opacity = '0'; frame.style.pointerEvents = 'none';
        delete frame.dataset.previewReady; delete frame.dataset.previewPrepared; delete frame.dataset.previewPainted; status.hidden = false; status.textContent = t('加载预览…');
      }
    };
    const status = document.createElement('p'); status.className = 'code-case-status'; status.textContent = t('加载预览…'); status.setAttribute('role', 'status');
    const theme = () => {
      const style = getComputedStyle(document.documentElement);
      return { background: style.getPropertyValue('--ui-surface').trim(), color: style.getPropertyValue('--ui-text').trim(), scheme: style.colorScheme };
    };
    const syncTheme = () => { if (frame.getAttribute('src') === url) frame.contentWindow.postMessage({ type: 'code-preview-theme', theme: theme() }, '*'); };
    const themeObserver = new MutationObserver(syncTheme);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-resolved-theme'] });
    const systemTheme = matchMedia('(prefers-color-scheme: dark)');
    systemTheme.addEventListener('change', syncTheme);
    // Only status text can return. A preview cannot ask the host to run tools.
    const receive = event => {
      if (!section.isConnected) { window.removeEventListener('message', receive); return; }
      if (event.source !== frame.contentWindow || frame.getAttribute('src') !== url) return;
      if (event.data?.type === 'code-preview-host-ready') {
        // A lazily attached iframe also loads about:blank. Wait for the actual
        // sandbox handshake so it cannot initialize the source a second time.
        frame.contentWindow.postMessage({ type: 'code-preview', html, contain: true, compact, theme: theme() }, '*');
      } else if (event.data?.type === 'code-preview-prepared') {
        frame.dataset.previewPrepared = 'true'; settledPreview(section); revealPrepared();
      } else if (event.data?.type === 'code-preview-ready') {
        frame.dataset.previewPainted = 'true'; revealPrepared();
      } else if (event.data?.type === 'code-preview-error') {
        frame.dataset.previewReady = 'error'; status.hidden = false; status.textContent = t('预览运行失败，源码已保留'); settledPreview(section);
      }
    };
    window.addEventListener('message', receive);
    section.append(frame, status);
    let release;
    if (compact) release = observeGalleryPreview(section, activate, pauseWithGallery, () => Boolean(frame.dataset.previewPrepared || frame.dataset.previewReady));
    else {
      const visibility = new IntersectionObserver(records => activate(records[0].isIntersecting, true));
      visibility.observe(section);
      release = () => { visibility.disconnect(); activate(false, false); };
    }
    section.dispose = () => { release(); themeObserver.disconnect(); systemTheme.removeEventListener('change', syncTheme); window.removeEventListener('message', receive); };
  } else {
    const status = document.createElement('p'); status.textContent = t('尚未保存可运行预览'); section.append(status);
  }
  return section;
}
