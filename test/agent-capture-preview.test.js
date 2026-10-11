import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentCapturePreview } from '../extension/agent-capture-preview.js';
import { applyPageCaptureSelections } from '../extension/page-capture.js';

function fixture() {
  const data = {}, commits = []; let allowed = true, url = 'https://example.test/work', libraryId = 'library-a';
  const storage = { get: async key => ({ [key]: structuredClone(data[key]) }), set: async value => Object.assign(data, structuredClone(value)),
    remove: async keys => { for (const key of keys) delete data[key]; } };
  const scope = { libraryId, assertCurrent: async () => { if (libraryId !== scope.libraryId) throw Object.assign(new Error('changed'), { code: 'library_changed' }); } };
  const options = { storage, chromeApi: { permissions: { contains: async () => allowed },
    tabs: { get: async id => ({ id, url, status: 'complete' }) },
    scripting: { executeScript: async () => [{ result: { ok: true, url, text: 'complete observed page', links: [], media: [] } }] } },
    collect: async () => ({ candidates: [{ id: 'original', title: 'Original', canonicalUrl: url, contentText: 'Full original body',
      articleDocument: { version: 1, blocks: [{ id: 'old-paragraph', kind: 'paragraph', text: 'Full original body', sourceOrder: 0 }] },
      media: [{ id: 'photo', kind: 'image', url: 'https://example.test/photo.png', originalPrompt: 'Exact original prompt' }] }] }),
    commit: async batch => { commits.push(structuredClone(batch)); return { ok: true, results: [{ candidateId: 'original', status: 'saved', entryId: 'saved' }] }; },
    loadState: async () => ({ collections: [] }), getLibraryId: async () => libraryId };
  return { data, commits, options, scope, api: createAgentCapturePreview(options),
    permission: value => { allowed = value; }, navigate: () => { url = 'https://example.test/elsewhere'; }, changeLibrary: () => { libraryId = 'library-b'; } };
}

test('source-backed capture stores the full original code even when the model read only a prefix or supplied fabricated code', async () => {
  const f = fixture(); const original = '  export function source() {\n  return "keep actual code";\n}\n' + '// full original\n'.repeat(1000);
  f.options.chromeApi.scripting.executeScript = async ({ func }) => [{ result: { ok: true, url: 'https://example.test/work', text: func.name === 'readCaptureSource' ? original : 'page facts', format: 'code', links: [], media: [] } }];
  await f.api.execute('prepare_capture', { tabId: 1 }, 'preview', f.scope);
  const read = await f.api.read({ captureId: 'preview', part: 'source', selector: 'pre', length: 7 });
  assert.equal(read.content, original.slice(0, 7)); assert.notEqual(read.nextOffset, null);
  const updated = await f.api.execute('update_capture', { captureId: 'preview', expectedRevision: read.revision,
    candidates: [{ id: 'code', title: 'Actual source', canonicalUrl: 'https://example.test/work', contentText: 'invented example', originalPrompt: 'fake source', media: [],
      textSources: [{ selector: 'pre', target: 'prompt' }] }], selections: [{ candidateId: 'code', includeText: true, selectedMediaIds: [] }], saveMode: 'multiple' }, 'supplement', f.scope);
  let page = await f.api.read({ captureId: 'preview', part: 'candidate', candidateId: 'code' }), content = page.content;
  while (page.nextOffset !== null) {
    page = await f.api.read({ captureId: 'preview', part: 'candidate', candidateId: 'code', expectedRevision: page.revision, offset: page.nextOffset }); content += page.content;
  }
  const candidate = JSON.parse(content);
  assert(candidate.contentText.includes(original)); assert(!candidate.contentText.includes('fake source')); assert(!candidate.contentText.includes('invented example'));
  await f.api.execute('save_capture', { captureId: 'preview', expectedRevision: updated.revision }, 'save-code', f.scope);
  assert(applyPageCaptureSelections(f.commits[0])[0].contentText.includes(original));
});

