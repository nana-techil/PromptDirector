import { agentError, requireAgentId, requireInteger, requireWebUrl, AGENT_CHUNK_BYTES, bytesToBase64 } from './agent-protocol.js';
import { validate } from './case-operation-specs.js';
import { CAPTURE_OPERATION_SPECS } from './capture-operation-specs.js';
import { waitForAgentTab } from './agent-capture.js';
import { normalizePageCaptureBatch, normalizePageCaptureCandidate } from './page-capture.js';
import { readPageCaptureSupplement } from './capture-supplement.js';
import { resolvePageCaptureAdapter } from './page-capture-adapter-registry.js';
import { PAGE_CAPTURE_LIMITS } from './resource-limits.js';
import { resolveAgentProject } from './agent-save.js';
import { operationBudget } from './resource-policy.js';
import { codePreviewText, codePreviewHtml } from './code-case.js';

const prefix = 'agentCapture:';
export function createAgentCapturePreview({ storage, chromeApi, collect, commit, loadState, getLibraryId, budget, readImage, resolveLocalMedia, readSavedText, readSupplement = readPageCaptureSupplement }) {
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
      const next = [{ id: record.id, bytes: new Blob([JSON.stringify(record)]).size,
        pendingDirectory: Boolean(record.moduleInventory && (record.moduleInventoryReadEnd || 0) < record.moduleInventory.length) }, ...history.filter(item => item.id !== record.id)];
      let bytes = next.reduce((total, item) => total + item.bytes, 0);
      const removed = [];
      while (next.length > 1 && (next.length > policy.maxAutomaticHistoryItems || bytes > policy.maxAutomaticHistoryBytes)) {
        const index = next.findLastIndex((item, index) => index > 0 && !item.pendingDirectory);
        if (index < 0) break;
        const [old] = next.splice(index, 1); bytes -= old.bytes; removed.push(key(old.id));
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
      platform: capturePlatformGuidance(record.batch.sourceUrl),
      candidates: record.batch.candidates.map(item => ({ id: item.id, title: item.title,
        codePreviewAvailable: Boolean(item.sourceFacts?.codePreviewAvailable && codePreviewHtml(item.contentText)),
        ...(item.sourceFacts?.codeSourceAvailable ? { contentRole: 'code_case' } : {}),
        canonicalUrl: item.canonicalUrl, completeness: item.completeness, adapter: item.adapter,
        textSources: (record.sourceBindings?.[item.id] || []).map(binding => ({ ...binding,
          totalCharacters: record.sources?.[binding.selector]?.text.length || 0,
          completeness: record.sources?.[binding.selector]?.completeness || 'unverified' })),
        supplements: item.supplements.map(({ id, sourceUrl, partial, text }) => ({ id, sourceUrl, partial, textCharacters: text.length })),
        textCharacters: item.contentText.length, media: item.media.map(({ id, kind, url }) => ({ id, kind, url })) })),
      selections: record.batch.selections, saveMode: record.batch.saveMode, combinedTitle: record.batch.combinedTitle,
      ...(record.task ? { task: record.task } : {}),
      ...(record.scanError ? { scanError: record.scanError } : {}),
      ...(record.lastSaveRequestId ? { lastSaveRequestId: record.lastSaveRequestId } : {}),
      ...(record.results ? { results: record.results } : {}), untrustedContent: true };
  }
  return {
    async view(input) {
      const record = await own(input.captureId); version(record, input);
      return { ...summary(record), batch: record.batch };
    },
    async read(input) {
      // A human can open a new dialog without changing the URL or an old preview.
      // Observe that live scene without invoking adapters or copying the full page.
      if (input.part === 'context') {
        const record = input.captureId ? await own(input.captureId) : null;
        if (record) version(record, input);
        const tabId = record?.batch.tabId ?? input.tabId;
        requireInteger(tabId);
        const tab = await chromeApi.tabs.get(tabId);
        if (record && tab.url !== record.batch.sourceUrl) throw agentError('page_changed', '采集网页已改变，请重新开始当前网页的采集');
        await permission(tab.url);
        const [observed] = await chromeApi.scripting.executeScript({ target: { tabId }, func: readCapturePageContext, args: [input.query || '', Boolean(input.includeHidden), input.selector || ''] });
        if (!observed?.result?.ok) throw agentError('capture_page_unavailable', observed?.result?.message || '当前网页现场未取得');
        if (observed.result.url !== tab.url || (await chromeApi.tabs.get(tabId)).url !== tab.url) throw agentError('page_changed', '读取期间网页已改变');
        const offset = input.offset ?? 0, length = input.length ?? 12000;
        requireInteger(offset); requireInteger(length, { min: 1, max: AGENT_CHUNK_BYTES / 4 });
        let scene = observed.result;
        if (scene.modules && JSON.stringify(scene.modules).length > length) {
          const { modules, ...visibleScene } = scene;
          scene = { ...visibleScene, moduleCount: modules.length,
            moduleDirectory: { part: 'modules', ...(record ? { captureId: record.id } : { requiresCapture: true }), scope: 'currently_loaded_dom' } };
        }
        const text = JSON.stringify(captureSceneForModel(scene, length));
        if (offset) throw agentError('invalid_input', '当前现场请重新读取或按模块名称缩小范围');
        if (text.length > length) throw agentError('capture_context_scope_required', '当前现场包含较多区域，请用模块名称查询或增加读取长度');
        return { ...(record ? { captureId: record.id, revision: record.revision } : {}), part: 'context', sourceUrl: tab.url,
          content: text, offset: 0, totalCharacters: text.length, nextOffset: null, platform: capturePlatformGuidance(tab.url), untrustedContent: true };
      }
      const record = await own(input.captureId);
      const part = input.part ?? 'summary';
      if (part === 'modules') {
        const offset = input.offset ?? 0, length = input.length ?? 12000;
        requireInteger(offset); requireInteger(length, { min: 1, max: AGENT_CHUNK_BYTES / 4 });
        if (offset && (!record.moduleInventory || input.expectedRevision === undefined)) throw agentError('capture_revision_required', '目录续读请携带首屏revision');
        if (input.refresh && offset) throw agentError('invalid_input', '刷新目录请从第一页开始');
        if (input.expectedRevision !== undefined) {
          if (!record.moduleInventory) version(record, input);
          else if (input.expectedRevision !== record.moduleInventoryRevision) throw agentError('capture_changed', '冻结目录已刷新，请从第一页重新读取');
        }
        if (!record.moduleInventory || input.refresh) {
          const tab = await chromeApi.tabs.get(record.batch.tabId);
          if (tab.url !== record.batch.sourceUrl) throw agentError('page_changed', '目标网页已改变，原目录保留');
          await permission(tab.url);
          const [observed] = await chromeApi.scripting.executeScript({ target: { tabId: tab.id }, func: readCapturePageContext, args: ['', true] });
          if (!observed?.result?.ok || observed.result.url !== tab.url || (await chromeApi.tabs.get(tab.id)).url !== tab.url) throw agentError('page_changed', '目录读取期间网页已改变');
          record.moduleInventory = observed.result.modules || [];
          record.moduleInventoryRevision = (record.moduleInventoryRevision || 0) + 1;
          record.moduleInventoryReadEnd = 0;
        }
        const modules = []; let characters = 2;
        for (const module of record.moduleInventory.slice(offset)) {
          const size = JSON.stringify(module).length + (modules.length ? 1 : 0);
          if (characters + size > length) break;
          modules.push(module); characters += size;
        }
        if (!modules.length && offset < record.moduleInventory.length) throw agentError('capture_context_scope_required', '单个目录项超过本次长度，请增加读取长度');
        const next = offset + modules.length;
        if (offset <= (record.moduleInventoryReadEnd || 0)) record.moduleInventoryReadEnd = Math.max(record.moduleInventoryReadEnd || 0, next);
        await persist(record);
        return { ok: true, captureId: record.id, revision: record.moduleInventoryRevision, captureRevision: record.revision, part, modules, offset, total: record.moduleInventory.length,
          nextOffset: next < record.moduleInventory.length ? next : null, inventoryScope: 'currently_loaded_dom', sourceUrl: record.batch.sourceUrl, untrustedContent: true };
      }
      version(record, input);
      if (part === 'supplement') {
        const offset = input.offset ?? 0, length = input.length ?? 12000;
        requireInteger(offset); requireInteger(length, { min: 1, max: AGENT_CHUNK_BYTES / 4 });
        const candidate = record.batch.candidates.find(item => item.id === input.candidateId);
        const item = candidate?.supplements.find(item => item.id === input.supplementId);
        if (!item) throw agentError('capture_candidate_not_found', '请读取候选中实际识别到的评论补充');
        await permission(record.batch.sourceUrl);
        if ((await chromeApi.tabs.get(record.batch.tabId)).url !== record.batch.sourceUrl) throw agentError('page_changed', '采集网页已改变，请重新开始当前网页的采集');
        if (input.offset && input.expectedRevision === undefined) throw agentError('capture_revision_required', '续读请携带首屏revision');
        if (input.offset && input.refresh) throw agentError('invalid_input', '重新读取评论须从首屏开始');
        if (input.offset && !record.sources?.[item.id]) throw agentError('capture_source_required', '请先读取评论首屏');
        const supplement = input.offset ? { ...item, text: record.sources[item.id].text, partial: record.sources[item.id].completeness === 'partial' }
          : item.partial || input.refresh ? await readSupplement(item, chromeApi, { sourceTabId: record.batch.tabId, sourceUrl: record.batch.sourceUrl }) : item;
        if ((await chromeApi.tabs.get(record.batch.tabId)).url !== record.batch.sourceUrl) throw agentError('page_changed', '读取期间网页已改变');
        record.sources ||= {};
        record.sources[item.id] = { text: supplement.text, selector: item.id, url: supplement.sourceUrl, format: 'text', completeness: supplement.partial ? 'partial' : 'complete' };
        candidate.supplements = candidate.supplements.map(value => value.id === item.id ? supplement : value);
        if (!input.offset) { record.revision++; await persist(record); }
        return { captureId: record.id, revision: record.revision, part, selector: item.id, sourceUrl: supplement.sourceUrl,
          content: supplement.text.slice(offset, offset + length), offset, totalCharacters: supplement.text.length,
          nextOffset: offset + length < supplement.text.length ? offset + length : null, completeness: record.sources[item.id].completeness, untrustedContent: true };
      }
      if (input.refresh) {
        if (part !== 'page' || input.offset) throw agentError('invalid_input', '重新读取网页须从正文首屏开始');
        await permission(record.batch.sourceUrl);
        if ((await chromeApi.tabs.get(record.batch.tabId)).url !== record.batch.sourceUrl) throw agentError('page_changed', '采集网页已改变，请重新开始当前网页的采集');
        const [evidence] = await chromeApi.scripting.executeScript({ target: { tabId: record.batch.tabId }, func: readCapturePageEvidence, args: [record.page.selector || ''] });
        if (!evidence?.result?.ok) throw agentError('capture_page_unavailable', evidence?.result?.message || '无法读取采集网页');
        if (evidence.result.url !== record.batch.sourceUrl || (await chromeApi.tabs.get(record.batch.tabId)).url !== record.batch.sourceUrl) throw agentError('page_changed', '读取时网页地址已改变，未生成采集预览');
        if (JSON.stringify(evidence.result) !== JSON.stringify(record.page)) { record.page = evidence.result; record.revision++; await persist(record); }
      }
      if (part === 'summary') return summary(record);
      if (part === 'source') {
        if (!input.selector && !input.selectors?.length || input.selector && input.selectors) throw agentError('invalid_input', '请指定实际网页内容区域');
        const offset = input.offset ?? 0, length = input.length ?? 12000;
        requireInteger(offset); requireInteger(length, { min: 1, max: AGENT_CHUNK_BYTES / 4 });
        if (input.selectors && offset) throw agentError('invalid_input', '多个区域请一次读取，续读使用单个selector');
        if (offset && input.expectedRevision === undefined) throw agentError('capture_revision_required', '续读请携带首屏revision');
        if (!input.offset) {
          await permission(record.batch.sourceUrl);
          if ((await chromeApi.tabs.get(record.batch.tabId)).url !== record.batch.sourceUrl) throw agentError('page_changed', '采集网页已改变，未读取原文');
          const [observed] = await chromeApi.scripting.executeScript({ target: { tabId: record.batch.tabId }, func: readCaptureSource, args: [input.selectors || input.selector] });
          if (!observed?.result?.ok) throw agentError('capture_page_unavailable', observed?.result?.message || '指定区域原文未取得');
          if (observed.result.url !== record.batch.sourceUrl || (await chromeApi.tabs.get(record.batch.tabId)).url !== record.batch.sourceUrl) throw agentError('page_changed', '读取期间网页已改变');
          record.sources ||= {};
          let changed = false;
          for (const source of observed.result.sources || [observed.result]) {
            if (JSON.stringify(record.sources[source.selector || input.selector]) === JSON.stringify(source)) continue;
            record.sources[source.selector || input.selector] = source; changed = true;
          }
          if (changed) { record.revision++; await persist(record); }
        }
        if (input.selectors) {
          const perSource = Math.max(1, Math.floor(length / input.selectors.length));
          return { captureId: record.id, revision: record.revision, part, sourceUrl: record.batch.sourceUrl,
            sources: input.selectors.map(selector => { const source = record.sources[selector];
              return { selector, content: source.text.slice(0, perSource), totalCharacters: source.text.length,
                nextOffset: source.text.length > perSource ? perSource : null }; }), untrustedContent: true };
        }
        const source = record.sources?.[input.selector];
        if (!source) throw agentError('capture_source_required', '请先读取这段实际原文');
        return { captureId: record.id, revision: record.revision, part, selector: input.selector, sourceUrl: source.url,
          content: source.text.slice(offset, offset + length), offset, totalCharacters: source.text.length,
          nextOffset: offset + length < source.text.length ? offset + length : null, completeness: source.completeness || 'unverified', untrustedContent: true };
      }
      if (part === 'screenshot') return screenshot(record);
      if (part === 'image') {
        const candidate = record.batch.candidates.find(item => item.id === input.candidateId);
        const media = candidate?.media.find(item => item.id === input.mediaId);
        if (!media || media.kind !== 'image') throw agentError('capture_candidate_not_found', '请选择这份预览中的图片');
        if (!media.localAssetId) await permission(media.url);
        const blob = await readImage?.(media);
        if (!blob?.type?.startsWith('image/')) throw agentError('capture_page_unavailable', '图片原件未取得，不能用封面代替');
        return { captureId: record.id, revision: record.revision, part, candidateId: candidate.id, mediaId: media.id,
          sourceUrl: candidate.canonicalUrl, dataUrl: `data:${blob.type};base64,${bytesToBase64(new Uint8Array(await blob.arrayBuffer()))}`, untrustedContent: true };
      }
      if (!['page', 'candidate'].includes(part)) throw agentError('invalid_input', '采集读取部分无效');
      if (part === 'page' && (input.selector || input.selectors)) throw agentError('invalid_input', 'page是冻结全页；读取指定模块请用source及实际selector，模块目录用modules');
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
    async execute(operation, input, requestId, scope, progress) {
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
        let snapshot = input.initialBatch, scanError = null;
        if (!snapshot) {
          try { snapshot = await collect(tab, { sessionId: requestId, mode, maxCandidates }); }
          catch (error) { scanError = { code: error.code || 'capture_failed', message: error.message }; }
        }
        const [evidence] = await chromeApi.scripting.executeScript({ target: { tabId: tab.id },
          func: readCapturePageEvidence, args: [input.selector || ''] });
        if (!evidence?.result?.ok) throw agentError('capture_page_unavailable', evidence?.result?.message || '无法读取采集网页');
        if ((await chromeApi.tabs.get(tab.id)).url !== url || evidence.result.url !== url) {
          throw agentError('page_changed', '读取时网页地址已改变，未生成采集预览');
        }
        await scope.assertCurrent();
        const batch = normalizePageCaptureBatch({ ...snapshot, id: requestId, tabId: tab.id, sourceUrl: url,
          ...(scanError ? { error: scanError.message } : {}),
          selections: input.initialBatch?.selections || [] });
        const record = { id: requestId, libraryId: scope.libraryId, revision: 1, state: 'preview', batch, page: evidence.result,
          ...(scanError ? { scanError } : {}) };
        await persist(record);
        return summary(record);
      }
      const record = await own(input.captureId);
      requireInteger(input.expectedRevision, { min: 1 });
      version(record, input);
      if (record.state !== 'preview') throw agentError('capture_not_editable', '本预览已保存或保存状态尚未确认，请先核对保存任务');
      if (operation === 'update_capture') {
        const schema = CAPTURE_OPERATION_SPECS.find(spec => spec.name === operation).parameters.properties;
        if (input.task !== undefined) validate(schema.task, input.task, 'task');
        const candidates = [...record.batch.candidates];
        const bindings = { ...record.sourceBindings };
        const ids = new Set();
        for (const patch of input.candidates ?? []) {
          let value = patch;
          if (patch.originalPrompt && !patch.textSources?.length && Object.values(record.sources || {}).some(source => source.text.length > patch.originalPrompt.length && source.text.startsWith(patch.originalPrompt))) {
            throw agentError('capture_source_required', '已取得的原文比提交的提示词更长，请用textSources引用完整来源，不能用模型截短版本代替');
          }
          if (patch.textSources !== undefined) validate(schema.candidates.items.properties.textSources, patch.textSources, 'textSources');
          if (patch.textSources?.length) {
            const sources = patch.textSources.map(reference => {
              const source = record.sources?.[reference.selector];
              if (!source) throw agentError('capture_source_required', '补充案例须先读取实际原文，不能用模型示例替代');
              return { ...reference, source };
            });
            const { textSources: _textSources, ...fields } = patch;
            value = { ...fields,
              contentText: sources.filter(source => source.target === 'text').map(source => sourceMaterialText(source.source)).join('\n\n'),
              originalPrompt: sources.filter(source => source.target === 'prompt').map(source => sourceMaterialText(source.source)).join('\n\n') };
            bindings[value.id] = patch.textSources;
          }
          if (!value?.id || ids.has(value.id)) throw agentError('invalid_input', '补充内容编号缺失或重复');
          ids.add(value.id);
          requireWebUrl(value.canonicalUrl);
          value = { ...value, media: await Promise.all((value.media || []).map(async item => {
            if (!item.localTransferId) { requireWebUrl(item.url); return item; }
            if (!resolveLocalMedia) throw agentError('attachment_unavailable', '本机原件读取尚未配置');
            return resolveLocalMedia(item);
          })) };
          const index = candidates.findIndex(item => item.id === value.id);
          const prior = candidates[index];
          const sameModule = index < 0 && candidates.find(item => record.sourceBindings?.[item.id]?.length
            && item.canonicalUrl === value.canonicalUrl && item.title === value.title);
          if (sameModule) throw agentError('capture_candidate_exists', `该模块已有候选 ${sameModule.id}，请用这个编号补充预览和重新选择，不要为同一模块另建编号`);
          if (patch.codePreview && Object.keys(record.sources || {}).length
            && !patch.textSources?.length && !record.sourceBindings?.[patch.id]?.length) {
            throw agentError('capture_source_required', '已读取原始源码；请用textSources关联该候选的实际selector，完整原文由插件保存，不能用模型重写的内容替代');
          }
          if (prior?.adapter === 'generic' && prior.sourceFacts?.captureScope !== 'selection' && patch.textSources?.length && value.title !== undefined && value.title !== prior.title) {
            throw agentError('capture_source_changed', '单独模块请新建候选，不能重命名已有整页候选并混入它的正文');
          }
          if (prior && prior.canonicalUrl !== requireWebUrl(value.canonicalUrl)) throw agentError('capture_source_changed', '已有候选的来源不能改为其他网页，请另建候选');
          for (const item of value.media ?? []) {
            const original = prior?.media.find(media => media.id === item.id);
            if (original && (original.url !== item.url || original.localAssetId !== item.localAssetId)) throw agentError('capture_source_changed', '已有媒体的来源不能替换，请另建媒体');
          }
          if (patch.codePreview !== undefined) validate(schema.candidates.items.properties.codePreview, patch.codePreview, 'codePreview');
          const added = appendOriginal(appendOriginal(value.contentText, value.originalPrompt), patch.codePreview ? codePreviewText(patch.codePreview.html) : '');
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
              ...(patch.textSources?.length ? { captureScope: 'selection', captureSourceSelectors: patch.textSources.map(source => source.selector),
                codeSourceAvailable: patch.textSources.some(source => isInteractiveCodeSource(record.sources[source.selector])) } : {}),
              ...(patch.codePreview ? { codePreviewAvailable: true } : {}),
              ...(value.originalPrompt ? { originalPromptAvailable: true, caseOriginalPromptAvailable: true } : {}), status: 'partial' },
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
        const task = input.task || record.task;
        if (task && (!task.candidateIds?.length || task.candidateIds.some(id => !candidates.some(candidate => candidate.id === id)))) {
          throw agentError('invalid_selection', '采集任务须对应实际候选，不能用估计数量代表已取得案例');
        }
        const nextBatch = normalizePageCaptureBatch({ ...record.batch, candidates,
          selections: selections.map(item => ({ ...item, mediaDecision: 'confirmed' })),
          saveMode: candidates.length > 1 && selections.length === 1 && !['multiple', 'combined'].includes(input.saveMode ?? record.batch.saveMode)
            ? 'multiple' : input.saveMode ?? record.batch.saveMode, combinedTitle: input.combinedTitle ?? record.batch.combinedTitle,
          captureMode: candidates.length > 1 ? 'list' : 'single' });
        if (input.candidates?.length) nextBatch.error = '';
        if (nextBatch.candidates.length !== candidates.length || nextBatch.selections.length !== selections.length) {
          throw agentError('invalid_selection', '候选重复或所选内容无效，预览未改变');
        }
        record.batch = nextBatch;
        record.revision++;
        if (task) record.task = structuredClone(task);
        record.sourceBindings = bindings;
        await scope.assertCurrent(); await persist(record);
        return summary(record);
      }
      if (operation !== 'save_capture') throw agentError('unknown_operation', '未知采集操作');
      if (!record.batch.selections.length) throw agentError('capture_selection_required', '请先选择要保存的内容，不会自动全选');
      if (record.task?.outcome === 'save' && record.task.candidateIds.some(id => !record.batch.selections.some(selection => selection.candidateId === id))) {
        throw agentError('capture_task_incomplete', '仍有指定案例未选入保存范围，已有预览保留');
      }
      if (input.saveMode !== undefined) {
        if (!['single', 'multiple', 'combined'].includes(input.saveMode)) throw agentError('invalid_input', '保存方式无效');
        record.batch = normalizePageCaptureBatch({ ...record.batch, saveMode: input.saveMode });
      }
      if (record.batch.captureMode === 'list' && record.batch.selections.length === 1 && !['multiple', 'combined'].includes(record.batch.saveMode)) {
        record.batch = normalizePageCaptureBatch({ ...record.batch, saveMode: 'multiple' });
      }
      if (record.batch.captureMode === 'list' && !['multiple', 'combined'].includes(record.batch.saveMode)) {
        throw agentError('capture_save_mode_required', '请选择分别保存或合并为一个案例');
      }
      const collectionId = input.project ? resolveAgentProject(await loadState(), input.project) : '';
      await scope.assertCurrent();
      record.state = 'saving'; record.lastSaveRequestId = requestId;
      await persist(record);
      try {
        const result = await commit(record.batch, { ...input.captureMetadata,
          ...(!input.captureMetadata?.contentTypeExplicit && input.contentTypeId ? { contentTypeId: input.contentTypeId, contentTypeExplicit: true } : {}), collectionId,
          ...(input.generationPromptChoices ? { generationPromptChoices: input.generationPromptChoices } : {}) }, progress);
        await scope.assertCurrent();
        record.results = result.results || [];
        // Read back only source-backed text selected in this save; never
        // download media again or let a short model reply prove completeness.
        for (const receipt of record.results.filter(item => item.entryId && ['saved', 'duplicate', 'partial'].includes(item.status))) {
          const chosen = record.batch.selections.filter(selection => selection.includeText && (record.batch.saveMode === 'combined' || selection.candidateId === receipt.candidateId));
          const sources = chosen.flatMap(selection => (record.sourceBindings?.[selection.candidateId] || []).map(binding => record.sources[binding.selector]));
          if (!sources.length) continue;
          const partial = sources.some(source => source.completeness === 'partial');
          let matches = false;
          if (readSavedText) {
            try { const savedText = await readSavedText(receipt.entryId); matches = sources.every(source => savedText.includes(sourceMaterialText(source).trim())); }
            catch (error) { receipt.warnings = [...(receipt.warnings || []), `保存读回未完成：${error.message}`]; }
          }
          receipt.originalVerification = { status: matches && !partial ? 'verified' : partial ? 'partial' : 'unverified', sourceCount: sources.length,
            sources: sources.map(source => ({ selector: source.selector, totalCharacters: source.text.length, completeness: source.completeness || 'unverified' })) };
          if (partial || readSavedText && !matches) {
            receipt.status = 'partial'; receipt.warnings = [...new Set([...(receipt.warnings || []), partial ? '来源正文仍被折叠，尚未取得全文' : '已保存内容与完整来源不一致，请补采后核对'])];
          }
        }
        await scope.assertCurrent();
        const expectedResults = record.batch.saveMode === 'combined' ? 1 : record.batch.selections.length;
        const actualIds = new Set(record.results.map(item => item.candidateId));
        const coversSelection = record.batch.saveMode === 'combined' || (actualIds.size === expectedResults && record.batch.selections.every(item => actualIds.has(item.candidateId)));
        record.state = result.ok && coversSelection && record.results.length === expectedResults
          && record.results.every(item => item.entryId && ['saved', 'duplicate'].includes(item.status)) ? 'completed' : 'preview';
        record.revision++;
        await persist(record);
        return { ...result, results: record.results, captureId: record.id, revision: record.revision, state: record.state };
      } catch (error) {
        await scope.assertCurrent(); record.state = 'preview'; record.revision++; await persist(record);
        throw error;
      }
    }
  };
  async function screenshot(record) {
    await permission(record.batch.sourceUrl);
    const tab = await chromeApi.tabs.get(record.batch.tabId);
    if (tab.url !== record.batch.sourceUrl || !tab.active || tab.status === 'loading' || tab.pendingUrl) {
      throw agentError('page_changed', '请将采集网页保持在当前标签，截图未取得');
    }
    let changed = false;
    const activated = info => { if (info.windowId === tab.windowId && info.tabId !== tab.id) changed = true; };
    const updated = (id, change) => { if (id === tab.id && (change.url || change.status === 'loading')) changed = true; };
    chromeApi.tabs.onActivated.addListener(activated);
    chromeApi.tabs.onUpdated.addListener(updated);
    try {
      const dataUrl = await chromeApi.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
      const current = await chromeApi.tabs.get(tab.id);
      if (changed || !current.active || current.url !== tab.url) throw agentError('page_changed', '截图期间网页已切换，截图已丢弃');
      if (!dataUrl?.startsWith('data:image/png;base64,')) throw agentError('capture_page_unavailable', '网页截图未取得');
      return { captureId: record.id, revision: record.revision, part: 'screenshot', sourceUrl: tab.url,
        dataUrl, capturedAt: new Date().toISOString(), untrustedContent: true };
    } finally {
      chromeApi.tabs.onActivated.removeListener(activated);
      chromeApi.tabs.onUpdated.removeListener(updated);
    }
  }
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
  const isVisible = element => {
    const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth;
  };
  const path = element => {
    if (element.id) return '#' + CSS.escape(element.id);
    const parts = [];
    while (element && element !== document.body) {
      const tag = element.localName, peers = element.parentElement ? [...element.parentElement.children].filter(child => child.localName === tag) : [];
      parts.unshift(tag + (peers.length > 1 ? `:nth-of-type(${peers.indexOf(element) + 1})` : ''));
      element = element.parentElement;
    }
    return ['body', ...parts].join(' > ');
  };
  const codeBlocks = [...root.querySelectorAll('pre')].map(element => ({ selector: path(element), characters: element.textContent.length, visible: isVisible(element) })).sort((a, b) => Number(b.visible) - Number(a.visible));
  const dialogs = [...root.querySelectorAll('dialog[open],[role="dialog"]')].filter(isVisible).map(element => ({ selector: path(element), title: element.getAttribute('aria-label') || element.querySelector('h1,h2,h3')?.textContent || '' }));
  const active = document.activeElement;
  const selection = active?.matches('input,textarea,select') ? '' : String(getSelection() || '');
  return { ok: true, url: location.href, title: document.title, selector, text: text.join('\n'), links, media,
    context: { selection, dialogs, codeBlocks },
    untrustedContent: true };
}

