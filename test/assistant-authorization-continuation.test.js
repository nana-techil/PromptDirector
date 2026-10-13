import test from 'node:test';
import assert from 'node:assert/strict';
import { withAssistantTaskRuntime } from '../extension/assistant-task.js';
import { createAgentContextRuntime } from '../extension/agent-runtime-context.js';
import { runComposerToolLoop } from '../extension/composer-tool-loop.js';

function setup() {
 let state={toolContext:[]};
 const durable=createAgentContextRuntime({turnId:'transport-request',load:async()=>state,update:async transform=>{state=transform(state);}});
 const runtime=withAssistantTaskRuntime({...durable,specs:[{name:'save_capture',parameters:{properties:{requestId:{}}}}],execute:async()=>({data:{ok:true,entryId:'actual-case'}})},
  {messages:[{id:'original-user',role:'user',content:'Save all the selected effects'},{role:'assistant',content:'Which scope?'},{id:'confirming-user',role:'user',content:'The full set, in batches'}],instruction:'The full set, in batches',userMessageId:'confirming-user'});
 return{runtime,state:()=>state};
}
test('the host binds the real confirming user message without making the model copy an authorization UUID',async()=>{
 const f=setup();await f.runtime.loadContext();
 const result=await f.runtime.execute('declare_task',{mode:'act',goal:'Save the originally requested effects in batches',userMessageIndices:[0],steps:[{operation:'save_capture'}]});
 assert.equal(result.data.ok,true);
 assert.deepEqual(f.runtime.task.userMessageIds,['original-user','confirming-user']);
 assert(!Object.hasOwn(f.runtime.specs.find(s=>s.name==='declare_task').parameters.properties,'userMessageIds'));
 await f.runtime.execute('save_capture',{requestId:'actual-save'},{callId:'save'});
 await f.runtime.finishTurn({content:'Saved.'});assert.equal(f.runtime.task.state,'completed');
});
test('a semantic action can use the current human instruction with no historical reference field',async()=>{
 const f=setup();await f.runtime.loadContext();
 assert.equal((await f.runtime.execute('declare_task',{mode:'act',goal:'Execute the requested save',steps:[{operation:'save_capture'}]})).data.ok,true);
 assert.deepEqual(f.runtime.task.userMessageIds,['confirming-user']);
});
test('references can select only actual human messages, never webpage or assistant text',async()=>{
 const f=setup();await f.runtime.loadContext();
 assert.equal((await f.runtime.execute('declare_task',{mode:'act',goal:'Unauthorized expansion',userMessageIndices:[99],steps:[{operation:'save_capture'}]})).data.ok,false);
});
test('rephrasing the same failed registration without new facts stops before a costly authorization loop',async()=>{
 let requests=0;
 const runtime={specs:[{name:'declare_task',parameters:{properties:{}}}],execute:async()=>({data:{ok:false,code:'task_authority_missing',message:'Invalid reference'}})};
 await assert.rejects(runComposerToolLoop({body:{model:'fixture',messages:[{role:'user',content:'Save the requested items'}]},protocol:'chat_completions',runtime,budget:{maxRequests:5},request:async()=>{
  requests++;return new Response(JSON.stringify({choices:[{message:{role:'assistant',tool_calls:[{id:'attempt-'+requests,type:'function',function:{name:'declare_task',arguments:JSON.stringify({goal:'Changed wording '+requests,userMessageIds:['mistyped-'+requests]})}}]}}]}));
 }}),{code:'AGENT_NO_PROGRESS'});
 assert.equal(requests,2);
});