test('multiple source tabs share one revision and save every frozen original even after a tiny understanding read', async () => {
  const f=fixture(); await f.api.execute('prepare_capture',{tabId:1},'preview',f.scope);
  const sources=['css','react','prompt'].map(selector=>({ok:true,url:'https://example.test/work',selector,text:'Complete '+selector+' original',format:'code'}));
  f.options.chromeApi.scripting.executeScript=async()=>[{result:{ok:true,url:'https://example.test/work',sources}}];
  const read=await f.api.read({captureId:'preview',expectedRevision:1,part:'source',selectors:['css','react','prompt'],length:3});
  assert.equal(read.revision,2);assert(read.sources.every(source=>source.content.length===1&&source.nextOffset===1));
  const selected=await f.api.execute('update_capture',{captureId:'preview',expectedRevision:read.revision,
    candidates:[{id:'original',title:'Original',canonicalUrl:'https://example.test/work',contentText:'',media:[],textSources:sources.map(source=>({selector:source.selector,target:'prompt'}))}],
    selections:[{candidateId:'original',includeText:true,selectedMediaIds:[]}]},'all-tabs',f.scope);
  await f.api.execute('save_capture',{captureId:'preview',expectedRevision:selected.revision},'save-all-tabs',f.scope);
  const candidate=applyPageCaptureSelections(f.commits[0])[0];assert(sources.every(source=>candidate.contentText.includes(source.text)));
  assert.equal(candidate.sourceFacts.caseOriginalPromptAvailable,true);
});

test('a declared batch task cannot save only one of its explicitly requested cases', async () => {
  const f = fixture(); await f.api.execute('prepare_capture', { tabId: 1 }, 'preview', f.scope);
  const added = await f.api.execute('update_capture', { captureId: 'preview', expectedRevision: 1,
    candidates: [{ id: 'second', title: 'Second', canonicalUrl: 'https://example.test/work', contentText: 'actual second original', media: [] }],
    selections: selected, saveMode: 'multiple', task: { objective: 'Save both selected cases', outcome: 'save', candidateIds: ['original', 'second'], state: 'active' } }, 'add', f.scope);
  await assert.rejects(f.api.execute('save_capture', { captureId: 'preview', expectedRevision: added.revision }, 'save-half', f.scope), { code: 'capture_task_incomplete' });
  assert.equal(f.commits.length, 0);
  assert.equal((await f.api.read({ captureId: 'preview' })).task.candidateIds.length, 2);
});

test('missing case identities or receipts for the wrong candidate never mark the capture complete', async () => {
  for (const receipt of [{ status: 'saved', candidateId: 'original' }, { status: 'saved', candidateId: 'wrong-case', entryId: 'different' }]) {
    const f = fixture(); const api = createAgentCapturePreview({ ...f.options, commit: async () => ({ ok: true, results: [receipt] }) });
    await api.execute('prepare_capture', { tabId: 1 }, 'preview', f.scope);
    await api.execute('update_capture', { captureId: 'preview', expectedRevision: 1, selections: selected }, 'select', f.scope);
    assert.equal((await api.execute('save_capture', { captureId: 'preview', expectedRevision: 2 }, 'save', f.scope)).state, 'preview');
    assert.equal((await api.read({ captureId: 'preview' })).selections.length, 1);
  }
});
const selected = [{ candidateId: 'original', includeText: true, selectedMediaIds: ['photo'] }];

test('preview does not write cases, survives restarting the service, and only saves explicitly selected originals', async () => {
  const f = fixture();
  const first = await f.api.execute('prepare_capture', { tabId: 1 }, 'preview', f.scope);
  assert.deepEqual(first.selections, []); assert.equal(f.commits.length, 0);
  await assert.rejects(f.api.execute('save_capture', { captureId: 'preview', expectedRevision: 1 }, 'save-empty', f.scope), { code: 'capture_selection_required' });
  const reloaded = createAgentCapturePreview(f.options);
  assert.equal((await reloaded.read({ captureId: 'preview', part: 'page' })).content.includes('complete observed page'), true);
  const updated = await reloaded.execute('update_capture', { captureId: 'preview', expectedRevision: 1, selections: selected }, 'select', f.scope);
  assert.equal(updated.revision, 2);
  const result = await reloaded.execute('save_capture', { captureId: 'preview', expectedRevision: 2 }, 'save', f.scope);
  assert.equal(result.state, 'completed');
  const actual = applyPageCaptureSelections(f.commits[0]);
  assert.equal(actual.length, 1); assert.equal(actual[0].contentText, 'Full original body');
  assert.equal(actual[0].media[0].originalPrompt, 'Exact original prompt');
  await assert.rejects(reloaded.execute('save_capture', { captureId: 'preview', expectedRevision: 3 }, 'again', f.scope), { code: 'capture_not_editable' });
});

