import test from 'node:test';
import assert from 'node:assert/strict';
import { captureContextReferences, runCaptureAssistant } from '../extension/capture-assistant.js';
import { createAgentCapturePreview } from '../extension/agent-capture-preview.js';
import { applyPageCaptureSelections } from '../extension/page-capture.js';
import { captureCompletionCheck } from '../extension/capture-assistant.js';
import { captureSceneForModel } from '../extension/agent-capture-preview.js';
import { captureReceiptText } from '../extension/assistant-chat-session.js';

function fixture() {
  const stored = {}, commits = [], url = 'https://x.com/author/status/123';
  const original = 'Exact complete prompt. '.repeat(130) + 'FINAL ORIGINAL WORDS';
  const storage = { get: async key => ({ [key]: structuredClone(stored[key]) }), set: async value => Object.assign(stored, structuredClone(value)) };
  const options = { storage, getLibraryId: async () => 'test-library', loadState: async () => ({ collections: [] }),
    chromeApi: { permissions: { contains: async () => true }, tabs: { get: async id => ({ id, url }) },
      scripting: { executeScript: async ({ func }) => [{ result: func.name === 'readCaptureSource'
        ? { ok: true, url, selector: '#comment', text: original, format: 'text' }
        : { ok: true, url, text: 'Post', links: [], media: [] } }] } },
    collect: async () => ({ candidates: [{ id: 'post', title: 'Post', adapter: 'x', canonicalUrl: url, contentText: 'Post', media: [] }] }),
    commit: async batch => { commits.push(batch); return { ok: true, results: [{ candidateId: 'post', entryId: 'saved', status: 'saved' }] }; } };
  return { api: createAgentCapturePreview(options), options, original, commits, url, scope: { libraryId: 'test-library', assertCurrent: async () => {} } };
}

test('historic nested source results and candidate originals are references, not repeated model input', () => {
  const original = 'Full original source '.repeat(10000);
  const records = [{ name: 'read_capture', args: { captureId: 'preview', part: 'source', selectors: ['pre'] }, data: { part: 'source', sources: [{ selector: 'pre', content: original, totalCharacters: original.length }] } },
    { name: 'update_capture', args: { candidates: [{ id: 'case', contentText: original, originalPrompt: original, codePreview: { html: original } }] }, data: { captureId: 'preview', revision: 3, selections: [{ candidateId: 'case' }] } }];
  const projected = captureContextReferences(records);
  assert(JSON.stringify(projected).length < 3000, 'full originals must not be repeatedly sent inside nested source results or mutation arguments');
  assert.equal(records[0].data.sources[0].content, original, 'durable originals remain intact');
  assert.equal(projected[0].data.sources[0].totalCharacters, original.length);
  assert.equal(projected[1].data.revision, 3);
});

test('X comment supplementation can keep the post media identity and use its complete frozen original', async () => {
  const f = fixture(); await f.api.execute('prepare_capture', { tabId: 1 }, 'preview', f.scope);
  const read = await f.api.read({ captureId: 'preview', part: 'source', selector: '#comment', length: 30 });
  const updated = await f.api.execute('update_capture', { captureId: 'preview', expectedRevision: read.revision,
    candidates: [{ id: 'post', title: 'Post with original prompt', canonicalUrl: f.url, textSources: [{ selector: '#comment', target: 'prompt' }], media: [] }],
    selections: [{ candidateId: 'post', includeText: true, selectedMediaIds: [] }] }, 'supplement', f.scope);
  const view = await f.api.view({ captureId: 'preview', expectedRevision: updated.revision });
  assert(view.batch.candidates[0].contentText.includes(f.original));
  assert(applyPageCaptureSelections(view.batch)[0].contentText.includes('FINAL ORIGINAL WORDS'));
});

test('a source that was frozen in full cannot be replaced by a model-written truncated prompt', async () => {
  const f = fixture(); await f.api.execute('prepare_capture', { tabId: 1 }, 'preview', f.scope);
  const read = await f.api.read({ captureId: 'preview', part: 'source', selector: '#comment' });
  await assert.rejects(f.api.execute('update_capture', { captureId: 'preview', expectedRevision: read.revision,
    candidates: [{ id: 'prompt', title: 'Prompt', canonicalUrl: f.url, originalPrompt: f.original.slice(0, 277), media: [] }] }, 'truncated', f.scope), { code: 'capture_source_required' });
});

test('save_capture applies an explicitly requested combined mode rather than ignoring it', async () => {
  const f = fixture(); await f.api.execute('prepare_capture', { tabId: 1 }, 'preview', f.scope);
  const update = await f.api.execute('update_capture', { captureId: 'preview', expectedRevision: 1,
    candidates: [{ id: 'comment', title: 'Comment', canonicalUrl: f.url, contentText: 'Exact comment', media: [] }],
    selections: ['post', 'comment'].map(candidateId => ({ candidateId, includeText: true, selectedMediaIds: [] })), saveMode: 'single' }, 'choose', f.scope);
  const result = await f.api.execute('save_capture', { captureId: 'preview', expectedRevision: update.revision, saveMode: 'combined' }, 'save', f.scope);
  assert.equal(result.state, 'completed'); assert.equal(f.commits[0].saveMode, 'combined');
});

test('an inherited completed preview cannot turn an unsupported new reply into a saved outcome', async () => {
  const result = await runCaptureAssistant({ captureId: 'old', instruction: 'Hello' }, {
    runtime: { aiTaskAssignments: { creativePlanning: { providerId: 'deepseek', model: 'deepseek-flash' } }, aiSettings: { apiKey: 'fixture', consent: true } },
    signal: new AbortController().signal, call: async () => ({ captureId: 'old', revision: 5, state: 'completed', results: [{ entryId: 'old-case', status: 'saved' }] }),
    execute: async () => ({ text: 'Hello' }) });
  assert.equal(result.outcome, 'conversation');
});

