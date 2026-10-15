import test from 'node:test';
import assert from 'node:assert/strict';
import { withAssistantTaskRuntime } from '../extension/assistant-task.js';
import { createAgentContextRuntime } from '../extension/agent-runtime-context.js';
import { DEFAULT_AGENT_INSTRUCTION_EN } from '../extension/composer-agent.js';

function fixture({ turnId = 'user-1', state = { toolContext: [] }, execute } = {}) {
  const calls = [];
  const durable = createAgentContextRuntime({ turnId, load: async () => state, update: async transform => Object.assign(state, transform(state)) });
  const runtime = withAssistantTaskRuntime({ ...durable, specs: [
    { name: 'edit_case', parameters: { properties: { requestId: {} } } },
    { name: 'read_case', parameters: { properties: {} } },
    { name: 'save_capture', parameters: { properties: { requestId: {} } } }
  ], execute: async (name, args, ctx) => {
    calls.push({ name, args });
    const result = { data: await execute?.(name, args) || { ok: true, caseId: args.caseId } };
    await durable.recordToolResult({ name, args, data: result.data, callId: ctx.callId });
    return result;
  } }, { messages: [{ id: turnId, role: 'user', content: 'current instruction' }], instruction: 'current instruction', context: {cases:['case','chosen-case','chosen','first','second'].map(id=>({id}))} });
  const declare = (steps, extra = {}) => runtime.execute('declare_task', { mode: 'act', goal: 'current goal', steps, ...extra });
  return { runtime, calls, state, declare };
}

test('a created material is complete for its actual source targets without replaying the committed save',async()=>{
  const record=[];
  const runtime=withAssistantTaskRuntime({specs:[{name:'save_material',parameters:{properties:{requestId:{}}}}],execute:async(name,args)=>{record.push(name);return{data:{ok:true,results:[{status:'saved',entryId:'new-output',sourceCaseIds:args.sourceCaseIds}]}};}},
    {instruction:'Save this work',userMessageId:'new-user',context:{cases:[{id:'source-case'}]}});
  await runtime.execute('declare_task',{mode:'act',goal:'Save new material based on selected source',steps:[{operation:'save_material',targetId:'source-case',resultIds:['source-case']}]});
  await runtime.execute('save_material',{requestId:'once',sourceCaseIds:['source-case']},{callId:'saved'});
  assert.equal(await runtime.finishTurn({}),undefined);assert.equal(runtime.task.state,'completed');assert.deepEqual(record,['save_material']);
});

test('one committed operation at the token budget cannot prove an entire user goal complete',async()=>{
  for(const saved of [true,false]) {
    const f=fixture({execute:()=>({results:[{status:saved?'saved':'failed',entryId:'case'}]})});let requests=0;
    const action=runComposerToolLoop({protocol:'chat_completions',runtime:f.runtime,budget:{maxTotalTokens:10},body:{model:'fixture',messages:[{role:'user',content:'current instruction'}]},request:async()=>{
      requests++;
      return new Response(JSON.stringify({choices:[{message:{role:'assistant',tool_calls:[
        {id:'plan',type:'function',function:{name:'declare_task',arguments:JSON.stringify({mode:'act',goal:'Save this result',steps:[{operation:'save_capture'}]})}},
        {id:'save',type:'function',function:{name:'save_capture',arguments:'{}'}}]},finish_reason:'tool_calls'}],usage:{prompt_tokens:9,completion_tokens:1,total_tokens:10}}));
    }});
    await assert.rejects(action,{code:'RESOURCE_BUDGET_REACHED'});assert.equal(f.runtime.task.state,'active');
    assert.equal(f.runtime.observations[0].data.results[0].status,saved?'saved':'failed');
    assert.equal(requests,1);assert.equal(f.calls.length,1);
  }
});

test('a declared edit cannot mutate a different case with the same tool', async () => {
  const f = fixture(); await f.declare([{ operation: 'edit_case', targetId: 'chosen-case' }]);
  const denied = await f.runtime.execute('edit_case', { caseId: 'unrelated-case' }, { callId: 'wrong' });
  assert.equal(denied.data.code, 'task_scope_changed'); assert.equal(f.calls.length, 0);
  assert.equal((await f.runtime.finishTurn({})).action, 'continue');
});

