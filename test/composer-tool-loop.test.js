import test from 'node:test';
import assert from 'node:assert/strict';
import { runComposerToolLoop, readToolResponse } from '../extension/composer-tool-loop.js';
const spec = { name: 'search_cases', description: 'search', parameters: { type: 'object', properties: { query: { type: 'string' } } } };
const chat = (message, extra = {}) => new Response(JSON.stringify({ choices: [{ message, finish_reason: message.tool_calls?.length ? 'tool_calls' : 'stop' }], ...extra }), { headers: { 'content-type': 'application/json' } });
const call = (id, args) => ({ id, type: 'function', function: { name: 'search_cases', arguments: JSON.stringify(args) } });
const body = () => ({ model: 'fixture-model', messages: [{ role: 'user', content: '查询案例' }] });
const sse = events => new Response(new ReadableStream({ start(controller) { const text = events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''); const bytes = new TextEncoder().encode(text); for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i+7)); controller.close(); } }), { headers: { 'content-type': 'text/event-stream' } });

for (const protocol of ['chat_completions', 'responses']) test(`${protocol}: a rejected terminal tool reply receives the same actionable completion feedback as a text reply`, async () => {
  let requests = 0, checks = 0;
  const runtime = { specs: [spec], execute: async () => ({ data: { ok: true }, terminate: true }),
    finishToolBatch: async () => ({ content: 'Only part of the work was done' }),
    finishTurn: async () => ++checks === 1 ? { action: 'continue', state: { missing: ['remaining'] }, message: 'Complete the remaining target from the retained scope' } : undefined };
  const result = await runComposerToolLoop({ protocol, runtime,
    body: protocol === 'responses' ? { model: 'fixture-model', input: [{ role: 'user', content: 'Finish the work' }] } : body(),
    request: async current => {
      if (++requests === 1) return protocol === 'responses'
        ? new Response(JSON.stringify({ output: [{ type: 'function_call', call_id: 'terminal', name: 'search_cases', arguments: '{"query":"target"}' }] }))
        : chat({ role: 'assistant', tool_calls: [call('terminal', { query: 'target' })] });
      const feedback = (current.input || current.messages).at(-1);
      assert.equal(feedback.role, 'user');
      assert.match(feedback.content, /Complete the remaining target/);
      return protocol === 'responses' ? new Response(JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'done' }] }] })) : chat({ role: 'assistant', content: 'done' });
    } });
  assert.equal(result.content, 'done'); assert.equal(requests, 2);
});

for (const protocol of ['chat_completions', 'responses']) test(`${protocol}: a failed batch can retry identical parameters after its exact source recovery, including an old stopped checkpoint`, async () => {
  for (const mode of ['fresh', 'checkpoint', 'same-batch']) {
    let reads = 0, writes = 0, requests = 0, checkpoint;
    const update = { captureId: 'batch', expectedRevision: 1, requestId: 'same-request', candidates: [{ id: 'effect' }] };
    const correction = { captureId: 'batch', expectedRevision: 1, part: 'source', selectors: ['#effect pre'] };
    const makeCall = (id, name, args) => protocol === 'responses' ? { type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) }
      : { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
    const response = calls => protocol === 'responses' ? new Response(JSON.stringify({ output: calls || [{ type: 'message', content: [{ type: 'output_text', text: 'done' }] }] }))
      : chat(calls ? { role: 'assistant', tool_calls: calls } : { role: 'assistant', content: 'done' });
    const runtime = { specs: ['update_capture', 'read_capture'].map(name => ({ name, parameters: { type: 'object', properties: {}, additionalProperties: true } })),
      saveContinuation: async value => { checkpoint = structuredClone(value); },
      execute: async name => name === 'read_capture' ? (reads++, { data: { captureId: 'batch', part: 'source', sources: [{ selector: '#effect pre', content: 'actual original', nextOffset: null }] } })
        : (writes++, { data: reads ? { ok: true, revision: 2 } : { ok: false, code: 'capture_source_required', recovery: { operation: 'read_capture', arguments: correction } } }) };
    const options = { protocol, body: protocol === 'responses' ? { model: 'fixture-model', input: [] } : body(), runtime,
      request: async () => {
        requests++;
        if (mode === 'same-batch') return response(requests === 1 ? [makeCall('failed-update', 'update_capture', update),
          makeCall('corrective-read', 'read_capture', correction), makeCall('retry-update', 'update_capture', update)] : undefined);
        return response(requests === 1 ? [makeCall('failed-update', 'update_capture', update)]
          : requests === 2 ? [makeCall('corrective-read', 'read_capture', { ...correction, length: 12000 })]
          : requests === 3 ? [makeCall('retry-update', 'update_capture', update)] : undefined);
      } };
    if (mode === 'checkpoint') {
      await assert.rejects(runComposerToolLoop({ ...options, budget: { maxToolCalls: 2 } }), { code: 'RESOURCE_BUDGET_REACHED' });
      // This is the legacy checkpoint shape: recovery must be inferred from
      // its actual paired native results, not depend on newly stored flags.
      assert.equal(checkpoint.requestCount, 3);
      assert.deepEqual(checkpoint.pendingCalls.map(c => c.id), ['retry-update']);
    }
    const result = await runComposerToolLoop({ ...options, ...(mode === 'checkpoint' ? { continuation: checkpoint } : {}) });
    assert.equal(result.content, 'done'); assert.equal(writes, 2); assert.equal(reads, 1);
  }
});

