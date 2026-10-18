"""Explicit module discovery and per-effect save/readback in a disposable library."""
import json, os, tempfile, threading
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from e2e_support import EXTENSION_DIR, extension_session

HTML='''<!doctype html><title>Motion reference</title><main><h1>Motion that has weight</h1><section><h2>Interaction</h2>'''+''.join(f'''<article id="effect-{i}"><div><div><div class="title">Try it</div></div></div><div><div><div><div class="name">Effect {i}</div></div><button class="event-name">View code</button></div></div><p>Independent animation {i}</p><div hidden><pre data-lang="CSS">.effect-{i}:hover {{ transform: scale({1+i/10}); }}</pre><pre data-lang="Prompt">Animate only effect {i}.</pre></div></article>''' for i in range(1,4))+'''</section></main>'''
class Server(BaseHTTPRequestHandler):
 def do_GET(self):
  self.send_response(200);self.send_header('Content-Type','text/html');self.end_headers();self.wfile.write(HTML.encode())
 def log_message(self,*_):pass

def main():
 server=ThreadingHTTPServer(('127.0.0.1',0),Server);threading.Thread(target=server.serve_forever,daemon=True).start()
 url=f'http://127.0.0.1:{server.server_port}/'
 try:
  with tempfile.TemporaryDirectory(prefix='pd-batch-extension-') as tmp:
   ext=Path(tmp)
   for p in EXTENSION_DIR.iterdir():
    if p.name not in ['manifest.json','background.js']:(ext/p.name).symlink_to(p,target_is_directory=p.is_dir())
   manifest=json.loads((EXTENSION_DIR/'manifest.json').read_text());manifest['host_permissions'].append(url+'*');(ext/'manifest.json').write_text(json.dumps(manifest))
   (ext/'background.js').write_text((EXTENSION_DIR/'background.js').read_text()+'\nglobalThis.agentTestDispatch=dispatchAgentOperation;\n')
   with extension_session('pd-capture-batch-',extension_dir=ext) as run:
    panel=run.open_page('collector.html');run.seed_storage(panel,{'entries':[]})
    web=run.context.new_page();web.goto(url);worker=run.context.service_workers[0]
    tab=panel.evaluate('async url=>(await chrome.tabs.query({})).find(t=>t.url===url).id',url)
    def call(op,args):return worker.evaluate('([op,args])=>agentTestDispatch(op,args)',[op,args])
    def done(op,args):
     receipt=call(op,args)
     if 'state' not in receipt:
      assert receipt.get('ok'),receipt
      return receipt
     while receipt['state'] in ['queued','running']:receipt=call('get_task',{'requestId':args['requestId'],'waitMs':1000})
     assert receipt['state']=='completed',receipt
     return receipt['result']
    scene=json.loads(call('read_capture',{'tabId':tab,'part':'context','includeHidden':True})['content'])
    assert len(scene.get('modules',[]))==3, f"Hidden code effects have no independent inventory: {scene}"
    assert [m['title'] for m in scene['modules']]==['Effect 1','Effect 2','Effect 3']
    assert all(len(m['sources'])==2 for m in scene['modules'])
    assert len(json.dumps(scene['modules']))<len(HTML)*2
    default=json.loads(call('read_capture',{'tabId':tab,'part':'context'})['content'])
    assert not default.get('modules'), 'Normal sidebar snapshot must not grow to the full hidden inventory'
    parent=done('create_project',{'requestId':'motion-project','name':'Web references'})['project']
    project=done('create_project',{'requestId':'child-project','name':'Motion-effects','parentId':parent['id']})['project']
    matches=call('read_projects',{'query':'motion-effects'})
    assert [x['id'] for x in json.loads(matches['content'])]==[project['id']]
    saved_ids=[]
    for i,module in enumerate(scene['modules'],1):
     prepared=done('prepare_capture',{'requestId':f'prepare-{i}','tabId':tab})
     selectors=[s['selector'] for s in module['sources']]
     original=call('read_capture',{'captureId':prepared['captureId'],'part':'source','selectors':selectors})
     preview=f'<!doctype html><style>button{{transition:transform .3s}}button:hover{{transform:scale({1+i/10})}}</style><button>Effect {i}</button>'
     selected=done('update_capture',{'requestId':f'select-{i}','captureId':prepared['captureId'],'expectedRevision':original['revision'],
       'candidates':[{'id':f'effect-{i}','title':module['title'],'canonicalUrl':url,'contentText':'','media':[],
        'textSources':[{'selector':s,'target':'text'} for s in selectors], 'codePreview':{'html':preview}}],
       'selections':[{'candidateId':f'effect-{i}','includeText':True,'selectedMediaIds':[]}]})
     saved=done('save_capture',{'requestId':f'save-{i}','captureId':prepared['captureId'],'expectedRevision':selected['revision'],'project':project['id'],'contentTypeId':'content:code-case'})
     assert saved['results'][0]['status']=='saved',saved
     proof=saved['results'][0]['originalVerification']
     assert proof['status']=='verified' and [x['selector'] for x in proof['sources']]==selectors,proof
     saved_ids.append(saved['results'][0]['entryId'])
     replay=done('save_capture',{'requestId':f'save-{i}','captureId':prepared['captureId'],'expectedRevision':selected['revision'],'project':project['id'],'contentTypeId':'content:code-case'})
     assert replay['results'][0]['entryId']==saved_ids[-1]
    state=panel.evaluate("async() => await chrome.runtime.sendMessage({type:'GET_STATE'})")
    assert len(state['entries'])==3
    for i,entry in enumerate(state['entries'],1):
     assert entry['title']==f'Effect {i}'
     assert f'.effect-{i}:hover' in entry['text'] and f'Animate only effect {i}.' in entry['text']
     assert all(f'.effect-{j}:hover' not in entry['text'] for j in range(1,4) if i!=j)
    got=call('read_projects',{'projectId':project['id']});assert json.loads(got['content'])[0]['caseCount']==3
    print(json.dumps({'modules':3,'saved':3,'retriesDuplicateFree':True,'perModuleSourcesExact':True,'paidApiCalls':0,'realLibraryWrites':0}))
 finally:server.shutdown()
if __name__=='__main__':main()
