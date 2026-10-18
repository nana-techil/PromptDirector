"""Browsing recommendations before changing modes must not load a hidden library."""
import os, json, time
from pathlib import Path
from playwright.sync_api import expect
from e2e_support import extension_session, base_entry


def main():
    out=Path(os.environ.get('PD_E2E_ARTIFACT_DIR','/tmp/pd-mode-lifecycle'));out.mkdir(parents=True,exist_ok=True)
    palette={'colors':['#493c32','#805c3d','#bb9662','#ddd4a8','#292b30']}
    images=[dict(id='landscape',kind='image',storageMode='managed',mimeType='image/png',width=960,height=540,palette=palette),dict(id='portrait',kind='image',storageMode='managed',mimeType='image/png',width=180,height=320,palette=palette)]
    entry=base_entry('main','Continuous browsing — '+ 'Long case title '*12,'A cinematic landscape, soft lighting, continuous camera motion. '*80,'content:prompt:video')
    entry.update(mediaAssets=[dict(id='video',kind='video',storageMode='managed',mimeType='video/mp4',width=320,height=180)]+images,primaryMediaId='video')
    related=[{**entry,'id':f'related-{i}','mediaAssets':images[:1],'primaryMediaId':'landscape'} for i in range(6362)]
    with extension_session('pd-mode-lifecycle-',viewport={'width':1886,'height':843},show_scrollbars=True) as run:
        setup=run.open_page('collector.html');run.seed_storage(setup,{'entries':[entry]+related,'uiPreferences':{'theme':'dark','locale':'zh-CN','motion':'system','detailPanelRatio':.415}})
        setup.evaluate("""async raw=>{const {saveMediaBlob}=await import('./media-store.js');await saveMediaBlob('video',new Blob([new Uint8Array(raw)],{type:'video/mp4'}));for(const [id,w,h] of [['landscape',960,540],['portrait',180,320]]){const c=document.createElement('canvas');c.width=w;c.height=h;const x=c.getContext('2d');x.fillStyle='#bb9662';x.fillRect(0,0,w,h);x.fillStyle='#493c32';x.fillRect(0,h*.65,w,h*.35);await saveMediaBlob(id,await new Promise(r=>c.toBlob(r)))}}""",list((Path(__file__).parent/'fixtures/review-workspace-smoke.mp4').read_bytes()))
        p=run.open_page('library.html',wait_until='networkidle');p.set_default_timeout(6000)
        expect(p.locator('#result-count')).to_contain_text('6363',timeout=20000)
        p.locator('.case-card[data-entry-id=main]').click();expect(p.locator('.local-discovery-item').first).to_be_attached(timeout=15000)
        p.locator('.detail-video-play').click();p.wait_for_function('()=>document.querySelector(".detail-video").readyState>=2')
        p.locator('#detail-content').evaluate('e=>e.scrollTop=1000');p.wait_for_timeout(350)
        p.locator('#detail-mode-toggle').click();expect(p.locator('#detail-mode-toggle')).to_be_enabled()
        hidden_count=p.locator('.local-discovery-item').count();p.wait_for_timeout(700)
        assert p.locator('.local-discovery-item').count()==hidden_count,'Hidden recommendations keep loading after entering sidebar'
        durations=[]
        for i in range(20):
            for selector in ['#detail-review-toggle','#detail-review-toggle','#detail-mode-toggle','#detail-mode-toggle']:
                start=time.perf_counter();p.locator(selector).click();expect(p.locator('#detail-mode-toggle')).to_be_enabled()
                durations.append(round((time.perf_counter()-start)*1000))
            assert p.locator('.local-discovery-item').count()==hidden_count, 'Changing modes must not append unseen recommendations'
        p.locator('#detail-mode-toggle').click()
        # Revealing recommendations again must resume real scrolling, without a hidden backlog.
        p.locator('#detail-content').evaluate('e=>e.scrollTop=e.scrollHeight')
        p.wait_for_function('(count)=>document.querySelectorAll(".local-discovery-item").length>count',arg=hidden_count,timeout=15000)
        p.locator('#detail-content').evaluate('e=>e.scrollTop=0')
        # Different aspect ratios and prompt updates keep the page header in view.
        for index in [1,2,0,2,1,0]:
            p.locator('.detail-visual-thumb').nth(index).click()
            expected=['video','landscape','portrait'][index]
            expect(p.locator('.detail-visual-gallery')).to_have_attribute('data-displayed-asset-id',expected)
            p.evaluate('()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')
            assert p.locator('#detail-content').evaluate('e=>e.scrollTop')==0, (index,p.locator('#detail-content').evaluate('e=>e.scrollTop'))
            assert p.locator('.detail-title').bounding_box()['y']>=0
        p.locator('.detail-visual-thumb').nth(1).click()
        p.wait_for_function("()=>document.querySelector('.detail-image')?.complete")
        p.screenshot(path=str(out/'wide-dark.png'))
        primary=p.locator('.detail-primary').bounding_box();gallery=p.locator('.detail-visual-gallery').bounding_box();body=p.locator('.detail-body').bounding_box()
        assert abs(primary['y']+primary['height']-max(gallery['y']+gallery['height'],body['y']+body['height']))<2
        assert p.locator('.detail-discovery').bounding_box()['y']<=primary['y']+primary['height']+2
        assert p.locator('.detail-palette').evaluate("e=>!!e.closest('.detail-visual-caption')")
        p.locator('#detail-next').click()
        expect(p.locator('.detail-visual-rail')).to_have_count(0)
        p.wait_for_function("()=>document.querySelector('.detail-image')?.complete")
        p.evaluate('()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')
        bottom=p.locator('.detail-primary').bounding_box()['height']
        assert bottom<803, ('Single landscape case still reserves the whole viewport',bottom)
        assert abs(p.locator('.detail-discovery').bounding_box()['y']-bottom)<2
        p.screenshot(path=str(out/'single-media-dark.png'))
        p.evaluate("async()=>(await import('./i18n.js')).initializeUi({theme:'light',locale:'zh-CN',motion:'system'})")
        p.evaluate("async()=>{await new Promise(requestAnimationFrame);await Promise.all(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})))}")
        p.screenshot(path=str(out/'single-media-light.png'))
        p.set_viewport_size({'width':390,'height':844});p.screenshot(path=str(out/'narrow-light.png'))
        assert p.locator('#detail-content').evaluate('e=>e.scrollWidth<=e.clientWidth')
        (out/'results.json').write_text(json.dumps({'cases':len(related)+1,'hiddenCards':hidden_count,'cycles':20,'clickMs':durations,'pageErrors':run.page_errors},indent=2))
        assert not run.page_errors,run.page_errors
        print('PASS: hidden recommendations bounded, 20 video mode cycles, mixed-media header stable, no reserved bottom area',flush=True)

if __name__=='__main__':main()
