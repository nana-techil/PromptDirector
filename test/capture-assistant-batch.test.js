import test from 'node:test';
import assert from 'node:assert/strict';
import { runCaptureAssistant } from '../extension/capture-assistant.js';
import { createAgentContextRuntime } from '../extension/agent-runtime-context.js';
import { runComposerToolLoop } from '../extension/composer-tool-loop.js';

test('one native assistant task saves separate previews and accepts all verified source receipts',async()=>{
 let state={},requests=0,created=0;const previews=new Map(),saved=[];
 const durable=createAgentContextRuntime({turnId:'batch-user',load:async()=>state,update:async transform=>{state=transform(state);}});
 const tool=(id,name,args)=>({id,type:'function',function:{name,arguments:JSON.stringify(args)}});
 const batches=[ [tool('plan','declare_task',{mode:'act',goal:'Save two separate code effects',userMessageIds:['batch-user'],contentTypeId:'content:code-case',steps:[{operation:'prepare_capture'},
  {operation:'read_capture',part:'source',selector:'#effect-1'},{operation:'read_capture',part:'source',selector:'#effect-2'},{operation:'update_capture'}, {operation:'save_capture',resultIds:['effect-1','effect-2']}]}),tool('prep-1','prepare_capture',{requestId:'prepare-1',tabId:1})] ];
 for(let i=1;i<=2;i++){
  if(i===2)batches.push([tool('prep-2','prepare_capture',{requestId:'prepare-2',tabId:1})]);
  batches.push([tool('source-'+i,'read_capture',{captureId:'preview-'+i,part:'source',selector:'#effect-'+i})],
   [tool('choose-'+i,'update_capture',{requestId:'choose-'+i,captureId:'preview-'+i,expectedRevision:1,selections:[{candidateId:'effect-'+i,includeText:true,selectedMediaIds:[]}]})],
   [tool('save-'+i,'save_capture',{requestId:'save-'+i,captureId:'preview-'+i,expectedRevision:2,project:'real-project'})]);
 }
 batches.push([]);
 const result=await runCaptureAssistant({tabId:1,sourceUrl:'https://example.test/motion',instruction:'Save separate effects',messages:[{id:'batch-user',role:'user',content:'Save separate effects'}]}, {
  runtime:{aiTaskAssignments:{creativePlanning:{providerId:'deepseek',model:'deepseek-flash'}},aiSettings:{apiKey:'isolated-fixture',consent:true}},sessionRuntime:durable,signal:new AbortController().signal,
  call:async(name,args)=>{
   if(name==='prepare_capture'){
    const id='preview-'+(++created),selector='#effect-'+created;
    const preview={captureId:id,revision:1,state:'preview',tabId:1,sourceUrl:'https://example.test/motion',candidates:[{id:'effect-'+created,codePreviewAvailable:true,textSources:[{selector,totalCharacters:20,completeness:'complete'}]}],selections:[]};previews.set(id,preview);return{state:'completed',result:preview};
   }
   const preview=previews.get(args.captureId);assert(preview,'native tools must bind to the actual per-effect preview');
   if(name==='read_capture')return args.part==='source'?{captureId:args.captureId,selector:args.selector,content:'x'.repeat(20),totalCharacters:20,revision:1,nextOffset:null}:preview;
   if(name==='update_capture'){preview.revision=2;preview.selections=args.selections;return{state:'completed',result:preview};}
   assert.equal(name,'save_capture');assert.equal(args.project,'real-project');preview.state='completed';saved.push(preview.captureId);
   return{state:'completed',result:{ok:true,captureId:preview.captureId,results:[{status:'saved',entryId:'saved-'+created,candidateId:'effect-'+created,originalVerification:{status:'verified',sources:preview.candidates[0].textSources}}]}};
  },
  execute:async(_request,_settings,_images,{toolRuntime})=>{
   const out=await runComposerToolLoop({protocol:'chat_completions',body:{model:'fixture',messages:[{role:'user',content:'Save separate effects'}]},runtime:toolRuntime,request:async()=>{
    assert(requests<batches.length,'all verified cases must finish without an extra model continuation');
    const calls=batches[requests++];return new Response(JSON.stringify({choices:[{message:{role:'assistant',content:calls.length?'':'Saved two effects.',...(calls.length?{tool_calls:calls}:{})}}]}));
   }});return{text:out.content,usage:out.usage};
  }
 });
 assert.equal(result.ok,true,result.message+' '+JSON.stringify(result.diagnostic?.task)+' '+JSON.stringify(result.diagnostic?.toolCalls.map(c=>({name:c.name,result:c.result?.data}))));assert.equal(result.taskState,'completed');assert.deepEqual(saved,['preview-1','preview-2']);
 assert.equal(result.diagnostic.task.pending.length,0);assert.equal(requests,batches.length);
});
