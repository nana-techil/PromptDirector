"""Mixed captures keep useful prompt scopes and video-first previews without rewriting originals."""
import os
import tempfile
from pathlib import Path
from playwright.sync_api import expect
from e2e_support import extension_session, base_entry


def main():
    out = Path(os.environ.get('PD_E2E_ARTIFACT_DIR') or tempfile.mkdtemp(prefix='pd-detail-media-'))
    out.mkdir(parents=True, exist_ok=True)
    with extension_session('pd-detail-media-') as run:
        setup = run.open_page('collector.html')
        entries = []
        for key, category in [('shared', 'content:prompt:video'), ('video-case', 'content:video-case'), ('image-case', 'content:image-case'), ('distinct', 'content:prompt:image'), ('excerpt', 'content:prompt:video'), ('sole', 'content:prompt:image')]:
            entry = base_entry(key, key, 'A forest with glowing fireflies', category)
            entry.update(mediaAssets=[{'id': key + '-image', 'kind': 'image', 'storageMode': 'managed', 'mimeType': 'image/png', 'width': 640, 'height': 360},
                                      {'id': key + '-video', 'kind': 'video', 'storageMode': 'managed', 'mimeType': 'video/mp4', 'width': 320, 'height': 180}], primaryMediaId=key + '-image',
                         sourceFacts={'originalPromptAvailable': True})
            if key == 'distinct':
                entry['mediaPrompts'] = [{'assetId': key + '-image', 'source': 'manual', 'text': 'A city skyline'}]
            if key == 'excerpt':
                entry['mediaPrompts'] = [{'assetId': key + '-image', 'source': 'webpage', 'text': 'A forest'}]
            if key == 'sole':
                entry['text'] = ''
                entry['mediaPrompts'] = [{'assetId': key + '-image', 'source': 'webpage', 'text': 'The only original prompt'}]
            entries.append(entry)
        run.seed_storage(setup, {'entries': entries, 'dataSafetyOnboardingSeen': True,
                                'uiPreferences': {'locale': 'en', 'theme': 'dark', 'motion': 'reduced'}})
        raw = (Path(__file__).parent / 'fixtures/review-workspace-smoke.mp4').read_bytes()
        setup.evaluate('''async ({entries, raw}) => {
          const {saveMediaBlob} = await import('./media-store.js');
          const canvas = document.createElement('canvas'); canvas.width=640; canvas.height=360;
          const ctx=canvas.getContext('2d'); ctx.fillStyle='#344b40';ctx.fillRect(0,0,640,360);
          ctx.fillStyle='#c9edc5';ctx.font='32px sans-serif';ctx.fillText('Image reference',32,180);
          const png=await new Promise(resolve=>canvas.toBlob(resolve));
          for (const entry of entries) {
            await saveMediaBlob(entry.id+'-image',png);
            await saveMediaBlob(entry.id+'-video',new Blob([new Uint8Array(raw)],{type:'video/mp4'}));
          }
        }''', {'entries': entries, 'raw': list(raw)})
        read_entries = "async()=>{const{getLibraryStorage}=await import('./library-storage.js');return(await getLibraryStorage().get('entries')).entries}"
        before = setup.evaluate(read_entries)
        page = run.open_page('library.html', wait_until='networkidle')
        for key in ['shared', 'video-case', 'excerpt']:
            expect(page.locator(f'.case-card[data-entry-id="{key}"] .case-video-poster')).to_have_count(1)
            page.locator(f'.case-card[data-entry-id="{key}"]').click()
            expect(page.locator('.detail-video')).to_be_visible()
            expect(page.locator('[data-prompt-tab=media]')).to_have_count(0)
            expect(page.locator('.original-prompt-panel .prompt-read-body')).to_have_text('A forest with glowing fireflies')
            if key == 'shared':
                for locale, theme in [('en', 'dark'), ('zh-CN', 'light')]:
                    page.evaluate("async prefs=>(await import('./i18n.js')).initializeUi(prefs)", {'locale': locale, 'theme': theme, 'motion': 'reduced'})
                    page.locator('#detail-close').click()
                    page.locator('.case-card[data-entry-id=shared]').click()
                    page.locator('.detail-video-play').click()
                    page.wait_for_function("() => document.querySelector('.detail-video').currentTime > 0.1")
                    page.locator('.detail-video').evaluate('v=>v.pause()')
                    for width in [1280, 390]:
                        page.set_viewport_size({'width': width, 'height': 900})
                        page.screenshot(path=str(out / f'detail-{locale}-{width}.png'))
                page.set_viewport_size({'width': 1280, 'height': 900})
            page.locator('.detail-visual-thumb').first.click()
            expect(page.locator('.detail-image')).to_be_visible()
            page.locator('#detail-close').click()
            page.locator(f'.case-card[data-entry-id="{key}"]').click()
            expect(page.locator('.detail-image')).to_be_visible()
            page.locator('#detail-close').click()
        page.locator('.case-card[data-entry-id="image-case"]').click()
        expect(page.locator('.detail-image')).to_be_visible()
        page.locator('#detail-close').click()
        page.locator('.case-card[data-entry-id="distinct"]').click()
        page.locator('[data-prompt-tab=media]').click()
        expect(page.locator('.media-original-prompt-panel .prompt-read-body')).to_have_text('A city skyline')
        page.locator('[data-prompt-tab=shared]').click()
        expect(page.locator('.original-prompt-panel .prompt-read-body')).to_have_text('A forest with glowing fireflies')
        page.screenshot(path=str(out / 'distinct-prompts.png'))
        assert setup.evaluate(read_entries) == before, 'Browsing must not rewrite source prompts, order or primary media'
        page.locator('#detail-close').click()
        page.locator('.case-card[data-entry-id=sole]').click()
        expect(page.locator('[data-prompt-tab=media]')).to_have_count(0)
        expect(page.locator('.original-prompt-panel .prompt-read-body')).to_have_text('The only original prompt')
        page.locator('.original-prompt-panel button[aria-label="编辑原始提示词"]').click()
        page.locator('.original-prompt-panel textarea').fill('Edited sole prompt')
        page.locator('.original-prompt-panel .prompt-edit-actions').get_by_role('button', name='保存', exact=True).click()
        expect(page.locator('.original-prompt-panel .prompt-read-body')).to_have_text('Edited sole prompt')
        sole = next(e for e in setup.evaluate(read_entries) if e['id'] == 'sole')
        assert sole['text'] == '' and sole['mediaPrompts'][0]['text'] == 'Edited sole prompt'
        setup.evaluate("""()=>chrome.runtime.sendMessage({type:'UPDATE_CAPTURE_DRAFT',draft:{title:'Type selector',fragments:[{id:'text',text:'A forest with glowing fireflies'}],visuals:[]}})""")
        setup.reload(wait_until='networkidle')
        if not setup.locator('#capture-metadata').is_visible():
            setup.locator('#organize-toggle').click()
        for locale, theme in [('en', 'dark'), ('zh-CN', 'light')]:
            setup.evaluate("async prefs=>(await import('./i18n.js')).initializeUi(prefs)", {'locale': locale, 'theme': theme, 'motion': 'reduced'})
            for width in [390, 1280]:
                setup.set_viewport_size({'width': width, 'height': 900})
                for category in ['content:prompt:video', 'content:reference']:
                    setup.locator('#content-type').select_option(category)
                    assert setup.locator('#content-type').evaluate('e=>e.scrollWidth<=e.clientWidth'), 'Arrow must fit inside selector'
                setup.locator('#content-type').select_option('content:prompt:video')
                setup.screenshot(path=str(out / f'capture-{locale}-{width}.png'))
                setup.locator('#content-type').click()
                expect(setup.get_by_role('option', name='Video prompt' if locale == 'en' else '视频提示词', exact=True)).to_be_visible()
                setup.keyboard.press('Escape')
        print({'video_first': True, 'remembered_selection': True, 'prompt_scopes': True, 'originals_unchanged': True, 'selector_fit': True, 'screenshots': str(out)})


if __name__ == '__main__':
    main()
