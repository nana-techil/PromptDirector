"""Bulk cleanup spans every group and every member, including offscreen differing notes."""
import copy,tempfile
from pathlib import Path
from playwright.sync_api import expect
from e2e_support import extension_session,base_entry

def main():
 out=Path(tempfile.gettempdir())/'pd-case-dedupe-bulk';out.mkdir(exist_ok=True)
 with extension_session('pd-dedupe-bulk-',viewport={'width':1440,'height':1000}) as run:
  setup=run.open_page('collector.html')
  assets=setup.evaluate('''async()=>{const {saveMediaBlob}=await import('./media-store.js');const {sha256Blob}=await import('./blob-digest.js');const assets=[];for(let i=0;i<60;i++){const c=document.createElement('canvas');c.width=120;c.height=80;const x=c.getContext('2d');x.fillStyle=`hsl(${i*6},60%,50%)`;x.fillRect(0,0,120,80);x.fillStyle='white';x.font='24px sans-serif';x.fillText(String(i),15,40);const blob=await new Promise(r=>c.toBlob(r));const id='group-image-'+i;await saveMediaBlob(id,blob,{checkCapacity:false});assets.push({id,kind:'image',mimeType:'image/png',storageMode:'managed',byteSize:blob.size,contentHash:await sha256Blob(blob)});}return assets;}''')
  entries=[];expected_keep=set()
  for g,asset in enumerate(assets):
   count=36 if g==0 else 3
   for i in range(count):
    e=base_entry(f'case-{g}-{i}',f'Group {g}',f'Original note {i}','content:prompt:image',0)
    e.update(mediaAssets=[copy.deepcopy(asset)],libraryAddedAt=f'2026-10-09T00:00:{i:02d}Z');entries.append(e)
   expected_keep.add(f'case-{g}-{count-1}')
  run.seed_storage(setup,{'entries':entries,'uiPreferences':{'locale':'zh-CN','theme':'dark','motion':'reduced'},'dataSafetyOnboardingSeen':True})
  p=run.open_page('library.html',wait_until='networkidle');p.locator('#open-settings').click();p.locator('[data-settings-tab=tasks]').click();p.locator('#inspect-duplicates').click()
  d=p.locator('.case-dedupe-panel');expect(d.locator('.dedupe-summary')).to_contain_text('60 组重复',timeout=30000)
  expect(d.locator('.dedupe-summary')).to_contain_text('213 个案例')
  expect(d.locator('.dedupe-footer')).to_contain_text('保留 60 份 · 清理 153 份')
  assert d.locator('.dedupe-group-row').count()<60
  p.screenshot(path=str(out/'bulk-overview.png'))
  d.get_by_role('button',name='取消全选',exact=True).click();expect(d.locator('.dedupe-footer')).to_contain_text('清理 0 份')
  d.get_by_role('button',name='全选所有重复组',exact=True).click();expect(d.locator('.dedupe-footer')).to_contain_text('清理 153 份')
  d.get_by_label('保留规则',exact=True).select_option('oldest');expect(d.locator('.dedupe-footer')).to_contain_text('清理 153 份')
  d.get_by_label('保留规则',exact=True).select_option('newest')
  p.set_viewport_size({'width':390,'height':900})
  p.wait_for_function("()=>document.querySelector('.dedupe-footer').getBoundingClientRect().bottom<=innerHeight")
  assert d.evaluate('e=>e.scrollWidth<=e.clientWidth+1')
  p.screenshot(path=str(out/'bulk-narrow.png'))
  p.set_viewport_size({'width':1440,'height':1000})
  # Two clicks regardless of number of groups: prepare all, then confirm a reversible cleanup.
  d.get_by_role('button',name='一键清理重复',exact=True).click()
  expect(d.locator('.dedupe-review')).to_contain_text('将保留 60 份，清理 153 份',timeout=30000)
  expect(d.locator('.dedupe-review')).to_contain_text('153 份附带资料有差异')
  assert len(p.evaluate("async()=> (await chrome.runtime.sendMessage({type:'GET_STATE'})).entries"))==213
  p.screenshot(path=str(out/'bulk-confirm.png'))
  d.get_by_role('button',name='确认移入回收站',exact=True).click()
  expect(d.locator('.dedupe-status')).to_contain_text('153 个案例已移入回收站',timeout=30000)
  state=p.evaluate("async()=>chrome.runtime.sendMessage({type:'GET_STATE'})")
  assert {e['id'] for e in state['entries']}==expected_keep
  assert len(state['trashState']['items'])==153
  restored=p.evaluate("async ids=>chrome.runtime.sendMessage({type:'RESTORE_TRASH_ITEMS',itemIds:ids})",[r['id'] for r in state['trashState']['items']]);assert restored['ok'],restored
  state=p.evaluate("async()=>chrome.runtime.sendMessage({type:'GET_STATE'})")
  assert {e['id']:e['text'] for e in state['entries']}=={e['id']:e['text'] for e in entries}
  assert not run.page_errors,run.page_errors
  print({'groups':60,'cases':213,'bulkRemoved':153,'keptLatest':60,'restoredOriginalNotes':True,'selectionIndependentOfVisiblePage':True,'screenshots':str(out)})
if __name__=='__main__':main()
