import test from 'node:test';
import assert from 'node:assert/strict';
import { runCaptureAssistant } from '../extension/capture-assistant.js';
import { createAgentContextRuntime } from '../extension/agent-runtime-context.js';
import { runComposerToolLoop } from '../extension/composer-tool-loop.js';

for (const interrupted of [false,true]) for (const lastDuplicate of [false,true]) test(`separate batch receipts retain earlier saves when the last item is ${lastDuplicate?'already present':'new'} and completion is ${interrupted?'interrupted':'normal'}`,async()=>{
 let state={},requests=0,created=0;const previews=new Map(),saved=[];
 const durable=createAgentContextRuntime({turnId:'batch-user',load:async()=>state,update:async transform=>{state=transform(state);}});
 const tool=(id,name,args)=>({id,type:'function',function:{name,arguments:JSON.stringify(args)}});
 const batches=[ [tool('plan','declare_task',{mode:'act',goal:'Save two separate code effects',contentTypeId:'content:code-case',steps:[{operation:'prepare_capture'},
  {operation:'read_capture',part:'modules',requireComplete:true},{operation:'read_capture',part:'source',selector:'#effect-1'},{operation:'read_capture',part:'source',selector:'#effect-2'},{operation:'update_capture'}, {operation:'save_capture',resultIds:['effect-1','effect-2']}]}),tool('prep-1','prepare_capture',{requestId:'prepare-1',tabId:1})] ];
 batches.push([tool('directory-first','read_capture',{captureId:'preview-1',part:'modules',offset:0})]);
 for(let i=1;i<=2;i++){
  if(i===2)batches.push([tool('prep-2','prepare_capture',{requestId:'prepare-2',tabId:1})],[tool('directory-rest','read_capture',{captureId:'preview-1',part:'modules',offset:1,expectedRevision:5})]);
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
   const preview=previews.get(args.captureId);
   if(name==='read_capture'&&args.part==='modules')return{ok:true,part:'modules',captureId:args.captureId,revision:5,captureRevision:preview.revision,offset:args.offset,total:2,modules:[{title:'Effect '+(args.offset+1)}],nextOffset:args.offset===0?1:null};
   assert(preview,'native tools must bind to the actual per-effect preview');
   if(name==='read_capture')return args.part==='source'?{captureId:args.captureId,selector:args.selector,content:'x'.repeat(20),totalCharacters:20,revision:1,nextOffset:null}:preview;
   if(name==='update_capture'){preview.revision=2;preview.selections=args.selections;return{state:'completed',result:preview};}
   assert.equal(name,'save_capture');assert.equal(args.project,'real-project');preview.state='completed';saved.push(preview.captureId);
   return{state:'completed',result:{ok:true,captureId:preview.captureId,message:lastDuplicate&&created===2?'已保存 0 项，跳过 1 项重复内容':'已保存 1 项',results:[{status:lastDuplicate&&created===2?'duplicate':'saved',entryId:'saved-'+created,candidateId:'effect-'+created,originalVerification:{status:'verified',sources:preview.candidates[0].textSources}}]}};
  },
  execute:async(_request,_settings,_images,{toolRuntime})=>{
   const out=await runComposerToolLoop({protocol:'chat_completions',body:{model:'fixture',messages:[{role:'user',content:'Save separate effects'}]},runtime:toolRuntime,request:async()=>{
    assert(requests<batches.length,'all verified cases must finish without an extra model continuation');
    const calls=batches[requests++];if(interrupted&&!calls.length)throw new Error('provider interrupted after saving');return new Response(JSON.stringify({choices:[{message:{role:'assistant',content:calls.length?'':'Saved two effects.',...(calls.length?{tool_calls:calls}:{})}}]}));
   }});return{text:out.content,usage:out.usage};
  }
 });
 assert.equal(result.ok,!interrupted,result.message);assert.deepEqual(saved,['preview-1','preview-2']);
 assert.equal(result.saveResult.results.length,2);assert.equal(result.saveResult.results[0].status,'saved');assert.equal(requests,batches.length);
 assert.equal(result.saveResult.message,lastDuplicate?'已保存 1 项，已有 1 项。':'已保存 2 项，已有 0 项。','the whole-turn receipt must not repeat only the last batch count');
 if(interrupted)assert.match(result.message,/provider interrupted/);
 else {assert.equal(result.taskState,'completed');assert.equal(result.text,lastDuplicate?'已保存 1 项，已有 1 项。':'已保存 2 项，已有 0 项。');assert.equal(result.diagnostic.task.pending.length,0);}
});
