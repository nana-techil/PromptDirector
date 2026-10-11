"""Live code-dialog targeting plus actual source-backed capture and library readback.

Default uses a deterministic page; PD_CAPTURE_LIVE_URL explicitly selects one
real page for a necessary test. All writes stay in a disposable browser profile.
"""
import json, os, tempfile, threading
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from e2e_support import EXTENSION_DIR, extension_session
from playwright.sync_api import expect

CSS = '.search {\n  width: 56px;\n  overflow: hidden;\n}\n.search:focus-within {\n  width: 230px;\n}'
PAGE = '''<!doctype html><title>Motion modules</title><style>.template,.hidden{display:none}dialog{width:600px}pre{white-space:pre-wrap}</style>
<main><h1>Unrelated whole-page introduction</h1>'''+''.join('<article><h2>Other module '+str(i)+'</h2><div class="template"><pre>unrelated code '+str(i)+'</pre></div></article>' for i in range(51))+'''
<article id="target"><div class="card-param">width 0.4s glide</div><div class="card-foot"><h2>Expanding Search</h2><p>Field grows on hover or focus</p><button id="view">View code</button></div><div class="template"><pre data-lang="css">'''+CSS+'''</pre><pre data-lang="react">function ExpandingSearch() { return 'Search'; }</pre><pre data-lang="prompt">Build an expanding search input.</pre></div></article></main>
<dialog id="floating"><h2>Expanding Search</h2><div id="code"></div></dialog>
<script>document.querySelector('#view').onclick=()=>{let c=document.querySelector('#target .template').cloneNode(true);c.classList.remove('template');c.querySelectorAll('pre').forEach((p,i)=>p.classList.toggle('hidden',i>0));document.querySelector('#code').replaceChildren(c);document.querySelector('#floating').showModal()}</script>'''

class Server(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200);self.send_header('Content-Type','text/html');self.end_headers();self.wfile.write(PAGE.encode())
    def log_message(self,*_):pass