test('a complete result for another source part cannot finish the declared full-original read', async () => {
  const f = fixture(); await f.declare([{ operation: 'read_case', targetId: 'chosen-case', part: 'original' }]);
  await f.runtime.execute('read_case', { caseId: 'chosen-case', part: 'overview' }, { callId: 'overview' });
  assert.equal((await f.runtime.finishTurn({})).action, 'continue');
  await f.runtime.execute('read_case', { caseId: 'chosen-case', part: 'original' }, { callId: 'original' });
  assert.equal(await f.runtime.finishTurn({}), undefined); assert.equal(f.runtime.task.state, 'completed');
});

test('paging and partial originals are work in progress even when the tool returns ok', async () => {
  for (const data of [{ ok: true, nextOffset: 64 }, { ok: true, sources: [{ nextOffset: 64 }] },
    { results: [{ status: 'saved', entryId: 'case', originalVerification: { status: 'partial' } }] },
    { codePreviewVerification: { status: 'missing' } }]) {
    const f = fixture({ execute: () => data }); await f.declare([{ operation: 'save_capture' }]);
    await f.runtime.execute('save_capture', {}, { callId: 'partial' });
    assert.equal((await f.runtime.finishTurn({})).action, 'continue');
  }
});

test('same-turn resume restores actual save receipts rather than requiring a second write', async () => {
  const f = fixture({ execute: () => ({ results: [{ status: 'saved', entryId: 'saved-case' }] }) });
  await f.declare([{ operation: 'save_capture' }]);
  await f.runtime.execute('save_capture', {}, { callId: 'committed' });
  const restored = fixture({ state: f.state }); await restored.runtime.loadContext();
  assert.equal(restored.runtime.observations[0].callId, 'committed');
  assert.equal(await restored.runtime.finishTurn({}), undefined); assert.equal(restored.calls.length, 0);
  assert.equal(restored.state.toolContext.find(record => record.name === 'assistant_task_state').data.state, 'completed');
});

test('a new user turn cannot borrow an old receipt or unfinished goal', async () => {
  const f = fixture(); await f.declare([{ operation: 'edit_case', targetId: 'case' }]);
  await f.runtime.execute('edit_case', { caseId: 'case' }, { callId: 'old-edit' });
  const next = fixture({ state: f.state, turnId: 'user-2' }); await next.runtime.loadContext();
  assert.equal(next.runtime.task, undefined); assert.equal(next.runtime.observations.length, 0);
  await next.declare([{ operation: 'edit_case', targetId: 'case' }]);
  assert.equal((await next.runtime.finishTurn({})).action, 'continue');
});

test('reading an undeclared preparation is allowed but new writes require a semantic plan extension', async () => {
  const f = fixture(); await f.declare([{ operation: 'read_case' }]);
  assert.equal((await f.runtime.execute('edit_case', { caseId: 'case' })).data.code, 'task_scope_changed');
  await f.declare([{ operation: 'read_case' }, { operation: 'edit_case', targetId: 'case' }]);
  await f.runtime.execute('read_case', { caseId: 'case' }, { callId: 'read' });
  await f.runtime.execute('edit_case', { caseId: 'case' }, { callId: 'edit' });
  assert.equal(await f.runtime.finishTurn({}), undefined);
});

test('cancellation refuses further work even before task registration', async () => {
  const f = fixture(); const c = new AbortController(); c.abort();
  await assert.rejects(f.runtime.execute('read_case', {}, { signal: c.signal })); assert.equal(f.calls.length, 0);
});

test('English studio default keeps the shared behavioral contract in English', () => {
  assert(!/\p{Script=Han}/u.test(DEFAULT_AGENT_INSTRUCTION_EN));
  assert(DEFAULT_AGENT_INSTRUCTION_EN.includes('Durable receipts'));
});

