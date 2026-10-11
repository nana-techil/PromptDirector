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

test('a saved code preview does not prove that the effect was actually run', () => {
  const edit={name:'edit_case',args:{patch:{codePreview:{html:'<button>Run</button>'}}},result:{data:{ok:true}}};
  assert(captureCompletionCheck('Yes, it is saved — and the effect now works.',[edit],null,null));
  assert.equal(captureCompletionCheck('交互预览已保存，请打开案例查看。',[edit],null,null),undefined);
});

test('the first frozen X-comment correction reaches the strict provider and selects the full source without an empty tool_calls array', async()=>{
  const {runComposerToolLoop}=await import('../extension/composer-tool-loop.js');
  const f=fixture();let requests=0;const wire=[];
  const sse=message=>new Response('data: '+JSON.stringify({choices:[{delta:message,finish_reason:message.tool_calls?'tool_calls':'stop'}]})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
  const tool=(name,args)=>sse({tool_calls:[{index:0,id:'call-'+requests,type:'function',function:{name,arguments:JSON.stringify(args)}}]});
  const result=await runCaptureAssistant({tabId:1,sourceUrl:f.url,instruction:'采集评论提示词',locale:'zh-CN'}, {
    runtime:{aiTaskAssignments:{creativePlanning:{providerId:'deepseek',model:'deepseek-flash'}},aiSettings:{apiKey:'fixture',consent:true}},signal:new AbortController().signal,
    call:async (name,args)=>['prepare_capture','update_capture','save_capture'].includes(name)
      ?{state:'completed',result:await f.api.execute(name,args,args.requestId,f.scope)}:await f.api.read(args),
    execute:async (_request,_settings,_images,{toolRuntime})=>{
      const response=await runComposerToolLoop({body:{model:'deepseek-flash',messages:[{role:'user',content:'采集评论提示词'}]},protocol:'chat_completions',runtime:toolRuntime,
        request:async body=>{
          wire.push(structuredClone(body));requests++;
          for(const message of body.messages) if(Object.hasOwn(message,'tool_calls'))assert(message.tool_calls.length>0,'first X-comment correction must satisfy the provider schema');
          const outputs=body.messages.filter(message=>message.role==='tool').map(message=>JSON.parse(message.content));
          const current=outputs.at(-1);
          if(requests===1)return tool('prepare_capture',{tabId:1});
          if(requests===2)return tool('read_capture',{captureId:current.captureId,expectedRevision:current.revision,part:'source',selector:'#comment'});
          if(requests===3)return sse({content:'完整提示词已选中。'});
          if(requests===4){assert(body.messages.at(-1).content.includes('textSources'));return tool('update_capture',{requestId:'select',captureId:current.captureId,expectedRevision:current.revision,
            candidates:[{id:'post',title:'Post',canonicalUrl:f.url,media:[],textSources:[{selector:'#comment',target:'prompt'}]}],selections:[{candidateId:'post',includeText:true,selectedMediaIds:[]}]});}
          return sse({content:'已取得评论全文，预览中可查看。'});
        }});
      return {text:response.content};
    }});
  assert(result.ok,result.message);assert.equal(requests,5);assert.equal(wire[3].messages.at(-2).content,'完整提示词已选中。');
  assert((await f.api.view({captureId:result.captureId})).batch.candidates[0].contentText.includes('FINAL ORIGINAL WORDS'));
  assert.equal(f.commits.length,0,'collect-only authorization must not silently save');
});

test('a first code-case save includes the interactive preview, frozen originals and current natural-language type choice', async()=>{
  const f=fixture();const commits=[];const html='<button onclick="this.textContent=\'Active\'">Tab</button>';
  const api=createAgentCapturePreview({...f.options,commit:async(batch,metadata)=>{commits.push({batch,metadata});return {ok:true,results:[{candidateId:'post',entryId:'code-saved',status:'saved'}]};}});
  const result=await runCaptureAssistant({tabId:1,sourceUrl:f.url,instruction:'存一下这个代码案例',locale:'en',captureMetadata:{contentTypeId:'content:prompt:video',contentTypeExplicit:true}}, {
    runtime:{aiTaskAssignments:{creativePlanning:{providerId:'deepseek',model:'deepseek-flash'}},aiSettings:{apiKey:'fixture',consent:true}},signal:new AbortController().signal,
    call:async(name,args)=>['prepare_capture','update_capture','save_capture'].includes(name)?{state:'completed',result:await api.execute(name,args,args.requestId,f.scope)}:await api.read(args),
    execute:async(_req,_settings,_images,{toolRuntime})=>{
      const prepared=(await toolRuntime.execute('prepare_capture',{tabId:1})).data;
      const source=(await toolRuntime.execute('read_capture',{captureId:prepared.captureId,part:'source',selector:'#comment'})).data;
      const updated=(await toolRuntime.execute('update_capture',{captureId:prepared.captureId,expectedRevision:source.revision,
        candidates:[{id:'post',title:'Code demo',canonicalUrl:f.url,codePreview:{html},textSources:[{selector:'#comment',target:'text'}],media:[]}],selections:[{candidateId:'post',includeText:true,selectedMediaIds:[]}]})).data;
      assert.equal(updated.candidates[0].codePreviewAvailable,true);
      const saved=(await toolRuntime.execute('save_capture',{captureId:prepared.captureId,expectedRevision:updated.revision})).data;
      assert.equal(saved.results[0].entryId,'code-saved');return {text:'已保存。'};
    }});
  assert.equal(result.outcome,'saved');assert.equal(result.text,'已保存。');assert.equal(commits.length,1);
  assert.equal(commits[0].metadata.contentTypeId,'content:code-case');
  assert(commits[0].batch.candidates[0].contentText.includes(html));assert(commits[0].batch.candidates[0].contentText.includes(f.original));
});