server=ThreadingHTTPServer(('127.0.0.1',0),Server);threading.Thread(target=server.serve_forever,daemon=True).start()
url=os.environ.get('PD_CAPTURE_LIVE_URL',f'http://127.0.0.1:{server.server_port}/work')
out=Path(os.environ.get('PD_E2E_ARTIFACT_DIR','/tmp/pd-current-page'));out.mkdir(parents=True,exist_ok=True)
try:
    with tempfile.TemporaryDirectory(prefix='pd-current-page-extension-') as tmp:
        ext=Path(tmp)
        for p in EXTENSION_DIR.iterdir():
            if p.name not in ['manifest.json','background.js']:(ext/p.name).symlink_to(p,target_is_directory=p.is_dir())
        manifest=json.loads((EXTENSION_DIR/'manifest.json').read_text());manifest['host_permissions'].append(url.split('/',3)[0]+'//'+url.split('/',3)[2]+'/*')
        (ext/'manifest.json').write_text(json.dumps(manifest));(ext/'background.js').write_text((EXTENSION_DIR/'background.js').read_text()+'\nglobalThis.agentTestDispatch=dispatchAgentOperation;\n')
        with extension_session('pd-current-page-',extension_dir=ext) as run:
            panel=run.open_page('collector.html'); run.seed_storage(panel,{'entries':[],'capturePermissionOnboarding':{'version':1,'acknowledgedAt':'2026-10-11T00:00:00Z','clipboardIncluded':False}})
            page=run.context.new_page();page.goto(url,wait_until='domcontentloaded');page.locator('body').wait_for()
            worker=run.context.service_workers[0];tab=panel.evaluate('async url=>(await chrome.tabs.query({})).find(t=>t.url===url).id',url)
            def call(name,args):return worker.evaluate('([operation,input])=>agentTestDispatch(operation,input)',[name,args])
            def done(name,args):
                task=call(name,args)
                while task['state'] in ['queued','running']:task=call('get_task',{'requestId':args['requestId'],'waitMs':1000})
                assert task['state']=='completed',task
                return task['result']
            if not os.environ.get('PD_CAPTURE_LIVE_URL'):
                page.evaluate('''() => {
                  const root=document.createElement('section');root.id='thread';
                  root.innerHTML='<div><article><p>Main post</p></article></div><div><article><p>AI Video Prompt: standing barefoot inside an apartment. No watermark.</p><textarea>private draft</textarea></article></div>';
                  document.body.prepend(root);
                }''')
                reply=json.loads(call('read_capture',{'part':'context','tabId':tab,'query':'AI Video Prompt'})['content'])
                assert reply.get('textModules'), 'Visible reply must be discoverable without guessing article:nth-of-type(2)'
                target=reply['textModules'][0]
                assert 'standing barefoot' in target['text'] and 'private draft' not in target['text'], target
                assert page.locator(target['selector']).count()==1
                page.locator('#thread').evaluate('(node)=>node.remove()')
            before=json.loads(call('read_capture',{'part':'context','tabId':tab})['content'])
            if os.environ.get('PD_CAPTURE_LIVE_URL'):
                card=page.locator('.card').filter(has=page.locator('.name',has_text='Expanding Search'));card.locator('.view-code').click()
                expect(page.locator('#code-modal')).to_be_visible()
            else:page.locator('#view').click()
            scene=json.loads(call('read_capture',{'part':'context','tabId':tab})['content'])
            assert scene['dialogs'] and scene['codeBlocks'],scene
            assert all('Expanding Search' in x['module']['title'] for x in scene['codeBlocks']),scene
            assert len(json.dumps(scene))<12000
            assert '.search' in scene['codeBlocks'][0]['content'] and 'width: 230px' in scene['codeBlocks'][0]['content']
            assert not any(x['visible'] for x in before['codeBlocks']),before
            matches=json.loads(call('read_capture',{'part':'context','tabId':tab,'query':'Expanding Search'})['content'])
            assert len(matches['codeBlocks'])>=3 and all('Expanding Search' in x['module']['title'] for x in matches['codeBlocks'])
            if os.environ.get('PD_CAPTURE_LIVE_URL'):
                page.wait_for_function("getComputedStyle(document.querySelector('#code-modal')).opacity === '1'")
            page.screenshot(path=str(out/'current-code-dialog.png'))
            prepared=done('prepare_capture',{'requestId':'current-preview','tabId':tab})
            revision=prepared['revision'];refs=[];texts=[]
            # Save every original tab for this module, without the whole page.
            dialog_selectors={d['selector'] for d in scene['dialogs']}
            template=[b for b in matches['codeBlocks'] if b['module']['selector'] not in dialog_selectors]
            assert len(template)==3,template
            bundle=call('read_capture',{'captureId':prepared['captureId'],'expectedRevision':revision,'part':'source','selectors':[block['selector'] for block in template],'length':3})
            assert bundle['revision']==revision+1, 'one scene read freezes every source under one revision'
            revision=bundle['revision']
            for block in template:
                refs.append({'selector':block['selector'],'target':'prompt'});texts.append(page.locator(block['selector']).text_content())
            assert '.search' in texts[0] and 'width: 230px' in texts[0]
            module=template[0]['module']['selector']
            for selector in [module+' > .card-foot',module+' .card-param']:
                source=call('read_capture',{'captureId':prepared['captureId'],'expectedRevision':revision,'part':'source','selector':selector})
                revision=source['revision'];refs.append({'selector':selector,'target':'text'})

            updated=done('update_capture',{'requestId':'select-current','captureId':prepared['captureId'],'expectedRevision':revision,
                'candidates':[{'id':'target-module','title':'Expanding Search','canonicalUrl':url,'contentText':'','media':[],'textSources':refs}],
                'selections':[{'candidateId':'target-module','includeText':True,'selectedMediaIds':[]}],
                'task':{'objective':'Capture only Expanding Search with its three source tabs','candidateIds':['target-module'],'outcome':'save','state':'active'}})
            saved=done('save_capture',{'requestId':'save-current','captureId':prepared['captureId'],'expectedRevision':updated['revision']})
            assert saved['results'][0]['status']=='saved',saved
            entries=panel.evaluate("async()=>(await chrome.runtime.sendMessage({type:'GET_STATE'})).entries")
            assert len(entries)==1 and entries[0]['title']=='Expanding Search',entries
            assert all(text in entries[0]['text'] for text in texts)
            assert 'Unrelated whole-page introduction' not in entries[0]['text'] and 'SpringCard' not in entries[0]['text']
            assert 'Field grows on hover or focus' in entries[0]['text'] and 'width 0.4s glide' in entries[0]['text']
            result={'source':url,'visibleDialogCorrect':True,'queryMatchesCorrectModule':True,'fullOriginalTabsSaved':True,'noWholePageContamination':True,'actualLibraryReadback':True,'moduleTitleDescriptionParametersSaved':True,'sceneCharacters':len(json.dumps(scene)),'paidRequests':0}
            (out/'results.json').write_text(json.dumps(result,ensure_ascii=False,indent=2));print(json.dumps(result,ensure_ascii=False))
finally:server.shutdown()
