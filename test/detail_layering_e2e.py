"""The prompt toolbar must never cover case editing or the fixed viewer controls."""
import os
from pathlib import Path
from playwright.sync_api import expect
from e2e_support import extension_session, base_entry


def main():
    out = Path(os.environ.get('PD_E2E_ARTIFACT_DIR', '/tmp/pd-detail-layering'))
    out.mkdir(parents=True, exist_ok=True)
    entry = base_entry('layering', '长标题 · AI art gallery / A complete creative reference',
                       '完整原始提示词\n\n' + '镜头稳定推进，保留全部创作细节。\n' * 150, 'content:prompt:image')
    entry.update(mediaAssets=[{'id': 'layering-image', 'kind': 'image', 'storageMode': 'managed', 'mimeType': 'image/png'}], primaryMediaId='layering-image')
    with extension_session('pd-detail-layering-', show_scrollbars=True) as run:
        p = run.open_page('collector.html', wait_until='networkidle')
        run.seed_storage(p, {'entries': [entry], 'dataSafetyOnboardingSeen': True,
                             'uiPreferences': {'theme': 'dark', 'locale': 'zh-CN', 'motion': 'reduced'}})
        p.evaluate('''async () => {
          const c=document.createElement('canvas'); c.width=900; c.height=600;
          c.getContext('2d').fillRect(0,0,900,600);
          await (await import('./media-store.js')).saveMediaBlob('layering-image', await new Promise(r=>c.toBlob(r)));
        }''')
        p = run.open_page('library.html', wait_until='networkidle')
        p.locator('.case-card').click()
        for theme, locale in [('dark', 'zh-CN'), ('light', 'en')]:
            p.evaluate("async v=>(await import('./i18n.js')).initializeUi(v)", {'theme': theme, 'locale': locale, 'motion': 'reduced'})
            for mode, width in [('full', 1280), ('sidebar', 1100), ('sidebar', 581), ('full', 390)]:
                p.set_viewport_size({'width': 1280, 'height': 720})
                sidebar = 'detail-sidebar-mode' in p.locator('#detail-drawer').get_attribute('class')
                if sidebar != (mode == 'sidebar'):
                    p.locator('#detail-mode-toggle').click()
                p.set_viewport_size({'width': width, 'height': 720})
                p.locator('.entry-editor-inline > summary').click()
                expect(p.locator('.entry-editor-body')).to_be_visible()
                p.evaluate('()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')
                p.screenshot(path=str(out/f'edit-{theme}-{mode}-{width}.png'))
                # Check where the prompt toolbar used to intercept the title input.
                assert p.locator('.entry-edit-field input').evaluate('''e=>{
                  let r=e.getBoundingClientRect();let hit=document.elementFromPoint(r.right-10,r.top+5);
                  return hit===e;
                }'''), f'Prompt toolbar covers title input: {theme}/{mode}/{width}'
                p.locator('.entry-edit-field input').click()
                expect(p.locator('.entry-edit-field input')).to_be_focused()
                for selector in ['#detail-close', '#detail-mode-toggle', '.entry-editor-inline > summary']:
                    if not p.locator(selector).is_visible():
                        assert selector == '#detail-mode-toggle' and width <= 640
                        continue
                    assert p.locator(selector).evaluate('''e=>{let r=e.getBoundingClientRect();return e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))}'''), selector
                p.locator('.entry-editor-inline > summary').click()
                expand = p.locator('.original-prompt-panel .prompt-expand')
                if expand.get_attribute('aria-expanded') != 'true':
                    expand.click()
                if mode == 'sidebar' or width <= 640:
                    prompt_before = p.locator('.original-prompt-panel .prompt-section-heading').bounding_box()['y']
                    p.locator('#detail-content').evaluate('e=>e.scrollTop=180')
                    prompt_after = p.locator('.original-prompt-panel .prompt-section-heading').bounding_box()['y']
                    assert prompt_after < prompt_before - 100, (prompt_before, prompt_after)
                    assert p.locator('#detail-close').evaluate('''e=>{let r=e.getBoundingClientRect();return e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))}''')
                    p.screenshot(path=str(out/f'scroll-{theme}-{mode}-{width}.png'))
                    p.locator('#detail-content').evaluate('e=>e.scrollTop=0')
                else:
                    p.locator('.detail-reading').evaluate('e=>e.scrollTop=180')
                    assert p.locator('.original-prompt-panel .prompt-section-heading').bounding_box()['y'] >= p.locator('.detail-reading').bounding_box()['y'] - 1
                    p.locator('.detail-reading').evaluate('e=>e.scrollTop=0')
        saved=p.evaluate("async()=>(await chrome.runtime.sendMessage({type:'GET_STATE'})).entries[0]")
        assert saved['text'] == entry['text'] and saved['title'] == entry['title']
        assert not run.page_errors, run.page_errors
        print('PASS: full/sidebar/narrow editing hit targets, fixed controls, local and overall scrolling, dark/light Chinese/English and original preservation')


if __name__ == '__main__':
    main()
