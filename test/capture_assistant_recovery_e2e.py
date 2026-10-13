"""Closed-tab recovery through native assistant tools and real save/readback.

Provider decisions are scripted; browser tabs, source reads and library writes
use production services in a disposable profile. No model API is called.
"""
import json
import tempfile
import threading
from pathlib import Path
from http.server import ThreadingHTTPServer
from capture_batch_inventory_e2e import Server
from e2e_support import EXTENSION_DIR, extension_session


def main():
    server = ThreadingHTTPServer(('127.0.0.1', 0), Server)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    url = f'http://127.0.0.1:{server.server_port}/'
    try:
        with tempfile.TemporaryDirectory(prefix='pd-recovery-extension-') as tmp:
            ext = Path(tmp)
            for path in EXTENSION_DIR.iterdir():
                if path.name not in ['manifest.json', 'background.js']:
                    (ext / path.name).symlink_to(path, target_is_directory=path.is_dir())
            manifest = json.loads((EXTENSION_DIR / 'manifest.json').read_text())
            manifest['host_permissions'].append(url + '*')
            (ext / 'manifest.json').write_text(json.dumps(manifest))
            (ext / 'background.js').write_text((EXTENSION_DIR / 'background.js').read_text() + '''
import { runCaptureAssistant as recoveryAssistant } from './capture-assistant.js';
import { runComposerToolLoop as recoveryLoop } from './composer-tool-loop.js';
globalThis.agentTestDispatch=dispatchAgentOperation;
globalThis.recoveryAssistant=recoveryAssistant;globalThis.recoveryLoop=recoveryLoop;
''')
            with extension_session('pd-recovery-', extension_dir=ext) as run:
                panel = run.open_page('collector.html')
                run.seed_storage(panel, {'entries': []})
                page = run.context.new_page()
                page.goto(url)
                tab = panel.evaluate('async url=>(await chrome.tabs.query({})).find(t=>t.url===url).id', url)
                worker = run.context.service_workers[0]
                old = worker.evaluate('''async tab => {
                  let r=await agentTestDispatch('prepare_capture',{requestId:'old-draft',tabId:tab});
                  while(['queued','running'].includes(r.state))r=await agentTestDispatch('get_task',{requestId:'old-draft',waitMs:1000});
                  if(r.state!=='completed')throw new Error(JSON.stringify(r));
                  return r.result;
                }''', tab)
                page.close()
                page = run.context.new_page()
                page.goto(url)
                page.add_style_tag(content='body { background: rgb(15, 15, 15); color: rgb(232, 232, 232); }')
                current = panel.evaluate('async url=>(await chrome.tabs.query({})).find(t=>t.url===url).id', url)
                proof = worker.evaluate('''async ({url,current,old}) => {
                  const runCaptureAssistant=globalThis.recoveryAssistant;
                  const runComposerToolLoop=globalThis.recoveryLoop;
                  let stage=0, fresh, source, selected;
                  const expect=(condition,message)=>{if(!condition)throw new Error(message);};
                  const plan={mode:'act',goal:'Save requested independent effect',steps:[
                    {operation:'read_capture',targetId:old.captureId,part:'source'},
                    {operation:'update_capture',targetId:old.captureId},
                    {operation:'save_capture',targetId:old.captureId}]};
                  const result=await runCaptureAssistant({tabId:current,sourceUrl:url,captureId:old.captureId,
                    instruction:'Save the first effect with its full source',userMessageId:'user'}, {
                    runtime:{aiTaskAssignments:{creativePlanning:{providerId:'deepseek',model:'deepseek-flash'}},aiSettings:{apiKey:'fixture',consent:true}},
                    signal:new AbortController().signal,call:agentTestDispatch,
                    execute:async (_r,_s,_i,{toolRuntime})=>{
                      const output=await runComposerToolLoop({runtime:toolRuntime,protocol:'chat_completions',
                        body:{model:'fixture',messages:[{role:'user',content:'Save the first effect with its full source'}]},
                        request:async body=>{
                          const last=body.messages.findLast(m=>m.role==='tool');
                          const data=last?JSON.parse(last.content):null;
                          let calls=[];
                          const call=(name,args)=>({id:'call-'+stage+'-'+calls.length,type:'function',function:{name,arguments:JSON.stringify(args)}});
                          if(stage===0){calls.push(call('declare_task',plan));calls.push(call('read_capture',{captureId:old.captureId,part:'source',selector:'#effect-1 pre'}));}
                          else if(stage===1){expect(data.ok===false,'closed tab must really fail');calls.push(call('prepare_capture',{requestId:'recover',tabId:current}));}
                          else if(stage===2){fresh=data;expect(fresh.captureId!==old.captureId&&fresh.tabId===current,'stale preview reused');calls.push(call('read_capture',{captureId:fresh.captureId,part:'modules'}));}
                          else if(stage===3){expect(data.inventoryProgress?.complete&&data.inventoryProgress.read===3,'directory completion was not exposed');calls.push(call('read_capture',{captureId:fresh.captureId,part:'modules'}));}
                          else if(stage===4){const feedback=JSON.parse(body.messages.at(-1).content);expect(feedback.runtimeFeedback?.status==='unchanged_tool_results','no corrective feedback before stop');calls.push(call('read_capture',{captureId:fresh.captureId,part:'source',selectors:['#effect-1 pre[data-lang="CSS"]','#effect-1 pre[data-lang="Prompt"]']}));}
                          else if(stage===5){source=data;expect(source.appearance?.page?.body?.['background-color']==='rgb(15, 15, 15)','source background was guessed or omitted');calls.push(call('update_capture',{requestId:'select',captureId:fresh.captureId,expectedRevision:data.revision,candidates:[{id:'effect-1',title:'Effect 1',canonicalUrl:url,textSources:data.sources.map(s=>({selector:s.selector,target:'text'})),codePreview:{html:'<button onclick="this.textContent=String(Number(this.textContent)+1)">0</button>'}}],selections:[{candidateId:'effect-1',includeText:true,selectedMediaIds:[]}]}));}
                          else if(stage===6){selected=data;expect(data.ok===true,'update must follow new capture identity');calls.push(call('save_capture',{requestId:'save',captureId:fresh.captureId,expectedRevision:data.revision,contentTypeId:'content:code-case',saveMode:'combined'}));}
                          else if(stage===7){expect(data.results?.[0]?.status==='saved','real save receipt required');expect(data.results[0].originalVerification?.status==='verified','combined save lost original code');}
                          else throw new Error('recovery did not finish');
                          stage++;
                          return new Response(JSON.stringify({choices:[{message:{role:'assistant',content:calls.length?'':'Saved.',...(calls.length?{tool_calls:calls}:{})}}]}));
                        }});
                      return {text:output.content};
                    }});
                  expect(result.ok,result.message);
                  expect(result.taskState==='completed','pending plan still bound to dead tab');
                  const kept=await agentTestDispatch('read_capture',{captureId:old.captureId});
                  expect(kept.revision===old.revision&&kept.tabId===old.tabId,'old draft was overwritten');
                  return {result,source,oldRetained:true,providerRequests:stage};
                }''', {'url': url, 'current': current, 'old': old})
                state = panel.evaluate("async()=>chrome.runtime.sendMessage({type:'GET_STATE'})")
                assert len(state['entries']) == 1
                entry = state['entries'][0]
                assert entry['contentRole'] == 'code_case'
                assert all(s['content'] in entry['text'] for s in proof['source']['sources'])
                assert 'promptdirector-preview-html' in entry['text']
                print(json.dumps({'saved': 1, 'fullSources': 2, 'closedTabReplaced': True, 'oldDraftRetained': proof['oldRetained'],
                                  'taskCompleted': True, 'directoryProgressAndRecoveryFeedback': True, 'combinedCodeOriginalsVerified': True, 'sourceAppearanceObserved': True, 'scriptedProviderRequests': proof['providerRequests'], 'paidApiCalls': 0, 'realLibraryWrites': 0}))
    finally:
        server.shutdown()


if __name__ == '__main__':
    main()
