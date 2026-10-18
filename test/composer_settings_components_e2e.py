"""Render only the production creative-settings component over HTTP.
No complete application, extension context, storage, or account is loaded.
"""
import json
import os
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parents[1]

def main():
    output=Path(os.environ.get('PD_E2E_ARTIFACT_DIR','/tmp/pd-composer-settings'))
    output.mkdir(parents=True,exist_ok=True)
    html=(ROOT/'extension/composer.html').read_text()
    start=html.index('<details id="composer-options"')
    component=html[start:html.index('</details>',start)+len('</details>')].replace('<details ','<details open ',1)
    js=(ROOT/'extension/composer-page.js').read_text()
    start=js.index('  const videoTask = composerSession?.targetType',js.index('function renderComposerAiProfile'))
    availability=js[start:js.index('\n}',start)]
    class Handler(SimpleHTTPRequestHandler):
        def __init__(self,*args,**kwargs):super().__init__(*args,directory=str(ROOT/'extension'),**kwargs)
        def log_message(self,*_):pass
    server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
    threading.Thread(target=server.serve_forever,daemon=True).start()
    try:
        with sync_playwright() as p:
            browser=p.chromium.launch(headless=True,channel=os.environ.get('PROMPTDIRECTOR_E2E_CHANNEL','chromium'))
            page=browser.new_page()
            page.goto(f'http://127.0.0.1:{server.server_port}/composer-page.css')
            results=[]
            for width,theme,disabled in [(1280,'light',False),(1280,'dark',True),(390,'light',True),(390,'dark',False)]:
                page.set_viewport_size({'width':width,'height':650})
                page.evaluate('''({component,theme})=>{
                  document.documentElement.dataset.theme=theme;
                  document.head.innerHTML='<link rel="stylesheet" href="/ui-foundation.css"><link rel="stylesheet" href="/library.css"><link rel="stylesheet" href="/composer-page.css"><style>body{margin:0;background:var(--paper);padding:24px}.composer-options{position:fixed;right:30px;bottom:34px}</style>';
                  document.body.innerHTML=component;
                  const size=document.querySelector('#composer-image-size');size.innerHTML='<option>方形 · 1024×1024</option>';
                  document.querySelector('#composer-generation-settings').hidden=false;
                  for(const id of ['composer-image-quality-field','composer-image-reference-mode-field'])document.getElementById(id).hidden=true;
                }''',{'component':component,'theme':theme})
                page.evaluate('''({availability,disabled})=>{
                  const elements={};for(const id of ['composer-create-image','composer-create-media-label','composer-create-image-note','composer-production-review'])elements[id.replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]=document.getElementById(id);
                  const reason=disabled?'请先配置支持图片生成的服务':'使用当前创作服务直接生成图片';
                  new Function('elements','composerSession','activeOperation','generationRouteProfile','composerVideoAvailability','composerImageAvailability','composerVisionSettings','t','translateUiMessage','renderImageGenerationSettings',availability)(elements,{targetType:'image',outputMode:'text_prompt',routeMode:'auto'},null,()=>({}),()=>({available:!disabled,message:reason}),()=>({available:!disabled,message:reason}),{},v=>v,v=>v,()=>{});
                }''',{'availability':availability,'disabled':disabled})
                page.wait_for_timeout(100)
                checks=page.evaluate('''()=>{
                  const group=document.querySelector('.composer-option-toggles'),panel=document.querySelector('.composer-options-panel'),create=document.querySelector('#composer-create-image'),label=create.closest('label');
                  return {height:group.getBoundingClientRect().height,count:group.children.length,panelFits:panel.scrollWidth<=panel.clientWidth,disabled:create.disabled,description:document.getElementById(create.getAttribute('aria-describedby')).textContent,title:label.title,focusable:label.tabIndex,diagnosticButtons:['composer-diagnostic-export','composer-assembly-open'].every(id=>document.getElementById(id).getBoundingClientRect().height>0)};
                }''')
                assert checks['height']==90 and checks['count']==3,checks
                assert checks['panelFits'] and not checks['diagnosticButtons'],checks
                assert checks['disabled']==disabled and checks['title']==checks['description'],checks
                if disabled:
                    assert checks['focusable']==0,checks
                    page.locator('#composer-create-image').locator('..').focus()
                else:
                    page.locator('#composer-thinking').check()
                    assert page.locator('#composer-thinking').is_checked()
                    page.locator('#composer-thinking').focus()
                page.keyboard.press('Tab');page.keyboard.press('Shift+Tab')
                assert page.evaluate('document.activeElement.matches(":focus-visible")')
                page.locator('.composer-options-panel').screenshot(path=str(output/f'settings-{width}-{theme}-{disabled}.png'))
                results.append(checks)
            (output/'results.json').write_text(json.dumps(results,ensure_ascii=False,indent=2))
            browser.close()
            print(json.dumps({'passed':len(results),'artifacts':str(output)}))
    finally:server.shutdown();server.server_close()
if __name__=='__main__':main()
