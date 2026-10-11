import { currentLocale, t, translateUiMessage } from './i18n.js';
import { createUiIcon } from './ui-icons.js';
import { renderMarkdownDocument } from './markdown-renderer.js';
import { createCaptureProjectMenu } from './capture-organization.js';
import { setTaskFeedbackState } from './task-feedback.js';
import { getLibraryStorage } from './library-storage.js';
import { applyPageCaptureSelections } from './page-capture.js';
import { captureSaveProgressPresentation } from './capture-save-progress.js';
import { prepareReviewFile } from './review-file-transfer.js';
import { restoreCaptureSessions, captureSessionForPage, newCaptureConversation } from './capture-assistant-sessions.js';
import { buildCaptureDiagnostic, captureDiagnosticValue } from './capture-assistant-diagnostics.js';
import { diagnosticFilename } from './composer-diagnostics.js';
import { confirmAppAction } from './ui-dialogs.js';
import { LOCAL_ASSET_FILE_ACCEPT } from './local-media.js';
import { availableAiModelChoicesForTask } from './ai-provider-registry.js';
import { composerProfileForTaskAssignment } from './composer.js';
import { composerLibraryToolService } from './composer-service.js';
import { getMediaBlob } from './media-store.js';
const storage = getLibraryStorage();
const stateKey = 'captureAssistantDialog';

