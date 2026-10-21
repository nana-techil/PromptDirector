"""A dense wall must not reflow once per card when opening details changes its width."""
import json
from e2e_support import extension_session


def main():
    with extension_session('pd-dense-layout-', viewport={'width':2560,'height':1210}) as session:
        page=session.open_page('collector.html')
        page.evaluate('''async () => {
          const {createVirtualGallery}=await import('./virtual-gallery.js');
          document.body.replaceChildren();document.body.style.margin='0';
          const container=document.createElement('div');
          container.style.cssText='position:relative;width:100%;--masonry-card-min-width:140px;--masonry-gap:12px';
          document.body.append(container);
          const createCard=id=>{
            const card=document.createElement('article');card.dataset.entryId=id;
            card.style.cssText='height:auto;aspect-ratio:1;box-sizing:border-box;border:1px solid';
            card.textContent=`Case ${id}`;return card;
          };
          window.denseGallery=createVirtualGallery(container,{mode:()=> 'waterfall',createCard});
          const cards=Array.from({length:600},(_,i)=>createCard(String(i)));
          container.append(...cards);window.denseGallery.append(cards);window.denseContainer=container;
        }''')
        page.wait_for_timeout(200)
        cdp=session.context.new_cdp_session(page);cdp.send('Performance.enable')
        def metrics():
            return {v['name']:v['value'] for v in cdp.send('Performance.getMetrics')['metrics']}
        before=metrics()
        page.evaluate('''async () => {
          window.denseContainer.style.width='calc(100% - 16px)';window.denseGallery.resize();
          await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
        }''')
        after=metrics()
        result={'cards':page.locator('article').count(),'layouts':after['LayoutCount']-before['LayoutCount'],
            'layout_ms':round((after['LayoutDuration']-before['LayoutDuration'])*1000,2)}
        print(json.dumps(result),flush=True)
        assert result['cards']>200,result
        assert result['layouts']<=5,result
        geometry=page.locator('article').evaluate_all('nodes=>nodes.map(node=>({id:node.dataset.entryId,left:node.offsetLeft,top:node.offsetTop,width:node.offsetWidth,height:node.offsetHeight}))')
        columns={}
        for card in geometry:
            column=columns.setdefault(card['left'],[]);column.append(card)
        for column in columns.values():
            column.sort(key=lambda card:card['top'])
            assert all(a['top']+a['height']<=b['top'] for a,b in zip(column,column[1:])),column
        assert not session.page_errors,session.page_errors


if __name__=='__main__':main()
