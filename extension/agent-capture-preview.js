import { agentError, requireAgentId, requireInteger, requireWebUrl, AGENT_CHUNK_BYTES } from './agent-protocol.js';
import { waitForAgentTab } from './agent-capture.js';
import { normalizePageCaptureBatch, normalizePageCaptureCandidate } from './page-capture.js';
import { PAGE_CAPTURE_LIMITS } from './resource-limits.js';
import { resolveAgentProject } from './agent-save.js';
import { operationBudget } from './resource-policy.js';

const prefix = 'agentCapture:';
export function createAgentCapturePreview({ storage, chromeApi, collect, commit, loadState, getLibraryId, budget }) {
  const key = id => prefix + requireAgentId(id);
  async function own(id) {
    const record = (await storage.get(key(id)))[key(id)];
    if (!record) throw agentError('capture_not_found', '没有找到采集预览，请核对采集编号');
    if (record.libraryId !== await getLibraryId()) throw agentError('library_mismatch', '采集预览属于另一份资料库');
    return record;
  }
  async function persist(record) {
    await storage.set({ [key(record.id)]: record });
    if (record.state !== 'completed') return;
    try {
      // Only saved previews are automatic history. Unfinished material and
      // durable task receipts remain available; library originals never enter
      // this cleanup. Work from a small index, without reading the case library.
      const indexKey = `agentCaptureHistory:${record.libraryId}`;
      const history = (await storage.get(indexKey))[indexKey] || [];
      const policy = operationBudget(budget);
      const next = [{ id: record.id, bytes: new Blob([JSON.stringify(record)]).size }, ...history.filter(item => item.id !== record.id)];
      let bytes = next.reduce((total, item) => total + item.bytes, 0);
      const removed = [];
      while (next.length > 1 && (next.length > policy.maxAutomaticHistoryItems || bytes > policy.maxAutomaticHistoryBytes)) {
        const old = next.pop(); bytes -= old.bytes; removed.push(key(old.id));
      }
      if (removed.length) await storage.remove(removed);
      await storage.set({ [indexKey]: next });
    } catch (error) { console.warn('Capture preview history cleanup deferred', error.name); }
  }
  function version(record, input) {
    if (input.expectedRevision !== undefined && record.revision !== input.expectedRevision) {
      throw agentError('capture_changed', '采集预览已改变，请重新读取后继续');
    }
  }
  function summary(record) {
    return { ok: true, captureId: record.id, revision: record.revision, state: record.state,
      sourceUrl: record.batch.sourceUrl, tabId: record.batch.tabId,
      candidates: record.batch.candidates.map(item => ({ id: item.id, title: item.title,
        canonicalUrl: item.canonicalUrl, completeness: item.completeness,
        textCharacters: item.contentText.length, media: item.media.map(({ id, kind, url }) => ({ id, kind, url })) })),
      selections: record.batch.selections, saveMode: record.batch.saveMode, combinedTitle: record.batch.combinedTitle,
      ...(record.lastSaveRequestId ? { lastSaveRequestId: record.lastSaveRequestId } : {}),
      ...(record.results ? { results: record.results } : {}), untrustedContent: true };
  }
  return {
    async view(input) {
      const record = await own(input.captureId); version(record, input);
      return { ...summary(record), batch: record.batch };
    },
    async read(input) {
      const record = await own(input.captureId);
      version(record, input);
      const part = input.part ?? 'summary';
      if (part === 'summary') return summary(record);
      if (!['page', 'candidate'].includes(part)) throw agentError('invalid_input', '采集读取部分无效');
      const offset = input.offset ?? 0, length = input.length ?? 12000;
      requireInteger(offset); requireInteger(length, { min: 1, max: AGENT_CHUNK_BYTES / 4 });
      if (offset && input.expectedRevision === undefined) throw agentError('capture_revision_required', '续读请携带首屏revision');
      const candidate = part === 'candidate' ? record.batch.candidates.find(item => item.id === input.candidateId) : null;
      if (part === 'candidate' && !candidate) throw agentError('capture_candidate_not_found', '没有找到这项采集内容');
      const text = JSON.stringify(part === 'page' ? record.page : candidate);
      return { captureId: record.id, revision: record.revision, part, content: text.slice(offset, offset + length),
        offset, totalCharacters: text.length, nextOffset: offset + length < text.length ? offset + length : null,
        untrustedContent: true };
    },
    async execute(operation, input, requestId, scope) {
      if (operation === 'prepare_capture') {
        if (Boolean(input.url) === (input.tabId !== undefined)) throw agentError('invalid_input', '请选择url或tabId其中一个');
        const mode = input.mode ?? 'loaded';
        if (!['loaded', 'whole'].includes(mode)) throw agentError('invalid_input', '采集模式无效');
        const maxCandidates = input.maxCandidates ?? PAGE_CAPTURE_LIMITS.maxCandidates;
        requireInteger(maxCandidates, { min: 1 });
        if (input.tabId !== undefined) requireInteger(input.tabId);
        let tab = input.tabId !== undefined ? await chromeApi.tabs.get(input.tabId) : { url: requireWebUrl(input.url) };
        await permission(tab.url);
        if (input.url) tab = await waitForAgentTab(chromeApi.tabs, (await chromeApi.tabs.create({ url: tab.url, active: true })).id);
        const url = requireWebUrl(tab.url);
        await permission(url);
        if (input.initialBatch && (input.initialBatch.tabId !== tab.id || input.initialBatch.sourceUrl !== url)) {
          throw agentError('page_changed', '当前采集预览属于其他网页，请先完成当前采集');
        }
        const snapshot = input.initialBatch || await collect(tab, { sessionId: requestId, mode, maxCandidates });
        const [evidence] = await chromeApi.scripting.executeScript({ target: { tabId: tab.id },
          func: readCapturePageEvidence, args: [input.selector || ''] });
        if (!evidence?.result?.ok) throw agentError('capture_page_unavailable', evidence?.result?.message || '无法读取采集网页');
        if ((await chromeApi.tabs.get(tab.id)).url !== url || evidence.result.url !== url) {
          throw agentError('page_changed', '读取时网页地址已改变，未生成采集预览');
        }
        await scope.assertCurrent();
        const batch = normalizePageCaptureBatch({ ...snapshot, id: requestId, tabId: tab.id, sourceUrl: url,
          selections: input.initialBatch?.selections || [] });
        const record = { id: requestId, libraryId: scope.libraryId, revision: 1, state: 'preview', batch, page: evidence.result };
        await persist(record);
        return summary(record);
      }
      const record = await own(input.captureId);
      requireInteger(input.expectedRevision, { min: 1 });
      version(record, input);
      if (record.state !== 'preview') throw agentError('capture_not_editable', '本预览已保存或保存状态尚未确认，请先核对保存任务');
      if (operation === 'update_capture') {
        const candidates = [...record.batch.candidates];
        const ids = new Set();
        for (const value of input.candidates ?? []) {
          if (!value?.id || ids.has(value.id)) throw agentError('invalid_input', '补充内容编号缺失或重复');
          ids.add(value.id);
          requireWebUrl(value.canonicalUrl);
          for (const item of value.media ?? []) requireWebUrl(item.url);
          const index = candidates.findIndex(item => item.id === value.id);
          const prior = candidates[index];
          if (prior && prior.canonicalUrl !== requireWebUrl(value.canonicalUrl)) throw agentError('capture_source_changed', '已有候选的来源不能改为其他网页，请另建候选');
          for (const item of value.media ?? []) {
            const original = prior?.media.find(media => media.id === item.id);
            if (original && original.url !== requireWebUrl(item.url)) throw agentError('capture_source_changed', '已有媒体的来源不能替换，请另建媒体');
          }
          const added = appendOriginal(value.contentText, value.originalPrompt);
          const contentText = appendOriginal(prior?.contentText, added);
          const extraText = prior?.contentText && !prior.contentText.includes(added) ? added : '';
          const extraBlock = { id: `agent:${requestId}:${value.id}`, kind: 'section', text: extraText, sourceOrder: prior?.textBlocks.length || 0 };
          const candidate = normalizePageCaptureCandidate({ ...prior, ...value,
            contentText,
            // Retain the full structured document and all original text. These
            // blocks are already chosen, so do not score/filter them again.
            textBlocks: prior ? [...prior.textBlocks.map(block => ({ ...block, kind: 'section' })), ...(extraText ? [extraBlock] : [])] : [],
            articleDocument: prior?.articleDocument && { ...prior.articleDocument,
              blocks: [...prior.articleDocument.blocks, ...(extraText ? [{ ...extraBlock, kind: 'paragraph', sourceOrder: prior.articleDocument.blocks.length }] : [])] },
            sourceFacts: { ...prior?.sourceFacts, ...(value.author ? { author: value.author } : {}),
              ...(value.originalPrompt ? { originalPromptAvailable: true } : {}), status: 'partial' },
            media: [...(prior?.media || []), ...(value.media || [])],
            // Agent supplementation is observed material, not proof of completeness.
            completeness: 'partial', adapter: prior?.adapter || 'generic' });
          if (!candidate) throw agentError('invalid_input', '补充内容无法保存');
          if (index < 0) candidates.push(candidate); else candidates[index] = candidate;
        }
        const selections = input.selections ?? record.batch.selections;
        const selected = new Set();
        for (const item of selections) {
          const candidate = candidates.find(value => value.id === item.candidateId);
          if (!candidate || selected.has(item.candidateId) || typeof item.includeText !== 'boolean' || !Array.isArray(item.selectedMediaIds)
            || item.selectedMediaIds.some(id => !candidate.media.some(media => media.id === id))) {
            throw agentError('invalid_selection', '所选候选或媒体不存在，预览未改变');
          }
          if (!item.includeText && !item.selectedMediaIds.length) throw agentError('invalid_selection', '所选内容为空');
          selected.add(item.candidateId);
        }
        if (input.saveMode && !['single', 'multiple', 'combined'].includes(input.saveMode)) throw agentError('invalid_input', '保存方式无效');
        record.batch = normalizePageCaptureBatch({ ...record.batch, candidates,
          selections: selections.map(item => ({ ...item, mediaDecision: 'confirmed' })),
          saveMode: input.saveMode ?? record.batch.saveMode, combinedTitle: input.combinedTitle ?? record.batch.combinedTitle,
          captureMode: candidates.length > 1 ? 'list' : 'single' });
        if (record.batch.candidates.length !== candidates.length || record.batch.selections.length !== selections.length) {
          throw agentError('invalid_selection', '候选重复或所选内容无效，预览未改变');
        }
        record.revision++;
        await scope.assertCurrent(); await persist(record);
        return summary(record);
      }
      if (operation !== 'save_capture') throw agentError('unknown_operation', '未知采集操作');
      if (!record.batch.selections.length) throw agentError('capture_selection_required', '请先选择要保存的内容，不会自动全选');
      if (record.batch.captureMode === 'list' && !['multiple', 'combined'].includes(record.batch.saveMode)) {
        throw agentError('capture_save_mode_required', '请选择分别保存或合并为一个案例');
      }
      const collectionId = input.project ? resolveAgentProject(await loadState(), input.project) : '';
      await scope.assertCurrent();
      record.state = 'saving'; record.lastSaveRequestId = requestId;
      await persist(record);
      try {
        const result = await commit(record.batch, { collectionId,
          ...(input.generationPromptChoices ? { generationPromptChoices: input.generationPromptChoices } : {}) });
        await scope.assertCurrent();
        record.results = result.results || [];
        record.state = result.ok && record.results.length && record.results.every(item => ['saved', 'duplicate'].includes(item.status)) ? 'completed' : 'preview';
        record.revision++;
        await persist(record);
        return { ...result, captureId: record.id, revision: record.revision, state: record.state };
      } catch (error) {
        await scope.assertCurrent(); record.state = 'preview'; record.revision++; await persist(record);
        throw error;
      }
    }
  };
  async function permission(url) {
    const origin = new URL(requireWebUrl(url)).origin;
    if (!await chromeApi.permissions.contains({ origins: [`${origin}/*`] })) {
      throw agentError('site_permission_required', '请先在插件设置中授权网页采集，Agent不能代替首次授权');
    }
  }
}

