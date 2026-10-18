"""Public component APIs, not site names, identify media and preserve chosen scope."""
from pathlib import Path
from playwright.sync_api import expect
from e2e_support import extension_session
from generic_capture_template_details_e2e import injected
from page_capture_e2e import PNG

ROOT = Path(__file__).resolve().parents[1]
ORIGIN = 'https://wchao6891.github.io'
VIDEO = (ROOT / 'test/fixtures/review-workspace-smoke.mp4').read_bytes()
PAGE = '''<!doctype html><html><head><title>Gym reference</title><style>
body{margin:24px;font:16px sans-serif}main{max-width:700px}demo-post,demo-player{display:block}
video,demo-player{width:480px;height:270px}aside{position:absolute;left:800px;top:24px}
</style></head><body><main><demo-post><h1 slot="title">Gym reference</h1>
<demo-player src="/master.m3u8"><source src="/alternate.m3u8"><img slot="poster" src="/poster.png"><div slot="recommendation-overlay"><h3>Unrelated recommendations</h3><img src="/recommend.png"></div></demo-player>
<p slot="copy">Complete creative prompt with all six shots. Do not shorten the original.</p>
</demo-post></main><aside aria-label="Advertisement"><h2>Sidebar advertisement</h2><video src="/ad.mp4"></video></aside>
<script>
const post=document.querySelector('demo-post');post.attachShadow({mode:'open'}).innerHTML='<slot name="title"></slot><slot></slot><slot name="copy"></slot>';
const player=document.querySelector('demo-player');player.attachShadow({mode:'open'}).innerHTML='<style>video{width:480px;height:270px} .controls{position:absolute;inset:0;display:grid;place-items:center}section{position:relative;width:480px;height:270px}</style><section><video src="/original.mp4" poster="/poster.png"></video><div class="controls"><button>Play overlay</button></div></section>';
</script></body></html>'''