test('unrelated or failed recovery reads cannot unlock a repeated failed write, and successful writes remain protected', async () => {
  for (const kind of ['unrelated', 'failed-read', 'committed', 'old-read', 'recovery-consumed']) {
    let writes = 0, requests = 0;
    const recovery = { operation: 'read_capture', arguments: { captureId: 'batch', part: 'source', selectors: ['#missing'] } };
    const runtime = { specs: ['update_capture', 'read_capture'].map(name => ({ name, parameters: { type: 'object', properties: {}, additionalProperties: true } })),
      execute: async name => name === 'update_capture' ? (writes++, { data: kind === 'committed' ? { ok: true } : { ok: false, recovery } })
        : { data: kind === 'failed-read' ? { ok: false } : { ok: true, content: 'observed' } } };
    await assert.rejects(runComposerToolLoop({ body: body(), protocol: 'chat_completions', runtime, request: async () => {
      const index = requests++; const reading = index === (kind === 'old-read' ? 0 : 1);
      const name = reading ? 'read_capture' : 'update_capture';
      const args = reading ? { ...recovery.arguments, ...(kind === 'unrelated' ? { selectors: ['#unrelated'] } : {}) } : { captureId: 'batch' };
      return chat({ role: 'assistant', tool_calls: [{ id: 'attempt-' + index, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
    } }), /没有进展/);
    assert.equal(writes, kind === 'recovery-consumed' ? 2 : 1);
  }
});

function batchRuntime() {
  const journal = [], checkpoints = [];
  const runtime = { turnId: 'batch-turn', task: { mode:'act',state:'active',goal:'Save every requested effect' },
    specs: ['update_capture','save_capture','read_tool_result'].map(name => ({name,parameters:{type:'object',properties:{},additionalProperties:true}})),
    loadContext: async () => journal, recordToolResult: async record => journal.push({...structuredClone(record),turnId:'batch-turn'}),
    saveContinuation: async value => checkpoints.push(structuredClone(value)), clearContinuation: async () => {},
    execute: async (name,args) => ({data: name === 'save_capture'
      ? {captureId:args.captureId,state:'completed',results:[{candidateId:args.captureId,entryId:args.captureId,status:'saved'}]}
      : {captureId:args.captureId}}) };
  return {runtime,journal,checkpoints};
}

test('a durable batch crosses the default 100 requests with receipt progress, preserving original journal and cumulative usage', async () => {
  const {runtime,journal,checkpoints}=batchRuntime(); let count=0;
  const html='<html>full effect source</html>'.repeat(200);
  const result=await runComposerToolLoop({body:body(),protocol:'chat_completions',runtime,
    request: async value => {
      if(count>2) assert(JSON.stringify(value).length<300000,'completed generated HTML must not grow with every saved batch');
      const index=count++; const captureId=`effect-${Math.floor(index/2)}`;
      return chat(index<104?{role:'assistant',tool_calls:[{id:`batch-${index}`,type:'function',function:{name:index%2?'save_capture':'update_capture',arguments:JSON.stringify({captureId,...(index%2?{project:'destination'}:{candidates:[{id:captureId,title:captureId,codePreview:{html}}]})})}}]}:{role:'assistant',content:'Saved all requested effects'},
        {usage:{prompt_tokens:10,completion_tokens:2,total_tokens:12}});
    }});
  assert.equal(result.requestCount,105);assert.equal(result.usage.totalTokens,1260);
  assert.equal(journal.filter(record=>record.name==='save_capture').length,52);
  assert.equal(journal[0].args.candidates[0].codePreview.html,html);
  assert.equal(checkpoints.length,1);assert.equal(checkpoints[0].requestCount,100);
});

test('verified batch progress never overrides an explicit request cap or a cumulative token cap', async () => {
  for(const planned of [true,false]) for(const budget of [{maxRequests:2},{maxTotalTokens:24}]) {
    const {runtime}=batchRuntime();if(!planned)delete runtime.task;let count=0;
    await assert.rejects(runComposerToolLoop({body:body(),protocol:'chat_completions',runtime,budget,
      request:async()=>chat({role:'assistant',tool_calls:[{id:`save-${++count}`,type:'function',function:{name:'save_capture',arguments:JSON.stringify({captureId:`saved-${count}`})}}]}, {usage:{prompt_tokens:10,completion_tokens:2,total_tokens:12}})
    }),{code:'RESOURCE_BUDGET_REACHED'});
    assert.equal(count,2);
  }
});

test('the default tool segment checkpoints between paired calls and keeps pending writes exactly once', async () => {
  const {runtime,checkpoints}=batchRuntime();let requests=0,writes=0;
  const execute=runtime.execute;runtime.execute=async(...args)=>{writes++;return execute(...args)};
  await runComposerToolLoop({body:body(),protocol:'chat_completions',runtime,request:async()=>chat(++requests===1
    ? {role:'assistant',tool_calls:Array.from({length:501},(_,i)=>({id:`bulk-${i}`,type:'function',function:{name:'save_capture',arguments:JSON.stringify({captureId:`case-${i}`})}}))}
    : {role:'assistant',content:'done'})});
  assert.equal(writes,501);assert.equal(requests,2);assert.equal(checkpoints.length,1);
  assert.deepEqual(checkpoints[0].pendingCalls.map(call=>call.id),['bulk-500']);
  assert.equal(checkpoints[0].uncertainCallId,'');
});

test('a failed item does not erase independent successful receipts when continuing a long batch', async () => {
  const {runtime,checkpoints}=batchRuntime();let count=0;
  runtime.execute=async(_name,args)=>({data:{ok:false,captureId:args.captureId,state:'preview',results:[
    {candidateId:'good',entryId:args.captureId,status:'saved'}, {candidateId:'unavailable',status:'failed'}]}});
  await runComposerToolLoop({body:body(),protocol:'chat_completions',runtime,request:async()=>chat(count++<101
    ? {role:'assistant',tool_calls:[{id:`partial-${count}`,type:'function',function:{name:'save_capture',arguments:JSON.stringify({captureId:`saved-${count}`})}}]}
    : {role:'assistant',content:'Successful items kept; unavailable items reported'})});
  assert.equal(count,102);assert.equal(checkpoints.length,1);
});

for(const planned of [true,false]) test(`a stopped batch cannot auto-resume and repeated existing-case receipts cannot fund endless segments (plan=${planned})`, async () => {
  const controller=new AbortController();const {runtime}=batchRuntime();if(!planned)delete runtime.task;const execute=runtime.execute;
  runtime.execute=async(...args)=>{const result=await execute(...args);controller.abort();return result};
  let requests=0;
  await assert.rejects(runComposerToolLoop({body:body(),protocol:'chat_completions',runtime,signal:controller.signal,
    request:async()=>{requests++;return chat({role:'assistant',tool_calls:[{id:'stop-save',type:'function',function:{name:'save_capture',arguments:'{"captureId":"saved"}'}}]})}
  }),{name:'AbortError'});
  assert.equal(requests,1);
  const repeated=batchRuntime();if(!planned)delete repeated.runtime.task;let count=0;
  repeated.runtime.execute=async(_name,args)=>({data:{captureId:args.captureId,state:'completed',results:[{entryId:'same-existing',status:'duplicate'}]}});
  await assert.rejects(runComposerToolLoop({body:body(),protocol:'chat_completions',runtime:repeated.runtime,
    request:async()=>chat({role:'assistant',tool_calls:[{id:`same-${++count}`,type:'function',function:{name:'save_capture',arguments:JSON.stringify({captureId:`retry-${count}`})}}]})
  }),{code:'RESOURCE_BUDGET_REACHED'});
  assert.equal(repeated.checkpoints[0].requestCount,100);
  assert.equal(count,200,'only first observed result makes progress; changing request handles cannot extend again');
});

test('varying tool parameters cannot evade a finite default work budget or keep charging forever', async () => {
  let requests = 0;
  await assert.rejects(runComposerToolLoop({ body: body(), protocol: 'chat_completions',
    request: async () => chat({ role: 'assistant', tool_calls: [call(`call-${++requests}`, { query: String(requests) })] }),
    runtime: { specs: [spec], execute: async () => ({ data: {} }) }
  }), error => error.code === 'RESOURCE_BUDGET_REACHED' && error.checkpoint.requestCount === requests);
  assert.ok(requests > 10 && requests < 1000, 'work budget is generous but finite, independent of a user input quota');
});

test('resuming a budget checkpoint supplies prior results without executing already completed writes', async () => {
  let checkpoint, writes = 0, requests = 0;
  const runtime = { specs: [spec], execute: async () => { writes++; return { data: { saved: true, caseId: 'already-saved' } }; },
    saveContinuation: async value => { checkpoint = structuredClone(value); } };
  await assert.rejects(runComposerToolLoop({ body: body(), protocol: 'chat_completions', budget: { maxRequests: 1 }, runtime,
    request: async () => { requests++; return chat({ role: 'assistant', tool_calls: [call('write-once', { query: '保存成果' })] }); }
  }), /工作|预算/);
  const result = await runComposerToolLoop({ body: body(), protocol: 'chat_completions', continuation: checkpoint, runtime,
    request: async value => {
      requests++;
      assert.equal(value.messages.at(-1).tool_call_id, 'write-once');
      assert.equal(JSON.parse(value.messages.at(-1).content).caseId, 'already-saved');
      return chat({ role: 'assistant', content: '成果已保存' });
    } });
  assert.equal(writes, 1); assert.equal(requests, 2); assert.equal(result.requestCount, 2);
});

test('budget reached midway through a batch preserves pending calls and does not repeat the first write', async () => {
  let checkpoint; const executed = [];
  const runtime = { specs: [spec], execute: async (_name, args) => { executed.push(args.query); return { data: args }; },
    saveContinuation: async value => { checkpoint = structuredClone(value); } };
  await assert.rejects(runComposerToolLoop({ body: body(), protocol: 'chat_completions', budget: { maxToolCalls: 1 }, runtime,
    request: async () => chat({ role: 'assistant', tool_calls: [call('one', { query: 'one' }), call('two', { query: 'two' })] })
  }), /预算/);
  assert.deepEqual(checkpoint.pendingCalls.map(item => item.id), ['two']);
  await runComposerToolLoop({ body: body(), protocol: 'chat_completions', continuation: checkpoint, runtime,
    request: async () => chat({ role: 'assistant', content: 'done' }) });
  assert.deepEqual(executed, ['one', 'two']);
});

test('whole-turn deadline cancels a pending response body after headers and retains completed work', async () => {
  let canceled = false;
  await assert.rejects(runComposerToolLoop({ body: body(), protocol: 'chat_completions', budget: { maxDurationMs: 20 },
    request: async () => new Response(new ReadableStream({ cancel() { canceled = true; } }), { headers: { 'content-type': 'application/json' } }),
    runtime: { specs: [spec], execute: () => assert.fail('incomplete response executes nothing') }
  }), error => error.code === 'RESOURCE_BUDGET_REACHED' && Boolean(error.checkpoint));
  assert.equal(canceled, true);
});

test('a large tool batch checks memory after every completed action, preserves its receipt and leaves later writes pending', async () => {
  let checkpoint;
  const writes = [];
  const runtime = { specs: [spec], budget: { workingBytes: 10000 },
    saveContinuation: async value => { checkpoint = value; },
    execute: async (_name, _args, { callId }) => { writes.push(callId); return { data: { fullText: '完整结果'.repeat(3000) } }; } };
  await assert.rejects(runComposerToolLoop({ body: body(), protocol: 'chat_completions',
    runtime, request: async () => chat({ role: 'assistant', tool_calls: [call('first', { query: 'one' }), call('second', { query: 'two' })] })
  }), { code: 'RESOURCE_BUDGET_REACHED' });
  assert.deepEqual(writes, ['first'], 'later actions cannot keep accumulating results before the memory check');
  assert.deepEqual(checkpoint.callIds, ['first']);
  assert.equal(checkpoint.pendingCalls[0].id, 'second');
  assert.equal(checkpoint.uncertainCallId, '');
  runtime.budget.workingBytes = 1000000;
  await runComposerToolLoop({ body: body(), protocol: 'chat_completions', runtime,
    continuation: checkpoint, request: async () => chat({ role: 'assistant', content: '完成' }) });
  assert.deepEqual(writes, ['first', 'second'], 'a subsequent authorized larger operation never repeats the first write');
});

test('a Skill version read is protected before a later tool can prune automatic history in the same work batch', async () => {
  const protectedVersions = new Set();
  let requests = 0;
  await runComposerToolLoop({ body: body(), protocol: 'chat_completions',
    request: async () => ++requests === 1
      ? chat({ role: 'assistant', tool_calls: [call('read', { query: 'read-old-method' }), call('save', { query: 'save-next-method' })] })
      : chat({ role: 'assistant', content: '完整完成' }),
    runtime: { specs: [spec], retainSkillVersions: async ids => ids.forEach(id => protectedVersions.add(id)),
      execute: async (_name, { query }) => {
        if (query === 'read-old-method') return { data: { skillId: 'method', versionId: 'old-used-version' } };
        assert.ok(protectedVersions.has('old-used-version'), 'running work must not wait until the entire model turn finishes to protect its source files');
        return { data: { saved: true } };
      } }
  });
  assert.ok(protectedVersions.has('old-used-version'));
});
test('ordinary response makes one request and executes zero tools; missing usage stays unknown', async () => {
  let requests = 0;
  const result = await runComposerToolLoop({ body: body(), protocol: 'chat_completions', maxCharacters: 750000,
    request: async () => { requests++; return chat({ role: 'assistant', content: '回答' }); }, runtime: { specs: [spec], execute: () => assert.fail('no tools') } });
  assert.equal(requests, 1); assert.equal(result.usageKnown, false);
});
test('empty text tool reply preserves each call ID and reasoning, then resumes with actual results', async () => {
  const requests = []; const executed = [];
  const result = await runComposerToolLoop({ body: body(), protocol: 'chat_completions', maxCharacters: 750000,
    request: async request => { requests.push(structuredClone(request)); return requests.length === 1
      ? chat({ role: 'assistant', content: null, reasoning_content: 'opaque reasoning', tool_calls: [call('one', { query: '雨夜' }), call('two', { query: '晴天' })] }, { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })
      : chat({ role: 'assistant', content: '找到两个案例' }, { usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } }); },
    runtime: { specs: [spec], execute: async (name, args, context) => { executed.push(context.callId); return { data: { title: args.query } }; } } });
  assert.deepEqual(executed, ['one', 'two']); assert.equal(requests[1].messages[1].reasoning_content, 'opaque reasoning');
  assert.deepEqual(requests[1].messages.slice(2).map(item => item.tool_call_id), ['one', 'two']);
  assert.equal(result.usage.totalTokens, 40); assert.equal(result.requestCount, 2);
});
test('streamed fragmented arguments finish before execution, including UTF8', async () => {
  const response = sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'one', function: { name: 'search_cases', arguments: '{"query":' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"雨夜"}' } }] }, finish_reason: 'tool_calls' }] }]);
  const parsed = await readToolResponse(response, 'chat_completions');
  assert.equal(parsed.calls[0].arguments, '{"query":"雨夜"}'); assert.equal(parsed.content, '');
});
test('Responses carries encrypted reasoning and call outputs; image bytes only after explicit runtime result', async () => {
  const requests = [];
  const result = await runComposerToolLoop({ body: { model: 'fixture', store: false, input: [{ role: 'user', content: '用指定图' }] }, protocol: 'responses', maxCharacters: 750000,
    request: async request => { requests.push(structuredClone(request)); return new Response(JSON.stringify(requests.length === 1 ? { status: 'completed', output: [
      { type: 'reasoning', id: 'r', encrypted_content: 'opaque' }, { type: 'function_call', call_id: 'one', name: 'search_cases', arguments: '{"query":"图"}' }] } : { status: 'completed', output_text: '完成' }), { headers: { 'content-type': 'application/json' } }); },
    runtime: { specs: [spec], execute: async () => ({ data: { imageId: 'allowed' }, images: [{ label: '指定图', dataUrl: 'data:image/png;base64,ALLOWED' }] }) } });
  assert.equal(result.content, '完成'); assert.ok(requests[0].include.includes('reasoning.encrypted_content'));
  assert.equal(requests[1].input[1].encrypted_content, 'opaque');
  assert.equal(requests[1].input[3].call_id, 'one');
  assert.equal(requests[1].input[4].content[1].image_url, 'data:image/png;base64,ALLOWED');
});
test('Responses SSE output items preserve complete tool call', async () => {
  const item = { type: 'function_call', call_id: 'one', name: 'search_cases', arguments: '' };
  const parsed = await readToolResponse(sse([
    { type: 'response.output_item.added', output_index: 0, item },
    { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"query":' },
    { type: 'response.function_call_arguments.delta', output_index: 0, delta: '"雨夜"}' },
    { type: 'response.completed', response: { status: 'completed' } }
  ]), 'responses');
  assert.equal(parsed.calls[0].id, 'one'); assert.equal(parsed.calls[0].arguments, '{"query":"雨夜"}');
});
test('stop during a tool prevents the next request; incomplete streams execute nothing', async () => {
  const controller = new AbortController(); let requests = 0;
  await assert.rejects(runComposerToolLoop({ body: body(), protocol: 'chat_completions', signal: controller.signal, maxCharacters: 750000,
    request: async () => { requests++; return chat({ role: 'assistant', tool_calls: [call('one', { query: '' })] }); },
    runtime: { specs: [spec], execute: async () => { controller.abort(); return { data: {} }; } } }), { name: 'AbortError' });
  assert.equal(requests, 1);
  await assert.rejects(readToolResponse(sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'x', function: { name: 'search_cases', arguments: '{' } }] } }] }]), 'chat_completions'), /中断/);
});
test('repeated no-progress calls stop; unknown tool never executes', async () => {
  let count = 0;
  await assert.rejects(runComposerToolLoop({ body: body(), protocol: 'chat_completions', maxCharacters: 750000,
    request: async () => chat({ role: 'assistant', tool_calls: [call(crypto.randomUUID(), { query: '' })] }),
    runtime: { specs: [spec], execute: async () => { count++; return { data: {} }; } } }), /重复/);
  assert.equal(count, 1);
  await assert.rejects(runComposerToolLoop({ body: body(), protocol: 'chat_completions', maxCharacters: 750000,
    request: async () => chat({ role: 'assistant', tool_calls: [{ ...call('x', {}), function: { name: 'shell', arguments: '{}' } }] }),
    runtime: { specs: [spec], execute: () => assert.fail() } }), /不可用/);
});


