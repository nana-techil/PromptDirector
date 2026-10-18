import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createAgentCapturePreview } from '../extension/agent-capture-preview.js';
import { createAgentTasks } from '../extension/agent-tasks.js';

const source = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
function functionSource(name) {
  const start = source.indexOf(`function ${name}(`);
  return source.slice(source.slice(start - 6, start) === 'async ' ? start - 6 : start, source.indexOf('\n}', start) + 2);
}
const dependencies = Object.assign({}, ...await Promise.all([
  'page-capture', 'page-capture-repair', 'capture-draft', 'capture-save-tasks', 'capture-asset-index',
  'capture-download-ahead', 'capture-save-progress', 'classifier', 'media', 'image-generation-info',
  'image-generation-ingestion', 'library-folder-ownership', 'organizer', 'facets', 'taxonomy', 'article-document', 'lib'
].map(name => import(`../extension/${name}.js`))));

const original = { id: 'business', title: 'Manual title', text: 'Manual edited introduction', textRevision: 3,
  url: 'https://x.com/artist/status/123456789', sourceFacts: { provider: 'x', itemId: '123456789', pageType: 'image' },
  articleDocument: { version: 1, blocks: [{ id: 'manual', kind: 'paragraph', text: 'Manual edited introduction', sourceOrder: 0 }] },
  customLabels: ['keep label'], mediaPrompts: [{assetId: 'original-image', text: 'Manual image prompt', source: 'manual', textRevision: 1, updatedAt: '2026-01-01T00:00:00.000Z'}],
  mediaAssets: [{ id: 'original-image', kind: 'image', storageMode: 'managed', sourceUrl: 'https://cdn.example.test/original.png', mimeType: 'image/png' }] };
const completePrompt = 'Exact original prompt.\n'.repeat(400) + 'Permission: attribution required.';
const candidate = { id: 'selected', canonicalUrl: original.url, title: 'Source title', contentText: completePrompt,
  pageType: 'image', sourceFacts: original.sourceFacts,
  textBlocks: [{ id: 'agent:bound-source:selected', kind: 'section', text: completePrompt }],
  media: [{ id: 'image', kind: 'image', url: original.mediaAssets[0].sourceUrl }] };
const batch = { id: 'preview', sourceUrl: original.url, candidates: [candidate],
  selections: [{ candidateId: 'selected', includeText: true, selectedMediaIds: ['image'], mediaDecision: 'confirmed' }] };

// Run the actual background commit function. Only browser storage, blob lookup,
// and notifications are substituted; duplicate matching, repair, project copying,
// classification, normalization, rebase and receipt projection are production code.
function fixture({ existingCopy = false, mutateBeforeCommit, compound = false } = {}) {
  let state = { entries: [structuredClone(original)], organizerState: { collections: [
    { id: 'target', name: 'Test project', entryIds: existingCopy ? ['target-copy'] : [] },
    { id: 'old', name: 'Business project', entryIds: ['business'] }
  ] }, compoundCases: [], taxonomy: dependencies.normalizeTaxonomy(), classificationRules: [] };
  if (existingCopy) state.entries.push({ ...structuredClone(original), id: 'target-copy', text: 'Target manual edit', title: 'Target title' });
  if (compound) {
    state.entries.push({ ...structuredClone(original), id: 'related', url: 'https://example.test/related', text: 'Related manual notes' });
    state.organizerState.collections[1].entryIds.push('related');
    state.compoundCases.push({ id: 'compound', title: 'Original group', memberEntryIds: ['business', 'related'] });
  }
  let reads = 0, writes = 0, blobReads = 0;
  const context = vm.createContext({ ...dependencies, crypto: globalThis.crypto, structuredClone, console, chrome: {},
    STORAGE_KEYS: { entries: 'entries', organizerState: 'organizerState', compoundCases: 'compoundCases' },
    enqueue: async fn => fn(), readState: async () => {
      if (++reads === 2) mutateBeforeCommit?.(state);
      return structuredClone(state);
    }, resolveXVideoSources: async snapshot => snapshot,
    getMediaBlob: async () => { blobReads++; return new Blob(['original bytes']); },
    commitLocalChanges: async values => { writes++; Object.assign(state, structuredClone(values)); },
    deleteUnreferencedMedia: async () => {}, notifySaved: async () => {}, userMessage: error => error.message
  });
  const commit = vm.runInContext(`${functionSource('organizerAfterCapturePlacement')}\n${functionSource('commitPageCapture')}\ncommitPageCapture`, context);
  return { commit: (metadata, input = batch) => commit(structuredClone(input), metadata, { stage() {}, update() {} }),
    state: () => structuredClone(state), writes: () => writes, blobReads: () => blobReads };
}

