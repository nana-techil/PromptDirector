"""Code cases keep shared actions, preview continuity and bounded offscreen work."""
import json, os
from pathlib import Path
from e2e_support import extension_session,base_entry
from playwright.sync_api import expect
def main():
    out=Path(os.environ.get('PD_E2E_ARTIFACT_DIR','/tmp/pd-code-workspace'));out.mkdir(parents=True,exist_ok=True)
    failures=[]
    html="<style>body{margin:0;background:#101010;min-height:100vh;display:grid;place-items:center}button{background:#d2ff00;color:#181818;padding:24px;border:0;border-radius:12px;animation:p 2s infinite}@keyframes p{50%{transform:scale(.9)}}</style><button onclick=\"this.textContent='Clicked'\">Push me</button><script>window.previewTicks=0;function tick(){previewTicks++;requestAnimationFrame(tick)}requestAnimationFrame(tick)</script>"
    source='Motion interaction source\n\n```css\nbutton{animation:p 2s infinite}\n```\n\n```promptdirector-preview-html\n'+html+'\n```'
    entries=[base_entry(f'code-{i}',f'Motion {i:03d}',source,'content:code-case') for i in range(153)]
    video = base_entry('video', 'Video analysis controls', 'Original video direction.', 'content:prompt:video')
    video.update(mediaAssets=[{'id': key, 'kind': 'video', 'storageMode': 'managed', 'mimeType': 'video/mp4', 'width': 320, 'height': 180} for key in ['video-one','video-two']], primaryMediaId='video-one')
    entries.append(video)
    with extension_session('pd-code-feedback-',show_scrollbars=True) as run:
        setup=run.open_page('collector.html',wait_until='networkidle')
        run.seed_storage(setup,{'entries':entries,'dataSafetyOnboardingSeen':True,'uiPreferences':{'theme':'light','locale':'zh-CN','motion':'reduced'}})
        setup.evaluate('''async raw=>{const {saveMediaBlob}=await import('./media-store.js');for(const id of ['video-one','video-two'])await saveMediaBlob(id,new Blob([new Uint8Array(raw)],{type:'video/mp4'}));}''',list((Path(__file__).parent/'fixtures/review-workspace-smoke.mp4').read_bytes()))
        p=run.open_page('library.html',wait_until='networkidle');expect(p.locator('#result-count')).to_contain_text('154')
        p.locator('.case-card').first.locator('.code-case-frame').wait_for()
        expect(p.locator('.case-card').first.locator('.code-case-frame')).to_have_attribute('data-preview-ready','true')
        # Background preview readiness may change; metadata/card rebuilding may not.
        p.evaluate("""()=>{window.probe={loads:0,moves:0,mutations:0,long:[]};new PerformanceObserver(l=>probe.long.push(...l.getEntries().map(e=>e.duration))).observe({type:'longtask'});document.querySelectorAll('.code-case-frame').forEach(f=>f.addEventListener('load',()=>probe.loads++));new MutationObserver(m=>probe.moves+=m.length).observe(document.querySelector('#sidebar-modules'),{childList:true});new MutationObserver(m=>probe.mutations+=m.filter(change=>!change.target.closest?.('.code-case-frame,.code-case-status')).length).observe(document.querySelector('#case-list'),{subtree:true,childList:true,attributes:true});}""")
        assert p.locator('.case-code-preview').first.evaluate('e=>getComputedStyle(e).backgroundColor') == p.locator('.detail-drawer').evaluate('e=>getComputedStyle(e).backgroundColor'), 'Loading canvas follows light theme'
        p.screenshot(path=str(out/'wall-light.png'))
        for _ in range(3):p.locator('[data-sidebar-module=tags] .sidebar-module-toggle').click()
        p.wait_for_timeout(300);print('tags',p.evaluate('probe'),flush=True)
        if p.evaluate('probe.moves'): failures.append('Tag navigation moves unchanged modules')
        p.locator('[data-gallery-view=list]').click();p.wait_for_timeout(400)
        p.evaluate('()=>{probe.mutations=0;probe.long=[]}')
        before=p.locator('.case-row-details').first.bounding_box()
        p.locator('[data-gallery-view=list]').click();p.wait_for_timeout(400)
        print('repeat list',before,p.locator('.case-row-details').first.bounding_box(),p.evaluate('probe'),flush=True)
        if p.evaluate('probe.mutations'): failures.append('Repeated active list rebuilds content')
        assert before == p.locator('.case-row-details').first.bounding_box(), 'Repeated list must preserve alignment'
        p.locator('[data-gallery-view=waterfall]').click();p.wait_for_timeout(300)
        first=p.locator('.case-card').first
        expect(first.locator('.code-case-frame')).to_have_attribute('data-preview-ready','true')
        first.locator('.code-case-frame').evaluate('f=>f.dataset.probeLoads="0"')
        first.locator('.code-case-frame').evaluate('f=>f.addEventListener("load",()=>f.dataset.probeLoads=String(Number(f.dataset.probeLoads)+1))')
        for _ in range(3):p.mouse.wheel(0,650);p.wait_for_timeout(250);p.mouse.wheel(0,-650);p.wait_for_timeout(250)
        expect(first.locator('.code-case-frame')).to_have_attribute('data-preview-ready','true')
        print('scroll reloads',first.locator('.code-case-frame').get_attribute('data-probe-loads'),flush=True)
        if first.locator('.code-case-frame').get_attribute('data-probe-loads') != '0': failures.append('Short return scroll reloads existing preview')
        first.locator('.case-code-title').click();expect(p.locator('.code-case-view .code-case-frame')).to_have_attribute('data-preview-ready','true')
        print('code create',p.locator('.detail-core-actions').count(),flush=True)
        if not p.locator('.detail-core-actions').count(): failures.append('Code case has no creation action')
        expect(p.locator('.code-case-source button[aria-label="编辑源码"]')).to_be_visible()
        p.evaluate('()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')
        p.screenshot(path=str(out/'detail-light.png'))
        p.locator('#detail-mode-toggle').click();p.wait_for_timeout(250)
        print('sidebar code stage visible',p.locator('.code-case-view').is_visible(),flush=True)
        if p.locator('.code-case-view').is_visible(): failures.append('Sidebar still shows code stage')
        expect(p.locator('.case-card').first.locator('.code-case-frame')).to_have_attribute('data-preview-ready','true')
        p.screenshot(path=str(out/'sidebar-light.png'))
        p.locator('#detail-review-toggle').click();p.wait_for_timeout(250)
        print('review enabled',p.locator('#detail-drawer').get_attribute('class'),'errors',run.page_errors,flush=True)

        if 'is-reviewing' not in p.locator('#detail-drawer').get_attribute('class'): failures.append('Code review does not open')
        assert not failures, failures
        # Review must show the preview at viewport size, with the source panel hidden.
        expect(p.locator('.detail-body')).not_to_be_visible()
        bounds = p.locator('.code-case-view').bounding_box()
        assert bounds['x'] == 0 and bounds['y'] == 0 and bounds['width'] == 1280 and bounds['height'] == 900, bounds
        p.screenshot(path=str(out/'review-light.png'))
        demo = p.frame_locator('.code-case-view .code-case-frame').frame_locator('#preview')
        demo.get_by_role('button',name='Push me').click()
        for _ in range(10):
            p.locator('#detail-review-toggle').click()
            expect(p.locator('.code-case-view')).not_to_be_visible()
            p.wait_for_timeout(80)
            ticks = demo.locator('body').evaluate('()=>window.previewTicks')
            p.wait_for_timeout(120)
            assert demo.locator('body').evaluate('()=>window.previewTicks') <= ticks + 1
            p.locator('#detail-review-toggle').click()
            expect(demo.get_by_role('button',name='Clicked')).to_be_visible()
        # Navigation while reviewing also works for code cases.
        p.locator('#detail-next').click()
        expect(p.locator('#detail-drawer')).to_have_attribute('data-entry-id','code-1')
        expect(p.locator('.detail-body')).not_to_be_visible()
        p.locator('#detail-prev').click()
        expect(p.locator('#detail-drawer')).to_have_attribute('data-entry-id','code-0')
        p.locator('#detail-mode-toggle').click()
        expect(p.locator('.detail-create-action')).to_be_enabled()
        expect(p.locator('.code-case-source [aria-label="分析文字标签"]')).to_be_visible()
        p.locator('.code-case-source button[aria-label="编辑源码"]').click()
        editor = p.locator('.code-case-source textarea')
        editor.fill(source+'\nUnsaved draft')
        p.locator('.code-case-source .prompt-edit-actions').get_by_role('button',name='取消',exact=True).click()
        expect(p.locator('.code-case-source button[aria-label="编辑源码"]')).to_be_visible()
        expect(p.locator('.code-case-source .markdown-reader')).not_to_contain_text('Unsaved draft')
        p.locator('.code-case-source button[aria-label="编辑源码"]').click()
        updated = source.replace('Motion interaction source','Edited original source')
        p.locator('.code-case-source textarea').fill(updated)
        p.locator('.code-case-source .prompt-edit-actions').get_by_role('button',name='保存',exact=True).click()
        expect(p.locator('.code-case-source .markdown-reader')).to_contain_text('Edited original source')
        stored = setup.evaluate("async()=>(await chrome.runtime.sendMessage({type:'GET_STATE'})).entries")
        assert next(e for e in stored if e['id']=='code-0')['text'] == updated
        assert next(e for e in stored if e['id']=='code-1')['text'] == source
        expect(p.locator('.code-case-view .code-case-frame')).to_have_attribute('data-preview-ready','true')
        p.locator('#detail-close').click()
        for theme in ['dark','light']:
            p.evaluate("async theme=>(await import('./i18n.js')).initializeUi({theme,locale:'zh-CN',motion:'reduced'})",theme)
            for width,height in [(1280,900),(390,844)]:
                p.set_viewport_size({'width':width,'height':height})
                p.locator('.case-card[data-entry-id="code-0"] .case-code-title').click()
                expect(p.locator('.code-case-view .code-case-frame')).to_have_attribute('data-preview-ready','true')
                p.evaluate("async()=>{await Promise.all(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})));await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))}")
                stage = p.locator('.code-case-view').bounding_box()
                assert 0 <= stage['y'] < height / 2 and stage['height'] > height / 2, stage
                assert p.locator('.detail-content').evaluate('e=>e.scrollWidth<=e.clientWidth')
                suffix = '-narrow' if width == 390 else ''
                p.screenshot(path=str(out/f'code-{theme}{suffix}.png'))
                p.locator('#detail-close').click()
        p.set_viewport_size({'width':1280,'height':900})
        # Far-away cards release their sandboxes; the page does not retain the full wall.
        old = p.locator('.case-card[data-entry-id="code-0"] .code-case-frame').element_handle()
        p.mouse.move(800,400)
        for _ in range(8):
            p.mouse.wheel(0,900);p.wait_for_timeout(80)
        p.wait_for_function('()=>window.scrollY>2000')
        # Keyboard focus may keep the card node mounted after closing detail;
        # the offscreen runnable sandbox must still be released.
        p.wait_for_function('f=>!f.getAttribute("src")', arg=old)
        assert p.locator('#case-list .code-case-frame[src]').count() < len(entries)
        assert p.locator('#case-list .code-case-frame[src]').evaluate_all('frames=>frames.every(f=>{const r=f.closest(".case-card").getBoundingClientRect();return r.bottom>=-innerHeight*2&&r.top<=innerHeight*3})')
        # Video shares text analysis; multi-video batch confirmation is scoped to this case.
        p.locator('#search-input').fill('Video analysis controls')
        p.locator('.case-card[data-entry-id=video]').click()
        expect(p.locator('.prompt-section [aria-label="分析文字标签"]:visible')).to_be_visible()
        p.evaluate("""()=>{const send=chrome.runtime.sendMessage.bind(chrome.runtime);window.sent=[];chrome.runtime.sendMessage=(m,...args)=>{sent.push(m);return send(m,...args)}}""")
        p.locator('.prompt-section [aria-label="批量分析视频"]:visible').click()
        expect(p.locator('#text-batch-dialog')).to_be_visible()
        calls=p.evaluate('sent')
        preview=next(c for c in calls if c['type']=='PREVIEW_VIDEO_BATCH')
        assert preview['entryIds']==['video'] and preview['includeAllVideos'] is True, preview
        p.locator('#text-batch-close').click()
        assert not any(c['type'].startswith(('CREATE_VIDEO','START_VIDEO','CREATE_VISION')) for c in p.evaluate('sent'))
        p.locator('#detail-close').click()
        p.locator('#search-input').fill('Motion 000')
        p.locator('.case-card[data-entry-id="code-0"] .case-code-title').click()
        p.locator('.detail-create-action').click()
        p.wait_for_url('**/composer.html?**')
        assert 'references=code-0' in p.url
        expect(p.locator('body')).to_contain_text('Motion 000')
        assert not run.page_errors, run.page_errors
        print('PASS: code actions/edit/readback, creation reference, 10 review cycles, navigation, repeated list, retained nearby/released far previews, light canvas and scoped video batch cancellation')


if __name__ == "__main__":
    main()
