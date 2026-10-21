import { renderMarkdownDocument } from './markdown-renderer.js';
import { createUiIcon } from './ui-icons.js';
import { assetFormatForFile } from './asset-formats.js';
import { blobToDataUrl } from './vision.js';
import { resolveSkillFileLink } from './skill-package-edit.js';
import { t, translateUiMessage } from './i18n.js';

// A file viewer, never a script runner. Files are read only when selected.
export function createSkillFileBrowser({ host, onSelect = () => {} }) {
  let source = null, selected = '', generation = 0, disabled = false;
  const urls = new Set(), expanded = new Set();
  host.classList.add('skill-file-browser');
  const sidebar = node('aside', 'skill-file-sidebar');
  const heading = node('header');
  const collapse = iconButton('panel-left-close', t('收起文件栏'));
  heading.append(node('strong', '', t('文件')), collapse);
  const tree = node('nav'); tree.setAttribute('aria-label', t('Skill 包文件'));
  sidebar.append(heading, tree);
  const reader = node('section', 'skill-file-reader');
  const toolbar = node('header', 'skill-file-toolbar');
  const expand = iconButton('panel-left', t('展开文件栏'));
  const pathLabel = node('strong'), size = node('span');
  toolbar.append(expand, pathLabel, size);
  const content = node('div', 'skill-detail-markdown');
  content.setAttribute('aria-live', 'polite');
  reader.append(toolbar, content); host.append(sidebar, reader);
  function setCollapsed(value) { host.classList.toggle('is-collapsed', value); expand.hidden = !value; }
  collapse.onclick = () => setCollapsed(true); expand.onclick = () => setCollapsed(false);
  setCollapsed(matchMedia('(max-width:760px)').matches);

  function release() {
    generation++;
    for (const url of urls) URL.revokeObjectURL(url);
    urls.clear(); content.replaceChildren();
  }
  function objectUrl(blob) { const url = URL.createObjectURL(blob); urls.add(url); return url; }
  function renderTree() {
    const root = new Map();
    for (const path of source.paths) {
      let parent = root;
      const parts = path.split('/');
      parts.forEach((part, index) => {
        if (index === parts.length - 1) parent.set(part, path);
        else { if (!parent.has(part)) parent.set(part, new Map()); parent = parent.get(part); }
      });
    }
    function children(map, prefix = '') {
      const fragment = document.createDocumentFragment();
      for (const [name, value] of [...map].sort(([a, av], [b, bv]) => a === 'SKILL.md' ? -1 : b === 'SKILL.md' ? 1 : Number(typeof av === 'string') - Number(typeof bv === 'string') || a.localeCompare(b))) {
        if (typeof value === 'string') {
          const button = node('button', 'button-secondary skill-file-row'); button.type = 'button'; button.disabled = disabled;
          button.append(createUiIcon('file-text'), document.createTextNode(name)); button.title = value;
          button.setAttribute('aria-current', String(value === selected));
          button.onclick = () => select(value); fragment.append(button);
        } else {
          const folder = prefix + name;
          const details = node('details'); details.open = expanded.has(folder) || selected.startsWith(folder + '/');
          details.ontoggle = () => details.open ? expanded.add(folder) : expanded.delete(folder);
          const group = node('div', 'skill-file-children'); group.append(children(value, folder + '/'));
          details.append(node('summary', '', name), group); fragment.append(details);
        }
      }
      return fragment;
    }
    tree.replaceChildren(children(root));
  }
  async function select(path) {
    if (!source || !source.paths.includes(path)) return;
    release(); selected = path; renderTree(); pathLabel.textContent = path; size.textContent = '';
    onSelect(path);
    const token = generation, current = source;
    content.textContent = t('正在读取文件…');
    try {
      if (current.mainEditor && path === current.mainPath) {
        content.replaceChildren(current.mainEditor); current.mainEditor.disabled = disabled; return;
      }
      const blob = await current.readFile(path);
      if (token !== generation) return;
      if (!(blob instanceof Blob)) throw new Error(t('文件读取失败'));
      size.textContent = `${blob.size.toLocaleString()} B`;
      content.replaceChildren();
      const format = assetFormatForFile({ name: path, type: blob.type });
      if (['image', 'video', 'audio'].includes(format?.kind) && !/\.svg$/i.test(path)) {
        const tag = format.kind === 'image' ? 'img' : format.kind;
        const media = node(tag, 'skill-file-media');
        media.src = objectUrl(blob.slice(0, blob.size, format.mimeTypes[0]));
        if (tag === 'img') media.alt = path;
        else { media.controls = true; media.preload = 'metadata'; }
        media.onerror = () => { if (token === generation) content.textContent = t('无法预览此文件，可从顶部下载'); };
        content.append(media); return;
      }
      let text;
      try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await blob.arrayBuffer()); if (text.includes('\0')) text = null; }
      catch { text = null; }
      if (token !== generation) return;
      if (text === null) { content.textContent = t('无法预览此文件，可从顶部下载'); return; }
      if (current.onChange) {
        const editor = node('textarea', 'skill-markdown-editor'); editor.value = text; editor.disabled = disabled;
        editor.setAttribute('aria-label', t('编辑文件：{path}', { path }));
        editor.oninput = () => current.onChange(path, new Blob([editor.value], { type: blob.type }));
        content.append(editor);
      } else if (/\.md$/i.test(path)) {
        const localImages = [];
        const display = text.replace(path === current.mainPath ? /^\uFEFF?---\r?\n[\s\S]*?\r?\n---\r?\n/ : /$^/, '');
        const article = renderMarkdownDocument(display, {
          renderLink: (href, label) => {
            const target = resolveSkillFileLink(path, href, current.paths);
            if (!target) return null;
            const link = node('a', '', label);
            link.href = '#' + encodeURIComponent(target.path);
            link.onclick = event => { event.preventDefault(); select(target.path); };
            return link;
          },
          resolveLink: (href, image) => {
            const target = image && resolveSkillFileLink(path, href, current.paths);
            if (!target) return href;
            localImages.push(target.path); return `document-image:${localImages.length - 1}`;
          },
          loadLocalImage: async ref => {
          const image = await current.readFile(localImages[Number(ref.split(':')[1])]);
          if (token !== generation) throw new Error(t('文件已切换'));
          const format = assetFormatForFile({ name: localImages[Number(ref.split(':')[1])], type: image.type });
          return blobToDataUrl(image.slice(0, image.size, format?.mimeTypes[0] || image.type));
        } });
        content.append(article);
      } else content.append(node('pre', 'skill-file-text', text || t('空文件 · 0 B')));
    } catch (error) {
      if (token === generation) content.textContent = translateUiMessage(error.message) || t('文件读取失败');
    }
  }
  return {
    setSource(value, preferred = selected) {
      source = value;
      const path = value.paths.includes(preferred) ? preferred : value.mainPath ?? value.paths[0];
      return select(path);
    },
    selection: () => selected,
    async selectedFile() { const path = selected, current = source; return { path, blob: await current.readFile(path) }; },
    setDisabled(value) { disabled = value; for (const control of host.querySelectorAll('button,textarea')) control.disabled = value; },
    dispose() { source = null; release(); tree.replaceChildren(); }
  };
}

function node(tag, className = '', text = '') { const element = document.createElement(tag); element.className = className; element.textContent = text; return element; }
function iconButton(icon, label) { const button = node('button', 'icon-button'); button.type = 'button'; button.title = label; button.setAttribute('aria-label', label); button.append(createUiIcon(icon)); return button; }
