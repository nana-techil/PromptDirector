import { currentLocale, t, translateUiMessage } from './i18n.js';
import { createUiIcon } from './ui-icons.js';
import { setTaskFeedbackState } from './task-feedback.js';
import { getLibraryStorage } from './library-storage.js';
const storage = getLibraryStorage();
const stateKey = 'captureAssistantDialog';

export function installCaptureAssistant({ getBatch, applyBatch, isBusy }) {
  const dialog = document.createElement('dialog');
  dialog.className = 'app-dialog ui-dialog capture-assistant-dialog'; dialog.id = 'capture-assistant-dialog';
  dialog.setAttribute('aria-label', t('Agent 采集'));
  const header = document.createElement('header'); header.className = 'ui-dialog-header';
  const heading = document.createElement('h2'); heading.textContent = t('Agent 采集');
  const close = button('关闭', 'icon-button app-dialog-close'); close.id = 'capture-assistant-close'; close.replaceChildren(createUiIcon('x'));
  header.append(heading, close);
  const body = document.createElement('div'); body.className = 'app-dialog-body';
  const model = document.createElement('p'); model.className = 'capture-assistant-model';
  const conversation = document.createElement('div'); conversation.className = 'capture-assistant-conversation ui-scrollbar';
  const field = document.createElement('textarea'); field.id = 'capture-assistant-input'; field.rows = 3;
  field.placeholder = t('描述想采集的内容，或指出漏采的部分'); field.setAttribute('aria-label', field.placeholder);
  const status = document.createElement('p'); status.id = 'capture-assistant-status'; status.className = 'app-dialog-status ui-task-feedback'; status.setAttribute('role', 'status');
  body.append(model, conversation, field, status);
  const footer = document.createElement('footer'); footer.className = 'ui-dialog-footer';
  const stop = button('停止', 'button-secondary'); stop.id = 'capture-assistant-stop'; stop.hidden = true;
  const send = button('发送', 'primary'); send.id = 'capture-assistant-send';
  footer.append(stop, send); dialog.append(header, body, footer); document.body.append(dialog);
  let state = { messages: [], requestId: '', captureId: '' }, checking = false, baseBatch = null, renderedMessages = null;
  const persist = () => storage.set({ [stateKey]: state });
  function feedback(text, error = false, pending = false) { setTaskFeedbackState(status, { pending, error }); status.textContent = translateUiMessage(text || ''); }
  function render() {
    if (renderedMessages !== state.messages) {
      conversation.replaceChildren(...state.messages.map(message => {
        const line = document.createElement('p'); line.className = `capture-assistant-${message.role}`; line.textContent = message.content; return line;
      }));
      renderedMessages = state.messages;
    }
    document.getElementById('open-capture-assistant').disabled = isBusy();
    send.disabled = Boolean(state.requestId) || isBusy(); stop.hidden = !state.requestId;
  }
  close.addEventListener('click', () => dialog.close());
  field.addEventListener('input', () => { state.draft = field.value; void persist(); });
  document.getElementById('open-capture-assistant').addEventListener('click', async () => {
    if (isBusy()) return;
    dialog.showModal();
    try {
      state = (await storage.get(stateKey))[stateKey] || state; render(); field.value = state.draft || '';
      const runtime = await chrome.runtime.sendMessage({ type: 'GET_COMPOSER_AI_RUNTIME' });
      if (!runtime?.ok) throw new Error(runtime?.message || '无法读取模型设置');
      const assignment = runtime.aiTaskAssignments?.creativePlanning;
      model.textContent = assignment?.model ? `${assignment.model} · ${t('使用已配置的模型，可能产生 API 费用。')}` : t('创作规划未配置，请在 AI 服务的任务路由中选择模型');
      if (state.lastError) feedback(state.lastError, true);
      if (state.requestId) void check();
      else if (state.pendingRevision) { await applyPendingPreview(); await persist(); }
      field.focus();
    } catch (error) { feedback(error.message, true); }
  });
  send.addEventListener('click', async () => {
    const instruction = field.value.trim(); if (!instruction || state.requestId || isBusy()) return;
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!/^https?:/iu.test(tab?.url || '')) throw new Error(t('请先打开要采集的网页'));
      const currentBatch = getBatch();
      if (currentBatch && currentBatch !== baseBatch) state.captureId = '';
      baseBatch = currentBatch;
      if (state.tabId !== tab.id || state.sourceUrl !== tab.url) { state.messages = []; state.captureId = ''; }
      const requestId = crypto.randomUUID();
      const messages = state.messages;
      const input = { instruction, messages, tabId: tab.id, sourceUrl: tab.url, locale: currentLocale(),
        ...(state.captureId ? { captureId: state.captureId } : baseBatch ? { initialBatch: baseBatch } : {}) };
      state = { ...state, requestId, tabId: tab.id, sourceUrl: tab.url, pendingRevision: null, draft: '', lastError: '', messages: [...messages, { role: 'user', content: instruction }] };
      field.value = ''; await persist(); render(); feedback(t('正在读取网页…'), false, true);
      const response = await chrome.runtime.sendMessage({ type: 'START_CAPTURE_ASSIST', requestId, input });
      if (!response?.ok) { state.requestId = ''; throw new Error(response?.message || '采集助手未启动'); }
      void check();
    } catch (error) { state.lastError = error.message; await persist(); render(); feedback(error.message, true); }
  });
  stop.addEventListener('click', async () => {
    const response = await chrome.runtime.sendMessage({ type: 'CANCEL_CAPTURE_ASSIST', requestId: state.requestId });
    if (!response?.ok) feedback(response?.message, true);
  });
  async function check() {
    if (checking || !state.requestId) return; checking = true;
    try {
      const requestId = state.requestId;
      for (;;) {
        const response = await chrome.runtime.sendMessage({ type: 'GET_CAPTURE_ASSIST_TASK', requestId, waitMs: 15000 });
        if (!response?.ok) { if (response?.code === 'task_not_found') state.requestId = ''; throw new Error(response?.message || '无法读取采集助手任务'); }
        if (state.requestId !== requestId) return;
        const task = response.task;
        if (['queued', 'running'].includes(task.state)) {
          // Only wait for the user-started task while this dialog is visible.
          if (!dialog.open) return;
          continue;
        }
        state.captureId = task.result?.captureId || state.captureId;
        state.requestId = '';
        if (task.state !== 'completed') throw new Error(task.error?.message || task.result?.message || t('采集未完成，已有内容保留'));
        state.messages = [...state.messages, { role: 'assistant', content: task.result.text }];
        state.pendingRevision = task.result.revision;
        await applyPendingPreview();
        break;
      }
    } catch (error) { state.lastError = error.message; feedback(error.message, true); }
    finally { checking = false; await persist(); render(); }
  }
  async function applyPendingPreview() {
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    const source = await chrome.tabs.get(state.tabId).catch(() => null);
    if (!source || source.url !== state.sourceUrl
      || (/^https?:/iu.test(active?.url || '') && (active.id !== state.tabId || active.url !== state.sourceUrl))
      || getBatch() !== baseBatch) {
      state.lastError = t('当前预览已变化，Agent 结果已保留'); feedback(state.lastError, true); return;
    }
    const preview = await chrome.runtime.sendMessage({ type: 'GET_CAPTURE_ASSIST_PREVIEW', input: { captureId: state.captureId, expectedRevision: state.pendingRevision } });
    if (!preview?.ok) throw new Error(preview?.message || '无法读取采集预览');
    if (getBatch() !== baseBatch) { state.lastError = t('当前预览已变化，Agent 结果已保留'); feedback(state.lastError, true); return; }
    applyBatch(preview.batch); baseBatch = getBatch(); state.pendingRevision = null; state.lastError = ''; feedback('');
  }
  chrome.runtime.onMessage.addListener(message => {
    if (message.type === 'CAPTURE_ASSIST_CHANGED' && message.requestId === state.requestId) feedback(t(message.message), false, true);
  });
  return { dialog, refresh: render };
}
function button(label, className) {
  const element = document.createElement('button'); element.type = 'button'; element.className = className;
  element.textContent = t(label); element.setAttribute('aria-label', t(label)); return element;
}
