import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentCapturePreview } from '../extension/agent-capture-preview.js';
import { applyPageCaptureSelections } from '../extension/page-capture.js';
import { CAPTURE_OPERATION_SPECS } from '../extension/capture-operation-specs.js';
import { validate } from '../extension/case-operation-specs.js';
import { captureInventories, captureScopeProgress } from '../extension/agent-capture-inventory.js';

function fixture() {
  const data = {}, commits = []; let allowed = true, url = 'https://example.test/work', libraryId = 'library-a';
  const storage = { get: async key => ({ [key]: structuredClone(data[key]) }), set: async value => Object.assign(data, structuredClone(value)),
    remove: async keys => { for (const key of keys) delete data[key]; } };
  const scope = { libraryId, assertCurrent: async () => { if (libraryId !== scope.libraryId) throw Object.assign(new Error('changed'), { code: 'library_changed' }); } };
  const options = { storage, chromeApi: { permissions: { contains: async () => allowed },
    tabs: { get: async id => ({ id, url, status: 'complete' }), onUpdated: {addListener() {}, removeListener() {}}, onRemoved: {addListener() {}, removeListener() {}} },
    scripting: { executeScript: async () => [{ result: { ok: true, url, text: 'complete observed page', links: [], media: [] } }] } },
    collect: async () => ({ candidates: [{ id: 'original', title: 'Original', canonicalUrl: url, contentText: 'Full original body',
      articleDocument: { version: 1, blocks: [{ id: 'old-paragraph', kind: 'paragraph', text: 'Full original body', sourceOrder: 0 }] },
      media: [{ id: 'photo', kind: 'image', url: 'https://example.test/photo.png', originalPrompt: 'Exact original prompt' }] }] }),
    commit: async batch => { commits.push(structuredClone(batch)); return { ok: true, results: [{ candidateId: 'original', status: 'saved', entryId: 'saved' }] }; },
    loadState: async () => ({ collections: [] }), getLibraryId: async () => libraryId };
  return { data, commits, options, scope, api: createAgentCapturePreview(options),
    permission: value => { allowed = value; }, navigate: () => { url = 'https://example.test/elsewhere'; }, changeLibrary: () => { libraryId = 'library-b'; } };
}

test('twenty named targets in a large directory are located together without reading unrelated modules or claiming full-site coverage', async () => {
  const f = fixture(); let scans = 0;
  const modules = Array.from({length:153}, (_, i) => ({title:'Effect '+i, selector:'#effect-'+i,
    sources:[{selector:'#effect-'+i+' pre',characters:10,language:'css'}]}));
  f.options.chromeApi.scripting.executeScript = async ({func}) => [{result:func.name==='readCapturePageContext'
    ? (scans++,{ok:true,url:'https://example.test/work',modules}) : {ok:true,url:'https://example.test/work',text:'page',links:[],media:[]}}];
  await f.api.execute('prepare_capture',{tabId:1},'directory',f.scope);
  const targets = modules.filter((_,i)=>i%7===0).slice(0,20);
  const args = {captureId:'directory',part:'modules',moduleTitles:targets.map(m=>m.title),length:12000};
  validate(CAPTURE_OPERATION_SPECS.find(s=>s.name==='read_capture').parameters,args);
  const data = await f.api.read(args);
  assert.deepEqual(data.modules,targets); assert.equal(data.total,20); assert.equal(data.nextOffset,null);
  assert.equal(data.inventoryTotal,153); assert.deepEqual(data.moduleIndices,targets.map(m=>modules.indexOf(m)));
  const records = [{name:'read_capture',args,data}];
  const inventory = captureInventories(records)[0];
  assert.equal(inventory.total,153); assert.equal(inventory.complete,false);
  const progress = captureScopeProgress(records,{captureId:'directory',selectors:targets.map(m=>m.selector),project:'',saveMode:'multiple'});
  assert.equal(progress.valid,true); assert.equal(progress.pending.length,20);
  const all = await f.api.read({captureId:'directory',part:'modules',length:12000});
  const merged = captureInventories([...records,{name:'read_capture',args:{},data:all}])[0];
  assert.equal(merged.total,153); assert(merged.modules.every(m=>modules.includes(m) || modules.some(v=>v.selector===m.selector)));
  assert(targets.every(target=>merged.modules.some(m=>m.selector===target.selector)),'unfiltered pages must not overwrite distant filtered matches at the wrong positions');
  assert.equal(scans,1,'name selection and later paging reuse the same frozen directory');
  assert.equal(f.data['agentCapture:directory'].moduleInventoryReadEnd,all.modules.length,'a filtered lookup is not a contiguous full-directory read');
});

