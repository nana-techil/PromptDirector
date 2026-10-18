import test from 'node:test';
import assert from 'node:assert/strict';
import { runComposerToolLoop } from '../extension/composer-tool-loop.js';
import { createAgentContextRuntime, AGENT_CONTEXT_READ_SPEC, readAgentToolResult } from '../extension/agent-runtime-context.js';
const call=(id,name,args={})=>({id,type:'function',function:{name,arguments:JSON.stringify(args)}});
const response=calls=>new Response(JSON.stringify({choices:[{message:{role:'assistant',content:calls.length?'':'Saved.',...(calls.length?{tool_calls:calls}:{})}}]}));
for(const protocol of ['chat_completions','responses'])test(`${protocol}: current working sources stay readable until there is actual context pressure`,async()=>{
  let state={},requests=0;const sources=['source A\n'.repeat(1000),'source B\n'.repeat(1000)],bodies=[];
  const durable=createAgentContextRuntime({turnId:'batch-user',load:async()=>state,update:async transform=>{state=transform(state);}});
  const runtime={...durable,specs:[{name:'read_source',parameters:{properties:{index:{type:'integer'}}}},{name:'save_capture',parameters:{properties:{requestId:{}}}},AGENT_CONTEXT_READ_SPEC],execute:async(name,args)=>
    ({data:name==='read_tool_result'?readAgentToolResult(state.toolContext,args):name==='read_source'?{content:sources[args.index],revision:args.index}:{ok:true,entryId:'saved'}})};
  const batches=[[call('first','read_source',{index:0})],[call('second','read_source',{index:1})], [call('get-original','read_tool_result',{callId:'first',turnId:'batch-user',path:['data','content']})],[call('save','save_capture',{requestId:'batch-save'})],[]];
  await runComposerToolLoop({body:{model:'fixture',...(protocol==='responses'?{input:[{role:'user',content:'Save separate modules'}]}:{messages:[{role:'user',content:'Save separate modules'}]})},protocol,runtime,request:async body=>{
    bodies.push(structuredClone(body));const calls=batches[requests++];
    return protocol==='responses'?new Response(JSON.stringify({status:'completed',output:calls.map(c=>({type:'function_call',call_id:c.id,name:c.function.name,arguments:c.function.arguments})),output_text:calls.length?'':'Saved.'})):response(calls);
  }});
  const outputs=body=>(protocol==='responses'?body.input.filter(x=>x.type==='function_call_output').map(x=>({id:x.call_id,data:JSON.parse(x.output)})):body.messages.filter(x=>x.role==='tool').map(x=>({id:x.tool_call_id,data:JSON.parse(x.content)})));
  const third=outputs(bodies[2]);
  assert.equal(third.find(x=>x.id==='first').data.content,sources[0],'do not hide material that still fits the context and force rereads');
  assert.equal(third.find(x=>x.id==='second').data.content,sources[1],'the current batch remains full');
  assert.equal(outputs(bodies[3]).find(x=>x.id==='get-original').data.content,sources[0],'a requested original must remain full in the next model call');
  assert.equal(state.toolContext.find(x=>x.callId==='first').data.content,sources[0]);
});

test('native preview arguments keep their schema and full originals across later calls',async()=>{
 let state={},requests=0;const html='<button>Actual preview</button>'.repeat(1000),bodies=[];
 const durable=createAgentContextRuntime({turnId:'write-user',load:async()=>state,update:async transform=>{state=transform(state);}});
 const batches=[[call('preview-one','save_capture',{requestId:'one',html})],[call('preview-two','save_capture',{requestId:'two',html})],[]];
 await runComposerToolLoop({body:{model:'fixture',messages:[{role:'user',content:'Save separate previews'}]},protocol:'chat_completions',runtime:{...durable,
  specs:[{name:'save_capture',parameters:{properties:{requestId:{},html:{}}}},AGENT_CONTEXT_READ_SPEC],execute:async()=>({data:{ok:true}})},request:async body=>{
   bodies.push(structuredClone(body));return response(batches[requests++]);
 }});
 const calls=bodies[2].messages.flatMap(message=>message.tool_calls||[]);
 const oldArgs=JSON.parse(calls.find(c=>c.id==='preview-one').function.arguments);
 assert.equal(oldArgs.html,html);
 assert.equal(readAgentToolResult(state.toolContext,{callId:'preview-one',path:['args','html']}).content,html);
 assert.equal(JSON.parse(calls.find(c=>c.id==='preview-two').function.arguments).html,html);
});

test('resuming a batch keeps complete provider checkpoints and current working sources',async()=>{
 let state={},requests=0;const original='Frozen source\n'.repeat(500);
 const durable=createAgentContextRuntime({turnId:'resume-user',load:async()=>state,update:async transform=>{state=transform(state);}});
 const runtime={...durable,specs:[{name:'read_source',parameters:{properties:{index:{type:'integer'}}}},AGENT_CONTEXT_READ_SPEC],execute:async()=>({data:{content:original}})};
 const body={model:'fixture',messages:[{role:'user',content:'Save effects'}]};
 await assert.rejects(runComposerToolLoop({body,protocol:'chat_completions',runtime,request:async()=>{
  if(++requests===3)throw Error('connection interrupted');return response([call('source-'+requests,'read_source',{index:requests})]);
 }}),/connection interrupted/);
 const checkpoint=state.toolContinuations['resume-user'];
 assert.equal(JSON.parse(checkpoint.body.messages.find(m=>m.tool_call_id==='source-1').content).content,original);
 await runComposerToolLoop({body,protocol:'chat_completions',runtime:{...runtime,specs:[{name:'read_source',parameters:{properties:{query:{type:'string'}}}},AGENT_CONTEXT_READ_SPEC],execute:()=>assert.fail('resume must not replay reads or writes')},request:async actual=>{
  assert(actual.tools.find(tool=>tool.function.name==='read_source').function.parameters.properties.query,'resume must expose current tool schemas');
  assert.equal(JSON.parse(actual.messages.find(m=>m.tool_call_id==='source-1').content).content,original);
  assert.equal(JSON.parse(actual.messages.find(m=>m.tool_call_id==='source-2').content).content,original);
  return response([]);
 }});
 assert.equal(state.toolContext.find(record=>record.callId==='source-1').data.content,original);
 assert.equal(state.toolContinuations['resume-user'],undefined);
});
