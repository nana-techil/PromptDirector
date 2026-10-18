import { createUiIcon } from './ui-icons.js';
import { installPanelDrag, createPanelDragHandle } from './panel-drag.js';
import { savedPanelPosition, savePanelPosition } from './panel-position.js';

export function reviewTime(ms) {
  const seconds = Math.max(0, Number(ms) || 0) / 1000;
  return `${Math.floor(seconds / 60)}:${(seconds % 60).toFixed(2).padStart(5, '0')}`;
}
export function feedbackIcon(label, icon, t = value => value) {
  const button = document.createElement('button'); button.type = 'button'; button.className = 'icon-button';
  button.title = t(label); button.setAttribute('aria-label', t(label)); button.append(createUiIcon(icon)); return button;
}

// Retain earlier authored content without recreating the removed five-field
// editor. Videos show these values inside their single feedback surface.
export function mountAuthoredNotes(container, entry, t = value => value) {
  container.querySelector('.review-authored-notes')?.remove();
  if (entry.mediaAssets?.some(asset => asset.kind === 'video') || !Object.values(entry.creative || {}).some(value => value?.trim?.())) return;
  const section = document.createElement('details'); section.className = 'detail-section review-authored-notes';
  const heading = document.createElement('summary'); heading.textContent = t('创作备注'); section.append(heading);
  for (const value of Object.values(entry.creative)) {
    if (!value?.trim?.()) continue;
    const text = document.createElement('p'); text.textContent = value; section.append(text);
  }
  container.append(section);
}

