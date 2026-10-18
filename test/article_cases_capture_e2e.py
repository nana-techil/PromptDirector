"""Synthetic WeChat-style rich text. No request to a real WeChat article is made."""
import json,tempfile,hashlib,struct,zlib
from pathlib import Path
from playwright.sync_api import expect
from e2e_support import EXTENSION_DIR,extension_session
def image_bytes(url):
 # Distinct valid pixels prevent the library's content deduplication merging fixture images.
 rgb=hashlib.sha256(url.encode()).digest()[:3]
 def chunk(kind,data):
  return struct.pack('>I',len(data))+kind+data+struct.pack('>I',zlib.crc32(kind+data))
 return b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',1,1,8,2,0,0,0))+chunk(b'IDAT',zlib.compress(b'\0'+rgb))+chunk(b'IEND',b'')
URL='https://mp.weixin.qq.com/s/promptdirector-synthetic-article'
HTML='''<html><head><meta charset="utf-8"><title>Rich text cases</title></head><body><h1 id="activity-name">Rich text cases</h1><span id="js_name">Fixture author</span><div id="js_content"><p>Article introduction</p><img data-src="https://mmbiz.qpic.cn/intro.png" width="160" height="120">'''+''.join(f'''<section><section><strong>{i}、案例{i}</strong></section><section><span>提示词：</span></section><section><span>Generate scene {i} with its own visual composition.</span></section>'''+''.join(f'<img data-src="https://mmbiz.qpic.cn/case-{i}-{n}.png" width="160" height="120">' for n in range(i))+ '</section>' for i in range(1,4))+ '</div></body></html>'
HIERARCHY_URL=URL+'-hierarchy'
HIERARCHY_HTML='''<html><head><meta charset="utf-8"><title>Hierarchy source</title></head><body>
<h1 id="activity-name">Hierarchy source</h1><span id="js_name">Fixture author</span><div id="js_content">
<h1>第一章</h1><h2>短原文案例A</h2><h3>提示词</h3><p>蓝色的猫</p>
<img data-src="https://mmbiz.qpic.cn/hierarchy-a.png" width="160" height="120">
<h2>短原文案例B</h2><h3>提示词</h3><p>红色的鸟</p>
<img data-src="https://mmbiz.qpic.cn/hierarchy-b.png" width="160" height="120">
<h1>第二章</h1><p>下一章引言，不能属于案例B。</p></div></body></html>'''