test('Agent supplementation retains existing body, structured document, media and original prompt rather than replacing them with a summary', async () => {
  const f = fixture(); await f.api.execute('prepare_capture', { tabId: 1 }, 'preview', f.scope);
  await f.api.execute('update_capture', { captureId: 'preview', expectedRevision: 1,
    candidates: [{ id: 'original', title: 'Original', canonicalUrl: 'https://example.test/work', contentText: 'Additional prompt from DOM',
      media: [{ id: 'extra', kind: 'image', url: 'https://example.test/extra.png' }] }],
    selections: [{ candidateId: 'original', includeText: true, selectedMediaIds: ['extra'] }] }, 'supplement', f.scope);
  const result = JSON.parse((await f.api.read({ captureId: 'preview', part: 'candidate', candidateId: 'original' })).content);
  assert.match(result.contentText, /Full original body/); assert.match(result.contentText, /Additional prompt from DOM/);
  assert.deepEqual(result.articleDocument.blocks.map(item => item.text), ['Full original body', 'Additional prompt from DOM']);
  assert.equal(result.media.length, 2); assert.equal(result.media[0].originalPrompt, 'Exact original prompt');
  assert.equal(result.completeness, 'partial');
  await f.api.execute('save_capture', { captureId: 'preview', expectedRevision: 2 }, 'save', f.scope);
  assert.deepEqual(applyPageCaptureSelections(f.commits[0])[0].media.map(item => item.id), ['extra']);
});

test('stale selection, invalid media and changed sources fail without changing preview or cases', async () => {
  const f = fixture(); await f.api.execute('prepare_capture', { tabId: 1 }, 'preview', f.scope);
  const before = structuredClone(f.data);
  for (const [input, code] of [
    [{ expectedRevision: 0, selections: selected }, 'invalid_input'],
    [{ expectedRevision: 2, selections: selected }, 'capture_changed'],
    [{ expectedRevision: 1, selections: [{ ...selected[0], selectedMediaIds: ['missing'] }] }, 'invalid_selection'],
    [{ expectedRevision: 1, candidates: [{ id: 'original', canonicalUrl: 'https://another.test/', contentText: 'replacement' }] }, 'capture_source_changed'],
    [{ expectedRevision: 1, candidates: [{ id: 'original', canonicalUrl: 'https://example.test/work', media: [{ id: 'photo', url: 'https://example.test/replacement.png' }] }] }, 'capture_source_changed']
  ]) await assert.rejects(f.api.execute('update_capture', { captureId: 'preview', ...input }, 'bad', f.scope), { code });
  assert.deepEqual(f.data, before); assert.equal(f.commits.length, 0);
});

test('full paginated page reads are pinned to a revision and never silently combine different selections', async () => {
  const f = fixture(); await f.api.execute('prepare_capture', { tabId: 1 }, 'preview', f.scope);
  let page = await f.api.read({ captureId: 'preview', part: 'page', length: 7 }), content = page.content;
  while (page.nextOffset !== null) {
    page = await f.api.read({ captureId: 'preview', part: 'page', expectedRevision: page.revision, offset: page.nextOffset, length: 7 }); content += page.content;
  }
  assert.equal(JSON.parse(content).text, 'complete observed page');
  await assert.rejects(f.api.read({ captureId: 'preview', part: 'page', offset: 7 }), { code: 'capture_revision_required' });
  await f.api.execute('update_capture', { captureId: 'preview', expectedRevision: 1, selections: selected }, 'select', f.scope);
  await assert.rejects(f.api.read({ captureId: 'preview', part: 'page', expectedRevision: 1, offset: 7 }), { code: 'capture_changed' });
});

test('permission denial and changing library prevent preview creation or saving into the wrong library', async () => {
  const f = fixture(); f.permission(false);
  await assert.rejects(f.api.execute('prepare_capture', { tabId: 1 }, 'preview', f.scope), { code: 'site_permission_required' });
  assert.deepEqual(f.data, {});
  f.permission(true); await f.api.execute('prepare_capture', { tabId: 1 }, 'preview', f.scope);
  f.changeLibrary(); await assert.rejects(f.api.read({ captureId: 'preview' }), { code: 'library_mismatch' });
});

