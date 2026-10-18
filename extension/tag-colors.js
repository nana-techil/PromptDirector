import { normalizeTagColors, tagColorKey } from './tag-color-values.js';
import { t, updateUiPreferences } from './i18n.js';

let colors = {}, initialization, closePalette;
// Shared compact palette; existing saved colors remain unchanged until selected or reset.
const PALETTE = ['#ef4444', '#f97316', '#f59e0b', '#eab308', '#84cc16', '#22c55e', '#10b981', '#14b8a6', '#06b6d4', '#0ea5e9', '#3b82f6', '#6366f1', '#8b5cf6', '#a855f7', '#ec4899', '#f43f5e', '#64748b'];
function renderColors() {
  for (const button of document.querySelectorAll('button[data-tag-color]')) {
    button.style.setProperty('--tag-color', colors[button.dataset.tagColor] || '#65736d');
  }
}
function initializeColors() {
  return initialization ??= (async () => {
    let changed = false;
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes.uiPreferences) return;
      changed = true; colors = normalizeTagColors(changes.uiPreferences.newValue?.customTagColors); renderColors();
    });
    const stored = await chrome.storage.local.get('uiPreferences');
    if (!changed) { colors = normalizeTagColors(stored.uiPreferences?.customTagColors); renderColors(); }
  })();
}
export function decorateCustomTag(node, name, { editable = false } = {}) {
  const key = tagColorKey(name);
  node.dataset.customTag = key;
  const ready = initializeColors();
  if (!editable) { void ready.catch(() => {}); return; }
  const button = document.createElement('button');
  button.type = 'button'; button.className = 'tag-color-button'; button.dataset.tagColor = key;
  button.title = t('修改标签颜色：{value}', { value: name }); button.setAttribute('aria-label', button.title);
  button.setAttribute('aria-haspopup', 'dialog'); button.setAttribute('aria-expanded', 'false');
  button.style.setProperty('--tag-color', colors[key] || '#65736d');
  node.prepend(button);
  // New tags initialize only their own swatch; saved colors remain unchanged.
  void ready.then(() => button.style.setProperty('--tag-color', colors[key] || '#65736d')).catch(() => {});
  button.addEventListener('click', event => {
    event.stopPropagation();
    if (button.getAttribute('aria-expanded') === 'true') return closePalette?.();
    openPalette(button, key, name);
  });
}

function openPalette(anchor, key, name) {
  closePalette?.();
  const panel = document.createElement('div'); panel.className = 'tag-color-palette ui-floating-panel';
  panel.popover = 'manual'; panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', anchor.title);
  const heading = document.createElement('strong'); heading.textContent = name; heading.title = name;
  const options = document.createElement('div'); options.className = 'tag-color-options';
  const status = document.createElement('span'); status.className = 'tag-color-status'; status.setAttribute('role', 'status');
  const controller = new AbortController();
  const close = () => {
    controller.abort(); panel.remove(); anchor.setAttribute('aria-expanded', 'false');
    if (anchor.isConnected) anchor.focus({ preventScroll: true });
    if (closePalette === close) closePalette = null;
  };
  closePalette = close;
  const save = async color => {
    const buttons = [...panel.querySelectorAll('button')]; buttons.forEach(button => { button.disabled = true; });
    try {
      await updateUiPreferences({ customTagColors: { [key]: color } });
      if (color) colors[key] = color; else delete colors[key];
      renderColors(); close();
    } catch (error) { status.textContent = t(error.message); buttons.forEach(button => { button.disabled = false; }); }
  };
  for (const color of PALETTE) {
    const choice = document.createElement('button'); choice.type = 'button';
    choice.className = 'tag-color-choice'; choice.style.setProperty('--tag-color', color);
    choice.setAttribute('aria-label', color); choice.setAttribute('aria-pressed', String(colors[key] === color));
    choice.addEventListener('click', () => void save(color)); options.append(choice);
  }
  const reset = document.createElement('button'); reset.type = 'button'; reset.className = 'tag-color-choice tag-color-default';
  reset.title = t('恢复默认'); reset.setAttribute('aria-label', reset.title);
  reset.setAttribute('aria-pressed', String(!colors[key]));
  reset.addEventListener('click', () => void save(null)); options.append(reset);
  panel.append(heading, options, status); (anchor.closest('dialog[open]') || document.body).append(panel); panel.showPopover();
  anchor.setAttribute('aria-expanded', 'true');
  const position = () => {
    const rect = anchor.getBoundingClientRect();
    panel.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - panel.offsetWidth - 8))}px`;
    panel.style.top = `${Math.max(8, Math.min(rect.bottom + 6, innerHeight - panel.offsetHeight - 8))}px`;
  };
  position();
  options.firstElementChild.focus();
  document.addEventListener('pointerdown', event => { if (!panel.contains(event.target) && !anchor.contains(event.target)) close(); }, { signal: controller.signal, capture: true });
  panel.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); } });
  window.addEventListener('resize', close, { signal: controller.signal });
  document.addEventListener('scroll', event => { if (!panel.contains(event.target)) close(); }, { signal: controller.signal, capture: true });
}
