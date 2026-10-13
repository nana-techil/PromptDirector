"""More than one default Agent work segment, real multi-case saves, no paid API."""
import json, tempfile, threading, time
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from e2e_support import EXTENSION_DIR, extension_session

COUNT = 52  # Two cases per test transaction require >100 native requests.
HTML = '<!doctype html><title>Batch effects</title><main>' + ''.join(
    f'<article id="effect-{i}"><h2>Effect {i}</h2><pre>.effect-{i}:hover {{ transform: scale(1.1); }}</pre></article>'
    for i in range(COUNT)) + '</main>'
class Server(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200);self.send_header('Content-Type','text/html');self.end_headers();self.wfile.write(HTML.encode())
    def log_message(self,*_): pass

def main():
    server=ThreadingHTTPServer(('127.0.0.1',0),Server);threading.Thread(target=server.serve_forever,daemon=True).start()
    url=f'http://127.0.0.1:{server.server_port}/'
    try:
        with tempfile.TemporaryDirectory(prefix='pd-long-batch-') as tmp:
            ext=Path(tmp)
            for path in EXTENSION_DIR.iterdir():
                if path.name not in ['manifest.json','background.js']:(ext/path.name).symlink_to(path,target_is_directory=path.is_dir())
            manifest=json.loads((EXTENSION_DIR/'manifest.json').read_text());manifest['host_permissions'].append(url+'*');(ext/'manifest.json').write_text(json.dumps(manifest))
            (ext/'background.js').write_text((EXTENSION_DIR/'background.js').read_text()+'''
import {runCaptureAssistant as longBatchAssistant} from './capture-assistant.js';
import {runComposerToolLoop} from './composer-tool-loop.js';
import {createAgentContextRuntime} from './agent-runtime-context.js';
globalThis.batchTest={runCaptureAssistant:longBatchAssistant,runComposerToolLoop,createAgentContextRuntime,call:dispatchAgentOperation};
''')
            with extension_session('pd-long-batch-',extension_dir=ext) as run:
                panel=run.open_page('collector.html');run.seed_storage(panel,{'entries':[]})
                page=run.context.new_page();page.goto(url)
                tab=panel.evaluate('async url=>(await chrome.tabs.query({})).find(t=>t.url===url).id',url)
                worker=run.context.service_workers[0]
                worker.on('console',lambda message: print(message.text,flush=True) if message.text.startswith('batch-test:') else None)
                worker.evaluate(r'''({url,tab,count})=>{
                  globalThis.longBatchPromise=(async()=>{
                  const {runCaptureAssistant,runComposerToolLoop,createAgentContextRuntime,call}=batchTest;
                  const expect=(yes,message)=>{if(!yes)throw new Error(message)};
                  let stage=0,checkpoints=0,journal={}; const sizes=[];
                  const sessionRuntime=createAgentContextRuntime({turnId:'long-batch-turn',load:async()=>journal,
                    update:async fn=>{journal=fn(journal);await chrome.storage.local.set({batchTestJournal:journal});}});
                  const save=sessionRuntime.saveContinuation;sessionRuntime.saveContinuation=async value=>{checkpoints++;await save(value)};
                  const ids=Array.from({length:count},(_,i)=>'effect-'+i);
                  const result=await runCaptureAssistant({instruction:'Save every effect as its own code case',sessionId:'long-batch',userMessageId:'long-batch-turn',sourceUrl:url,tabId:tab,pageTitle:'Batch effects',messages:[],aiProfile:{serviceId:'deepseek',model:'deepseek-chat'}},
                    {runtime:{aiSettings:{providerId:'deepseek',apiKey:'fixture',consent:true}},sessionRuntime,
                    signal:new AbortController().signal,call,
                    execute:async(_r,_s,_i,{toolRuntime})=>{
                      const output=await runComposerToolLoop({runtime:toolRuntime,protocol:'chat_completions',body:{model:'fixture',messages:[{role:'user',content:'Save every effect separately'}]},request:async body=>{
                        globalThis.longBatchStage=stage;sizes.push(JSON.stringify(body).length);
                        const latest=body.messages.findLast(m=>m.role==='tool');const data=latest?JSON.parse(latest.content):null;
                        if(data?.ok===false)throw new Error(JSON.stringify(data));
                        let calls=[];const tool=(name,args)=>calls.push({id:'call-'+stage,type:'function',function:{name,arguments:JSON.stringify(args)}});
                        if(stage===0)tool('declare_task',{mode:'act',goal:'Save all '+count+' independent effects',steps:[{operation:'prepare_capture'},{operation:'read_capture',part:'source'},{operation:'update_capture'},{operation:'save_capture',resultIds:ids}],contentTypeId:'content:code-case'});
                        else if(stage<=count*2){
                          const batch=Math.floor((stage-1)/4);const phase=(stage-1)%4;const current=ids.slice(batch*2,batch*2+2);
                          if(phase===0)tool('prepare_capture',{requestId:'prepare-'+batch,url});
                          if(phase===1){expect(data.tabId===tab,'batch opened another tab');tool('read_capture',{captureId:data.captureId,part:'source',selectors:current.map(id=>'#'+id+' pre')});}
                          if(phase===2)tool('update_capture',{requestId:'select-'+batch,captureId:data.captureId,expectedRevision:data.revision,candidates:current.map(id=>({id,title:id,canonicalUrl:url,textSources:[{selector:'#'+id+' pre',target:'text'}],codePreview:{html:'<style>button:hover{transform:scale(1.1)}</style><button>'+id+'</button>'}})),selections:current.map(candidateId=>({candidateId,includeText:true,selectedMediaIds:[]})),saveMode:'multiple'});
                          if(phase===3)tool('save_capture',{requestId:'save-'+batch,captureId:data.captureId,expectedRevision:data.revision,contentTypeId:'content:code-case'});
                        }
                        stage++;return new Response(JSON.stringify({choices:[{message:{role:'assistant',content:calls.length?'':'All requested effects saved',...(calls.length?{tool_calls:calls}:{})}}],usage:{prompt_tokens:10,completion_tokens:2,total_tokens:12}}));
                      }});
                      expect(output.requestCount===count*2+2,'unexpected request count');expect(output.usage.totalTokens===output.requestCount*12,'usage reset at checkpoint');return {text:output.content};
                    }});
                  expect(result.ok,result.message);expect(result.taskState==='completed','target ledger incomplete');
                  const receipts=journal.toolContext.filter(r=>r.name==='save_capture');
                  expect(receipts.flatMap(r=>r.data.results).length===count,'missing receipts');
                  expect(receipts.every(r=>r.data.results.every(i=>i.originalVerification.status==='verified')),'unverified originals');
                  const tabs=(await chrome.tabs.query({})).filter(t=>t.url===url);
                  expect(tabs.length===1,'source tab multiplication');
                  return {requests:stage,checkpoints,sourceTabs:tabs.length,receipts:receipts.length,journalRecords:journal.toolContext.length,requestCharacters:sizes};
                  })();globalThis.longBatchDone=false;longBatchPromise.finally(()=>longBatchDone=true).catch(()=>{});
                }''',{'url':url,'tab':tab,'count':COUNT})
                last=None;started=time.monotonic()
                while not worker.evaluate('Boolean(globalThis.longBatchDone)'):
                    stage=worker.evaluate('globalThis.longBatchStage')
                    if stage!=last: print('batch-test:'+str(stage),flush=True);last=stage
                    assert time.monotonic()-started<240, {'stalledStage':stage}
                    page.wait_for_timeout(250)
                proof=worker.evaluate('longBatchPromise')
                entries=panel.evaluate("async()=>(await chrome.runtime.sendMessage({type:'GET_STATE'})).entries")
                assert len(entries)==COUNT, len(entries)
                for i in range(COUNT):
                    entry=next(item for item in entries if item['title']==f'effect-{i}')
                    assert f'.effect-{i}:hover {{ transform: scale(1.1); }}' in entry['text']
                    assert entry['contentRole']=='code_case'
                assert proof['checkpoints']==1,proof
                assert not run.page_errors,run.page_errors
                print(json.dumps({**proof,'savedReadback':len(entries),'paidApiCalls':0,'realLibraryWrites':0}))
    finally: server.shutdown()
if __name__=='__main__': main()
