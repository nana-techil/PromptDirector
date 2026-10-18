"""Four production diagnostic controls on an isolated HTTP component fixture.
No installed extension, full application, account, or model request is loaded.
"""
import json
import os
import re
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]

def between(text, start, end):
    offset = text.index(start)
    return text[offset:text.index(end, offset)]

def main():
    output = Path(os.environ.get('PD_E2E_ARTIFACT_DIR', '/tmp/pd-diagnostic-controls'))
    output.mkdir(parents=True, exist_ok=True)
    library = (ROOT / 'extension/library.html').read_text()
    composer = (ROOT / 'extension/composer.html').read_text()
    library_js = (ROOT / 'extension/library.js').read_text()
    composer_js = (ROOT / 'extension/composer-page.js').read_text()
    assistant_js = (ROOT / 'extension/collector-capture-assistant.js').read_text()
    parts = {
        'settings': between(library[library.index('<section id="settings-general-panel"'):], '<section class="setting-section appearance-grid">', '</section>') + '</section>',
        'options': between(composer, '<details id="composer-options"', '</details>') + '</details>',
        'analysis': re.search(r'<button id="copy-analysis-diagnostics".*?</button>', library).group(),
        'settingsBind': between(library_js, 'bindDiagnosticControls({', '\nbindAppearanceControls'),
        'composerBind': between(composer_js, 'bindDiagnosticControls({', '\n\nlet entries'),
        'assistantBuild': between(assistant_js, "  const contextRow = node('div'", "  const conversation = node('div'"),
    }
    class Handler(SimpleHTTPRequestHandler):
        def __init__(self, *args, **kwargs): super().__init__(*args, directory=str(ROOT/'extension'), **kwargs)
        def log_message(self, *_): pass
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True, channel=os.environ.get('PROMPTDIRECTOR_E2E_CHANNEL', 'chromium'))
            page = browser.new_page()
            page.goto(f'http://127.0.0.1:{server.server_port}/ui-foundation.css')
            page.evaluate('''async parts => {
              const {bindDiagnosticControls} = await import('/diagnostic-controls.js');
              const {normalizeUiPreferences} = await import('/preferences.js');
              const listeners=new Set();
              window.saved=normalizeUiPreferences({theme:'light',locale:'zh-CN',galleryZoom:76});
              window.chrome={storage:{local:{get:async()=>({uiPreferences:window.saved})},onChanged:{addListener:f=>listeners.add(f),removeListener:f=>listeners.delete(f)}},runtime:{sendMessage:async msg=>{
                if(window.failSave)return {ok:false,message:'保存失败'};
                const oldValue=window.saved;window.saved=normalizeUiPreferences({...oldValue,...msg.preferences});
                localStorage.setItem('fixturePreferences',JSON.stringify(window.saved));
                for(const f of listeners)f({uiPreferences:{oldValue,newValue:window.saved}},'local');
                return {ok:true,uiPreferences:window.saved};
              }}};
              const {updateUiPreferences}=await import('/i18n.js');
              document.head.innerHTML='<link rel="stylesheet" href="/ui-foundation.css"><link rel="stylesheet" href="/library.css"><link rel="stylesheet" href="/collector.css"><link rel="stylesheet" href="/composer-page.css"><style>body{display:block;padding:20px;margin:0;background:var(--paper)}#fixture{display:grid;gap:28px;max-width:600px;margin:auto}.composer-options{position:relative;justify-self:end}.composer-options-panel{position:relative;inset:auto}.capture-assistant-context-row{padding:10px}section{min-width:0}</style>';
              document.body.innerHTML='<div id="fixture"><section id="settings-component">'+parts.settings+'<p id="library-settings-feedback" role="status"></p></section><section id="assistant-component"></section><section id="analysis-component">'+parts.analysis+'</section>'+parts.options+'<dialog id="composer-assembly-dialog">本次装配</dialog></div>';
              document.querySelector('#composer-options').open=true;
              const elements=Object.fromEntries([...document.querySelectorAll('[id]')].map(e=>[e.id.replace(/-([a-z])/g,(_,c)=>c.toUpperCase()),e]));
              const transientFeedback={show:(el,message)=>{el.textContent=message;}};
              new Function('bindDiagnosticControls','elements','uiPreferences','updateUiPreferences','transientFeedback','translateUiMessage',parts.settingsBind)(bindDiagnosticControls,elements,window.saved,updateUiPreferences,transientFeedback,v=>v);
              window.bindComposer=()=>new Function('bindDiagnosticControls','elements','uiPreferences',parts.composerBind)(bindDiagnosticControls,elements,JSON.parse(localStorage.getItem('fixturePreferences')||'{}'));
              window.bindComposer();
              const node=(tag,cls)=>{const el=document.createElement(tag);el.className=cls;return el;};
              const button=(text,cls)=>{const el=node('button',cls);el.textContent=text;return el;};
              const row=new Function('node','button','bindDiagnosticControls','t','feedback',parts.assistantBuild+'return contextRow;')(node,button,bindDiagnosticControls,v=>v,()=>{});
              document.querySelector('#assistant-component').append(row);
              elements.composerAssemblyOpen.onclick=()=>elements.composerAssemblyDialog.showModal();
            }''', parts)
            diagnostic_ids=['capture-assistant-diagnostic','composer-diagnostic-export','composer-assembly-open','copy-analysis-diagnostics']
            for key in diagnostic_ids: assert page.locator('#'+key).is_hidden(), key
            results=[]
            for width, theme in [(1280,'light'),(390,'dark')]:
                page.set_viewport_size({'width':width,'height':1000})
                page.evaluate('theme=>document.documentElement.dataset.theme=theme',theme)
                page.locator('#ui-diagnostics').check()
                for key in diagnostic_ids: assert page.locator('#'+key).is_visible(), key
                assert page.evaluate('window.saved.galleryZoom')==76
                page.evaluate('window.bindComposer()')
                assert page.locator('#composer-diagnostic-export').is_visible()
                page.screenshot(path=str(output/f'enabled-{width}-{theme}.png'), animations='disabled')
                page.locator('#composer-assembly-open').click()
                assert page.locator('#composer-assembly-dialog').is_visible()
                # A separate already-open settings surface updates the shared preference.
                page.evaluate("async()=>{const {updateUiPreferences}=await import('/i18n.js');await updateUiPreferences({diagnosticsEnabled:false});}")
                for key in diagnostic_ids: assert page.locator('#'+key).is_hidden(), key
                assert page.locator('#composer-assembly-dialog').is_hidden()
                assert not page.locator('#ui-diagnostics').is_checked()
                page.screenshot(path=str(output/f'default-{width}-{theme}.png'), animations='disabled')
                results.append({'width':width,'theme':theme,'entries':len(diagnostic_ids),'defaultHidden':True,'enabledVisible':True,'closedDialog':True,'reopenPersisted':True})
            page.evaluate('window.failSave=true')
            page.locator('#ui-diagnostics').click()
            page.wait_for_function("document.querySelector('#library-settings-feedback').textContent==='保存失败'")
            assert not page.locator('#ui-diagnostics').is_checked()
            page.screenshot(path=str(output/'save-failure-390-dark.png'), animations='disabled')
            (output/'results.json').write_text(json.dumps(results,ensure_ascii=False,indent=2))
            browser.close()
            print(json.dumps({'passed':len(results),'failedSaveRestored':True,'artifacts':str(output)}))
    finally: server.shutdown(); server.server_close()

if __name__=='__main__': main()