with extension_session('pd-component-capture-') as run:
    def serve(route):
        url = route.request.url
        if '.mp4' in url:
            route.fulfill(body=VIDEO, content_type='video/mp4')
        elif '.png' in url:
            route.fulfill(body=PNG, content_type='image/png')
        else:
            route.fulfill(body=PAGE, content_type='text/html')
    run.context.route(ORIGIN + '/**', serve)
    panel = run.open_page('collector.html')
    page = run.context.new_page()
    page.goto(ORIGIN + '/work')
    extract = panel.evaluate("async()=>String((await import('./page-capture.js')).collectPageCaptureSnapshot)")
    picker = injected('page-content-picker.js', 'pickPageContent')
    page.add_script_tag(content=picker)
    def capture(options):
        return page.evaluate('async ({source,options}) => await (0,eval)(`(${source})`)(options)', {'source': extract, 'options': options})
    # Same component works on an unknown domain and on a named post route.
    for adapters in [[], [{'id':'post-fixture','support':'generic','pageType':'post','hosts':['wchao6891.github.io'],'cardSelectors':['demo-post'],'fields':{'title':['h1']}}]]:
        snapshot = capture({'adapters':adapters,'maxCandidates':10,'maxMedia':10})
        candidate = snapshot['candidates'][0]
        assert candidate['title'] == 'Gym reference', candidate
        assert [m['url'] for m in candidate['media']] == [ORIGIN + '/original.mp4'], candidate['media']
        assert candidate['media'][0]['placement'] == 'inline', candidate
        assert {v['url'] for v in candidate['media'][0]['variants']} >= {ORIGIN+'/original.mp4',ORIGIN+'/master.m3u8',ORIGIN+'/alternate.m3u8'},candidate
        assert 'all six shots' in candidate['contentText'], candidate
        assert 'Sidebar' not in candidate['contentText'] and 'Unrelated' not in candidate['contentText'], candidate
        assert len([b for b in candidate['articleDocument']['blocks'] if b['kind']=='video']) == 1
    # Clicking a control over the player produces only the original video.
    page.evaluate('()=>{window.picked=pickPageContent();}')
    page.get_by_role('button', name='Play overlay').click()
    selected = page.evaluate('()=>window.picked')
    assert '<video' in selected['html'] and '<button' not in selected['html'], selected
    assert 'all six shots' not in selected['html'] and 'Sidebar' not in selected['html'], selected
    manual = capture({'manualContentHtml': selected['html'], 'sessionId':'picked'})['candidates'][0]
    assert [m['url'] for m in manual['media']] == [ORIGIN + '/original.mp4'], manual
    assert manual['sourceFacts']['captureScope'] == 'selection'
    # Explicitly selecting sidebar media still works; no new location ban.
    page.evaluate('()=>{window.picked=pickPageContent();}')
    page.locator('aside video').click()
    sidebar=page.evaluate('()=>window.picked')
    sidebar_capture=capture({'manualContentHtml':sidebar['html'],'sessionId':'sidebar'})['candidates'][0]
    assert [m['url'] for m in sidebar_capture['media']]==[ORIGIN+'/ad.mp4'],sidebar_capture
    # A broad chosen region keeps its actual rendered content.
    page.evaluate('()=>{window.picked=pickPageContent();}')
    page.locator('main').click(position={'x':650,'y':200})
    broad = page.evaluate('()=>window.picked')
    assert 'all six shots' in broad['html'] and 'Unrelated' not in broad['html'], broad
    # The actual extension preview and original save/readback on a clean profile.
    run.seed_storage(panel, {'entries':[], 'uiPreferences':{'theme':'dark','motion':'reduced'}, 'capturePermissionOnboarding':{'version':1,'acknowledgedAt':'2026-10-10T00:00:00Z'}})
    panel.reload(wait_until='networkidle')
    page.bring_to_front()
    panel.evaluate("()=>document.querySelector('#start-selection').click()")
    expect(page.locator('#promptdirector-content-picker')).to_be_attached()
    page.get_by_role('button', name='Play overlay').click()
    expect(panel.locator('.page-capture-item.confirmed')).to_have_count(1)
    expect(panel.locator('.page-capture-media-review-item')).to_have_count(1)
    for width in [390,1280]:
        panel.set_viewport_size({'width':width,'height':900})
        panel.screenshot(path=f'/tmp/pd-component-video-{width}.png', full_page=True, animations='disabled')
    panel.locator('#page-capture-save').click()
    expect(panel.locator('#page-capture')).to_be_hidden(timeout=30000)
    entries=panel.evaluate("async()=>(await chrome.runtime.sendMessage({type:'GET_STATE'})).entries")
    assert len(entries)==1 and len([m for m in entries[0]['mediaAssets'] if m['kind']=='video'])==1, entries
    entry=entries[0]
    assert all(m['kind']=='video' or m.get('usage')=='poster' for m in entry['mediaAssets']),entry
    result=panel.evaluate('''async id=>{const {getMediaBlob}=await import('./media-store.js');const {entries}=await chrome.runtime.sendMessage({type:'GET_STATE'});const entry=entries.find(e=>e.id===id);const blob=await getMediaBlob(entry.mediaAssets.find(m=>m.kind==='video').id);return [...new Uint8Array(await blob.arrayBuffer())];}''',entry['id'])
    assert bytes(result)==VIDEO, 'The saved original must equal the complete source file, not the poster.'
    # Ordinary HTML control overlays use the same geometric player selection.
    page.set_content('<div style="position:relative;width:480px;height:270px"><video style="width:480px;height:270px" src="/original.mp4"></video><div style="position:absolute;inset:0;display:grid;place-items:center"><button>Native player control</button></div></div>')
    page.evaluate('()=>{window.picked=pickPageContent();}')
    page.get_by_role('button',name='Native player control').click()
    native=page.evaluate('()=>window.picked')
    assert '<video' in native['html'] and '<button' not in native['html'],native
    # The same exact media selection remains reusable for a list of components.
    page.set_content('<main><article><h2>One</h2><demo-player></demo-player></article><article><h2>Two</h2><demo-player></demo-player></article></main>')
    page.evaluate("""()=>{for(const [i,host] of [...document.querySelectorAll('demo-player')].entries())host.attachShadow({mode:'open'}).innerHTML=`<video style="width:480px;height:270px" src="/clip-${i}.mp4"></video>`;}""")
    page.evaluate('()=>{window.picked=pickPageContent();}')
    page.locator('video').first.click()
    selected=page.evaluate('()=>window.picked')
    batch=capture({'selectionTemplate':selected['selectionTemplate'],'listMode':True,'maxCandidates':2,'maxMedia':10})
    assert len(batch['candidates'])==2,batch
    assert [m['url'] for c in batch['candidates'] for m in c['media']]==[ORIGIN+'/clip-0.mp4',ORIGIN+'/clip-1.mp4'],batch
    print('PASS: unknown domain + named post; nested shadow/slots; exact video/control click; broad selection; clean preview; complete original save/readback')
