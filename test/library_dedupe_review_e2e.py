"""Unverified originals are actionable; dismissing is durable and never proves duplicates."""
from pathlib import Path
import tempfile
from playwright.sync_api import expect
from e2e_support import base_entry, extension_session

with extension_session('pd-dedupe-review-', viewport={'width': 1440, 'height': 1000}) as run:
    setup = run.open_page('collector.html')
    entries = []
    for identity in ['missing', 'linked', 'ready']:
        entry = base_entry(identity, 'A futuristic armored superhero flies through dark storm clouds at high speed' if identity == 'linked' else 'Case '+identity, 'Full text '+identity, 'content:prompt:image')
        entry.update(url='https://example.com/source', mediaAssets=[{'id': identity+'-asset', 'kind': 'video' if identity == 'linked' else 'image', 'storageMode': 'reference' if identity == 'linked' else 'managed', 'sourceTitle': identity+('.mp4' if identity == 'linked' else '.png')}], primaryMediaId=identity+'-asset')
        entries.append(entry)
    run.seed_storage(setup, {'entries': entries, 'uiPreferences': {'locale': 'zh-CN', 'theme': 'dark'}, 'dataSafetyOnboardingSeen': True})
    setup.evaluate('''async()=>{const canvas=document.createElement('canvas');canvas.width=32;canvas.height=32;
      window.fixtureBlob=await new Promise(resolve=>canvas.toBlob(resolve));
      await (await import('./media-store.js')).saveMediaBlob('ready-asset',fixtureBlob,{checkCapacity:false});}''')
    page = run.open_page('library.html')
    expect(page.locator("body[data-library-state='ready']")).to_be_visible()
    def open_review():
        page.locator('#open-settings').click()
        page.locator('[data-settings-tab=tasks]').click()
        page.locator('#inspect-duplicates').click()
        dialog = page.locator('.case-dedupe-panel')
        expect(dialog.locator('.dedupe-status')).to_contain_text('已比较可核对原件')
        return dialog
    dialog = open_review()
    pending = dialog.locator('.dedupe-unverified').first
    expect(dialog.locator('[data-review=pending]')).to_have_text('待核对 3 个案例')
    assert not pending.evaluate('(e)=>e.open')
    dialog.locator('[data-review=pending]').click()
    missing = dialog.locator('.dedupe-unverified-row[data-entry-id="missing"]')
    missing.get_by_role('button', name='Case missing', exact=True).click()
    missing.get_by_text('完整案例内容', exact=True).click()
    expect(missing.locator('pre')).to_have_text('Full text missing')
    missing.get_by_role('button', name='重试核对', exact=True).click()
    expect(missing.get_by_role('button', name='重试核对')).to_be_enabled()
    missing.get_by_role('button', name='Case missing', exact=True).click()
    expect(missing).to_contain_text('本机原件未找到')
    assert 'Case missing' not in dialog.locator('.dedupe-status').inner_text()
    missing.get_by_role('button', name='不再提示', exact=True).click()
    expect(dialog.locator('[data-review=pending]')).to_have_text('待核对 2 个案例')
    ignored = dialog.locator('.dedupe-unverified').nth(1)
    expect(dialog.locator('[data-review=ignored]')).to_have_text('已略过 1 个案例')
    # Batch checking excludes dismissed cases but saves other valid originals.
    dialog.get_by_role('button', name='核对原件', exact=True).click()
    expect(dialog.locator('[data-review=pending]')).to_have_text('待核对 1 个案例')
    expect(pending.locator('.dedupe-case')).to_have_count(0)
    pending.get_by_role('button', name='A futuristic armored superhero flies through dark storm clouds at high speed', exact=True).click()
    expect(pending).to_contain_text('原件仅保留外部引用')
    expect(dialog.locator('.dedupe-footer')).to_be_hidden()
    expect(dialog.locator('.dedupe-status')).to_be_hidden()
    expect(dialog.locator('.dedupe-summary')).to_have_text('已核对项无重复')
    assert '原件不可核对' not in dialog.locator('.dedupe-status').inner_text()
    for width in [1440, 390]:
        page.set_viewport_size({'width': width, 'height': 1000})
        assert dialog.evaluate('(e)=>e.scrollWidth<=e.clientWidth+1')
        assert pending.locator('.dedupe-review-title').evaluate('(e)=>getComputedStyle(e).color===getComputedStyle(document.querySelector(".dedupe-summary")).color')
        # Match the reported failure state: expanded reference-only case with a real source link.
        detail = pending.locator('.dedupe-inspection')
        expect(detail.locator('.dedupe-preview')).to_be_hidden()
        assert detail.locator('.dedupe-inspection-reason').count() == 1
        assert detail.get_by_role('link', name='查看来源').evaluate('(e)=>getComputedStyle(e).color===getComputedStyle(document.querySelector(".dedupe-summary")).color')
        assert detail.bounding_box()['height'] < 140
        dialog.screenshot(path=str(Path(tempfile.gettempdir()) / f'pd-dedupe-expanded-{width}.png'))
        toolbar = dialog.locator('.dedupe-toolbar').first
        before = toolbar.bounding_box()
        dialog.locator('.dedupe-options > summary').click()
        expect(dialog.locator('.ui-popover-menu')).to_be_visible()
        after = toolbar.bounding_box()
        assert abs(before['height']-after['height']) < 1 and abs(before['y']-after['y']) < 1
        assert dialog.locator('.ui-popover-menu').evaluate('(e)=>{const r=e.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight}')
        page.screenshot(path=str(Path(tempfile.gettempdir()) / f'pd-dedupe-options-{width}.png'))
        page.keyboard.press('Escape')
        expect(dialog).to_be_visible()
        expect(dialog.locator('.ui-popover-menu')).to_be_hidden()
        expect(dialog.locator('.dedupe-options > summary')).to_be_focused()
    dialog.locator('[data-review=pending]').click()
    expect(pending).to_be_hidden()
    expect(pending.locator('img,video')).to_have_count(0)
    dialog.screenshot(path=str(Path(tempfile.gettempdir()) / 'pd-dedupe-review-collapsed.png'))
    page.reload()
    page.set_viewport_size({'width': 1440, 'height': 1000})
    expect(page.locator("body[data-library-state='ready']")).to_be_visible()
    dialog = open_review()
    expect(dialog.locator('[data-review=pending]')).to_have_text('待核对 1 个案例')
    ignored = dialog.locator('.dedupe-unverified').nth(1)
    expect(dialog.locator('[data-review=ignored]')).to_have_text('已略过 1 个案例')
    dialog.locator('[data-review=ignored]').click()
    missing = ignored.locator('.dedupe-unverified-row[data-entry-id="missing"]')
    missing.get_by_role('button', name='恢复提醒', exact=True).click()
    expect(dialog.locator('[data-review=pending]')).to_have_text('待核对 2 个案例')
    # Repair the isolated fixture's original, then explicitly retry only that case.
    setup.evaluate("async()=> (await import('./media-store.js')).saveMediaBlob('missing-asset',fixtureBlob,{checkCapacity:false})")
    dialog.locator('[data-review=pending]').click()
    missing = dialog.locator('.dedupe-unverified-row[data-entry-id="missing"]')
    missing.get_by_role('button', name='重试核对', exact=True).click()
    expect(dialog.locator('[data-review=pending]')).to_have_text('待核对 1 个案例')
    expect(dialog.locator('.dedupe-summary')).to_contain_text('1 组重复')
    assert page.evaluate("async()=>(await (await import('./library-storage.js')).getLibraryStorage().get('entries')).entries.length") == 3
    page.evaluate("async()=>chrome.runtime.sendMessage({type:'UPDATE_UI_PREFERENCES',preferences:{locale:'en',theme:'light'}})")
    page.close()
    page = run.open_page('library.html')
    expect(page.locator("body[data-library-state='ready']")).to_be_visible()
    page.locator('#open-settings').click()
    page.locator('[data-settings-tab=tasks]').click()
    page.locator('#inspect-duplicates').click()
    dialog = page.locator('.case-dedupe-panel')
    expect(dialog.locator('[data-review=pending]')).to_contain_text('cases to check')
    dialog.locator('[data-review=pending]').click()
    for text in dialog.locator('.dedupe-unverified-row button, .dedupe-unverified-row small').all_text_contents():
        assert not any('\u4e00' <= c <= '\u9fff' for c in text), text
    dialog.locator('.dedupe-review-title').click()
    expect(dialog.locator('.dedupe-inspection .dedupe-preview')).to_be_hidden()
    page.set_viewport_size({'width': 390, 'height': 1000})
    assert dialog.evaluate('(e)=>e.scrollWidth<=e.clientWidth+1')
    dialog.screenshot(path=str(Path(tempfile.gettempdir()) / 'pd-dedupe-review-english-light.png'))
    page.close()
    setup.evaluate('''async()=>{
      const {createLibraryReplacementRecoveryPoint}=await import('./library-recovery-point.js');
      const saved=await chrome.runtime.sendMessage({type:'GET_FOLDER_BACKUP_STATE'});
      await chrome.storage.local.set({libraryReplacementRecoveryPoint:createLibraryReplacementRecoveryPoint(saved)});
      await chrome.runtime.sendMessage({type:'UPDATE_UI_PREFERENCES',preferences:{locale:'zh-CN',theme:'dark'}});
    }''')
    page = run.open_page('library.html')
    expect(page.locator("body[data-library-state='ready']")).to_be_visible()
    page.locator('#open-settings').click()
    expect(page.locator('#library-recovery-actions')).to_have_count(0)
    for width in [1440, 390]:
        page.set_viewport_size({'width': width, 'height': 1000})
        page.locator('#restore-folder-backup').click()
        expect(page.locator('#restore-library-replacement-point')).to_be_visible()
        dialog = page.locator('#promptdirector-app-dialog')
        assert dialog.evaluate('(e)=>e.scrollWidth<=e.clientWidth+1')
        page.screenshot(path=str(Path(tempfile.gettempdir()) / f'pd-recovery-options-{width}.png'))
        page.keyboard.press('Escape')
        expect(page.locator('#restore-library-replacement-point')).to_have_count(0)
    page.close()
    many = [{**entries[1], 'id': f'reference-{i}', 'title': f'Reference clip {i}'} for i in range(61)]
    run.seed_storage(setup, {'entries': many, 'uiPreferences': {'locale': 'zh-CN', 'theme': 'dark'}})
    page = run.open_page('library.html')
    expect(page.locator("body[data-library-state='ready']")).to_be_visible()
    dialog = open_review()
    expect(dialog.locator('.dedupe-unverified-row')).to_have_count(0)
    dialog.locator('[data-review=pending]').click()
    assert 0 < dialog.locator('.dedupe-unverified-row').count() < len(many)
    while dialog.get_by_role('button', name='显示更多待核对项', exact=True).count():
        dialog.get_by_role('button', name='显示更多待核对项', exact=True).click()
    expect(dialog.locator('.dedupe-unverified-row')).to_have_count(len(many))
    expect(dialog.locator('.dedupe-unverified img, .dedupe-unverified video')).to_have_count(0)
    expect(dialog.locator('.dedupe-footer')).to_be_hidden()
    dialog.locator('.dedupe-unverified').first.evaluate('(e)=>e.scrollTop=0')
    dialog.screenshot(path=str(Path(tempfile.gettempdir()) / 'pd-dedupe-review-many.png'))
    dialog.locator('[data-review=pending]').click()
    expect(dialog.locator('.dedupe-unverified-row')).to_have_count(0)
    assert not run.page_errors, run.page_errors
    print('PASS: inspect case, reasoned retry, durable dismissal, restore reminder, verified rows disappear, dismissed originals never become duplicate proof; wide/narrow')
