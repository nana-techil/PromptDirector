"""MCP preview supplementation and collector chat share actual capture/save paths.

Only the model reply is a fixture. Web reads, original downloads, selection,
durable receipts, close/reopen and library readback run in disposable Chromium.
"""
import json
import os
import tempfile
import threading
import ssl
import subprocess
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from playwright.sync_api import expect
from e2e_support import EXTENSION_DIR, ai_configuration_fixture, extension_session
from page_capture_e2e import PNG

PAGE = '''<!doctype html><title>Visual reference</title><main><h1>Visual reference</h1>
<p>A detailed creative reference with original text preserved, with lighting, lens and movement information.</p>
<demo-prompt></demo-prompt><img src="/original.png" alt="Original artwork" width="640" height="480">
<a href="/details">Read more source details</a></main>
<input type="password" value="DO_NOT_CAPTURE_PASSWORD"><textarea>DO_NOT_CAPTURE_DRAFT</textarea>
<script>document.querySelector('demo-prompt').attachShadow({mode:'open'}).innerHTML='<p>Exact shadow prompt: gym, soft rim light, slow camera push.</p>';</script>'''


def main():
    class Server(BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200)
            self.send_header('Content-Type', 'image/png' if self.path.endswith('.png') else 'text/html')
            self.end_headers(); self.wfile.write(PNG if self.path.endswith('.png') else PAGE.encode())
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
            (ext / 'background.js').write_text((EXTENSION_DIR / 'background.js').read_text() + '\nglobalThis.agentTestDispatch=dispatchAgentOperation;\n')
            with extension_session('pd-agent-capture-', extension_dir=ext, viewport={'width':390,'height':844}, extra_args=['--ignore-certificate-errors']) as run:
                panel = run.open_page('collector.html')
                run.seed_storage(panel, {'entries': [], 'capturePermissionOnboarding': {'version':1,'acknowledgedAt':'2026-10-11T00:00:00Z','clipboardIncluded':False},
                    **ai_configuration_fixture(providers={'deepseek': {'apiKey':'isolated-fixture','consent':True,'models':{'creativePlanning':'deepseek-flash'}}},
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
                # Fixture replies pass through the actual provider tool loop.
                # Only this fake-key endpoint is replaced; original downloads stay real.
                worker.evaluate('''() => {
                  const original=globalThis.fetch;
                  globalThis.captureAI={requests:[],hold:false,release:null};
                  globalThis.fetch=async(url,init)=>{
                    if(!String(url).includes('api.deepseek.com'))return original(url,init);
                    const body=JSON.parse(init.body);captureAI.requests.push(body);
                    const results=body.messages.filter(m=>m.role==='tool');
                    const preview=JSON.parse(body.messages[0].content.match(/当前采集预览：(\\{[^\\n]+\\})。/u)[1]);
                    let delta,finish;
                    if(!results.length){delta={tool_calls:[{index:0,id:crypto.randomUUID(),type:'function',function:{name:'read_capture',arguments:JSON.stringify({captureId:preview.captureId,part:'page'})}}]};finish='tool_calls';}
                    else if(results.length===1){
                      const page=JSON.parse(JSON.parse(results[0].content).content);
                      const img=page.media.find(m=>m.kind==='image');
                      delta={tool_calls:[{index:0,id:crypto.randomUUID(),type:'function',function:{name:'update_capture',arguments:JSON.stringify({requestId:'model-select',captureId:preview.captureId,expectedRevision:preview.revision,
                        candidates:[{id:'assistant-candidate',title:'Assistant creative reference',canonicalUrl:page.url,contentText:page.text,media:[{id:'assistant-image',kind:'image',url:img.url}]}],
                        selections:[{candidateId:'assistant-candidate',includeText:true,selectedMediaIds:['assistant-image']}],saveMode:'multiple'})}}]};finish='tool_calls';
                    }else{
                      if(captureAI.hold)await new Promise((resolve,reject)=>{captureAI.release=resolve;init.signal.addEventListener('abort',()=>reject(init.signal.reason),{once:true})});
                      delta={content:'已选择完整原文与原图，请检查预览后保存。'};finish='stop';
                    }
                    const events=[{model:'fixture-observed-model',choices:[{index:0,delta,finish_reason:null}]},{choices:[{index:0,delta:{},finish_reason:finish}],usage:{prompt_tokens:100,completion_tokens:20,total_tokens:120}}];
                    return new Response(events.map(e=>'data: '+JSON.stringify(e)+'\\n\\n').join('')+'data: [DONE]\\n\\n',{headers:{'content-type':'text/event-stream'}});
                  };
                }''')
                panel.reload()
                panel.locator('#open-capture-assistant').click()
                expect(panel.locator('#capture-assistant-dialog')).to_be_visible()
                expect(panel.locator('.capture-assistant-model')).to_contain_text('API')
                assert worker.evaluate('captureAI.requests.length')==0
                panel.screenshot(path=str(out/'capture-chat-empty-zh-dark-390.png'))
                panel.locator('#capture-assistant-input').fill('采集正文与原图，补上提示词')
                worker.evaluate('captureAI.hold=true')
                web.bring_to_front(); panel.locator('#capture-assistant-send').evaluate('e=>e.click()')
                expect(panel.locator('#capture-assistant-send')).to_be_disabled()
                panel.screenshot(path=str(out/'capture-chat-wait-zh-dark-390.png'))
                panel.wait_for_function("async()=>Boolean((await chrome.storage.local.get('captureAssistantDialog')).captureAssistantDialog.requestId)")
                for _ in range(200):
                    if worker.evaluate('Boolean(captureAI.release)'): break
                    panel.wait_for_timeout(50)
                assert worker.evaluate('Boolean(captureAI.release)'), worker.evaluate('captureAI.requests.length')
                panel.close(); web.goto(origin + '/other'); worker.evaluate('captureAI.release()')
                panel=run.open_page('collector.html'); panel.locator('#open-capture-assistant').click()
                expect(panel.locator('#capture-assistant-status')).to_contain_text('Agent 结果已保留')
                panel.wait_for_function("async()=>Boolean((await chrome.storage.local.get('captureAssistantDialog')).captureAssistantDialog.pendingRevision)")
                assert worker.evaluate('captureAI.requests.length')==3, 'Changing pages must not resend model calls'
                panel.close(); web.goto(origin + '/work')
                panel=run.open_page('collector.html'); panel.locator('#open-capture-assistant').click()
                expect(panel.locator('.capture-assistant-assistant')).to_contain_text('完整原文')
                expect(panel.locator('#capture-assistant-send')).to_be_enabled(timeout=30000)
                expect(panel.locator('#page-capture-save')).to_be_enabled()
                assert worker.evaluate('captureAI.requests.length')==3
                assert len(panel.evaluate("async()=>(await chrome.runtime.sendMessage({type:'GET_STATE'})).entries"))==1, 'Assistant must not auto-save'
                panel.screenshot(path=str(out/'capture-chat-result-zh-dark-390.png'))
                panel.locator('#capture-assistant-close').click()
                expect(panel.locator('#page-capture-save')).to_be_enabled()
                panel.locator('#page-capture-save').click()
                expect(panel.locator('#page-capture')).to_be_hidden(timeout=30000)
                entries=panel.evaluate("async()=>(await chrome.runtime.sendMessage({type:'GET_STATE'})).entries")
                assert len(entries)==1 and entries[0]['id']==entry['id'] and 'Exact shadow prompt' in entries[0]['text'], entries
                assert entries[0]['mediaPrompts']==entry['mediaPrompts'], 'Same-source repair must retain the saved original prompt'
                assert worker.evaluate('captureAI.requests.length')==3, 'Saving must not call the model'
                panel.locator('#open-capture-assistant').click()
                panel.locator('#capture-assistant-input').fill('继续检查原文，先不要保存')
                worker.evaluate('captureAI.release=null')
                web.bring_to_front(); panel.locator('#capture-assistant-send').evaluate('e=>e.click()')
                for _ in range(200):
                    if worker.evaluate('Boolean(captureAI.release)'): break
                    panel.wait_for_timeout(50)
                assert worker.evaluate('Boolean(captureAI.release)')
                panel.locator('#capture-assistant-stop').click()
                expect(panel.locator('#capture-assistant-status')).to_contain_text('已停止',timeout=10000)
                expect(panel.locator('#capture-assistant-send')).to_be_enabled()
                panel.screenshot(path=str(out/'capture-chat-stopped-zh-dark-390.png'))
                assert len(panel.evaluate("async()=>(await chrome.runtime.sendMessage({type:'GET_STATE'})).entries"))==1
                # English, light theme, smaller and larger actual dialog states.
                panel.evaluate("async()=>chrome.storage.local.set({uiPreferences:{locale:'en',theme:'light',motion:'reduced'}})")
                panel.reload(); panel.locator('#open-capture-assistant').click()
                for width in [320,960]:
                    panel.set_viewport_size({'width':width,'height':844})
                    dialog=panel.locator('#capture-assistant-dialog'); expect(dialog).to_be_visible()
                    assert dialog.evaluate('e=>e.scrollWidth<=e.clientWidth'), 'Dialog overflow'
                    assert panel.locator('#capture-assistant-send').evaluate('e=>{const r=e.getBoundingClientRect();return r.right<=innerWidth&&r.bottom<=innerHeight}')
                    panel.screenshot(path=str(out/f'capture-chat-result-en-light-{width}.png'))
                print(json.dumps({'mcpPreviewAndSupplement':True,'exactOriginalBytesReadback':True,'saveRetryDoesNotDuplicate':True,
                    'sharedCollectorTools':True,'closeContinuesAndReopenRestores':True,'explicitStopRetainsPreview':True,
                    'changedPageDoesNotApplyOldPreview':True,'returnToSourceRestoresWithoutModelCalls':True,
                    'sameSourceDoesNotDuplicateOrReplaceOriginalPrompt':True,'modelFixtureRequests':worker.evaluate('captureAI.requests.length'),'paidRequests':0,'pageErrors':run.page_errors}),flush=True)
    finally:
        server.shutdown(); server.server_close()

if __name__=='__main__': main()
