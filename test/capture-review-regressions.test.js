import test from 'node:test';
import assert from 'node:assert/strict';
import { runCaptureAssistant } from '../extension/capture-assistant.js';
import { captureScopeProgress } from '../extension/agent-capture-inventory.js';
import { withAssistantTaskRuntime } from '../extension/assistant-task.js';

const runtime = { aiTaskAssignments: { creativePlanning: { providerId: 'deepseek', model: 'deepseek-flash' } }, aiSettings: { apiKey: 'offline-fixture', consent: true } };
const url = 'https://example.test/article';
const preview = { captureId: 'batch', revision: 1, state: 'preview', tabId: 1, sourceUrl: url,
  candidates: [{ id: 'a', title: 'Article' }], selections: [{ candidateId: 'a', includeText: true, selectedMediaIds: [] }] };
for (const newSource of [false, true]) test(`a manual type belongs to the reused preview and ${newSource ? 'does not follow a new source' : 'survives the first assistant save'}`, async () => {
  let metadata, preparation;
  const result = await runCaptureAssistant({ tabId: 1, sourceUrl: url, instruction: '保存当前预览',
    captureMetadata: { contentTypeId: 'content:reference', contentTypeExplicit: true },
    initialBatch: { id: 'manual', tabId: 1, sourceUrl: url, candidates: [{ id: 'a' }] } }, {
    runtime, signal: new AbortController().signal,
    call: async (name, args) => {
      if (name === 'prepare_capture') { preparation = args; return { state: 'completed', result: preview }; }
      if (name === 'save_capture') { metadata = args.captureMetadata; return { state: 'completed', result: { ok: true, captureId: 'batch', results: [{ entryId: 'saved', candidateId: 'a', status: 'saved' }] } }; }
      return preview;
    },
    execute: async (_request, _settings, _images, { toolRuntime }) => {
      await toolRuntime.execute('prepare_capture', newSource ? { url: 'https://example.test/other' } : { tabId: 1 });
      await toolRuntime.execute('save_capture', { captureId: 'batch', expectedRevision: 1 });
      return { text: '已保存' };
    }
  });
  assert.equal(result.ok, true);
  assert.equal(Boolean(preparation.initialBatch), !newSource);
  assert.deepEqual(metadata, { contentTypeId: newSource ? '' : 'content:reference', contentTypeExplicit: !newSource });
});

test('completion uses the committed type when the model omitted or misstated its optional type argument', () => {
  const inventory = { name: 'read_capture', data: { part: 'modules', captureId: 'inventory', revision: 1, total: 1, sourceUrl: url,
    modules: [{ selector: '#a', title: 'A', sources: [{ selector: '#a pre', characters: 3 }] }] } };
  const scope = { captureId: 'inventory', selectors: ['#a'], project: 'project', saveMode: 'multiple' };
  for (const actualType of ['content:code-case', 'content:reference']) for (const argsType of [undefined, 'content:code-case']) {
    const records = [inventory, { name: 'prepare_capture', data: { captureId: 'batch', sourceUrl: url } }, {
      name: 'save_capture', args: { captureId: 'batch', project: 'project', ...(argsType ? { contentTypeId: argsType } : {}) },
      data: { captureId: 'batch', collectionId: 'project', results: [{ entryId: 'saved-code', status: 'saved', contentTypeId: actualType,
        originalVerification: { status: 'verified', sources: [{ selector: '#a pre', totalCharacters: 3, completeness: 'complete' }] } }] }
    }];
    assert.equal(captureScopeProgress(records, scope, 'content:code-case').complete, actualType === 'content:code-case');
  }
});

test('an undeclared preview is resolved semantically without silently authorizing a save', async () => {
  const calls = [];
  const tools = withAssistantTaskRuntime({ specs: [{ name: 'prepare_capture', parameters: { properties: { requestId: {} } } }],
    execute: async name => { calls.push(name); return { data: preview }; } }, { instruction: '先看看预览，暂不入库' });
  await tools.execute('prepare_capture', { tabId: 1 });
  assert.equal((await tools.finishTurn({ content: '已保存' })).state.captureIntentMissing, true);
  await tools.execute('declare_task', { mode: 'respond', goal: 'Only show the preview', steps: [], reply: '预览已准备，尚未保存。' });
  assert.equal(await tools.finishTurn({}), undefined);
  assert.deepEqual(calls, ['prepare_capture']);
});

test('a host-resolved code save completes its declared frozen module scope without a redundant model retry', async () => {
  const code = 'content:code-case';
  const module = { selector: '#code', title: 'Code', sources: [{ selector: '#code pre', characters: 3 }] };
  const inventory = { name: 'read_capture', data: { part: 'modules', captureId: 'directory', revision: 1, total: 1, sourceUrl: url, modules: [module] } };
  let actualMetadata, decision, journal = [];
  const codePreview = { ...preview, candidates: [{ id: 'a', codePreviewAvailable: true }] };
  const result = await runCaptureAssistant({ tabId: 1, sourceUrl: url, captureId: 'batch', instruction: '保存这个代码模块' }, {
    runtime, signal: new AbortController().signal,
    sessionRuntime: { loadContext: async () => [inventory, { name: 'prepare_capture', args: {}, data: codePreview }], recordToolResult: async record => journal.push(record) },
    call: async (name, args) => {
      if (name !== 'save_capture') return codePreview;
      assert.equal(args.contentTypeId, undefined, 'the schema permits omitting the model argument');
      actualMetadata = args.captureMetadata;
      return { state: 'completed', result: { ok: true, captureId: 'batch', collectionId: 'project', results: [{ candidateId: 'a', entryId: 'saved-code',
        contentTypeId: actualMetadata.contentTypeId, status: 'saved', originalVerification: { status: 'verified',
          sources: [{ selector: '#code pre', totalCharacters: 3, completeness: 'complete' }] } }] } };
    },
    execute: async (_request, _settings, _images, { toolRuntime }) => {
      await toolRuntime.loadContext();
      const declared = await toolRuntime.execute('declare_task', { mode: 'act', goal: 'Save this code module', steps: [{ operation: 'save_capture' }],
        contentTypeId: code, captureScope: { captureId: 'directory', selectors: ['#code'], project: 'project', saveMode: 'multiple' } });
      assert.equal(declared.data.ok, true);
      await toolRuntime.execute('save_capture', { captureId: 'batch', expectedRevision: 1, project: 'project' });
      decision = await toolRuntime.finishTurn({ content: 'Saved.' });
      return { text: 'Saved.' };
    }
  });
  assert.equal(result.ok, true);
  assert.deepEqual(actualMetadata, { contentTypeId: code, contentTypeExplicit: true });
  assert.equal(decision, undefined);
  assert.equal(result.taskState, 'completed');
  assert.equal(journal.at(-1).data.pending.length, 0);
});
