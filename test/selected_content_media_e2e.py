"""Replay actual selection/media modules on HTTP, without an extension or user library."""
import base64
import json
import os
import struct
import threading
import zlib
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]


def main():
    evidence = Path(os.environ['PD_SELECTION_EVIDENCE']) if os.environ.get('PD_SELECTION_EVIDENCE') else None
    baseline = Path(os.environ['PD_SELECTION_BASELINE']) if os.environ.get('PD_SELECTION_BASELINE') else None
    fixed = not baseline
    results = []
    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))
    png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 200, 180, 8, 2, 0, 0, 0))
    png += chunk(b'IDAT', zlib.compress((b'\x00' + bytes([255, 0, 0]) * 200) * 180)) + chunk(b'IEND', b'')

    class Handler(SimpleHTTPRequestHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=str(ROOT / 'extension'), **kwargs)
        def do_GET(self):
            source = baseline / self.path.lstrip('/') if baseline else None
            if self.path == '/red.png':
                content, mime = png, 'image/png'
            elif self.path == '/frame':
                content, mime = b'<body style="margin:0;background:rgb(0,0,255)">Embedded work</body>', 'text/html'
            elif source and source.is_file():
                content, mime = source.read_bytes(), 'text/javascript'
            else:
                return super().do_GET()
            self.send_response(200); self.send_header('Content-Type', mime); self.end_headers(); self.wfile.write(content)
        def log_message(self, *_):
            pass

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True, channel=os.environ.get('PROMPTDIRECTOR_E2E_CHANNEL', 'chromium'))
            page = browser.new_page(viewport={'width': 900, 'height': 650})
            origin = f'http://127.0.0.1:{server.server_port}'
            page.goto(origin + '/page-content-picker.js')
            page.evaluate("""async () => {
              const picker = await import('/page-content-picker.js');
              const capture = await import('/page-capture.js');
              window.pick = picker.pickPageContent; window.validateRects = picker.validateSelectedCaptureRectangles;
              window.collect = capture.collectPageCaptureSnapshot; window.normalizeBatch = capture.normalizePageCaptureBatch;
              window.resolveImage = capture.resolvePageCaptureImage;
            }""")
            examples = [
                ('image', '<img id="target" src="/red.png" width="200" height="180">'),
                ('video', '<video id="target" src="/movie.mp4" width="200" height="180"></video>'),
                ('canvas', '<canvas id="target" width="200" height="180"></canvas>'),
                ('css-background', '<div id="target" style="width:200px;height:180px;background-image:url(/red.png)"></div>'),
                ('iframe', '<iframe id="target" src="/frame" width="200" height="180"></iframe>'),
                ('mixed', '<section id="target"><p>Keep the complete original text.</p><img src="/red.png" width="200" height="180"><iframe src="/frame" width="200" height="180"></iframe></section>'),
                ('mixed-offscreen', '<section id="target"><p>Keep the complete original text.</p><img src="/red.png" width="200" height="180"><iframe src="/frame" width="200" height="180" style="display:block;margin-top:900px"></iframe></section>'),
                ('tainted-canvas', '<canvas id="target" width="200" height="180"></canvas>'),
            ]
            if fixed:
                background = (ROOT / 'extension/background.js').read_text()
                helper = background[background.index('async function addVisiblePageCaptureFallbacks('):background.index('async function capturePageCaptureViewportFallbacks(')]
                page.evaluate("""source => {
                  window.screenshots = 0; window.failCrop = false; window.moveAfterScreenshot = false; window.switched = false;
                  window.validateSelectedCaptureRectangles = window.validateRects;
                  window.ensureOffscreenDocument = async () => {};
                  window.PAGE_CAPTURE_LIMITS = {maxInlinePixelDataCharacters:32*1024*1024};
                  window.chrome = { tabs: { query: async () => [{id:window.switched ? 2 : 1}], captureVisibleTab: async () => {
                    window.screenshots++;
                    if(window.switchAfterScreenshot) window.switched=true;
                    if(window.moveAfterScreenshot) document.querySelector('#target').style.marginLeft='40px';
                    return window.capturePixels;
                  }}, scripting: {executeScript: async ({func,args}) => [{result:func(...args)}]}, runtime: {
                    sendMessage: async message => {
                      if(window.failCrop) return {ok:false,message:'Synthetic crop failure'};
                      const image = new Image(); image.src = message.dataUrl; await image.decode();
                      return {ok:true,dataUrls:message.selections.map(selection=>{
                        const canvas=document.createElement('canvas'); canvas.width=selection.rect.width; canvas.height=selection.rect.height;
                        canvas.getContext('2d').drawImage(image,selection.rect.x,selection.rect.y,selection.rect.width,selection.rect.height,0,0,canvas.width,canvas.height);
                        return canvas.toDataURL('image/png');
                      })};
                    }
                  }};
                  window.completePixels = new Function(source + '; return addVisiblePageCaptureFallbacks')();
                }""", helper)
            for name, html in examples:
                page.evaluate("""async ({html,tainted}) => {
                  document.body.innerHTML=html; document.body.style.margin='8px';
                  await Promise.all([...document.images].map(image=>image.decode().catch(()=>{})));
                  const canvas=document.querySelector('canvas');
                  if(canvas){
                    if(tainted){const image=new Image();image.src=location.origin.replace('127.0.0.1','localhost')+'/red.png';await image.decode();canvas.getContext('2d').drawImage(image,0,0);}
                    else {canvas.getContext('2d').fillStyle='red';canvas.getContext('2d').fillRect(0,0,200,180);window.originalPixels=canvas.toDataURL('image/webp',.92);}
                  }
                  window.pickResult=null;pick({timeoutMs:1000}).then(result=>window.pickResult=result);
                }""", {'html': html, 'tainted': name == 'tainted-canvas'})
                page.locator('#target').dispatch_event('click', {'clientX': 10, 'clientY': 10})
                page.wait_for_function('window.pickResult !== null')
                if name in ['iframe', 'mixed', 'mixed-offscreen']:
                    page.wait_for_function("[...document.querySelectorAll('iframe')].every(frame=>frame.contentDocument?.location.pathname==='/frame' && frame.contentDocument.readyState==='complete')")
                page.evaluate("""async () => {
                  const picked=window.pickResult;
                  window.snapshot=await collect({manualContentHtml:picked.html,selectedContentMarker:picked.selectedContentMarker,
                    selectionTemplate:picked.selectionTemplate,sessionId:'selection-replay'});
                }""")
                summary = page.evaluate("""() => ({html:pickResult.html,error:snapshot.captureError,notice:snapshot.error,
                  candidates:snapshot.candidates?.map(candidate=>({text:candidate.contentText,media:candidate.media.map(media=>({
                    kind:media.kind,url:media.url,method:media.captureMethod,hasFallback:!!media.fallbackRect,
                    pixelsMatch:media.dataUrl?media.dataUrl===window.originalPixels:null
                  }))}))})""")
                results.append({'name': name, 'fixture': html, 'result': summary})
                if not fixed:
                    print(json.dumps(results[-1], ensure_ascii=False)); continue
                assert not summary.get('error'), (name, summary)
                media = summary['candidates'][0]['media']
                if name in ['image', 'css-background']:
                    assert media[0]['url'] == origin + '/red.png', (name, media)
                if name == 'video':
                    assert media[0]['kind'] == 'video' and media[0]['url'] == origin + '/movie.mp4'
                if name == 'canvas':
                    assert media[0]['pixelsMatch'] and media[0]['method'] == 'pixel-fallback'
                if name == 'mixed-offscreen':
                    assert '不在可见区域' in summary['notice'], summary
                    assert summary['candidates'][0]['text'] == 'Keep the complete original text.' and len(media) == 1 and media[0]['url'] == origin + '/red.png', summary
                if name in ['iframe', 'tainted-canvas']:
                    assert media[0]['hasFallback'] and media[0]['method'] == 'pixel-fallback' and not media[0]['url']
                source_pixels = page.screenshot()
                page.evaluate('value=>window.capturePixels=value', 'data:image/png;base64,' + base64.b64encode(source_pixels).decode())
                if evidence and name in ['canvas', 'iframe']:
                    evidence.mkdir(parents=True, exist_ok=True)
                    (evidence / f'{name}-source.png').write_bytes(source_pixels)
                completed = page.evaluate("""async () => {
                  const before=screenshots;
                  window.completed=await completePixels(snapshot,{id:1,windowId:1},{selectedOnly:true});
                  window.normalized=normalizeBatch(completed);
                  return {screenshots:screenshots-before,media:normalized.candidates.flatMap(candidate=>candidate.media).map(media=>({
                    kind:media.kind,url:media.url,method:media.captureMethod,hasPixels:!!media.dataUrl
                  }))};
                }""")
                assert completed['media'], (name, completed)
                if evidence and name in ['canvas', 'iframe']:
                    saved = page.evaluate('normalized.candidates[0].media[0].dataUrl')
                    extension = 'webp' if saved.startswith('data:image/webp') else 'png'
                    (evidence / f'{name}-captured.{extension}').write_bytes(base64.b64decode(saved.split(',', 1)[1]))
                assert completed['screenshots'] == (1 if name in ['iframe', 'mixed', 'tainted-canvas'] else 0), (name, completed)
                if name in ['iframe', 'tainted-canvas']:
                    assert completed['media'][0]['hasPixels']
                    pixel = page.evaluate("""async()=>{const image=new Image();image.src=normalized.candidates[0].media[0].dataUrl;await image.decode();const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;const context=canvas.getContext('2d');context.drawImage(image,0,0);return [...context.getImageData(Math.floor(canvas.width/2),Math.floor(canvas.height/2),1,1).data];}""")
                    color = 2 if name == 'iframe' else 0
                    assert pixel[color] > 240 and pixel[1] < 20 and pixel[2 - color] < 20, (name, pixel)
                    results[-1]['savedPixel'] = pixel
                    method = page.evaluate("""async()=>{const result=await resolveImage(normalized.candidates[0].media[0],{
                      fetchMedia:()=>{throw Error('Pixels must not become an invented original URL');},decodeDataUrl:async url=>(await fetch(url)).blob()
                    });return {method:result.captureMethod,fallback:result.usedPixelFallback};}""")
                    assert method == {'method': 'pixel-fallback', 'fallback': True}, method
                if name == 'image':
                    resolved = page.evaluate("""async () => {
                      const media=normalized.candidates[0].media[0];
                      const result=await resolveImage(media,{fetchMedia:async url=>(await fetch(url)).blob(),decodeDataUrl:()=>{throw Error('Original must win');}});
                      return {method:result.captureMethod,fallback:result.usedPixelFallback,size:result.blob.size};
                    }""")
                    assert resolved == {'method': 'source', 'fallback': False, 'size': len(png)}, resolved
                if name == 'mixed':
                    page.evaluate("window.failCrop=true;document.querySelector('iframe').setAttribute('data-promptdirector-selected-pixels',snapshot.candidates[0].media.find(media=>media.captureMethod==='pixel-fallback').fallbackRect.marker)")
                    partial = page.evaluate("""async()=>{const result=await completePixels(snapshot,{id:1,windowId:1},{selectedOnly:true});return {error:result.error,text:result.candidates[0].contentText,media:result.candidates[0].media.map(media=>media.url)};}""")
                    assert partial['error'] == 'Synthetic crop failure' and partial['text'] == 'Keep the complete original text.' and partial['media'] == [origin + '/red.png'], partial
                    page.evaluate('window.failCrop=false')
                    results[-1]['partialFailure'] = partial
                if name == 'tainted-canvas':
                    page.evaluate("window.moveAfterScreenshot=true;document.querySelector('canvas').setAttribute('data-promptdirector-selected-pixels',snapshot.candidates[0].media[0].fallbackRect.marker)")
                    moved = page.evaluate("""async()=>{try{await completePixels(snapshot,{id:1,windowId:1},{selectedOnly:true});return '';}catch(error){return error.message;}}""")
                    assert '变化' in moved, moved
                    results[-1]['movedSelection'] = moved
                    page.evaluate("window.moveAfterScreenshot=false;window.switchAfterScreenshot=true;document.querySelector('canvas').style.marginLeft='0px';document.querySelector('canvas').setAttribute('data-promptdirector-selected-pixels',snapshot.candidates[0].media[0].fallbackRect.marker)")
                    switched = page.evaluate("""async()=>{try{await completePixels(snapshot,{id:1,windowId:1},{selectedOnly:true});return '';}catch(error){return error.message;}}""")
                    assert '切换' in switched, switched
                    results[-1]['switchedTab'] = switched
                results[-1]['completed'] = completed
                print('PASS:', name)
            browser.close()
    finally:
        server.shutdown(); server.server_close()
        if evidence:
            evidence.mkdir(parents=True, exist_ok=True)
            (evidence / ('before.json' if baseline else 'after.json')).write_text(json.dumps(results, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