test('same batch duplicate reads reuse local work but each call receives its own result', async () => {
  let executes = 0; const requests = [];
  await runComposerToolLoop({ body: body(), protocol: 'chat_completions', maxCharacters: 750000,
    request: async request => { requests.push(structuredClone(request)); return requests.length === 1
      ? chat({ role: 'assistant', tool_calls: [call('one', {query:'a'}), call('two', {query:'a'})] })
      : chat({ role: 'assistant', content: '完成' }); },
    runtime: { specs: [spec], execute: async () => { executes++; return {data: { title: 'a' }}; } } });
  assert.equal(executes, 1);
  assert.deepEqual(requests[1].messages.filter(item => item.role === 'tool').map(item => item.tool_call_id), ['one', 'two']);
});

test('native video bytes stay intact without consuming the text budget; retrieved text still counts', async () => {
  const maxCharacters = 2048;
  const video = 'A'.repeat(maxCharacters * 2);
  const input = { model: 'video-fixture', messages: [{ role: 'user', content: [
    { type: 'text', text: '参考原视频' }, { type: 'video_url', video_url: { url: video } }
  ] }] };
  let requests = 0;
  await assert.rejects(runComposerToolLoop({ body: input, protocol: 'chat_completions', maxCharacters,
    request: async current => {
      requests++;
      assert.equal(current.messages[0].content[1].video_url.url, video);
      return chat({ role: 'assistant', tool_calls: [call('read', { query: '资料' })] });
    }, runtime: { specs: [spec], execute: async () => ({ data: { text: '字'.repeat(maxCharacters) } }) }
  }), /请求容量/);
  assert.equal(requests, 1, 'the original video must reach the provider before an oversized text result is rejected');
});

