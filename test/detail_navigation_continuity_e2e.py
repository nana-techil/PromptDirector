"""A filtered library must not strand similar cases; review and sidebar remain usable."""
import os, json, time, base64
from pathlib import Path
from playwright.sync_api import expect
from e2e_support import extension_session, base_entry


def main():
    out = Path(os.environ.get('PD_E2E_ARTIFACT_DIR', '/tmp/pd-navigation-continuity')); out.mkdir(parents=True, exist_ok=True)
    assets = [{'id': 'image', 'kind': 'image', 'storageMode': 'managed', 'mimeType': 'image/png', 'width': 960, 'height': 540, 'palette': {'colors': ['#8d9697','#284454','#beaa9b','#555c5b','#dfdcd3']}}]
    entries = []
    for i in range(6363):
        e = base_entry(f'case-{i}', ('Unique opening reference ' if i == 0 else f'Related reference {i} ') + '长标题：镜头中的空间和层次 ' * 10,
                       'A quiet landscape, soft lighting, continuous camera motion. ' * (100 if i == 0 else 1), 'content:prompt:image')
        e.update(mediaAssets=assets, primaryMediaId='image', customLabels=['Landscape'])
        entries.append(e)
    entries[2]['text'] = ''
    entries[3].update(title='Mixed reference text',mediaAssets=[],primaryMediaId=None)
    entries[4]['title']='Mixed reference image'
    with extension_session('pd-navigation-continuity-', show_scrollbars=True) as run:
        setup = run.open_page('collector.html')
        run.seed_storage(setup, {'entries': entries, 'dataSafetyOnboardingSeen': True, 'organizerState':{'version':4,'collections':[{'id':f'p{i}','name':f'镜头参考项目 {i+1}','parentId':None,'order':i,'entryIds':[]} for i in range(30)]},
            'uiPreferences': {'theme':'light', 'locale':'zh-CN', 'motion':'reduced', 'detailSidebarWidth':520}})
        setup.evaluate("""async()=>{const c=document.createElement('canvas');c.width=960;c.height=540;const x=c.getContext('2d');x.fillStyle='#beaa9b';x.fillRect(0,0,960,540);x.fillStyle='#284454';x.fillRect(0,340,960,200);x.fillStyle='#dfdcd3';x.beginPath();x.arc(480,240,100,0,7);x.fill();await(await import('./media-store.js')).saveMediaBlob('image',await new Promise(r=>c.toBlob(r)));}""")
        p = run.open_page('library.html', wait_until='networkidle'); p.set_default_timeout(8000)
        warnings=[];p.on('console',lambda m:warnings.append(m.text) if 'aria-hidden' in m.text else None)
        expect(p.locator('.project-filter').first).to_have_css('border-top-color','rgba(0, 0, 0, 0)')
        p.screenshot(path=str(out/'project-navigation-light.png'))
        p.locator('#search-input').fill('Unique opening reference')
        expect(p.locator('.case-card')).to_have_count(1)
        p.locator('.case-card').click()
        expect(p.locator('.prompt-expand')).to_be_visible()
        assert p.locator('.prompt-expand').inner_text()==''
        assert p.locator('.prompt-expand').evaluate("e=>e.parentElement.classList.contains('prompt-section-heading')")
        p.locator('.tag-editor-compact > button').click()
        p.get_by_role('button', name='保存标签', exact=True).click()
        expect(p.locator('.tag-editor-compact .tag-editor-row')).to_be_hidden()
        p.locator('.detail-project-menu > summary').click()
        panel=p.locator('.detail-project-menu .detail-project-popover')
        expect(panel).to_be_visible()
        box=panel.bounding_box(); anchor=p.locator('.detail-project-menu > summary').bounding_box()
        assert box['y']>=0 and box['y']+box['height']<=900
        assert panel.evaluate("e=>e.matches(':popover-open')")
        assert box['y']+box['height']<=anchor['y'],(box,anchor)
        p.screenshot(path=str(out/'project-popover.png'))
        p.keyboard.press('Escape')
        related=p.locator('.local-discovery-item')
        expect(related.first).to_be_visible()
        titles=related.evaluate_all("es=>es.slice(0,3).map(e=>e.getAttribute('aria-label'))")
        related.first.click()
        p.wait_for_function("()=>{const id=document.querySelector('#detail-drawer').dataset.entryId;return id&&id!=='case-0'}")
        first=p.locator('#detail-drawer').get_attribute('data-entry-id')
        expect(p.locator('#detail-next')).to_be_enabled()
        p.locator('#detail-next').click()
        expect(p.locator('#detail-drawer')).not_to_have_attribute('data-entry-id',first)
        p.wait_for_function("()=>!!document.querySelector('#detail-drawer').dataset.entryId")
        second=p.locator('#detail-drawer').get_attribute('data-entry-id')
        p.locator('#detail-prev').click();expect(p.locator('#detail-drawer')).to_have_attribute('data-entry-id',first)
        p.locator('#detail-review-toggle').click();expect(p.locator('.detail-body')).to_be_hidden()
        p.locator('#detail-next').click();expect(p.locator('#detail-drawer')).to_have_attribute('data-entry-id',second)
        expect(p.locator('.detail-body')).to_be_hidden()
        p.locator('#detail-review-toggle').click()
        durations=[]
        for i in range(6):
            start=time.perf_counter()
            p.locator('#detail-mode-toggle').click()
            expect(p.locator('.detail-visual-gallery')).to_be_hidden()
            title=p.locator('.detail-title');assert title.evaluate('e=>e.scrollWidth>e.clientWidth&&e.clientHeight<30')
            p.locator('.entry-editor-inline > summary').click()
            box=p.locator('.entry-editor-body').bounding_box();drawer=p.locator('#detail-drawer').bounding_box()
            assert box['x']>=drawer['x'] and box['x']+box['width']<=1280 and box['y']+box['height']<=900,(box,drawer)
            if i==0:p.screenshot(path=str(out/'sidebar-editor.png'))
            p.locator('.entry-editor-inline > summary').click()
            # The background project navigation stays at the same viewport position while the library scrolls.
            if i==0:
                p.locator('#search-input').fill('')
                p.wait_for_function("()=>document.querySelectorAll('#case-list .case-card').length>10")
            sidebar=p.locator('.filter-sidebar').bounding_box()
            p.evaluate('window.scrollTo(0,500)')
            assert p.evaluate('window.scrollY')>=400
            assert abs(p.locator('.filter-sidebar').bounding_box()['y']-sidebar['y'])<2
            p.locator('#detail-review-toggle').click();expect(p.locator('.detail-body')).to_be_hidden()
            assert p.locator('.detail-visual-gallery').bounding_box()['height']>=890
            p.locator('#detail-next').click()
            p.wait_for_function("()=>!!document.querySelector('#detail-drawer').dataset.entryId")
            expect(p.locator('.detail-body')).to_be_hidden()
            p.locator('#detail-review-toggle').click()
            p.locator('#detail-mode-toggle').click()
            expect(p.locator('.detail-image')).to_be_visible()
            durations.append(round((time.perf_counter()-start)*1000))
        p.screenshot(path=str(out/'full-detail.png'))
        p.evaluate("()=>{window.noteReads=[];window.noteSend=chrome.runtime.sendMessage.bind(chrome.runtime);chrome.runtime.sendMessage=(m,...a)=>{window.noteReads.push(m.type);return window.noteSend(m,...a)}}")
        worker=run.context.service_workers[0]
        worker.evaluate("()=>{globalThis.noteStorageReads=[];globalThis.noteStorageGet=chrome.storage.local.get.bind(chrome.storage.local);chrome.storage.local.get=(keys,...args)=>{globalThis.noteStorageReads.push(keys);return globalThis.noteStorageGet(keys,...args)}}")
        p.locator('[data-review-feedback]').click()
        p.locator('.review-feedback-form textarea').fill('大库备注保存与读回')
        note_start=time.perf_counter()
        p.locator('.review-feedback-save').click()
        expect(p.locator('.review-feedback-row p')).to_have_text('大库备注保存与读回')
        note_ms=round((time.perf_counter()-note_start)*1000)
        reads=p.evaluate('window.noteReads')
        storage_reads=worker.evaluate('globalThis.noteStorageReads')
        assert 'GET_STATE' not in reads and 'GET_LIBRARY_STATE' not in reads,reads
        assert all('composerSessions' not in (keys or []) for keys in storage_reads),storage_reads
        p.get_by_role('button',name='收起备注',exact=True).click()
        p.evaluate('()=>{chrome.runtime.sendMessage=window.noteSend}')
        worker.evaluate('()=>{chrome.storage.local.get=globalThis.noteStorageGet}')
        # Switching layout directly from review must leave a coherent pane mode.
        p.locator('#detail-mode-toggle').click()
        p.locator('#detail-review-toggle').click()
        p.locator('#detail-mode-toggle').click()
        expect(p.locator('.detail-body')).to_be_visible()
        expect(p.locator('.detail-image')).to_be_visible()
        p.locator('#detail-close').click()
        assert not warnings,warnings
        assert p.locator('#detail-drawer').evaluate('e=>!e.contains(document.activeElement)')
        p.locator('#search-input').fill('Related reference 2 ')
        p.locator('.case-card[data-entry-id="case-2"]').click()
        expect(p.locator('.prompt-read-body').first).to_be_hidden()
        p.evaluate('()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')
        palette=p.locator('.detail-palette'); tools=p.locator('#detail-drawer .detail-media-tools')
        pb=palette.bounding_box();tb=tools.bounding_box()
        assert palette.evaluate("e=>!!e.closest('.detail-media-tools')")
        assert tb['x']<=pb['x'] and pb['x']+pb['width']<=tb['x']+tb['width'], (pb,tb)
        assert p.locator('.detail-create-action').bounding_box()['y']<300
        img=p.locator('.detail-image').bounding_box();caption=p.locator('.detail-visual-caption').bounding_box()
        assert abs(img['y']+img['height']-caption['y'])<2
        p.wait_for_function("()=>document.querySelector('.detail-image').complete&&document.querySelector('.detail-image').naturalWidth>0")
        p.evaluate('()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')
        expect(p.locator('.prompt-section-heading').first).to_be_visible()
        shot=p.screenshot(path=str(out/'empty-prompt-light.png'))
        pixel=p.evaluate("""async ({url,x,y})=>{const i=new Image();i.src=url;await i.decode();const c=document.createElement('canvas');c.width=i.width;c.height=i.height;const ctx=c.getContext('2d');ctx.drawImage(i,0,0);return [...ctx.getImageData(x,y,1,1).data]}""",{'url':'data:image/png;base64,'+base64.b64encode(shot).decode(),'x':int(img['x']+10),'y':int(img['y']+10)})
        assert pixel[:3]==[190,170,155],'Media layer disappeared after mode switches' 
        p.set_viewport_size({'width':390,'height':844});p.evaluate('()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');p.screenshot(path=str(out/'narrow-light.png'))
        assert p.locator('#detail-content').evaluate('e=>e.scrollWidth<=e.clientWidth')
        p.set_viewport_size({'width':1280,'height':900});p.locator('#detail-close').click()
        p.locator('#search-input').fill('Mixed reference')
        expect(p.locator('#case-list .case-card')).to_have_count(2)
        p.locator('.case-card[data-entry-id="case-4"]').click()
        p.locator('#detail-review-toggle').click()
        direction='#detail-next' if p.locator('#detail-next').is_enabled() else '#detail-prev'
        p.locator(direction).click()
        expect(p.locator('#detail-drawer')).to_have_attribute('data-entry-id','case-3')
        expect(p.locator('.detail-body')).to_be_visible()
        assert not p.locator('#detail-drawer').evaluate("e=>e.classList.contains('is-reviewing')")
        (out/'results.json').write_text(json.dumps({'cases':len(entries),'cyclesMs':durations,'warnings':warnings,'noteSaveMs':note_ms,'noteRequests':reads,'noteStorageReads':storage_reads,'similarFirst':first,'similarSecond':second},indent=2))
        print('PASS: 6363-case similar navigation, review navigation, repeated sidebar/review, editor bounds, empty tags, popover, focus, compact empty prompt and media adjacency',durations)

if __name__=='__main__': main()
