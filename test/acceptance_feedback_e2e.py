"""Actual MCP selection reload and narrow detail controls, using disposable data."""
import json
import os
import sys
import tempfile
import time
from pathlib import Path
from playwright.sync_api import expect
from e2e_support import EXTENSION_DIR, base_entry, extension_session


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else 'all'
    failures = []
    with tempfile.TemporaryDirectory(prefix='pd-feedback-extension-') as tmp:
        ext = Path(tmp)
        for path in EXTENSION_DIR.iterdir():
            if path.name != 'background.js':
                (ext / path.name).symlink_to(path, target_is_directory=path.is_dir())
        (ext / 'background.js').write_text((EXTENSION_DIR / 'background.js').read_text() + '\nglobalThis.agentTestDispatch = dispatchAgentOperation;\n')
        with extension_session('pd-feedback-', extension_dir=ext, show_scrollbars=True) as run:
            setup = run.open_page('collector.html')
            entries = []
            for index in range(2):
                entry = base_entry(f'feedback-{index}', f'Gym workout {index}', 'gym fitness cinematic reference', 'content:prompt:image')
                entry['mediaAssets'] = [{'id': f'feedback-{index}-{n}', 'kind': 'image', 'storageMode': 'managed', 'mimeType': 'image/png', 'width': 1, 'height': 1} for n in range(16)]
                entry['primaryMediaId'] = entry['mediaAssets'][0]['id']
                if index == 0:
                    entry['mediaAssets'][1].update(kind='video', mimeType='video/mp4', width=320, height=180)
                entries.append(entry)
            run.seed_storage(setup, {'entries': entries, 'uiPreferences': {'locale': 'en', 'theme': 'light', 'motion': 'reduced', 'detailMode': 'fullscreen'}})
            setup.evaluate('''async ({entries,video}) => {
              const {saveMediaBlob}=await import('./media-store.js');
              const blob=await (await fetch('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==')).blob();
              for(const entry of entries) for(const asset of entry.mediaAssets) await saveMediaBlob(asset.id, asset.kind==='video' ? new Blob([new Uint8Array(video)],{type:'video/mp4'}) : blob);
            }''', {'entries': entries, 'video': list((Path(__file__).parent/'fixtures/review-workspace-smoke.mp4').read_bytes())})
            page = run.open_page('library.html')
            expect(page.locator('.case-card')).to_have_count(2)
            worker = run.context.service_workers[0]
            def call(op, data=None):
                return worker.evaluate('([op,input])=>agentTestDispatch(op,input)', [op, data or {}])
            if mode in ('all', 'selection'):
                other = run.open_page('library.html')
                expect(other.locator('.case-card')).to_have_count(2)
                before = call('read_case_details', {'caseId': 'feedback-0'})['revision']
                live = call('read_live_workspace', {'tabId': call('read_live_workspace')['contexts'][0]['tabId']})
                result = call('control_workspace', {'requestId': 'feedback-selection', 'tabId': live['tabId'], 'expectedRevision': live['controlRevision'], 'action': 'set_selection', 'caseIds': ['feedback-0', 'feedback-1']})
                assert result['state'] == 'executed', result
                selected = call('read_workspace_context', {'source': 'selection'})
                assert selected['selectedCaseCount'] == 2, selected
                revision = selected['selectionRevision']
                page.reload()
                expect(page.locator('.case-card')).to_have_count(2)
                selected = call('read_workspace_context', {'source': 'selection'})
                if selected['selectedCaseCount'] != 2 or selected['selectionRevision'] != revision:
                    failures.append({'test': 'Agent reference selection survives reload', 'actual': selected})
                assert call('read_case_details', {'caseId': 'feedback-0'})['revision'] == before
                other.reload()
                expect(other.locator('.case-card')).to_have_count(2)
                with run.context.expect_page() as opened_page:
                    reopened = call('show_case', {'caseId': 'feedback-0'})
                new_page = opened_page.value
                expect(new_page.locator('#detail-drawer')).to_be_visible()
                selected = call('read_workspace_context', {'source': 'selection'})
                if selected['selectedCaseCount'] != 2 or selected['selectionRevision'] != revision:
                    failures.append({'test': 'Opening another case preserves Agent references', 'actual': selected})
                assert reopened['state'] == 'ready' and reopened['viewedCaseId'] == 'feedback-0', reopened
                other.close()
                new_page.close()
                with run.context.expect_page() as composer_page:
                    composer = call('open_workspace', {'surface': 'composer'})
                assert composer['state'] == 'ready' and composer['surface'] == 'composer', composer
                composer_page.value.close()
                # The reported symptom happened after a reload and reconnect.
                # Close every extension view and actually restart its MV3 worker;
                # no live page or in-memory projection can preserve this result.
                idle_seconds = float(os.environ.get('PD_SELECTION_IDLE_SECONDS', '0'))
                if idle_seconds:
                    print(json.dumps({'selectionIdleSeconds': idle_seconds, 'referenceCount': 2}), flush=True)
                    time.sleep(idle_seconds)
                    assert call('read_workspace_context', {'source': 'selection'})['selectionRevision'] == revision
                for old in [setup, page]:
                    old.close()
                assert call('read_workspace_context', {'source': 'selection'})['selectedCaseCount'] == 2
                run.restart_browser(extension_dir=ext)
                worker = run.context.service_workers[0]
                page = run.open_page('library.html')
                expect(page.locator('.case-card')).to_have_count(2)
                selected = call('read_workspace_context', {'source': 'selection'})
                assert selected['selectedCaseCount'] == 2 and selected['selectionRevision'] == revision, selected
                # Human changes supersede an earlier Agent command, and an
                # explicit Cancel is the only action here expected to clear.
                live = call('read_live_workspace')
                expect(page.locator('.case-card[aria-pressed="true"]')).to_have_count(2)
                page.locator('.case-card').first.click()
                expect(page.locator('.case-card[aria-pressed="true"]')).to_have_count(1)
                stale = worker.evaluate("async input => {try {return await agentTestDispatch('control_workspace',input)} catch(error) {return {code:error.code}}}",
                    {'requestId': 'feedback-stale-selection', 'tabId': live['tabId'], 'expectedRevision': live['controlRevision'],
                     'action': 'set_selection', 'caseIds': ['feedback-0', 'feedback-1']})
                assert stale['code'] == 'workspace_changed', stale
                assert call('read_workspace_context', {'source': 'selection'})['selectedCaseCount'] == 1
                page.locator('#share-cancel').click()
                expect(page.locator('.case-card[aria-pressed="true"]')).to_have_count(0)
                page.reload()
                expect(page.locator('.case-card')).to_have_count(2)
                assert call('read_workspace_context', {'source': 'selection'})['selectedCaseCount'] == 0
                status = call('status')
                assert 'open_workspace' in status['capabilities']
                assert 'en' in status['searchGuidance']['languages'] and status['searchGuidance']['pluginApiCalls'] is False
                live = call('read_live_workspace')
                browse = call('control_workspace', {'requestId': 'feedback-browse', 'tabId': live['tabId'], 'expectedRevision': live['controlRevision'], 'action': 'set_browse', 'browse': {'query': 'cinematic', 'pendingOnly': False}})
                assert browse['state'] == 'executed', browse
                expect(page.locator('#search-input')).to_have_value('cinematic')
                live = call('read_live_workspace')
                opened = call('control_workspace', {'requestId': 'feedback-settings', 'tabId': live['tabId'], 'expectedRevision': live['controlRevision'], 'action': 'open_settings'})
                assert opened['state'] == 'executed', opened
                expect(page.locator('#settings-dialog')).to_be_visible()
                page.locator('#settings-close').click()
            if mode in ('all', 'layout', 'toolbar'):
                if setup.is_closed():
                    setup = run.open_page('collector.html')
                if page.locator('#share-cancel').is_visible():
                    page.locator('#share-cancel').click()
                artifact = Path(os.environ.get('PD_E2E_ARTIFACT_DIR', tempfile.gettempdir()))
                artifact.mkdir(parents=True, exist_ok=True)
                for locale in ['en', 'zh-CN']:
                    page.close()
                    setup.evaluate("async ({locale,theme}) => { const {uiPreferences}=await chrome.storage.local.get('uiPreferences');await chrome.storage.local.set({uiPreferences:{...uiPreferences,locale,theme}}); }", {'locale': locale, 'theme': 'dark' if mode == 'toolbar' and locale == 'zh-CN' else 'light'})
                    page = run.open_page('library.html')
                    expect(page.locator('.case-card')).to_have_count(2)
                    sizes = [(960, 0.6), (1440, 0.6)] if mode == 'toolbar' else [(390, None), (640, None), (900, None), (1440, None), (960, 0.6)]
                    for width, ratio in sizes:
                        page.set_viewport_size({'width': width, 'height': 850})
                        if page.locator('#detail-drawer').is_visible():
                            page.locator('#detail-close').click()
                        if mode != 'toolbar':
                            page.locator('#select-cases').click()
                            page.locator('.case-card').first.click()
                            value = page.locator('#share-cancel').evaluate('''button => {
                              const rect=button.getBoundingClientRect();
                              const center=document.elementFromPoint(rect.left+rect.width/2,rect.top+rect.height/2);
                              const clip=document.querySelector('#selection-selected-actions').getBoundingClientRect();
                              const collisions=[...document.querySelectorAll('#selection-selected-actions button,#selection-selected-actions summary')].filter(n=>n.checkVisibility()).map(n=>n.getBoundingClientRect()).filter(r=>Math.min(r.right,clip.right)>rect.left && Math.max(r.left,clip.left)<rect.right && r.top<rect.bottom && r.bottom>rect.top);
                              return {hit:(button===center || button.contains(center)) && !collisions.length,rect:rect.toJSON(),collisions};
                            }''')
                            page.screenshot(path=str(artifact / f'management-{locale}-{width}.png'))
                            if not value['hit']:
                                failures.append({'test': 'Management cancel remains clickable', 'locale': locale, 'width': width, 'actual': value})
                            page.locator('#share-cancel').click(force=True)
                        page.locator('.case-card[data-entry-id=feedback-0]').click()
                        expect(page.locator('#detail-drawer')).to_be_visible()
                        page.wait_for_function("() => { const gallery=document.querySelector('.detail-visual-gallery');return gallery?.checkVisibility({visibilityProperty:true}) && (gallery.querySelector('img')?.naturalWidth>0 || gallery.dataset.displayedAssetId==='feedback-0-1'); }")
                        expect(page.locator('.detail-visual-gallery')).to_be_visible()
                        page.locator('.detail-visual-thumb').nth(1).click()
                        expect(page.locator('.detail-visual-gallery')).to_have_attribute('data-displayed-asset-id', 'feedback-0-1')
                        if not page.evaluate("()=>document.querySelector('.detail-video')?.readyState>=2"):
                            page.locator('.detail-video-play').click()
                        page.wait_for_function("()=>document.querySelector('.detail-video')?.readyState>=2")
                        page.locator('.detail-video').evaluate('video=>video.pause()')
                        if ratio is not None:
                            primary = page.locator('.detail-primary').bounding_box()
                            divider = page.locator('.detail-split-resizer').bounding_box()
                            page.mouse.move(divider['x']+divider['width']/2, divider['y']+divider['height']/2)
                            page.mouse.down()
                            page.mouse.move(primary['x']+primary['width']*(1-ratio), divider['y']+divider['height']/2, steps=5)
                            page.mouse.up()
                        page.screenshot(path=str(artifact / f'detail-start-{locale}-{width}.png'))
                        for selector in ['#detail-drawer .detail-media-tools', '#detail-drawer .detail-visual-rail']:
                            target=page.locator(selector).first
                            if not target.count():
                                continue
                            overflow=target.evaluate('node=>{node.scrollLeft=0;return node.scrollWidth-node.clientWidth;}')
                            if overflow > 0:
                                bounds=target.bounding_box()
                                page.mouse.move(bounds['x']+bounds['width']/2, bounds['y']+bounds['height']/2)
                                page.mouse.wheel(0, overflow+bounds['width'])
                                page.wait_for_function('(selector)=>{const n=document.querySelector(selector);return n.scrollLeft>=n.scrollWidth-n.clientWidth-1;}', arg=selector)
                            value=target.evaluate('''node => {
                              const isTools=node.classList.contains('detail-media-tools');
                              if(isTools && getComputedStyle(node).scrollbarWidth!=='none')return {hit:false,unwantedActionScrollbar:true};
                              if(!isTools && node.scrollWidth>node.clientWidth && getComputedStyle(node).scrollbarWidth==='none')return {hit:false,thumbnailScrollbarHidden:true};
                              const navigation=node.closest('.detail-visual-gallery').querySelector('.detail-media-navigation');
                              if(isTools && navigation) {
                                const caption=node.closest('.detail-visual-caption'), nav=navigation.getBoundingClientRect();
                                if(Math.abs(nav.left-caption.getBoundingClientRect().left-parseFloat(getComputedStyle(caption).paddingLeft))>1)return {hit:false,navigationNotLeftAligned:true};
                                if(Math.abs(nav.top-node.querySelector('button').getBoundingClientRect().top)>1)return {hit:false,buttonsMisaligned:true};
                              }
                              const children=[...node.querySelectorAll('button')].filter(n=>n.checkVisibility());
                              const last=children.at(-1); if(!last)return {hit:true};
                              const r=last.getBoundingClientRect(), bounds=node.getBoundingClientRect();
                              const center=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);
                              return {hit:(last===center||last.contains(center)) && r.left>=bounds.left-1 && r.right<=bounds.right+1,cover:center?.className,last:r.toJSON(),bounds:bounds.toJSON(),scrollWidth:node.scrollWidth,clientWidth:node.clientWidth};
                            }''')
                            if not value['hit']:
                                failures.append({'test': 'Last detail control reachable', 'selector': selector, 'locale': locale, 'width': width, 'actual': value})
                        page.screenshot(path=str(artifact / f'detail-{locale}-{width}.png'))
                        page.locator('#detail-close').click()
            assert not run.page_errors, run.page_errors
            print(json.dumps({'mode': mode, 'failures': failures}, ensure_ascii=False), flush=True)
            assert not failures, failures


if __name__ == '__main__':
    main()
