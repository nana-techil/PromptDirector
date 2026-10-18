"""Code and media share an in-flow detail surface; card previews never show browser scrollbars."""
import os
import re
import tempfile
from pathlib import Path
from playwright.sync_api import expect
from e2e_support import base_entry, extension_session


def main():
    out = Path(os.environ.get('PD_E2E_ARTIFACT_DIR') or tempfile.mkdtemp(prefix='pd-detail-surface-'))
    out.mkdir(parents=True, exist_ok=True)
    html = '''<style>body{margin:0;background:#0d0d0d;color:white;min-height:100vh;display:grid;place-items:center}
      .scroll{width:500px;height:240px;overflow:scroll}button{margin:40px;width:420px;height:140px;border:0;border-radius:20px;background:orange;font:700 28px system-ui}
      button:hover{transform:scale(.97)}</style><div class="scroll"><button onclick="this.textContent='Clicked'">Push me</button></div>'''
    source = 'A continuous shot at sunset.\n\n# Original source\n\n```css\nbutton { background: orange; }\n```\n\n```promptdirector-preview-html\n' + html + '\n```'
    code = base_entry('code', 'Push Button — interactive source', source, 'content:code-case')
    media = base_entry('image', '海边日落 · 完整创作参考 / Sunset motion study — continuous camera movement and lighting reference',
                       '\n\n'.join(['A continuous shot at sunset. 保持人物、服装、姿态和空间关系一致。',
                                    'Camera movement\nStart with a wide composition, then slowly move toward the subject.\n镜头平稳推进，保留环境层次。',
                                    'Lighting\nWarm light on the subject, cool shadows in the distance.\n暖色主光，远景保留冷色层次。'] * 4), 'content:prompt:image')
    related = [base_entry(f'related-{i}', f'Motion study {i + 1} — interaction', source, 'content:code-case') for i in range(30)]
    for entry in [code, media, *related]: entry['customLabels'] = ['Motion study']
    media.update(mediaAssets=[{'id': 'original', 'kind': 'image', 'storageMode': 'managed', 'mimeType': 'image/png', 'width': 960, 'height': 540}], primaryMediaId='original')
    with extension_session('pd-detail-surface-', show_scrollbars=True) as run:
        setup = run.open_page('collector.html', wait_until='networkidle')
        run.seed_storage(setup, {'entries': [code, media, *related], 'dataSafetyOnboardingSeen': True,
                                'uiPreferences': {'theme': 'dark', 'locale': 'en', 'motion': 'reduced'}})
        setup.evaluate('''async () => {
          const canvas=document.createElement('canvas');canvas.width=960;canvas.height=540;
          const c=canvas.getContext('2d');c.fillStyle='#9a6c4b';c.fillRect(0,0,960,540);
          c.fillStyle='#eec694';c.beginPath();c.arc(480,240,100,0,Math.PI*2);c.fill();
          c.fillStyle='#284454';c.fillRect(0,340,960,200);
          await (await import('./media-store.js')).saveMediaBlob('original',await new Promise(r=>canvas.toBlob(r)));
        }''')
        page = run.open_page('library.html', wait_until='networkidle')
        for locale, theme in [('en', 'dark'), ('zh-CN', 'light')]:
            page.evaluate("async prefs=>(await import('./i18n.js')).initializeUi(prefs)", {'locale': locale, 'theme': theme, 'motion': 'reduced'})
            for width in [1280, 390]:
                page.set_viewport_size({'width': width, 'height': 900})
                card = page.locator('.case-card[data-entry-id=code]')
                card.scroll_into_view_if_needed()
                expect(card.locator('.code-case-frame')).to_have_attribute('data-preview-ready', 'true')
                inner = card.frame_locator('.code-case-frame').frame_locator('#preview')
                assert inner.locator('.scroll').evaluate("el=>getComputedStyle(el).scrollbarWidth") == 'none'
                assert inner.locator('body').evaluate("el=>getComputedStyle(el).overflow") == 'hidden'
                page.screenshot(path=str(out / f'gallery-{theme}-{width}.png'))
                card.locator('.case-code-title').click()
                expect(page.locator('.code-case-view .code-case-frame')).to_have_attribute('data-preview-ready', 'true')
                demo = page.frame_locator('.code-case-view .code-case-frame').frame_locator('#preview')
                demo.get_by_role('button', name='Push me').click()
                expect(demo.get_by_role('button', name='Clicked')).to_be_visible()
                expected_background = page.locator('.detail-body').evaluate('e=>getComputedStyle(e).backgroundColor')
                assert demo.locator('body').evaluate('e=>getComputedStyle(e).backgroundColor') == expected_background
                bounds = page.evaluate('''() => {
                  const stage=document.querySelector('.detail-primary > .code-case-view').getBoundingClientRect();
                  const panel=document.querySelector('.detail-primary > .detail-body').getBoundingClientRect();
                  return {stage:{right:stage.right,bottom:stage.bottom},panel:{left:panel.left,top:panel.top},
                    background:getComputedStyle(document.querySelector('.detail-body')).backgroundColor,
                    shell:getComputedStyle(document.querySelector('.detail-drawer')).backgroundColor,
                    overflow:document.querySelector('.detail-content').scrollWidth>document.querySelector('.detail-content').clientWidth};
                }''')
                assert bounds['background'] == bounds['shell'] and bounds['shell'] not in ['rgb(0, 0, 0)', 'rgb(255, 255, 255)'] and not bounds['overflow'], bounds
                if width > 640: assert bounds['stage']['right'] <= bounds['panel']['left'] + 1, bounds
                else: assert bounds['stage']['bottom'] <= bounds['panel']['top'] + 1, bounds
                expect(page.locator('.code-case-source .markdown-reader')).to_contain_text('button { background: orange; }')
                page.mouse.move(10, 10)
                page.screenshot(path=str(out / f'code-{theme}-{width}.png'))
                page.locator('#detail-close').click()
                page.locator('.case-card[data-entry-id=image]').click()
                expect(page.locator('.detail-image')).to_be_visible()
                expect(page.locator('.prompt-read-body')).to_contain_text(media['text'])
                assert page.locator('.prompt-read-body').evaluate('el=>getComputedStyle(el).backgroundColor') == 'rgba(0, 0, 0, 0)'
                assert page.locator('#detail-close').evaluate('el=>getComputedStyle(el).boxShadow') == 'none'
                page.mouse.move(10, 10)
                page.wait_for_function("() => [...document.querySelectorAll('.detail-visual-actions svg use')].every(el => el.getBBox().width > 0)")
                page.screenshot(path=str(out / f'image-{theme}-{width}.png'))
                if width > 640:
                    assert page.locator('.detail-visual-gallery').bounding_box()['x'] + page.locator('.detail-visual-gallery').bounding_box()['width'] <= page.locator('.detail-body').bounding_box()['x'] + 1
                page.locator('.detail-discovery-heading').scroll_into_view_if_needed()
                preview = page.locator('.detail-discovery .code-case-frame').first
                expect(preview).to_have_attribute('data-preview-ready', 'true')
                expect(page.locator('.case-card[data-entry-id=code] .code-case-frame')).not_to_have_attribute('src', re.compile('.+'))
                total = page.locator('.detail-discovery .code-case-frame').count()
                active = page.locator('.detail-discovery .code-case-frame[src]').count()
                assert 0 < active < total, (active, total)
                preview_handle = preview.element_handle()
                page.screenshot(path=str(out / f'similar-{theme}-{width}.png'))
                if width == 1280:
                    page.locator('.detail-discovery .case-code-title').first.click()
                    expect(page.locator('.code-case-view .code-case-frame')).to_have_attribute('data-preview-ready', 'true')
                    expect(page.locator('.code-case-source')).to_contain_text('button { background: orange; }')
                page.locator('#detail-close').click()
                assert preview_handle.evaluate('el=>el.getAttribute("src")') is None
        # System preference must use the same theme surface without a separate viewer palette.
        for theme in ['dark', 'light']:
            page.emulate_media(color_scheme=theme)
            page.evaluate("async ()=>(await import('./i18n.js')).initializeUi({theme:'system',locale:'en',motion:'reduced'})")
            assert page.evaluate("()=>getComputedStyle(document.documentElement).getPropertyValue('--viewer-bg').trim()===getComputedStyle(document.documentElement).getPropertyValue('--ui-surface').trim()")
        page.set_viewport_size({'width':1280,'height':900})
        page.locator('.case-card[data-entry-id=code] .case-code-title').click()
        expect(page.locator('.code-case-view .code-case-frame')).to_have_attribute('data-preview-ready', 'true')
        live_demo = page.frame_locator('.code-case-view .code-case-frame').frame_locator('#preview')
        live_demo.get_by_role('button',name='Push me').click()
        for scheme in ['dark','light']:
            page.emulate_media(color_scheme=scheme)
            page.evaluate('()=>new Promise(r=>requestAnimationFrame(r))')
            expect(live_demo.locator('body')).to_have_css('background-color', page.locator('.detail-drawer').evaluate('e=>getComputedStyle(e).backgroundColor'))
            expect(live_demo.get_by_role('button',name='Clicked')).to_be_visible()
        page.locator('.detail-split-resizer').focus()
        before = page.locator('.detail-body').bounding_box()['width']
        page.keyboard.press('ArrowLeft')
        page.wait_for_function("before=>document.querySelector('.detail-body').getBoundingClientRect().width>before", arg=before, timeout=3000)
        # Updating source must rebuild the runnable preview; unrelated organization preserves it.
        page.locator('.code-case-view').evaluate("node=>node.dataset.probe='preserved'")
        setup.evaluate('''async()=>{
          const storage=(await import('./library-storage.js')).getLibraryStorage();
          const {entries}=await storage.get('entries');entries.find(e=>e.id==='code').customLabels=['Reviewed'];await storage.set({entries});
        }''')
        expect(page.locator('.detail-quick-organization')).to_contain_text('Reviewed')
        expect(page.locator('.code-case-view')).to_have_attribute('data-probe','preserved')
        updated = source.replace('Push me', 'Updated preview')
        setup.evaluate('''async text=>{
          const storage=(await import('./library-storage.js')).getLibraryStorage();
          const {entries}=await storage.get('entries');entries.find(e=>e.id==='code').text=text;await storage.set({entries});
        }''', updated)
        expect(page.frame_locator('.code-case-view .code-case-frame').frame_locator('#preview').get_by_role('button',name='Updated preview')).to_be_visible()
        expect(page.locator('.code-case-source')).to_contain_text('Updated preview')
        stored = setup.evaluate("async()=>(await chrome.runtime.sendMessage({type:'GET_STATE'})).entries")
        assert next(e for e in stored if e['id'] == 'code')['text'] == updated
        print(f'PASS: live code interaction, visible source, in-flow panes, shared theme, width and narrow layout; originals unchanged. Screenshots: {out}')


if __name__ == '__main__':
    main()
