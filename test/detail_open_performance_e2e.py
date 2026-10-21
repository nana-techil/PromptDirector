"""Exercise first-frame scheduling and cancellation through real detail opens."""
import json
import base64
import os
import re
import tempfile
from pathlib import Path
from playwright.sync_api import expect
from e2e_support import EXTENSION_DIR, base_entry, extension_session
from image_generation_info_e2e import png_bytes


def main():
    with tempfile.TemporaryDirectory(prefix='pd-detail-source-') as tmp:
        ext = Path(tmp)
        for source in EXTENSION_DIR.iterdir():
            if source.name != 'library.js':
                (ext / source.name).symlink_to(source, target_is_directory=source.is_dir())
        source = (EXTENSION_DIR / 'library.js').read_text()
        source = source.replace('function createLocalDiscovery(entry) {', '''function createLocalDiscovery(entry) {
          window.detailEvents.push({kind: 'rank', id: entry.id});''', 1)
        source = source.replace('async function loadImageDerivedMetadata({ refresh = false } = {}) {', '''async function loadImageDerivedMetadata({ refresh = false } = {}) {
          if (window.detailMetadataGate) { window.detailMetadataStarted = true; await window.detailMetadataGate; }''', 1)
        source = source.replace('const readDetailGenerationInfo = createGenerationInfoViewReader(getMediaBlob);', """const actualReadDetailGenerationInfo = createGenerationInfoViewReader(getMediaBlob);
          async function readDetailGenerationInfo(...args) {
            if (window.generationGate) await window.generationGate;
            return actualReadDetailGenerationInfo(...args);
          }""", 1)
        hooks = '''
window.detailEvents = [];
window.detailTest = {
  async prepare(stale) { await loadImageDerivedMetadata(); currentSimilarityIndex(); localSimilarityIndexStale = stale; if(stale) imageDerivedMetadataLoaded=false; },
  open: openDetail, close: closeDetail, ready: () => libraryFullyLoaded,
  expected(id) { const index=currentSimilarityIndex(); return rankSimilarEntries(index,id,index.profiles.size).map(item=>item.entry.title); }
};
'''
        source = source.replace('try {\n  await openLibraryProgressively();', hooks + '\ntry {\n  await openLibraryProgressively();', 1)
        (ext / 'library.js').write_text(source)
        with extension_session('pd-detail-scheduling-', extension_dir=ext, viewport={'width':1280,'height':900}) as session:
            setup = session.open_page('collector.html')
            entries = []
            for i in range(60):
                entry = base_entry(f'perf-{i}', f'Case {i}', 'Cinematic city in rain', 'content:prompt:image')
                entry.update(mediaAssets=[{'id':f'image-{i}', 'kind':'image', 'usage':'content', 'storageMode':'managed',
                    'mimeType':'image/png', 'palette':{'version':1,'colors':['#112233','#445566']}}], primaryMediaId=f'image-{i}')
                entries.append(entry)
            session.seed_storage(setup, {'entries':entries, 'uiPreferences':{'locale':'zh-CN','detailMode':'fullscreen'}})
            setup.evaluate('''async png => {
              const {saveMediaBlob}=await import('./media-store.js');
              const canvas=document.createElement('canvas');canvas.width=canvas.height=32;
              canvas.getContext('2d').fillRect(0,0,16,32);
              const blob=await new Promise(resolve=>canvas.toBlob(resolve));
              for(let i=0;i<60;i++) await saveMediaBlob(`image-${i}`,blob,{checkCapacity:false});
              await saveMediaBlob('image-0',new Blob([Uint8Array.from(atob(png),c=>c.charCodeAt(0))],{type:'image/png'}),{checkCapacity:false});
            }''',base64.b64encode(png_bytes()).decode())
            page = session.open_page('library.html')
            page.on('pageerror', lambda error: print(str(error), flush=True))
            page.wait_for_selector('.case-card')
            page.wait_for_function('() => window.detailTest?.ready()')
            # Metadata may be slow; visible case content must not wait for this optional enrichment.
            page.evaluate("""() => {
              window.generationGate=new Promise(resolve=>window.releaseGeneration=resolve);
              void window.detailTest.open('perf-0');
            }""")
            expect(page.locator('#detail-drawer')).to_have_attribute('data-entry-id','perf-0')
            expect(page.locator('#detail-content .detail-image')).to_be_visible()
            page.wait_for_function("() => { const image=document.querySelector('#detail-content .detail-image');return image?.complete && image.naturalWidth>0 && getComputedStyle(document.querySelector('#detail-drawer')).opacity==='1'; }")
            if os.environ.get('PD_E2E_ARTIFACT_DIR'):
                out=Path(os.environ['PD_E2E_ARTIFACT_DIR']);out.mkdir(parents=True,exist_ok=True)
                page.screenshot(path=str(out/'metadata-still-pending.png'))
            page.get_by_role('button',name='编辑原始提示词',exact=True).click()
            draft=page.get_by_role('textbox',name='编辑原始提示词',exact=True)
            draft.fill('Unsaved draft must survive metadata enrichment')
            page.evaluate('() => { window.generationGate=null;window.releaseGeneration(); }')
            expect(page.locator('#detail-content .source-open-action')).to_have_attribute('aria-description', re.compile('.*18446744073709551615.*', re.S))
            expect(draft).to_have_value('Unsaved draft must survive metadata enrichment')
            page.locator('.prompt-edit-actions').get_by_role('button',name='取消',exact=True).click()
            page.locator('#detail-close').click()
            for stale in [False, True]:
                page.evaluate('(stale)=>window.detailTest.prepare(stale)', stale)
                events = page.evaluate('''async () => {
                  window.detailEvents=[];
                  document.querySelector('.case-card[data-entry-id="perf-0"]').click();
                  await new Promise(resolve=>{
                    const tick=()=>{
                      if(document.querySelector('#detail-drawer').dataset.entryId==='perf-0') {
                        window.detailEvents.push({kind:'ready-frame',id:'perf-0'});resolve();
                      } else requestAnimationFrame(tick);
                    };requestAnimationFrame(tick);
                  });return window.detailEvents;
                }''')
                assert events[0]['kind'] == 'ready-frame', events
                page.wait_for_selector('.detail-discovery .local-discovery-item')
                assert page.evaluate('window.detailEvents.filter(e=>e.kind==="rank").map(e=>e.id)') == ['perf-0']
                expected = page.evaluate('window.detailTest.expected("perf-0")')
                expect(page.locator('.detail-discovery-heading')).to_contain_text(str(len(expected)))
                actual = page.locator('.local-discovery-item').evaluate_all("nodes => nodes.map(node => node.getAttribute('aria-label').split('：')[1].split('；')[0])")
                # The section retains the complete ranking, with its existing paged DOM.
                assert actual == expected[:len(actual)] and len(actual) > 0, (actual,expected[:24])
                page.locator('#detail-close').click()
            for action in ['close','switch']:
                page.evaluate('''async action => {
                  window.detailEvents=[];
                  await window.detailTest.open('perf-0');
                  if(action==='close') window.detailTest.close();
                  else await window.detailTest.open('perf-1');
                }''',action)
                if action == 'switch':
                    page.wait_for_selector('.detail-discovery .local-discovery-item')
                    expect(page.locator('#detail-drawer')).to_have_attribute('data-entry-id','perf-1')
                page.wait_for_timeout(150)
                assert not page.evaluate('window.detailEvents.some(e=>e.kind==="rank"&&e.id==="perf-0")')
                if action == 'close': assert page.locator('.detail-discovery').count() == 0
                else: page.locator('#detail-close').click()
            # Closing while the deferred metadata read is still pending must also cancel ranking.
            page.evaluate("""async () => {
              window.detailEvents=[];window.detailMetadataStarted=false;
              window.detailMetadataGate=new Promise(resolve=>window.releaseDetailMetadata=resolve);
              await window.detailTest.open('perf-0');
            }""")
            page.wait_for_function('() => window.detailMetadataStarted')
            page.evaluate('() => { window.detailTest.close();window.detailMetadataGate=null;window.releaseDetailMetadata(); }')
            page.wait_for_timeout(150)
            assert page.evaluate('window.detailEvents') == []
            assert page.locator('.detail-discovery').count() == 0
            assert not session.page_errors, session.page_errors
            print(json.dumps({'first_frame_before_ranking':True,'warm_and_stale':True,'cancel_close_switch':True}))


if __name__ == '__main__':
    main()
