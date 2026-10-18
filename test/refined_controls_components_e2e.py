"""Production component fragments on HTTP; no extension page, account or library."""
import json
import os
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]

def main():
    output = Path(os.environ.get('PD_E2E_ARTIFACT_DIR', '/tmp/pd-refined-controls'))
    output.mkdir(parents=True, exist_ok=True)
    collector = (ROOT/'extension/collector.html').read_text()
    header = collector[collector.index('<header class="collector-header">'):collector.index('</header>')+9]
    library = (ROOT/'extension/library.html').read_text()
    start = library.index('<div id="share-bar"')
    bar = library[start:library.index('<button id="manage-case-order"', start)]
    class Handler(SimpleHTTPRequestHandler):
        def __init__(self, *args, **kwargs): super().__init__(*args, directory=str(ROOT/'extension'), **kwargs)
        def log_message(self, *_): pass
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    results = []
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()
            page = browser.new_page()
            page.goto(f'http://127.0.0.1:{server.server_port}/tag-editor.js')
            page.evaluate('''async()=>{
              window.saved=[];window.preferences={theme:'light',customTagColors:{'324':'#10b981','dsfds':'#f97316'}};
              window.chrome={storage:{local:{get:async()=>({uiPreferences:preferences})},onChanged:{addListener(){}}},i18n:{getUILanguage:()=> 'zh-CN'},runtime:{sendMessage:async m=>{saved.push(m);preferences={...preferences,...m.preferences};return {ok:true,uiPreferences:preferences};}}};
              window.ui=await import('/i18n.js'); window.tags=await import('/tag-editor.js');
            }''')
            for width, theme, locale in [(1000,'light','zh-CN'),(390,'dark','zh-CN'),(320,'light','en'),(390,'light','zh-CN')]:
                page.set_viewport_size({'width':width,'height':600})
                page.evaluate('''async({header,bar,theme,locale})=>{
                  document.head.innerHTML='<link rel="stylesheet" href="/ui-foundation.css"><link rel="stylesheet" href="/library.css"><link rel="stylesheet" href="/organization.css"><style>body{display:block;margin:0;padding:16px;min-width:0}#tags{margin-bottom:24px}#management{margin:0 0 24px;max-width:100%}iframe{border:0;width:100%;max-width:390px;height:90px}</style>';
                  document.body.innerHTML='<section id="tags"></section><section id="management">'+bar+'</section><iframe id="nav"></iframe>';
                  document.querySelector('#share-bar').hidden=false;document.querySelector('#selection-selected-actions').hidden=false;
                  document.querySelector('#share-count').textContent='';document.querySelectorAll('#management button[disabled]').forEach(b=>b.disabled=false);
                  await ui.initializeUi({theme,locale});
                  window.editor=tags.createTagEditor({values:['324','dsfds','长标签名称测试'],compact:true,onChange:async values=>{window.values=values;}});
                  document.querySelector('#tags').append(editor.element || editor.root);
                  const frame=document.querySelector('#nav');frame.srcdoc='<base href="'+location.origin+'/"><link rel="stylesheet" href="ui-foundation.css"><link rel="stylesheet" href="collector.css"><style>body{padding:0;min-width:0}</style>'+header;
                  await new Promise(r=>frame.onload=r);
                  frame.contentDocument.documentElement.dataset.theme=theme;
                  if(locale==='en'){frame.contentDocument.querySelector('#open-library span').textContent='Library';frame.contentDocument.querySelector('#open-capture-assistant span').textContent='Assistant';}
                }''', {'header':header,'bar':bar,'theme':theme,'locale':locale})
                page.wait_for_timeout(100)
                chip = page.locator('.tag-editor-chip').first
                before = chip.bounding_box()
                assert chip.evaluate('(e)=>getComputedStyle(e).borderTopWidth') == '0px'
                assert page.locator('.tag-color-button').first.evaluate('(e)=>getComputedStyle(e,"::after").width') == '8px'
                page.mouse.move(1, 1)
                page.wait_for_function('getComputedStyle(document.querySelector(".tag-remove-button")).opacity === "0"')
                chip.hover()
                assert chip.bounding_box() == before
                page.wait_for_function('getComputedStyle(document.querySelector(".tag-remove-button")).opacity === "1"')
                page.locator('.tag-color-button').first.click()
                assert page.locator('.tag-color-palette').is_visible()
                page.keyboard.press('Escape')
                assert page.locator('.tag-color-palette').count() == 0
                assert page.locator('.tag-color-button').first.evaluate('(e)=>e===document.activeElement')
                nav = page.frame_locator('#nav')
                assert nav.locator('#open-library span').is_visible()
                assert nav.locator('#open-capture-assistant span').is_visible()
                assert nav.locator('#open-library').evaluate('(e)=>getComputedStyle(e).borderTopWidth') == '1px'
                assert nav.locator('#open-library').bounding_box()['x'] > nav.locator('#open-capture-assistant').bounding_box()['x']
                assert nav.locator('#open-library').bounding_box()['height'] >= 36
                nav.locator('body').evaluate('(e)=>e.classList.add("capture-assistant-open")')
                assert nav.locator('#open-library span').is_visible()
                assert nav.locator('#open-capture-assistant span').is_visible()
                nav.locator('body').evaluate('(e)=>e.classList.remove("capture-assistant-open")')
                assert nav.locator('.product-brand-mark').get_attribute('src') == 'assets/icons/icon-source.svg'
                assert nav.locator('.collector-header').evaluate('(e)=>e.scrollWidth<=e.clientWidth'), width
                order = page.locator('#selection-selected-actions').evaluate('(e)=>[...e.children].map(n=>n.id)')
                assert order == ['selection-project-menu','selection-classification-menu','selection-label-menu','selection-more-menu','selection-trash'], order
                assert page.locator('#selection-selected-actions > details > summary svg, #selection-trash svg').count() == 5
                assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
                if width == 1000: page.locator('#tags').screenshot(path=str(output/'tag-keyboard-focus.png'))
                page.evaluate('document.activeElement.blur()')
                page.mouse.move(1, 1)
                page.wait_for_function('getComputedStyle(document.querySelector(".tag-remove-button")).opacity === "0"')
                height=page.locator('#nav').bounding_box()['y']+90
                page.screenshot(path=str(output/f'controls-{width}-{theme}-{locale}.png'), clip={'x':0,'y':0,'width':width,'height':height})
                results.append({'width':width,'theme':theme,'locale':locale,'order':order,'tagHeight':before['height']})
            page.locator('.tag-color-button').first.click()
            page.locator('.tag-color-choice[aria-label="#ef4444"]').click()
            assert page.evaluate('saved.at(-1).preferences.customTagColors["324"]') == '#ef4444'
            assert page.locator('.tag-color-button').first.evaluate('(e)=>getComputedStyle(e,"::after").backgroundColor') == 'rgb(239, 68, 68)'
            page.locator('.tag-editor-chip').first.hover()
            page.get_by_role('button',name='删除标签：324',exact=True).click()
            assert page.evaluate('values') == ['dsfds','长标签名称测试']
            browser.close()
        (output/'results.json').write_text(json.dumps(results,ensure_ascii=False,indent=2))
        print(json.dumps({'passed':len(results),'colorSaveAndDelete':True,'output':str(output)}))
    finally: server.shutdown(); server.server_close()

if __name__ == '__main__': main()