test('a streamed text reply corrected by the executor never sends an empty tool_calls array to the provider', async () => {
  let requests = 0;
  const result = await runComposerToolLoop({body:body(), protocol:'chat_completions',
    request:async payload=>{
      for(const message of payload.messages) if(Object.hasOwn(message,'tool_calls'))
        assert(message.tool_calls.length > 0, "Invalid messages.tool_calls: empty array (DeepSeek rejects the corrective request)");
      requests++;
      return sse([{choices:[{delta:{content:requests===1?'Complete prompt is captured.':'Not selected yet.'},finish_reason:'stop'}]}]);
    },runtime:{specs:[spec],execute:async()=>({data:{}}),finishTurn:()=>requests===1?{action:'continue',state:'source-not-selected',message:'Select the frozen comment before claiming completion.'}:undefined}});
  assert.equal(requests,2);assert.equal(result.content,'Not selected yet.');
});

test('resuming an old corrective checkpoint removes empty calls without replaying completed tools', async () => {
  const original=body();original.messages.push({role:'assistant',content:'Already read.',tool_calls:[]});
  const checkpoint={protocol:'chat_completions',body:original,requestCount:1,pendingCalls:[]};
  const result=await runComposerToolLoop({body:body(),protocol:'chat_completions',continuation:checkpoint,
    request:async payload=>{assert(!Object.hasOwn(payload.messages[1],'tool_calls'));return chat({role:'assistant',content:'Continue.'});},
    runtime:{specs:[spec],execute:()=>assert.fail('no previously completed read/write may replay')}});
  assert.equal(result.content,'Continue.');assert.deepEqual(checkpoint.body.messages[1].tool_calls,[]);
});

