import { currentLocale, t, translateUiMessage } from './i18n.js';
import { createUiIcon } from './ui-icons.js';
import { renderMarkdownDocument } from './markdown-renderer.js';
import { setTaskFeedbackState } from './task-feedback.js';
import { getLibraryStorage } from './library-storage.js';
import { captureSaveProgressPresentation } from './capture-save-progress.js';
import { prepareReviewFile } from './review-file-transfer.js';
import { restoreCaptureSessions, captureSessionForPage, newCaptureConversation, pageWork, recentCaptureConversations } from './capture-assistant-sessions.js';
import { buildCaptureDiagnostic, captureDiagnosticValue } from './capture-assistant-diagnostics.js';
import { diagnosticFilename } from './composer-diagnostics.js';
import { confirmAppAction } from './ui-dialogs.js';
import { LOCAL_ASSET_FILE_ACCEPT } from './local-media.js';
import { availableAiModelChoicesForTask } from './ai-provider-registry.js';
import { composerProfileForTaskAssignment } from './composer.js';
import { composerLibraryToolService } from './composer-service.js';
import { getMediaBlob } from './media-store.js';
import { captureReceiptText } from './assistant-chat-session.js';
const storage = getLibraryStorage();
const stateKey = 'captureAssistantDialog';

export function installCaptureAssistant({ getBatch, applyBatch, switchBatch = applyBatch, isBusy, isAutomaticCapturing = () => false, getBatchEditVersion = () => 0, getDraft, getMetadata, changeProject }) {
  const panel = node('section', 'capture-assistant-panel'); panel.id = 'capture-assistant-panel'; panel.hidden = true;
  panel.setAttribute('aria-label', t('采集助手'));
  const contextRow = node('div', 'capture-assistant-context-row');
  const context = node('p', 'capture-assistant-context');
  const diagnosticButton = button('导出对话诊断', 'quiet compact capture-assistant-diagnostic'); diagnosticButton.id = 'capture-assistant-diagnostic';
  const chats = node('select', 'capture-assistant-model capture-assistant-chats'); chats.id = 'capture-assistant-chats'; chats.setAttribute('aria-label', t('切换对话'));
  contextRow.append(context, diagnosticButton);
  const conversation = node('div', 'capture-assistant-conversation ui-scrollbar'); conversation.setAttribute('aria-label', t('采集助手')); conversation.setAttribute('role', 'log');
  const composer = node('form', 'capture-assistant-composer');
  const field = document.createElement('textarea'); field.id = 'capture-assistant-input'; field.rows = 2;
  field.placeholder = t('采集、查找或管理案例…'); field.setAttribute('aria-label', field.placeholder);
  const controls = node('div', 'capture-assistant-controls');
  const attach = button('添加附件', 'quiet capture-assistant-attach'); attach.replaceChildren(createUiIcon('paperclip'));
  const file = document.createElement('input'); file.type = 'file'; file.multiple = true; file.hidden = true; file.accept = LOCAL_ASSET_FILE_ACCEPT;
  const model = node('select', 'capture-assistant-model'); model.id = 'capture-assistant-model'; model.setAttribute('aria-label', t('选择模型')); model.title = t('使用已配置的模型，可能产生 API 费用。');
  const attachmentRow = node('div', 'capture-assistant-attachments'); attachmentRow.hidden = true;
  const send = button('发送', 'capture-assistant-send'); send.id = 'capture-assistant-send'; send.type = 'submit'; send.replaceChildren(createUiIcon('arrow-up'));
  const stop = button('停止', 'button-secondary compact'); stop.id = 'capture-assistant-stop'; stop.hidden = true;
  const status = node('p', 'capture-assistant-status ui-task-feedback'); status.id = 'capture-assistant-status'; status.setAttribute('role', 'status');
  controls.append(attach, model, stop, send); composer.append(attachmentRow, field, controls, status, file); panel.append(chats, contextRow, conversation, composer);
  document.querySelector('.collector-header').after(panel);
  const toggle = document.getElementById('open-capture-assistant'); toggle.setAttribute('aria-controls', panel.id);
  const fresh = button('新对话', 'quiet compact capture-assistant-new'); fresh.id = 'capture-assistant-new'; fresh.hidden = true; toggle.before(fresh);
  let state = { messages: [], requestId: '', captureId: '' }, checking = false, opened = false, loaded = false;
  let baseBatch = null, renderedMessages = null, stream = null, localSaving = false, preparingFiles = false;
  let persistTail = Promise.resolve(), syncTail = Promise.resolve(), switching = false, deferredPage = false, submitting = false, opening = false;
  const pendingWrites = new Map(); let writing = false;
  const persistedPages = new Map(); let persistedDialog = '';
  function samePageWork(left, right) {
    return left && left.pendingBatch === right.pendingBatch && left.tabId === right.tabId && left.captureId === right.captureId
      && left.pendingRevision === right.pendingRevision && JSON.stringify(left.projectDraft) === JSON.stringify(right.projectDraft);
  }
  let sessions = restoreCaptureSessions(), modelChoices = [], renderedAttachments = '', localEdits = 0;
  const modelLabels = new Map(), chatRevisions = new Map();
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
  function persist({ saveChat = true, draftOnly = false } = {}) {
    if (!switching) state.projectDraft = organizationDraft();
    const index = sessions.conversations.findIndex(item => item.id === state.id);
    if (index >= 0) sessions.conversations[index] = state;
    if (state.sourceUrl) sessions.pages[state.sourceUrl] = pageWork(state);
    const pending = pendingWrites.get(state.id);
    pendingWrites.set(state.id, {owner:state, saveChat:saveChat || pending?.saveChat,
      draftOnly: !(saveChat && !draftOnly || pending?.saveChat && !pending.draftOnly)});
    if (writing) return persistTail;
    writing = true;
    persistTail = persistTail.catch(() => {}).then(async () => {
      while (pendingWrites.size) {
        const [id, {owner, saveChat, draftOnly}] = pendingWrites.entries().next().value; pendingWrites.delete(id);
        for (const message of owner.messages) message.id ||= crypto.randomUUID();
        // Page originals live in pageWork. Typing a chat draft must not copy
        // every webpage's preview or send the same batch to the background again.
        const { pendingBatch: _pendingBatch, ...view } = owner;
        const sentTurns = new Set(owner.turns || []);
        const smallDraft = draftOnly && chatRevisions.has(owner.id);
        const chat = smallDraft ? {id:owner.id,draft:owner.draft,chatRevision:owner.chatRevision} : structuredClone(view);
        const changedPages = Object.entries(sessions.pages).filter(([url, work]) => !samePageWork(persistedPages.get(url), work));
        const snapshot = { schema: 'shared-chat', pages: Object.fromEntries(changedPages.map(([url, work]) => [url, structuredClone(work)])), activeId: sessions.activeId, activeUrl: sessions.activeUrl,
          emptyChat: !owner.messages.length && !owner.draft && !owner.attachments?.length
            ? {id:owner.id,aiProfile:owner.aiProfile,messages:[],sourceUrl:owner.sourceUrl,tabId:owner.tabId,pageTitle:owner.pageTitle,projectDraft:owner.projectDraft} : null };
        if (saveChat && (chatRevisions.has(owner.id) || owner.userCreated || owner.messages.length || owner.draft || owner.attachments?.length)) {
          chat.chatRevision = chatRevisions.get(chat.id) ?? owner.chatRevision ?? chat.chatRevision;
          const response = await chrome.runtime.sendMessage({ type: 'UPSERT_ASSISTANT_CHAT', chat, draftOnly:smallDraft, activate:state.id === owner.id });
          if (!response?.ok) throw new Error(response?.message || t('无法保存创作草稿'));
          owner.chatRevision = response.session.chatRevision; owner.updatedAt = response.session.updatedAt; owner.title = response.session.title;
          chatRevisions.set(chat.id, response.session.chatRevision);
          // The canonical conversation now owns these diagnostics. Keep only
          // newly arrived turns in the UI until their next successful write.
          if (!smallDraft && owner.turns) owner.turns = owner.turns.filter(turn => !sentTurns.has(turn));
        }
        const dialog = JSON.stringify([snapshot.activeId, snapshot.activeUrl, snapshot.emptyChat]);
        if (changedPages.length || dialog !== persistedDialog) await storage.update(stateKey, stored => ({[stateKey]: {
          ...stored[stateKey], schema:'shared-chat', activeUrl:snapshot.activeUrl,
          pages: { ...stored[stateKey]?.pages, ...snapshot.pages },
          ...(state.id === owner.id ? {activeId:owner.id,emptyChat:snapshot.emptyChat} : {})
        }}));
        changedPages.forEach(([url, work]) => persistedPages.set(url, work)); persistedDialog = dialog;
      }
    }).finally(() => { writing = false; });
    return persistTail;
  }
  async function loadSessions() {
    if (loaded) return;
    const stored = (await storage.get(stateKey))[stateKey] || {};
    const response = await chrome.runtime.sendMessage({type:'GET_ASSISTANT_CHATS', activeId:stored.activeId});
    if (!response?.ok) throw new Error(response?.message || t('无法读取对话'));
    response.chats.forEach(chat => chatRevisions.set(chat.id, chat.chatRevision || 0));
    const latest = (await storage.get(stateKey))[stateKey] || stored;
    if (latest.emptyChat?.id === latest.activeId && !response.chats.some(chat => chat.id === latest.activeId)) response.chats.push(latest.emptyChat);
    sessions = restoreCaptureSessions({...latest, conversations:response.chats}); loaded = true;
    Object.entries(sessions.pages).forEach(([url, work]) => persistedPages.set(url, work));
  }
  function organizationDraft() {
    const draft = getDraft() || {};
    return { collectionId: draft.collectionId || '', newCollectionName: draft.newCollectionName || '',
      contentTypeId: draft.contentTypeId || '', contentTypeExplicit: Boolean(draft.contentTypeExplicit) };
  }
  function syncPage() {
    syncTail = syncTail.catch(() => {}).then(async () => {
      await loadSessions();
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      context.textContent = t('当前网页 · {title}', { title: tab?.title || t('案例库与对话') }); context.title = tab?.url || '';
      if (localSaving || isBusy()) { deferredPage = true; return; }
      deferredPage = false;
      const batch = getBatch();
      if (state.id) {
        state.projectDraft = organizationDraft();
        if (!batch || batch.sourceUrl === state.sourceUrl) state.pendingBatch = batch;
      }
      if (batch && batch.sourceUrl !== tab?.url) sessions.pages[batch.sourceUrl] = {
        ...sessions.pages[batch.sourceUrl], sourceUrl: batch.sourceUrl, tabId: batch.tabId, pendingBatch: batch,
        projectDraft: organizationDraft()
      };
      const previousUrl = state.sourceUrl, previousId = state.id;
      state = captureSessionForPage(sessions, tab);
      // Browsing cannot retarget a request which is still executing.
      if (!state.requestId && (previousUrl !== state.sourceUrl || previousId !== state.id)) {
        const next = state.pendingBatch || (batch?.sourceUrl === tab?.url ? batch : null);
        switching = true;
        try {
          if (state.projectDraft) await changeProject(state.projectDraft);
          switchBatch(next ? { ...next, tabId: tab?.id } : null);
        } finally { switching = false; }
        baseBatch = getBatch(); state.pendingBatch = baseBatch;
        field.value = state.draft || ''; feedback(state.lastError || '', Boolean(state.lastError));
      }
      if (previousUrl !== state.sourceUrl || previousId !== state.id) await persist({saveChat:false});
      render();
    });
    return syncTail;
  }
  async function resume() {
    if (state.requestId) { feedback(t('正在回复…'), false, true); void check(); }
    else if (state.pendingRevision) { await applyPendingPreview(); await persist(); render(); }
  }
  function applyAssistantBatch(batch) {
    // Collector rendering calls refresh synchronously. Restoring the assistant's
    // own preview is not a manual edit and must retain its capture identity.
    switching = true;
    try { applyBatch(batch); }
    finally { switching = false; }
    baseBatch = getBatch();
    state.pendingBatch = baseBatch;
  }
  function feedback(text, error = false, pending = false) {
    setTaskFeedbackState(status, { pending, error }); status.textContent = translateUiMessage(text || '');
  }
  function busy() { return Boolean(opening || submitting || state.requestId || localSaving); }
  function render() {
    toggle.disabled = false; fresh.disabled = busy();
    chats.disabled = busy();
    chats.replaceChildren(...recentCaptureConversations(sessions).map((session, index) => {
      const option = document.createElement('option'); option.value = session.id;
      option.textContent = session.title || session.messages.find(message => message.role === 'user')?.content || t('新对话');
      if (option.textContent.length > 32) option.textContent = option.textContent.slice(0, 32) + '…';
      option.selected = session.id === state.id; return option;
    }));
    const remove = document.createElement('option'); remove.value = 'all'; remove.textContent = t('全部对话…'); chats.append(remove);
    field.disabled = localSaving || opening;
    attach.disabled = busy() || isBusy();
    send.disabled = busy(); stop.hidden = preparingFiles || submitting || !(state.requestId || localSaving);
    stop.disabled = Boolean(state.committing);
    renderModels();
    const attachmentKey = JSON.stringify([state.id, state.attachments || [], busy()]);
    if (attachmentKey !== renderedAttachments) {
      attachmentRow.replaceChildren(...(state.attachments || []).map(item => attachmentView(item, true)));
      attachmentRow.hidden = !state.attachments?.length; renderedAttachments = attachmentKey;
    }
    if (renderedMessages !== state.messages) {
      const nearEnd = conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight < 40;
      conversation.replaceChildren(...(state.messages.length ? state.messages.map(messageView) : [welcome()]));
      renderedMessages = state.messages; stream = null;
      if (nearEnd) conversation.scrollTop = conversation.scrollHeight;
    }
    conversation.querySelectorAll('[data-capture-action]').forEach(element => {
      element.disabled = busy();
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
      line.append(speaker, replyView(message.content || ''));
    }
    return line;
  }
  function replyView(text) {
    return renderMarkdownDocument(text);
  }
  function welcome() {
    const box = node('div', 'capture-assistant-welcome');
    const heading = node('h2'); heading.textContent = t('想让我帮你做什么？'); box.append(heading);
    for (const label of ['这个怎么采集？', '打开案例库', '查找案例']) {
      const item = action(label, () => submit(t(label)), 'quiet'); box.append(item);
    }
    return box;
  }
  function savedView(result) {
    const card = node('div', 'capture-assistant-result');
    for (const item of result.results || []) {
      const row = node('div');
      const title = node('strong'); title.textContent = item.title || t('案例'); row.append(title);
      const info = node('p'); info.textContent = translateUiMessage(item.status === 'partial' ? t('已部分保存，缺失内容可继续补采') : item.status === 'duplicate' && item.entryId ? t('已有案例，未新增采集内容。') : item.status === 'saved' && item.entryId ? t('已保存') : t('未保存，已有内容保留')); row.append(info);
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
    const label = t(value ? '采集工具' : '采集助手'); toggle.title = label; toggle.setAttribute('aria-label', label);
    toggle.classList.add('capture-assistant-mode-toggle');
    const labels = document.createElement('span'); labels.className = 'capture-assistant-mode-labels';
    for (const [text, active] of [['工具', value], ['助手', !value]]) {
      const label = document.createElement('span'); label.textContent = t(text);
      label.style.visibility = active ? 'visible' : 'hidden'; label.setAttribute('aria-hidden', String(!active)); labels.append(label);
    }
    toggle.replaceChildren(createUiIcon(value ? 'layers' : 'sparkles'), labels);
    if (!value) return;
    if (opening) return;
    opening = true; render();
    try {
      await syncPage();
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      context.textContent = t('当前网页 · {title}', { title: tab?.title || getBatch()?.candidates[0]?.title || t('案例库与对话') }); context.title = tab?.url || '';
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
        applyAssistantBatch(state.pendingBatch);
      }
      field.value = state.draft || ''; render(); field.focus();
    } catch (error) { feedback(error.message, true); }
    finally { opening = false; render(); }
  }
  async function submit(instruction) {
    if (busy() || !instruction && !state.attachments?.length) return;
    submitting = true; render(); feedback(t('正在回复…'), false, true);
    let owner;
    try {
      await syncPage();
      if (state.requestId || localSaving) return;
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const target = tab || {};
      const currentBatch = getBatch();
      const reusableBatch = currentBatch?.status === 'preview' && currentBatch.candidates.length && currentBatch.tabId === target.id && currentBatch.sourceUrl === target.url;
      if (currentBatch !== baseBatch) state.captureId = '';
      baseBatch = currentBatch;
      if (state.tabId !== target.id || state.sourceUrl !== target.url) state.captureId = '';
      const requestId = crypto.randomUUID(), metadata = getDraft() || {};
      const attachments = [...(state.attachments || [])];
      const userMessageId = crypto.randomUUID();
      const input = { instruction: instruction || t('请查看附件'), userMessageId, attachments, sessionId: state.id, aiProfile: state.aiProfile, messages: state.messages.map(message => message.role === 'result'
        ? { role: 'assistant', content: captureReceiptText(message.result) } : message), ...(Number.isInteger(target.id) ? { tabId: target.id } : {}),
        sourceUrl: target.url || '', pageTitle: target.title || '', locale: currentLocale(), project: metadata.collectionId || '', newCollectionName: metadata.newCollectionName || '', captureMetadata: getMetadata(),
        ...(state.captureId ? { captureId: state.captureId } : reusableBatch ? { initialBatch: baseBatch } : {}) };
      state = { ...state, requestId, awaitingAutomaticPreview: isAutomaticCapturing(), previewEditVersion: getBatchEditVersion(), committing: false, tabId: target.id, sourceUrl: target.url || '', pendingRevision: null, draft: '', attachments: [], lastError: '', messages: [...state.messages, { id: userMessageId, role: 'user', content: input.instruction, attachments }] };
      owner = state;
      state.events = [...(state.events || []), { type: 'turn_started', requestId, tabId: target.id, sourceUrl: target.url || '', previewSourceUrl: currentBatch?.sourceUrl, at: new Date().toISOString() }];
      field.value = ''; render(); conversation.scrollTop = conversation.scrollHeight;
      await persist();
      const response = await chrome.runtime.sendMessage({ type: 'START_CAPTURE_ASSIST', requestId, input });
      if (!response?.ok) {
        owner.messages = owner.messages.slice(0, -1); owner.draft = input.instruction; owner.attachments = attachments;
        owner.requestId = response?.code === 'capture_busy' && response.sessionId === owner.id ? response.requestId : '';
        if (state === owner) { field.value = owner.draft; if (owner.requestId) void check(); }
        throw new Error(response?.message || '采集助手未启动');
      }
      if (state === owner) void check();
    } catch (error) {
      if (owner && !owner.requestId) owner.committing = false;
      (owner || state).lastError = error.message; await persist();
      if (!owner || state === owner) { render(); feedback(error.message, true); }
    } finally { submitting = false; render(); if (opened && state.requestId) void check(); }
  }
  async function check() {
    // Page/focus events can request a resume while persistence and START are
    // still pending. The durable task cannot be inspected until START returns.
    if (submitting || checking || !state.requestId) return; checking = true;
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
    // A completed automatic scan is not a newer human selection. Adopt that
    // baseline before applying the explicitly requested assistant result.
    if (state.awaitingAutomaticPreview && state.previewEditVersion === getBatchEditVersion() && getBatch()?.sourceUrl === state.sourceUrl) baseBatch = getBatch();
    if (!source || source.url !== state.sourceUrl || (/^https?:/iu.test(active?.url || '') && (active.id !== state.tabId || active.url !== state.sourceUrl)) || getBatch() !== baseBatch) {
      state.events = [...(state.events || []), { type: 'preview_conflict', at: new Date().toISOString(), sourceUrl: state.sourceUrl,
        sourceTabId: state.tabId, activeTabId: active?.id, activeUrl: active?.url, currentSourceUrl: source?.url,
        baseBatchId: baseBatch?.id, currentBatchId: getBatch()?.id, currentBatchSourceUrl: getBatch()?.sourceUrl,
        awaitingAutomaticPreview: state.awaitingAutomaticPreview, humanEdited: state.previewEditVersion !== getBatchEditVersion() }];
      state.lastError = t('当前预览已变化，Agent 结果已保留'); feedback(state.lastError, true); return;
    }
    const preview = await chrome.runtime.sendMessage({ type: 'GET_CAPTURE_ASSIST_PREVIEW', input: { captureId: state.captureId, expectedRevision: state.pendingRevision } });
    if (!preview?.ok) throw new Error(preview?.message || '无法读取采集预览');
    if (state !== owner) return;
    if (getBatch() !== baseBatch) { state.lastError = t('当前预览已变化，Agent 结果已保留'); feedback(state.lastError, true); return; }
    if (preview.batch && preview.batch.id !== state.pendingBatch?.id) {
      if (!await changeProject({ contentTypeId: '', contentTypeExplicit: false })) throw new Error(t('保存设置未更新，请重试'));
      if (state !== owner || getBatch() !== baseBatch) return;
      state.projectDraft = organizationDraft();
    }
    state.pendingBatch = preview.state === 'completed' ? null : preview.batch;
    applyAssistantBatch(state.pendingBatch);
    baseBatch = getBatch(); state.pendingRevision = null; state.lastError = '';
    if (preview.state === 'completed') { state.captureId = ''; state.pendingBatch = null; }
    feedback('');
  }
  diagnosticButton.addEventListener('click', async () => {
    try {
      await persist();
      if (!await confirmAppAction({ title: t('导出对话诊断？'), description: t('诊断包包含各网页的多轮对话、采集步骤和失败原因，不包含 API Key 或媒体文件。'), confirmLabel: t('导出') })) return;
      const full = await chrome.runtime.sendMessage({type:'GET_ASSISTANT_CHATS',activeId:state.id,includeDiagnostics:true});
      if (!full?.ok) throw new Error(full?.message || t('无法读取对话'));
      const diagnostic = buildCaptureDiagnostic({...sessions,conversations:full.chats}, state);
      diagnostic.capture.tasks = await Promise.all(sessions.conversations.filter(page => page.requestId).map(async page => {
        const receipt = await chrome.runtime.sendMessage({ type: 'GET_CAPTURE_ASSIST_TASK', requestId: page.requestId, waitMs: 0 });
        return captureDiagnosticValue({ requestId: page.requestId, sourceUrl: page.sourceUrl, receipt });
      }));
      const url = URL.createObjectURL(new Blob([JSON.stringify(diagnostic, null, 2)], { type: 'application/json' }));
      try { const link = document.createElement('a'); link.href = url; link.download = diagnosticFilename(state.pageTitle); link.click(); feedback(t('当前对话诊断包已导出')); }
      finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
    } catch (error) { feedback(error.message, true); }
  });
  const pageChanged = () => { void syncPage().then(() => opened ? resume() : undefined).catch(error => feedback(error.message, true)); };
  void open(false);
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
          name: item.name, kind: prepared.asset.kind, mimeType: prepared.asset.mimeType, byteSize: item.size }];
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
  chats.addEventListener('change', async () => {
    if (busy()) return;
    const selected = chats.value;
    await persist({saveChat:false});
    if (selected === 'all') {
      await chrome.tabs.create({url:chrome.runtime.getURL(`composer.html?session=${encodeURIComponent(state.id)}`)}); render(); return;
    }
    sessions.activeId = selected;
    state = sessions.conversations.find(session => session.id === sessions.activeId);
    // Restore the chosen conversation; its next turn observes the current tab.
    renderedMessages = null; field.value = state.draft || ''; feedback(state.lastError || '', Boolean(state.lastError));
    await syncPage(); await persist({saveChat:false}); render(); field.focus();
  });
  fresh.addEventListener('click', async () => {
    if (busy()) return; localEdits++; state.pendingBatch = getBatch(); state = newCaptureConversation(sessions, state); field.value = ''; baseBatch = getBatch();
    feedback(''); render(); field.focus();
    try { await persist(); } catch (error) { feedback(error.message, true); }
  });
  composer.addEventListener('submit', event => { event.preventDefault(); void submit(field.value.trim()); });
  field.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); if (!busy()) void submit(field.value.trim()); } });
  field.addEventListener('input', () => { localEdits++; state.draft = field.value; void persist({draftOnly:true}).catch(error => feedback(error.message,true)); });
  model.addEventListener('change', () => { localEdits++; state.aiProfile = JSON.parse(model.value); void persist().catch(error => feedback(error.message,true)); });
  stop.addEventListener('click', async () => {
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
    if (message.preview) {
      state.captureId = message.preview.captureId; state.pendingRevision = message.preview.revision;
      if (message.preview.sourceUrl) { state.sourceUrl = message.preview.sourceUrl; state.tabId = message.preview.tabId; }
      void persist();
    }
    if (typeof message.text === 'string' && opened) {
      const nearEnd = conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight < 40;
      if (!stream) { stream = node('section', 'capture-assistant-message capture-assistant-assistant'); conversation.append(stream); }
      stream.replaceChildren(replyView(message.text)); if (nearEnd) conversation.scrollTop = conversation.scrollHeight;
    }
  });
  storage.subscribe(changes => {
    if (!changes.composerSessionSummaries || !loaded || busy() || preparingFiles) return;
    void persistTail.catch(() => {}).then(async () => {
      const id = state.id, edit = localEdits;
      const response = await chrome.runtime.sendMessage({type:'GET_ASSISTANT_CHATS', activeId:id});
      if (state.id !== id || edit !== localEdits || busy() || !response?.ok) return;
      const saved = response.chats.find(chat => chat.id === id);
      if (!saved && state.chatRevision > 0) {
        sessions.conversations = response.chats; sessions.activeId = '';
        sessions = restoreCaptureSessions(sessions);
        state = captureSessionForPage(sessions,(await chrome.tabs.query({active:true,currentWindow:true}))[0]);
        field.value = state.draft || ''; renderedMessages = null; render(); return;
      }
      if (saved && saved.chatRevision > Math.max(state.chatRevision || 0,chatRevisions.get(id) || 0)) {
        const pendingBatch = state.pendingBatch;
        state = {...saved,pendingBatch}; chatRevisions.set(state.id,state.chatRevision);
        field.value = state.draft || ''; renderedMessages = null;
      }
      sessions.conversations = [...response.chats.filter(chat => chat.id !== state.id),state]; render();
    }).catch(error => feedback(error.message,true));
  });
  return { panel,
    async restore() {
      try {
        await syncPage();
        if (state.captureId && !getBatch() && !isBusy()) {
          const preview = await chrome.runtime.sendMessage({ type: 'GET_CAPTURE_ASSIST_PREVIEW', input: { captureId: state.captureId } });
          if (!preview?.ok) throw new Error(preview?.message || t('无法读取采集预览'));
          state.pendingBatch = preview.state === 'completed' ? null : preview.batch;
          applyAssistantBatch(state.pendingBatch);
        }
        baseBatch = getBatch();
      } catch (error) { feedback(error.message, true); }
    },
    refresh: () => {
      if (!switching && (deferredPage && !isBusy() || getBatch() && state.sourceUrl && getBatch().sourceUrl !== state.sourceUrl)) { pageChanged(); return; }
      if (!switching && !state.requestId && !state.pendingRevision && getBatch() !== baseBatch) {
        state.captureId = ''; baseBatch = getBatch();
        if (loaded && state.sourceUrl && (!baseBatch || baseBatch.sourceUrl === state.sourceUrl)) { state.pendingBatch = baseBatch; void persist({saveChat:false}); }
      }
      render();
    } };
}
function node(tag, className = '') { const element = document.createElement(tag); element.className = className; return element; }
function button(label, className) { const element = node('button', className); element.type = 'button'; element.textContent = t(label); element.title = t(label); element.setAttribute('aria-label', t(label)); return element; }
function action(label, callback, className = '') { const element = button(label, className); element.dataset.captureAction = ''; element.addEventListener('click', () => { void callback(); }); return element; }
