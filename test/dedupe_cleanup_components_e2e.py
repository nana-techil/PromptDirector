"""Dedupe production component on HTTP with memory fixtures; no extension or real library."""
import json
import os
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]

def main():
    output = Path(os.environ.get('PD_E2E_ARTIFACT_DIR', '/tmp/pd-dedupe-components'))
    output.mkdir(parents=True, exist_ok=True)
    class Handler(SimpleHTTPRequestHandler):
        def __init__(self, *args, **kwargs): super().__init__(*args, directory=str(ROOT/'extension'), **kwargs)
        def log_message(self, *_): pass
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    markup = (ROOT/'extension/library.html').read_text()
    heading = markup[markup.index('<div class="settings-subview-heading">'):markup.index('<div class="case-dedupe-panel">')]
    results = []
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()
            page = browser.new_page()
            page.goto(f'http://127.0.0.1:{server.server_port}/library-dedupe-panel.js')
            page.evaluate('''async()=>{
              window.chrome={storage:{local:{get:async()=>({}),set:async()=>{},remove:async()=>{}},onChanged:{addListener(){},removeListener(){}}},i18n:{getUILanguage:()=> 'zh-CN'}};
              window.ui=await import('/i18n.js'); window.panel=await import('/library-dedupe-panel.js');
              window.ops=await import('/case-dedupe-operations.js');
              document.head.innerHTML='<link rel="stylesheet" href="/ui-foundation.css"><link rel="stylesheet" href="/library.css"><style>body{display:block;min-width:0;margin:0;padding:12px}#fixture{height:calc(100dvh - 24px);border:1px solid var(--line);border-radius:8px}</style>';
              window.mount=async({theme,mixed=false,blocked=true})=>{
                window.controller?.dispose();document.body.innerHTML='<section id="fixture" class="settings-dedupe-panel">'+window.headingMarkup+'<div class="case-dedupe-panel"></div></section>';
                window.originalBack=document.querySelector('#dedupe-back');window.backClicks=0;originalBack.addEventListener('click',()=>backClicks++);
                await ui.initializeUi({theme,locale:'zh-CN'});
                const entry=(id,date)=>({id,title:'A straight-on, medium-long shot — '+id,text:'Complete source prompt is preserved.',libraryAddedAt:date,mediaAssets:[{id:'asset',kind:'image',usage:'content',storageMode:'managed',mimeType:'image/png',byteSize:9,contentHash:'a'.repeat(64)}]});
                window.state={entries:[entry('a','2026-10-18'),entry('b','2026-10-17')],organizerState:{collections:[]},compoundCases:blocked?[{id:'storyboard',title:'我的电影分镜',memberEntryIds:['b']}]:[],trashState:{items:[]}};
                if(mixed)state.entries.push(entry('c','2026-10-16'));
                window.applies=[];window.opened=[];window.messages=[];
                const data={}; const service=ops.createCaseDedupeOperations({loadState:async()=>state,storage:{get:async key=>({[key]:data[key]})},enqueue:fn=>fn(),commit:async patch=>{Object.assign(data,patch);state={...state,...patch};}});
                const picture='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="180" height="240"><rect width="180" height="240" fill="#b79d63"/><circle cx="90" cy="80" r="38" fill="#f0d5ad"/><path d="M35 240V140Q90 100 145 140V240" fill="#e7c037"/></svg>');
                window.controller=panel.mountCaseDedupePanel(document.querySelector('#fixture .case-dedupe-panel'),{heading:document.querySelector('.settings-subview-heading'),state,facetCatalog:{nodes:[]},contentLabel:x=>x,pageSize:20,currentState:()=>state,thumbnailUrl:async()=>picture,mediaUrl:async()=>picture,openCase:async id=>opened.push(id),send:async message=>{
                  messages.push(message);if(message.type==='PREVIEW_CASE_DEDUPE')return service.preview(message.groups);
                  if(message.type==='APPLY_CASE_DEDUPE'){applies.push(message);return service.execute(message.input);}
                  throw Error('Unexpected message: '+message.type);
                }});
              };
            }''')
            page.evaluate('(markup)=>window.headingMarkup=markup',heading)
            for width, theme in [(960,'light'),(390,'dark')]:
                page.set_viewport_size({'width':width,'height':680})
                page.evaluate('mount',{'theme':theme})
                page.get_by_role('button',name='查看详情',exact=True).click()
                assert page.evaluate('originalBack===document.querySelector(".dedupe-toolbar #dedupe-back")')
                page.locator('#dedupe-back').click()
                assert page.evaluate('backClicks')==1
                if width==960:
                    assert abs(page.locator('.settings-subview-heading').bounding_box()['y']-page.get_by_label('检查范围').bounding_box()['y'])<2
                page.get_by_role('button',name='一键清理重复',exact=True).click()
                page.wait_for_function('document.querySelector(".dedupe-status").textContent.includes("本次未清理")')
                assert page.locator('.dedupe-review').inner_text().find('将保留 0') == -1
                assert '清理后进入回收站' not in page.locator('.dedupe-review').inner_text()
                assert page.locator('.dedupe-footer > span').inner_text() == '保留 2 份 · 清理 0 份'
                assert page.get_by_role('button',name='一键清理重复',exact=True).is_disabled()
                assert page.locator('.dedupe-comparison').bounding_box()['height'] > 300
                assert page.evaluate('applies.length') == 0
                assert page.locator('.dedupe-review').inner_text().find('我的电影分镜') >= 0
                page.locator('.dedupe-review').get_by_role('button',name='查看案例',exact=True).click()
                assert page.evaluate('opened') == ['storyboard']
                page.screenshot(path=str(output/f'blocked-{width}-{theme}.png'))
                page.locator('.dedupe-content').evaluate('(e)=>e.scrollTop=0')
                page.screenshot(path=str(output/f'comparison-{width}-{theme}.png'))
                assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
                results.append({'width':width,'theme':theme,'blocked':True,'noFalseConfirmation':True})
            page.set_viewport_size({'width':960,'height':680})
            page.evaluate('mount',{'theme':'light','mixed':True})
            page.get_by_role('button',name='一键清理重复',exact=True).click()
            page.get_by_role('button',name='确认移入回收站',exact=True).wait_for(state='visible')
            assert page.locator('.dedupe-review strong').inner_text() == '将保留 2 份，清理 1 份'
            assert page.locator('.dedupe-footer > span').inner_text() == '保留 2 份 · 清理 1 份'
            page.screenshot(path=str(output/'mixed-confirmation.png'))
            page.get_by_role('button',name='确认移入回收站',exact=True).click()
            page.wait_for_function('document.querySelector(".dedupe-status").textContent.includes("1 个案例已移入回收站")')
            assert page.evaluate('applies[0].input.groups.flatMap(g=>g.remove.map(r=>r.id))') == ['c']
            assert page.evaluate('state.entries.map(e=>e.id)') == ['a','b']
            page.evaluate('mount',{'theme':'light','blocked':False})
            page.get_by_role('button',name='一键清理重复',exact=True).click()
            page.get_by_role('button',name='确认移入回收站',exact=True).wait_for(state='visible')
            page.evaluate("state.compoundCases=[{id:'later',title:'后来新增组合',memberEntryIds:['b']}]")
            page.get_by_role('button',name='确认移入回收站',exact=True).click()
            page.wait_for_function('document.querySelector(".dedupe-status").textContent.includes("本次未清理")')
            assert '0 个案例已移入回收站' not in page.locator('.dedupe-status').inner_text()
            assert page.evaluate('state.entries.length') == 2
            assert page.locator('.dedupe-footer > span').inner_text() == '保留 2 份 · 清理 0 份'
            assert page.get_by_role('button',name='一键清理重复',exact=True).is_disabled()
            page.evaluate('controller.dispose()')
            assert page.evaluate('originalBack===document.querySelector("#fixture > .settings-subview-heading #dedupe-back")')
            page.locator('#dedupe-back').click()
            assert page.evaluate('backClicks')==1
            page.evaluate('''()=>{chrome.storage.local.get=async keys=>{
              if((Array.isArray(keys)?keys:[keys]).includes('dedupeReviewDismissals'))await new Promise(resolve=>window.finishRead=resolve);
              return {};
            };}''')
            page.evaluate('mount',{'theme':'light'})
            page.wait_for_function('Boolean(window.finishRead)')
            assert page.get_by_role('button',name='重新比较',exact=True).is_disabled()
            assert page.locator('#dedupe-back').is_enabled()
            page.locator('#dedupe-back').focus()
            assert page.locator('#dedupe-back').evaluate('(e)=>e===document.activeElement')
            page.evaluate('controller.dispose();finishRead()')
            assert page.locator('.dedupe-toolbar').count()==0
            assert page.evaluate('originalBack===document.querySelector("#fixture > .settings-subview-heading #dedupe-back")')
            browser.close()
        (output/'results.json').write_text(json.dumps({'states':results,'mixedOnlyAccepted':True,'lateReferenceProtected':True,'backButtonLifecycle':True},ensure_ascii=False,indent=2))
        print(json.dumps({'passed':5,'output':str(output)}))
    finally: server.shutdown();server.server_close()

if __name__ == '__main__': main()