test('malformed tool JSON returns a native error so the model can correct it without losing sibling saves', async () => {
  for (const protocol of ['chat_completions','responses']) {
    const executed=[],records=[];let requests=0;
    const nativeCall=(id,args)=>protocol==='responses'?{type:'function_call',call_id:id,name:'search_cases',arguments:args}:{id,type:'function',function:{name:'search_cases',arguments:args}};
    const response=calls=>protocol==='responses'?new Response(JSON.stringify({output:calls,usage:{input_tokens:1,output_tokens:1}})):chat({role:'assistant',tool_calls:calls});
    await runComposerToolLoop({body:protocol==='responses'?{input:[{role:'user',content:'continue'}]}:body(),protocol,
      runtime:{specs:[spec],execute:async(name,args)=>{executed.push(args);return {data:{ok:true}}},recordToolResult:async r=>records.push(r)},
      request:async current=>{
        requests++;
        if(requests===1)return response([nativeCall('bad','{"query":"target","task":: '),nativeCall('good','{"query":"sibling"}')]);
        if(requests===2){const outputs=(current.messages||current.input).filter(x=>x.role==='tool'||x.type==='function_call_output');assert.equal(outputs.length,2);assert.equal(JSON.parse(outputs[0].content||outputs[0].output).code,'invalid_tool_arguments');return response([nativeCall('fixed','{"query":"target"}')]);}
        return protocol==='responses'?new Response(JSON.stringify({output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'done'}]}]})):chat({role:'assistant',content:'done'});
      }});
    assert.deepEqual(executed,[{query:'sibling'},{query:'target'}]);assert.equal(records[0].data.ok,false);
  }
});