// One feedback surface for stored videos and temporary outputs. Persistence is
// supplied by their respective services; neither edits reference material.
export function mountReviewFeedback({ container, notes = [], authored = {}, timed = true, getPosition, getRange, seek, saveNote, removeNote, t = value => value, changed = () => {} }) {
  const panel = document.createElement('section'); panel.className = 'review-feedback-panel ui-floating-panel ui-scrollbar'; panel.hidden = true;
  panel.setAttribute('aria-label', t('创作备注')); container.replaceChildren(panel);
  const header = document.createElement('header');
  const title = document.createElement('strong'); title.textContent = t('创作备注');
  const close = feedbackIcon('收起备注', 'x', t); header.append(createPanelDragHandle(t), title, close);
  const list = document.createElement('div'); list.className = 'review-feedback-list';
  const form = document.createElement('form'); form.className = 'review-feedback-form';
  const text = document.createElement('textarea'); text.rows = 3; text.name = 'reviewFeedback'; text.placeholder = t('哪里好，哪里需要调整？'); text.setAttribute('aria-label', t('备注内容'));
  const footer = document.createElement('footer');
  const times = document.createElement('div'); times.className = 'review-feedback-time';
  const start = document.createElement('input'); start.type = 'number'; start.min = '0'; start.step = 'any'; start.setAttribute('aria-label', t('开始时间（秒）')); start.title = t('开始时间（秒）');
  const end = start.cloneNode(); end.setAttribute('aria-label', t('结束时间（秒）')); end.title = t('结束时间（秒）'); end.hidden = true;
  const separator = document.createElement('span'); separator.textContent = '–'; separator.hidden = true; times.append(start, separator, end);
  const useRange = feedbackIcon('使用入出点区间', 'brackets', t); useRange.hidden = true;
  useRange.addEventListener('click', () => {
    const range = getRange?.();
    if (!validRange(range)) return;
    rangeMode = true; stamped = true;
    start.value = String(Math.round(range.startMs) / 1000);
    end.hidden = separator.hidden = false; end.value = String(Math.round(range.endMs) / 1000);
    changed();
  });
  const save = document.createElement('button'); save.type = 'submit'; save.textContent = t('保存'); save.title = t('保存备注'); save.className = 'review-feedback-save';
  const refreshTime = feedbackIcon('刷新时间', 'refresh-cw', t);
  refreshTime.dataset.reviewRefreshTime = '';
  times.hidden = refreshTime.hidden = !timed;
  refreshTime.addEventListener('click', async () => {
    if (busy) return;
    refreshTime.disabled = true;
    stamped = true; stampPromise = useCurrentTime();
    try { await stampPromise; } finally { refreshTime.disabled = false; }
  });
  const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'button-secondary review-feedback-cancel'; cancel.textContent = t('取消'); cancel.hidden = true;
  cancel.addEventListener('click', () => { if (busy) return; resetEditor(); void useCurrentTime(); text.focus(); });
  const timing = document.createElement('div'); timing.className = 'review-feedback-timing'; timing.hidden = !timed;
  timing.append(times, useRange, refreshTime);
  footer.append(cancel, save); form.append(timing, text, footer);
  const status = document.createElement('p'); status.className = 'review-feedback-status'; status.setAttribute('role', 'status');
  panel.append(header, list, form, status);
  let currentNotes = notes, busy = false, editingId = null, editingNote = null, rangeMode = false, stamped = true, stampPromise = Promise.resolve(), openIntent = 0;
  const dirty = () => Boolean(editingNote || text.value.trim());
  const updateDirty = () => {
    form.dataset.dirty = String(dirty());
    for (const button of list.querySelectorAll?.('[data-note-mutation]') || []) button.disabled = busy || dirty();
    changed();
  };
  function resetEditor() {
    editingId = editingNote = null; text.value = ''; stamped = false; rangeMode = false;
    end.hidden = separator.hidden = true; end.value = ''; cancel.hidden = true; save.textContent = t('保存');
    status.textContent = ''; status.classList.remove('is-error'); updateDirty();
  }
  form.addEventListener('input', event => {
    if (event.target === text && !stamped && !rangeMode) { stamped = true; stampPromise = useCurrentTime(); }
    if (event.target === start || event.target === end) stamped = true;
    updateDirty();
  });
  function validRange(range) { return Number.isFinite(range?.startMs) && Number.isFinite(range?.endMs) && range.endMs > range.startMs; }
  async function useCurrentTime() {
    rangeMode = false; end.hidden = separator.hidden = true; end.value = '';
    try { start.value = String(Math.round(await getPosition()) / 1000); }
    catch (error) { report(error); }
    useRange.hidden = !validRange(getRange?.()); changed();
  }
  const position = installFeedbackPosition(panel, header, container, report);
  function renderList() {
    list.replaceChildren();
    for (const note of currentNotes) {
      const row = document.createElement('div'); row.className = 'review-feedback-row';
      const jump = document.createElement('button'); jump.type = 'button'; jump.className = 'button-secondary review-feedback-jump';
      jump.textContent = `${reviewTime(note.startMs)}${note.endMs !== undefined ? `–${reviewTime(note.endMs)}` : ''}`;
      jump.addEventListener('click', () => { void Promise.resolve(seek(note.startMs)).catch(error => report(error)); });
      const content = document.createElement('p'); content.textContent = note.text;
      const edit = feedbackIcon('编辑备注', 'pencil', t); edit.dataset.noteMutation = '';
      edit.disabled = busy || dirty();
      edit.addEventListener('click', () => {
        if (busy || dirty()) return;
        editingNote = { ...note }; editingId = note.id; text.value = note.text; stamped = true;
        start.value = String((note.startMs || 0) / 1000); rangeMode = note.endMs !== undefined;
        end.hidden = separator.hidden = !rangeMode; end.value = rangeMode ? String(note.endMs / 1000) : '';
        cancel.hidden = false; save.textContent = t('保存修改'); status.textContent = '';
        updateDirty(); text.focus({ preventScroll: true });
      });
      const remove = feedbackIcon('删除备注', 'trash-2', t); remove.dataset.noteMutation = ''; remove.disabled = busy || dirty(); remove.classList.add('quiet-danger');
      remove.addEventListener('click', async () => {
        if (busy || dirty()) return; busy = true; updateDirty();
        try { const next = await removeNote(note.id); currentNotes = next; renderList(); changed(); }
        catch (error) { report(error); }
        finally { busy = false; updateDirty(); }
      });
      if (timed) row.append(jump);
      row.append(content, edit, remove); list.append(row);
    }
    const labels = { prompt: '创作提示词', summary: '提炼', notes: '备注', purpose: '用途', plan: '方案' };
    for (const [key, value] of Object.entries(authored)) {
      if (!value?.trim?.()) continue;
      const row = document.createElement('div'); row.className = 'review-feedback-authored';
      const label = document.createElement('small'); label.textContent = t(labels[key] || key);
      const content = document.createElement('p'); content.textContent = value; row.append(label, content); list.append(row);
    }
  }
  function report(error) { status.textContent = t(error.message || '保存失败'); status.classList.add('is-error'); }
  async function open() {
    const intent = ++openIntent;
    if (!dirty() && !editingId) {
      rangeMode = false; stamped = true;
      const range = getRange?.();
      try { start.value = String(Math.round(await getPosition()) / 1000); }
      catch (error) { start.value = ''; report(error); }
      end.hidden = separator.hidden = true; end.value = '';
      useRange.hidden = !validRange(range);
    }
    try { await position.restore(); } catch (error) { report(error); }
    if (intent !== openIntent) return;
    panel.hidden = false;
    position.place(); text.focus({ preventScroll: true }); changed();
  }
  function hide() { openIntent++; panel.hidden = true; changed(); } // Draft remains intact when folded.
  close.addEventListener('click', hide);
  async function submit() {
    if (busy || !dirty()) return;
    await stampPromise;
    if (busy) return;
    if (!text.value.trim()) return report(new Error('请填写备注'));
    if (start.value === '' || !start.checkValidity() || !end.checkValidity() || !end.hidden && Number(end.value) <= Number(start.value)) return report(new Error('请填写有效时间'));
    busy = true; save.disabled = true; refreshTime.disabled = true; useRange.disabled = true; text.disabled = true; close.disabled = true;
    start.disabled = end.disabled = cancel.disabled = true;
    updateDirty();
    save.textContent = t('正在保存…');
    editingId ||= `note:${crypto.randomUUID()}`;
    try {
      const note = { ...editingNote, id: editingId, startMs: Math.round(Number(start.value) * 1000), text: text.value,
        ...(!end.hidden ? { endMs: Math.round(Number(end.value) * 1000) } : {}) };
      if (end.hidden) delete note.endMs;
      currentNotes = await saveNote(note);
      resetEditor(); renderList();
    } catch (error) { report(error); }
    finally { busy = false; save.textContent = t(editingNote ? '保存修改' : '保存'); start.disabled = end.disabled = cancel.disabled = false; updateDirty(); save.disabled = false; refreshTime.disabled = false; useRange.disabled = false; text.disabled = false; close.disabled = false; text.focus({ preventScroll: true }); changed(); }
  }
  form.addEventListener('submit', event => { event.preventDefault(); void submit(); });
  renderList();
  return { open, hide, save: submit, panel, useCurrentTime, refreshTime: () => refreshTime.click(),
    newline() { text.setRangeText('\n', text.selectionStart, text.selectionEnd, 'end'); updateDirty(); },
    dispose() { openIntent++; position.dispose(); },
    update(value, annotations = authored) { currentNotes = value; authored = annotations; renderList(); },
    getState: () => ({ open: !panel.hidden, notes: currentNotes, draft: text.value, dirty: dirty(), saving: busy,
      startMs: start.value === '' ? null : Number(start.value) * 1000, endMs: end.hidden ? null : Number(end.value) * 1000 }),
    setSaveShortcut(key) { save.title = `${t('保存备注')}${key ? ` · ${key}` : ''}`; key ? save.setAttribute('aria-keyshortcuts', key) : save.removeAttribute('aria-keyshortcuts'); }
  };
}

