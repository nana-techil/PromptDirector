"""Compare whole cases, review real differences, recover cleanup, retain projects and originals."""
import tempfile,copy,base64,hashlib
from pathlib import Path
from playwright.sync_api import expect
from e2e_support import extension_session,base_entry,wait_for_async_condition

def main():
 out=Path(tempfile.gettempdir())/'pd-case-dedupe-evidence';out.mkdir(exist_ok=True)
 with extension_session('pd-case-dedupe-',viewport={'width':1440,'height':1000}) as run:
  setup=run.open_page('collector.html')
  blob=setup.evaluate('''async()=>{const c=document.createElement('canvas');c.width=60;c.height=40;const x=c.getContext('2d');x.fillStyle='#658c82';x.fillRect(0,0,60,40);const b=await new Promise(r=>c.toBlob(r));const {sha256Blob}=await import('./blob-digest.js');return {bytes:[...new Uint8Array(await b.arrayBuffer())],hash:await sha256Blob(b),size:b.size};}''')
  a=base_entry('a','山谷公路','Slow camera move through the valley.','content:prompt:image',0)
  a.update(customLabels=['镜头参考'],libraryAddedAt='2026-10-01T00:00:00Z',mediaAssets=[{'id':'image-a','kind':'image','storageMode':'managed','mimeType':'image/png','byteSize':blob['size'],'contentHash':blob['hash']}])
  b=copy.deepcopy(a);b.update(id='b',libraryAddedAt='2026-10-02T00:00:00Z');b['mediaAssets'][0]['id']='image-b'
  c=copy.deepcopy(a);c.update(id='c',text='Fast camera move through the valley.');c['mediaAssets'][0]['id']='image-c'
  d=copy.deepcopy(a);d.update(id='d');d['mediaAssets'][0]['id']='image-d'
  run.seed_storage(setup,{'entries':[a,b,c,d],'organizerState':{'collections':[{'id':'project','name':'跨项目保留','entryIds':['d']}]},'uiPreferences':{'locale':'zh-CN','theme':'dark','motion':'reduced'},'dataSafetyOnboardingSeen':True})
  setup.evaluate('''async bytes=>{const {saveMediaBlob}=await import('./media-store.js');for(const id of ['image-a','image-b','image-c','image-d'])await saveMediaBlob(id,new Blob([new Uint8Array(bytes)],{type:'image/png'}),{checkCapacity:false});}''',blob['bytes'])
  p=run.open_page('library.html',wait_until='networkidle')
  p.locator('.case-card[data-entry-id="a"]').click()
  assert p.locator('#detail-content .tag-editor-chip').first.evaluate("e=>e.firstElementChild.matches('.tag-color-button') && e.lastElementChild.textContent==='×'")
  p.locator('#detail-content .tag-color-button').first.click()
  p.screenshot(path=str(out/'tag-dot-first.png'))
  p.keyboard.press('Escape');p.keyboard.press('Escape');p.locator('#open-settings').click();p.locator('[data-settings-tab=tasks]').click();p.locator('#inspect-duplicates').click()
  dialog=p.locator('.case-dedupe-panel');expect(dialog).to_be_visible()
  expect(dialog.locator('.dedupe-status')).to_contain_text('核对完成',timeout=30000)
  expect(dialog.locator('.dedupe-footer')).to_contain_text('清理 2 份')
  p.screenshot(path=str(out/'exact-wide.png'))
  dialog.get_by_role('button',name='查看详情',exact=True).first.click()
  expect(dialog.locator('.dedupe-case')).to_have_count(3)
  dialog.locator('summary').filter(has_text='正文 · 不同').first.click()
  expect(dialog.locator('mark').first).to_be_visible()
  assert any('Fast' in text for text in dialog.locator('mark').all_text_contents())
  p.screenshot(path=str(out/'differences-wide.png'))
  # Changing the keeper updates choices/differences without destroying the
  # already loaded original or the reader's expanded full text.
  first_case=dialog.locator('.dedupe-case').first
  first_case.locator('details').filter(has=p.locator('summary',has_text='完整案例内容')).last.evaluate('(e)=>e.open=true')
  first_case.evaluate('(e)=>{window.__dedupeFirstId=e.dataset.entryId;window.__dedupeImage=e.querySelector(".dedupe-preview img");}')
  dialog.get_by_role('button',name='改为保留这份',exact=True).first.click()
  assert p.evaluate('()=>document.querySelector(`.dedupe-case[data-entry-id="${window.__dedupeFirstId}"] .dedupe-preview img`)===window.__dedupeImage')
  assert p.evaluate('()=>[...document.querySelectorAll(`.dedupe-case[data-entry-id="${window.__dedupeFirstId}"] details`)].some(e=>e.open && e.querySelector("summary").textContent==="完整案例内容")')

  p.set_viewport_size({'width':390,'height':900})
  assert dialog.evaluate('e=>e.scrollWidth<=e.clientWidth+1')
  p.screenshot(path=str(out/'differences-narrow.png'))
  p.wait_for_function("()=>document.querySelector('.dedupe-footer').getBoundingClientRect().bottom<=innerHeight")
  p.screenshot(path=str(out/'differences-narrow.png'))
  p.set_viewport_size({'width':1440,'height':1000})
  dialog.get_by_role('button',name='返回全部重复组',exact=True).click()
  dialog.locator('summary').filter(has_text='清理选项').click()
  dialog.get_by_label('仅清理附带资料也一致的副本',exact=True).check()
  expect(dialog.locator('.dedupe-footer')).to_contain_text('清理 1 份')
  dialog.get_by_role('button',name='一键清理重复',exact=True).click()
  expect(dialog.get_by_role('button',name='确认移入回收站',exact=True)).to_be_visible()
  expect(dialog.locator('.dedupe-review')).to_contain_text('清理 1 份')
  # Review does not mutate the library; cancel remains possible.
  s=p.evaluate("async()=>chrome.runtime.sendMessage({type:'GET_STATE'})")
  assert len(s['entries'])==4
  dialog.get_by_role('button',name='确认移入回收站',exact=True).click()
  expect(dialog.locator('.dedupe-status')).to_contain_text('1 个案例已移入回收站',timeout=30000)
  s=p.evaluate("async()=>chrome.runtime.sendMessage({type:'GET_STATE'})")
  assert {e['id'] for e in s['entries']}=={'b','c','d'}
  trash=s['trashState']['items'];assert len(trash)==1 and trash[0]['snapshot']['text']==a['text']
  restored=p.evaluate("async id=>chrome.runtime.sendMessage({type:'RESTORE_TRASH_ITEMS',itemIds:[id]})",trash[0]['id']);assert restored['ok']
  assert p.evaluate("async()=>{const {getMediaBlob}=await import('./media-store.js');return (await getMediaBlob('image-a')).size;}")==blob['size']
  # Unknown originals become eligible only after actual local bytes are checked.
  p.evaluate("""async()=>{const {getLibraryStorage}=await import('./library-storage.js');const storage=getLibraryStorage();const state=await storage.get('entries');for(const e of state.entries)if(['a','b'].includes(e.id))for(const a of e.mediaAssets)delete a.contentHash;await storage.set({entries:state.entries});}""")
  p.reload(wait_until='networkidle');p.locator('#open-settings').click();p.locator('[data-settings-tab=tasks]').click();p.locator('#inspect-duplicates').click()
  dialog=p.locator('.case-dedupe-panel');expect(dialog.locator('[data-review=pending]')).to_contain_text('待核对 2 个案例')
  dialog.get_by_role('button',name='核对原件',exact=True).click()
  expect(dialog.locator('.dedupe-status')).to_contain_text('核对完成',timeout=30000)
  stored=p.evaluate("async()=>chrome.runtime.sendMessage({type:'GET_STATE'})")
  assert all(e['mediaAssets'][0].get('contentHash')==blob['hash'] for e in stored['entries'])
  p.evaluate("async()=>chrome.runtime.sendMessage({type:'UPDATE_UI_PREFERENCES',preferences:{locale:'en'}})")
  p.close();p=run.open_page('library.html',wait_until='networkidle');p.locator('#open-settings').click();p.locator('[data-settings-tab=tasks]').click();p.locator('#inspect-duplicates').click()
  dialog=p.locator('.case-dedupe-panel');expect(dialog.locator('.dedupe-status')).to_contain_text('comparison complete',timeout=30000)
  for text in dialog.locator('.dedupe-toolbar button,.dedupe-footer button').all_text_contents():
   assert not any('\u4e00'<=char<='\u9fff' for char in text),text
  p.screenshot(path=str(out/'exact-english.png'))
  p.close()
  # Different image originals with identical title, prompt and source must never be listed.
  visual=setup.evaluate("""async()=>{const rows=[];const {saveMediaBlob}=await import('./media-store.js');const {sha256Blob}=await import('./blob-digest.js');for(let n=0;n<3;n++){const c=document.createElement('canvas');c.width=180+n*90;c.height=120+n*60;const x=c.getContext('2d');const g=x.createLinearGradient(0,0,c.width,0);g.addColorStop(0,n===1?'#284060':'#203050');g.addColorStop(1,n===1?'#d0c0a0':'#c0b090');x.fillStyle=n===2?'#658c82':g;x.fillRect(0,0,c.width,c.height);const b=await new Promise(r=>c.toBlob(r));const id='visual-'+n;await saveMediaBlob(id,b,{checkCapacity:false});rows.push({id,kind:'image',storageMode:'managed',mimeType:'image/png',byteSize:b.size,contentHash:await sha256Blob(b)});}return rows;}""")
  entries=[]
  for index,asset in enumerate(visual):
   e=base_entry('visual-case-'+str(index),'Same title','Same prompt','content:prompt:image',index)
   e.update(mediaAssets=[asset],url='https://example.com/same');entries.append(e)
  run.seed_storage(setup,{'entries':entries,'uiPreferences':{'locale':'zh-CN','theme':'dark'},'dataSafetyOnboardingSeen':True})
  p=run.open_page('library.html',wait_until='networkidle');p.locator('#open-settings').click();p.locator('[data-settings-tab=tasks]').click();p.locator('#inspect-duplicates').click()
  dialog=p.locator('.case-dedupe-panel');expect(dialog.locator('.dedupe-status')).to_contain_text('核对完成',timeout=30000)
  expect(dialog.locator('.dedupe-groups')).to_be_empty()
  expect(dialog.locator('.dedupe-summary')).to_contain_text('未发现重复')
  expect(dialog.get_by_role('button',name='查找相似图片',exact=True)).to_have_count(0)
  expect(dialog.locator('.dedupe-case')).to_have_count(0)
  expect(dialog.locator('.dedupe-footer')).to_be_hidden()
  expect(dialog.get_by_role('button',name='一键清理重复',exact=True)).to_have_count(0)
  p.screenshot(path=str(out/'different-images-not-duplicates.png'))
  p.close()
  # Full video originals, not matching posters or the same text, determine duplicates.
  clips=[Path(__file__).parent/'fixtures/review-workspace-smoke.mp4',Path(__file__).parent/'fixtures/detail-portrait-smoke.mp4']
  videos=[]
  for index in range(3):
   data=clips[0 if index<2 else 1].read_bytes();mid='video-'+str(index)
   setup.evaluate("""async ({id,data})=>{const {saveMediaBlob}=await import('./media-store.js');await saveMediaBlob(id,new Blob([Uint8Array.from(atob(data),c=>c.charCodeAt(0))],{type:'video/mp4'}),{checkCapacity:false});}""",{'id':mid,'data':base64.b64encode(data).decode()})
   v=base_entry('video-case-'+str(index),'Same video title','Same prompt','content:prompt:video',index)
   v.update(url='https://example.com/same-video',mediaAssets=[{'id':mid,'kind':'video','mimeType':'video/mp4','storageMode':'managed','contentHash':hashlib.sha256(data).hexdigest(),'byteSize':len(data)},{**visual[0],'usage':'poster'}]);videos.append(v)
  run.seed_storage(setup,{'entries':videos,'uiPreferences':{'locale':'zh-CN','theme':'dark'},'dataSafetyOnboardingSeen':True})
  p=run.open_page('library.html',wait_until='networkidle');p.locator('#open-settings').click();p.locator('[data-settings-tab=tasks]').click();p.locator('#inspect-duplicates').click()
  dialog=p.locator('.case-dedupe-panel');expect(dialog.locator('.dedupe-summary')).to_contain_text('1 组重复',timeout=30000)
  dialog.get_by_role('button',name='查看详情',exact=True).first.click()
  expect(dialog.locator('.dedupe-case')).to_have_count(2)
  assert set(dialog.locator('.dedupe-case').evaluate_all("nodes=>nodes.map(n=>n.dataset.entryId)"))=={'video-case-0','video-case-1'}
  p.wait_for_function("()=>[...document.querySelectorAll('.dedupe-preview video')].length===2 && [...document.querySelectorAll('.dedupe-preview video')].every(v=>v.readyState>=1)")
  dialog.locator('.dedupe-preview video').first.evaluate('async v=>{v.loop=true;v.muted=true;await v.play();window.__playingDuplicate=v;window.__duplicateTime=v.currentTime;}')
  dialog.get_by_role('button',name='改为保留这份',exact=True).first.click()
  assert p.evaluate('()=>window.__playingDuplicate.isConnected && !window.__playingDuplicate.paused')
  p.wait_for_function('()=>window.__playingDuplicate.currentTime>window.__duplicateTime')
  p.screenshot(path=str(out/'identical-video-only.png'))
  assert not run.page_errors,run.page_errors
  print({'exactOriginalsOnly':True,'wordDifference':True,'crossProjectKept':True,'restoreAndOriginal':True,'tagDotFirst':True,'differentImagesNeverListed':True,'identicalVideoOnly':True,'widths':[1440,390],'screenshots':str(out)})
if __name__=='__main__':main()
