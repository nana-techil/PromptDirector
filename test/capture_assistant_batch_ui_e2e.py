"""Assistant chat keeps drafts in Tools and uses real save/readback without model API calls.

Only the model reply is a fixture. Web reads, original downloads, selection,
durable receipts, close/reopen and library readback run in disposable Chromium.
"""
import json
import re
import os
import tempfile
import threading
import ssl
import subprocess
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from playwright.sync_api import expect
from e2e_support import EXTENSION_DIR, ai_configuration_fixture, extension_session
from page_capture_e2e import fixture_png
PNG = fixture_png('original-artwork')

PAGE = '''<!doctype html><title>Visual reference</title><main><h1>Visual reference</h1>
<p>A detailed creative reference with original text preserved, with lighting, lens and movement information.</p>
<demo-prompt></demo-prompt><img src="/original.png" alt="Original artwork" width="640" height="480">
<a href="/details">Read more source details</a></main>
<input type="password" value="DO_NOT_CAPTURE_PASSWORD"><textarea>DO_NOT_CAPTURE_DRAFT</textarea>
<script>document.querySelector('demo-prompt').attachShadow({mode:'open'}).innerHTML='<p>Exact shadow prompt: gym, soft rim light, slow camera push.</p>';</script>'''


def main():
    class Server(BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path.endswith('/missing.mp4'):
                self.send_response(404);self.end_headers();return
            self.send_response(200)
            self.send_header('Content-Type', 'image/png' if self.path.endswith('.png') else 'text/html')
            page=PAGE.replace('</main>','<video src="/missing.mp4" poster="/poster.png"></video></main>') if self.path.endswith('/failed') else PAGE
            self.end_headers(); self.wfile.write(PNG if self.path.endswith('.png') else page.encode())
        def log_message(self, *_): pass
    server = ThreadingHTTPServer(('127.0.0.1', 0), Server)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    origin = f'https://127.0.0.1:{server.server_port}'
    out = Path(os.environ.get('PD_E2E_ARTIFACT_DIR', tempfile.gettempdir())); out.mkdir(parents=True, exist_ok=True)
    try:
        with tempfile.TemporaryDirectory(prefix='pd-agent-capture-extension-') as tmp:
            ext = Path(tmp)
            subprocess.run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-keyout',str(ext/'fixture.key'),
                '-out',str(ext/'fixture.crt'),'-days','1','-subj','/CN=127.0.0.1'],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
            tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); tls.load_cert_chain(ext/'fixture.crt',ext/'fixture.key')
            server.socket = tls.wrap_socket(server.socket,server_side=True)
            for path in EXTENSION_DIR.iterdir():
                if path.name not in ['background.js', 'manifest.json']:
                    (ext / path.name).symlink_to(path, target_is_directory=path.is_dir())
            manifest = json.loads((EXTENSION_DIR / 'manifest.json').read_text())
            manifest['host_permissions'].append(origin + '/*')
            (ext / 'manifest.json').write_text(json.dumps(manifest))
            background=(EXTENSION_DIR / 'background.js').read_text().replace('async function collectPageCaptureTab(tab, options) {',
                "async function collectPageCaptureTab(tab, options) { if (tab.url.endsWith('/failed')) throw new Error('Fixture adapter cannot identify this webpage');")
            (ext / 'background.js').write_text(background + '\nglobalThis.agentTestDispatch=dispatchAgentOperation;\n')
            with extension_session('pd-agent-capture-', extension_dir=ext, viewport={'width':390,'height':844}, extra_args=['--ignore-certificate-errors']) as run:
                panel = run.open_page('collector.html')
                run.seed_storage(panel, {'entries': [], 'capturePermissionOnboarding': {'version':1,'acknowledgedAt':'2026-10-11T00:00:00Z','clipboardIncluded':False},
                    **ai_configuration_fixture(providers={'deepseek': {'apiKey':'isolated-fixture','consent':True,'models':{'creativePlanning':'deepseek-flash'}},
                    'custom-media': {'apiKey':'isolated-vision-fixture','consent':True,'endpoint':'https://api.deepseek.com/chat/completions','protocol':'chat_completions',
                    'models':{'creativePlanning':'fixture-vision','imageAnalysis':'fixture-vision'},
                    'discoveredModels':[{'id':'fixture-vision','tasks':['creativePlanning','imageAnalysis'],'inputModalities':['text','image'],'outputModalities':['text'],'supportedParameters':['tools'],'status':'available'}]}},
                                               assignments={'creativePlanning':{'providerId':'deepseek','model':'deepseek-flash'}})})
                web = run.context.new_page(); web.goto(origin + '/work')
                worker = run.context.service_workers[0]
                tab_id = panel.evaluate("async url => (await chrome.tabs.query({})).find(tab=>tab.url===url).id", origin + '/work')
                def call(name, input): return worker.evaluate('([name,input])=>agentTestDispatch(name,input)', [name,input])
                def done(name, input):
                    receipt = call(name,input)
                    while receipt['state'] in ['queued','running']:
                        receipt = call('get_task',{'requestId':input['requestId'],'waitMs':15000})
                    assert receipt['state']=='completed', receipt
                    return receipt['result']
                before = panel.evaluate("async()=>(await chrome.runtime.sendMessage({type:'GET_STATE'})).entries")
                prepared = done('prepare_capture', {'requestId':'mcp-preview','tabId':tab_id,'selector':'main'})
                assert prepared['selections']==[] and before==[]
                evidence = json.loads(call('read_capture',{'captureId':'mcp-preview','part':'page'})['content'])
                assert 'Exact shadow prompt' in evidence['text'] and 'DO_NOT_CAPTURE' not in evidence['text'], evidence
                assert evidence['links'][0]['url']==origin+'/details'
                supplemented = done('update_capture', {'requestId':'mcp-supplement','captureId':'mcp-preview','expectedRevision':1,
                    'candidates':[{'id':'agent-candidate','title':'Selected creative reference','canonicalUrl':origin+'/work',
                        'contentText':evidence['text'],'media':[{'id':'agent-image','kind':'image','url':origin+'/original.png',
                        'originalPrompt':'Exact shadow prompt: gym, soft rim light, slow camera push.'}]}],
                    'selections':[{'candidateId':'agent-candidate','includeText':True,'selectedMediaIds':['agent-image']}],'saveMode':'multiple'})
                assert supplemented['revision']==2
                receipt = done('save_capture',{'requestId':'mcp-save','captureId':'mcp-preview','expectedRevision':2})
                assert receipt['ok'] and receipt['results'][0]['status']=='saved', receipt
                replay = done('save_capture',{'requestId':'mcp-save','captureId':'mcp-preview','expectedRevision':2})
                assert replay['results']==receipt['results']
                entry = panel.evaluate("async()=>(await chrome.runtime.sendMessage({type:'GET_STATE'})).entries[0]")
                assert 'Exact shadow prompt' in entry['text']
                assert entry['mediaPrompts'][0]['text']=='Exact shadow prompt: gym, soft rim light, slow camera push.', entry
                original = panel.evaluate("async id=>Array.from(new Uint8Array(await (await import('./media-store.js')).getMediaBlob(id).then(blob=>blob.arrayBuffer())))", entry['mediaAssets'][0]['id'])
                assert bytes(original)==PNG
                assert len(panel.evaluate("async()=>(await chrome.runtime.sendMessage({type:'GET_STATE'})).entries"))==1
                panel.add_init_script(f'''(() => {{
                  const query=chrome.tabs.query.bind(chrome.tabs);
                  chrome.tabs.query=async input=>input.active ? [await chrome.tabs.get({tab_id})] : query(input);
                }})();''')
                worker.evaluate(r'''() => {
                  const original=globalThis.fetch;
                  globalThis.captureAI={stage:0,mode:'preview',requests:[],hold:false};
                  globalThis.fetch=async(url,init)=>{
                    if(!String(url).includes('api.deepseek.com'))return original(url,init);
                    const body=JSON.parse(init.body);captureAI.requests.push(body);
                    if(captureAI.hold) await new Promise((resolve,reject)=>{captureAI.release=resolve;init.signal.addEventListener('abort',()=>reject(init.signal.reason),{once:true});});
                    if(captureAI.mode==='failure') return new Response('Fixture service unavailable',{status:503});
                    const results=body.messages.filter(m=>m.role==='tool').map(m=>({name:body.messages.flatMap(m=>m.tool_calls||[]).find(c=>c.id===m.tool_call_id)?.function.name,data:JSON.parse(m.content)}));
                    const env=body.messages.filter(m=>m.role==='user'&&typeof m.content==='string').map(m=>{try{return JSON.parse(m.content)}catch{return null}}).find(m=>m?.runtimeContext)?.runtimeContext;
                    const page=env.page;
                    const last=results.at(-1)?.data;
                    const stage=captureAI.stage++;
                    let message={role:'assistant',content:'已完成当前批次。'};
                    const tool=(name,args)=>message={role:'assistant',content:'',tool_calls:[{id:crypto.randomUUID(),type:'function',function:{name,arguments:JSON.stringify(args)}}]};
                    if(stage===0) tool('declare_task',{mode:'act',goal:'Prepare the requested source'+(captureAI.mode==='save'?' and save it':''),steps:[{operation:'prepare_capture'},{operation:'read_capture',part:'page'},{operation:'update_capture'},...(captureAI.mode==='save'?[{operation:'save_capture'}]:[])]});
                    else if(stage===1) tool('prepare_capture',{requestId:crypto.randomUUID(),tabId:page.tabId});
                    else if(stage===2) tool('read_capture',{captureId:last.captureId,part:'page'});
                    else if(stage===3){
                      const data=JSON.parse(last.content);const media=data.media.filter(m=>m.kind==='image').map((m,i)=>({id:'image-'+i,kind:m.kind,url:m.url}));
                      tool('update_capture',{requestId:crypto.randomUUID(),captureId:last.captureId,expectedRevision:last.revision,candidates:[{id:'fixture-case',title:'Assistant selected original',canonicalUrl:page.url,contentText:data.text,media}],selections:[{candidateId:'fixture-case',includeText:true,selectedMediaIds:media.map(m=>m.id)}],saveMode:'multiple'});
                    }else if(stage===4&&captureAI.mode==='save') tool('save_capture',{requestId:crypto.randomUUID(),captureId:last.captureId,expectedRevision:last.revision,project:captureAI.project});
                    else if(stage===4) message.content='已准备好，可在工具中调整。';
                    return new Response(JSON.stringify({choices:[{message,finish_reason:message.tool_calls?'tool_calls':'stop'}]}),{headers:{'content-type':'application/json'}});
                  };
                }''')
                panel.reload();panel.locator('#open-capture-assistant').click()
                expect(panel.locator('#capture-assistant-input')).to_be_visible()
                expect(panel.locator('.capture-assistant-preview')).to_have_count(0)
                panel.screenshot(path=str(out/'batch-chat-empty-390.png'))
                worker.evaluate("Object.assign(captureAI,{stage:0,mode:'preview',hold:true})")
                panel.locator('#capture-assistant-input').fill('准备这个网页的正文和原图，先保留草稿')
                panel.locator('#capture-assistant-send').click()
                expect(panel.locator('#capture-assistant-send')).to_be_disabled()
                expect(panel.locator('#capture-assistant-stop')).to_be_visible()
                expect(panel.locator('.capture-assistant-preview')).to_have_count(0)
                panel.screenshot(path=str(out/'batch-chat-wait-390.png'))
                panel.wait_for_function("document.querySelectorAll('.capture-assistant-user').length===1")
                for _ in range(100):
                    if worker.evaluate('Boolean(captureAI.release)'): break
                    panel.wait_for_timeout(50)
                worker.evaluate('captureAI.hold=false;captureAI.release()')
                expect(panel.locator('.capture-assistant-assistant').last).to_contain_text('已准备好',timeout=30000)
                expect(panel.locator('#capture-assistant-send')).to_be_enabled()
                expect(panel.locator('.capture-assistant-preview')).to_have_count(0)
                panel.screenshot(path=str(out/'batch-chat-ready-390.png'))
                # The original Tools UI still owns selection, type, project and save.
                panel.locator('#open-capture-assistant').click()
                expect(panel.locator('#page-capture-save')).to_be_enabled()
                expect(panel.locator('#page-capture-list')).to_contain_text('Assistant selected original')
                expect(panel.locator('#content-type')).to_be_visible()
                assert panel.locator('#content-type option[value="content:code-case"]').count()==1
                panel.locator('#content-type').select_option('content:reference')
                panel.locator('#page-capture-save-mode').select_option('combined')
                expect(panel.locator('#page-capture-save-mode')).to_have_value('combined')
                panel.screenshot(path=str(out/'batch-tools-draft-390.png'))
                panel.locator('#page-capture-save').click()
                expect(panel.locator('#page-capture-save')).not_to_be_visible(timeout=30000)
                entries=panel.evaluate("async()=>(await chrome.runtime.sendMessage({type:'GET_STATE'})).entries")
                assert len(entries)==1 and 'Exact shadow prompt' in entries[0]['text'],entries
                # Automatic saving reaches the same durable service and keeps a receipt in chat.
                web.goto(origin+'/second')
                panel.locator('#open-capture-assistant').click()
                worker.evaluate("Object.assign(captureAI,{stage:0,mode:'save',project:''})")
                panel.locator('#capture-assistant-input').fill('采集并保存这个页面')
                panel.locator('#capture-assistant-send').click()
                expect(panel.locator('.capture-assistant-result')).to_be_visible(timeout=30000)
                expect(panel.locator('#capture-assistant-send')).to_be_enabled()
                expect(panel.locator('.capture-assistant-preview')).to_have_count(0)
                entries=panel.evaluate("async()=>(await chrome.runtime.sendMessage({type:'GET_STATE'})).entries")
                assert len(entries)==2 and all('Exact shadow prompt' in item['text'] for item in entries),entries
                for width,locale in [(390,'zh-CN'),(640,'en')]:
                    panel.set_viewport_size({'width':width,'height':844})
                    panel.evaluate("async locale=>chrome.storage.local.set({uiPreferences:{locale,theme:locale==='en'?'light':'dark',motion:'reduced'}})",locale)
                    panel.reload();panel.locator('#open-capture-assistant').click()
                    expect(panel.locator('.capture-assistant-result')).to_be_visible()
                    expect(panel.locator('.capture-assistant-preview')).to_have_count(0)
                    expect(panel.locator('#capture-assistant-send')).to_be_in_viewport()
                    panel.screenshot(path=str(out/f'batch-chat-saved-{width}-{locale}.png'))
                worker.evaluate("Object.assign(captureAI,{stage:0,mode:'failure'})")
                panel.locator('#capture-assistant-input').fill('读取当前页面')
                panel.locator('#capture-assistant-send').click()
                expect(panel.locator('#capture-assistant-status')).to_contain_text('503',timeout=30000)
                expect(panel.locator('#capture-assistant-send')).to_be_enabled()
                expect(panel.locator('.capture-assistant-preview')).to_have_count(0)
                panel.screenshot(path=str(out/'batch-chat-failure-640.png'))
                print(json.dumps({'savedReadback':len(entries),'chatDraftCards':0,'manualToolsSave':True,'automaticSaveReceipt':True,'paidApiCalls':0,'realLibraryWrites':0,'pageErrors':run.page_errors}))
    finally: server.shutdown()

if __name__=='__main__': main()
