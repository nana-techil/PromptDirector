"""Sort press geometry, completed analysis and code-preview continuity in real Chromium."""
import base64
import json
import os
import time
from pathlib import Path
from playwright.sync_api import expect
from e2e_support import ai_configuration_fixture, base_entry, extension_session


def main():
    out = Path(os.environ.get('PD_E2E_ARTIFACT_DIR', '/tmp/pd-code-refresh'))
    out.mkdir(parents=True, exist_ok=True)
    html = '<style>body{margin:0;min-height:100vh;display:grid;place-items:center}button{padding:30px;background:#d2ff00;color:#181818;border:0}</style><button onclick="this.textContent=\'Clicked\'">Push me</button>'
    source = 'Interactive source\n\n```promptdirector-preview-html\n' + html + '\n```'
    entries = [base_entry(f'code-{i}', f'Motion {i:03d}', source, 'content:code-case', i) for i in range(153)]
    results, failures = {}, []
    with extension_session('pd-code-refresh-', show_scrollbars=True) as run:
        setup = run.open_page('collector.html', wait_until='networkidle')
        run.seed_storage(setup, {'entries': entries, 'dataSafetyOnboardingSeen': True,
            'uiPreferences': {'theme': 'dark', 'locale': 'zh-CN', 'motion': 'reduced'},
            **ai_configuration_fixture(providers={'deepseek': {'apiKey': 'test-fixture-key', 'consent': True,
                'models': {'textTags': 'deepseek-v4-flash'}}}, assignments={'textTags': {'providerId': 'deepseek', 'model': 'deepseek-v4-flash'}})})
        p = run.open_page('library.html', wait_until='networkidle')
        expect(p.locator('#result-count')).to_contain_text('153')
        p.locator('[data-gallery-view=list]').click()
        p.wait_for_timeout(300)
        results['sortPress'] = []
        for key in ['title', 'title', 'type', 'added']:
            button = p.locator(f'[data-sort-column={key}]')
            before = button.bounding_box()
            p.mouse.move(before['x'] + 20, before['y'] + 15)
            p.mouse.down(); p.wait_for_timeout(100)
            pressed = button.bounding_box()
            p.mouse.up(); p.wait_for_timeout(200)
            after = button.bounding_box()
            results['sortPress'].append({'key': key, 'before': before, 'pressed': pressed, 'after': after})
            if any(abs(before[k] - pressed[k]) > .5 or abs(before[k] - after[k]) > .5 for k in before):
                failures.append(f'{key} header shifts while sorting')
        p.screenshot(path=str(out / 'list-dark.png'))
        # Return to ascending title for a predictable first page.
        p.locator('[data-sort-column=title]').click()
        p.locator('[data-gallery-view=waterfall]').click()
        p.locator('.case-card[data-entry-id=code-0] .case-code-title').click()
        preview = p.locator('.code-case-view .code-case-frame')
        expect(preview).to_have_attribute('data-preview-ready', 'true')
        demo = p.frame_locator('.code-case-view .code-case-frame').frame_locator('#preview')
        demo.get_by_role('button', name='Push me').click()
        expect(demo.get_by_role('button', name='Clicked')).to_be_visible()
        preview.evaluate("f=>{window.previewLoads=0;f.addEventListener('load',()=>previewLoads++)}")
        # Record actual composited frames during mode switches and return scrolls.
        cdp = run.context.new_cdp_session(p)
        frames = []
        def captured(event):
            frames.append(base64.b64decode(event['data']))
            cdp.send('Page.screencastFrameAck', {'sessionId': event['sessionId']})
        cdp.on('Page.screencastFrame', captured)
        cdp.send('Page.startScreencast', {'format': 'png', 'everyNthFrame': 1})
        for _ in range(3):
            p.locator('#detail-mode-toggle').click(); p.wait_for_timeout(150)
            p.locator('#detail-mode-toggle').click(); p.wait_for_timeout(150)
            p.locator('.detail-content').evaluate('e=>e.scrollTop=1000'); p.wait_for_timeout(150)
            p.locator('.detail-content').evaluate('e=>e.scrollTop=0'); p.wait_for_timeout(150)
            expect(demo.get_by_role('button', name='Clicked')).to_be_visible()
        cdp.send('Page.stopScreencast'); cdp.detach()
        results['returnLoads'] = p.evaluate('previewLoads')
        assert results['returnLoads'] == 0
        theme = p.locator('#detail-drawer').evaluate('e=>getComputedStyle(e).backgroundColor')
        backing = p.frame_locator('.code-case-view .code-case-frame').locator('html').evaluate('e=>({html:getComputedStyle(e).backgroundColor,body:getComputedStyle(document.body).backgroundColor,frame:getComputedStyle(document.querySelector("iframe")).backgroundColor})')
        results['backing'] = backing
        if any(color != theme for color in backing.values()): failures.append('Nested preview backing canvas does not follow theme')
        results['flashFrames'] = []
        frame_dir = out / 'frames'; frame_dir.mkdir(exist_ok=True)
        for index, raw in enumerate(frames):
            (frame_dir / f'{index:03d}.png').write_bytes(raw)
            bright = p.evaluate("""async data=>{
              const blob=await (await fetch('data:image/png;base64,'+data)).blob();
              const bitmap=await createImageBitmap(blob), canvas=new OffscreenCanvas(230,240), ctx=canvas.getContext('2d');
              ctx.drawImage(bitmap,270,110,230,240,0,0,230,240);bitmap.close();
              const pixels=ctx.getImageData(0,0,230,240).data;let bright=0;
              for(let i=0;i<pixels.length;i+=4)if(Math.min(pixels[i],pixels[i+1],pixels[i+2])>230)bright++;
              return bright/(230*240);
            }""", base64.b64encode(raw).decode())
            if bright > .25: results['flashFrames'].append(index)
        results['capturedFrames'] = len(frames)
        assert frames, 'Screencast must capture transitions'
        if results['flashFrames']: failures.append('White flash in dark preview transitions')
        # Replace only the external model response; use actual button, validation,
        # background write and storage-change refresh. No network model request.
        p.evaluate('''()=>{const real=fetch;window.fixtureCalls=0;window.fetch=async(...args)=>{
          if(!String(args[0]).includes('api.deepseek.com'))return real(...args);
          fixtureCalls++;return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify({tags:[{g:'style.render',t:'实时测试标签'}]})}}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}),{status:200,headers:{'Content-Type':'application/json'}})}}''')
        p.locator('[aria-label="分析文字标签"]').click()
        p.wait_for_function('()=>fixtureCalls===1')
        expect(p.locator('[aria-label="分析文字标签"]')).to_be_enabled()
        stored = setup.evaluate("async()=>(await chrome.runtime.sendMessage({type:'GET_STATE'})).entries")
        entry = next(e for e in stored if e['id'] == 'code-0')
        assert entry['facetAssignments'] and entry['text'] == source
        assert not next(e for e in stored if e['id'] == 'code-1').get('facetAssignments')
        results['visibleTags'] = p.locator('.attribute-section').all_text_contents()
        if not any('实时测试标签' in text for text in results['visibleTags']): failures.append('Completed code analysis needs refresh to display tags')
        expect(demo.get_by_role('button', name='Clicked')).to_be_visible()
        p.screenshot(path=str(out / 'analysis-dark.png'))
        p.locator('#detail-close').click()
        # A normal reading pause prepares the next screen, but never the full wall.
        p.mouse.move(900, 500); p.wait_for_timeout(1000)
        results['preparedNeighbours'] = p.locator('#case-list .code-case-frame').evaluate_all('fs=>fs.filter(f=>{const r=f.closest(".case-card").getBoundingClientRect();return r.top>=innerHeight&&r.top<innerHeight*2}).map(f=>({ready:f.dataset.previewPrepared,hidden:f.hidden}))')
        if not results['preparedNeighbours'] or any(f.get('ready') != 'true' or not f['hidden'] for f in results['preparedNeighbours']):
            failures.append('Next screen is not prepared and paused before scrolling')
        start = time.monotonic(); p.mouse.wheel(0, 900); p.wait_for_timeout(50)
        p.wait_for_function('()=>[...document.querySelectorAll("#case-list .code-case-frame")].filter(f=>{const r=f.closest(".case-card").getBoundingClientRect();return r.bottom>70&&r.top<innerHeight}).every(f=>f.dataset.previewReady==="true")')
        results['scrollReadyMs'] = round((time.monotonic() - start) * 1000, 1)
        assert p.locator('#case-list .code-case-frame[src]').count() < len(entries)
        for _ in range(8): p.mouse.wheel(0, 900); p.wait_for_timeout(80)
        assert p.locator('#case-list .code-case-frame[src]').evaluate_all('fs=>fs.every(f=>{const r=f.closest(".case-card").getBoundingClientRect();return r.bottom>=-innerHeight*2&&r.top<=innerHeight*3})')
        p.locator('#search-input').fill('Motion 000')
        p.locator('.case-card[data-entry-id=code-0] .case-code-title').click()
        for width, height in [(1280, 900), (390, 844)]:
            p.set_viewport_size({'width': width, 'height': height})
            p.evaluate("async()=>(await import('./i18n.js')).initializeUi({theme:'light',locale:'zh-CN',motion:'reduced'})")
            expect(preview).to_have_attribute('data-preview-ready', 'true')
            expect(p.frame_locator('.code-case-view .code-case-frame').locator('html')).to_have_css('background-color', p.locator('#detail-drawer').evaluate('e=>getComputedStyle(e).backgroundColor'))
            p.wait_for_timeout(150)
            p.locator('.detail-content').evaluate('e=>e.scrollTop=0')
            p.screenshot(path=str(out / f'code-light-{width}.png'))
            assert p.locator('.detail-content').evaluate('e=>e.scrollWidth<=e.clientWidth')
        results['errors'] = run.page_errors
        (out / 'results.json').write_text(json.dumps(results, ensure_ascii=False, indent=2))
        print(json.dumps(results, ensure_ascii=False), flush=True)
        assert not run.page_errors, run.page_errors
        assert not failures, failures
        print('PASS: stationary sort headers, live saved tags, themed transition frames, prepared neighbours and bounded release')


if __name__ == '__main__':
    main()
