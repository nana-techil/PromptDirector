"""Render only the local-import dialog fragment and real source-state function on HTTP."""
import json
import os
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]

def main():
    output=Path(os.environ.get('PD_E2E_ARTIFACT_DIR','/tmp/pd-import-source'))
    output.mkdir(parents=True,exist_ok=True)
    html=(ROOT/'extension/library.html').read_text();start=html.index('<dialog id="import-dialog"')
    component=html[start:html.index('</dialog>',start)+9]
    source=(ROOT/'extension/library.js').read_text();start=source.index('function renderImportSource()')
    render=source[start:source.index('\nasync function chooseLocalImportFiles',start)]
    class Handler(SimpleHTTPRequestHandler):
        def __init__(self,*args,**kwargs):super().__init__(*args,directory=str(ROOT/'extension'),**kwargs)
        def log_message(self,*_):pass
    server=ThreadingHTTPServer(('127.0.0.1',0),Handler);threading.Thread(target=server.serve_forever,daemon=True).start()
    results=[]
    try:
        with sync_playwright() as p:
            browser=p.chromium.launch();page=browser.new_page()
            page.goto(f'http://127.0.0.1:{server.server_port}/library.css')
            for width,theme,failed in [(1000,'light',False),(390,'dark',False),(1000,'dark',True),(390,'light',True)]:
                page.set_viewport_size({'width':width,'height':650})
                page.evaluate('''({component,render,theme,failed})=>{
                  document.head.innerHTML='<link rel="stylesheet" href="ui-foundation.css"><link rel="stylesheet" href="library.css">';
                  document.documentElement.dataset.theme=theme;document.body.innerHTML=component;
                  const elements={};for(const id of ['import-dialog-title','import-source','import-preparing','import-confirmation','import-job-panel','import-actions','import-last-job'])elements[id.replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]=document.getElementById(id);
                  const job={status:failed?'failed':'completed',items:[{status:failed?'failed':'imported'}]};
                  new Function('elements','latestImportJob','t',render+';renderImportSource()')(elements,job,v=>v);
                  document.querySelector('dialog').showModal();
                }''',{'component':component,'render':render,'theme':theme,'failed':failed})
                page.wait_for_timeout(100)
                assert page.locator('#import-last-job').is_visible()==failed
                assert page.locator('#import-choose-files').is_visible()
                assert page.locator('#add-folder').is_visible()
                assert page.locator('#import-last-job').inner_text()=='查看失败项'
                assert page.locator('dialog').evaluate('(e)=>e.scrollWidth<=e.clientWidth')
                page.locator('dialog').screenshot(path=str(output/f'import-{width}-{theme}-{failed}.png'))
                results.append({'width':width,'theme':theme,'failedEntry':failed})
            browser.close()
        (output/'results.json').write_text(json.dumps(results));print(json.dumps({'passed':len(results)}))
    finally:server.shutdown();server.server_close()
if __name__=='__main__':main()