test('named module lookup preserves duplicate titles, missing names and filtered pagination identities', async () => {
  const f=fixture();
  const modules=[{title:'Shared name',selector:'#one',sources:[]},{title:'Other',selector:'#other',sources:[]},{title:'Shared name',selector:'#two',sources:[]}];
  f.options.chromeApi.scripting.executeScript=async({func})=>[{result:func.name==='readCapturePageContext'
    ? {ok:true,url:'https://example.test/work',modules} : {ok:true,url:'https://example.test/work',text:'page'}}];
  await f.api.execute('prepare_capture',{tabId:1},'directory',f.scope);
  const args={captureId:'directory',part:'modules',moduleTitles:[' shared   NAME ','Missing'],length:JSON.stringify([modules[0]]).length};
  const first=await f.api.read(args);
  assert.equal(first.nextOffset,1); assert.deepEqual(first.moduleIndices,[0]); assert.deepEqual(first.unmatchedTitles,['Missing']);
  const second=await f.api.read({...args,offset:first.nextOffset,expectedRevision:first.revision});
  assert.deepEqual(second.moduleIndices,[2]); assert.equal(second.nextOffset,null); assert.equal(second.total,2);
  const empty=await f.api.read({...args,moduleTitles:['Not here']});
  assert.deepEqual(empty.modules,[]); assert.deepEqual(empty.unmatchedTitles,['Not here']); assert.equal(empty.total,0);
});

test('a mixed batch of twenty source regions uses spare capacity instead of truncating long sources to an equal share', async () => {
  const f=fixture();await f.api.execute('prepare_capture',{tabId:1},'preview',f.scope);
  const sources=Array.from({length:20},(_,i)=>({ok:true,selector:'#source-'+i,text:String(i).repeat(i===19?500:10),format:'code',url:'https://example.test/work'}));
  f.options.chromeApi.scripting.executeScript=async()=>[{result:{ok:true,url:'https://example.test/work',sources}}];
  const size=sources.reduce((sum,source)=>sum+source.text.length,0);
  const args={captureId:'preview',part:'source',selectors:sources.map(s=>s.selector)};
  const read=await f.api.read({...args,length:size});
  assert.deepEqual(read.sources.map(s=>s.content),sources.map(s=>s.text));
  assert(read.sources.every(s=>s.nextOffset===null));
  const partial=await f.api.read({...args,length:100});
  assert.equal(partial.sources.reduce((sum,s)=>sum+s.content.length,0),100);
  assert(partial.sources.some(s=>s.nextOffset!==null));
  assert(sources.every(s=>f.data['agentCapture:preview'].sources[s.selector].text===s.text),'understanding pagination never truncates stored originals');
});

test('new batches reuse the same exact webpage without opening or focusing another tab', async () => {
  const f = fixture(); const url = 'https://example.test/work';
  f.options.chromeApi.tabs.query = async () => [{ id: 8, url, active: false }, { id: 9, url, active: true }, { id: 10, url: url + '#other', active: true }];
  f.options.chromeApi.tabs.create = async () => assert.fail('an existing source must not open again');
  for (const id of ['batch-one', 'batch-two']) {
    const result = await f.api.execute('prepare_capture', { url }, id, f.scope);
    assert.equal(result.tabId, 9);
  }
  assert.equal((await f.api.execute('prepare_capture', { url, preferredTabId: 8 }, 'pinned-batch', f.scope)).tabId, 8,
    'an active same-URL tab must not replace the running task source');
  assert.equal((await f.api.execute('prepare_capture', { url, preferredTabId: 10 }, 'navigated-source', f.scope)).tabId, 9,
    'a preferred tab which navigated away must not be read as the original page');
});

test('a closed source opens once while a different URL is never retargeted', async () => {
  const f = fixture(); const url = 'https://example.test/work'; const created = [];
  f.options.chromeApi.tabs.query = async () => [{ id: 8, url: url + '/elsewhere' }];
  f.options.chromeApi.tabs.create = async input => { created.push(input); return { id: 9 }; };
  assert.equal((await f.api.execute('prepare_capture', { url }, 'reopened', f.scope)).tabId, 9);
  assert.deepEqual(created, [{ url, active: false }]);
});

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
  assert.equal(read.revision,1);assert(read.sources.every(source=>source.content.length===1&&source.nextOffset===1));
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

