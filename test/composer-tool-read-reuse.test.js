import test from 'node:test';
import assert from 'node:assert/strict';
import { runComposerToolLoop } from '../extension/composer-tool-loop.js';
const read = {name:'read_case',parameters:{type:'object',properties:{caseId:{type:'string'},part:{type:'string'}}}};
const save = {name:'save_skill',parameters:{type:'object',properties:{requestId:{type:'string'}}}};
const call=(id,name,args)=>({id,type:'function',function:{name,arguments:JSON.stringify(args)}});
const response=(calls,content='')=>new Response(JSON.stringify({choices:[{message:{role:'assistant',content,...(calls.length?{tool_calls:calls}:{})},finish_reason:calls.length?'tool_calls':'stop'}]}),{headers:{'content-type':'application/json'}});

test('reviewing an earlier source amid new case reads does not abort a legitimate Skill synthesis',async()=>{
  let requests=0;const reads=[],writes=[];const bodies=[];
  const steps=[ [call('a','read_case',{caseId:'one',part:'original_prompt'})],
    [call('again','read_case',{caseId:'one',part:'original_prompt'}),call('b','read_case',{caseId:'two',part:'original_prompt'})],
    [call('save','save_skill',{requestId:'skill-write'})], [] ];
  const result=await runComposerToolLoop({body:{model:'fixture',messages:[{role:'user',content:'Summarize these cases as a reusable guide'}]},protocol:'chat_completions',
    runtime:{specs:[read,save],execute:async(name,args)=>{
      if(name==='read_case'){reads.push(args.caseId);return{data:{caseId:args.caseId,content:'Full original '+args.caseId,revision:'same',nextOffset:null}};}
      writes.push(args.requestId);return{data:{ok:true,skillId:'saved-guide'}};
    }},request:async body=>{bodies.push(structuredClone(body));return response(steps[requests++],'Guide saved.');}});
  assert.equal(result.content,'Guide saved.');assert.deepEqual(reads,['one','two']);assert.deepEqual(writes,['skill-write']);
  assert.equal(JSON.parse(bodies[2].messages.find(message=>message.tool_call_id==='again').content).content,'Full original one');
});

test('a successful edit invalidates earlier reads so verification sees the new content',async()=>{
  let requests=0,version=0;const observed=[];
  const steps=[[call('before','read_case',{caseId:'one'})],[call('edit','save_skill',{requestId:'change'})],[call('after','read_case',{caseId:'one'})],[]];
  await runComposerToolLoop({body:{model:'fixture',messages:[{role:'user',content:'Edit then verify'}]},protocol:'chat_completions',runtime:{specs:[read,save],execute:async(name)=>{
    if(name==='save_skill'){version++;return{data:{ok:true}};}observed.push(version);return{data:{revision:version,content:'Version '+version}};
  }},request:async()=>response(steps[requests++],'Verified.')});
  assert.deepEqual(observed,[0,1]);
});

test('live workspace reads observe changed views instead of being replaced by an old cached result',async()=>{
  let requests=0,reads=0;const live={name:'read_live_workspace',parameters:{properties:{}}};
  const bodies=[];
  await runComposerToolLoop({body:{model:'fixture',messages:[{role:'user',content:'Inspect the live view'}]},protocol:'chat_completions',runtime:{specs:[live],execute:async()=>({data:{revision:++reads}})},
    request:async body=>{bodies.push(structuredClone(body));return ++requests<3?response([call('live-'+requests,'read_live_workspace',{})]):response([],'Observed.');}});
  assert.equal(reads,2);assert.equal(JSON.parse(bodies[2].messages.find(message=>message.tool_call_id==='live-2').content).revision,2);
});

test('repeated unchanged sources still stop without doing duplicate backend work',async()=>{
  let requests=0,reads=0;
  await assert.rejects(runComposerToolLoop({body:{model:'fixture',messages:[{role:'user',content:'Inspect'}]},protocol:'chat_completions',runtime:{specs:[read],execute:async()=>{reads++;return{data:{content:'same'}};}},
    request:async()=>response([call('repeat-'+(++requests),'read_case',{caseId:'one'})])}),/重复/);
  assert.equal(reads,1);assert.equal(requests,3);
});