def main():
 with tempfile.TemporaryDirectory(prefix='pd-article-case-fixture-') as tmp:
  ext=Path(tmp)
  for f in EXTENSION_DIR.iterdir():
   if f.name!='manifest.json':(ext/f.name).symlink_to(f,target_is_directory=f.is_dir())
  manifest=json.loads((EXTENSION_DIR/'manifest.json').read_text());manifest['host_permissions']+=['https://mp.weixin.qq.com/*','https://*.qpic.cn/*']
  (ext/'manifest.json').write_text(json.dumps(manifest))
  with extension_session('pd-article-cases-',extension_dir=ext) as run:
   run.context.route('https://mp.weixin.qq.com/**',lambda r:r.fulfill(body=HIERARCHY_HTML if r.request.url==HIERARCHY_URL else HTML,content_type='text/html'))
   run.context.route('https://*.qpic.cn/**',lambda r:r.fulfill(body=image_bytes(r.request.url),content_type='image/png'))
   panel=run.open_page('collector.html');panel.set_viewport_size({'width':390,'height':844})
   run.seed_storage(panel,{'entries':[],'capturePermissionOnboarding':{'version':1,'acknowledgedAt':'2026-09-12T00:00:00Z','clipboardIncluded':True}})
   source=run.context.new_page();source.goto(URL);source.bring_to_front()
   panel.locator('#start-page-capture').evaluate('e=>e.click()')
   expect(panel.locator('.page-capture-item')).to_have_count(1)
   panel.locator('#page-capture-mode').select_option('article')
   expect(panel.locator('.page-capture-item')).to_have_count(4,timeout=30000)
   expect(panel.locator('#page-capture-mode')).to_have_value('article')
   expect(panel.locator('#page-capture-save-mode')).to_have_value('multiple')
   expect(panel.locator('.page-capture-item.confirmed')).to_have_count(3)
   expect(panel.locator('#page-capture-list-summary')).to_contain_text('1 个案例待复核')
   panel.screenshot(path=str(ext/'article-cases-preview.png'),full_page=True)
   # Whole article remains available via the same mode control.
   source.bring_to_front()
   panel.locator('#page-capture-mode').select_option('single')
   expect(panel.locator('.page-capture-item')).to_have_count(1,timeout=30000)
   expect(panel.locator('#page-capture-mode')).to_have_value('single')
   result=panel.evaluate("async()=>chrome.runtime.sendMessage({type:'START_PAGE_CAPTURE',mode:'loaded'})")
   assert len(result['batch']['candidates'])==1
   assert len(result['batch']['candidates'][0]['media'])==7
   batch_result=panel.evaluate("async()=>chrome.runtime.sendMessage({type:'START_PAGE_CAPTURE',mode:'list',targetCount:6})")
   assert batch_result['ok'] and len(batch_result['batch']['candidates'])==4,batch_result
   source.bring_to_front()
   panel.locator('#page-capture-mode').select_option('article')
   expect(panel.locator('.page-capture-item')).to_have_count(4,timeout=30000)
   panel.locator('#page-capture-save').click()
   expect(panel.locator("#page-capture")).to_be_hidden(timeout=60000)
   entries=panel.evaluate("async()=>(await chrome.runtime.sendMessage({type:'GET_STATE'})).entries")
   assert {e['title'] for e in entries} == {f'{i}、案例{i}' for i in range(1,4)}, [(e['title'],len(e.get('mediaAssets',[]))) for e in entries]
   for i in range(1,4):
    entry=next(e for e in entries if e['title']==f'{i}、案例{i}')
    assert len(entry['mediaAssets'])==i,(i,entry)
    assert f'Generate scene {i}' in entry['text']
    assert 'Article introduction' not in entry['text']
    assert all(a.get('byteSize',0)>0 for a in entry['mediaAssets'])
   print('PASS: rich-text paragraph boundaries, per-case image sets, unassigned intro, UI mode/saving and whole-article retention')

   # Actual webpage -> background scanner -> collector preview -> save task.
   # This phase does not replace the scanner, grouping response or save handler.
   source.goto(HIERARCHY_URL);source.bring_to_front()
   panel.locator('#start-page-capture').evaluate('e=>e.click()')
   expect(panel.locator('.page-capture-item')).to_have_count(1)
   raw=panel.evaluate("async()=>chrome.runtime.sendMessage({type:'START_PAGE_CAPTURE',mode:'loaded'})")
   assert raw['ok'] and len(raw['batch']['candidates'])==1,raw
   panel.locator('#page-capture-mode').select_option('article')
   expect(panel.locator('.page-capture-item')).to_have_count(3,timeout=30000)
   case_b=panel.locator('.page-capture-item').filter(has=panel.locator('strong',has_text='短原文案例B'))
   expect(case_b.locator('.page-capture-excerpt')).to_contain_text('红色的鸟')
   expect(case_b.locator('.page-capture-excerpt')).not_to_contain_text('下一章引言')
   remainder=panel.locator('.page-capture-item.structure-review')
   expect(remainder.locator('.page-capture-excerpt')).to_contain_text('下一章引言')
   remainder.locator('.page-capture-confirm').click()
   expect(panel.locator('.page-capture-item.confirmed')).to_have_count(3)
   panel.locator('#page-capture-save').click()
   expect(panel.locator('#page-capture')).to_be_hidden(timeout=60000)
   entries=panel.evaluate("async()=>(await chrome.runtime.sendMessage({type:'GET_STATE'})).entries")
   assert len(entries)==6,[(e['title'],e['text']) for e in entries]
   for title,text in [('短原文案例A','蓝色的猫'),('短原文案例B','红色的鸟')]:
    entry=next(e for e in entries if e['title']==title)
    assert title in entry['text'] and text in entry['text'],entry
    assert '下一章引言' not in entry['text'],entry
    assert len(entry['mediaAssets'])==1,entry
   intro=next(e for e in entries if e['title']=='未分组内容 · Hierarchy source')
   assert '第二章' in intro['text'] and '下一章引言' in intro['text'],intro

   # Unplaced-original fixture enrichment is deliberately explicit: the source
   # was really scanned above, but ordinary article DOM does not naturally
   # produce unread author-reply supplements. Preserve their preview here;
   # do not fake the separate READ_PAGE_CAPTURE_SUPPLEMENT source fetch.
   unplaced_url='https://mmbiz.qpic.cn/unplaced-original.png'
   result=panel.evaluate('''async ({raw,url})=>{
     const {splitArticleCases}=await import('./article-case-groups.js');
     const {normalizePageCaptureBatch}=await import('./page-capture.js');
     const input=raw.candidates[0];input.id='enriched-article';input.title='Enriched source';
     input.canonicalUrl+='-enriched';input.sourceFacts.itemId='enriched-article';
     input.media.push({id:'unplaced-original',kind:'image',url,placement:'unplaced'});
     input.possibleOmissions=[{id:'unread',text:'An original needs review'}];
     input.supplements=[{id:'unread-source',text:'Unread source text',sourceUrl:input.canonicalUrl+'/reply'}];
     const groups=splitArticleCases(input);const remainder=groups.at(-1);
     const batch=normalizePageCaptureBatch({...raw,id:crypto.randomUUID(),candidates:groups,
       selections:[{candidateId:remainder.id,selectedTextBlockIds:remainder.textBlocks.map(b=>b.id),
         selectedMediaIds:['unplaced-original'],mediaDecision:'confirmed'}]});
     const preview=batch.candidates.at(-1);
     const response=await chrome.runtime.sendMessage({type:'COMMIT_PAGE_CAPTURE',batch});
     return {preview,response};
   }''',{'raw':raw['batch'],'url':unplaced_url})
   assert result['preview']['media'][0]['url']==unplaced_url,result
   assert result['preview']['supplements'][0]['text']=='Unread source text',result
   assert result['preview']['possibleOmissions'][0]['text']=='An original needs review',result
   assert result['response']['ok'] and len(result['response']['results'])==1,result
   receipt=result['response']['results'][0]
   assert receipt.get('pendingMediaIds',[])==[],receipt
   entries=panel.evaluate("async()=>(await chrome.runtime.sendMessage({type:'GET_STATE'})).entries")
   assert len(entries)==7,entries
   enriched=next(e for e in entries if e['id']==receipt['entryId'])
   assert len(enriched['mediaAssets'])==1,enriched
   original_id=enriched['mediaAssets'][0]['id']
   original=panel.evaluate("async id=>Array.from(new Uint8Array(await(await(await import('./media-store.js')).getMediaBlob(id)).arrayBuffer()))",original_id)
   assert bytes(original)==image_bytes(unplaced_url)
   # Restart the isolated profile: neither the collector nor the worker can
   # satisfy readback from their previous in-memory candidate state.
   run.restart_browser(extension_dir=ext)
   reopened=run.open_page('collector.html')
   readback=reopened.evaluate("async()=>(await chrome.runtime.sendMessage({type:'GET_STATE'})).entries")
   assert {e['id'] for e in readback}=={e['id'] for e in entries}
   for before in entries:
    after=next(e for e in readback if e['id']==before['id'])
    assert after['text']==before['text'] and after['title']==before['title']
    assert [a['id'] for a in after.get('mediaAssets',[])]==[a['id'] for a in before.get('mediaAssets',[])]
    for asset in after.get('mediaAssets',[]):
     size=reopened.evaluate("async id=>(await(await import('./media-store.js')).getMediaBlob(id))?.size",asset['id'])
     assert size and size==asset['byteSize'],asset
   persisted=reopened.evaluate("async id=>Array.from(new Uint8Array(await(await(await import('./media-store.js')).getMediaBlob(id)).arrayBuffer()))",original_id)
   assert persisted==original
   print('PASS: real hierarchy/short source preview, explicit remainder selection, background save and full-browser restart readback')
   print('PASS: enriched unplaced original explicitly selected, saved receipt, exact original bytes after restart; unread supplement preview retained (supplement source fetch and acceptance not exercised)')

if __name__=='__main__':main()