test('partial save retains preview for completion without discarding original material', async () => {
  const f = fixture(); f.options.commit = async () => ({ ok: true, results: [{ status: 'partial', entryId: 'partial', warnings: ['video unavailable'] }] });
  const api = createAgentCapturePreview(f.options);
  await api.execute('prepare_capture', { tabId: 1 }, 'preview', f.scope);
  await api.execute('update_capture', { captureId: 'preview', expectedRevision: 1, selections: selected }, 'select', f.scope);
  assert.equal((await api.execute('save_capture', { captureId: 'preview', expectedRevision: 2 }, 'save', f.scope)).state, 'preview');
  assert.equal((await api.read({ captureId: 'preview', part: 'candidate', candidateId: 'original' })).content.includes('Full original body'), true);
});

test('saved preview history follows existing resource budgets while unfinished work and saved cases remain protected', async () => {
  const f = fixture(); const api = createAgentCapturePreview({ ...f.options, budget: { maxAutomaticHistoryItems: 1 } });
  await api.execute('prepare_capture', { tabId: 1 }, 'unfinished', f.scope);
  for (const id of ['saved-one', 'saved-two']) {
    await api.execute('prepare_capture', { tabId: 1 }, id, f.scope);
    await api.execute('update_capture', { captureId: id, expectedRevision: 1, selections: selected }, `select-${id}`, f.scope);
    await api.execute('save_capture', { captureId: id, expectedRevision: 2 }, `save-${id}`, f.scope);
  }
  assert.equal((await api.read({ captureId: 'unfinished' })).state, 'preview');
  assert.equal((await api.read({ captureId: 'saved-two' })).state, 'completed');
  await assert.rejects(api.read({ captureId: 'saved-one' }), { code: 'capture_not_found' });
  assert.equal(f.commits.length, 2);
  assert.deepEqual(f.data['agentCaptureHistory:library-a'].map(item => item.id), ['saved-two']);
});

test('an auxiliary history cleanup failure must not turn a confirmed save into failure or enable repeating the save', async () => {
  const f = fixture(); const api = createAgentCapturePreview({ ...f.options, budget: { maxAutomaticHistoryItems: 1 } });
  f.options.storage.remove = async () => { throw new Error('storage removal unavailable'); };
  for (const id of ['saved-one', 'saved-two']) {
    await api.execute('prepare_capture', { tabId: 1 }, id, f.scope);
    await api.execute('update_capture', { captureId: id, expectedRevision: 1, selections: selected }, `select-${id}`, f.scope);
    assert.equal((await api.execute('save_capture', { captureId: id, expectedRevision: 2 }, `save-${id}`, f.scope)).state, 'completed');
  }
  assert.equal(f.commits.length, 2);
  await assert.rejects(api.execute('save_capture', { captureId: 'saved-two', expectedRevision: 3 }, 'retry', f.scope), { code: 'capture_not_editable' });
});

test('an adapter failure keeps an editable evidence-backed preview instead of preventing Agent supplementation', async () => {
  const f = fixture(); f.options.collect = async () => { throw Object.assign(new Error('Selected post not mounted'), { code: 'X_POST_NOT_MOUNTED' }); };
  const api = createAgentCapturePreview(f.options);
  const prepared = await api.execute('prepare_capture', { tabId: 1 }, 'failed-scan', f.scope);
  assert.deepEqual(prepared.candidates, []); assert.equal(prepared.scanError.code, 'X_POST_NOT_MOUNTED');
  const page = JSON.parse((await api.read({ captureId: 'failed-scan', part: 'page' })).content);
  assert.equal(page.text, 'complete observed page'); assert.equal(f.commits.length, 0);
  const repaired = await api.execute('update_capture', { captureId: 'failed-scan', expectedRevision: 1,
    candidates: [{ id: 'recovered', title: 'Recovered', canonicalUrl: 'https://example.test/work', contentText: page.text, media: [] }],
    selections: [{ candidateId: 'recovered', includeText: true, selectedMediaIds: [] }] }, 'repair', f.scope);
  assert.equal(repaired.selections.length, 1); assert.equal(repaired.revision, 2);
});

test('a failed adapter must not turn a website access challenge into saveable page evidence', async () => {
  const f = fixture(); f.options.collect = async () => { throw new Error('adapter failed'); };
  f.options.chromeApi.scripting.executeScript = async () => [{ result: { ok: false, message: 'Complete website access check' } }];
  const api = createAgentCapturePreview(f.options);
  await assert.rejects(api.execute('prepare_capture', { tabId: 1 }, 'blocked', f.scope), { code: 'capture_page_unavailable' });
  assert.deepEqual(f.data, {}); assert.equal(f.commits.length, 0);
});