test('discovery establishes targets and an authorized simple write needs no extra plan',async()=>{
 let writes=0;
 const runtime=withAssistantTaskRuntime({specs:[{name:'read_target',parameters:{properties:{}}},{name:'save_capture',parameters:{properties:{requestId:{}}}}],
  execute:async(name)=>{if(name==='save_capture')writes++;return{data:{ok:true,captureId:'actual-preview'}};}},
  {instruction:'Inspect and save the selected module',userMessageId:'real-user'});
 assert.equal((await runtime.execute('read_target',{}, {callId:'discover'})).data.captureId,'actual-preview');
 assert.equal(writes,0);
 assert.equal((await runtime.execute('declare_task',{mode:'act',goal:'Save the actual module',steps:[{operation:'save_capture',targetId:'actual-preview'}]})).data.ok,true);
 assert.equal((await runtime.execute('save_capture',{requestId:'actual-write',captureId:'actual-preview'},{callId:'write'})).data.ok,true);assert.equal(writes,1);
});

test('a resolved read error cannot be reused to abandon an authorized save',async()=>{
 let reads=0;
 const runtime=withAssistantTaskRuntime({specs:[{name:'read_target',parameters:{properties:{}}},{name:'save_capture',parameters:{properties:{requestId:{}}}}],execute:async()=>
  ({data:++reads===1?{ok:false,code:'temporarily_unavailable'}:{ok:true,captureId:'actual'}})}, {instruction:'Save the requested content',userMessageId:'user'});
 await runtime.execute('declare_task',{mode:'act',goal:'Save content',steps:[{operation:'read_target'},{operation:'save_capture'}]});
 await runtime.execute('read_target',{selector:'#target'},{callId:'failed'});
 await runtime.execute('read_target',{selector:'#target',refresh:true},{callId:'recovered'});
 assert.equal((await runtime.execute('settle_task',{state:'blocked',failedCallId:'failed',reason:'The source is unavailable'})).data.code,'task_blocker_resolved');
 assert.equal(runtime.task.state,'active');assert(runtime.task.pending.some(step=>step.operation==='save_capture'));
});

test('paged module discovery is complete only after every item range has been observed',async()=>{
 const runtime=withAssistantTaskRuntime({specs:[{name:'read_capture',parameters:{properties:{}}}],execute:async(_name,args)=>({data:{ok:true,revision:'frozen',offset:args.offset,total:4,nextOffset:args.offset===0?2:null,modules:args.offset===0?[{title:'A'},{title:'B'}]:[{title:'C'},{title:'D'}]}})},
  {instruction:'Read the entire module directory',userMessageId:'user'});
 await runtime.execute('declare_task',{mode:'act',goal:'Read all modules',steps:[{operation:'read_capture',part:'modules',requireComplete:true}]});
 await runtime.execute('read_capture',{part:'modules',offset:2},{callId:'last-page'});
 assert.equal(runtime.task.pending.length,1,'the last page cannot stand in for the entire directory');
 await runtime.execute('read_capture',{part:'modules',offset:0},{callId:'first-page'});
 assert.equal(runtime.task.pending.length,0);
});

test('a new human reply sees the unfinished action, while a later completed action does not resurrect old waits',async()=>{
 let state={toolContext:[{turnId:'old-request',name:'assistant_task_state',callId:'old-task',args:{},data:{currentUserId:'old-user',mode:'act',state:'waiting',goal:'Save selected modules',steps:[{operation:'save_capture'}],pending:[{operation:'save_capture'}]}}]};
 const make=uid=>withAssistantTaskRuntime({...createAgentContextRuntime({turnId:'request-'+uid,load:async()=>state,update:async transform=>{state=transform(state);}}),specs:[{name:'save_capture',parameters:{properties:{requestId:{}}}}],execute:async()=>({data:{ok:true}})},
  {instruction:uid,userMessageId:uid});
 const resumed=make('confirmation');await resumed.loadContext();assert.equal((await resumed.context()).continuingTask.goal,'Save selected modules');
 await resumed.execute('declare_task',{mode:'act',goal:'Save selected modules',steps:[{operation:'save_capture'}]});
 await resumed.execute('save_capture',{requestId:'save'},{callId:'saved'});await resumed.finishTurn({content:'Saved.'});
 const later=make('next-user');await later.loadContext();assert.equal((await later.context()).continuingTask,undefined);
});
