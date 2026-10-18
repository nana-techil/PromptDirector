import test from 'node:test';
import assert from 'node:assert/strict';
import { projectCaptureHandoff } from '../extension/agent-capture-handoff.js';
import { readAgentToolResult } from '../extension/agent-runtime-context.js';

for (const protocol of ['chat_completions', 'responses']) test(`${protocol}: completed source and generated HTML leave working context, remain readable, pending batch stays exact`, () => {
  const original = '<html>full original preview</html>'.repeat(500);
  const records = [
    {callId:'old',turnId:'turn',name:'update_capture',args:{captureId:'closed',candidates:[{id:'effect',title:'Original effect',codePreview:{html:original},textSources:[{selector:'#effect',target:'prompt'}]}]},data:{captureId:'closed'}},
    {callId:'save',turnId:'turn',name:'save_capture',args:{captureId:'closed',project:'project-a'},data:{captureId:'closed',state:'completed',results:[{candidateId:'effect',entryId:'saved-effect',status:'saved'}]}},
    {callId:'next',turnId:'turn',name:'update_capture',args:{captureId:'working',candidates:[{id:'next',codePreview:{html:original}}]},data:{captureId:'working'}}
  ];
  const pair = record => protocol === 'responses'
    ? [{type:'function_call',call_id:record.callId,name:record.name,arguments:JSON.stringify(record.args)},{type:'function_call_output',call_id:record.callId,output:JSON.stringify(record.data)}]
    : [{role:'assistant',tool_calls:[{id:record.callId,type:'function',function:{name:record.name,arguments:JSON.stringify(record.args)}}]},{role:'tool',tool_call_id:record.callId,content:JSON.stringify(record.data)}];
  const key = protocol === 'responses' ? 'input' : 'messages';
  const body = {[key]:[{role:'user',content:'Save all into project-a'},...records.flatMap(pair)]};
  const snapshot = structuredClone(body);
  const projected = projectCaptureHandoff(body,protocol,records,{goal:'all effects',state:'active'});
  assert.deepEqual(body,snapshot,'provider original/checkpoint is not modified');
  assert.deepEqual(projected[key].slice(-2),pair(records.at(-1)),'current batch is not indexed away');
  assert(!projected[key].some(item => item.tool_call_id === 'old' || item.call_id === 'old'));
  assert(JSON.stringify(projected).includes('saved-effect'));
  assert(JSON.stringify(projected).includes('project-a'));
  assert.equal(readAgentToolResult(records,{callId:'old',turnId:'turn',path:['args','candidates','0','codePreview','html'],length:original.length}).content,original);
  const partial = records.map(record => record.callId === 'save' ? {...record,data:{...record.data,state:'preview'}} : record);
  assert.strictEqual(projectCaptureHandoff(body,protocol,partial),body,'partial batch stays fully available for repair');
  assert(JSON.stringify(projected).length < JSON.stringify(body).length * .7);
});

test('mixed messages and unmatched calls never lose their native pairing', () => {
  const records=[{callId:'old',name:'read_capture',args:{captureId:'closed'},data:{}},{name:'save_capture',data:{captureId:'closed',state:'completed',results:[{entryId:'saved',status:'saved'}]}}];
  const body={messages:[{role:'assistant',tool_calls:[{id:'old'},{id:'still-working'}]},{role:'tool',tool_call_id:'old',content:'{}'}]};
  assert.strictEqual(projectCaptureHandoff(body,'chat_completions',records),body);
  const pending={messages:[{role:'assistant',tool_calls:[{id:'old'}]}]};
  assert.strictEqual(projectCaptureHandoff(pending,'chat_completions',records),pending);
});

for (const protocol of ['chat_completions', 'responses']) test(`${protocol}: reading the next module after a save keeps fresh sources, revision errors and recovery state visible`, () => {
  const records = [
    {callId:'prepared',name:'prepare_capture',args:{},data:{captureId:'batch',revision:1}},
    {callId:'saved',name:'save_capture',args:{captureId:'batch'},data:{captureId:'batch',revision:4,state:'completed',results:[{entryId:'saved-effect',status:'saved'}]}},
    {callId:'next-source',name:'read_capture',args:{captureId:'batch',part:'source',selector:'#next pre'},data:{captureId:'batch',revision:4,content:'next module original code'}},
    {callId:'stale-read',name:'read_capture',args:{captureId:'batch',part:'source',expectedRevision:1},data:{ok:false,code:'capture_changed',message:'Read current revision'}},
    {callId:'current-state',name:'read_capture',args:{captureId:'batch',part:'summary'},data:{captureId:'batch',revision:4,state:'completed'}}
  ];
  const pair = record => protocol === 'responses'
    ? [{type:'function_call',call_id:record.callId,name:record.name,arguments:JSON.stringify(record.args)},{type:'function_call_output',call_id:record.callId,output:JSON.stringify(record.data)}]
    : [{role:'assistant',tool_calls:[{id:record.callId,type:'function',function:{name:record.name,arguments:JSON.stringify(record.args)}}]},{role:'tool',tool_call_id:record.callId,content:JSON.stringify(record.data)}];
  const key = protocol === 'responses' ? 'input' : 'messages';
  const body = {[key]:records.flatMap(pair)};
  const projected = projectCaptureHandoff(body,protocol,records);
  assert.deepEqual(projected[key].slice(-6),records.slice(2).flatMap(pair), 'post-save work is not part of the committed transaction');
  assert(!projected[key].some(item => (item.call_id || item.tool_call_id) === 'prepared'),'committed inputs still leave working context');
  assert.deepEqual(body[key],records.flatMap(pair),'full provider history stays intact');
});
