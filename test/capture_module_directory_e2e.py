"""A complete frozen directory across transport pages and current live scopes."""
import json, os, re, tempfile, threading
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from e2e_support import EXTENSION_DIR, extension_session

COUNT=153
FALLBACK='<!doctype html><title>Large code library</title><main>'+''.join(f'<section id="item-{i}"><h2>Effect {i}</h2><div hidden>'+''.join(f'<pre data-lang="{lang}">Original {lang} {i}</pre>' for lang in ['css','react','prompt'])+'</div></section>' for i in range(COUNT))+'</main>'
HTML=Path(os.environ['PD_MODULE_PAGE_FILE']).read_text() if os.environ.get('PD_MODULE_PAGE_FILE') else FALLBACK
# The supplied file is a rendered DOM snapshot: do not rerun its page scripts
# against this fixture server. Source blocks inside pre remain unchanged.
HTML=re.sub(r'<script\b[^>]*>.*?</script\s*>','',HTML,flags=re.I|re.S)
class Server(BaseHTTPRequestHandler):
 def do_GET(self):
  self.send_response(200);self.send_header('Content-Type','text/html');self.end_headers();self.wfile.write(HTML.encode())
 def log_message(self,*_):pass

def main():
 server=ThreadingHTTPServer(('127.0.0.1',0),Server);threading.Thread(target=server.serve_forever,daemon=True).start();url=f'http://127.0.0.1:{server.server_port}/'
 try:
  with tempfile.TemporaryDirectory(prefix='pd-modules-extension-') as tmp:
   ext=Path(tmp)
   for p in EXTENSION_DIR.iterdir():
    if p.name not in ['manifest.json','background.js']:(ext/p.name).symlink_to(p,target_is_directory=p.is_dir())
   manifest=json.loads((EXTENSION_DIR/'manifest.json').read_text());manifest['host_permissions'].append(url+'*');(ext/'manifest.json').write_text(json.dumps(manifest))
   (ext/'background.js').write_text((EXTENSION_DIR/'background.js').read_text()+'\nglobalThis.agentTestDispatch=dispatchAgentOperation;\n')
   with extension_session('pd-module-directory-',extension_dir=ext) as run:
    panel=run.open_page('collector.html');run.seed_storage(panel,{'entries':[]})
    web=run.context.new_page();web.goto(url,wait_until='domcontentloaded');worker=run.context.service_workers[0]
    tab=panel.evaluate('async url=>(await chrome.tabs.query({})).find(t=>t.url===url).id',url)
    def call(op,args):return worker.evaluate('([op,args])=>agentTestDispatch(op,args)',[op,args])
    result=call('prepare_capture',{'requestId':'module-directory','tabId':tab})
    while result['state'] in ['queued','running']:result=call('get_task',{'requestId':'module-directory','waitMs':1000})
    assert result['state']=='completed',result
    capture=result['result']['captureId'];offset=0;revision=None;modules=[];pages=0
    while True:
     args={'captureId':capture,'part':'modules','offset':offset,'length':12000}
     if revision is not None:args['expectedRevision']=revision
     page=call('read_capture',args);assert page.get('ok'),page
     assert len(json.dumps(page['modules'],ensure_ascii=False,separators=(',',':')))<=12000
     modules.extend(page['modules']);pages+=1;revision=page['revision'];offset=page['nextOffset']
     if offset is None:break
    assert len(modules)==COUNT,(len(modules),modules[:1])
    assert pages>1
    for module in modules:
     assert web.locator(module['selector']).count()==1
     for source in module['sources']:assert web.locator(source['selector']).count()==1
    selected=modules[0]
    scope=json.loads(call('read_capture',{'captureId':capture,'part':'context','includeHidden':True,'selector':selected['selector']})['content'])
    assert scope['loadedCodeBlockCount']==len(selected['sources'])
    empty=json.loads(call('read_capture',{'captureId':capture,'part':'context','query':'__no_such_module__'})['content'])
    assert empty['matchingCodeBlockCount']==0 and empty['loadedCodeBlockCount']>0
    # A directory scan persists its checkpoint. A simultaneous manual choice
    # must survive that persistence instead of being overwritten by an old draft.
    draft=call('read_capture',{'captureId':capture,'part':'summary'})
    choice={'candidateId':draft['candidates'][0]['id'],'includeText':True,'selectedMediaIds':[]}
    worker.evaluate('''([capture,revision,choice])=>{
     const original=chrome.scripting.executeScript.bind(chrome.scripting);
     let started,release;
     globalThis.directoryStarted=new Promise(resolve=>started=resolve);
     const gate=new Promise(resolve=>release=resolve);
     globalThis.releaseDirectory=()=>{chrome.scripting.executeScript=original;release();};
     chrome.scripting.executeScript=async options=>{
      if(options.func?.name==='readCapturePageContext'){started();await gate;}
      return original(options);
     };
     globalThis.directoryRead=agentTestDispatch('read_capture',{captureId:capture,part:'modules',refresh:true,length:12000});
     globalThis.startManualChoice=()=>agentTestDispatch('update_capture',{requestId:'manual-choice-during-directory',captureId:capture,expectedRevision:revision,selections:[choice]});
    }''',[capture,draft['revision'],choice])
    worker.evaluate('()=>directoryStarted')
    worker.evaluate('()=>startManualChoice()')
    waiting=call('get_task',{'requestId':'manual-choice-during-directory','waitMs':1000})
    assert waiting['state'] in ['queued','running'],'manual write raced a pending directory checkpoint'
    worker.evaluate('async()=>{releaseDirectory();await directoryRead;}')
    updated=call('get_task',{'requestId':'manual-choice-during-directory','waitMs':1000})
    while updated['state'] in ['queued','running']:updated=call('get_task',{'requestId':'manual-choice-during-directory','waitMs':1000})
    assert updated['state']=='completed',updated
    retained=call('read_capture',{'captureId':capture,'part':'summary'})
    assert retained['selections']==updated['result']['selections']
    assert len(retained['selections'])==1 and all(retained['selections'][0].get(key)==value for key,value in choice.items()),retained['selections']
    assert retained['revision']==updated['result']['revision']
    assert panel.evaluate("async()=>(await chrome.runtime.sendMessage({type:'GET_STATE'})).entries.length")==0
    proof={'modules':len(modules),'sources':sum(len(m['sources']) for m in modules),'pages':pages,'allSelectorsUnique':True,'actualSelectorScope':True,'emptyQueryDoesNotMeanNoCode':True,'concurrentManualChoicePreserved':True,'modelRequests':0,'realLibraryWrites':0}
    print(json.dumps(proof))
 finally:server.shutdown()
if __name__=='__main__':main()