import { runComposerToolLoop } from '../extension/composer-tool-loop.js';
function nativeResponse(protocol, calls, content = '') {
  const message = { role: 'assistant', content, ...(calls.length ? { tool_calls: calls.map(call => ({
    id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) }
  })) } : {}) };
  return new Response(JSON.stringify(protocol === 'responses' ? { status: 'completed', output: calls.map(call => ({
    type: 'function_call', call_id: call.id, name: call.name, arguments: JSON.stringify(call.args)
  })), output_text: content } : { choices: [{ message, finish_reason: calls.length ? 'tool_calls' : 'stop' }] }),
  { headers: { 'content-type': 'application/json' } });
}
for (const protocol of ['chat_completions', 'responses']) {
  test(`${protocol}: registration and an authorized edit can share one tool batch`, async () => {
    const f = fixture(); let requests = 0;
    const result = await runComposerToolLoop({ protocol, runtime: f.runtime,
      body: { model: 'fixture', ...(protocol === 'responses' ? { input: [{ role: 'user', content: 'change the title' }] } : { messages: [{ role: 'user', content: 'change the title' }] }) },
      request: async () => nativeResponse(protocol, requests++ ? [] : [
        { id: 'register', name: 'declare_task', args: { mode: 'act', goal: 'change title', steps: [{ operation: 'edit_case', targetId: 'case' }] } },
        { id: 'edit', name: 'edit_case', args: { caseId: 'case', requestId: 'stable-write' } }
      ], 'The title is updated.') });
    assert.equal(result.content, 'The title is updated.'); assert.equal(requests, 2);
    assert.equal(f.calls.length, 1); assert.equal(f.runtime.task.state, 'completed');
  });
  test(`${protocol}: ordinary conversation terminates with a native declaration in one request`, async () => {
    const f = fixture(); let requests = 0;
    const result = await runComposerToolLoop({ protocol, runtime: f.runtime,
      body: { model: 'fixture', ...(protocol === 'responses' ? { input: [{ role: 'user', content: 'help' }] } : { messages: [{ role: 'user', content: 'help' }] }) },
      request: async () => { requests++; return nativeResponse(protocol, [{ id: 'register', name: 'declare_task',
        args: { mode: 'respond', goal: 'explain', steps: [], reply: 'Here is how it works.' } }]); } });
    assert.equal(result.content, 'Here is how it works.'); assert.equal(requests, 1); assert.equal(f.calls.length, 0);
  });
}

test('a plan extension permits retrying a preflight-denied write without relaxing no-progress protection', async () => {
  const f = fixture(); let requests = 0;
  const args = { caseId: 'case', requestId: 'same-write' };
  const declaration = steps => ({ name: 'declare_task', args: { mode: 'act', goal: 'current goal', steps } });
  const batches = [
    [declaration([{ operation: 'read_case' }]), { name: 'edit_case', args }],
    [declaration([{ operation: 'read_case' }, { operation: 'edit_case', targetId: 'case' }]), { name: 'edit_case', args }, { name: 'read_case', args: { caseId: 'case' } }],
    []
  ];
  await runComposerToolLoop({ protocol: 'chat_completions', runtime: f.runtime, body: { model: 'fixture', messages: [{ role: 'user', content: 'current instruction' }] },
    request: async () => { const index = requests++; return nativeResponse('chat_completions', batches[index].map((call, i) => ({ ...call, id: `call-${index}-${i}` })), 'Done.'); } });
  assert.deepEqual(f.calls.map(call => call.name), ['edit_case', 'read_case']); assert.equal(requests, 3);
});

test('identical words in a new human message retain a new task identity', async () => {
  const wrapped = withAssistantTaskRuntime({ specs: [], execute: async () => assert.fail() }, {
    messages: [{ id: 'old-message', role: 'user', content: 'same words' }], instruction: 'same words', userMessageId: 'new-message'
  });
  const context = await wrapped.context();
  assert.equal(context.currentUserMessageIndex, 1); assert.equal(context.userMessages.length, 2);
  assert.equal(context.userMessages.at(-1).userMessageIndex, 1);
});

