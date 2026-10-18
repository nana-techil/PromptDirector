"""Source-backed code capture, actual library interaction and sandbox isolation.

All writes use a disposable profile. No model endpoint or real library is used.
"""
import json, os, tempfile, threading
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from playwright.sync_api import expect
from e2e_support import EXTENSION_DIR, extension_session

ORIGINAL = '.pill { transition: left .4s, width .4s; }'
DEMO = '''<!doctype html><html><head><style>body{background:#141414;color:#eee;font-family:sans-serif;display:grid;place-items:center;height:100vh;margin:0}.tabs{display:flex;position:relative;gap:8px;width:460px;justify-content:space-between}button{border:0;padding:14px;background:transparent;color:white;position:relative;z-index:1}.pill{position:absolute;height:100%;background:#db671d;border-radius:25px;transition:left .4s,width .4s}</style></head><body><div class="tabs"><div class="pill"></div><button>Plan</button><button>Build</button><button>Ship</button></div><output id="state"></output><script>const pill=document.querySelector('.pill');const buttons=[...document.querySelectorAll('button')];function select(b){pill.style.left=b.offsetLeft+'px';pill.style.width=b.offsetWidth+'px';document.querySelector('#state').textContent=b.textContent}buttons.forEach(b=>b.onclick=()=>select(b));select(buttons[1]);</script></body></html>'''
class Server(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200);self.send_header('Content-Type','text/html');self.end_headers()
        self.wfile.write(('<!doctype html><title>Tab demo</title><main><h1>Tab Pill Glide</h1><pre>'+ORIGINAL+'</pre></main>').encode())
    def log_message(self,*_): pass

