"""Thousands of Trash entries must not read/play every original before cleanup."""
import json
import re
from playwright.sync_api import expect
from e2e_support import base_entry, extension_session


with extension_session('pd-trash-preview-window-') as run:
    page = run.open_page('collector.html')
    count = 3431
    live = base_entry('kept', 'Keep this original', 'Keep this text', 'content:prompt:image')
    live['mediaAssets'] = [{'id': 'kept-original', 'kind': 'image', 'storageMode': 'managed'}]
    live['primaryMediaId'] = 'kept-original'
    items = []
    for index in range(count):
        entry = {**live, 'id': f'gone-{index}', 'title': f'Duplicate {index}',
                 'mediaAssets': [{'id': f'preview-{index}', 'kind': 'image', 'storageMode': 'managed'}],
                 'primaryMediaId': f'preview-{index}'}
        items.append({'id': f'trash:entry:{entry["id"]}', 'kind': 'entry', 'targetId': entry['id'],
                      'deletedAt': '2026-10-09T00:00:00Z', 'snapshot': entry})
    run.seed_storage(page, {'entries': [live], 'trashState': {'version': 1, 'items': items}})
    page.evaluate('''async count => {
      const {savePortableAssetBlobs,saveDerivedMedia}=await import('./media-store.js');
      const canvas=document.createElement('canvas');canvas.width=32;canvas.height=32;
      const keptBlob=await new Promise(resolve=>canvas.toBlob(resolve));
      const encoded=await (async()=>{
          const chunk=(name,data)=>{const out=new Uint8Array(8+data.length+(data.length%2));out.set(new TextEncoder().encode(name));new DataView(out.buffer).setUint32(4,data.length,true);out.set(data,8);return out;};
          const join=parts=>{const out=new Uint8Array(parts.reduce((n,p)=>n+p.length,0));let at=0;for(const p of parts){out.set(p,at);at+=p.length;}return out;};
          const frames=[];
          for(const color of ['red','blue']){const c=document.createElement('canvas');c.width=800;c.height=400;c.getContext('2d').fillStyle=color;c.getContext('2d').fillRect(0,0,800,400);
            const b=await new Promise(r=>c.toBlob(r,'image/webp'));const bytes=new Uint8Array(await b.arrayBuffer());
            const header=new Uint8Array(16);header[6]=31;header[7]=3;header[9]=143;header[10]=1;header[12]=200;
            const parts=[];for(let at=12;at+8<=bytes.length;){const tag=new TextDecoder().decode(bytes.slice(at,at+4)),size=new DataView(bytes.buffer).getUint32(at+4,true),end=at+8+size+(size%2);if(['VP8 ','VP8L','ALPH'].includes(tag))parts.push(bytes.slice(at,end));at=end;}frames.push(chunk('ANMF',join([header,...parts])));}
          const ext=new Uint8Array(10);ext[0]=2;ext[4]=31;ext[5]=3;ext[7]=143;ext[8]=1;
          const payload=join([new TextEncoder().encode('WEBP'),chunk('VP8X',ext),chunk('ANIM',new Uint8Array(6)),...frames]);
          return btoa(String.fromCharCode(...chunk('RIFF',payload)));
        })();
      const blob=new Blob([Uint8Array.from(atob(encoded),c=>c.charCodeAt(0))],{type:'image/webp'});
      await savePortableAssetBlobs([{assetId:'kept-original',blob:keptBlob},
        ...Array.from({length:count},(_,i)=>({assetId:'preview-'+i,blob}))],{checkCapacity:false});
      await saveDerivedMedia('kept-original',{thumbnail:keptBlob,animated:false});
    }''', count)
    library = run.open_page('library.html')
    expect(library.locator("body[data-library-state='ready']")).to_be_visible()
    library.evaluate('''() => {
      window.trashReads=new Set();const get=IDBObjectStore.prototype.get;
      IDBObjectStore.prototype.get=function(key){
        if(['media','derived-media'].includes(this.name)&&String(key).startsWith('preview-')) window.trashReads.add(key);
        return get.call(this,key);
      };
    }''')
    library.locator('#open-trash').click()
    expect(library.locator('.trash-item')).to_have_count(count)
    expect(library.locator('.trash-item img[src]').first).to_be_visible()
    # This must exercise decoded animation, not only metadata or tiny still placeholders.
    first_image = library.locator('.trash-item img[src]').first
    first_frame = first_image.screenshot()
    animated = False
    for _ in range(8):
        library.wait_for_timeout(70)
        if first_image.screenshot() != first_frame:
            animated = True
            break
    assert animated, 'visible Trash original must animate'
    initial = library.evaluate('''() => {
      const root=document.querySelector('.trash-dialog-body').getBoundingClientRect();
      const visible=[...document.querySelectorAll('.trash-item img')].filter(image=>{
        const r=image.getBoundingClientRect();return r.bottom>root.top&&r.top<root.bottom;
      }).map(image=>image.dataset.visualId);
      return {requested:[...trashReads],visible};
    }''')
    assert initial['requested'] and set(initial['requested']) <= set(initial['visible']), initial
    library.locator('.trash-dialog-body').evaluate('(node)=>{node.scrollTop=node.scrollHeight}')
    expect(library.locator('.trash-item img').last).to_have_attribute('src', re.compile(r'blob:.*'))
    assert library.locator('.trash-item img[src]').count() < count
    reads_before_close = library.evaluate('()=>trashReads.size')
    library.locator('#trash-close').click()
    expect(library.locator('.trash-item img[src]')).to_have_count(0)
    library.wait_for_timeout(400)
    assert library.evaluate('()=>trashReads.size') <= reads_before_close + 2, 'closing must cancel queued preview work'
    library.locator('#open-trash').click()
    expect(library.locator('.trash-item img[src]').first).to_be_visible()
    # The viewport only limits preview work. Permanent clear covers every fixture item.
    library.locator('#trash-empty').click()
    library.get_by_role('button', name='永久清空', exact=True).click()
    expect(library.locator('#trash-dialog')).not_to_be_visible(timeout=30000)
    result = library.evaluate('''async () => {
      const storage=(await import('./library-storage.js')).getLibraryStorage();
      const {getMediaBlob}=await import('./media-store.js');
      const state=await storage.get(['entries','trashState','pendingTrashCleanup']);
      return {ids:state.entries.map(e=>e.id),text:state.entries[0].text,trash:state.trashState.items.length,
        pending:!!state.pendingTrashCleanup,kept:!!await getMediaBlob('kept-original'),
        first:!!await getMediaBlob('preview-0'),last:!!await getMediaBlob('preview-3430')};
    }''')
    assert result == {'ids': ['kept'], 'text': 'Keep this text', 'trash': 0, 'pending': False,
                      'kept': True, 'first': False, 'last': False}, result
    library.reload()
    expect(library.locator("body[data-library-state='ready']")).to_be_visible()
    print(json.dumps({'trashItems': count, 'initialCoverReads': len(initial['requested']),
                      'animatedOriginals': True, 'lastRowAccessible': True, 'closedCoversReleased': True,
                      'allItemsCleared': True, 'keptOriginalPreserved': True, 'reopened': True}))
