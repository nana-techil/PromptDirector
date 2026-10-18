"""Two continuous panes, truthful review mode and responsive repeated mode switches."""
import os
from pathlib import Path
from playwright.sync_api import expect
from e2e_support import extension_session, base_entry


def main():
    out=Path(os.environ.get('PD_E2E_ARTIFACT_DIR','/tmp/pd-two-panes'));out.mkdir(parents=True,exist_ok=True)
    entry=base_entry('image','宫阙幻境 · 东方华裳 / A complete visual reference','镜头从远景缓慢推进，保留服装与光线的细节。\n\nA continuous shot, soft window light and a quiet composition.','content:prompt:image')
    entry.update(mediaAssets=[{'id':'photo','kind':'image','storageMode':'managed','mimeType':'image/png','width':900,'height':600,'palette':{'colors':['#34565d','#a98660','#d8c6a0']}}],primaryMediaId='photo')
    with extension_session('pd-two-panes-',show_scrollbars=True) as run:
        p=run.open_page('collector.html',wait_until='networkidle');run.seed_storage(p,{'entries':[entry], 'dataSafetyOnboardingSeen':True,'uiPreferences':{'theme':'dark','locale':'zh-CN','motion':'reduced'}})
        p.evaluate('''async()=>{const c=document.createElement('canvas');c.width=900;c.height=600;const x=c.getContext('2d');x.fillStyle='#34565d';x.fillRect(0,0,900,600);x.fillStyle='#a98660';x.fillRect(240,0,420,600);x.fillStyle='#d8c6a0';x.beginPath();x.arc(450,260,130,0,Math.PI*2);x.fill();await(await import('./media-store.js')).saveMediaBlob('photo',await new Promise(r=>c.toBlob(r)));}''')
        p=run.open_page('library.html',wait_until='networkidle')
        assert p.locator('.library-loading').evaluate('e=>getComputedStyle(e).display')=='none'
        top=p.locator('.topbar').bounding_box();card=p.locator('.case-card').bounding_box()
        assert card['y']-top['height']<4,(top,card)
        for theme in ['dark','light']:
            p.evaluate("async theme=>(await import('./i18n.js')).initializeUi({theme,locale:'zh-CN',motion:'reduced'})",theme)
            p.locator('.case-card').click()
            expect(p.locator('.detail-image')).to_be_visible()
            assert p.locator('.detail-header-section .detail-palette').count()==0
            expect(p.locator('.detail-visual-caption > .detail-palette')).to_be_visible()
            assert p.locator('.detail-visual-rail').count()==0
            assert p.locator('.detail-visual-caption').bounding_box()['height']<65
            assert p.locator('.detail-workspace-footer').evaluate('e=>e.parentElement.classList.contains("detail-body")')
            assert p.locator('.detail-create-action').bounding_box()['y']<600
            summary=p.locator('.entry-editor-inline > summary').bounding_box();close=p.locator('#detail-close').bounding_box()
            assert abs(summary['y']+summary['height']/2-close['y']-close['height']/2)<2
            p.screenshot(path=str(out/f'detail-{theme}.png'))
            p.locator('.entry-editor-inline > summary').click()
            expect(p.locator('.entry-edit-field input')).to_be_visible()
            expect(p.locator('.entry-edit-field input')).to_have_value(entry['title'])
            p.evaluate('()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')
            p.screenshot(path=str(out/f'edit-{theme}.png'))
            p.locator('.entry-editor-inline > summary').click()
            # Visibility alone missed the former bug: require the media to occupy the whole viewport.
            p.locator('#detail-review-toggle').click()
            expect(p.locator('.detail-body')).to_be_hidden()
            expect(p.locator('.detail-image')).to_be_visible()
            box=p.locator('.detail-visual-gallery').bounding_box()
            assert box['x']==0 and abs(box['width']-1280)<2 and box['height']>=890,box
            p.screenshot(path=str(out/f'review-{theme}.png'))
            p.locator('#detail-review-toggle').click()
            for _ in range(3):
                p.locator('#detail-mode-toggle').click(timeout=5000)
                expect(p.locator('#detail-drawer')).to_have_class(__import__('re').compile('.*detail-sidebar-mode.*'),timeout=5000)
                expect(p.locator('.detail-visual-gallery')).to_be_hidden()
                assert p.locator('.detail-body').bounding_box()['height']<3000
                p.locator('#detail-review-toggle').click(timeout=5000)
                expect(p.locator('.detail-body')).to_be_hidden()
                expect(p.locator('.detail-image')).to_be_visible()
                p.locator('#detail-review-toggle').click(timeout=5000)
                p.locator('#detail-mode-toggle').click(timeout=5000)
                expect(p.locator('.detail-image')).to_be_visible()
            p.set_viewport_size({'width':390,'height':844})
            p.screenshot(path=str(out/f'narrow-{theme}.png'))
            assert p.locator('#detail-content').evaluate('e=>e.scrollWidth<=e.clientWidth')
            p.locator('#detail-close').click();p.set_viewport_size({'width':1280,'height':900})
        saved=p.evaluate("async()=>(await chrome.runtime.sendMessage({type:'GET_STATE'})).entries[0]")
        assert saved['text']==entry['text'] and saved['mediaAssets'][0]['palette']==entry['mediaAssets'][0]['palette']
        print('PASS: single-media compact controls, palette placement, natural creation flow, review geometry, repeated mode switches, gallery edges and source preservation')

if __name__=='__main__':main()