// Keep the media owner in place; only the visible tool is lifted above both panes.
function installFeedbackPosition(panel, header, owner, failed) {
  let offset = null, saved = null, disposed = false, host = null;
  function place() {
    if (panel.hidden || disposed) return;
    const root = owner.closest('#detail-drawer, #temporary-review-dialog');
    if (!root) return;
    if (!host) {
      host = owner.parentElement === root ? owner : document.createElement('div');
      host.classList.add('review-feedback-positioner', 'ui-floating-panel-positioner'); host.style.inset = 'auto';
      if (host !== owner) root.append(host);
      host.append(panel);
    }
    const bounds = root.getBoundingClientRect();
    const gap = Number.parseFloat(getComputedStyle(panel).paddingTop) || 12;
    const close = root.querySelector('#detail-close, #temporary-review-close');
    const top = Math.max(gap, close ? close.getBoundingClientRect().bottom - bounds.top + gap : gap);
    panel.style.maxHeight = `${Math.max(0, bounds.height - top - gap)}px`;
    const { width, height } = panel.getBoundingClientRect();
    const x = Math.max(gap, Math.min(offset?.x ?? (saved ? saved.left * window.innerWidth - bounds.left : bounds.width - width - gap), bounds.width - width - gap));
    const y = Math.max(top, Math.min(offset?.y ?? (saved ? saved.top * window.innerHeight - bounds.top : top), bounds.height - height - gap));
    host.style.left = `${x}px`; host.style.top = `${y}px`;
    return { left: bounds.left + x, top: bounds.top + y };
  }
  const releaseDrag = installPanelDrag(header, {
    getPosition: () => ({ left: Number.parseFloat(host?.style.left) || 0, top: Number.parseFloat(host?.style.top) || 0 }),
    setPosition({ left, top }) { offset = { x: left, y: top }; return place(); },
    onEnd(position) {
      if (!position) return;
      saved = { left: position.left / window.innerWidth, top: position.top / window.innerHeight }; offset = null;
      void savePanelPosition('reviewFeedback', panel, position).catch(failed);
    }
  });
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(place) : null;
  observer?.observe(panel);
  window.addEventListener('resize', place);
  return { place, async restore() { const value = await savedPanelPosition('reviewFeedback'); if (!disposed && !offset) saved = value; },
    dispose() { disposed = true; observer?.disconnect(); window.removeEventListener('resize', place); releaseDrag(); if (host && host !== owner) host.remove(); } };
}
