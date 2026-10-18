"""Long content exposes thin tracks; compact surfaces retain scrolling without tracks."""
from pathlib import Path
import tempfile
from e2e_support import extension_session,base_entry
from playwright.sync_api import expect
with extension_session('pd-hidden-scroll-',viewport={'width':1440,'height':900}) as s:
    setup=s.open_page('collector.html')
    entry=base_entry('scroll-case','长提示词案例','\n'.join(f'第{i}行提示词，完整保留内容。' for i in range(220)),'content:prompt:image')
    document=base_entry('document-case','长资料文章','\n'.join(f'资料第{i}段完整正文内容保留。' for i in range(220)),'content:reference')
    document.update(contentRole='reference')
    s.seed_storage(setup,{'entries':[entry,document]+[base_entry(f'case-{i}',f'案例 {i}','测试正文','content:prompt:image',i+1) for i in range(80)],'organizerState':{'version':7,'collections':[dict(id=f'p{i}',name=f'项目 {i}',entryIds=[],order=i) for i in range(70)]},'uiPreferences':{'locale':'zh-CN','motion':'reduced'}})
    page=s.open_page('library.html',wait_until='networkidle')
    assert page.evaluate('getComputedStyle(document.documentElement).scrollbarWidth') == 'thin'
    page.locator('#case-list').hover()
    page.mouse.wheel(0, 600)
    page.wait_for_function('()=>window.scrollY > 0')
    page.evaluate('window.scrollTo(0,0)')
    page.locator('#open-settings').click()
    page.locator('[data-settings-tab="general"]').click()
    page.set_viewport_size({'width':960,'height':710})
    panel=page.locator('.settings-panel:not([hidden])')
    assert panel.evaluate('e=>getComputedStyle(e).scrollbarWidth') == 'none'
    assert panel.evaluate('e=>e.scrollHeight>e.clientHeight')
    panel.hover();page.mouse.wheel(0,450)
    page.wait_for_function("()=>document.querySelector('.settings-panel:not([hidden])').scrollTop>0")
    for theme in ['dark','light']:
        page.evaluate('v=>{document.documentElement.dataset.theme=v;document.documentElement.dataset.resolvedTheme=v}',theme)
        page.screenshot(path=str(Path(tempfile.gettempdir()) / f'promptdirector-settings-scroll-{theme}.png'))
    page.locator('#settings-close').click()
    page.set_viewport_size({'width':1440,'height':900})
    body=page.locator('#sidebar-projects-body')
    assert body.evaluate('e=>getComputedStyle(e).scrollbarWidth')=='none'
    body.hover(); page.mouse.wheel(0,550)
    page.wait_for_function("()=>document.querySelector('#sidebar-projects-body').scrollTop>0")
    page.locator('#search-input').fill('长提示词案例')
    page.locator('.case-card[data-entry-id="scroll-case"]').click()
    expect(page.locator('#detail-drawer')).to_have_attribute('aria-hidden','false')
    page.get_by_role('button',name='展开全文',exact=True).first.click()
    page.evaluate("""()=>{const region=[...document.querySelectorAll('#detail-drawer, #detail-drawer *')].find(e=>e.clientHeight>0&&e.scrollHeight>e.clientHeight&&['auto','scroll'].includes(getComputedStyle(e).overflowY));if(!region)throw Error('No overflowing detail region');region.dataset.scrollProbe='true'}""")
    prompt=page.locator('[data-scroll-probe]')
    # Ordinary case reading stays compact by default (2026-09-25): long text still scrolls,
    # while only documents, reading panes and editors expose a draggable track.
    assert prompt.evaluate('e=>e.id')=='detail-content'
    assert prompt.evaluate('e=>getComputedStyle(e).scrollbarWidth')=='none'
    prompt.hover();page.mouse.wheel(0,500)
    page.wait_for_function("()=>document.querySelector('[data-scroll-probe]').scrollTop>0")
    # Native keyboard scrolling remains available when the region is focused.
    prompt.evaluate('e=>e.focus()')
    before=prompt.evaluate('e=>e.scrollTop')
    page.keyboard.press('PageDown')
    page.wait_for_function('(before)=>document.querySelector("[data-scroll-probe]").scrollTop>before',arg=before)
    assert page.locator('#detail-drawer').evaluate("e=>[e,...e.querySelectorAll('*')].every(n=>getComputedStyle(n).scrollbarWidth===(n.matches('.detail-reading, .ui-scrollbar, textarea:not([readonly]):not([disabled]), [contenteditable]:not([contenteditable=\"false\"])')?'thin':'none'))")
    page.screenshot(path=str(Path(tempfile.gettempdir()) / 'promptdirector-hidden-scroll.png'))
    page.locator('#detail-close').click()
    # Documents keep the draggable thin track on the real reading surface (2026-10-18).
    page.locator('#search-input').fill('长资料文章')
    page.locator('.case-card[data-entry-id="document-case"]').click()
    expect(page.locator('#detail-drawer')).to_have_attribute('aria-hidden','false')
    page.evaluate("""()=>{const region=[...document.querySelectorAll('#detail-drawer, #detail-drawer *')].find(e=>e.clientHeight>0&&e.scrollHeight>e.clientHeight&&['auto','scroll'].includes(getComputedStyle(e).overflowY));if(!region)throw Error('No overflowing document region');region.dataset.docScrollProbe='true'}""")
    doc_region=page.locator('[data-doc-scroll-probe]')
    assert doc_region.evaluate('e=>e.id')=='detail-content' and doc_region.evaluate('e=>e.classList.contains("ui-scrollbar")')
    assert doc_region.evaluate('e=>getComputedStyle(e).scrollbarWidth')=='thin'
    doc_region.hover();page.mouse.wheel(0,400)
    page.wait_for_function("()=>document.querySelector('[data-doc-scroll-probe]').scrollTop>0")
    page.locator('#detail-close').click()
    page.locator('#search-input').fill('')
    # The shared opt-in preserves a draggable track for wide content and editors.
    page.evaluate("""() => {
      const box=document.createElement('div');box.className='ui-scrollbar';box.id='wide-scroll-probe';
      box.style.cssText='position:fixed;inset:100px auto auto 300px;width:300px;height:100px;overflow:auto;z-index:10000;background:white';
      const wide=document.createElement('div');wide.style.cssText='width:1200px;height:40px';wide.textContent='宽表格';box.append(wide);
      const edit=document.createElement('textarea');edit.id='edit-scroll-probe';edit.style.cssText='position:fixed;inset:250px auto auto 300px;width:300px;height:100px;z-index:10000';edit.value='可编辑长文本\\n'.repeat(100);
      document.body.append(box,edit);
    }""")
    wide=page.locator('#wide-scroll-probe')
    assert wide.evaluate('e=>getComputedStyle(e).scrollbarWidth')=='thin'
    wide.hover();page.mouse.wheel(500,0)
    page.wait_for_function("()=>document.querySelector('#wide-scroll-probe').scrollLeft>0")
    editor=page.locator('#edit-scroll-probe')
    assert editor.evaluate('e=>getComputedStyle(e).scrollbarWidth')=='thin'
    editor.hover();page.mouse.wheel(0,500)
    page.wait_for_function("()=>document.querySelector('#edit-scroll-probe').scrollTop>0")
    for url in ['composer.html','skills.html','collector.html','curated.html','curated-skills.html']:
        other=s.open_page(url,wait_until='domcontentloaded')
        assert other.evaluate('getComputedStyle(document.documentElement).scrollbarWidth')=='none',url
        other.close()
    assert not s.page_errors,s.page_errors
    print('PASS: ordinary reading stays track-free but scrollable; document/details reading surfaces expose thin tracks; settings/sidebar stay compact; wheel/PageDown and editor/wide-content scrolling remain usable')