export function installCaptureAssistant({ getBatch, applyBatch, switchBatch = applyBatch, isBusy, getCollections, getDraft, getMetadata, changeProject, save, cancelSave }) {
  const panel = node('section', 'capture-assistant-panel'); panel.id = 'capture-assistant-panel'; panel.hidden = true;
  panel.setAttribute('aria-label', t('采集助手'));
  const contextRow = node('div', 'capture-assistant-context-row');
  const context = node('p', 'capture-assistant-context');
  const diagnosticButton = button('导出对话诊断', 'quiet compact capture-assistant-diagnostic'); diagnosticButton.id = 'capture-assistant-diagnostic';
  contextRow.append(context, diagnosticButton);
  const conversation = node('div', 'capture-assistant-conversation ui-scrollbar'); conversation.setAttribute('aria-label', t('采集助手')); conversation.setAttribute('role', 'log');
  const composer = node('form', 'capture-assistant-composer');
  const field = document.createElement('textarea'); field.id = 'capture-assistant-input'; field.rows = 2;
  field.placeholder = t('问怎么采集，或告诉我想保存什么…'); field.setAttribute('aria-label', field.placeholder);
  const controls = node('div', 'capture-assistant-controls');
  const attach = button('添加附件', 'quiet capture-assistant-attach'); attach.replaceChildren(createUiIcon('paperclip'));
  const file = document.createElement('input'); file.type = 'file'; file.multiple = true; file.hidden = true; file.accept = LOCAL_ASSET_FILE_ACCEPT;
  const model = node('select', 'capture-assistant-model'); model.id = 'capture-assistant-model'; model.setAttribute('aria-label', t('选择模型')); model.title = t('使用已配置的模型，可能产生 API 费用。');
  const attachmentRow = node('div', 'capture-assistant-attachments'); attachmentRow.hidden = true;
  const send = button('发送', 'capture-assistant-send'); send.id = 'capture-assistant-send'; send.type = 'submit'; send.replaceChildren(createUiIcon('arrow-up'));
  const stop = button('停止', 'button-secondary compact'); stop.id = 'capture-assistant-stop'; stop.hidden = true;
  const status = node('p', 'capture-assistant-status ui-task-feedback'); status.id = 'capture-assistant-status'; status.setAttribute('role', 'status');
  controls.append(attach, model, stop, send); composer.append(attachmentRow, field, controls, status, file); panel.append(contextRow, conversation, composer);
  document.querySelector('.collector-header').after(panel);
  const toggle = document.getElementById('open-capture-assistant'); toggle.setAttribute('aria-controls', panel.id);
  const fresh = button('新对话', 'quiet compact capture-assistant-new'); fresh.id = 'capture-assistant-new'; fresh.hidden = true; toggle.before(fresh);
  const project = node('details', 'detail-project-menu capture-assistant-project');
  const projects = createCaptureProjectMenu({ menu: project, getCollections, getDraft, onChange: changeProject, onError: error => feedback(error.message, true) });
  // Both collector project controls share one draft. Give this input its own DOM identity.
  project.querySelector('input').id = 'capture-assistant-new-project';
  let state = { messages: [], requestId: '', captureId: '' }, checking = false, opened = false, loaded = false;
  let baseBatch = null, previewBatch = null, renderedMessages = null, renderedBatch = undefined, resultPreview = null, stream = null, localSaving = false, preparingFiles = false;
  let persistTail = Promise.resolve(), syncTail = Promise.resolve(), switching = false, deferredPage = false;
  let sessions = restoreCaptureSessions(), modelChoices = [], renderedAttachments = '';
  const modelLabels = new Map();
  const attachmentUrls = new Map();
  function renderModels() {
    model.replaceChildren(...modelChoices.map(profile => {
      const option = document.createElement('option'); option.value = JSON.stringify(profile); option.textContent = modelLabels.get(JSON.stringify([profile.serviceId, profile.model])) || profile.model; return option;
    }));
    const selected = state.aiProfile;
    const current = modelChoices.find(profile => profile.serviceId === selected?.serviceId && profile.model === selected?.model);
    if (current) model.value = JSON.stringify(current);
    else { const placeholder = document.createElement('option'); placeholder.textContent = t('选择模型'); placeholder.value = ''; placeholder.disabled = true; placeholder.selected = true; model.prepend(placeholder); }
    model.disabled = busy() || !modelChoices.length;
  }
  function attachmentView(item, removable = false) {
    const chip = node('span', 'capture-assistant-attachment'); chip.dataset.transferId = item.transferId;
    if (item.kind === 'image') {
      const image = document.createElement('img'); image.alt = ''; chip.append(image);
      void getMediaBlob(item.assetId).then(blob => {
        if (!blob || !image.isConnected) return;
        if (!attachmentUrls.has(item.assetId)) attachmentUrls.set(item.assetId, URL.createObjectURL(blob));
        image.src = attachmentUrls.get(item.assetId);
      });
    }
    const label = node('span'); label.textContent = item.name; chip.append(label);
    if (removable) { const remove = button('移除', 'quiet compact'); remove.replaceChildren(createUiIcon('x')); remove.disabled = busy();
      remove.addEventListener('click', () => { state.attachments = state.attachments.filter(file => file.transferId !== item.transferId); void persist(); render(); }); chip.append(remove); }
    return chip;
  }
  window.addEventListener('pagehide', () => { attachmentUrls.forEach(url => URL.revokeObjectURL(url)); attachmentUrls.clear(); });
  function persist() {
    if (state.sourceUrl) {
      if (!switching) { const draft = getDraft() || {}; state.projectDraft = { collectionId: draft.collectionId || '', newCollectionName: draft.newCollectionName || '' }; }
      sessions.pages[state.sourceUrl] = state;
    }
    const snapshot = structuredClone(sessions);
    persistTail = persistTail.catch(() => {}).then(() => storage.set({ [stateKey]: snapshot }));
    return persistTail;
  }
  async function loadSessions() {
    if (loaded) return;
    sessions = restoreCaptureSessions((await storage.get(stateKey))[stateKey] || {}); loaded = true;
  }
  function syncPage() {
    syncTail = syncTail.catch(() => {}).then(async () => {
      await loadSessions();
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!/^https?:/iu.test(tab?.url || '')) return;
      if (state.sourceUrl === tab.url) {
        state.pageTitle = tab.title || state.pageTitle;
        context.textContent = t('当前网页 · {title}', { title: state.pageTitle }); context.title = tab.url;
        return;
      }
      // Ordinary writes and file preparation finish before replacing their view.
      if (localSaving || isBusy()) { deferredPage = true; return; }
      deferredPage = false;
      await projects.flush();
      const batch = getBatch();
      if (state.sourceUrl) { const draft = getDraft() || {}; state.projectDraft = { collectionId: draft.collectionId || '', newCollectionName: draft.newCollectionName || '' }; }
      if (state.sourceUrl) { if (!batch || batch.sourceUrl === state.sourceUrl) state.pendingBatch = batch; sessions.pages[state.sourceUrl] = state; }
      if (batch && batch.sourceUrl !== tab.url && !sessions.pages[batch.sourceUrl]) {
        sessions.pages[batch.sourceUrl] = { id: crypto.randomUUID(), sourceUrl: batch.sourceUrl, tabId: batch.tabId,
          pageTitle: batch.candidates?.[0]?.title, pendingBatch: batch, messages: [], requestId: '', captureId: '' };
      }
      state = captureSessionForPage(sessions, tab);
      const next = state.pendingBatch || (batch?.sourceUrl === tab.url ? batch : null);
      switching = true;
      try {
        if (state.projectDraft) await changeProject(state.projectDraft);
        switchBatch(next ? { ...next, tabId: tab.id } : null);
      }
      finally { switching = false; }
      baseBatch = getBatch(); previewBatch = baseBatch; state.pendingBatch = baseBatch;
      field.value = state.draft || ''; feedback(state.lastError || '', Boolean(state.lastError));
      context.textContent = t('当前网页 · {title}', { title: tab.title }); context.title = tab.url;
      await persist(); render();
    });
    return syncTail;
  }
  async function resume() {
    if (state.requestId) { feedback(t('正在回复…'), false, true); void check(); }
    else if (state.pendingRevision) { await applyPendingPreview(); await persist(); render(); }
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
    renderModels();
    const attachmentKey = JSON.stringify([state.id, state.attachments || [], busy()]);
    if (attachmentKey !== renderedAttachments) {
      attachmentRow.replaceChildren(...(state.attachments || []).map(item => attachmentView(item, true)));
      attachmentRow.hidden = !state.attachments?.length; renderedAttachments = attachmentKey;
    }
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
      if (message.attachments?.length) { const row = node('div', 'capture-assistant-attachments'); row.append(...message.attachments.map(item => attachmentView(item))); line.append(row); }
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
      await syncPage();
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      context.textContent = t('当前网页 · {title}', { title: tab?.title || getBatch()?.candidates[0]?.title || t('请先打开要采集的网页') }); context.title = tab?.url || '';
      const runtime = await chrome.runtime.sendMessage({ type: 'GET_COMPOSER_AI_RUNTIME' });
      if (!runtime?.ok) throw new Error(runtime?.message || '无法读取模型设置');
      const profiles = runtime.visionSettings?.providerProfiles || {};
      modelLabels.clear();
      modelChoices = availableAiModelChoicesForTask('creativePlanning', { providers: profiles }).flatMap(choice => {
        const profile = composerProfileForTaskAssignment({ providerId: choice.providerId, model: choice.modelId });
        modelLabels.set(JSON.stringify([profile.serviceId, profile.model]), `${choice.providerLabel} · ${profile.model}`);
        return profile.serviceId !== 'unassigned' && composerLibraryToolService({ aiProfile: profile }, runtime.aiSettings, runtime.visionSettings).nativeTools ? [profile] : [];
      });
      state.aiProfile ||= composerProfileForTaskAssignment(runtime.aiTaskAssignments?.creativePlanning);
      renderModels();
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
    if (!instruction && !state.attachments?.length) return;
    let owner;
    try {
      await syncPage();
      if (busy()) return;
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!/^https?:/iu.test(tab?.url || '')) throw new Error(t('请先打开要采集的网页'));
      const currentBatch = getBatch();
      const blockedByOtherPage = Boolean(currentBatch?.candidates.length && (currentBatch.tabId !== tab.id || currentBatch.sourceUrl !== tab.url));
      const reusableBatch = currentBatch?.candidates.length && currentBatch.tabId === tab.id && currentBatch.sourceUrl === tab.url;
      if (currentBatch !== baseBatch) state.captureId = '';
      baseBatch = currentBatch;
      if (state.tabId !== tab.id || state.sourceUrl !== tab.url) state.captureId = '';
      const requestId = crypto.randomUUID(), metadata = getDraft() || {};
      const attachments = [...(state.attachments || [])];
      const input = { instruction: instruction || t('请查看附件'), attachments, sessionId: state.id, aiProfile: state.aiProfile, messages: state.messages.map(message => message.role === 'result'
        ? { role: 'assistant', content: JSON.stringify({ saveReceipt: message.result }) } : message), tabId: tab.id,
        sourceUrl: tab.url, pageTitle: tab.title, locale: currentLocale(), project: metadata.collectionId || '', newCollectionName: metadata.newCollectionName || '', captureMetadata: getMetadata(),
        blockedByOtherPage, collectorBusy: isBusy(),
        ...(state.captureId ? { captureId: state.captureId } : reusableBatch ? { initialBatch: baseBatch } : {}) };
      state = { ...state, requestId, committing: false, tabId: tab.id, sourceUrl: tab.url, pendingRevision: null, draft: '', attachments: [], lastError: '', messages: [...state.messages, { role: 'user', content: input.instruction, attachments }] };
      owner = state;
      state.events = [...(state.events || []), { type: 'turn_started', requestId, tabId: tab.id, sourceUrl: tab.url, previewSourceUrl: currentBatch?.sourceUrl, at: new Date().toISOString() }];
      field.value = ''; await persist();
      if (state === owner) { render(); feedback(t('正在回复…'), false, true); conversation.scrollTop = conversation.scrollHeight; }
      const response = await chrome.runtime.sendMessage({ type: 'START_CAPTURE_ASSIST', requestId, input });
      if (!response?.ok) { owner.requestId = ''; throw new Error(response?.message || '采集助手未启动'); }
      if (state === owner) void check();
    } catch (error) {
      (owner || state).lastError = error.message; await persist();
      if (!owner || state === owner) { render(); feedback(error.message, true); }
    }
  }
  async function check() {
    if (checking || !state.requestId) return; checking = true;
    const owner = state, requestId = state.requestId;
    try {
      for (;;) {
        const response = await chrome.runtime.sendMessage({ type: 'GET_CAPTURE_ASSIST_TASK', requestId, waitMs: 15000 });
        if (state !== owner || state.requestId !== requestId) return;
        if (!response?.ok) { if (response?.code === 'task_not_found') state.requestId = ''; throw new Error(response?.message || '无法读取采集助手任务'); }
        const task = response.task;
        owner.taskState = task.state;
        if (['queued', 'running'].includes(task.state)) { if (!opened) return; continue; }
        state.turns = [...(state.turns || []), { requestId, taskState: task.state, diagnostic: task.result?.diagnostic, error: task.error }];
        state.captureId = task.result?.captureId || state.captureId; state.requestId = ''; state.committing = false;
        state.pendingRevision = task.result?.revision || null;
        if (task.result?.saveResult?.results?.length) state.messages = [...state.messages, { role: 'result', result: task.result.saveResult }];
        if (task.state !== 'completed' || task.result?.ok === false) {
          stream?.remove(); stream = null;
          if (!state.attachments?.length) state.attachments = state.messages.findLast(message => message.role === 'user')?.attachments || [];
          if (state.pendingRevision) await applyPendingPreview();
          throw new Error(task.error?.message || task.result?.message || t('采集未完成，已有内容保留'));
        }
        state.messages = [...state.messages, { role: 'assistant', content: task.result.text }];
        if (state.pendingRevision) await applyPendingPreview(); else feedback('');
        break;
      }
    } catch (error) { if (state === owner) { state.lastError = error.message; feedback(error.message, true); } }
    finally {
      checking = false; await persist(); render(); conversation.scrollTop = conversation.scrollHeight;
      if (opened && state.requestId && state !== owner) void check();
    }
  }
  async function applyPendingPreview() {
    const owner = state;
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    const source = await chrome.tabs.get(state.tabId).catch(() => null);
    if (state !== owner) return;
    if (!source || source.url !== state.sourceUrl || (/^https?:/iu.test(active?.url || '') && (active.id !== state.tabId || active.url !== state.sourceUrl)) || getBatch() !== baseBatch) {
      state.lastError = t('当前预览已变化，Agent 结果已保留'); feedback(state.lastError, true); return;
    }
    const preview = await chrome.runtime.sendMessage({ type: 'GET_CAPTURE_ASSIST_PREVIEW', input: { captureId: state.captureId, expectedRevision: state.pendingRevision } });
    if (!preview?.ok) throw new Error(preview?.message || '无法读取采集预览');
    if (state !== owner) return;
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
        state.lastError = '';
        state.events = [...(state.events || []), { type: 'manual_save', at: new Date().toISOString(), result: response }];
        state.messages = [...state.messages, { role: 'result', result: response }]; state.captureId = ''; state.pendingRevision = null;
        state.pendingBatch = getBatch();
        previewBatch = getBatch(); baseBatch = previewBatch;
        feedback('');
      } else throw new Error(response?.message || t('未保存，已有内容保留'));
    } catch (error) { state.lastError = error.message; feedback(error.message, true); }
    finally { localSaving = false; await persist(); render(); pageChanged(); conversation.scrollTop = conversation.scrollHeight; }
  }
  diagnosticButton.addEventListener('click', async () => {
    try {
      await persist();
      if (!await confirmAppAction({ title: t('导出对话诊断？'), description: t('诊断包包含各网页的多轮对话、采集步骤和失败原因，不包含 API Key 或媒体文件。'), confirmLabel: t('导出') })) return;
      const diagnostic = buildCaptureDiagnostic(sessions, state);
      diagnostic.capture.tasks = await Promise.all(Object.values(sessions.pages).filter(page => page.requestId).map(async page => {
        const receipt = await chrome.runtime.sendMessage({ type: 'GET_CAPTURE_ASSIST_TASK', requestId: page.requestId, waitMs: 0 });
        return captureDiagnosticValue({ requestId: page.requestId, sourceUrl: page.sourceUrl, receipt });
      }));
      const url = URL.createObjectURL(new Blob([JSON.stringify(diagnostic, null, 2)], { type: 'application/json' }));
      try { const link = document.createElement('a'); link.href = url; link.download = diagnosticFilename(state.pageTitle); link.click(); feedback(t('当前对话诊断包已导出')); }
      finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
    } catch (error) { feedback(error.message, true); }
  });
  const pageChanged = () => { void syncPage().then(() => opened ? resume() : undefined).catch(error => feedback(error.message, true)); };
  chrome.tabs.onActivated.addListener(pageChanged);
  chrome.tabs.onUpdated.addListener((_id, change, tab) => { if (tab.active && (change.url || change.title)) pageChanged(); });
  window.addEventListener('focus', pageChanged);
  toggle.addEventListener('click', () => { void open(!opened); });
  attach.addEventListener('click', () => file.click());
  async function addFiles(files) {
    if (!files.length || busy() || isBusy()) return;
    await syncPage(); const owner = state;
    localSaving = true; preparingFiles = true; render(); feedback(t('正在读取本机文件…'), false, true);
    try {
      for (const item of files) {
        const prepared = await prepareReviewFile(item, chrome, 'CAPTURE_LOCAL_FILE');
        owner.attachments = [...(owner.attachments || []), { transferId: prepared.transferId, assetId: prepared.asset.id,
          name: item.name, kind: prepared.asset.kind, mimeType: prepared.asset.mimeType }];
        await persist();
      }
      owner.lastError = '';
      feedback('');
    } catch (error) { owner.lastError = error.message; feedback(error.message, true); }
    finally { localSaving = false; preparingFiles = false; await persist(); render(); pageChanged(); }
  }
  file.addEventListener('change', () => { const files = [...file.files]; file.value = ''; void addFiles(files); });
  field.addEventListener('paste', event => {
    const files = [...(event.clipboardData?.files || [])];
    if (files.length) { event.preventDefault(); void addFiles(files); }
  });
  composer.addEventListener('dragover', event => { if (event.dataTransfer?.types.includes('Files')) event.preventDefault(); });
  composer.addEventListener('drop', event => {
    const files = [...(event.dataTransfer?.files || [])];
    if (files.length) { event.preventDefault(); void addFiles(files); }
  });
  fresh.addEventListener('click', async () => {
    await syncPage();
    if (busy()) return; state.pendingBatch = getBatch(); state = newCaptureConversation(sessions, state); field.value = ''; previewBatch = getBatch(); baseBatch = previewBatch;
    feedback(''); await persist(); render(); field.focus();
  });
  composer.addEventListener('submit', event => { event.preventDefault(); void submit(field.value.trim()); });
  field.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); if (!busy()) void submit(field.value.trim()); } });
  field.addEventListener('input', () => { state.draft = field.value; void persist(); });
  model.addEventListener('change', () => { state.aiProfile = JSON.parse(model.value); void persist(); });
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
        await syncPage();
        if (state.captureId && !getBatch() && !isBusy()) {
          const preview = await chrome.runtime.sendMessage({ type: 'GET_CAPTURE_ASSIST_PREVIEW', input: { captureId: state.captureId } });
          if (!preview?.ok) throw new Error(preview?.message || t('无法读取采集预览'));
          state.pendingBatch = preview.state === 'completed' ? null : preview.batch;
          applyBatch(state.pendingBatch);
        }
        baseBatch = getBatch(); previewBatch = baseBatch;
      } catch (error) { feedback(error.message, true); }
    },
    refresh: () => {
      if (!switching && (deferredPage && !isBusy() || getBatch() && state.sourceUrl && getBatch().sourceUrl !== state.sourceUrl)) { pageChanged(); return; }
      if (!switching && !state.requestId && !state.pendingRevision && getBatch() !== baseBatch) {
        state.captureId = ''; baseBatch = getBatch(); previewBatch = baseBatch;
        if (loaded && state.sourceUrl && (!baseBatch || baseBatch.sourceUrl === state.sourceUrl)) { state.pendingBatch = baseBatch; void persist(); }
      }
      render();
    } };
}
function node(tag, className = '') { const element = document.createElement(tag); element.className = className; return element; }
function button(label, className) { const element = node('button', className); element.type = 'button'; element.textContent = t(label); element.title = t(label); element.setAttribute('aria-label', t(label)); return element; }
function action(label, callback, className = '') { const element = button(label, className); element.dataset.captureAction = ''; element.addEventListener('click', () => { void callback(); }); return element; }
