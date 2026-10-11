import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolveStageDocument } from '../extension/staged-media.js';
import { runCaptureAssistant } from '../extension/capture-assistant.js';
const runtime = { aiTaskAssignments: { creativePlanning: { providerId: 'deepseek', model: 'deepseek-flash' } }, aiSettings: { apiKey: 'fixture', consent: true } };
test('after a user opens another code dialog a new turn observes the current page before relying on historic tool facts', async () => {
  let observed = false;
  const result = await runCaptureAssistant({ tabId: 1, sourceUrl: 'https://example.test/', instruction: '是的', messages: [{ role: 'user', content: '我打开了源码' }] }, {
    runtime, signal: new AbortController().signal,
    sessionRuntime: { loadContext: async () => [{ name: 'read_capture', data: { content: 'old SpringCard' } }] },
    call: async (name,args) => { assert.equal(name,'read_capture'); assert.equal(args.part,'context'); observed=true; return { part:'context',content: 'current Expanding Search .search { width: 56px; }',nextOffset:null }; },
    execute: async (_request,_settings,_images,{toolRuntime}) => {
      assert.equal(observed,false,'current page content is read only after a semantic action decision');
      const ctx=await toolRuntime.context();
      await toolRuntime.execute('declare_task',{mode:'act',goal:'读取用户已打开的当前源码',userMessageIds:[ctx.currentUserId],steps:[{operation:'read_capture',part:'context'}]});
      const read=await toolRuntime.execute('read_capture',{tabId:1,part:'context'});
      assert(observed,'observe the newly opened dialog without asking for another confirmation');
      assert(read.data.content.includes('current Expanding Search'));
      assert(!toolRuntime.systemInstruction.includes('current Expanding Search'),'page evidence belongs in tool context rather than system instructions');
      return { text:'当前代码已取得' };
    }
  });
  assert.equal(result.ok,true,result.message);
});
test('real side panel senders lacking documentId resolve browser-owned context before registering screenshot bytes', async () => {
  const background = await readFile(new URL('../extension/background.js',import.meta.url),'utf8');
  const branch=background.slice(background.indexOf("    case 'REGISTER_STAGED_MEDIA':"),background.indexOf("    case 'GET_LIBRARY_IDENTITY':"));
  let registered;
  const chrome={runtime:{id:'extension',getURL:path=>'chrome-extension://extension/'+path,getContexts:async()=>[{contextId:'panel-context',contextType:'SIDE_PANEL',documentId:'panel-document',documentUrl:'chrome-extension://extension/collector.html'}]}};
  const stagedMedia={register:async(...args)=>{registered=args;},release:async()=>{}};
  const execute=new (Object.getPrototypeOf(async function(){}).constructor)('message','interaction','chrome','enqueue','stagedMedia','resolveStageDocument','libraryStorage',`switch(message.type){${branch}}`);
  const result=await execute({type:'REGISTER_STAGED_MEDIA',operationId:'upload',assetIds:['screenshot'],localReferenceIds:[]},{sender:{id:'extension',url:chrome.runtime.getURL('collector.html')}},chrome,async f=>f(),stagedMedia, resolveStageDocument,{get:async()=>({})});
  assert.equal(result.ok,true);assert.equal(registered[1],'panel-document');
});

test('a compact historic projection keeps source references and receipts without repeatedly sending old full-page originals', async () => {
  const { captureContextReferences } = await import('../extension/capture-assistant.js');
  const original=[{name:'read_capture',args:{captureId:'old',part:'page'},data:{part:'page',content:'unrelated whole-page introduction'.repeat(10000),totalCharacters:300000,nextOffset:null}},{name:'save_capture',data:{results:[{entryId:'actually-saved'}]}}];
  const projected=captureContextReferences(original);
  assert.equal(projected[0].data.content,undefined); assert.deepEqual(projected[0].data.readAgain,original[0].args);
  assert.equal(projected[0].data.totalCharacters,300000);assert.equal(projected[1].data.results[0].entryId,'actually-saved');
  assert.equal(original[0].data.content,'unrelated whole-page introduction'.repeat(10000));
});
test('stage context resolution rejects web senders, ambiguous panels and another document ownership', async () => {
  const { resolveStageDocument }=await import('../extension/staged-media.js');
  const ctx={contextType:'SIDE_PANEL',documentUrl:'chrome-extension://extension/collector.html',documentId:'one'};
  const chrome={runtime:{id:'extension',getURL:path=>'chrome-extension://extension/'+path,getContexts:async()=>[ctx,{...ctx,documentId:'two'}]}};
  const sender={id:'extension',url:ctx.documentUrl},storage={get:async()=>({stagedMediaWrites:{existing:{documentId:'one'}}})};
  await assert.rejects(resolveStageDocument(chrome,{...sender,url:'https://example.test/'},'new',storage),/插件页面/);
  await assert.rejects(resolveStageDocument(chrome,sender,'new',storage),/无法确认/);
  assert.equal(await resolveStageDocument(chrome,sender,'existing',storage),'one');
});