test('a code module directory larger than a live-scene message is frozen and fully traversable without an arbitrary scope rejection',async()=>{
 const f=fixture();let inventoryReads=0;
 const modules=Array.from({length:153},(_,i)=>({title:'Effect '+i,selector:'body > main > section > div > div:nth-of-type('+(i+1)+')',sources:[0,1,2].map(j=>({selector:'body > main > section > div > div:nth-of-type('+(i+1)+') > div > div > pre:nth-of-type('+(j+1)+')',language:['css','react','prompt'][j],characters:100}))}));
 assert(JSON.stringify(modules).length>49152);
 f.options.chromeApi.scripting.executeScript=async({func})=>[{result:func.name==='readCapturePageContext'?(inventoryReads++,{ok:true,url:'https://example.test/work',title:'Effects',codeBlocks:[],textModules:[],modules}):{ok:true,url:'https://example.test/work',text:'Observed page',links:[],media:[]}}];
 await f.api.execute('prepare_capture',{tabId:1},'large-directory',f.scope);
 const scene=JSON.parse((await f.api.read({captureId:'large-directory',part:'context',includeHidden:true})).content);
 assert.equal(scene.moduleCount,153);assert.equal(scene.moduleDirectory.part,'modules');
 let offset=0,revision,all=[];
 do {
  const page=await f.api.read({captureId:'large-directory',part:'modules',offset,length:12000,...(revision?{expectedRevision:revision}:{})});
  assert(page.modules.length>0);assert(JSON.stringify(page.modules).length<=12000);
  all.push(...page.modules);offset=page.nextOffset;revision=page.revision;
 }while(offset!==null);
 assert.deepEqual(all,modules);
 assert.equal(inventoryReads,2,'one live scene and one frozen directory snapshot; pagination must not rescan the page');
});

test('a page selector is not silently ignored and cannot make a whole-page result look like a targeted module read',async()=>{
 const f=fixture();await f.api.execute('prepare_capture',{tabId:1},'selector-scope',f.scope);
 await assert.rejects(f.api.read({captureId:'selector-scope',part:'page',selector:'#target'}),{code:'invalid_input'});
});

test('an unfinished frozen directory survives preview saves and automatic history cleanup without confusing selection revisions',async()=>{
 const f=fixture();const api=createAgentCapturePreview({...f.options,budget:{maxAutomaticHistoryItems:2}});
 const modules=Array.from({length:12},(_,i)=>({title:'Module '+i,selector:'#module-'+i,sources:[{selector:'#module-'+i+' pre',characters:10,language:'css'}]}));
 f.options.chromeApi.scripting.executeScript=async({func})=>[{result:func.name==='readCapturePageContext'?{ok:true,url:'https://example.test/work',modules,codeBlocks:[],textModules:[]}:{ok:true,url:'https://example.test/work',text:'page',links:[],media:[]}}];
 async function save(id){
  const preview=await api.read({captureId:id});
  const chosen=await api.execute('update_capture',{captureId:id,expectedRevision:preview.revision,selections:[{candidateId:'original',includeText:true,selectedMediaIds:[]}]},'select-'+id,f.scope);
  return api.execute('save_capture',{captureId:id,expectedRevision:chosen.revision},'save-'+id,f.scope);
 }
 await api.execute('prepare_capture',{tabId:1},'directory-parent',f.scope);
 const first=await api.read({captureId:'directory-parent',part:'modules',length:250});assert(first.nextOffset!==null);
 const saved=await save('directory-parent');assert(saved.revision>first.captureRevision);
 for(const id of ['other-1','other-2','other-3']){await api.execute('prepare_capture',{tabId:1},id,f.scope);await save(id);}
 assert(f.data['agentCapture:directory-parent'],'an unread directory is unfinished work, even when its first case was saved');
 const rest=await api.read({captureId:'directory-parent',part:'modules',offset:first.nextOffset,expectedRevision:first.revision,length:12000});
 assert.equal(rest.revision,first.revision);assert.equal(rest.captureRevision,saved.revision);assert.equal(rest.nextOffset,null);
 assert.equal(first.modules.length+rest.modules.length,12);
});