// Injected in isolation; all helpers deliberately stay inside this function.
export function readCapturePageContext(query = '', includeHidden = false, selector = '') {
  let root = document;
  if (selector) {
    try { root = document.querySelector(selector); } catch { return { ok: false, message: '区域选择器无效，请使用模块目录的实际selector' }; }
    if (!root) return { ok: false, message: '指定区域未找到，请使用模块目录的实际selector' };
  }
  const excluded = 'script,style,noscript,input,textarea,select,[data-promptdirector-capture-ui]';
  const visible = element => {
    if (element.closest('[hidden],[aria-hidden="true"]')) return false;
    for (let node = element; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
    }
    const r = element.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
  };
  const path = element => {
    const parts = [];
    while (element && element !== document.body) {
      if (element.id && document.querySelectorAll('#' + CSS.escape(element.id)).length === 1) {
        return ['#' + CSS.escape(element.id), ...parts].join(' > ');
      }
      const siblings = [...(element.parentElement?.children || [])].filter(peer => peer.localName === element.localName);
      parts.unshift(element.localName + (siblings.length > 1 ? `:nth-of-type(${siblings.indexOf(element) + 1})` : ''));
      element = element.parentElement;
    }
    return ['body', ...parts].join(' > ');
  };
  const titleSelector = 'h1,h2,h3,h4,h5,h6,[role="heading"],[class*="title"],[class*="name"]';
  function owner(element) {
    for (let node = element.parentElement; node && node !== document.body; node = node.parentElement) {
      const validTitle = item => !item.closest('pre,code,button,a,[role="button"]') && !item.matches(excluded) && item.textContent.trim();
      const depth = item => { let count = 0; for (; item && item !== node; item = item.parentElement) count++; return count; };
      // A module's name is stronger identity evidence than a demo's title
      // text. Controls and event-tracking class names are not module labels.
      const title = [...node.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"]')].find(validTitle)
        || [...node.querySelectorAll('[class*="name"]')].filter(validTitle).sort((a, b) => depth(a) - depth(b))[0]
        || [...node.querySelectorAll(titleSelector)].filter(validTitle).sort((a, b) => depth(a) - depth(b))[0];
      if (title) return { selector: path(node), title: title.textContent.trim() };
    }
    return null;
  }
  const needle = query.trim().toLocaleLowerCase();
  const allCodeBlocks = [...(root.matches?.('pre') ? [root] : []), ...root.querySelectorAll('pre')].filter(element => !element.closest('[data-promptdirector-capture-ui]')).map(element => {
    const module = owner(element), shown = visible(element);
    return { selector: path(element), characters: element.textContent.length, visible: shown, module,
      ...(shown ? { content: element.textContent } : {}),
      language: element.getAttribute('data-lang') || element.querySelector('code')?.className || '' };
  });
  const codeBlocks = allCodeBlocks.filter(item => needle ? item.module?.title.toLocaleLowerCase().includes(needle) : item.visible).sort((a, b) => Number(b.visible) - Number(a.visible));
  const modules = new Map();
  if (includeHidden) for (const block of allCodeBlocks) {
    if (!block.module || needle && !block.module.title.toLocaleLowerCase().includes(needle)) continue;
    const module = modules.get(block.module.selector) || { ...block.module, sources: [] };
    module.sources.push({ selector: block.selector, language: block.language, characters: block.characters });
    modules.set(module.selector, module);
  }
  const dialogs = [...root.querySelectorAll('dialog[open],[role="dialog"]')].filter(visible).map(element => ({ selector: path(element),
    title: element.querySelector(titleSelector)?.textContent.trim() || element.getAttribute('aria-label') || '' }));
  const active = document.activeElement;
  const textRoots = [...root.querySelectorAll('article,[role="article"],p,blockquote,[lang]')].filter(element => {
    if (element === document.body || element === document.documentElement || element.closest('pre,code,nav,header,footer,' + excluded)) return false;
    const clone = element.cloneNode(true); clone.querySelectorAll(excluded).forEach(node => node.remove());
    const text = clone.textContent.trim();
    return text && (needle ? text.toLocaleLowerCase().includes(needle) : visible(element));
  });
  const parents = new Set();
  for (const element of textRoots) for (let parent = element.parentElement; parent; parent = parent.parentElement) parents.add(parent);
  const textModules = textRoots.filter(element => !parents.has(element)).map(element => {
    const clone = element.cloneNode(true); clone.querySelectorAll(excluded).forEach(node => node.remove());
    const truncated = Boolean(element.closest('article,[role="article"]')?.querySelector('[data-testid="tweet-text-show-more-link"]'));
    return { selector: path(element), visible: visible(element), text: clone.textContent.trim(), completeness: truncated ? 'partial' : 'complete' };
  }).filter(item => item.text);
  return { ok: true, url: location.href, title: document.title, query,
    scope: selector ? { selector } : query ? { query } : 'visible_scene', loadedCodeBlockCount: allCodeBlocks.length,
    matchingCodeBlockCount: codeBlocks.length,
    selection: active?.matches('input,textarea,select') ? '' : String(getSelection() || ''), dialogs, codeBlocks, textModules,
    ...(includeHidden ? { modules: [...modules.values()], inventoryScope: 'currently_loaded_dom' } : {}),
    untrustedContent: true };
}

export function readCaptureSource(selector) {
  function read(selector) {
  let element;
  try { element = document.querySelector(selector); }
  catch { return { ok: false, message: '网页区域选择器无效' }; }
  if (!element || element.matches('script,style,noscript,input,textarea,select') || element.closest('[data-promptdirector-capture-ui]')) {
    return { ok: false, message: '没有找到可采集的原文区域' };
  }
  const clone = element.cloneNode(true);
  clone.querySelectorAll('script,style,noscript,input,textarea,select,[data-promptdirector-capture-ui]').forEach(node => node.remove());
  // Preserve code whitespace directly from the DOM. Model pagination is only
  // for understanding; a source-backed save uses this complete frozen original.
  const post = element.closest('article,[role="article"]');
  const truncated = Boolean(post?.querySelector('[data-testid="tweet-text-show-more-link"]'));
  return { ok: true, url: location.href, selector, text: clone.textContent, completeness: truncated ? 'partial' : 'complete',
    format: element.matches('pre,code') ? 'code' : 'text', untrustedContent: true };
  }
  if (!Array.isArray(selector)) return read(selector);
  const sources = selector.map(read);
  const failed = sources.find(source => !source.ok);
  return failed || { ok: true, url: location.href, sources, untrustedContent: true };
}

function sourceMaterialText(source) {
  if (source.format !== 'code') return source.text;
  const fence = '`'.repeat(Math.max(3, ...(source.text.match(/`+/gu) || []).map(value => value.length + 1)));
  return `${fence}\n${source.text}\n${fence}`;
}

function isInteractiveCodeSource(source) {
  // A prompt can also live inside <pre>. Infer web code only from actual
  // CSS declarations, JavaScript syntax or HTML, rather than its DOM tag.
  return source?.format === 'code' && /(?:\{[^{}]*[\w-]+\s*:\s*[^{};]+;|\b(?:function\s+[\w$]+\s*\(|(?:const|let|var)\s+[\w$]+\s*=)|<(?:html|div|button|style|script)\b)/iu.test(source.text);
}

export function capturePlatformGuidance(url) {
  const adapter = resolvePageCaptureAdapter(url);
  return { adapter: adapter.id, label: adapter.label, support: adapter.support, cardSelectors: adapter.cardSelectors, fields: adapter.fields,
    trustedMediaHosts: adapter.trustedMediaHosts,
    capabilities: { prepare: { operation: 'prepare_capture', modes: ['whole', 'loaded'], selector: true },
      locate: { operation: 'read_capture', part: 'context', query: true },
      moduleDirectory: { operation: 'read_capture', part: 'modules', frozen: true, paging: true, revisionScope: 'directory' },
      originals: { operation: 'read_capture', part: 'source', selectors: true, paging: true, frozen: true },
      supplements: { operation: 'read_capture', part: 'supplement', discover: 'summary.candidates[].supplements' },
      visual: { operation: 'read_capture', parts: ['screenshot', 'image'], requiresVisionModel: true },
      save: { update: 'update_capture', operation: 'save_capture', exactSelection: true, readback: true, codePreview: true } },
    guidance: adapter.id === 'x'
      ? 'prepare_capture复用X正文、原视频及作者后续评论适配器。summary的supplements列出真实评论来源及partial；partial=true时read_capture(part=supplement,candidateId,supplementId)调用同一评论展开采集器。返回的selector可用于textSources.target=prompt，完整冻结原文入库。当前打开的其他评论可从context的真实selector读source。视频/图片附带短词不等于评论全文；先核对评论是否展开，未取得全文不能说完整。'
      : 'prepare_capture使用当前适配器的cardSelectors、fields和媒体解析，再复用通用DOM、结构化数据、嵌套播放器和资源识别。support记录验证覆盖，不表示权限不足或不能采集。按用户目标用selector选择区域或loaded读取已加载列表；context/query定位模块、弹窗及代码，source分页读取完整冻结原文，textSources保存全文；summary.supplements发现可补采来源。partial或excerpts不能当完整，核对所选正文、原词、媒体及保存读回。适配未覆盖时用相同工具读取真实区域并update_capture补充，不让用户手工复制已有可读内容。代码模块须提供codePreview再保存，不混入整页或其他模块。' };
}

export function captureSceneForModel(scene, length) {
  if (JSON.stringify(scene).length <= length || !scene.textModules?.length && !scene.codeBlocks?.length) return scene;
  const count = (scene.textModules?.length || 0) + (scene.codeBlocks?.length || 0);
  let excerptLength = Math.floor(length / count);
  for (;;) {
    const index = { ...scene, excerptOnly: true, instruction: '这是当前区域索引，不是完整原文；按真实selector用source读取并冻结全文。query可按模块标题或正文片段定位。',
      textModules: (scene.textModules || []).map(({ text, ...module }) => ({ ...module, totalCharacters: text.length, text: text.slice(0, excerptLength), excerptOnly: text.length > excerptLength })),
      codeBlocks: (scene.codeBlocks || []).map(({ content, ...module }) => ({ ...module, ...(content ? { totalCharacters: content.length, content: content.slice(0, excerptLength), excerptOnly: content.length > excerptLength } : {}) })) };
    if (JSON.stringify(index).length <= length || !excerptLength) return index;
    excerptLength = Math.floor(excerptLength / 2);
  }
}