test('newly discovered target identity can refine a plan but cannot replace an established target', async () => {
  const f = fixture(); await f.declare([{ operation: 'edit_case' }]);
  assert((await f.declare([{ operation: 'edit_case', targetId: 'chosen' }])).data.ok);
  assert.equal((await f.declare([{ operation: 'edit_case', targetId: 'other' }])).data.code, 'task_goal_changed');
});

test('a successful subset cannot complete the declared batch of cases', async () => {
  const f = fixture({ execute: () => ({ results:[{candidateId:'first',status:'saved',entryId:'case-1'}] }) });
  await f.declare([{operation:'save_capture',resultIds:['first','second']}]);
  await f.runtime.execute('save_capture', {}, {callId:'subset'});
  assert.equal((await f.runtime.finishTurn({})).action,'continue');
  assert.equal((await f.declare([{operation:'save_capture',resultIds:['first']}])).data.code,'task_goal_changed');
});

test('batch retries retain successful items from earlier partial receipts', async () => {
  let attempt=0;
  const f=fixture({execute:()=>({results:++attempt===1?[{candidateId:'first',status:'saved',entryId:'case-1'},{candidateId:'second',status:'failed'}]:[{candidateId:'second',status:'saved',entryId:'case-2'}]})});
  await f.declare([{operation:'save_capture',resultIds:['first','second']}]);
  await f.runtime.execute('save_capture',{}, {callId:'partial'}); assert.equal((await f.runtime.finishTurn({})).action,'continue');
  await f.runtime.execute('save_capture',{}, {callId:'retry'}); assert.equal(await f.runtime.finishTurn({}),undefined);
});

test('a one-page query does not require scanning an entire library; full traversal must be explicit',async()=>{
  const f=fixture({execute:()=>({ok:true,nextOffset:24})});await f.declare([{operation:'read_case'}]);
  await f.runtime.execute('read_case',{}, {callId:'page'});assert.equal(await f.runtime.finishTurn({}),undefined);
  const full=fixture({execute:()=>({ok:true,nextOffset:24})});await full.declare([{operation:'read_case',requireComplete:true}]);
  await full.runtime.execute('read_case',{}, {callId:'page'});assert.equal((await full.runtime.finishTurn({})).action,'continue');
});

test('an analysis receipt with failed items is not a completed task merely because transport succeeded',async()=>{
  const f=fixture({execute:()=>({ok:true,status:'partial',items:[{state:'saved'},{state:'failed'}]})});await f.declare([{operation:'edit_case'}]);
  await f.runtime.execute('edit_case',{}, {callId:'analysis'});assert.equal((await f.runtime.finishTurn({})).action,'continue');
});

test('extending a plan does not permit replaying an already successful write with unchanged arguments', async () => {
  const f=fixture();let requests=0;
  const steps=[{operation:'edit_case',targetId:'case'}];
  const declare=steps=>({name:'declare_task',args:{mode:'act',goal:'current goal',steps}});
  const write={name:'edit_case',args:{caseId:'case',requestId:'stable'}};
  const batches=[[declare(steps),write],[declare([...steps,{operation:'read_case'}]),write]];
  await assert.rejects(runComposerToolLoop({protocol:'chat_completions',runtime:f.runtime,body:{model:'fixture',messages:[{role:'user',content:'current instruction'}]},
    request:async()=>{const index=requests++;return nativeResponse('chat_completions',batches[index].map((call,i)=>({...call,id:`write-${index}-${i}`})));}}),/重复请求/);
  assert.equal(f.calls.length,1);
});

test('a genuine blocker terminates with its factual reason without a second model embellishment',async()=>{
  const f=fixture({execute:()=>({ok:false,code:'source_unavailable'})});let requests=0;
  const batches=[[
    {name:'declare_task',args:{mode:'act',goal:'current goal',steps:[{operation:'read_case'}]}},
    {name:'read_case',args:{caseId:'case'}}
  ],[{name:'settle_task',args:{state:'blocked',reason:'目标来源暂不可用，已取得的内容保留。',failedCallId:'block-0-1'}}]];
  const result=await runComposerToolLoop({protocol:'chat_completions',runtime:f.runtime,body:{model:'fixture',messages:[{role:'user',content:'current instruction'}]},
    request:async()=>{const index=requests++;return nativeResponse('chat_completions',batches[index].map((call,i)=>({...call,id:`block-${index}-${i}`})));}});
  assert.equal(requests,2);assert.equal(result.content,'目标来源暂不可用，已取得的内容保留。');assert.equal(f.runtime.task.state,'blocked');
});