def main():
    server=ThreadingHTTPServer(('127.0.0.1',0),Server);threading.Thread(target=server.serve_forever,daemon=True).start()
    url=f'http://127.0.0.1:{server.server_port}/work'
    out=Path(os.environ.get('PD_E2E_ARTIFACT_DIR','/tmp/pd-code-case'));out.mkdir(parents=True,exist_ok=True)
    try:
        with tempfile.TemporaryDirectory(prefix='pd-code-case-extension-') as tmp:
            ext=Path(tmp)
            for p in EXTENSION_DIR.iterdir():
                if p.name not in ['manifest.json','background.js']:(ext/p.name).symlink_to(p,target_is_directory=p.is_dir())
            manifest=json.loads((EXTENSION_DIR/'manifest.json').read_text());manifest['host_permissions'].append(url.rsplit('/',1)[0]+'/*')
            (ext/'manifest.json').write_text(json.dumps(manifest));(ext/'background.js').write_text((os.environ.get('PD_CODE_BACKGROUND') and Path(os.environ['PD_CODE_BACKGROUND']).read_text() or (EXTENSION_DIR/'background.js').read_text())+'\nglobalThis.agentTestDispatch=dispatchAgentOperation;\n')
            with extension_session('pd-code-case-',extension_dir=ext) as run:
                panel=run.open_page('collector.html');run.seed_storage(panel,{'entries':[],'capturePermissionOnboarding':{'version':1,'acknowledgedAt':'2026-10-11T00:00:00Z','clipboardIncluded':False}})
                catalog = panel.evaluate("async() => (await chrome.runtime.sendMessage({type:'GET_STATE'})).taxonomy")
                catalog['nodes'] = [node for node in catalog['nodes'] if node['id'] != 'content:code-case']
                catalog['nodes'][0]['name'] = 'My custom type'
                panel.evaluate("async taxonomy=>{const {getLibraryStorage}=await import('./library-storage.js');await getLibraryStorage().set({taxonomy});}",catalog)
                repaired = panel.evaluate("async() => await chrome.runtime.sendMessage({type:'GET_STATE'})")
                assert any(node['id']=='content:code-case' for node in repaired['taxonomy']['nodes']), 'Same-schema library must gain Code case without a full case migration'
                assert repaired['taxonomy']['nodes'][0]['name']=='My custom type'
                assert repaired['entries']==[]
                web=run.context.new_page();web.goto(url);worker=run.context.service_workers[0]
                tab=panel.evaluate('async url=>(await chrome.tabs.query({})).find(t=>t.url===url).id',url)
                def call(op,args):return worker.evaluate('([op,args])=>agentTestDispatch(op,args)',[op,args])
                def done(op,args):
                    receipt=call(op,args)
                    while receipt['state'] in ['queued','running']:receipt=call('get_task',{'requestId':args['requestId'],'waitMs':1000})
                    assert receipt['state']=='completed',receipt
                    return receipt['result']
                prepared=done('prepare_capture',{'requestId':'code-preview','tabId':tab})
                source=call('read_capture',{'captureId':prepared['captureId'],'part':'source','selector':'pre'})
                selected=done('update_capture',{'requestId':'code-select','captureId':prepared['captureId'],'expectedRevision':source['revision'],
                    'candidates':[{'id':'code','title':'Tab Pill Glide','canonicalUrl':url,'contentText':'','media':[],
                        'textSources':[{'selector':'pre','target':'text'}]}],
                    'selections':[{'candidateId':'code','includeText':True,'selectedMediaIds':[]}]})
                saved=done('save_capture',{'requestId':'code-save','captureId':prepared['captureId'],'expectedRevision':selected['revision']})
                entry=panel.evaluate("async()=>(await chrome.runtime.sendMessage({type:'GET_STATE'})).entries[0]")
                original_entry=entry
                assert ORIGINAL in entry['text'] and DEMO not in entry['text']
                details=call('read_case_details',{'caseId':entry['id'],'parts':['document','organization']})
                changed=call('edit_case',{'requestId':'append-existing-preview','caseId':entry['id'],'expectedRevision':details['revision'],
                    'patch':{'codePreview':{'html':DEMO}}})
                assert changed.get('ok',True),changed
                entries=panel.evaluate("async()=>(await chrome.runtime.sendMessage({type:'GET_STATE'})).entries")
                assert len(entries)==1 and entries[0]['id']==original_entry['id']
                entry=entries[0]
                assert entry['text'].startswith(original_entry['text']) and entry.get('mediaAssets')==original_entry.get('mediaAssets')
                assert ORIGINAL in entry['text'] and DEMO in entry['text'];assert entry['classification']['pathIds']==['content:code-case'],entry
                run.context.add_init_script("window.clickEvents=[];document.addEventListener('click',e=>clickEvents.push({text:e.target.textContent,x:e.clientX,y:e.clientY,time:performance.now()}),true)")
                magnetic_source = '.magnet-btn { transition: transform .15s ease-out; }'
                web.evaluate('(text)=>document.querySelector("pre").textContent=text', magnetic_source)
                prepared2=done('prepare_capture',{'requestId':'magnetic-preview','tabId':tab})
                source2=call('read_capture',{'captureId':prepared2['captureId'],'part':'source','selector':'pre'})
                selected2=done('update_capture',{'requestId':'magnetic-select','captureId':prepared2['captureId'],'expectedRevision':source2['revision'],
                    'candidates':[{'id':'magnetic','title':'Magnetic Button','canonicalUrl':url,'contentText':'','media':[],
                        'codePreview':{'html':'<!doctype html><html><body><button>Magnetic Button</button></body></html>'},
                        'textSources':[{'selector':'pre','target':'text'}]}],
                    'selections':[{'candidateId':'magnetic','includeText':True,'selectedMediaIds':[]}]})
                saved2=done('save_capture',{'requestId':'magnetic-save','captureId':prepared2['captureId'],'expectedRevision':selected2['revision'],'contentTypeId':'content:code-case'})
                assert saved2['results'][0]['status']=='saved' and saved2['results'][0]['title']=='Magnetic Button', saved2
                assert saved2['results'][0]['entryId']!=entry['id'], 'New module must not reuse Tab Pill entry'
                after=panel.evaluate("async()=>(await chrome.runtime.sendMessage({type:'GET_STATE'})).entries")
                assert len(after)==2
                assert next(item for item in after if item['id']==entry['id'])['text']==entry['text'], 'Old source and preview must remain unchanged'
                library=run.open_page('library.html');library.locator(f'.case-card[data-entry-id="{entry["id"]}"] .case-code-title').click()
                expect(library.locator('.code-case-view .code-case-frame')).to_be_visible()
                preview=library.frame_locator('.code-case-view .code-case-frame').frame_locator('#preview')
                expect(preview.locator('#state')).to_have_text('Build')
                expect(library.locator('.code-case-view .code-case-frame')).to_have_attribute('data-preview-ready','true')
                preview.get_by_role('button',name='Ship').click()
                try: expect(preview.locator('#state')).to_have_text('Ship')
                except Exception:
                    library.screenshot(path=str(out/'failed-click.png'))
                    (out/'failed-click.json').write_text(json.dumps({'html':preview.locator('body').evaluate('()=>document.body.innerHTML'),'events':[{'url':f.url,'clicks':f.evaluate('window.clickEvents')} for f in library.frames],'errors':run.page_errors}))
                    raise
                frame=next(f for f in library.frames if f.url=='about:srcdoc')
                isolation=frame.evaluate('''async()=>{let access=false,network=false;try{parent.parent.document.body;access=true}catch{}try{await fetch('https://example.test/blocked');network=true}catch{}return {access,network,extensionAPI:typeof chrome?.runtime}}''')
                assert not isolation['access'] and not isolation['network'] and isolation['extensionAPI']=='undefined',isolation
                for width in [1280,390]:
                    library.set_viewport_size({'width':width,'height':844})
                    for label in ['Plan','Build','Ship']:expect(preview.get_by_role('button',name=label)).to_be_in_viewport()
                    expect(preview.locator('#state')).to_have_text('Ship')
                    preview.locator('.pill').evaluate("async node=>{await Promise.all(node.getAnimations().map(animation=>animation.finished))}")
                    library.screenshot(path=str(out/f'code-case-{width}.png'))
                # Older saved previews can have the wrong type. Display the actual saved preview without rewriting originals.
                panel.evaluate("async()=>{const {getLibraryStorage}=await import('./library-storage.js');const storage=getLibraryStorage();const {entries}=await storage.get('entries');entries.find(item=>item.title==='Tab Pill Glide').classification={pathIds:['content:reference'],status:'confirmed',source:'manual'};await storage.set({entries})}")
                library.reload();library.locator(f'.case-card[data-entry-id="{entry["id"]}"] .case-code-title').click();expect(library.locator('.code-case-view .code-case-frame')).to_be_visible()
                expect(library.frame_locator('.code-case-view .code-case-frame').frame_locator('#preview').locator('#state')).to_have_text('Build')
                with library.expect_navigation():
                    library.evaluate("async()=>chrome.storage.local.set({uiPreferences:{locale:'en',theme:'light',motion:'reduced'}})")
                library.locator(f'.case-card[data-entry-id="{entry["id"]}"] .case-code-title').click()
                expect(library.locator('.code-case-source')).to_be_visible()
                expect(library.locator('.code-case-view .code-case-frame')).to_have_attribute('data-preview-ready','true')
                for width in [1280,390]:
                    library.set_viewport_size({'width':width,'height':844})
                    expect(library.frame_locator('.code-case-view .code-case-frame').frame_locator('#preview').get_by_role('button',name='Build')).to_be_in_viewport()
                    library.screenshot(path=str(out/f'code-case-en-light-{width}.png'))
                result={'savedOriginalExact':True,'updatedSameCaseWithoutDuplicateOrSourceLoss':True,'codeTypeSaved':True,'actualLibraryInteraction':True,'reloadRunsSavedPreview':True,'isolatedFromLibraryAndNetwork':True,'paidRequests':0,'pageErrors':run.page_errors}
                (out/'results.json').write_text(json.dumps(result,ensure_ascii=False,indent=2));print(json.dumps(result))
    finally:server.shutdown()
if __name__=='__main__': main()