test('a screenshot is read only from the verified visible source and discarded after even a switch back', async () => {
  const f = fixture(), listeners = {};
  for (const name of ['onActivated', 'onUpdated']) f.options.chromeApi.tabs[name] = { addListener: fn => { listeners[name] = fn; }, removeListener: fn => { assert.equal(listeners[name], fn); delete listeners[name]; } };
  f.options.chromeApi.tabs.get = async id => ({ id, active: true, status: 'complete', windowId: 2, url: 'https://example.test/work' });
  f.options.chromeApi.tabs.captureVisibleTab = async () => 'data:image/png;base64,eA==';
  const api = createAgentCapturePreview(f.options); await api.execute('prepare_capture', { tabId: 1 }, 'visible', f.scope);
  const shot = await api.read({ captureId: 'visible', part: 'screenshot' });
  assert.equal(shot.dataUrl, 'data:image/png;base64,eA=='); assert.deepEqual(listeners, {});
  f.options.chromeApi.tabs.captureVisibleTab = async () => { listeners.onActivated({ windowId: 2, tabId: 7 }); return 'data:image/png;base64,eA=='; };
  await assert.rejects(api.read({ captureId: 'visible', part: 'screenshot' }), { code: 'page_changed' });
  assert.deepEqual(listeners, {}); assert.equal(f.commits.length, 0);
});

test('retry reads fresh observed page facts, keeps chosen originals, and pins later work to the changed revision', async () => {
  const f = fixture(); await f.api.execute('prepare_capture', { tabId: 1 }, 'fresh', f.scope);
  await f.api.execute('update_capture', { captureId: 'fresh', expectedRevision: 1, selections: selected }, 'choose', f.scope);
  f.options.chromeApi.scripting.executeScript = async () => [{ result: { ok: true, url: 'https://example.test/work', text: 'Video link appeared after loading', media: [{ kind: 'video', url: 'https://example.test/new.mp4' }], links: [] } }];
  const page = await f.api.read({ captureId: 'fresh', expectedRevision: 2, part: 'page', refresh: true });
  assert.equal(page.revision, 3); assert.match(page.content, /new.mp4/);
  const summary = await f.api.read({ captureId: 'fresh' }); assert.deepEqual(summary.selections, selected.map(item => ({ ...item, mediaDecision: 'confirmed' })));
  const preview = await f.api.view({ captureId: 'fresh' });
  const originals = applyPageCaptureSelections(preview.batch);
  assert.equal(originals[0].contentText, 'Full original body');
  assert.equal(originals[0].media[0].originalPrompt, 'Exact original prompt');
  await assert.rejects(f.api.execute('update_capture', { captureId: 'fresh', expectedRevision: 2, selections: [] }, 'stale', f.scope), { code: 'capture_changed' });
  assert.equal((await f.api.read({ captureId: 'fresh', part: 'page', refresh: true })).revision, 3, 'unchanged observed evidence reuses the existing revision');
});

test('reading a selected image returns actual original bytes, while missing originals never fall back to another picture', async () => {
  const f = fixture(); f.options.readImage = async () => new Blob(['original pixels'], { type: 'image/png' });
  const api = createAgentCapturePreview(f.options); await api.execute('prepare_capture', { tabId: 1 }, 'image', f.scope);
  const image = await api.read({ captureId: 'image', part: 'image', candidateId: 'original', mediaId: 'photo' });
  assert.equal(Buffer.from(image.dataUrl.split(',')[1], 'base64').toString(), 'original pixels');
  await assert.rejects(api.read({ captureId: 'image', part: 'image', candidateId: 'original', mediaId: 'absent' }), { code: 'capture_candidate_not_found' });
  f.options.readImage = async () => null;
  const missing = createAgentCapturePreview(f.options);
  await assert.rejects(missing.read({ captureId: 'image', part: 'image', candidateId: 'original', mediaId: 'photo' }), { code: 'capture_page_unavailable' });
});

test('a whole-page candidate cannot be relabelled as a specific source-backed module while retaining unrelated original text', async () => {
  const f=fixture(); await f.api.execute('prepare_capture',{tabId:1},'preview',f.scope);
  const source=await f.api.read({captureId:'preview',part:'source',selector:'#module'});
  const before=structuredClone(f.data);
  await assert.rejects(f.api.execute('update_capture',{captureId:'preview',expectedRevision:source.revision,
    candidates:[{id:'original',title:'Selected module',canonicalUrl:'https://example.test/work',contentText:'',media:[],textSources:[{selector:'#module',target:'text'}]}]},'wrong-module',f.scope),{code:'capture_source_changed'});
  assert.deepEqual(f.data,before);assert.equal(f.commits.length,0);
});

