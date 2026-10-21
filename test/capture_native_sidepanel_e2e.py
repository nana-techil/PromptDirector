"""Actual native side panel file preparation, not a tab standing in for it."""
import json,tempfile,base64,os
from pathlib import Path
from e2e_support import extension_session,EXTENSION_DIR
with tempfile.TemporaryDirectory(prefix='pd-native-sender-') as tmp:
 ext=Path(tmp)
 for p in EXTENSION_DIR.iterdir():
  if p.name!='background.js':(ext/p.name).symlink_to(p,target_is_directory=p.is_dir())
 (ext/'probe.html').write_text('<html><body>Side panel test launcher</body></html>')
 (ext/'background.js').write_text((EXTENSION_DIR/'background.js').read_text()+"\nchrome.runtime.onMessage.addListener((m,s,reply)=>{if(m.type==='PROBE_SENDER'){reply(s);return false;}});\n")
 with extension_session('pd-native-sender-',extension_dir=ext) as run:
  p=run.open_page('probe.html')
  p.evaluate("""()=>{let b=document.createElement('button');b.id='probe';b.textContent='open';b.onclick=async()=>{await chrome.sidePanel.open({windowId:(await chrome.windows.getCurrent()).id});window.probe=1};document.body.append(b)}""")
  p.evaluate("()=>document.querySelectorAll('dialog[open]').forEach(d=>d.close())");p.locator('#probe').click();p.wait_for_function('window.probe')
  cdp=run.context.new_cdp_session(p); targets=cdp.send('Target.getTargets')['targetInfos']; target=next(t for t in targets if t['url'].endswith('/collector.html'))
  sid=cdp.send('Target.attachToTarget',{'targetId':target['targetId'],'flatten':False})['sessionId'];responses={}
  cdp.on('Target.receivedMessageFromTarget',lambda e:responses.update({json.loads(e['message']).get('id'):json.loads(e['message'])}))
  sequence=0
  def rpc(method,params):
   global sequence
   sequence+=1; call_id=sequence
   cdp.send('Target.sendMessageToTarget',{'sessionId':sid,'message':json.dumps({'id':call_id,'method':method,'params':params})})
   for _ in range(200):
    if call_id in responses:break
    p.wait_for_timeout(50)
   result=responses.pop(call_id);assert 'error' not in result,result
   return result['result']
  def evaluate(expression):
   result=rpc('Runtime.evaluate',{'expression':expression,'awaitPromise':True,'returnByValue':True})
   assert 'exceptionDetails' not in result,result
   return result['result'].get('value')
  for _ in range(100):
   if evaluate("Boolean(document.querySelector('#open-capture-assistant'))"):break
   p.wait_for_timeout(50)
  evaluate("import(chrome.runtime.getURL('collector.js')).then(module => module.collectorStartup)")
  sender=evaluate("chrome.runtime.sendMessage({type:'PROBE_SENDER'})")
  assert 'documentId' not in sender,sender
  evaluate("document.querySelector('#open-capture-assistant').click()")
  png=base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=')
  file=ext/'user-screenshot.png';file.write_bytes(png)
  obj=rpc('Runtime.evaluate',{'expression':"document.querySelector('#capture-assistant-panel input[type=file]')"})['result']['objectId']
  rpc('DOM.setFileInputFiles',{'objectId':obj,'files':[str(file)]})
  for _ in range(600):
   if evaluate("document.querySelector('.capture-assistant-composer .capture-assistant-attachments')?.textContent.includes('user-screenshot.png')"):break
   p.wait_for_timeout(50)
  status=evaluate("document.querySelector('#capture-assistant-status').textContent")
  assert '文件准备只能' not in status,status
  assert evaluate("document.querySelector('.capture-assistant-composer .capture-assistant-attachments').textContent.includes('user-screenshot.png')")
  original=evaluate("(async()=>{let img=document.querySelector('.capture-assistant-composer .capture-assistant-attachment img');for(let i=0;i<100&&!img?.src;i++){await new Promise(r=>setTimeout(r,20));img=document.querySelector('.capture-assistant-composer .capture-assistant-attachment img')}return Array.from(new Uint8Array(await(await fetch(img.src)).arrayBuffer()))})()")
  assert bytes(original)==png
  saved=evaluate("chrome.runtime.sendMessage({type:'GET_STATE'}).then(state=>state.entries.length)")
  assert saved==0
  before=evaluate("chrome.storage.local.get('captureAssistantDialog').then(value=>value.captureAssistantDialog.activeId)")
  evaluate("document.querySelector('.library-entry').click()")
  for _ in range(200):
   if evaluate("chrome.tabs.query({}).then(tabs=>tabs.some(tab=>tab.url?.endsWith('/library.html')))"):break
   p.wait_for_timeout(50)
  assert evaluate("chrome.tabs.query({}).then(tabs=>tabs.some(tab=>tab.url?.endsWith('/library.html')))") or any(t['url'].endswith('/library.html') for t in cdp.send('Target.getTargets')['targetInfos']), {'targets':cdp.send('Target.getTargets')['targetInfos'],'feedback':evaluate("document.querySelector('#feedback')?.textContent"),'errors':run.page_errors}
  # The side panel re-attaches to the newly opened library tab; poll the same
  # panel/conversation facts instead of sampling one slow CI frame.
  for _ in range(600):
   if evaluate("chrome.runtime.getContexts({contextTypes:['SIDE_PANEL']}).then(contexts=>contexts.some(context=>context.documentUrl.endsWith('/collector.html')))"):break
   p.wait_for_timeout(50)
  assert evaluate("chrome.runtime.getContexts({contextTypes:['SIDE_PANEL']}).then(contexts=>contexts.some(context=>context.documentUrl.endsWith('/collector.html')))")
  for _ in range(600):
   if evaluate("document.querySelector('#capture-assistant-panel')?.hidden===false"):break
   p.wait_for_timeout(50)
  assert evaluate("document.querySelector('#capture-assistant-panel').hidden") is False
  for _ in range(600):
   if evaluate("document.querySelector('.capture-assistant-composer .capture-assistant-attachments')?.textContent.includes('user-screenshot.png')"):break
   p.wait_for_timeout(50)
  assert evaluate("document.querySelector('.capture-assistant-composer .capture-assistant-attachments').textContent.includes('user-screenshot.png')")
  for _ in range(200):
   if evaluate("chrome.storage.local.get('captureAssistantDialog').then(value=>value.captureAssistantDialog.activeId)")==before:break
   p.wait_for_timeout(50)
  assert evaluate("chrome.storage.local.get('captureAssistantDialog').then(value=>value.captureAssistantDialog.activeId)")==before
  out=Path(os.environ.get('PD_E2E_ARTIFACT_DIR','/tmp/pd-native-sidepanel'));out.mkdir(parents=True,exist_ok=True)
  shot=rpc('Page.captureScreenshot',{'format':'png'})['data'];(out/'native-sidepanel-attachment.png').write_bytes(base64.b64decode(shot))
  result={'nativeSidePanel':True,'samePanelAndConversationRemainInLibrary':True,'senderDocumentIdAbsent':True,'screenshotAttachmentPrepared':True,'noAutomaticIngest':True,'originalBytesReadback':True,'status':status,'paidRequests':0}
  (out/'results.json').write_text(json.dumps(result,ensure_ascii=False,indent=2));print(json.dumps(result,ensure_ascii=False))
