"""Visible code cards run the saved sandbox, preserve navigation and release offscreen work."""
import json,os,re
from pathlib import Path
from playwright.sync_api import expect
from e2e_support import extension_session
from code_case_e2e import DEMO

def main():
    out=Path(os.environ.get('PD_E2E_ARTIFACT_DIR','/tmp/pd-code-gallery'));out.mkdir(parents=True,exist_ok=True)
    with extension_session('pd-code-gallery-',viewport={'width':1280,'height':844}) as run:
        panel=run.open_page('collector.html')
        html=Path(os.environ['PD_CODE_GALLERY_HTML']).read_text() if os.environ.get('PD_CODE_GALLERY_HTML') else DEMO
        source='Original CSS and React remain intact.\n\n```promptdirector-preview-html\n'+html+'\n```'
        entries=[{'id':f'code-{i}','title':f'Tab Pill {i}','text':source,'mediaAssets':[],'classification':{'pathIds':['content:code-case'],'status':'confirmed'},'sourceFacts':{'codePreviewAvailable':True}} for i in range(50)]
        entries[1]['classification']={'pathIds':['content:reference'],'status':'confirmed'};entries[1]['sourceFacts']={}
        run.seed_storage(panel,{'entries':entries,'organizerState':{'version':1,'collections':[
            {'id':'code-parent','name':'Code project','entryIds':[],'order':0,'visibility':'library'},
            {'id':'code-child','name':'Code child','parentId':'code-parent','entryIds':['code-10'],'order':0,'visibility':'library'}]}})
        library=run.open_page('library.html')
        card=library.locator('.case-card[data-entry-id="code-0"]')
        expect(card).to_be_visible();library.screenshot(path=str(out/'baseline.png'))
        frame=card.locator('.code-case-frame')
        expect(frame).to_be_visible(timeout=6000)
        expect(frame).to_have_attribute('data-preview-ready','true')
        expect(library.locator('.case-card[data-entry-id="code-1"] .code-case-frame')).to_have_attribute('data-preview-ready','true')
        library.locator('.project-row[data-collection-id="code-parent"] .project-disclosure').click()
        library.locator('.project-row[data-collection-id="code-child"] .project-filter').click()
        expect(library.locator('.case-card[data-entry-id="code-10"] .code-case-frame')).to_have_attribute('data-preview-ready','true')
        library.locator('#workspace-library').click()
        expect(frame).to_have_attribute('data-preview-ready','true')
        demo=card.frame_locator('.code-case-frame').frame_locator('#preview')
        actual=bool(os.environ.get('PD_CODE_GALLERY_HTML'))
        if actual:
            button=demo.locator('#btn');button.hover();library.mouse.down()
            expect(button).to_have_class('hold-btn done',timeout=2000);library.mouse.up()
        else:
            expect(demo.locator('#state')).to_have_text('Build')
            demo.get_by_role('button',name='Ship').click();expect(demo.locator('#state')).to_have_text('Ship')
        assert not library.locator('.detail-drawer.open').count()
        for locale,theme in [('zh-CN','dark'),('en','light')]:
            if locale=='en':
                with library.expect_navigation():library.evaluate("async()=>chrome.storage.local.set({uiPreferences:{locale:'en',theme:'light',motion:'reduced'}})")
                expect(card.locator('.code-case-frame')).to_have_attribute('data-preview-ready','true')
            for width in [1280,390]:
                library.set_viewport_size({'width':width,'height':844})
                if actual:
                    expect(demo.locator('#btn')).to_be_in_viewport()
                    box=demo.locator('#btn').bounding_box();parent=frame.bounding_box()
                    assert box['y']>=parent['y'] and box['y']+box['height']<=parent['y']+parent['height']+1,(box,parent)
                else:expect(demo.get_by_role('button',name='Build')).to_be_in_viewport()
                library.screenshot(path=str(out/f'gallery-code-{locale}-{theme}-{width}.png'))
        library.set_viewport_size({'width':1280,'height':844})
        library.locator('[data-gallery-view="list"]').click()
        expect(library.locator('[data-gallery-view="list"]')).to_have_attribute('aria-pressed','true')
        expect(frame).to_have_attribute('data-preview-ready','true')
        assert not card.locator('.case-row-placeholder').count(),'code list rows must show their live preview rather than a generic file icon'
        card.locator('.case-row-title').click()
        expect(library.locator('.code-case-view .code-case-frame')).to_have_attribute('data-preview-ready','true')
        library.locator('#detail-close').click()
        library.locator('[data-gallery-view="waterfall"]').click()
        expect(frame).to_have_attribute('data-preview-ready','true')
        library.locator('#select-cases').click()
        expect(card).to_have_class(re.compile('.*share-selectable.*'))
        assert frame.evaluate('el=>getComputedStyle(el).pointerEvents')=='none','case selection must remain possible through an interactive preview'
        card.locator('.case-code-preview').click()
        expect(card).to_have_attribute('aria-pressed','true')
        assert not library.locator('.detail-drawer.open').count()
        library.locator('#share-cancel').click()
        card.locator('.case-code-title').click()
        expect(library.locator('.code-case-view .code-case-frame')).to_have_attribute('data-preview-ready','true')
        assert not library.locator('.case-code-preview .code-case-frame[src]').count(),'covered gallery previews must stop while detail is open'
        library.locator('#detail-close').click();expect(frame).to_have_attribute('data-preview-ready','true')
        before=library.locator('.case-code-preview .code-case-frame[src]').count()
        assert before < len(entries),'offscreen cards must not execute code'
        library.set_viewport_size({'width':1280,'height':844})
        for _ in range(len(entries)):
            library.evaluate('window.scrollTo(0,document.documentElement.scrollHeight)');library.wait_for_timeout(100)
            if library.locator('.case-card[data-entry-id="code-49"]').count():break
        expect(library.locator('.case-card[data-entry-id="code-49"] .code-case-frame')).to_have_attribute('data-preview-ready','true')
        assert not card.locator('.code-case-frame[src]').count(),'recycled/offscreen source scripts must be released'
        stored=panel.evaluate("async()=>(await chrome.runtime.sendMessage({type:'GET_STATE'})).entries")
        assert len(stored)==len(entries) and all(entry['text']==source for entry in stored)
        assert not run.page_errors
        # A broken saved preview must report failure without losing its source or faking readiness.
        broken={**entries[0],'id':'broken-preview','title':'Broken preview','text':'```promptdirector-preview-html\n<script>throw Error("fixture preview failure")</script>\n```'}
        library.close()
        run.seed_storage(panel,{'entries':[broken],'uiPreferences':{'locale':'en','theme':'light','motion':'reduced'}})
        library=run.open_page('library.html')
        bad=library.locator('.case-card[data-entry-id="broken-preview"]')
        expect(bad.locator('.code-case-frame')).to_have_attribute('data-preview-ready','error')
        expect(bad.locator('.code-case-status')).to_be_visible()
        expect(bad.locator('.code-case-status')).to_have_text('Preview failed. Source code is preserved.')
        library.set_viewport_size({'width':390,'height':844})
        library.wait_for_function("()=>{const box=document.querySelector('.case-card[data-entry-id=\"broken-preview\"]').getBoundingClientRect();return box.left>=0&&box.right<=innerWidth}")
        library.screenshot(path=str(out/'gallery-code-error-en-light-390.png'))
        expected_errors=list(run.page_errors)
        assert expected_errors and all(error.endswith(': fixture preview failure') for error in expected_errors),expected_errors
        run.page_errors.clear() # Only the explicitly injected sandbox failures are expected here.
        print(json.dumps({'liveGalleryCode':True,'interactionOnCard':True,'projectRoundTripWithoutReload':True,'listPreviewAndNavigation':True,'selectionPreserved':True,'visibleOnlyRuntime':True,'detailPauseAndReturn':True,'virtualRecycle':True,'sourceUnchanged':True,'truthfulPreviewFailure':True,'expectedSandboxErrors':expected_errors,'paidRequests':0,'pageErrors':run.page_errors}))
if __name__=='__main__':main()