test('live context is readable without adapter scanning and never returns truncated JSON or changes the preview', async () => {
  const f=fixture();
  const context=await f.api.read({part:'context',tabId:1});
  assert.equal(context.nextOffset,null);assert.equal(JSON.parse(context.content).text,'complete observed page');
  assert.deepEqual(f.data,{});assert.equal(f.commits.length,0);
  await assert.rejects(f.api.read({part:'context',tabId:1,length:1}),{code:'capture_context_scope_required'});
  await assert.rejects(f.api.read({part:'context',tabId:1,offset:1}),{code:'invalid_input'});
  f.permission(false);await assert.rejects(f.api.read({part:'context',tabId:1}),{code:'site_permission_required'});
});
test('selecting a single independent module never asks for a multi-case save decision merely because other candidates exist', async () => {
  const f=fixture();f.api=createAgentCapturePreview({ ...f.options, commit: async batch => { f.commits.push(batch); return { ok: true, results: applyPageCaptureSelections(batch).map(item => ({ candidateId: item.id, entryId: 'saved-'+item.id, status: 'saved' })) }; } });
  await f.api.execute('prepare_capture',{tabId:1},'preview',f.scope);
  const updated=await f.api.execute('update_capture',{captureId:'preview',expectedRevision:1,
    candidates:[{id:'module',title:'One module',canonicalUrl:'https://example.test/work',contentText:'Only the selected module',media:[]}],
    selections:[{candidateId:'module',includeText:true,selectedMediaIds:[]}]},'only-one',f.scope);
  const saved=await f.api.execute('save_capture',{captureId:'preview',expectedRevision:updated.revision},'save-one',f.scope);
  assert.equal(saved.state,'completed');assert.deepEqual(applyPageCaptureSelections(f.commits[0]).map(item=>item.id),['module']);
});

test('all registered adapters and the generic path expose shared capture and completeness operations',async()=>{
 const {capturePlatformGuidance}=await import('../extension/agent-capture-preview.js');
 const {PAGE_CAPTURE_ADAPTERS}=await import('../extension/page-capture-adapter-registry.js');
 for(const adapter of PAGE_CAPTURE_ADAPTERS){
  const facts=capturePlatformGuidance('https://'+adapter.hosts[0]+'/');
  assert.equal(facts.adapter,adapter.id);assert.deepEqual(facts.fields,adapter.fields);
  assert.equal(facts.capabilities.originals.frozen,true);assert.equal(facts.capabilities.save.readback,true);
  assert.equal(facts.capabilities.prepare.selector,true);assert(facts.capabilities.supplements.discover);
 }
 assert.equal(capturePlatformGuidance('https://unknown.test/').capabilities.save.codePreview,true);
});

test('duplicate module supplementation reports its existing id and preserves the failed-update revision',async()=>{
 const f=fixture();await f.api.execute('prepare_capture',{tabId:1},'preview',f.scope);
 f.options.chromeApi.scripting.executeScript=async()=>[{result:{ok:true,url:'https://example.test/work',selector:'pre',text:'.button { color:red; }',format:'code'}}];
 const source=await f.api.read({captureId:'preview',part:'source',selector:'pre'});
 const selected=await f.api.execute('update_capture',{captureId:'preview',expectedRevision:source.revision,
 candidates:[{id:'original',title:'Original',canonicalUrl:'https://example.test/work',contentText:'',media:[],textSources:[{selector:'pre',target:'text'}]}]},'source-bind',f.scope);
 assert.equal(selected.candidates[0].contentRole,'code_case');
 await assert.rejects(f.api.execute('update_capture',{captureId:'preview',expectedRevision:selected.revision,
  candidates:[{id:'original-final',title:'Original',canonicalUrl:'https://example.test/work',contentText:'',media:[],codePreview:{html:'<button>Run</button>'}}]},'append',f.scope),error=>error.code==='capture_candidate_exists' && error.message.includes('original'));
 assert.equal((await f.api.read({captureId:'preview'})).revision,selected.revision);
 assert.equal((await f.api.read({captureId:'preview'})).candidates.length,1);
});
