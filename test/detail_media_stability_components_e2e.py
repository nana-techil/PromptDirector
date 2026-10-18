"""Isolated HTTP replay of production prompt components and media-stage sizing.
No extension app, account, storage, or full-page mirror is loaded.
"""
import json,os,re,threading
from pathlib import Path
from http.server import SimpleHTTPRequestHandler,ThreadingHTTPServer
from playwright.sync_api import sync_playwright
R=Path(__file__).resolve().parents[1]; O=Path(os.environ.get('PD_E2E_ARTIFACT_DIR','/tmp/pd-media-stability'));O.mkdir(parents=True,exist_ok=True)
s=(R/'extension/library.js').read_text()
def fn(n):
 a=s.index('function '+n+'('); match=re.search(r'\n(?:async )?function ',s[a+1:]); b=a+1+match.start() if match else len(s);return ('async ' if s[a-6:a]=='async ' else '')+s[a:b]
code='\n'.join(fn(n) for n in ['createPromptCopyAction','createPromptRulesAction','createMediaPromptSection','createTextAnalysisAction','createVideoAnalysisWorkspace','createVideoAnalysisTaskStatus','analyzeEntryVisualSet'])
class H(SimpleHTTPRequestHandler):
 def __init__(self,*a,**k):super().__init__(*a,directory=str(R/'extension'),**k)
 def translate_path(self,path):
  if path.startswith("/fixtures/"):return str(R/"test"/path.lstrip("/"))
  return super().translate_path(path)
 def log_message(self,*a):pass