test('an old checkpoint containing malformed arguments can recover without replaying committed calls',async()=>{
 const original=body(); original.messages.push({role:'assistant',tool_calls:[call('bad',{})]});
 original.messages.at(-1).tool_calls[0].function.arguments='{"query"::';
 const continuation={protocol:'chat_completions',body:original,pendingCalls:[{id:'bad',name:'search_cases',arguments:'{"query"::'}],callIds:['already-saved'],requestCount:4};
 let writes=0;
 await runComposerToolLoop({body:body(),protocol:'chat_completions',continuation,
  runtime:{specs:[spec],execute:async()=>{writes++;return {data:{ok:true}}}},
  request:async current=>{assert.equal(JSON.parse(current.messages.find(m=>m.tool_call_id==='bad').content).code,'invalid_tool_arguments');return chat({role:'assistant',content:'Corrected task report'});}});
 assert.equal(writes,0,'invalid pending writes must never reach the library');
});

test('invalid JSON objects are recoverable but unchanged malformed calls cannot loop forever',async()=>{
 for(const raw of ['{"query"::','null','[]','"text"',undefined,null]){
  let requests=0,writes=0;let saved;
  await assert.rejects(runComposerToolLoop({body:body(),protocol:'chat_completions',
   runtime:{specs:[spec],execute:async()=>{writes++;return {data:{ok:true}}},saveContinuation:async v=>saved=v},
   request:async()=>chat({role:'assistant',tool_calls:[{id:`invalid-${++requests}`,type:'function',function:{name:'search_cases',arguments:raw}}]})
  }),/没有进展/);
  assert.equal(writes,0);assert.equal(requests,2);assert.equal(saved.pendingCalls.length,0);
  assert.equal(saved.body.messages.filter(m=>m.role==='tool').length,2,'checkpoint retains paired errors for both invalid calls');
 }
});

