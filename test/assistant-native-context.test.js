import test from 'node:test';
import assert from 'node:assert/strict';
import {agentContextReferences, createAgentContextRuntime, AGENT_CONTEXT_READ_SPEC} from '../extension/agent-runtime-context.js';
import {runComposerToolLoop} from '../extension/composer-tool-loop.js';
const tool=(id,name,args)=>({id,type:'function',function:{name,arguments:JSON.stringify(args)}});
const response=calls=>new Response(JSON.stringify({usage:{prompt_tokens:20,completion_tokens:5,total_tokens:25},choices:[{message:{role:'assistant',content:calls.length?'':'Done',...(calls.length?{tool_calls:calls}:{})}}]}));
test('history retains discoverable module and project identities without altering native write arguments',()=>{
 const args={candidates:[{id:'effect-a',title:'A',codePreview:{html:'<button>A</button>'.repeat(200)}}]};
 const modules=Array.from({length:153},(_,i)=>({id:'module-'+i,title:'Effect '+i,selector:'#effect-'+i,sources:[{selector:'#effect-'+i+' pre'}]}));
 const rows=agentContextReferences([{callId:'write',args,data:{ok:true}},{callId:'directory',data:{modules}},{callId:'projects',name:'read_projects',data:{content:JSON.stringify([{id:'project-a',name:'Motion',caseCount:0}])}}]);
 assert.deepEqual(rows[0].args,args,'model must never see an invented candidatesReference as a native tool argument');
 assert.deepEqual(rows[1].data.modules,modules,'a complete directory remains usable after the next tool call');
 assert.equal(rows[2].data.content,JSON.stringify([{id:'project-a',name:'Motion',caseCount:0}]));
});
test('invalid reference-shaped model input is rejected before a write, and can be corrected',async()=>{
 let n=0,writes=0,state={};const durable=createAgentContextRuntime({turnId:'human',load:async()=>state,update:async fn=>state=fn(state)});
 const spec={name:'update_capture',parameters:{type:'object',properties:{candidates:{type:'array',items:{type:'string'}}},required:['candidates'],additionalProperties:false}};
 const bodies=[];
 await runComposerToolLoop({body:{model:'test',messages:[{role:'user',content:'Save these effects'}]},protocol:'chat_completions',runtime:{...durable,specs:[spec,AGENT_CONTEXT_READ_SPEC],execute:async()=>{writes++;return {data:{ok:true}};}},request:async body=>{bodies.push(structuredClone(body));return response(n++===0?[tool('invalid','update_capture',{candidatesCount:2,candidatesReference:{callId:'old'}})]:n===2?[tool('valid','update_capture',{candidates:['a','b']})]:[]);}});
 assert.equal(writes,1);assert.equal(JSON.parse(bodies[1].messages.find(m=>m.tool_call_id==='invalid').content).code,'invalid_tool_arguments');
});
test('context window is not a cumulative billing allowance; explicit execution budget is respected',async()=>{
 let n=0;const options={body:{model:'test',messages:[{role:'user',content:'Read then answer'}]},protocol:'chat_completions',runtime:{contextLength:10,specs:[{name:'read_source',parameters:{type:'object',properties:{},additionalProperties:false}}],execute:async()=>({data:{ok:true}})},request:async()=>response(n++===0?[tool('read','read_source',{})]:[])};
 await runComposerToolLoop(options);assert.equal(n,2);
 n=0;await assert.rejects(runComposerToolLoop({...options,budget:{maxTotalTokens:20}}),/累计模型工作预算/);
});

test('ordinary answers and authorized direct actions do not require model-authored permission paperwork',async()=>{
 const {withAssistantTaskRuntime}=await import('../extension/assistant-task.js');
 let writes=0;
 const runtime=withAssistantTaskRuntime({specs:[{name:'save_material',parameters:{type:'object',properties:{requestId:{type:'string'}}}}],execute:async()=>{writes++;return {data:{ok:true,entryId:'saved'}};}},{instruction:'Keep this source as a case'});
 assert.equal((await runtime.execute('save_material',{requestId:'save'})).data.ok,true);
 assert.equal(writes,1);assert.equal(await runtime.finishTurn({content:'Saved'}),undefined);
});

test('source-backed code updates need not invent empty text or media fields',async()=>{
 const {CAPTURE_OPERATION_SPECS}=await import('../extension/capture-operation-specs.js');
 const {validate}=await import('../extension/case-operation-specs.js');
 const schema=CAPTURE_OPERATION_SPECS.find(s=>s.name==='update_capture').parameters;
 assert.doesNotThrow(()=>validate(schema,{requestId:'source-case',captureId:'capture',expectedRevision:1,candidates:[{id:'effect',title:'Effect',canonicalUrl:'https://example.test/',textSources:[{selector:'pre',target:'text'}],codePreview:{html:'<button>Effect</button>'}}]},'update_capture'));
 assert.throws(()=>validate(schema,{requestId:'source-case',captureId:'capture',expectedRevision:1,candidatesReference:{callId:'old'}},'update_capture'),/不支持/);
});

test('context pressure offloads old originals without creating references to references',async()=>{
 let state={},n=0;const original='original '.repeat(1000),bodies=[];
 const durable=createAgentContextRuntime({turnId:'pressure',load:async()=>state,update:async fn=>state=fn(state)});
 const spec={name:'read_source',parameters:{type:'object',properties:{index:{type:'integer'}},required:['index'],additionalProperties:false}};
 await runComposerToolLoop({body:{model:'test',messages:[{role:'user',content:'Read the source'}]},protocol:'chat_completions',runtime:{...durable,contextLength:1,specs:[spec,AGENT_CONTEXT_READ_SPEC],execute:async()=>({data:{content:original}})},request:async body=>{
 bodies.push(structuredClone(body));return response(n++===0?[tool('source','read_source',{index:0})]:n===2?[tool('original','read_tool_result',{callId:'source',path:['data','content']})]:n===3?[tool('next','read_source',{index:1})]:[]);
 }});
 const output=id=>JSON.parse(bodies.at(-1).messages.find(m=>m.tool_call_id===id).content);
 assert(output('source').contentReference);
 assert.equal(output('original').content,original,'explicit original retrieval must not turn into an endless reference chain');
});