function appendOriginal(prior = '', added = '') {
  if (!prior) return added || '';
  if (!added || prior.includes(added)) return prior;
  if (added.includes(prior)) return added;
  return `${prior}\n\n${added}`;
}

// Runs in the page, with a fixed read-only function. Never reads input values,
// cookies, storage, network headers or executes instructions from page content.
export function readCapturePageEvidence(selector = '') {
  if (document.querySelector('script[src*="/cdn-cgi/challenge-platform/"]') && [...document.scripts].some(script => script.textContent.includes('_cf_chl_opt'))) {
    return { ok: false, message: '网页正在进行安全验证，请在浏览器完成后再采集' };
  }
  let root;
  try { root = selector ? document.querySelector(selector) : document.body; }
  catch { return { ok: false, message: '网页区域选择器无效' }; }
  if (!root) return { ok: false, message: '没有找到指定网页区域' };
  const links = [], media = [], text = [];
  const webUrl = value => { try { const url = new URL(value, location.href); return ['http:', 'https:'].includes(url.protocol) ? url.href : ''; } catch { return ''; } };
  function visit(node) {
    if (node.nodeType === Node.TEXT_NODE) { if (node.textContent.trim()) text.push(node.textContent.trim()); return; }
    if (node.nodeType !== Node.ELEMENT_NODE || node.matches('script,style,noscript,input,textarea,select,[data-promptdirector-capture-ui]')) return;
    if (node.matches('a[href]')) { const url = webUrl(node.getAttribute('href')); if (url) links.push({ text: node.textContent.trim(), url }); }
    if (node.matches('img,video,audio,source')) {
      const raw = node.currentSrc || node.src || node.getAttribute('src');
      const url = raw ? webUrl(raw) : '';
      if (url) media.push({ kind: node.matches('img') ? 'image' : node.matches('audio') || node.parentElement?.matches('audio') ? 'audio' : 'video',
        url, alt: node.getAttribute('alt') || '', posterUrl: node.getAttribute('poster') ? webUrl(node.getAttribute('poster')) : '' });
    }
    for (const child of node.childNodes) visit(child);
    if (node.shadowRoot) for (const child of node.shadowRoot.childNodes) visit(child);
  }
  visit(root);
  return { ok: true, url: location.href, title: document.title, selector, text: text.join('\n'), links, media,
    untrustedContent: true };
}
