import { currentLocale, t, translateUiMessage } from './i18n.js';
import { createUiIcon } from './ui-icons.js';
import { renderMarkdownDocument } from './markdown-renderer.js';
import { createCaptureProjectMenu } from './capture-organization.js';
import { setTaskFeedbackState } from './task-feedback.js';
import { getLibraryStorage } from './library-storage.js';
import { applyPageCaptureSelections, normalizePageCaptureBatch } from './page-capture.js';
import { captureSaveProgressPresentation } from './capture-save-progress.js';
import { prepareReviewFile } from './review-file-transfer.js';
import { LOCAL_ASSET_FILE_ACCEPT } from './local-media.js';
const storage = getLibraryStorage();
const stateKey = 'captureAssistantDialog';

export function installCaptureAssistant({ getBatch, applyBatch, isBusy, getCollections, getDraft, getMetadata, changeProject, save, cancelSave }) {
  const panel = node('section', 'capture-assistant-panel'); panel.id = 'capture-assistant-panel'; panel.hidden = true;
  panel.setAttribute('aria-label', t('采集助手'));
  const context = node('p', 'capture-assistant-context');
  const conversation = node('div', 'capture-assistant-conversation ui-scrollbar'); conversation.setAttribute('aria-label', t('采集助手')); conversation.setAttribute('role', 'log');
  const composer = node('form', 'capture-assistant-composer');
  const field = document.createElement('textarea'); field.id = 'capture-assistant-input'; field.rows = 2;
  field.placeholder = t('问怎么采集，或告诉我想保存什么…'); field.setAttribute('aria-label', field.placeholder);
  const controls = node('div', 'capture-assistant-controls');
  const attach = button('补充本机文件', 'quiet capture-assistant-attach'); attach.replaceChildren(createUiIcon('paperclip'));
  const file = document.createElement('input'); file.type = 'file'; file.multiple = true; file.hidden = true; file.accept = LOCAL_ASSET_FILE_ACCEPT;
  const model = button('使用已配置的模型，可能产生 API 费用。', 'quiet capture-assistant-model');
  const send = button('发送', 'capture-assistant-send'); send.id = 'capture-assistant-send'; send.type = 'submit'; send.replaceChildren(createUiIcon('arrow-up'));
  const stop = button('停止', 'button-secondary compact'); stop.id = 'capture-assistant-stop'; stop.hidden = true;
  const status = node('p', 'capture-assistant-status ui-task-feedback'); status.id = 'capture-assistant-status'; status.setAttribute('role', 'status');
  controls.append(attach, model, stop, send); composer.append(field, controls, status, file); panel.append(context, conversation, composer);
  document.querySelector('.collector-header').after(panel);
  const toggle = document.getElementById('open-capture-assistant'); toggle.setAttribute('aria-controls', panel.id);
  const fresh = button('新对话', 'icon-button'); fresh.id = 'capture-assistant-new'; fresh.hidden = true; fresh.replaceChildren(createUiIcon('plus')); toggle.before(fresh);
  const project = node('details', 'detail-project-menu capture-assistant-project');
  const projects = createCaptureProjectMenu({ menu: project, getCollections, getDraft, onChange: changeProject, onError: error => feedback(error.message, true) });
  // Both collector project controls share one draft. Give this input its own DOM identity.
  project.querySelector('input').id = 'capture-assistant-new-project';
  let state = { messages: [], requestId: '', captureId: '' }, checking = false, opened = false, loaded = false;
  let baseBatch = null, previewBatch = null, renderedMessages = null, renderedBatch = undefined, resultPreview = null, stream = null, localSaving = false, preparingFiles = false;
  let persistTail = Promise.resolve();
  function persist() {
    const snapshot = structuredClone(state);
    persistTail = persistTail.catch(() => {}).then(() => storage.set({ [stateKey]: snapshot }));
    return persistTail;
  }
  function feedback(text, error = false, pending = false) {
    setTaskFeedbackState(status, { pending, error }); status.textContent = translateUiMessage(text || '');
  }
  function busy() { return Boolean(state.requestId || localSaving); }
  function render() {
    toggle.disabled = false; fresh.disabled = busy();
    field.disabled = localSaving;
    attach.disabled = busy() || isBusy();
    send.disabled = busy(); stop.hidden = preparingFiles || !(state.requestId || localSaving);
    stop.disabled = Boolean(state.committing);
    projects.render(busy() || isBusy());
    if (renderedMessages !== state.messages) {
      const nearEnd = conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight < 40;
      conversation.replaceChildren(...(state.messages.length ? state.messages.map(messageView) : [welcome()]));
      renderedMessages = state.messages; renderedBatch = undefined; resultPreview = null; stream = null;
      if (nearEnd) conversation.scrollTop = conversation.scrollHeight;
    }
    if (renderedBatch !== previewBatch) {
      resultPreview?.remove(); resultPreview = previewBatch ? previewView(previewBatch) : null;
      if (resultPreview) conversation.append(resultPreview);
      renderedBatch = previewBatch;
    }
    conversation.querySelectorAll('[data-capture-action]').forEach(element => {
      element.disabled = busy() || element.id === 'capture-assistant-save' && (isBusy() || !previewBatch?.selections.length);
    });
  }
  function messageView(message) {
    const line = node('section', `capture-assistant-message capture-assistant-${message.role === 'result' ? 'receipt' : message.role}`);
    if (message.role === 'result') {
      line.append(savedView(message.result)); return line;
    }
    if (message.role === 'user') {
      const bubble = node('div', 'capture-assistant-bubble'); bubble.textContent = message.content; line.append(bubble);
    } else {
      const speaker = node('div', 'capture-assistant-speaker'); speaker.append(createUiIcon('sparkles'), document.createTextNode(t('采集助手')));
      line.append(speaker, renderMarkdownDocument(message.content || ''));
    }
    return line;
  }
  function welcome() {
    const box = node('div', 'capture-assistant-welcome');
    const heading = node('h2'); heading.textContent = t('想保存这页的什么？'); box.append(heading);
    for (const label of ['这个怎么采集？', '怎么保存到项目？', '网页采集没成功']) {
      const item = action(label, () => submit(t(label)), 'quiet'); box.append(item);
    }
    return box;
  }
  function previewView(batch) {
    const selected = applyPageCaptureSelections(batch), first = selected[0] || batch.candidates[0];
    const card = node('section', 'capture-assistant-preview');
    const heading = node('div', 'capture-assistant-preview-heading');
    const title = node('strong'); title.textContent = first?.title || t('暂未取得可保存内容');
    const copy = node('div'); copy.append(title);
    const count = node('p', 'capture-assistant-preview-meta');
    count.textContent = selected.length ? t('已选 {count} 项 · {media} 个媒体', { count: selected.length, media: selected.reduce((sum, item) => sum + item.media.length, 0) }) : t('请选择要保存的内容'); copy.append(count);
    const media = first?.media.find(item => item.kind === 'image' || item.posterUrl);
    if (media && !media.localAssetId) {
      const image = document.createElement('img'); image.src = media.posterUrl || media.url; image.alt = ''; image.loading = 'lazy'; image.referrerPolicy = 'no-referrer';
      image.addEventListener('error', () => image.remove(), { once: true }); heading.append(image);
    }
    heading.append(copy); card.append(heading);
    if (first?.media.length) { const notice = node('p', 'capture-assistant-preview-meta'); notice.textContent = t('媒体原件将在保存时读取'); card.append(notice); }
    const localFiles = selected.flatMap(item => item.media).filter(item => item.localTransferId);
    if (localFiles.length) { const files = node('p', 'capture-assistant-preview-meta'); files.textContent = localFiles.map(item => item.filename).join(' · '); card.append(files); }
    const details = node('details', 'capture-assistant-original'); const summary = node('summary'); summary.textContent = t('查看原文'); details.append(summary);
    details.addEventListener('toggle', () => {
      if (details.open && details.childElementCount === 1) {
        for (const item of selected.length ? selected : batch.candidates) {
          const body = node('div'); const title = node('strong'); title.textContent = item.title;
          const text = node('p'); text.textContent = item.contentText; body.append(title, text); details.append(body);
        }
      }
    }); card.append(details);
    if (batch.error) {
      const reported = state.messages.some(message => message.role === 'result' &&
        [...new Set((message.result.results || []).flatMap(item => item.warnings || []))].join('；') === batch.error);
      if (!reported) {
        const error = node('p', 'capture-assistant-preview-error'); error.textContent = translateUiMessage(batch.error); card.append(error);
      }
      card.append(action('继续补采', () => submit(t('重新读取当前网页，补采缺失内容，先不要保存')), 'quiet compact'));
    }
    const adjust = action('调整选择', () => open(false), 'quiet compact'); card.append(adjust);
    const row = node('div', 'capture-assistant-save-row'); row.append(project);
    const saveButton = action('保存案例', savePreview); saveButton.id = 'capture-assistant-save'; saveButton.disabled = !selected.length || busy(); row.append(saveButton); card.append(row);
    return card;
  }
  function savedView(result) {
    const card = node('div', 'capture-assistant-result');
    for (const item of result.results || []) {
      const row = node('div');
      const title = node('strong'); title.textContent = item.title || t('案例'); row.append(title);
      const info = node('p'); info.textContent = translateUiMessage(item.status === 'partial' ? t('已部分保存，缺失内容可继续补采') : ['saved', 'duplicate'].includes(item.status) && item.entryId ? t('已保存') : t('未保存，已有内容保留')); row.append(info);
      if (item.warnings?.length) {
        const details = node('details', 'capture-assistant-original'); const summary = node('summary'); summary.textContent = t('查看原因');
        const warning = node('p', 'capture-assistant-preview-error'); warning.textContent = item.warnings.map(translateUiMessage).join('；');
        details.append(summary, warning); row.append(details);
      }
      if (item.entryId) row.append(action('打开案例', () => openCase(item.entryId), 'quiet compact'));
      card.append(row);
    }
    return card;
  }
  async function openCase(id) {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'SHOW_CAPTURE_ASSIST_CASE', caseId: id });
      if (!response?.ok) throw new Error(response?.message || t('无法打开案例'));
    } catch (error) { feedback(error.message, true); }
  }
  async function open(value) {
    opened = value; panel.hidden = !value; fresh.hidden = !value;
    document.body.classList.toggle('capture-assistant-open', value); toggle.setAttribute('aria-pressed', String(value));
    if (!value) return;
    try {
      if (!loaded) { state = (await storage.get(stateKey))[stateKey] || state; loaded = true; baseBatch = getBatch(); }
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      context.textContent = t('当前网页 · {title}', { title: tab?.title || getBatch()?.candidates[0]?.title || t('请先打开要采集的网页') }); context.title = tab?.url || '';
      const runtime = await chrome.runtime.sendMessage({ type: 'GET_COMPOSER_AI_RUNTIME' });
      if (!runtime?.ok) throw new Error(runtime?.message || '无法读取模型设置');
      const assignment = runtime.aiTaskAssignments?.creativePlanning;
      model.textContent = assignment?.model || t('选择模型');
      if (state.lastError) feedback(state.lastError, true);
      if (state.requestId) { feedback(t('正在回复…'), false, true); void check(); }
      else if (state.pendingRevision) { await applyPendingPreview(); await persist(); }
      else if (state.pendingBatch && !getBatch() && tab?.id === state.pendingBatch.tabId && tab.url === state.pendingBatch.sourceUrl) {
        applyBatch(state.pendingBatch); baseBatch = getBatch(); previewBatch = baseBatch;
      } else previewBatch = getBatch();
      field.value = state.draft || ''; render(); field.focus();
    } catch (error) { feedback(error.message, true); }
  }
  async function submit(instruction) {
    if (!instruction || busy()) return;
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!/^https?:/iu.test(tab?.url || '')) throw new Error(t('请先打开要采集的网页'));
      const currentBatch = getBatch();
      const blockedByOtherPage = Boolean(currentBatch?.candidates.length && (currentBatch.tabId !== tab.id || currentBatch.sourceUrl !== tab.url));
      const reusableBatch = currentBatch?.candidates.length && currentBatch.tabId === tab.id && currentBatch.sourceUrl === tab.url;
      if (currentBatch !== baseBatch) state.captureId = '';
      baseBatch = currentBatch;
      if (state.tabId !== tab.id || state.sourceUrl !== tab.url) state.captureId = '';
      const requestId = crypto.randomUUID(), metadata = getDraft() || {};
      const input = { instruction, messages: state.messages.map(message => message.role === 'result'
        ? { role: 'assistant', content: JSON.stringify({ saveReceipt: message.result }) } : message), tabId: tab.id,
        sourceUrl: tab.url, pageTitle: tab.title, locale: currentLocale(), project: metadata.collectionId || '', newCollectionName: metadata.newCollectionName || '', captureMetadata: getMetadata(),
        blockedByOtherPage, collectorBusy: isBusy(),
        ...(state.captureId ? { captureId: state.captureId } : reusableBatch ? { initialBatch: baseBatch } : {}) };
      state = { ...state, requestId, committing: false, tabId: tab.id, sourceUrl: tab.url, pendingRevision: null, draft: '', lastError: '', messages: [...state.messages, { role: 'user', content: instruction }] };
      field.value = ''; await persist(); render(); feedback(t('正在回复…'), false, true); conversation.scrollTop = conversation.scrollHeight;
      const response = await chrome.runtime.sendMessage({ type: 'START_CAPTURE_ASSIST', requestId, input });
      if (!response?.ok) { state.requestId = ''; throw new Error(response?.message || '采集助手未启动'); }
      void check();
    } catch (error) { state.lastError = error.message; await persist(); render(); feedback(error.message, true); }
  }
  async function check() {
    if (checking || !state.requestId) return; checking = true;
    try {
      const requestId = state.requestId;
      for (;;) {
        const response = await chrome.runtime.sendMessage({ type: 'GET_CAPTURE_ASSIST_TASK', requestId, waitMs: 15000 });
        if (!response?.ok) { if (response?.code === 'task_not_found') state.requestId = ''; throw new Error(response?.message || '无法读取采集助手任务'); }
        if (state.requestId !== requestId) return;
        const task = response.task;
        if (['queued', 'running'].includes(task.state)) { if (!opened) return; continue; }
        state.captureId = task.result?.captureId || state.captureId; state.requestId = ''; state.committing = false;
        state.pendingRevision = task.result?.revision || null;
        if (task.result?.saveResult?.results?.length) state.messages = [...state.messages, { role: 'result', result: task.result.saveResult }];
        if (task.state !== 'completed' || task.result?.ok === false) {
          if (state.pendingRevision) await applyPendingPreview();
          throw new Error(task.error?.message || task.result?.message || t('采集未完成，已有内容保留'));
        }
        state.messages = [...state.messages, { role: 'assistant', content: task.result.text }];
        if (state.pendingRevision) await applyPendingPreview(); else feedback('');
        break;
      }
    } catch (error) { state.lastError = error.message; feedback(error.message, true); }
    finally { checking = false; await persist(); render(); conversation.scrollTop = conversation.scrollHeight; }
  }
  async function applyPendingPreview() {
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    const source = await chrome.tabs.get(state.tabId).catch(() => null);
    if (!source || source.url !== state.sourceUrl || (/^https?:/iu.test(active?.url || '') && (active.id !== state.tabId || active.url !== state.sourceUrl)) || getBatch() !== baseBatch) {
      state.lastError = t('当前预览已变化，Agent 结果已保留'); feedback(state.lastError, true); return;
    }
    const preview = await chrome.runtime.sendMessage({ type: 'GET_CAPTURE_ASSIST_PREVIEW', input: { captureId: state.captureId, expectedRevision: state.pendingRevision } });
    if (!preview?.ok) throw new Error(preview?.message || '无法读取采集预览');
    if (getBatch() !== baseBatch) { state.lastError = t('当前预览已变化，Agent 结果已保留'); feedback(state.lastError, true); return; }
    state.pendingBatch = preview.state === 'completed' ? null : preview.batch;
    applyBatch(state.pendingBatch);
    baseBatch = getBatch(); previewBatch = baseBatch; state.pendingRevision = null; state.lastError = '';
    if (preview.state === 'completed') { state.captureId = ''; state.pendingBatch = null; }
    feedback('');
  }
  async function savePreview() {
    if (busy() || isBusy() || !previewBatch || previewBatch !== getBatch()) return;
    localSaving = true; render(); feedback(t('正在保存…'), false, true);
    try {
      if (!await projects.flush()) throw new Error(t('保存设置未更新，请重试'));
      const response = await save();
      if (response?.results?.length) {
        state.messages = [...state.messages, { role: 'result', result: response }]; state.captureId = ''; state.pendingRevision = null;
        state.pendingBatch = getBatch();
        previewBatch = getBatch(); baseBatch = previewBatch;
        feedback('');
      } else throw new Error(response?.message || t('未保存，已有内容保留'));
    } catch (error) { feedback(error.message, true); }
    finally { localSaving = false; await persist(); render(); conversation.scrollTop = conversation.scrollHeight; }
  }
  toggle.addEventListener('click', () => { void open(!opened); });
  attach.addEventListener('click', () => file.click());
  file.addEventListener('change', async () => {
    if (!file.files.length || busy() || isBusy()) return;
    const files = [...file.files]; file.value = '';
    const before = getBatch(); let expected = before; localSaving = true; preparingFiles = true; render(); feedback(t('正在读取本机文件…'), false, true);
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!/^https?:/iu.test(tab?.url || '') || before && (before.tabId !== tab.id || before.sourceUrl !== tab.url)) throw new Error(t('请先打开要采集的网页'));
      let batch = before || { id: crypto.randomUUID(), tabId: tab.id, sourceUrl: tab.url, selections: [], candidates: [{ id: crypto.randomUUID(), title: tab.title || files[0].name, canonicalUrl: tab.url, contentText: '', media: [] }] };
      const candidateId = batch.selections[0]?.candidateId || batch.candidates[0]?.id;
      if (!candidateId) throw new Error(t('请选择要保存的内容'));
      for (const item of files) {
        const prepared = await prepareReviewFile(item, chrome, 'CAPTURE_LOCAL_FILE');
        const asset = prepared.asset;
        if (getBatch() !== expected || (await chrome.tabs.get(tab.id)).url !== tab.url) throw new Error(t('当前预览已变化，附件已保留'));
        batch = normalizePageCaptureBatch({ ...batch,
          candidates: batch.candidates.map(candidate => candidate.id !== candidateId ? candidate : { ...candidate, media: [...candidate.media,
            { id: asset.id, localAssetId: asset.id, localTransferId: prepared.transferId, kind: asset.kind, url: '', placement: 'inline',
              filename: item.name, mimeType: asset.mimeType, contentHash: asset.contentHash, width: asset.width, height: asset.height }] }),
          selections: [...batch.selections.filter(selection => selection.candidateId !== candidateId),
            { ...(batch.selections.find(selection => selection.candidateId === candidateId) || { candidateId, includeText: Boolean(batch.candidates.find(candidate => candidate.id === candidateId)?.contentText) }),
              selectedMediaIds: [...(batch.selections.find(selection => selection.candidateId === candidateId)?.selectedMediaIds || []), asset.id], mediaDecision: 'confirmed' }] });
        state.captureId = ''; state.pendingRevision = null; state.pendingBatch = batch;
        applyBatch(batch); expected = getBatch(); previewBatch = expected; baseBatch = expected; await persist();
      }
      feedback('');
    } catch (error) { feedback(error.message, true); }
    finally { localSaving = false; preparingFiles = false; await persist(); render(); conversation.scrollTop = conversation.scrollHeight; }
  });
  fresh.addEventListener('click', async () => {
    if (busy()) return; state = { messages: [], requestId: '', captureId: '', draft: '', pendingBatch: getBatch() }; field.value = ''; previewBatch = getBatch(); baseBatch = previewBatch;
    feedback(''); await persist(); render(); field.focus();
  });
  composer.addEventListener('submit', event => { event.preventDefault(); void submit(field.value.trim()); });
  field.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); if (!busy()) void submit(field.value.trim()); } });
  field.addEventListener('input', () => { state.draft = field.value; void persist(); });
  model.addEventListener('click', () => {
    state.messages = [...state.messages, { role: 'assistant', content: t('使用已配置的模型，可能产生 API 费用。') }]; render(); void persist();
  });
  stop.addEventListener('click', async () => {
    if (localSaving) { await cancelSave(); return; }
    const response = await chrome.runtime.sendMessage({ type: 'CANCEL_CAPTURE_ASSIST', requestId: state.requestId });
    if (!response?.ok) feedback(response?.message, true);
  });
  chrome.runtime.onMessage.addListener(message => {
    if (message.type === 'CAPTURE_SAVE_PROGRESS' && (message.requestId === state.requestId || localSaving)) {
      feedback(captureSaveProgressPresentation(message.progress, t).message, false, true); return;
    }
    if (message.type !== 'CAPTURE_ASSIST_CHANGED' || message.requestId !== state.requestId) return;
    if (message.message) feedback(t(message.message), false, true);
    if (message.committing) { state.committing = true; render(); }
    if (message.preview) { state.captureId = message.preview.captureId; state.pendingRevision = message.preview.revision; void persist(); }
    if (typeof message.text === 'string' && opened) {
      const nearEnd = conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight < 40;
      if (!stream) { stream = node('section', 'capture-assistant-message capture-assistant-assistant'); conversation.append(stream); }
      stream.replaceChildren(renderMarkdownDocument(message.text)); if (nearEnd) conversation.scrollTop = conversation.scrollHeight;
    }
  });
  return { panel,
    async restore() {
      try {
        state = (await storage.get(stateKey))[stateKey] || state; loaded = true;
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (state.pendingBatch && !getBatch() && !isBusy() && tab?.url === state.pendingBatch.sourceUrl) {
          applyBatch({ ...state.pendingBatch, tabId: tab.id });
        } else if (state.captureId && !getBatch() && !isBusy() && tab?.id === state.tabId && tab.url === state.sourceUrl) {
          const preview = await chrome.runtime.sendMessage({ type: 'GET_CAPTURE_ASSIST_PREVIEW', input: { captureId: state.captureId } });
          if (!preview?.ok) throw new Error(preview?.message || t('无法读取采集预览'));
          state.pendingBatch = preview.state === 'completed' ? null : preview.batch;
          applyBatch(state.pendingBatch);
        }
        baseBatch = getBatch(); previewBatch = baseBatch;
      } catch (error) { feedback(error.message, true); }
    },
    refresh: () => {
      if (!state.requestId && !state.pendingRevision && getBatch() !== baseBatch) {
        state.captureId = ''; baseBatch = getBatch(); previewBatch = baseBatch;
        if (loaded && state.pendingBatch) { state.pendingBatch = baseBatch; void persist(); }
      }
      render();
    } };
}
function node(tag, className = '') { const element = document.createElement(tag); element.className = className; return element; }
function button(label, className) { const element = node('button', className); element.type = 'button'; element.textContent = t(label); element.title = t(label); element.setAttribute('aria-label', t(label)); return element; }
function action(label, callback, className = '') { const element = button(label, className); element.dataset.captureAction = ''; element.addEventListener('click', () => { void callback(); }); return element; }
