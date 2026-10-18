"""Dedupe is a stable settings subview: no modal gap, resize or stale async remount."""
import copy
import json
import tempfile
from pathlib import Path
from playwright.sync_api import expect
from e2e_support import extension_session, base_entry


def main():
    out=Path(tempfile.gettempdir())/'pd-dedupe-settings';out.mkdir(exist_ok=True)
    with extension_session('pd-dedupe-settings-',viewport={'width':1440,'height':1000}) as run:
        setup=run.open_page('collector.html')
        first=base_entry('first','相同原件案例','保持原词','content:prompt:image')
        first.update(mediaAssets=[{'id':'shared-image','kind':'image','storageMode':'managed','contentHash':'a'*64,'byteSize':10}],libraryAddedAt='2026-10-01T00:00:00Z')
        second=copy.deepcopy(first);second.update(id='second',libraryAddedAt='2026-10-02T00:00:00Z')
        run.seed_storage(setup,{'entries':[first,second],'uiPreferences':{'locale':'zh-CN','theme':'dark'},'dataSafetyOnboardingSeen':True})
        page=run.open_page('library.html')
        expect(page.locator('body')).to_have_attribute('data-library-state','ready')
        page.locator('#open-settings').click();page.locator('[data-settings-tab=tasks]').click()
        # Record both the close mutation (even between frames) and every painted position.
        page.evaluate('''()=>{
          window.__settings=document.querySelector('#settings-dialog');window.__frames=[];window.__closed=0;
          window.__observer=new MutationObserver(records=>{for(const r of records)if(r.attributeName==='open'&&!window.__settings.open)window.__closed++;});
          window.__observer.observe(window.__settings,{attributes:true,attributeOldValue:true,attributeFilter:['open']});
          window.__watch=true;const frame=()=>{if(!window.__watch)return;const d=window.__settings,r=d.getBoundingClientRect();
          window.__frames.push({open:d.open,x:r.x,y:r.y,width:r.width,height:r.height,modals:document.querySelectorAll('dialog[open]').length});requestAnimationFrame(frame);};frame();
        }''')
        before=page.locator('#settings-dialog').bounding_box()
        page.locator('#inspect-duplicates').click()
        expect(page.locator('.dedupe-summary')).to_contain_text('1 组重复')
        page.screenshot(path=str(out/'settings-dedupe-wide.png'))
        assert page.locator('#settings-dialog').evaluate('(e)=>e.open'),'Opening dedupe closed settings and exposed the library'
        expect(page.locator('#settings-dedupe-panel')).to_be_visible()
        assert page.locator('#settings-dialog').bounding_box()==before
        assert page.locator('dialog[open]').count()==1
        panel=page.locator('#settings-dedupe-panel')
        panel.get_by_role('button',name='查看详情',exact=True).click()
        expect(panel.locator('.dedupe-case')).to_have_count(2)
        assert page.locator('#settings-dialog').bounding_box()==before
        page.locator('#dedupe-back').click()
        expect(page.locator('#settings-tasks-panel')).to_be_visible()
        expect(page.locator('#inspect-duplicates')).to_be_focused()
        assert page.locator('#settings-dialog').bounding_box()==before
        page.locator('#inspect-duplicates').click()
        expect(panel.locator('.dedupe-summary')).to_contain_text('1 组重复')
        # Rescanning from duplicate results to no duplicates must not resize the settings shell.
        setup.evaluate('''async()=>{const storage=(await import('./library-storage.js')).getLibraryStorage();const s=await storage.get('entries');await storage.set({entries:s.entries.slice(0,1)});}''')
        page.wait_for_function("()=>document.querySelectorAll('.case-card').length===1")
        panel.get_by_role('button',name='重新比较',exact=True).click()
        expect(panel.locator('.dedupe-summary')).to_contain_text('未发现重复')
        assert page.locator('#settings-dialog').bounding_box()==before
        samples=page.evaluate('''()=>{window.__watch=false;window.__observer.disconnect();return {frames:window.__frames,closed:window.__closed};}''')
        assert samples['closed']==0 and all(f['open'] and f['modals']==1 for f in samples['frames']),samples
        assert all(abs(f[k]-samples['frames'][0][k])<1 for f in samples['frames'] for k in ['x','y','width','height']),samples
        page.set_viewport_size({'width':390,'height':900})
        assert panel.evaluate('(e)=>e.scrollWidth<=e.clientWidth+1')
        page.screenshot(path=str(out/'settings-dedupe-empty-narrow.png'))
        page.locator('[data-settings-tab=general]').click()
        expect(panel).to_be_hidden()
        expect(panel.locator('.dedupe-toolbar')).to_have_count(0)
        page.locator('[data-settings-tab=tasks]').click();page.locator('#inspect-duplicates').click()
        expect(panel.locator('.dedupe-summary')).to_contain_text('未发现重复')
        page.keyboard.press('Escape')
        expect(page.locator('#settings-dialog')).not_to_be_visible()
        expect(panel.locator('.dedupe-toolbar')).to_have_count(0)
        # Delayed preferences must leave the settings surface visible; exit cannot remount it.
        page.set_viewport_size({'width':1440,'height':1000})
        page.locator('#open-settings').click();page.locator('[data-settings-tab=tasks]').click()
        page.evaluate("""()=>{
          const original=chrome.storage.local.get.bind(chrome.storage.local);
          window.__restoreStorageGet=()=>{chrome.storage.local.get=original;};
          chrome.storage.local.get=keys=>{
            if((Array.isArray(keys)?keys:[keys]).includes('dedupeReviewDismissals'))
              return new Promise(resolve=>{window.__finishReviewRead=()=>original(keys).then(resolve);});
            return original(keys);
          };
        }""")
        page.locator('#inspect-duplicates').click()
        expect(panel.locator('.dedupe-status')).to_have_text('正在比较案例…')
        expect(panel.get_by_role('button',name='重新比较',exact=True)).to_be_disabled()
        page.screenshot(path=str(out/'settings-dedupe-loading.png'))
        page.wait_for_function('()=>Boolean(window.__finishReviewRead)')
        page.locator('#dedupe-back').click()
        page.evaluate('async()=>{await window.__finishReviewRead();window.__restoreStorageGet();}')
        expect(panel.locator('.dedupe-toolbar')).to_have_count(0)
        expect(page.locator('#settings-tasks-panel')).to_be_visible()
        # An initial read failure is actionable in the same subview and refresh retries it.
        page.evaluate("""()=>{
          const original=chrome.storage.local.get.bind(chrome.storage.local);let fail=true;
          chrome.storage.local.get=keys=>{
            if(fail&&(Array.isArray(keys)?keys:[keys]).includes('dedupeReviewDismissals')) {fail=false;return Promise.reject(new Error('Fixture read failure'));}
            return original(keys);
          };
        }""")
        page.locator('#inspect-duplicates').click()
        expect(panel.locator('.dedupe-status')).to_contain_text('Fixture read failure')
        page.screenshot(path=str(out/'settings-dedupe-error.png'))
        panel.get_by_role('button',name='重新比较',exact=True).click()
        expect(panel.locator('.dedupe-summary')).to_contain_text('未发现重复')
        page.locator('#dedupe-back').click()
        page.locator('#inspect-duplicates').click()
        expect(panel.locator('.dedupe-summary')).to_contain_text('未发现重复')
        panel.locator('.dedupe-options > summary').click()
        expect(panel.locator('.ui-popover-menu')).to_be_visible()
        page.locator('[data-settings-tab=general]').click()
        expect(page.locator('.ui-popover-menu:visible')).to_have_count(0)
        page.locator('#settings-close').click()
        assert not run.page_errors,run.page_errors
        print(json.dumps({'settingsNeverClosed':True,'paintedFrames':len(samples['frames']),'geometryStable':True,'backAndTabCleanup':True,'closeCleanup':True,'delayedReadExit':True,'readFailureRetry':True,'popoverCleanup':True,'screenshots':str(out)}))


if __name__=='__main__':main()