test('X partial comments use the actual supplement adapter once and freeze all text for paginated reads', async () => {
  const f = fixture(); let reads = 0;
  const api = createAgentCapturePreview({ ...f.options,
    collect: async () => ({ candidates: [{ id: 'post', title: 'Post', canonicalUrl: f.url, adapter: 'x', contentText: 'Post', media: [],
      supplements: [{ id: 'supplement:comment', sourceUrl: 'https://x.com/author/status/124', text: 'Short', partial: true, media: [] }] }] }),
    readSupplement: async item => { reads++; return { ...item, text: f.original, partial: false }; } });
  await api.execute('prepare_capture', { tabId: 1 }, 'preview', f.scope);
  const summary = await api.read({ captureId: 'preview' });
  assert(summary.platform.guidance.includes('supplement'));
  assert.equal(summary.candidates[0].supplements[0].partial, true);
  const first = await api.read({ captureId: 'preview', part: 'supplement', candidateId: 'post', supplementId: 'supplement:comment', length: 7 });
  const next = await api.read({ captureId: 'preview', part: 'supplement', candidateId: 'post', supplementId: 'supplement:comment', offset: first.nextOffset, expectedRevision: first.revision, length: 7 });
  assert.equal(reads, 1); assert.equal(first.completeness, 'complete'); assert.equal(first.revision, next.revision);
  assert.equal(next.content, f.original.slice(7, 14));
  await api.execute('update_capture', { captureId: 'preview', expectedRevision: next.revision,
    candidates: [{ id: 'post', title: 'Post', canonicalUrl: f.url, contentText: '', media: [], textSources: [{ selector: first.selector, target: 'prompt' }] }],
    selections: [{ candidateId: 'post', includeText: true, selectedMediaIds: [] }] }, 'freeze-comment', f.scope);
  assert((await api.view({ captureId: 'preview' })).batch.candidates[0].contentText.includes(f.original));
});

test('source-backed save checks the actual stored body; a truncated readback retains the case but reports partial', async () => {
  for (const matches of [true, false]) {
    const f = fixture(); const api = createAgentCapturePreview({ ...f.options, readSavedText: async () => matches ? f.original : f.original.slice(0, 277) });
    await api.execute('prepare_capture', { tabId: 1 }, 'preview', f.scope);
    const source = await api.read({ captureId: 'preview', part: 'source', selector: '#comment' });
    const update = await api.execute('update_capture', { captureId: 'preview', expectedRevision: source.revision,
      candidates: [{ id: 'post', title: 'Post', canonicalUrl: f.url, contentText: '', media: [], textSources: [{ selector: '#comment', target: 'prompt' }] }],
      selections: [{ candidateId: 'post', includeText: true, selectedMediaIds: [] }] }, 'select-source', f.scope);
    const result = await api.execute('save_capture', { captureId: 'preview', expectedRevision: update.revision }, 'save-source', f.scope);
    assert.equal(result.results[0].entryId, 'saved', 'readback failure does not discard a committed case');
    assert.equal(result.results[0].originalVerification.status, matches ? 'verified' : 'unverified');
    assert.equal(result.results[0].status, matches ? 'saved' : 'partial');
    assert.equal(result.state, matches ? 'completed' : 'preview');
  }
});

test('current scene remains a usable selector index when many long originals exceed the context read size', () => {
  const text = 'Exact source '.repeat(10000);
  const scene = { textModules: [{ selector: '#one', text, completeness: 'partial' }, { selector: '#two', text, completeness: 'complete' }], codeBlocks: [] };
  const index = captureSceneForModel(scene, 12000);
  assert(JSON.stringify(index).length <= 12000);
  assert.equal(index.textModules[0].totalCharacters, text.length); assert.equal(index.textModules[0].completeness, 'partial');
  assert(index.excerptOnly && index.textModules[0].excerptOnly); assert.equal(scene.textModules[0].text, text);
});

test('runtime rejects fabricated save, unsupported completeness and zero-tool correction claims, while allowing ordinary guidance', () => {
  assert(captureCompletionCheck('已保存。', [], { state: 'preview', revision: 1 }, null));
  assert(captureCompletionCheck('已保存。', [], { state: 'completed', revision: 5 }, null), 'an old completed preview is not a receipt for this turn');
  assert(captureCompletionCheck('已核对这条案例，我会补一次。', [], null, null));
  const read = { name: 'read_capture', args: { part: 'source', selector: '#comment' }, result: { data: { selector: '#comment', totalCharacters: 2700 } } };
  assert(captureCompletionCheck('完整提示词已选中。', [read], { revision: 2, selections: [{ candidateId: 'post', includeText: true }], candidates: [{ id: 'post' }] }, null));
  assert.equal(captureCompletionCheck('未取得完整提示词，原文仍被折叠。', [read], { revision: 2 }, null), undefined);
  assert.equal(captureCompletionCheck('点保存案例即可入库。', [], null, null), undefined);
});

test('the shared studio transcript never turns duplicates or partial receipts into a saved status', () => {
  assert.equal(captureReceiptText({ results: [{ entryId: 'case', status: 'duplicate' }] }), '已有案例，未新增采集内容。');
  assert.equal(captureReceiptText({ results: [{ entryId: 'case', status: 'partial' }] }), '已部分保存，请查看缺失原因。');
  assert.equal(captureReceiptText({ results: [{ entryId: 'case', status: 'saved' }] }), '已保存。');
});