test('supplemented full originals update only the selected existing project copy and preserve manual edits', async () => {
  const f = fixture({ existingCopy: true });
  const before = f.state();
  const result = await f.commit({ collectionId: 'target' });
  assert.equal(result.results[0].entryId, 'target-copy');
  assert.equal(result.results[0].status, 'saved');
  assert.deepEqual(f.state().entries[0], before.entries[0], 'Business source must remain byte-for-byte unchanged');
  const saved = f.state().entries.find(entry => entry.id === 'target-copy');
  assert.equal(saved.text, `Target manual edit\n\n${completePrompt}`);
  assert.equal(saved.title, 'Target title'); assert.equal(saved.textRevision, 4);
  assert.deepEqual(saved.mediaPrompts, before.entries[1].mediaPrompts);
  assert(saved.articleDocument.blocks.some(block => block.text === completePrompt));
  const retry = await f.commit({ collectionId: 'target' });
  assert.equal(retry.results[0].entryId, 'target-copy');
  assert.equal(f.state().entries.length, 2);
  assert.equal(f.state().entries[1].text, saved.text, 'Retry does not append a second copy of the original');
  assert.equal(f.state().entries[1].textRevision, saved.textRevision);
});

for (const newProject of [false, true]) test(`first supplement into ${newProject ? 'a new' : 'an empty existing'} project copies before repair, even when target sorts before source`, async () => {
  const f = fixture(); const before = f.state();
  const result = await f.commit(newProject ? { newCollectionName: 'New test' } : { collectionId: 'target' });
  const id = result.results[0].entryId;
  assert.notEqual(id, 'business');
  const state = f.state(), saved = state.entries.find(entry => entry.id === id);
  assert.deepEqual(state.entries.find(entry => entry.id === 'business'), before.entries[0]);
  assert.equal(saved.text, `${original.text}\n\n${completePrompt}`);
  assert.equal(saved.copyOrigin.caseId, 'business');
  assert.equal(saved.mediaAssets[0].id, original.mediaAssets[0].id, 'Original asset is reused without downloading');
  assert(state.organizerState.collections.find(item => item.id === result.collectionId).entryIds.includes(id));
  assert.deepEqual(state.organizerState.collections.find(item => item.id === 'old').entryIds, ['business']);
  assert.equal(f.writes(), 1); assert.equal(f.blobReads(), 1);
  await f.commit({ collectionId: result.collectionId });
  assert.equal(f.state().entries.length, 2);
  assert.equal(f.state().entries.find(entry => entry.id === id).text, saved.text);
});

test('copying a compound preserves related notes and relations without altering business members', async () => {
  const f = fixture({ compound: true }); const before = f.state();
  const result = await f.commit({ collectionId: 'target' });
  const state = f.state();
  assert.deepEqual(state.entries.slice(0, 2), before.entries);
  assert.deepEqual(state.compoundCases[0], before.compoundCases[0]);
  assert.equal(state.compoundCases.length, 2);
  const targetMembers = state.compoundCases[1].memberEntryIds;
  assert(targetMembers.includes(result.results[0].entryId));
  assert.equal(state.entries.find(entry => entry.id === targetMembers[1]).text, 'Related manual notes');
});