test('after reading the directory a save plan may omit finished preparation without losing it', async () => {
  const f = fixture();
  await f.declare([{ operation: 'read_case', targetId: 'case' }], { contentTypeId: 'content:code-case' });
  await f.runtime.execute('read_case', { caseId: 'case' }, { callId: 'directory' });
  const next = await f.declare([{ operation: 'save_capture' }]);
  assert.equal(next.data.ok, true);
  assert.equal(f.runtime.task.contentTypeId, 'content:code-case');
  assert(f.runtime.task.steps.some(step => step.operation === 'read_case'));
  assert.deepEqual(f.runtime.task.pending, [{ operation: 'save_capture' }]);
  assert.equal((await f.runtime.finishTurn({ content: 'Finished' })).action, 'continue');
});

test('a planned candidate update matches the real write field and cannot be fulfilled by selection alone', async () => {
  const runtime = withAssistantTaskRuntime({ specs: [{ name: 'update_capture', parameters: { properties: { requestId: {}, candidates: {}, selections: {} } } }],
    execute: async () => ({ data: { ok: true } }) }, { instruction: 'Prepare the effect candidates' });
  await runtime.execute('declare_task', { mode: 'act', goal: 'Prepare the effects', steps: [{ operation: 'update_capture', part: 'candidates' }] });
  assert.equal((await runtime.execute('update_capture', { selections: [] })).data.code, 'task_scope_changed');
  assert.equal((await runtime.execute('update_capture', { candidates: [{ id: 'effect' }] })).data.ok, true);
  assert.equal(await runtime.finishTurn({}), undefined);
});

test('a corrected save cannot become a waiting blocker by citing its obsolete failure', async () => {
  let attempt = 0;
  const f = fixture({ execute: () => ++attempt === 1
    ? { ok: false, code: 'capture_code_preview_required' }
    : { ok: true, results: [{ status: 'saved', entryId: 'case' }] } });
  await f.declare([{ operation: 'save_capture' }]);
  await f.runtime.execute('save_capture', { captureId: 'capture', requestId: 'first', expectedRevision: 2 }, { callId: 'failed' });
  await f.runtime.execute('save_capture', { captureId: 'capture', requestId: 'retry', expectedRevision: 3 }, { callId: 'saved' });
  const result = await f.runtime.execute('settle_task', { state: 'waiting', failedCallId: 'failed', reason: 'Need permission to fix the preview' });
  assert.equal(result.data.code, 'task_blocker_resolved');
  assert.equal(f.runtime.task.state, 'active');
});

test('plan extension cannot silently discard a registered user restriction',async()=>{
  const f=fixture();await f.declare([{operation:'read_case'}],{constraints:['preserve existing title']});
  const revised=await f.declare([{operation:'read_case'},{operation:'edit_case'}]);
  assert.equal(revised.data.ok,true);
  assert.deepEqual(f.runtime.task.constraints,['preserve existing title']);
  assert.equal((await f.declare([{operation:'read_case'},{operation:'edit_case'}],{constraints:[]})).data.code,'task_goal_changed');
});

test('an unfinished full-original read cannot be downgraded to an excerpt by changing a completion flag',async()=>{
  const f=fixture();await f.declare([{operation:'read_case',part:'original'}]);
  const changed=await f.declare([{operation:'read_case',part:'original',requireComplete:false}]);
  assert.equal(changed.data.code,'task_goal_changed');
});

test('an unresolved creation label is not accepted as a real saved Skill identity',async()=>{
  const f=fixture();
  const result=await f.declare([{operation:'save_capture',targetId:'not-an-observed-resource'}]);
  assert.equal(result.data.code,'task_target_unresolved');
  assert.equal(f.runtime.task,undefined,'the model must be able to correct an invalid plan before it is locked');
});