test('a source-scoped candidate can be retitled when adding its interactive preview',async()=>{
 const f=fixture();await f.api.execute('prepare_capture',{tabId:1},'preview',f.scope);
 const source=await f.api.read({captureId:'preview',part:'source',selector:'#module'});
 let result=await f.api.execute('update_capture',{captureId:'preview',expectedRevision:source.revision,candidates:[{id:'module',title:'Effect',canonicalUrl:'https://example.test/work',textSources:[{selector:'#module',target:'text'}]}]},'module',f.scope);
 result=await f.api.execute('update_capture',{captureId:'preview',expectedRevision:result.revision,candidates:[{id:'module',title:'Effect — interactive',canonicalUrl:'https://example.test/work',textSources:[{selector:'#module',target:'text'}],codePreview:{html:'<button>Effect</button>'}}]},'preview-added',f.scope);
 assert.equal(result.candidates.find(c=>c.id==='module').title,'Effect — interactive');
});

test('real code capture cannot report success while a model paraphrases frozen original sources',async()=>{
 const f=fixture();await f.api.execute('prepare_capture',{tabId:1},'preview',f.scope);
 const source=await f.api.read({captureId:'preview',part:'source',selector:'#module'});
 const patch={id:'module',title:'Module',canonicalUrl:'https://example.test/work',contentText:'A model paraphrase instead of the frozen source',codePreview:{html:'<button>Effect</button>'}};
 await assert.rejects(f.api.execute('update_capture',{captureId:'preview',expectedRevision:source.revision,candidates:[patch]},'paraphrased',f.scope),{code:'capture_source_required'});
 assert.equal(f.commits.length,0);
 const updated=await f.api.execute('update_capture',{captureId:'preview',expectedRevision:source.revision,candidates:[{...patch,textSources:[{selector:'#module',target:'text'}]}]},'bound',f.scope);
 const result=await f.api.read({captureId:'preview',part:'candidate',candidateId:'module',expectedRevision:updated.revision});
 assert(JSON.parse(result.content).contentText.includes(source.content));
 assert(!JSON.parse(result.content).contentText.includes(patch.contentText));
});

test('independent source reads in one model call do not invalidate each other; changed originals still invalidate stale writes', async () => {
  const f = fixture();
  await f.api.execute('prepare_capture', { tabId: 1 }, 'preview', f.scope);
  let suffix = 'original';
  f.options.chromeApi.scripting.executeScript = async ({ args }) => [{ result: {
    ok: true, url: 'https://example.test/work', selector: args[0], text: args[0] + suffix, completeness: 'complete'
  } }];
  for (const selector of ['#first', '#second', '#third']) {
    const source = await f.api.read({ captureId: 'preview', part: 'source', selector, expectedRevision: 1 });
    assert.equal(source.revision, 1, 'caching another source is not a preview edit');
  }
  suffix = 'changed';
  const changed = await f.api.read({ captureId: 'preview', part: 'source', selector: '#first', expectedRevision: 1 });
  assert.equal(changed.revision, 2, 'replacing a previously observed original requires a fresh write revision');
  await assert.rejects(f.api.execute('update_capture', { captureId: 'preview', expectedRevision: 1, selections: selected }, 'stale', f.scope), { code: 'capture_changed' });
  assert.equal((await f.api.read({ captureId: 'preview', part: 'source', selector: '#third', expectedRevision: 2, offset: 1 })).content, '#thirdoriginal'.slice(1));
});

test('reading more sources after saving exposes the read-only batch before an agent attempts another edit', async () => {
  const f = fixture();
  await f.api.execute('prepare_capture', { tabId: 1 }, 'preview', f.scope);
  f.options.chromeApi.scripting.executeScript = async ({ func }) => [{ result: func.name === 'readCapturePageContext'
    ? { ok: true, url: 'https://example.test/work', modules: [{ selector: '#next', sources: [] }] }
    : { ok: true, url: 'https://example.test/work', selector: 'pre', text: 'next module original', format: 'code' } }];
  const before = await f.api.read({ captureId: 'preview', part: 'source', selector: 'pre' });
  assert.equal(before.state, 'preview'); assert.equal(before.readOnly, false);
  const selected = await f.api.execute('update_capture', { captureId: 'preview', expectedRevision: before.revision,
    selections: [{ candidateId: 'original', includeText: true, selectedMediaIds: [] }] }, 'select', f.scope);
  await f.api.execute('save_capture', { captureId: 'preview', expectedRevision: selected.revision }, 'save', f.scope);
  for (const args of [{ part: 'source', selector: 'pre' }, { part: 'source', selectors: ['pre'] }, { part: 'modules' }, { part: 'page' }]) {
    const read = await f.api.read({ captureId: 'preview', ...args });
    assert.equal(read.state, 'completed'); assert.equal(read.readOnly, true);
  }
  assert.equal(f.commits.length, 1, 'reading next sources must not save or reopen the old transaction');
});
