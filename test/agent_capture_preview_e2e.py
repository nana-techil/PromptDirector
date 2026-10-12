"""MCP preview supplementation and collector chat share actual capture/save paths.

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
                # The collector page stands in for a side panel: its host tab is
                # the synthetic source page, even while visible controls are clicked.
                # No daily profile, external website or real API is accessed.
                panel.add_init_script("""({tabId}) => {
                  const query=chrome.tabs.query.bind(chrome.tabs);
                  chrome.tabs.query=async input=>input.active ? [await chrome.tabs.get(tabId)] : query(input);
                }""".replace('({tabId}) =>', '(() =>').replace('chrome.tabs.get(tabId)', f'chrome.tabs.get({tab_id})') + ')();')
                worker.evaluate(r'''() => {
                  const original=globalThis.fetch;
                  globalThis.captureAI={requests:[],hold:false,release:null};
                  globalThis.fetch=async(url,init)=>{
                    if(!String(url).includes('api.deepseek.com'))return original(url,init);
                    const body=JSON.parse(init.body);captureAI.requests.push(body);
                    try {
                    const results=body.messages.filter(m=>m.role==='tool').map(m=>({name:body.messages.flatMap(m=>m.tool_calls||[]).find(c=>c.id===m.tool_call_id)?.function.name,data:JSON.parse(m.content)}));
                    const rawSystem=body.messages[0].content;
                    const system=typeof rawSystem==='string'?rawSystem:rawSystem.map(part=>part.text||'').join('\n');
                    const current=JSON.parse(system.match(/当前采集预览：(null|\{[^\n]+\})。/u)[1]);
                    const page=JSON.parse(system.match(/当前网页：(\{[^\n]+\})。/u)[1]);
                    const user=[...body.messages].reverse().find(m=>m.role==='user').content;
                    const instruction=typeof user==='string'?user:user.map(part=>part.text||'').join('\n');
                    let delta,finish;
                    const tool=(name,args)=>{delta={tool_calls:[{index:0,id:crypto.randomUUID(),type:'function',function:{name,arguments:JSON.stringify(args)}}]};finish='tool_calls';};
                    const prepared=results.find(m=>m.name==='prepare_capture')?.data||current;
                    if(/怎么|如何|how|先不要采集/iu.test(instruction) && !/保存这些附件/u.test(instruction)){delta={content:'点击“帮我采集”得到预览，再选择项目保存。也可以直接说“保存到镜头参考”。'};finish='stop';}
                    else if(/保存这些附件/u.test(instruction) && !prepared) tool('prepare_capture',{requestId:'attachment-preview',tabId:page.tabId});
                    else if(/保存这些附件/u.test(instruction) && !results.find(m=>m.name==='update_capture')) {
                      const files=JSON.parse(system.match(/本对话可读附件：(\[[^\n]+\])。/u)[1]);
                      const media=files.map((file,i)=>({id:'file-'+i,kind:file.kind,localTransferId:file.transferId}));
                      tool('update_capture',{requestId:'attach-select',captureId:prepared.captureId,expectedRevision:prepared.revision,
                        candidates:[{id:'chat-files',title:'Explicitly requested local originals',canonicalUrl:page.url,contentText:'',media}],
                        selections:[{candidateId:'chat-files',includeText:false,selectedMediaIds:media.map(item=>item.id)}],saveMode:'multiple',
                        task:{objective:'Select the requested attachments, do not save yet',candidateIds:['chat-files'],outcome:'preview',state:'active'}});
                    } else if(/保存这些附件/u.test(instruction)) { delta={content:'已按明确要求选入原件，请保存。'};finish='stop'; }
                    else if(!prepared)tool('prepare_capture',{requestId:'model-prepare',tabId:page.tabId});
                    else if(/保存到|save to|新建镜头参考并保存/iu.test(instruction)){
                      if(!results.find(m=>m.name==='read_projects'))tool('read_projects',{name:'镜头参考'});
                      else if(!results.find(m=>m.name==='save_capture')){
                        const projects=JSON.parse(results.find(m=>m.name==='read_projects').data.content);
                        const created=results.find(m=>m.name==='create_project')?.data.project;
                        if(/新建镜头参考并保存/u.test(instruction) && !projects.length && !created) tool('create_project',{requestId:'new-target-project',name:'镜头参考'});
                        else tool('save_capture',{requestId:'model-save',captureId:prepared.captureId,expectedRevision:prepared.revision,project:created?.id||projects[0].id});
                      }else{delta={content:'已按保存回执完成。'};finish='stop';}
                    }else if(!results.find(m=>m.name==='read_capture'))tool('read_capture',{captureId:prepared.captureId,part:'page'});
                    else if(!results.find(m=>m.name==='update_capture')){
                      const evidence=JSON.parse(results.find(m=>m.name==='read_capture').data.content);
                      const media=evidence.media.filter(m=>['image','video'].includes(m.kind)).map((m,i)=>({id:'assistant-media-'+i,kind:m.kind,url:m.url,posterUrl:m.posterUrl}));
                      tool('update_capture',{requestId:'model-select',captureId:prepared.captureId,expectedRevision:prepared.revision,
                        candidates:[{id:'assistant-candidate',title:'Assistant creative reference',canonicalUrl:evidence.url,contentText:evidence.text,media}],
                        selections:[{candidateId:'assistant-candidate',includeText:true,selectedMediaIds:media.map(m=>m.id)}],saveMode:'multiple',
                        ...(captureAI.premature?{task:{objective:'Save the requested case',candidateIds:['assistant-candidate'],outcome:'save',state:'active'}}:{})});
                    }else{
                      if(captureAI.hold)await new Promise((resolve,reject)=>{captureAI.release=resolve;init.signal.addEventListener('abort',()=>reject(init.signal.reason),{once:true})});
                      delta={content:captureAI.premature?'已保存全部 FORGED_SAVED_REPLY':'**已选择原文和原图。** 可以直接保存。'};finish='stop';
                    }
                    const events=[{model:'fixture-observed-model',choices:[{index:0,delta,finish_reason:null}]},{choices:[{index:0,delta:{},finish_reason:finish}],usage:{prompt_tokens:100,completion_tokens:20,total_tokens:120}}];
                    if(captureAI.requests.length===1) {
                      const encoder=new TextEncoder();
                      return new Response(new ReadableStream({start(controller){
                        controller.enqueue(encoder.encode('data: '+JSON.stringify(events[0])+'\n\n'));
                        captureAI.finishStream=()=>{controller.enqueue(encoder.encode('data: '+JSON.stringify(events[1])+'\n\ndata: [DONE]\n\n'));controller.close();};
                      }}),{headers:{'content-type':'text/event-stream'}});
                    }
                    return new Response(events.map(e=>'data: '+JSON.stringify(e)+'\n\n').join('')+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
                    } catch(error) {captureAI.fixtureError=String(error.stack);throw error;}
                  };
                }''')
                panel.reload()
                panel.locator('#open-capture-assistant').click()
                expect(panel.locator('#capture-assistant-panel')).to_be_visible()
                assert worker.evaluate('captureAI.requests.length')==0
                panel.screenshot(path=str(out/'capture-chat-empty-zh-dark-390.png'))
                panel.locator('#capture-assistant-input').fill('这个怎么采集？')
                panel.locator('#capture-assistant-input').press('Enter')
                expect(panel.locator('.capture-assistant-assistant')).to_contain_text('得到预览',timeout=30000)
                expect(panel.locator('#capture-assistant-send')).to_be_disabled()
                worker.evaluate('captureAI.finishStream()')
                expect(panel.locator('#capture-assistant-send')).to_be_enabled(timeout=30000)
                assert worker.evaluate('captureAI.requests.length')==1, 'Guidance needs no capture tools'
                panel.screenshot(path=str(out/'capture-chat-guide-zh-dark-390.png'))
                # Deliberately hold the final model response; the real tools and
                # preview have already completed. Closing must not re-request AI.
                panel.locator('#capture-assistant-input').fill('采集正文与原图，补上提示词')
                worker.evaluate('captureAI.hold=true')
                panel.locator('#capture-assistant-send').click()
                expect(panel.locator('#capture-assistant-stop')).to_be_visible()
                panel.screenshot(path=str(out/'capture-chat-wait-zh-dark-390.png'))
                for _ in range(200):
                    if worker.evaluate('Boolean(captureAI.release)'): break
                    panel.wait_for_timeout(50)
                assert worker.evaluate('Boolean(captureAI.release)'), worker.evaluate('captureAI.requests.length')
                request_count=worker.evaluate('captureAI.requests.length')
                panel.locator('#open-capture-assistant').click()
                expect(panel.locator('#capture-assistant-panel')).to_be_hidden()
                web.goto(origin + '/other'); worker.evaluate('captureAI.release()')
                panel.locator('#open-capture-assistant').click()
                expect(panel.locator('.capture-assistant-user')).not_to_have_count(0,timeout=30000)
                expect(panel.locator('#capture-assistant-send')).to_be_enabled()
                expect(panel.locator('.capture-assistant-preview')).to_have_count(0)
                assert worker.evaluate('captureAI.requests.length')==request_count
                web.goto(origin + '/work')
                panel.locator('#open-capture-assistant').click();panel.locator('#open-capture-assistant').click()
                expect(panel.locator('.capture-assistant-assistant').last).to_contain_text('已选择原文')
                expect(panel.locator('#capture-assistant-save')).to_be_enabled(timeout=30000)
                assert panel.locator('.capture-assistant-assistant strong').count()>0, 'Markdown is rendered'
                assert len(panel.evaluate("async()=>(await chrome.runtime.sendMessage({type:'GET_STATE'})).entries"))==1
                panel.screenshot(path=str(out/'capture-chat-result-zh-dark-390.png'))
                # The Save action stays in the conversation and uses the actual
                # collector permission / conflict / durable receipt path.
                panel.locator('#capture-assistant-save').click()
                expect(panel.locator('.capture-assistant-result')).to_contain_text('已有案例，未新增采集内容',timeout=30000)
                assert worker.evaluate('captureAI.requests.length')==request_count
                entries=panel.evaluate("async()=>(await chrome.runtime.sendMessage({type:'GET_STATE'})).entries")
                assert len(entries)==1 and entries[0]['id']==entry['id'] and 'Exact shadow prompt' in entries[0]['text'], entries
                assert entries[0]['mediaPrompts']==entry['mediaPrompts']
                panel.screenshot(path=str(out/'capture-chat-saved-zh-dark-390.png'))

                # An unfinished selection on A no longer prevents B from capturing.
                worker.evaluate('captureAI.hold=false;captureAI.release=null')
                panel.locator('#capture-assistant-input').fill('采集正文与原图')
                panel.locator('#capture-assistant-send').click()
                expect(panel.locator('#capture-assistant-save')).to_be_enabled(timeout=30000)
                call('create_project',{'requestId':'session-project-a','name':'A-page-project'})
                call('create_project',{'requestId':'session-project-b','name':'B-page-project'})
                panel.reload();panel.locator('#open-capture-assistant').click()
                expect(panel.locator('#capture-assistant-save')).to_be_enabled(timeout=30000)
                panel.locator('.capture-assistant-project summary').click()
                panel.get_by_role('checkbox',name='A-page-project',exact=True).check()
                expect(panel.locator('.capture-assistant-project summary')).to_contain_text('A-page-project')
                panel.locator('.capture-assistant-project summary').click()
                page_a_preview=panel.evaluate("async()=>(await (await import('./library-storage.js')).getLibraryStorage().get('captureAssistantDialog')).captureAssistantDialog.pages")
                assert page_a_preview[origin+'/work']['pendingBatch']['selections']
                web.goto(origin+'/other')
                expect(panel.locator('.capture-assistant-user')).not_to_have_count(0,timeout=30000)
                panel.locator('#capture-assistant-input').fill('采集正文与原图')
                panel.locator('#capture-assistant-send').click()
                expect(panel.locator('#capture-assistant-save')).to_be_enabled(timeout=30000)
                assert panel.evaluate("async()=>(await (await import('./library-storage.js')).getLibraryStorage().get('captureAssistantDialog')).captureAssistantDialog.pages")[origin+'/other']['pendingBatch']['sourceUrl']==origin+'/other'
                panel.locator('.capture-assistant-project summary').click()
                panel.get_by_role('checkbox',name='B-page-project',exact=True).check()
                expect(panel.locator('.capture-assistant-project summary')).to_contain_text('B-page-project')
                panel.locator('.capture-assistant-project summary').click()
                panel.screenshot(path=str(out/'capture-chat-switch-page-390.png'))
                before_reset=worker.evaluate('captureAI.requests.length')
                prior_chat_id=panel.locator('#capture-assistant-chats').input_value()
                panel.locator('#capture-assistant-new').click()
                expect(panel.locator('.capture-assistant-user')).to_have_count(0)
                expect(panel.locator('#capture-assistant-save')).to_be_enabled()
                for _ in range(200):
                    record=panel.evaluate("async()=>(await (await import('./library-storage.js')).getLibraryStorage().get(['captureAssistantDialog','composerSessions']))")
                    if record['captureAssistantDialog']['activeId']!=prior_chat_id and any(chat['id']==record['captureAssistantDialog']['activeId'] for chat in record['composerSessions']):break
                    panel.wait_for_timeout(50)
                assert record['captureAssistantDialog']['activeId']!=prior_chat_id
                panel.reload();panel.locator('#open-capture-assistant').click()
                expect(panel.locator('.capture-assistant-user')).to_have_count(0)
                expect(panel.locator('#capture-assistant-save')).to_be_enabled(timeout=30000)
                assert worker.evaluate('captureAI.requests.length')==before_reset
                with panel.expect_download() as downloaded:
                    panel.locator('#capture-assistant-diagnostic').click()
                    panel.get_by_role('button',name='导出',exact=True).click()
                downloaded.value.save_as(str(out/'capture-chat-diagnostic.json'))
                diagnostic=json.loads((out/'capture-chat-diagnostic.json').read_text())
                assert diagnostic['schema']=='promptdirector-composer-diagnostic' and diagnostic['surface']=='capture-assistant'
                assert {origin+'/work',origin+'/other'} <= set(diagnostic['capture']['pageWork'])
                assert any(item.get('turns') and any(turn.get('diagnostic',{}).get('toolCalls') for turn in item['turns']) for item in diagnostic['capture']['sessions'])
                assert 'isolated-fixture' not in json.dumps(diagnostic) and 'base64,' not in json.dumps(diagnostic)
                panel.locator('#capture-assistant-chats').select_option(prior_chat_id)
                web.goto(origin+'/work')
                expect(panel.locator('.capture-assistant-result')).to_contain_text('已有案例，未新增采集内容',timeout=30000)
                expect(panel.locator('#capture-assistant-save')).to_be_enabled(timeout=30000)
                expect(panel.locator('.capture-assistant-project summary')).to_contain_text('A-page-project')
                current=panel.evaluate("async()=>(await (await import('./library-storage.js')).getLibraryStorage().get('captureAssistantDialog')).captureAssistantDialog.pages")
                assert current[origin+'/work']['pendingBatch']['selections']==page_a_preview[origin+'/work']['pendingBatch']['selections']
                # Resume the existing lifecycle tests on A, including explicit stop.
                worker.evaluate('captureAI.hold=true;captureAI.release=null')

                with run.context.expect_page() as opened_info:
                    panel.locator('.capture-assistant-result button').click()
                opened=opened_info.value
                expect(opened.locator('#detail-drawer')).to_be_visible(timeout=30000)
                opened.close()
                # Explicit stop retains selection and does not replay a model call.
                panel.locator('#capture-assistant-input').fill('继续采集原文，先不要保存')
                worker.evaluate('captureAI.release=null')
                panel.locator('#capture-assistant-send').click()
                for _ in range(200):
                    if worker.evaluate('Boolean(captureAI.release)'): break
                    panel.wait_for_timeout(50)
                assert worker.evaluate('Boolean(captureAI.release)')
                panel.locator('#capture-assistant-stop').click()
                expect(panel.locator('#capture-assistant-status')).to_contain_text('已停止',timeout=30000)
                expect(panel.locator('#capture-assistant-send')).to_be_enabled()
                panel.screenshot(path=str(out/'capture-chat-stopped-zh-dark-390.png'))
                stopped_requests=worker.evaluate('captureAI.requests.length')
                panel.reload();panel.locator('#open-capture-assistant').click()
                expect(panel.locator('#capture-assistant-save')).to_be_enabled(timeout=30000)
                expect(panel.locator('.capture-assistant-preview')).to_contain_text('Assistant creative reference')
                assert worker.evaluate('captureAI.requests.length')==stopped_requests
                before_false_claim=panel.evaluate("async()=>(await chrome.runtime.sendMessage({type:'GET_STATE'})).entries.length")
                worker.evaluate('captureAI.hold=false;captureAI.premature=true')
                panel.locator('#capture-assistant-input').fill('采集这页，按任务保存')
                panel.locator('#capture-assistant-send').click()
                expect(panel.locator('#capture-assistant-status')).to_contain_text('任务尚未完成',timeout=30000)
                expect(panel.locator('.capture-assistant-conversation')).not_to_contain_text('FORGED_SAVED_REPLY')
                expect(panel.locator('#capture-assistant-save')).to_be_enabled(timeout=30000)
                assert panel.evaluate("async()=>(await chrome.runtime.sendMessage({type:'GET_STATE'})).entries.length")==before_false_claim
                worker.evaluate('captureAI.premature=false')
                # Select real local files through the visible attachment button.
                import struct, zlib
                def png_chunk(kind, data): return struct.pack('>I',len(data))+kind+data+struct.pack('>I',zlib.crc32(kind+data))
                local_png=(b'\x89PNG\r\n\x1a\n'+png_chunk(b'IHDR',struct.pack('>IIBBBBB',24,24,8,2,0,0,0))
                    +png_chunk(b'IDAT',zlib.compress((b'\x00'+bytes([35,90,120])*24)*24))+png_chunk(b'IEND',b''))
                local_text=b'Exact local document original. Lighting and camera movement notes.'
                local_video=(Path(__file__).parent/'fixtures/review-workspace-smoke.mp4').read_bytes()
                before_attachments=panel.evaluate("async()=>(await chrome.runtime.sendMessage({type:'GET_STATE'})).entries.length")
                panel.evaluate("""() => {
                  const clip=new DataTransfer();clip.items.add(new File(['notes'], 'pasted-notes.txt', {type:'text/plain'}));
                  document.querySelector('#capture-assistant-input').dispatchEvent(new ClipboardEvent('paste',{clipboardData:clip,bubbles:true,cancelable:true}));
                }""")
                expect(panel.locator('.capture-assistant-composer .capture-assistant-attachments')).to_contain_text('pasted-notes.txt',timeout=30000)
                expect(panel.locator('.capture-assistant-attach')).to_be_enabled(timeout=30000)
                panel.evaluate("""() => {
                  const drop=new DataTransfer();drop.items.add(new File(['drop original'], 'dropped-notes.txt', {type:'text/plain'}));
                  document.querySelector('.capture-assistant-composer').dispatchEvent(new DragEvent('drop',{dataTransfer:drop,bubbles:true,cancelable:true}));
                }""")
                expect(panel.locator('.capture-assistant-composer .capture-assistant-attachments')).to_contain_text('dropped-notes.txt',timeout=30000)
                expect(panel.locator('.capture-assistant-attach')).to_be_enabled(timeout=30000)
                panel.locator('.capture-assistant-composer .capture-assistant-attachment button').first.click()
                panel.locator('.capture-assistant-composer .capture-assistant-attachment button').first.click()
                expect(panel.locator('.capture-assistant-composer .capture-assistant-attachments')).to_be_hidden()
                assert panel.evaluate("async()=>(await chrome.runtime.sendMessage({type:'GET_STATE'})).entries.length")==before_attachments
                with panel.expect_file_chooser() as chosen:
                    panel.locator('.capture-assistant-attach').click()
                chosen.value.set_files([{'name':'local-original.png','mimeType':'image/png','buffer':local_png},
                    {'name':'capture-notes.txt','mimeType':'text/plain','buffer':local_text},
                    {'name':'local-video.mp4','mimeType':'video/mp4','buffer':local_video}])
                expect(panel.locator('.capture-assistant-composer .capture-assistant-attachments')).to_contain_text('local-video.mp4',timeout=30000)
                assert 'local-video.mp4' not in panel.locator('.capture-assistant-preview').inner_text()
                assert panel.locator('#capture-assistant-model option').count() >= 2
                expect(panel.locator('#capture-assistant-status')).to_have_text('')
                panel.screenshot(path=str(out/'capture-chat-local-files-zh-dark-390.png'))
                panel.reload();panel.locator('#open-capture-assistant').click()
                expect(panel.locator('.capture-assistant-composer .capture-assistant-attachments')).to_contain_text('local-original.png',timeout=30000)
                expect(panel.locator('#capture-assistant-model option').filter(has_text='fixture-vision')).to_have_count(1,timeout=30000)
                selected=next(index for index,text in enumerate(panel.locator('#capture-assistant-model option').all_text_contents()) if text.endswith('fixture-vision'))
                panel.locator('#capture-assistant-model').select_option(index=selected)
                panel.screenshot(path=str(out/'capture-chat-model-and-attachments-zh-dark-390.png'))
                panel.locator('#capture-assistant-input').fill('保存这些附件，先选入预览')
                panel.locator('#capture-assistant-send').click()
                try:expect(panel.locator('.capture-assistant-preview')).to_contain_text('local-video.mp4',timeout=30000)
                except Exception:
                    (out/'attachment-failure.json').write_text(json.dumps({'status':panel.locator('#capture-assistant-status').text_content(),'model':panel.locator('#capture-assistant-model').input_value(),'fixtureError':worker.evaluate('captureAI.fixtureError'),'requests':worker.evaluate('captureAI.requests.slice(-5).map(request=>({model:request.model,tools:request.messages.flatMap(message=>message.tool_calls||[]).map(tool=>tool.function.name)}))'),'errors':run.page_errors},ensure_ascii=False))
                    raise
                assert worker.evaluate("captureAI.requests.some(request=>request.model==='fixture-vision' && JSON.stringify(request).includes('image_url'))")
                assert panel.evaluate("async()=>(await (await import('./library-storage.js')).getLibraryStorage().get('aiTaskAssignments')).aiTaskAssignments.creativePlanning.model")== 'deepseek-flash'
                panel.reload();panel.locator('#open-capture-assistant').click()
                expect(panel.locator('#capture-assistant-model')).to_have_value(re.compile('.*fixture-vision.*'),timeout=30000)
                receipt_count=panel.locator('.capture-assistant-result').count()
                panel.locator('#capture-assistant-save').click()
                expect(panel.locator('.capture-assistant-result')).to_have_count(receipt_count+1,timeout=30000)
                expect(panel.locator('.capture-assistant-result').last).to_contain_text('已保存',timeout=30000)
                local_assets=panel.evaluate("async()=>(await chrome.runtime.sendMessage({type:'GET_STATE'})).entries.flatMap(entry=>entry.mediaAssets)")
                for name,data in [('local-original.png',local_png),('capture-notes.txt',local_text),('local-video.mp4',local_video)]:
                    assert any(item.get('sourceTitle')==name for item in local_assets), {'missing':name,'assets':local_assets}
                    asset=next(item for item in local_assets if item.get('sourceTitle')==name)
                    actual=panel.evaluate("async id=>Array.from(new Uint8Array(await (await import('./media-store.js')).getMediaBlob(id).then(blob=>blob.arrayBuffer())))",asset['id'])
                    assert bytes(actual)==data
                # Natural-language explicit save uses the shared project lookup
                # and durable MCP receipt, while guidance above used no tool.
                worker.evaluate('captureAI.hold=false;captureAI.release=null')
                panel.locator('#capture-assistant-input').fill('采集正文与原图')
                panel.locator('#capture-assistant-send').click()
                expect(panel.locator('#capture-assistant-save')).to_be_enabled(timeout=30000)
                panel.locator('#capture-assistant-input').fill('新建镜头参考并保存')
                panel.locator('#capture-assistant-send').click()
                expect(panel.locator('#capture-assistant-save')).to_have_count(0,timeout=30000)
                expect(panel.locator('.capture-assistant-result').last).to_contain_text('已有案例，未新增采集内容',timeout=30000)
                state=panel.evaluate("async()=>chrome.runtime.sendMessage({type:'GET_STATE'})")
                project=next(item for item in state['organizerState']['collections'] if item['name']=='镜头参考')
                for _ in range(200):
                    chats=panel.evaluate("async()=>{const {captureAssistantDialog:dialog}=await (await import('./library-storage.js')).getLibraryStorage().get('captureAssistantDialog');return (await chrome.runtime.sendMessage({type:'GET_ASSISTANT_CHATS',activeId:dialog.activeId})).chats.find(chat=>chat.id===dialog.activeId)}")
                    receipts=[message['result'] for message in chats['messages'] if message['role']=='result']
                    if receipts and any(item.get('entryId') in project['entryIds'] for item in receipts[-1]['results']):break
                    panel.wait_for_timeout(50)
                save_receipt=receipts[-1]
                saved_id=save_receipt['results'][0]['entryId']
                assert saved_id in project['entryIds'], {'project':project,'receipt':save_receipt}
                saved_entry=next(item for item in panel.evaluate("async()=>(await chrome.runtime.sendMessage({type:'GET_STATE'})).entries") if item['id']==saved_id)
                assert 'Exact shadow prompt' in saved_entry['text']
                assert saved_entry['mediaAssets'][0]['id']==entry['mediaAssets'][0]['id']
                with run.context.expect_page() as opened_copy:
                    panel.locator('.capture-assistant-result').last.get_by_role('button',name='打开案例',exact=True).click()
                copy_page=opened_copy.value
                expect(copy_page.locator('#detail-drawer')).to_be_visible(timeout=30000)
                from urllib.parse import urlparse, parse_qs
                # The library consumes the opening query after showing it.
                # Verify the actual drawer identity, not an ephemeral URL.
                expect(copy_page.locator('#detail-drawer')).to_have_attribute('data-entry-id',saved_id,timeout=30000)
                copy_page.close()
                panel.screenshot(path=str(out/'capture-chat-project-saved-zh-dark-390.png'))
                # The site adapter really fails; the Agent reads the actual DOM
                # and supplements it. A real 404 then verifies partial save.
                web.goto(origin+'/failed');panel.reload();panel.locator('#open-capture-assistant').click()
                panel.locator('#capture-assistant-new').click()
                panel.locator('#capture-assistant-input').fill('网页采集没成功，帮我补采原文、图片和视频')
                panel.locator('#capture-assistant-send').click()
                try: expect(panel.locator('#capture-assistant-save')).to_be_enabled(timeout=30000)
                except AssertionError:
                    print(panel.locator('body').inner_text(),flush=True)
                    print(panel.evaluate("async()=> (await chrome.runtime.sendMessage({type:'GET_ASSISTANT_CHATS'})).chats.map(c=>({id:c.id,events:c.events?.filter(e=>e.type==='preview_conflict')}))"),flush=True)
                    print(worker.evaluate("captureAI.requests.slice(-5).map(b=>b.messages.filter(m=>m.role==='tool'))"),flush=True)
                    raise
                expect(panel.locator('.capture-assistant-preview')).to_contain_text('2 个媒体')
                panel.screenshot(path=str(out/'capture-chat-adapter-recovered-zh-dark-390.png'))
                panel.locator('#capture-assistant-save').click()
                expect(panel.locator('.capture-assistant-result').last).to_contain_text('已部分保存',timeout=30000)
                try: expect(panel.locator('#capture-assistant-save')).to_be_enabled()
                except AssertionError:
                    print(panel.locator('body').inner_text(),flush=True)
                    print(panel.evaluate("async()=> (await import('./library-storage.js')).getLibraryStorage().get('captureAssistantDialog')"),flush=True)
                    raise
                partial_state=panel.evaluate("async()=>chrome.runtime.sendMessage({type:'GET_STATE'})")
                partial=next(item for item in partial_state['entries'] if item['url']==origin+'/failed')
                assert 'Exact shadow prompt' in partial['text']
                assert any(asset['kind']=='image' and asset['storageMode']=='managed' for asset in partial['mediaAssets'])
                assert any(asset['kind']=='video' and asset['storageMode']=='reference' for asset in partial['mediaAssets'])
                panel.screenshot(path=str(out/'capture-chat-partial-zh-dark-390.png'))
                # Narrow/wide, English/light and Chinese/dark inspect the actual
                # implementation. No copied prototype or installed daily data.
                for locale,theme in [('en','light'),('zh-CN','dark')]:
                    panel.evaluate("async prefs=>chrome.storage.local.set({uiPreferences:prefs})",{'locale':locale,'theme':theme,'motion':'reduced'})
                    panel.reload();panel.locator('#open-capture-assistant').click()
                    for width in [320,960]:
                        panel.set_viewport_size({'width':width,'height':844})
                        expect(panel.locator('#capture-assistant-panel')).to_be_visible()
                        panel.locator('.capture-assistant-conversation').hover();panel.mouse.wheel(0,1400)
                        expect(panel.locator('#capture-assistant-save')).to_be_in_viewport()
                        assert panel.locator('#capture-assistant-panel').evaluate('e=>e.scrollWidth<=e.clientWidth')
                        assert panel.evaluate('document.documentElement.scrollWidth<=innerWidth'), panel.evaluate("Array.from(document.querySelectorAll('body *')).filter(e=>!e.hidden&&e.getBoundingClientRect().right>innerWidth).map(e=>({tag:e.tagName,id:e.id,class:e.className,right:e.getBoundingClientRect().right}))")
                        for selector in ['#capture-assistant-new','#capture-assistant-diagnostic','#open-library']:
                            assert panel.locator(selector).evaluate('e=>{const r=e.getBoundingClientRect();return r.x>=0&&r.right<=innerWidth}'),selector
                        assert panel.locator('#capture-assistant-send').evaluate('e=>{const r=e.getBoundingClientRect();return r.right<=innerWidth&&r.bottom<=innerHeight}')
                        panel.screenshot(path=str(out/f'capture-chat-{locale}-{theme}-{width}.png'))
                        panel.locator('.capture-assistant-project > summary').click()
                        expect(panel.locator('#capture-assistant-content-type')).to_be_visible()
                        assert panel.locator('.capture-assistant-project .detail-project-popover').evaluate('e=>{const r=e.getBoundingClientRect();return r.x>=0 && r.right<=innerWidth && r.y>=0 && r.bottom<=innerHeight}')
                        assert panel.locator('.capture-assistant-project .detail-project-popover').evaluate('e=>e.scrollWidth<=e.clientWidth'), 'type and project controls must not clip horizontally'
                        expect(panel.locator('.capture-assistant-project .detail-project-list')).to_be_visible()
                        panel.screenshot(path=str(out/f'capture-type-menu-{locale}-{theme}-{width}.png'))
                        panel.locator('.capture-assistant-project > summary').click()
                # The save-card menu exposes the real shared classification draft.
                panel.locator('.capture-assistant-project > summary').click()
                expect(panel.locator('#capture-assistant-content-type')).to_be_visible()
                assert panel.locator('#capture-assistant-content-type option[value="content:code-case"]').count()==1
                panel.locator('#capture-assistant-content-type').select_option('content:reference')
                expect(panel.locator('#capture-assistant-content-type')).to_have_value('content:reference')
                panel.screenshot(path=str(out/'capture-type-selected-zh-dark-960.png'))
                panel.locator('.capture-assistant-project > summary').click()
                count=panel.locator('.capture-assistant-result').count()
                panel.locator('#capture-assistant-save').click()
                expect(panel.locator('.capture-assistant-result')).to_have_count(count+1,timeout=30000)
                assert panel.evaluate("async()=>(await chrome.runtime.sendMessage({type:'GET_STATE'})).entries.some(entry=>entry.classification?.pathIds?.[0]==='content:reference' && entry.classification?.source==='manual')")
                # Full reply visibility is exercised by plugin_assistant_e2e.
                results={'manualContentTypeSaveReadback':True,'mcpPreviewAndSupplement':True,'exactOriginalBytesReadback':True,'saveRetryDoesNotDuplicate':True,
                    'guidanceWithoutScanTools':True,'markdownAndStreamingWired':True,'inChatSaveAndOpenCase':True,
                    'closeContinuesAndReopenRestores':True,'explicitStopRetainsPreview':True,'changedPageDoesNotApplyOldPreview':True,'earlyFalseCompletionDoesNotRemainInChatOrWriteCases':True,
                    'sameSourceDoesNotDuplicateOrReplaceOriginalPrompt':True,'localFilesSurviveReloadAndExactBytes':True,'chatPasteDropRemoveWithoutLibraryWrites':True,'modelSelectionSendsActualImageWithoutChangingGlobalRoute':True,'naturalLanguageSaveToProject':True,'naturalLanguageCreateProjectAndSave':True,
                    'adapterFailureRecoveredFromObservedPage':True,'partialSaveRetainsSuccessfulOriginalsAndPreview':True,'sameConversationAcrossPagesWithSeparatePreviews':True,'newChatPreservesPendingSelectionAfterReload':True,'multiPageDiagnosticNativeDownload':True,'crossProjectSaveReceiptOpensTargetCopy':True,
                    'diagnosticExcludesSecretsAndMediaPayloads':True,'paidRequests':0,'pageErrors':run.page_errors}
                (out/'capture-chat-results.json').write_text(json.dumps(results,ensure_ascii=False,indent=2)+'\n')
                print(json.dumps(results),flush=True)
    finally:
        server.shutdown(); server.server_close()

if __name__=='__main__': main()