test('actual Skill identifiers are supported by the same target binding as cases',async()=>{
  const {withAssistantTaskRuntime}=await import('../extension/assistant-task.js');
  const runtime=withAssistantTaskRuntime({specs:[{name:'save_skill',parameters:{properties:{requestId:{},skillId:{}}}}],execute:async()=>({data:{ok:true,skillId:'actual-skill'}})},
    {messages:[{id:'u',role:'user',content:'update the method'}],instruction:'update the method',context:{skills:[{id:'actual-skill'}]}});
  await runtime.execute('declare_task',{mode:'act',goal:'Update the chosen method',steps:[{operation:'save_skill',targetId:'actual-skill'}]});
  assert((await runtime.execute('save_skill',{skillId:'actual-skill'},{callId:'saved'})).data.ok);
  assert.equal(await runtime.finishTurn({}),undefined);
});

for(const key of ['skillId','caseId','captureId','projectId','batchId','transferId','referenceId','assetId','tabId']) {
  test(`semantic target binding uses the actual ${key} contract`,async()=>{
    const value=key==='tabId'?17:'actual-object';
    const runtime=withAssistantTaskRuntime({specs:[{name:'read_object',parameters:{properties:{[key]:{}}}}],execute:async()=>({data:{ok:true,[key]:value}})},
      {instruction:'Inspect the object',context:{objects:[{[key]:value}]}});
    const context=await runtime.context();await runtime.execute('declare_task',{mode:'act',goal:'Inspect',steps:[{operation:'read_object',targetId:String(value)}]});
    await runtime.execute('read_object',{[key]:value},{callId:'read'});assert.equal(await runtime.finishTurn({}),undefined);
  });
}

test('reading only the end of a paged original cannot prove the full source was read',async()=>{
  const f=fixture({execute:(_name,args)=>({ok:true,caseId:'case',revision:'fixed',content:args.offset?'efgh':'abcd',offset:args.offset||0,totalCharacters:8,nextOffset:args.offset?null:4})});
  await f.declare([{operation:'read_case',targetId:'case',requireComplete:true}]);
  await f.runtime.execute('read_case',{caseId:'case',offset:4},{callId:'end'});
  assert.equal((await f.runtime.finishTurn({})).action,'continue');
  await f.runtime.execute('read_case',{caseId:'case',offset:0},{callId:'start'});
  assert.equal(await f.runtime.finishTurn({}),undefined);
});

test('a full read step supports the actual plural parts argument and exposes current pending facts',async()=>{
  const f=fixture();await f.declare([{operation:'read_case',part:'document'}]);
  await f.runtime.execute('read_case',{parts:['overview','document']},{callId:'document'});
  assert.deepEqual(f.runtime.task.pending,[]);
});

test('a declared group of originals must be read per case rather than satisfied by a single successful read',async()=>{
  const f=fixture();await f.declare([{operation:'read_case',resultIds:['first','second'],requireComplete:true}]);
  await f.runtime.execute('read_case',{caseId:'first'},{callId:'first'});assert.equal((await f.runtime.finishTurn({})).action,'continue');
  await f.runtime.execute('read_case',{caseId:'second'},{callId:'second'});assert.equal(await f.runtime.finishTurn({}),undefined);
});

test('batched source reads and individual continuation pages share the same source identity',async()=>{
  let reads=0;
  const f=fixture({execute:()=>++reads===1?{ok:true,revision:'same',sources:[{selector:'#source',content:'abcd',totalCharacters:8,nextOffset:4},{selector:'#other',content:'x',totalCharacters:20,nextOffset:1}]}:
    {ok:true,revision:'same',selector:'#source',content:'efgh',totalCharacters:8,offset:4,nextOffset:null}});
  await f.declare([{operation:'read_case',part:'source',selector:'#source',requireComplete:true}]);
  await f.runtime.execute('read_case',{part:'source',selectors:['#source','#other']},{callId:'batch'});
  await f.runtime.execute('read_case',{part:'source',selector:'#source',offset:4},{callId:'continuation'});
  assert.equal(await f.runtime.finishTurn({}),undefined);
});

