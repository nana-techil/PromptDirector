"""Settings complete only missing text in place, without inheriting scoped media UI."""
import os
from pathlib import Path
from playwright.sync_api import expect
from e2e_support import extension_session, base_entry, ai_configuration_fixture, wait_for_async_condition


def shot(page,path):
    page.evaluate('()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')
    page.screenshot(path=str(path),animations='disabled')


def main():
    out=Path(os.environ.get('PD_E2E_ARTIFACT_DIR','/tmp/pd-settings-inline'));out.mkdir(parents=True,exist_ok=True)
    entries=[base_entry('one','项目内未分析','项目内完整原词','content:prompt:image'),base_entry('two','项目外未分析','项目外完整原词','content:prompt:video'),base_entry('done','已分析','已分析原词保持','content:prompt:image')]
    entries[0]['customLabels']=['人工标签保持']
    with extension_session('pd-settings-inline-') as run:
        p=run.open_page('collector.html',wait_until='networkidle')
        run.seed_storage(p,{'entries':entries,'dataSafetyOnboardingSeen':True,'uiPreferences':{'locale':'zh-CN','theme':'dark','motion':'reduced'},'organizerState':{'version':7,'collections':[{'id':'p','name':'仅此项目','entryIds':['one','done']}]},**ai_configuration_fixture(providers={'deepseek':{'apiKey':'fixture-key','consent':True,'models':{'textTags':'deepseek-v4-flash'}}},assignments={'textTags':{'providerId':'deepseek','model':'deepseek-v4-flash'}})})
        p.evaluate('''async()=>{const s=await chrome.runtime.sendMessage({type:'GET_STATE'});const group=s.facetCatalog.nodes.find(n=>!n.parentId&&n.status!=='archived');const done=s.entries.find(e=>e.id==='done');done.facetAssignments=[{nodeId:group.id,source:'deepseek_text'}];done.analysisMeta={textRevision:1};await(await import('./library-storage.js')).getLibraryStorage().set({entries:s.entries});}''')
        worker=run.context.service_workers[0]
        worker.evaluate('''()=>{globalThis.inlineCalls=0;const real=fetch;globalThis.fetch=async(...a)=>{if(!String(a[0]).includes('api.deepseek.com'))return real(...a);if(!String(a[0]).includes('chat/completions'))return new Response(JSON.stringify({data:[]}));inlineCalls++;if(inlineCalls===1)await new Promise(r=>globalThis.finishInline=r);const s=await chrome.storage.local.get('facetCatalog');return new Response(JSON.stringify({model:'deepseek-v4-flash',choices:[{finish_reason:'stop',message:{content:JSON.stringify({tags:s.facetCatalog.nodes.filter(n=>!n.parentId&&n.status!=='archived').slice(0,6).map(n=>({g:n.id,t:''}))})}}],usage:{prompt_tokens:20,completion_tokens:4,total_tokens:24}}),{status:200,headers:{'Content-Type':'application/json'}})};}''')
        p=run.open_page('library.html',wait_until='networkidle')
        # Real project entry retains scoped text/image/video capabilities.
        menu=p.locator('.project-row[data-collection-id="p"] .project-menu');menu.locator('summary').click();menu.get_by_role('button',name='批量分析',exact=True).click()
        expect(p.locator('#batch-scope-project')).to_have_value('p')
        expect(p.locator('#analysis-batch-summary')).to_contain_text('待处理 1')
        p.locator('#batch-text-status').select_option('selected')
        expect(p.locator('#analysis-batch-summary')).to_contain_text('待处理 2')
        p.locator('#text-batch-close').click()
        p.locator('#open-settings').click();p.locator('[data-settings-tab="tasks"]').click()
        panel=p.locator('#settings-tasks-panel')
        expect(panel.locator('#text-batch-card')).to_be_visible()
        expect(panel.locator('#preview-analysis-batch')).to_be_visible()
        expect(panel.locator('[data-batch-kind], #batch-scope-fields, #open-text-batch')).to_have_count(0)
        expect(p.locator('#text-batch-dialog')).to_be_hidden()
        expect(panel.locator('.task-tools')).to_be_hidden()
        for theme,locale in [('dark','zh-CN'),('light','en')]:
            p.evaluate("async v=>(await import('./i18n.js')).initializeUi(v)",{'theme':theme,'locale':locale,'motion':'reduced'})
            for width in [1280,390]:
                p.set_viewport_size({'width':width,'height':900});shot(p,out/f'inline-{theme}-{width}.png')
                assert panel.evaluate('e=>e.scrollWidth<=e.clientWidth')
        p.evaluate("async()=>(await import('./i18n.js')).initializeUi({theme:'dark',locale:'zh-CN',motion:'reduced'})");p.set_viewport_size({'width':1280,'height':900})
        p.locator('#preview-analysis-batch').click()
        expect(p.locator('#analysis-batch-summary')).to_contain_text('待处理 2')
        expect(p.locator('#analysis-batch-summary')).to_have_text('待处理 2')
        expect(p.locator('#start-analysis-batch')).to_have_text('开始补全')
        expect(p.locator('#text-batch-dialog')).to_be_hidden()
        shot(p,out/'preview.png')
        before=p.evaluate("()=>chrome.runtime.sendMessage({type:'GET_STATE'})")
        p.locator('#start-analysis-batch').click()
        expect(p.locator('#promptdirector-app-dialog')).to_contain_text('2 个案例')
        expect(p.locator('#promptdirector-app-dialog')).to_contain_text('API 费用')
        assert worker.evaluate('inlineCalls')==0
        p.locator('#promptdirector-app-dialog').get_by_role('button',name='确认付费',exact=True).click()
        wait_for_async_condition(p,"async()=>{const s=await chrome.runtime.sendMessage({type:'GET_STATE'});return s.analysisBatchJob?.status==='running'?s:null}")
        expect(p.locator('#pause-analysis-batch')).to_be_visible();shot(p,out/'running.png')
        p.locator('#settings-close').click()
        worker.evaluate('()=>finishInline()')
        result=wait_for_async_condition(p,"async()=>{const s=await chrome.runtime.sendMessage({type:'GET_STATE'});return s.analysisBatchJob?.status==='completed'?s:null}")
        assert worker.evaluate('inlineCalls')==2
        assert {i['entryId'] for i in result['analysisBatchJob']['items']}=={'one','two'}
        for old in before['entries']:
            saved=next(e for e in result['entries'] if e['id']==old['id'])
            assert saved['text']==old['text'] and saved['customLabels']==old['customLabels']
            if old['id']=='done':assert saved==old
        assert result['organizerState']==before['organizerState']
        p.locator('#open-settings').click();p.locator('[data-settings-tab="tasks"]').click()
        expect(p.locator('#analysis-batch-summary')).to_contain_text('完成 2/2');shot(p,out/'completed.png')
        p.locator('#preview-analysis-batch').click()
        expect(p.locator('#analysis-batch-summary')).to_contain_text('待处理 0')
        expect(p.locator('#start-analysis-batch')).to_be_disabled();shot(p,out/'empty.png')
        # An actual failed preview keeps the error inside the settings row.
        p.evaluate('''()=>{const send=chrome.runtime.sendMessage.bind(chrome.runtime);chrome.runtime.sendMessage=m=>m.type==='PREVIEW_ANALYSIS_BATCH'?new Promise(resolve=>{window.endInlinePreview=()=>resolve({ok:false,message:'检查失败测试，资料未改动'})}):send(m);}''')
        p.locator('#preview-analysis-batch').click()
        expect(p.locator('#analysis-batch-summary')).to_have_attribute('aria-busy','true');shot(p,out/'checking.png')
        p.evaluate('()=>endInlinePreview()')
        expect(p.locator('#analysis-settings-feedback')).to_contain_text('检查失败测试')
        expect(p.locator('#analysis-settings-feedback')).to_be_visible();shot(p,out/'failure.png')
        assert not run.page_errors,run.page_errors
        print('PASS: inline settings, no scope/media dialog, project independence, correct missing-only queue, fee confirmation, close/continue/readback, empty/wait/failure and preserved originals/tags/projects; paid requests 0')


if __name__=='__main__':main()
