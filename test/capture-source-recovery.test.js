import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentCapturePreview } from '../extension/agent-capture-preview.js';
import { createAgentTasks } from '../extension/agent-tasks.js';
import { runCaptureAssistant } from '../extension/capture-assistant.js';
import { applyPageCaptureSelections } from '../extension/page-capture.js';

test('a batch missing six original prompts exposes every missing source through durable tasks and the assistant, then saves all twelve after one corrective read', async () => {
  const url = 'https://example.test/effects', data = {}, saved = new Map(), reads = [];
  const storage = { get: async key => ({ [key]: structuredClone(data[key]) }),
    set: async values => Object.assign(data, structuredClone(values)), remove: async keys => keys.forEach(key => delete data[key]) };
  const candidates = Array.from({ length: 12 }, (_, i) => ({ id: `effect-${i}`, title: `Effect ${i}`, canonicalUrl: url,
    textSources: ['css', 'react', 'prompt'].map(part => ({ selector: `#effect-${i} .${part}`, target: part === 'prompt' ? 'prompt' : 'text' })),
    codePreview: { html: `<!doctype html><button>Effect ${i}</button>` } }));
  const allSources = candidates.flatMap(c => c.textSources.map(ref => ({ selector: ref.selector, url,
    text: `Exact original: ${ref.selector}`, format: ref.target === 'prompt' ? 'text' : 'code', completeness: 'complete' })));
  const missing = candidates.slice(6).map(c => ({ candidateId: c.id, title: c.title, selectors: [c.textSources[2].selector] }));
  const missingSelectors = missing.flatMap(m => m.selectors);
  const initialSelectors = allSources.map(s => s.selector).filter(s => !missingSelectors.includes(s));
  const api = createAgentCapturePreview({ storage, getLibraryId: async () => 'library', loadState: async () => ({ collections: [] }),
    chromeApi: { permissions: { contains: async () => true }, tabs: { get: async id => ({ id, url, status: 'complete' }) },
      scripting: { executeScript: async ({ func, args }) => {
        if (func.name !== 'readCaptureSource') return [{ result: { ok: true, url, text: 'Effects page' } }];
        reads.push(args[0]);
        return [{ result: { ok: true, url, sources: args[0].map(selector => allSources.find(s => s.selector === selector)) } }];
      } } },
    collect: async () => ({ candidates: [] }),
    commit: async batch => {
      const selected = applyPageCaptureSelections(batch);
      for (const c of selected) saved.set(c.id, c.contentText);
      return { ok: true, results: selected.map(c => ({ candidateId: c.id, entryId: c.id, status: 'saved' })) };
    }, readSavedText: async id => saved.get(id) });
  const taskOptions = { storage, getLibraryId: async () => 'library', execute: api.execute };
  const tasks = createAgentTasks(taskOptions);
  const runtime = { aiTaskAssignments: { creativePlanning: { providerId: 'deepseek', model: 'deepseek-flash' } },
    aiSettings: { apiKey: 'isolated-fixture', consent: true } };
  let failedRequest;
  const result = await runCaptureAssistant({ tabId: 1, sourceUrl: url, instruction: '保存这些案例' }, {
    runtime, signal: new AbortController().signal,
    call: async (name, args) => {
      if (name === 'read_capture') return api.read(args);
      if (name === 'get_task') return tasks.inspect(args.requestId, args);
      if (name === 'update_capture') failedRequest ||= args.requestId;
      return tasks.submit(name, args, args.requestId);
    },
    execute: async (_request, _settings, _images, { toolRuntime }) => {
      await toolRuntime.execute('declare_task', { mode: 'act', goal: 'Save twelve source-backed cases',
        steps: [{ operation: 'read_capture', part: 'source' }, { operation: 'update_capture' }, { operation: 'save_capture' }] });
      const { data: preview } = await toolRuntime.execute('prepare_capture', { tabId: 1 });
      await toolRuntime.execute('read_capture', { captureId: preview.captureId, part: 'source', selectors: initialSelectors });
      const update = { captureId: preview.captureId, expectedRevision: preview.revision, candidates,
        selections: candidates.map(c => ({ candidateId: c.id, includeText: true, selectedMediaIds: [] })), saveMode: 'multiple' };
      const before = structuredClone(data[`agentCapture:${preview.captureId}`]);
      const { data: failure } = await toolRuntime.execute('update_capture', update);
      assert.equal(failure.code, 'capture_source_required');
      assert.deepEqual(failure.missingSources, missing, 'all missing originals must be actionable, not a generic accusation that no sources were read');
      assert.deepEqual(data[`agentCapture:${preview.captureId}`], before, 'a rejected batch must not partially edit its preview');
      assert.equal(saved.size, 0);
      const durable = await createAgentTasks(taskOptions).inspect(failedRequest);
      assert.deepEqual(durable.error.details.missingSources, missing, 'MCP and resumed tasks retain the same correction facts');
      assert.deepEqual(failure.recovery.arguments, { captureId: preview.captureId, expectedRevision: preview.revision, part: 'source', selectors: missingSelectors });
      assert.equal(failure.recovery.operation, 'read_capture');
      assert.equal((await toolRuntime.execute(failure.recovery.operation, failure.recovery.arguments)).data.sources.length, 6);
      const { data: updated } = await toolRuntime.execute('update_capture', update);
      assert.equal(updated.ok, true);
      const { data: receipt } = await toolRuntime.execute('save_capture', { captureId: preview.captureId, expectedRevision: updated.revision });
      assert.equal(receipt.results.length, 12);
      assert(receipt.results.every(r => r.originalVerification.status === 'verified'));
      return { text: '已保存。' };
    }
  });
  assert.equal(result.ok, true, result.message || result.text); assert.equal(saved.size, 12);
  assert.deepEqual(reads, [initialSelectors, missingSelectors], 'recovery only reads missing originals');
  for (const c of candidates) for (const ref of c.textSources) assert(saved.get(c.id).includes(`Exact original: ${ref.selector}`));
});
