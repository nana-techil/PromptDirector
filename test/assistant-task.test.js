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
  } }, { messages: [{ id: turnId, role: 'user', content: 'current instruction' }], instruction: 'current instruction' });
  const declare = (steps, extra = {}) => runtime.execute('declare_task', { mode: 'act', goal: 'current goal', userMessageIds: [turnId], steps, ...extra });
  return { runtime, calls, state, declare };
}

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
        { id: 'register', name: 'declare_task', args: { mode: 'act', goal: 'change title', userMessageIds: ['user-1'], steps: [{ operation: 'edit_case', targetId: 'case' }] } },
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
        args: { mode: 'respond', goal: 'explain', userMessageIds: ['user-1'], steps: [], reply: 'Here is how it works.' } }]); } });
    assert.equal(result.content, 'Here is how it works.'); assert.equal(requests, 1); assert.equal(f.calls.length, 0);
  });
}

test('a plan extension permits retrying a preflight-denied write without relaxing no-progress protection', async () => {
  const f = fixture(); let requests = 0;
  const args = { caseId: 'case', requestId: 'same-write' };
  const declaration = steps => ({ name: 'declare_task', args: { mode: 'act', goal: 'current goal', userMessageIds: ['user-1'], steps } });
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
  assert.equal(context.currentUserId, 'new-message'); assert.equal(context.userMessages.length, 2);
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
  const declare=steps=>({name:'declare_task',args:{mode:'act',goal:'current goal',userMessageIds:['user-1'],steps}});
  const write={name:'edit_case',args:{caseId:'case',requestId:'stable'}};
  const batches=[[declare(steps),write],[declare([...steps,{operation:'read_case'}]),write]];
  await assert.rejects(runComposerToolLoop({protocol:'chat_completions',runtime:f.runtime,body:{model:'fixture',messages:[{role:'user',content:'current instruction'}]},
    request:async()=>{const index=requests++;return nativeResponse('chat_completions',batches[index].map((call,i)=>({...call,id:`write-${index}-${i}`})));}}),/重复请求/);
  assert.equal(f.calls.length,1);
});

test('a genuine blocker terminates with its factual reason without a second model embellishment',async()=>{
  const f=fixture({execute:()=>({ok:false,code:'source_unavailable'})});let requests=0;
  const batches=[[
    {name:'declare_task',args:{mode:'act',goal:'current goal',userMessageIds:['user-1'],steps:[{operation:'read_case'}]}},
    {name:'read_case',args:{caseId:'case'}}
  ],[{name:'settle_task',args:{state:'blocked',reason:'目标来源暂不可用，已取得的内容保留。',failedCallId:'block-0-1'}}]];
  const result=await runComposerToolLoop({protocol:'chat_completions',runtime:f.runtime,body:{model:'fixture',messages:[{role:'user',content:'current instruction'}]},
    request:async()=>{const index=requests++;return nativeResponse('chat_completions',batches[index].map((call,i)=>({...call,id:`block-${index}-${i}`})));}});
  assert.equal(requests,2);assert.equal(result.content,'目标来源暂不可用，已取得的内容保留。');assert.equal(f.runtime.task.state,'blocked');
});

test('plan extension cannot silently discard a registered user restriction',async()=>{
  const f=fixture();await f.declare([{operation:'read_case'}],{constraints:['preserve existing title']});
  const revised=await f.declare([{operation:'read_case'},{operation:'edit_case'}]);
  assert.equal(revised.data.code,'task_goal_changed');
  assert.deepEqual(f.runtime.task.constraints,['preserve existing title']);
});

test('an unfinished full-original read cannot be downgraded to an excerpt by changing a completion flag',async()=>{
  const f=fixture();await f.declare([{operation:'read_case',part:'original'}]);
  const changed=await f.declare([{operation:'read_case',part:'original',requireComplete:false}]);
  assert.equal(changed.data.code,'task_goal_changed');
});