server=ThreadingHTTPServer(('127.0.0.1',0),H);threading.Thread(target=server.serve_forever,daemon=True).start()
with sync_playwright() as p:
 b=p.chromium.launch(headless=True,channel='chromium');page=b.new_page();page.goto(f'http://127.0.0.1:{server.server_port}/prompt-panel.js')
 page.evaluate(r'''async(code)=>{
 const {createPromptPanel,promptIconButton}=await import('/prompt-panel.js');
 const {selectedSkillContentImages}=await import('/skill-contact-sheet.js');
 const aiTaskAssignments={},aiProviderRegistry={};
 const showAppDialog=async options=>{window.batchDescription=options.description;return null};
 const el=(tag,cls)=>{let e=document.createElement(tag);e.className=cls;return e};
 const textEl=(tag,cls,text)=>{let e=el(tag,cls);e.textContent=text;return e};const rawTextEl=textEl;const t=(x,v={})=>x.replace(/\{(\w+)\}/g,(_,key)=>v[key]??key);
 const detailPromptSources=(entry,asset)=>({original:entry.text,ai:''});const sharedOriginalPrompt=e=>e.text;
 const entryMediaAssets=e=>e.mediaAssets;const hasDistinctMediaPrompts=()=>window.multipleTabs===true;const originalMediaPrompt=()=>null;const detailCaseOriginalPromptText=e=>e.text;
 const option=(id,text)=>{let e=textEl('option','',text);e.value=id;return e};const assetFormatLabel=a=>a.kind;
 const visionStatusByEntry=new Map();const visualAnalysisPromptReplacement=()=>null;const createComposerAction=()=>el('div','');
 const canonicalTextAnalysisInput=e=>({text:e.text});const promptTabByAsset=new Map();const requestVideoAnalysisTaskState=()=>{};
 const videoAnalysisAssetKey=(e,a)=>e+a;const videoAnalysisTaskStateByAsset=new Map();const currentVideoReconstruction=()=>null;window.setVideoRunning=running=>{videoAnalysisTaskStateByAsset.clear();if(running)videoAnalysisTaskStateByAsset.set('casev',{status:'running'});};
 eval(code+';window.renderPrompt=createMediaPromptSection');
 document.head.innerHTML='<link rel="stylesheet" href="/ui-foundation.css"><link rel="stylesheet" href="/library.css"><link rel="stylesheet" href="/detail-workspace.css">';
 window.mount=(kind,multi,text)=>{document.body.innerHTML='<main class="detail-workspace"><div class="detail-reading"></div></main>';document.querySelector('main').style.cssText='display:block;width:min(100%,430px);height:600px;margin:auto';let media=[{id:'v',kind:'video',storageMode:'managed'},{id:'i',kind:'image',storageMode:'managed'},...(multi?[{id:'j',kind:'image',storageMode:'managed'}]:[])];document.querySelector('.detail-reading').append(window.renderPrompt({id:'case',text,mediaAssets:media},media.find(a=>a.kind===kind),{articleMedia:true}));};
 window.measure=()=>[...document.querySelector('.original-prompt-panel .prompt-section-heading').querySelectorAll('button:not([hidden])')].map(e=>({label:e.getAttribute('aria-label')||e.textContent,x:e.getBoundingClientRect().x,y:e.getBoundingClientRect().y,w:e.getBoundingClientRect().width,h:e.getBoundingClientRect().height}));
 }''',code)
 page.wait_for_timeout(100)
 res=[]
 for width,theme in [(1000,'light'),(1000,'dark'),(390,'light'),(390,'dark')]:
  page.set_viewport_size({'width':width,'height':700})
  page.evaluate('(theme)=>document.documentElement.dataset.theme=theme',theme)
  for multi in [False,True]:
   previous=None
   for kind in ['video','image','video']:
    page.evaluate('(a)=>mount(...a)',[kind,multi,'镜头描述，保持原始构图。'*100]);first=page.evaluate('measure()');page.wait_for_timeout(120)
    v=page.evaluate('measure()'); visible=[x for x in v if x['w'] and x['label']!='展开全文']
    assert [(x['x'],x['y']) for x in first if x['label']=='复制提示词']==[(x['x'],x['y']) for x in visible if x['label']=='复制提示词'],(first,visible)
    if previous:assert [(x['x'],x['y'],x['w'],x['h']) for x in previous]==[(x['x'],x['y'],x['w'],x['h']) for x in visible],(previous,visible)
    previous=visible
    assert all(x['w']==30 and x['h']==30 for x in visible),visible
    if multi:
     page.locator('.original-prompt-panel [aria-label="批量图片分析"]').click()
     assert page.evaluate('batchDescription').startswith('2 张图片 · 默认补齐 2 张'),page.evaluate('batchDescription')
    res.append({'width':width,'theme':theme,'multi':multi,'kind':kind,'buttons':v})
    page.screenshot(path=str(O/f'prompt-{width}-{theme}-{multi}-{kind}.png'))
 # Multiple source tabs shrink/scroll independently; a running video keeps its disabled action.
 page.set_viewport_size({'width':320,'height':700})
 page.evaluate("()=>{window.multipleTabs=true;mount('video',true,'描述'.repeat(300));}")
 page.wait_for_timeout(100);idle=page.evaluate('measure()')
 page.evaluate("()=>{setVideoRunning(true);mount('video',true,'描述'.repeat(300));}")
 page.wait_for_timeout(100);running=page.evaluate('measure()')
 for label in ['复制提示词','编辑原始提示词','逆推视频提示词']:
  assert [(x['x'],x['y']) for x in idle if x['label']==label]==[(x['x'],x['y']) for x in running if x['label']==label],label
 assert page.locator('.original-prompt-panel [aria-label="逆推视频提示词"]').is_disabled()
 page.screenshot(path=str(O/'prompt-320-dark-tabs-running.png'))
 assert page.evaluate("()=>document.documentElement.scrollWidth<=innerWidth"),page.evaluate("()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,items:[...document.querySelector('.original-prompt-panel .prompt-section-heading').children].map(e=>({cls:e.className,w:e.getBoundingClientRect().width,min:getComputedStyle(e).minWidth,scroll:e.scrollWidth}))})")
 page.screenshot(path=str(O/'prompt-320-dark-tabs-running.png'))
 (O/'prompt-results.json').write_text(json.dumps(res,ensure_ascii=False,indent=2))
 print('PASS: 24 production prompt switches; stable actions, no wrap; video batch action opens image-only selection confirmation')
 stage_start=s.index('  function syncMediaStageSize(')
 sizing=s[stage_start:s.index('\n  function captureDetailScrollAnchor',stage_start)]
 stage_results=[]
 for width,theme in [(1000,'light'),(1000,'dark'),(390,'light'),(390,'dark')]:
  page.set_viewport_size({'width':width,'height':700})
  page.evaluate(r'''({sizing,theme})=>{
   document.documentElement.dataset.theme=theme;
   document.body.innerHTML='<div id="detail-drawer"><div class="detail-workspace"><section class="detail-header-section"><h2 class="detail-title">横竖媒体切换</h2></section><section class="detail-visual-gallery is-immersive is-video-detail"><div class="detail-visual-stage"></div></section></div></div>';
   const shell=document.querySelector('#detail-drawer');shell.style.cssText='position:static;width:100%;height:auto;transform:none;visibility:visible;opacity:1';
   shell.firstElementChild.style.cssText='display:block;width:min(100%,700px);margin:auto';
   const gallery=document.querySelector('.detail-visual-gallery'),stage=document.querySelector('.detail-visual-stage');
   const contentAssets=[{kind:'video'},{kind:'image'}],activeIndex=0,immersive=true,elements={detailDrawer:shell},mobileLayout=matchMedia('(max-width:640px)'),rail=document.createElement('div');
   eval(sizing+';window.syncStage=syncMediaStageSize');
   window.showMedia=async (kind,portrait,loading=false)=>{
    gallery.classList.toggle('is-image-detail',kind==='image');gallery.classList.toggle('is-video-detail',kind==='video');
    const item=document.createElement('figure');item.className='detail-visual-item';
    const body=document.createElement(kind==='image'?'img':'video');body.className=kind==='image'?'detail-image':'detail-video';
    const width=portrait?600:1200,height=portrait?1000:675;
    if(!loading){if(kind==='image')body.src='data:image/svg+xml,'+encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#68819b"/><circle cx="50%" cy="50%" r="140" fill="#d4be91"/></svg>`);else{body.src=portrait?'/fixtures/detail-portrait-smoke.mp4':'/fixtures/review-workspace-smoke.mp4';body.muted=true;body.loop=true;body.controls=true;}}
    const caption=document.createElement('figcaption');caption.className='detail-visual-caption';caption.innerHTML='<span>媒体 2/4</span><nav class="detail-media-navigation"><button>上一项</button><button>下一项</button></nav>';
    item.append(body,caption);stage.replaceChildren(item);window.syncStage({kind,...(loading?{}:{width,height})});
    if(!loading){await new Promise((resolve,reject)=>{if(kind==='image'){if(body.complete)resolve();else body.onload=resolve;}else{body.onloadedmetadata=resolve;body.onerror=()=>reject(new Error('video fixture failed'));}});window.syncStage({kind,width,height});if(kind==='video'){await body.play();await new Promise(r=>setTimeout(r,80));if(body.paused)throw Error('playback failed');body.pause();}}
    return {stage:stage.getBoundingClientRect().height,caption:caption.getBoundingClientRect().y,fit:getComputedStyle(body).objectFit};
   };
  }''',{'sizing':sizing,'theme':theme})
  heights=[]
  for kind,portrait,loading in [('video',False,True),('video',False,False),('image',True,True),('image',True,False),('video',True,False),('image',False,False)]:
   geometry=page.evaluate('(args)=>showMedia(...args)',[kind,portrait,loading]);heights.append(geometry['stage'])
   assert geometry['fit']=='contain',geometry
   stage_results.append({'width':width,'theme':theme,'kind':kind,'portrait':portrait,'loading':loading,**geometry})
   page.screenshot(path=str(O/f'stage-{width}-{theme}-{kind}-{portrait}-{loading}.png'))
  assert max(heights)-min(heights)<=1,heights
 (O/'stage-results.json').write_text(json.dumps(stage_results,ensure_ascii=False,indent=2))
 print('PASS: 24 media stage states, loading/portrait/landscape heights stable; contain and native video playback retained')
 b.close()
server.shutdown()
