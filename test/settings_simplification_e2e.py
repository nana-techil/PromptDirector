"""Compact maintenance controls retain truthful errors, preferences and support export."""
import os
from pathlib import Path
from playwright.sync_api import expect
from e2e_support import extension_session, base_entry


def snapshot(page, path):
    page.evaluate("()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))")
    page.screenshot(path=str(path), animations="disabled")


def main():
    out=Path(os.environ.get('PD_E2E_ARTIFACT_DIR','/tmp/pd-settings-simplification'));out.mkdir(parents=True,exist_ok=True)
    with extension_session('pd-settings-simplification-') as run:
        p=run.open_page('collector.html',wait_until='networkidle')
        entry=base_entry('reference','创意资料保留','完整原始提示词，镜头缓慢推进。','content:prompt:video')
        run.seed_storage(p,{'entries':[entry],'dataSafetyOnboardingSeen':True,'uiPreferences':{'theme':'dark','locale':'zh-CN','motion':'reduced'},'videoComponentSetup':{'phase':'ready'}})
        p=run.open_page('library.html',wait_until='networkidle')
        expect(p.locator('#undo-analysis-batch, #undo-facet, #import-undo, #analysis-diagnostics, #show-analysis-diagnostics')).to_have_count(0)
        p.locator('#open-settings').click()
        expect(p.locator('#video-online-only-help')).to_have_count(0)
        p.locator('#video-online-only').check()
        p.wait_for_function("async()=> (await chrome.storage.local.get('uiPreferences')).uiPreferences.videoOnlineOnly === true")
        p.reload(wait_until='networkidle');p.locator('#open-settings').click()
        expect(p.locator('#video-online-only')).to_be_checked()
        # Persistence failure must restore the previous value and show a local error.
        p.evaluate('''async()=>{
          const {bindCaptureVideoSettings}=await import('./capture-video-settings.js');
          const original=document.querySelector('#video-online-only'),toggle=original.cloneNode(true);original.replaceWith(toggle);
          bindCaptureVideoSettings({toggle,feedback:document.querySelector('#video-capture-settings-feedback'),load:async()=>({videoOnlineOnly:true}),save:async()=>{throw Error('设置保存失败测试')},show:(n,s)=>{n.textContent=s}}).refresh();
        }''')
        p.locator('#video-online-only').click()
        expect(p.locator('#video-online-only')).to_be_checked()
        expect(p.locator('#video-capture-settings-feedback')).to_have_text('设置保存失败测试')
        p.reload(wait_until='networkidle');p.locator('#open-settings').click()
        for theme,locale in [('dark','zh-CN'),('light','en')]:
            p.evaluate("async v=>(await import('./i18n.js')).initializeUi(v)",{'theme':theme,'locale':locale,'motion':'reduced'})
            for width in [1280,390]:
                p.set_viewport_size({'width':width,'height':900})
                p.locator('[data-settings-tab="general"]').click()
                p.locator('#video-online-only').scroll_into_view_if_needed()
                run.context.service_workers[0].evaluate("()=>chrome.runtime.sendMessage({type:'VIDEO_COMPONENT_SETUP_CHANGED',state:{phase:'ready'}})")
                expect(p.locator('#connect-video-component')).to_be_hidden()
                assert p.locator('#settings-general-panel').evaluate('e=>e.scrollWidth<=e.clientWidth')
                snapshot(p, out/f'video-{theme}-{width}.png')
                # The same component still displays actionable failures instead of hiding them.
                run.context.service_workers[0].evaluate("()=>chrome.runtime.sendMessage({type:'VIDEO_COMPONENT_SETUP_CHANGED',state:{phase:'failed',message:'安装包下载中断，请重试'}})")
                expect(p.locator('#connect-video-component')).to_be_visible()
                snapshot(p, out/f'video-failure-{theme}-{width}.png')
                run.context.service_workers[0].evaluate("()=>chrome.runtime.sendMessage({type:'VIDEO_COMPONENT_SETUP_CHANGED',state:{phase:'ready'}})")
                p.locator('[data-settings-tab="tasks"]').click()
                snapshot(p, out/f'maintenance-{theme}-{width}.png')
                expect(p.locator('#settings-tasks-panel #preview-analysis-batch')).to_be_visible()
                expect(p.locator('#text-batch-dialog')).to_be_hidden()
                expect(p.locator('#settings-tasks-panel [data-batch-kind], #settings-tasks-panel #batch-scope-fields')).to_have_count(0)
        p.locator('[data-settings-tab="tasks"]').click()
        p.evaluate('''()=>{
          window.originalPreviewSend=chrome.runtime.sendMessage.bind(chrome.runtime);
          chrome.runtime.sendMessage=m=>m.type==='PREVIEW_ANALYSIS_BATCH'
            ? new Promise(resolve=>{window.failPreview=()=>resolve({ok:false,message:'Scope preview failed; no changes were saved'})})
            : window.originalPreviewSend(m);
        }''')
        p.locator('#preview-analysis-batch').click()
        expect(p.locator('#analysis-batch-summary')).to_have_attribute('aria-busy','true')
        snapshot(p, out/'analysis-waiting.png')
        p.evaluate('()=>window.failPreview()')
        expect(p.locator('#analysis-settings-feedback')).to_contain_text('Scope preview failed')
        expect(p.locator('#analysis-batch-summary')).to_have_attribute('aria-busy','false')
        snapshot(p, out/'analysis-preview-failed.png')
        p.locator('[data-settings-tab=general]').click()
        p.locator('#ui-diagnostics').check()
        p.locator('#settings-close').click()
        p=run.open_page('composer.html',wait_until='networkidle')
        expect(p.locator('.composer-toolbar #composer-diagnostic-export')).to_have_count(0)
        expect(p.locator('#composer-diagnostic-export')).to_be_hidden()
        p.locator('#composer-options > summary').click()
        expect(p.locator('#composer-options #composer-diagnostic-export')).to_be_visible()
        snapshot(p, out/'composer-support.png')
        saved=p.evaluate("async()=>(await chrome.runtime.sendMessage({type:'GET_STATE'})).entries[0]")
        assert saved['text']==entry['text'] and saved['title']==entry['title']
        assert not run.page_errors,run.page_errors
        print('PASS: compact settings in both themes and widths, inline text entry, saved toggle, visible failures, composer support access and original preservation')


if __name__=='__main__':main()