test('provider output length is fed back so a smaller complete write can follow without executing partial calls',async()=>{
 for(const protocol of ['chat_completions','responses']){
  let requests=0;const executed=[],receipts=[];
  const response=(args,limited=false)=>protocol==='responses'?new Response(JSON.stringify({status:limited?'incomplete':'completed',incomplete_details:limited?{reason:'max_output_tokens'}:undefined,usage:{input_tokens:5,output_tokens:3,total_tokens:8},output:[{type:'function_call',call_id:`r-${requests}`,name:'search_cases',arguments:args}]})):chat({role:'assistant',tool_calls:[{id:`r-${requests}`,type:'function',function:{name:'search_cases',arguments:args}}]},{choices:[{message:{role:'assistant',tool_calls:[{id:`r-${requests}`,type:'function',function:{name:'search_cases',arguments:args}}]},finish_reason:limited?'length':'tool_calls'}],usage:{prompt_tokens:5,completion_tokens:3,total_tokens:8}});
  const result=await runComposerToolLoop({body:protocol==='responses'?{input:[{role:'user',content:'save remaining items'}]}:body(),protocol,
   runtime:{specs:[spec],onRequest:async info=>receipts.push(info),execute:async(_name,args)=>{executed.push(args);return {data:{ok:true}}}},
   request:async current=>{
    requests++;if(requests===1)return response('{"query":"unfinished',true);
    if(requests===2){assert(JSON.stringify(current).includes('model_output_limit'));assert(!JSON.stringify(current).includes('unfinished'),'partial unexecuted arguments must not poison the next request');return response('{"query":"complete small step"}');}
    return protocol==='responses'?new Response(JSON.stringify({status:'completed',output:[{type:'message',content:[{type:'output_text',text:'done'}]}],usage:{input_tokens:5,output_tokens:3,total_tokens:8}})):chat({role:'assistant',content:'done'},{usage:{prompt_tokens:5,completion_tokens:3,total_tokens:8}});
   }});
  assert.deepEqual(executed,[{query:'complete small step'}]);assert.equal(result.usage.totalTokens,24);assert.equal(receipts[0].incompleteReason,protocol==='responses'?'max_output_tokens':'length');
 }
});

