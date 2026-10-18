"""Wheel to the true end of long content, without locator auto-scroll masking clips."""
import json
import os
from pathlib import Path
from playwright.sync_api import expect
from e2e_support import extension_session, base_entry


def wheel_end(page, selector, name):
    region = page.locator(selector)
    expect(region).to_be_visible()
    point = region.evaluate("""e=>{
      const r=e.getBoundingClientRect();
      const top=Math.max(0,r.top), bottom=Math.min(innerHeight,r.bottom), left=Math.max(0,r.left), right=Math.min(innerWidth,r.right);
      // Overlays (detail navigation, sticky toolbars) are siblings of the scroller, so a wheel there never
      // reaches it. Pick a visible point whose real hit target lives inside this scrollable region.
      const points=[];
      for(const fx of [0.5,0.2,0.8])for(const fy of [0.5,0.3,0.7])points.push([left+(right-left)*fx,top+(bottom-top)*fy]);
      points.push([left+Math.min(40,(right-left)/2),top+40]);
      for(const [x,y] of points){const hit=document.elementFromPoint(x,y);if(hit&&e.contains(hit))return {x,y};}
      return {x:left+Math.min(40,(right-left)/2),y:top+Math.min(40,(bottom-top)/2)};
    }""")
    page.mouse.move(point['x'],point['y'])
    for up in [True,False]:
        metrics=region.evaluate('e=>({height:e.scrollHeight,client:e.clientHeight})')
        # Use repeated wheel gestures, as a user does. The finite budget follows
        # the actual number of screenfuls; scrollTop is never assigned by a test.
        budget=(metrics['height']+metrics['client']-1)//metrics['client']+1
        for _ in range(budget):
            current=region.evaluate("e=>({top:e.scrollTop,max:e.scrollHeight-e.clientHeight,client:e.clientHeight})")
            if (current['top']<=1 if up else current['top']>=current['max']-1):break
            region.evaluate("e=>{e.dataset.wheelReceived='no';e.addEventListener('wheel',()=>e.dataset.wheelReceived='yes',{once:true,passive:true})}")
            page.mouse.wheel(0,current['client']*(-2 if up else 2))
            page.wait_for_function("s=>document.querySelector(s).dataset.wheelReceived==='yes'",arg=selector)
            page.wait_for_function("({s,before})=>document.querySelector(s).scrollTop!==before",arg={'s':selector,'before':current['top']},timeout=5000)
            page.evaluate('()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
        final=region.evaluate('e=>({top:e.scrollTop,max:e.scrollHeight-e.clientHeight})')
        assert final['top']<=1 if up else final['top']>=final['max']-1,(name,up,final)
    value=region.evaluate("""e=>{
      const leaves=[...e.querySelectorAll('button,input,textarea,select,p,strong,.prompt-read-body,.composer-session-item')]
        .filter(n=>n.checkVisibility({visibilityProperty:true})&&n.getBoundingClientRect().height>0);
      const last=leaves.sort((a,b)=>a.getBoundingClientRect().bottom-b.getBoundingClientRect().bottom).at(-1);
      if(!last)throw Error('No real content to test');
      const r=last.getBoundingClientRect();let bottom=innerHeight;
      for(let n=last.parentElement;n;n=n.parentElement){if(['hidden','clip','auto','scroll'].includes(getComputedStyle(n).overflowY))bottom=Math.min(bottom,n.getBoundingClientRect().bottom);}
      const hit=document.elementFromPoint(r.left+Math.min(20,r.width/2),r.bottom-2);
      return {scrollHeight:e.scrollHeight,clientHeight:e.clientHeight,scrollTop:e.scrollTop,lastBottom:r.bottom,visibleBottom:bottom,lastHit:hit===last||last.contains(hit),lastText:(last.textContent||last.value||last.ariaLabel||'').slice(-70)};
    }""")
    assert value['scrollHeight']>value['clientHeight'],(name,value)
    assert value['lastBottom']<=value['visibleBottom']+1 and value['lastHit'],(name,value)
    result={'surface':name,**value}
    print(json.dumps(result,ensure_ascii=False),flush=True)
    return result


def main():
    out=Path(os.environ.get('PD_E2E_ARTIFACT_DIR','/tmp/pd-content-scroll'));out.mkdir(parents=True,exist_ok=True)
    timestamp='2026-10-11T00:00:00Z'
    messages=[{'id':f'm{i}','role':'user' if i%2==0 else 'assistant','type':'chat','content':f'对话 {i}: 实际聊天正文。\n'+'\n'.join(f'第{j}段，完整内容不会因窗口变矮丢失。' for j in range(6)), 'createdAt':timestamp} for i in range(40)]
    chat={'id':'long-chat','title':'长对话滚动验收','targetType':'image','messages':messages,'updatedAt':timestamp}
    entry=base_entry('long-case','完整长正文','\n'.join(f'第{i}行完整提示词正文。' for i in range(220)),'content:prompt:image')
    projects=[{'id':f'p{i}','name':f'项目 {i:02d}','entryIds':[],'order':i} for i in range(70)]
    results=[]
    with extension_session('pd-content-scroll-',viewport={'width':1280,'height':600}) as run:
        setup=run.open_page('collector.html')
        run.seed_storage(setup,{'entries':[entry],'composerSessions':[chat],'captureAssistantDialog':{'schema':'shared-chat','activeId':'long-chat'},'organizerState':{'version':7,'collections':projects},'uiPreferences':{'locale':'zh-CN','theme':'dark','motion':'reduced'}})
        for width,height,locale,theme in [(1280,600,'zh-CN','dark'),(390,500,'en','light')]:
            setup.evaluate('async p=>chrome.storage.local.set({uiPreferences:p})',{'locale':locale,'theme':theme,'motion':'reduced'})
            composer=run.open_page('composer.html?session=long-chat',wait_until='networkidle');composer.set_viewport_size({'width':width,'height':height})
            expect(composer.locator('.composer-message')).to_have_count(40)
            results.append(wheel_end(composer,'#composer-timeline',f'composer-{width}'))
            expect(composer.locator('#composer-action')).to_be_in_viewport()
            header=composer.locator('.composer-library-exit').evaluate('''e=>{const r=e.getBoundingClientRect(),label=e.querySelector('span').getBoundingClientRect();return {left:r.left,right:r.right,labelRight:label.right,width:innerWidth}}''')
            assert 0<=header['left'] and header['right']<=header['width'] and header['labelRight']<=header['width'],header
            composer.evaluate('()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
            composer.screenshot(path=str(out/f'composer-bottom-{width}.png'));composer.close()
            panel=run.open_page('collector.html',wait_until='networkidle');panel.set_viewport_size({'width':width,'height':height})
            panel.locator('#open-capture-assistant').click()
            expect(panel.locator('#capture-assistant-chats option[value="long-chat"]')).to_have_count(1)
            panel.locator('#capture-assistant-chats').select_option('long-chat')
            expect(panel.locator('.capture-assistant-message')).to_have_count(40)
            results.append(wheel_end(panel,'.capture-assistant-conversation',f'assistant-{width}'))
            expect(panel.locator('#capture-assistant-send')).to_be_in_viewport()
            panel.screenshot(path=str(out/f'assistant-bottom-{width}.png'));panel.close()
            library=run.open_page('library.html',wait_until='networkidle');library.set_viewport_size({'width':width,'height':height})
            if width<700:
                library.locator('#toggle-filters').click()
            expect(library.locator('#sidebar-projects-body .project-row')).to_have_count(70)
            results.append(wheel_end(library,'#sidebar-projects-body',f'projects-{width}'))
            library.screenshot(path=str(out/f'projects-bottom-{width}.png'))
            if width<700: library.locator('#toggle-filters').click()
            library.locator('#open-settings').click()
            for tab in ['general','ai','shortcuts']:
                library.locator(f'[data-settings-tab="{tab}"]').click()
                results.append(wheel_end(library,f'#settings-{tab}-panel',f'settings-{tab}-{width}'))
            library.screenshot(path=str(out/f'settings-bottom-{width}.png'));library.locator('#settings-close').click()
            library.locator('.case-card[data-entry-id="long-case"]').click()
            library.get_by_role('button',name='展开全文' if locale=='zh-CN' else 'Expand full text',exact=True).first.click()
            results.append(wheel_end(library,'#detail-content',f'detail-{width}'))
            library.screenshot(path=str(out/f'detail-bottom-{width}.png'));library.close()
        result={'surfaces':results,'pageErrors':run.page_errors,'paidRequests':0}
        (out/'results.json').write_text(json.dumps(result,ensure_ascii=False,indent=2));print(json.dumps(result,ensure_ascii=False))

if __name__=='__main__':main()