for (const existingCopy of [false, true]) test(`concurrent manual editing of ${existingCopy ? 'target' : 'source'} rejects the save without copying stale content`, async () => {
  const f = fixture({ existingCopy, mutateBeforeCommit: state => { state.entries.at(-1).text = 'Newer manual edit'; } });
  await assert.rejects(f.commit({ collectionId: 'target' }), /下载期间已变化/u);
  assert.equal(f.writes(), 0); assert.equal(f.state().entries.at(-1).text, 'Newer manual edit');
});

test('moving the target copy out of the selected project during capture rejects an outdated repair', async () => {
  const f = fixture({ existingCopy: true, mutateBeforeCommit: state => { state.organizerState.collections[0].entryIds = []; } });
  await assert.rejects(f.commit({ collectionId: 'target' }), /案例项目在下载期间已变化/u);
  assert.equal(f.writes(), 0);
});

for (const matched of [true, false]) test(`MCP frozen-source supplement uses the common save and reports ${matched ? 'verified originals with idempotent replay' : 'readback failure without a stale duplicate-success message'}`, async () => {
  const f = fixture({ existingCopy: true });
  const data = {}, url = original.url;
  const storage = { get: async keys => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, structuredClone(data[key])])),
    set: async values => Object.assign(data, structuredClone(values)), remove: async keys => { for (const key of keys) delete data[key]; } };
  const scope = { libraryId: 'library', assertCurrent: async () => {} };
  const api = createAgentCapturePreview({ storage, getLibraryId: async () => 'library',
    chromeApi: { permissions: { contains: async () => true },
      tabs: { get: async id => ({ id, url, status: 'complete' }), onUpdated: { addListener() {}, removeListener() {} }, onRemoved: { addListener() {}, removeListener() {} } },
      scripting: { executeScript: async () => [{ result: { ok: true, url, selector: '#prompt', text: completePrompt, format: 'text', completeness: 'complete' } }] } },
    collect: async () => ({ candidates: [{ ...candidate, contentText: 'Short initially captured introduction', textBlocks: [] }] }),
    commit: async (batch, metadata) => matched ? f.commit(metadata, batch)
      : { ok: true, message: '已保存 0 项，跳过 1 项重复内容', results: [{ candidateId: candidate.id, entryId: 'target-copy', status: 'duplicate' }] },
    loadState: async () => f.state(),
    readSavedText: async id => f.state().entries.find(entry => entry.id === id).text
  });
  await api.execute('prepare_capture', { tabId: 1 }, 'preview', scope);
  const read = await api.read({ captureId: 'preview', part: 'source', selector: '#prompt' });
  const updated = await api.execute('update_capture', { captureId: 'preview', expectedRevision: read.revision,
    candidates: [{ id: candidate.id, canonicalUrl: url, textSources: [{ selector: '#prompt', target: 'text' }] }],
    selections: [{ candidateId: candidate.id, includeText: true, selectedMediaIds: [], mediaDecision: 'none' }]
  }, 'bind-full-original', scope);
  const tasks = createAgentTasks({ storage, getLibraryId: async () => 'library',
    execute: (operation, input, id, taskScope) => api.execute(operation, input, id, taskScope) });
  const input = { captureId: 'preview', expectedRevision: updated.revision, project: 'target' };
  await tasks.submit('save_capture', input, 'same-save');
  const done = await tasks.inspect('same-save', { waitMs: 1000 });
  assert.equal(done.state, 'completed', JSON.stringify(done));
  const receipt = done.result.results[0];
  assert.equal(receipt.originalVerification.status, matched ? 'verified' : 'unverified');
  assert.equal(done.result.state, matched ? 'completed' : 'preview');
  if (matched) {
    assert.equal(receipt.entryId, 'target-copy');
    assert.equal(f.state().entries[1].text, `Target manual edit\n\n${completePrompt}`);
    assert.deepEqual(f.state().entries[0], original);
  } else {
    assert.equal(receipt.status, 'partial');
    assert.match(done.result.message, /原文未核对完整/u);
    assert.doesNotMatch(done.result.message, /跳过.*重复/u);
  }
  const writes = f.writes();
  const replay = await tasks.submit('save_capture', input, 'same-save');
  assert.equal(replay.replayed, true); assert.equal(f.writes(), writes);
});