test('semantic goal wording may be refined while required outcomes and real user authorization stay fixed',async()=>{
  const f=fixture();await f.declare([{operation:'save_capture'}]);
  const updated=await f.runtime.execute('declare_task',{mode:'act',goal:'Preserve the source and save the guide',steps:[{operation:'save_capture'}]});
  assert(updated.data.ok);assert.equal((await f.runtime.finishTurn({})).action,'continue');
  assert.equal((await f.runtime.execute('declare_task',{mode:'act',goal:'Just explain instead',steps:[{operation:'read_case'}]})).data.code,'task_goal_changed');
});

test('actual successful analysis items survive a partial receipt and can complete after a failed-item retry',async()=>{
  let attempt=0;
  const f=fixture({execute:()=>({ok:true,status:++attempt===1?'partial':'completed',items:attempt===1?[{caseId:'first',state:'saved'},{caseId:'second',state:'failed'}]:[{caseId:'second',state:'saved'}]})});
  await f.declare([{operation:'save_capture',resultIds:['first','second']}]);
  await f.runtime.execute('save_capture',{}, {callId:'first-page'});assert.equal((await f.runtime.finishTurn({})).action,'continue');
  await f.runtime.execute('save_capture',{}, {callId:'retry'});assert.equal(await f.runtime.finishTurn({}),undefined);
});

test('a project lookup step can continue using its actual name fragment filter without losing the save requirement',async()=>{
 let state={toolContext:[]};
 const durable=createAgentContextRuntime({turnId:'project-user',load:async()=>state,update:async transform=>{state=transform(state);}});
 const runtime=withAssistantTaskRuntime({...durable,specs:[{name:'read_projects',parameters:{properties:{query:{},name:{}}}},{name:'save_capture',parameters:{properties:{requestId:{}}}}],
  execute:async(name,args)=>({data:{ok:true,content:JSON.stringify([{id:'real-project',name:'Motion-effects'}]),nextOffset:null}})},
  {instruction:'Save the selected effects in the project',userMessageId:'project-user'});
 await runtime.loadContext();
 await runtime.execute('declare_task',{mode:'act',goal:'Save separate effects in the matching project',steps:[{operation:'read_projects',selector:'motion'},{operation:'save_capture'}]});
 await runtime.execute('read_projects',{query:' MOTION '},{callId:'actual-project-search'});
 assert.deepEqual(runtime.task.pending,[{operation:'save_capture'}]);
 assert.equal((await runtime.finishTurn({content:'All saved.'})).action,'continue');
});

test('preparing the next batch on the same source fulfills the old preparation target and rebinds pending writes',async()=>{
 const runtime=withAssistantTaskRuntime({specs:['prepare_capture','update_capture','save_capture'].map(name=>({name,parameters:{properties:{requestId:{}}}})),
  execute:async(name,args)=>({data:name==='prepare_capture'?{ok:true,captureId:'next-batch',replacesCaptureId:'saved-batch',state:'preview'}:{ok:true,captureId:args.captureId,results:[{entryId:'next-case',status:'saved'}]}})},
  {instruction:'Continue saving remaining modules',userMessageId:'current-user',context:{preview:{captureId:'saved-batch',state:'completed'}}});
 await runtime.execute('declare_task',{mode:'act',goal:'Continue remaining modules',steps:['prepare_capture','update_capture','save_capture'].map(operation=>({operation,targetId:'saved-batch'}))});
 await runtime.execute('prepare_capture',{url:'https://example.test/'},{callId:'next-preview'});
 assert(!runtime.task.pending.some(step=>step.operation==='prepare_capture'),'same-source preparation is a real completed step, not a permanent missing old handle');
 assert(runtime.task.pending.every(step=>step.targetId==='next-batch'));
 await runtime.execute('update_capture',{captureId:'next-batch'},{callId:'next-write'});
 await runtime.execute('save_capture',{captureId:'next-batch'},{callId:'next-save'});
 assert.equal(await runtime.finishTurn({}),undefined);
 assert.equal(runtime.task.state,'completed');
});