test('an actual revision conflict invalidates cached reads and lets the agent obtain the current source',async()=>{
  let requests=0,reads=0;
  const batches=[[call('first','read_case',{caseId:'one'})],[call('stale','read_case',{caseId:'one',expectedRevision:'old'})],[call('fresh','read_case',{caseId:'one'})],[]];
  const bodies=[];
  await runComposerToolLoop({body:{model:'fixture',messages:[{role:'user',content:'Read the current case'}]},protocol:'chat_completions',runtime:{specs:[read],execute:async(_name,args)=>{
    reads++;return{data:args.expectedRevision?{ok:false,code:'case_changed'}:{revision:reads===1?'old':'new',content:'Current source'}};
  }},request:async body=>{bodies.push(structuredClone(body));return response(batches[requests++],'Current source obtained.');}});
  assert.equal(reads,3);assert.equal(JSON.parse(bodies[3].messages.find(message=>message.tool_call_id==='fresh').content).revision,'new');
});

test('repeating the same semantic registration amid new tool facts is idempotent and does not abort work',async()=>{
  const declare={name:'declare_task',parameters:{properties:{}}};let requests=0;const invoked=[];
  const batches=[[call('plan','declare_task',{goal:'Read the sources'}),call('one','read_case',{caseId:'one'})],
    [call('same-plan','declare_task',{goal:'Read the sources'}),call('two','read_case',{caseId:'two'})],[]];
  await runComposerToolLoop({body:{model:'fixture',messages:[{role:'user',content:'Use the sources'}]},protocol:'chat_completions',runtime:{specs:[read,declare],execute:async(name,args)=>{
    invoked.push(name);return{data:{ok:true,...args}};
  }},request:async()=>response(batches[requests++],'Read.')});
  assert.deepEqual(invoked,['declare_task','read_case','read_case']);
});

test('a transient failed read is retried instead of caching failure as permanent source data',async()=>{
  let requests=0,reads=0;
  const batches=[[call('failed','read_case',{caseId:'one'})],[call('retry','read_case',{caseId:'one'})],[]];
  const result=await runComposerToolLoop({body:{model:'fixture',messages:[{role:'user',content:'Read the source'}]},protocol:'chat_completions',runtime:{specs:[read],execute:async()=>({data:++reads===1?{ok:false,code:'temporarily_unavailable'}:{ok:true,content:'Full source'}})},request:async()=>response(batches[requests++],'Read.')});
  assert.equal(reads,2);assert.equal(result.content,'Read.');
});

test('a failed task registration can be reconsidered after actual object facts are read',async()=>{
  const declare={name:'declare_task',parameters:{properties:{}}};let requests=0,known=false;const invoked=[];
  const plan={targetId:'actual-id'};
  const batches=[[call('unresolved','declare_task',plan)], [call('source','read_case',{caseId:'actual-id'})], [call('resolved','declare_task',plan)],[]];
  await runComposerToolLoop({body:{model:'fixture',messages:[{role:'user',content:'Use the source'}]},protocol:'chat_completions',runtime:{specs:[read,declare],execute:async name=>{
    invoked.push(name);if(name==='read_case')known=true;return{data:name==='declare_task'&&!known?{ok:false,code:'task_target_unresolved'}:{ok:true}};
  }},request:async()=>response(batches[requests++],'Read.')});
  assert.deepEqual(invoked,['declare_task','read_case','declare_task']);
});

test('resuming without a reusable read receipt obtains fresh evidence instead of stopping an existing task',async()=>{
  const args={caseId:'one'};let requests=0,reads=0;
  const body={model:'fixture',messages:[{role:'user',content:'Continue the unfinished guide'}]};
  const continuation={protocol:'chat_completions',body,requestCount:1,seen:[[JSON.stringify(['read_case',args]),{requestCount:1}]]};
  await runComposerToolLoop({body,continuation,protocol:'chat_completions',runtime:{specs:[read],execute:async()=>{reads++;return{data:{content:'Full source'}};}},request:async()=>++requests===1?response([call('resumed-read','read_case',args)]):response([],'Read.')});
  assert.equal(reads,1);
});
