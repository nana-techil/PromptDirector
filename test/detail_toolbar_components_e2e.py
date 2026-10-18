"""HTTP-only presentation fixture for media-toolbar geometry and shared icons.
No extension page, account, storage, or library application is loaded.
"""
import json
import os
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]

def main():
    output = Path(os.environ.get('PD_E2E_ARTIFACT_DIR', '/tmp/pd-detail-components'))
    output.mkdir(parents=True, exist_ok=True)
    class Handler(SimpleHTTPRequestHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=str(ROOT / 'extension'), **kwargs)
        def log_message(self, *_):
            pass
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True, channel=os.environ.get('PROMPTDIRECTOR_E2E_CHANNEL', 'chromium'))
            page = browser.new_page()
            page.goto(f'http://127.0.0.1:{server.server_port}/detail-workspace.js')
            page.evaluate("""async () => {
              const module = await import('/detail-workspace.js'); window.arrange = module.arrangeDetailWorkspace;
              document.head.innerHTML = '<link rel="stylesheet" href="/ui-foundation.css"><link rel="stylesheet" href="/library.css"><link rel="stylesheet" href="/detail-workspace.css">';
            }""")
            baseline = os.environ.get('PD_DETAIL_BASELINE')
            if baseline:
                before = Path(baseline)
                page.evaluate("""({js, css}) => {
                  const script=document.createElement('script');script.textContent=js.replaceAll('export function ', 'function ');document.head.append(script);window.arrange=arrangeDetailWorkspace;
                  document.querySelector('link[href="/detail-workspace.css"]').remove();const style=document.createElement('style');style.textContent=css;document.head.append(style);
                }""", {'js': (before / 'detail-workspace.before.js').read_text(), 'css': (before / 'detail-workspace.before.css').read_text()})
            results = []
            for width, theme, multi, kind, review in [(1000, 'dark', False, 'image', False), (1000, 'light', True, 'video', False), (390, 'dark', True, 'image', False), (390, 'light', False, 'image', False), (1000, 'dark', True, 'video', True), (390, 'light', True, 'video', True)]:
                page.set_viewport_size({'width': width, 'height': 620})
                result = page.evaluate("""({theme,multi,kind,review}) => {
                  document.documentElement.dataset.theme=theme;
                  document.body.innerHTML=`<div id="detail-drawer" class="${review?'is-reviewing':''}"><div class="has-primary-media"><div class="detail-primary"><section class="detail-visual-gallery is-${kind}-detail"><div style="height:340px;display:grid;place-items:center;background:var(--card)" id="media"><div style="width:220px;height:310px;background:linear-gradient(#9a160e,#191217)"></div></div><div class="detail-visual-caption ${multi?'has-media-navigation':''}"><span>PNG</span>${multi?'<nav class="detail-media-navigation"><button aria-label="Previous">‹</button><span>媒体 12/120</span><button aria-label="Next">›</button></nav>':''}<div class="detail-media-tools"><div class="detail-visual-actions"><button class="icon-button" aria-label="Notes">N</button><button class="icon-button" aria-label="Download">↓</button><button class="icon-button" aria-label="Delete">×</button></div></div></div></section><div class="detail-body"><section class="detail-header-section"><div class="detail-palette">${['#511411','#b1190f','#d7491e','#b7a18e','#261c24'].map(c=>`<button class="swatch" style="--palette-color:${c}"></button>`).join('')}</div></section></div></div></div></div>`;
                  window.arrange(document.querySelector('.detail-body'));
                  // Fixture constrains only the shell; real toolbar styles and arrangement run unchanged.
                  const style=document.createElement('style');style.textContent='#detail-drawer{position:static;width:100%;height:auto;visibility:visible;opacity:1;transform:none}.detail-primary.detail-workspace{display:block!important}.detail-visual-gallery{display:block!important;height:auto!important}.detail-workspace>.detail-header-section,.detail-body{display:none!important}.detail-visual-caption{position:static!important}';document.head.append(style);
                  return true;
                }""", {'theme': theme, 'multi': multi, 'kind': kind, 'review': review})
                page.wait_for_timeout(100)
                geometry = page.evaluate("""() => {
                  const box=e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height}};
                  const palette=box(document.querySelector('.detail-palette')), media=box(document.querySelector('#media'));
                  const tools=document.querySelector('.detail-media-tools'),context=document.querySelector('.detail-media-context');
                  const actions=box(tools);return {palette,media,actions,delta:Math.abs(palette.x+palette.w/2-media.x-media.w/2),context:context?box(context):null,toolsReachable:tools.scrollWidth>=tools.clientWidth};
                }""")
                page.screenshot(path=str(output / f'toolbar-{width}-{theme}-{multi}-{kind}-{review}.png'))
                results.append(geometry)
                assert geometry['delta'] <= 1, geometry
                assert geometry['palette']['x'] + geometry['palette']['w'] <= geometry['actions']['x'] + 1, geometry
                assert geometry['context']['x'] + geometry['context']['w'] <= geometry['palette']['x'] + 1, geometry
                reachable = page.evaluate('''() => {
                  const context=document.querySelector('.detail-media-context');context.scrollLeft=context.scrollWidth;
                  const next=context.querySelector('[aria-label=Next]');
                  if(!next)return true;
                  next.focus();const a=next.getBoundingClientRect(),b=context.getBoundingClientRect();return a.left>=b.left-1&&a.right<=b.right+1;
                }''')
                assert reachable, 'Media navigation must remain reachable in the single toolbar row'
            # Inspect actual shared symbols at a large scale, without mounting application code.
            page.evaluate("""async()=>{const {createUiIcon}=await import('/ui-icons.js');document.body.replaceChildren();for(const name of ['fullscreen','exit-fullscreen']){const button=document.createElement('button');button.title=name;button.append(createUiIcon(name));document.body.append(button);}}""")
            page.screenshot(path=str(output / 'review-icons.png'))
            (output / 'geometry.json').write_text(json.dumps(results, indent=2))
            browser.close()
            print(json.dumps({'passed':len(results),'artifacts':str(output)}))
    finally:
        server.shutdown();server.server_close()
if __name__ == '__main__':
    main()