test('streamed output limits retain usage and incomplete checkpoints without bypassing explicit budgets or refusals',async()=>{
 const lengthReply=()=>sse([{choices:[{delta:{tool_calls:[{index:0,id:'unfinished',function:{name:'search_cases',arguments:'{"query":"'}}]},finish_reason:'length'}]}, {usage:{prompt_tokens:5,completion_tokens:3,total_tokens:8}}]);
 let checkpoint,requests=0;
 const runtime={specs:[spec],execute:()=>assert.fail('partial output must never execute'),saveContinuation:async v=>checkpoint=v};
 await assert.rejects(runComposerToolLoop({body:body(),protocol:'chat_completions',runtime,budget:{maxTotalTokens:8},request:async()=>{requests++;return lengthReply()}}),{code:'RESOURCE_BUDGET_REACHED'});
 assert.equal(requests,1);assert.equal(checkpoint.usage.totalTokens,8);assert.equal(checkpoint.lastIncompleteResponse.calls[0].arguments,'{"query":"');assert.equal(checkpoint.pendingCalls.length,0);
 requests=0;
 await assert.rejects(runComposerToolLoop({body:body(),protocol:'chat_completions',runtime,request:async()=>{requests++;return lengthReply()}}),{code:'AGENT_OUTPUT_LIMIT'});
 assert.equal(requests,2,'unchanged output exhaustion is not an infinite paid retry loop');
 assert.equal(checkpoint.usage.totalTokens,16);
 requests=0;
 await assert.rejects(runComposerToolLoop({body:{input:[{role:'user',content:'save'}]},protocol:'responses',runtime,request:async()=>{requests++;return new Response(JSON.stringify({status:'incomplete',incomplete_details:{reason:'content_filter'},usage:{input_tokens:5,output_tokens:3,total_tokens:8}}))}}),{code:'AGENT_RESPONSE_INCOMPLETE',incompleteReason:'content_filter'});
 assert.equal(requests,1,'a provider refusal must not be treated as a batch size problem');
 const parsed=await readToolResponse(sse([{type:'response.incomplete',response:{status:'incomplete',incomplete_details:{reason:'max_output_tokens'},output:[],usage:{input_tokens:5,output_tokens:3,total_tokens:8}}}]),'responses');
 assert.equal(parsed.incompleteReason,'max_output_tokens');assert.equal(parsed.usage.total_tokens,8);
});

for(const protocol of ['chat_completions','responses']) test(`${protocol}: identical preparation arguments start later saved batches without requiring a model-authored plan`,async()=>{
 const {runtime,journal,checkpoints}=batchRuntime();delete runtime.task;
 runtime.specs.push({name:'prepare_capture',parameters:{type:'object',properties:{requestId:{type:'string'},url:{type:'string'}},required:['requestId','url']}});
 let prepared=0,requests=0;
 const execute=runtime.execute;runtime.execute=async(name,args)=>name==='prepare_capture'
  ? {data:{captureId:'batch-'+(++prepared),revision:1,state:'preview'}} : execute(name,args);
 const response=(calls=[])=>protocol==='responses'?new Response(JSON.stringify({status:'completed',output:calls.length?calls.map(c=>({type:'function_call',call_id:c.id,name:c.function.name,arguments:c.function.arguments})):[{type:'message',content:[{type:'output_text',text:'done'}]}]})):chat({role:'assistant',content:calls.length?'':'done',...(calls.length?{tool_calls:calls}:{})});
 await runComposerToolLoop({protocol,body:protocol==='responses'?{model:'fixture-model',input:[{role:'user',content:'Save all requested modules'}]}:body(),runtime,
  request:async()=>{const index=requests++;return response(index<104?[{id:'step-'+index,type:'function',function:{name:index%2?'save_capture':'prepare_capture',arguments:JSON.stringify(index%2?{captureId:'batch-'+prepared}:{requestId:'prepare-again',url:'https://example.test/effects'})}}]:[]);}});
 assert.equal(prepared,52);assert.equal(requests,105);assert.equal(journal.filter(r=>r.name==='save_capture').length,52);
 assert.equal(checkpoints.length,1,'real save progress can continue across a default segment without an optional plan tool');
});

test('preparing an unchanged preview still stops on repeated observed lack of progress',async()=>{
 let requests=0,executions=0;
 const runtime={specs:[{name:'prepare_capture',parameters:{type:'object',properties:{},additionalProperties:true}}],execute:async()=>{executions++;return {data:{captureId:'unchanged',revision:1,state:'preview'}};}};
 await assert.rejects(runComposerToolLoop({protocol:'chat_completions',body:body(),runtime,request:async()=>chat({role:'assistant',tool_calls:[{id:'prepare-'+(++requests),type:'function',function:{name:'prepare_capture',arguments:'{}'}}]})}),/没有进展/);
 assert.equal(executions,3,'preparation is checked against current preview facts instead of blocked as a repeated library mutation');
 assert.equal(requests,3);
});
