"""Visible split/cancel and tag colors preserve originals and manual edits."""
import tempfile
from pathlib import Path
from playwright.sync_api import expect
from e2e_support import extension_session, base_entry, wait_for_async_condition

def main():
    output=Path(tempfile.gettempdir())/'pd-split-ui-evidence';output.mkdir(exist_ok=True)
    entry=base_entry('split-ui','Two original images','Shared original prompt','content:prompt:image',0)
    entry.update(customLabels=['Director'],mediaAssets=[{'id':name,'kind':'image','storageMode':'managed','mimeType':'image/png'} for name in ['first','second']])
    with extension_session('pd-split-ui-',viewport={'width':1440,'height':900}) as session:
        setup=session.open_page('collector.html')
        session.seed_storage(setup,{'entries':[entry],'uiPreferences':{'locale':'en','motion':'reduced'}})
        setup.evaluate('''async()=>{const {saveMediaBlob}=await import('./media-store.js');const canvas=document.createElement('canvas');canvas.width=40;canvas.height=40;const ctx=canvas.getContext('2d');for(const [id,color]of [['first','red'],['second','blue']]){ctx.fillStyle=color;ctx.fillRect(0,0,40,40);await saveMediaBlob(id,await new Promise(r=>canvas.toBlob(r)),{checkCapacity:false});}}''')
        page=session.open_page('library.html',wait_until='networkidle')
        page.locator('[data-entry-id="split-ui"].case-card').click()
        color=page.locator('#detail-content button[data-tag-color]').first
        color.click()
        palette=page.locator('.tag-color-palette');expect(palette).to_be_visible()
        expect(palette.locator('.tag-color-choice')).to_have_count(18)
        # Every swatch keeps its own color on hover/focus, not the global green.
        for choice in palette.locator('.tag-color-choice:not(.tag-color-default)').all():
            choice.hover(); choice.focus()
            assert choice.evaluate("e=>{const c=document.createElement('span');c.style.color=e.style.getPropertyValue('--tag-color');document.body.append(c);const expected=getComputedStyle(c).color;c.remove();return getComputedStyle(e).backgroundColor===expected&&(!e.matches(':focus-visible')||getComputedStyle(e).outlineColor===expected)}")
        page.screenshot(path=str(output/'tag-palette-light.png'))
        palette.get_by_role('button',name='#ec4899',exact=True).click()
        wait_for_async_condition(page,"async()=> (await chrome.storage.local.get('uiPreferences')).uiPreferences.customTagColors?.director==='#ec4899'")
        chip=page.locator('#detail-content [data-custom-tag="director"]').first
        page.wait_for_function("()=>getComputedStyle(document.querySelector('#detail-content [data-custom-tag=director]')).borderTopColor==='rgb(236, 72, 153)'")
        for theme in ['dark','light']:
            page.evaluate("async theme=>(await import('./i18n.js')).initializeUi({theme,locale:'en',motion:'reduced'})",theme)
            if not color.count(): page.locator('[data-entry-id="split-ui"].case-card').click()
            color.click()
            selected=palette.get_by_role('button',name='#ec4899',exact=True)
            expect(selected).to_have_attribute('aria-pressed','true')
            selected.hover()
            assert selected.evaluate("e=>getComputedStyle(e).backgroundColor==='rgb(236, 72, 153)'")
            page.screenshot(path=str(output/f'tag-selected-{theme}.png'))
            selected.press('Escape')
        page.reload(wait_until='networkidle');page.locator('[data-entry-id="split-ui"].case-card').click()
        page.wait_for_function("()=>{const e=document.querySelector('#detail-content button[data-tag-color]');return e&&getComputedStyle(e).backgroundColor==='rgb(236, 72, 153)'}")
        # Concurrent distinct labels merge against latest preferences.
        result=page.evaluate('''async()=>{await Promise.all(['a','b'].map(key=>chrome.runtime.sendMessage({type:'UPDATE_UI_PREFERENCES',preferences:{customTagColors:{[key]:'#abcdef'}}})));return (await chrome.storage.local.get('uiPreferences')).uiPreferences.customTagColors;}''')
        assert result=={'director':'#ec4899','a':'#abcdef','b':'#abcdef'}
        page.locator('.entry-editor-inline > summary').click()
        for width in [1440,390]:
            page.set_viewport_size({'width':width,'height':900})
            page.locator('.entry-editor-inline').get_by_role('button',name='Media',exact=True).click()
            page.get_by_role('menuitem',name='Split into separate cases',exact=True).click()
            dialog=page.locator('.media-split-dialog');expect(dialog).to_be_visible()
            expect(dialog.locator('.media-split-card')).to_have_count(2)
            assert dialog.evaluate('e=>e.scrollWidth<=e.clientWidth+1')
            assert '首项' not in dialog.inner_text()
            page.screenshot(path=str(output/f'split-en-{width}.png'))
            dialog.get_by_role('button',name='Cancel',exact=True).click()
            state=page.evaluate("async()=>chrome.runtime.sendMessage({type:'GET_STATE'})")
            assert len(state['entries'])==1 and len(state['entries'][0]['mediaAssets'])==2
        page.locator('.entry-editor-inline').get_by_role('button',name='Media',exact=True).click()
        page.get_by_role('menuitem',name='Split into separate cases',exact=True).click()
        page.locator('.media-split-dialog').get_by_role('button',name='Split into 2 cases',exact=True).click()
        expect(page.locator('.media-split-dialog')).not_to_be_visible(timeout=30000)
        page.reload(wait_until='networkidle')
        state=page.evaluate("async()=>chrome.runtime.sendMessage({type:'GET_STATE'})")
        assert len(state['entries'])==2
        assert all(e['text']=='Shared original prompt' and e['customLabels']==['Director'] for e in state['entries'])
        print({'split':True,'cancelPreservesOriginal':True,'englishWidths':[1440,390],'concurrentColors':True,'screenshots':str(output)})

if __name__=='__main__':main()
