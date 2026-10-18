import test from 'node:test';
import assert from 'node:assert/strict';
import { applyComposerConversation } from '../extension/composer-conversation.js';
import { runComposerToolLoop } from '../extension/composer-tool-loop.js';

for (const protocol of ['chat_completions','responses']) for (const resumed of [false,true]) {
  test(`${protocol}: assistant routing stays executable${resumed?' after restoring an older checkpoint':''}`, async () => {
    const key=protocol==='responses'?'input':'messages', type=protocol==='responses'?'input_text':'text';
    const body={model:'fixture',[key]:[{role:'user',content:[{type,text:''}]}]};
    applyComposerConversation(body,{routeMode:'chat',route:'chat',taskMethod:'Discuss only',agentVersion:'fixture',methodVersion:'fixture',
      references:[{id:'source'}],instruction:'核对后继续',messages:[{role:'user',content:'Save all modules'},{role:'assistant',content:'Ready'},{role:'user',content:'核对后继续'}]},protocol);
    const checkpoint=structuredClone(body);
    checkpoint[key].at(-1).content.unshift({type,text:JSON.stringify({untrustedToolEvidence:[]})});
    await runComposerToolLoop({body,protocol,continuation:resumed?{protocol,body:checkpoint}:undefined,
      runtime:{systemInstruction:'Use actual tools to fulfill the user request',specs:[],execute:()=>assert.fail('no requested action in this transport fixture')},
      request:async sent=>{
        const parts=sent[key].findLast(m=>Array.isArray(m.content)).content;
        const context=parts.map(p=>{try{return JSON.parse(p.text)}catch{return null}}).find(p=>p?.agentVersion);
        assert.equal(context.taskMethod,undefined);assert.equal(context.routeMode,undefined);assert.equal(context.route,undefined);
        assert.deepEqual(context.references,[{id:'source'}]);assert.equal(parts.at(-1).text,'核对后继续');
        return new Response(JSON.stringify(protocol==='responses'?{status:'completed',output_text:'Ready',output:[]}:{choices:[{message:{role:'assistant',content:'Ready'},finish_reason:'stop'}]}));
      }});
    assert.equal(JSON.parse(body[key].at(-1).content[0].text).route,'chat','the original journal is preserved');
  });
}

test('normal composer routing remains intact without an assistant policy override',async()=>{
  const body={model:'fixture',messages:[{role:'user',content:[{type:'text',text:JSON.stringify({routeMode:'chat',route:'chat',taskMethod:'Discuss only',agentVersion:'fixture',methodVersion:'fixture'})}]}]};
  await runComposerToolLoop({body,protocol:'chat_completions',runtime:{specs:[]},request:async sent=>{
    assert.equal(JSON.parse(sent.messages[0].content[0].text).taskMethod,'Discuss only');
    return new Response(JSON.stringify({choices:[{message:{role:'assistant',content:'Answer'},finish_reason:'stop'}]}));
  }});
});
