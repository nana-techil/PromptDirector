"""Real sidebar component: rapid submits, original disclosures and visible save controls.
Model/task replies are fixtures; shared chat persistence uses the actual background.
"""
import os
from pathlib import Path
from playwright.sync_api import expect
from e2e_support import extension_session, ai_configuration_fixture

def main():
    out = Path(os.environ.get('PD_E2E_ARTIFACT_DIR', '/tmp/pd-assistant-feedback'))
    out.mkdir(parents=True, exist_ok=True)
    with extension_session('pd-assistant-feedback-', viewport={'width': 390, 'height': 844}) as run:
        page = run.open_page('collector.html')
        run.seed_storage(page, ai_configuration_fixture(providers={'deepseek': {'apiKey': 'fixture', 'consent': True, 'models': {'creativePlanning': 'deepseek-flash'}}}, assignments={'creativePlanning': {'providerId': 'deepseek', 'model': 'deepseek-flash'}}))
        page.reload()
        page.evaluate('''async () => {
          const old = document.querySelector('#open-capture-assistant');
          const toggle = old.cloneNode(true); old.replaceWith(toggle);
          document.querySelector('#capture-assistant-panel').remove();
          document.querySelector('#capture-assistant-new').remove();
          const send = chrome.runtime.sendMessage.bind(chrome.runtime);
          window.fixture = { starts: 0, saves: 0, draft: {}, batch: null, original: send };
          chrome.runtime.sendMessage = async message => {
            if(message.type === 'START_CAPTURE_ASSIST') {
              fixture.starts++; await new Promise(resolve => setTimeout(resolve, 100));
              fixture.started = true;
              if(fixture.scenario) {
                fixture.source = {tabId:message.input.tabId,sourceUrl:message.input.sourceUrl};
                fixture.batch={...fixture.template,...fixture.source,id:'automatic-base'};
                if(fixture.scenario==='human')fixture.editVersion++;
                fixture.view.refresh();
              }
              return {ok:true, task:{state:'running'}};
            }
            if(message.type === 'GET_CAPTURE_ASSIST_TASK') {
              if(!fixture.started) {fixture.earlyReads=(fixture.earlyReads||0)+1;return {ok:false,code:'task_not_found',message:'Task has not started'};}
              await new Promise(resolve => setTimeout(resolve, 300));
              return {ok:true, task:{state:'completed',result:{ok:true,text:'A long response. '.repeat(100),
                ...(fixture.scenario?{captureId:'assistant-preview',revision:2}:{})}}};
            }
            if(message.type==='GET_CAPTURE_ASSIST_PREVIEW' && fixture.scenario) return {ok:true,state:'preview',batch:{...fixture.template,...fixture.source,id:'assistant-result'}};
            return send(message);
          };
          const { installCaptureAssistant } = await import('./collector-capture-assistant.js');
          fixture.view = installCaptureAssistant({getBatch:()=>fixture.batch, applyBatch:batch=>fixture.batch=batch,
            isBusy:()=>false,isAutomaticCapturing:()=>Boolean(fixture.scenario),getBatchEditVersion:()=>fixture.editVersion||0,
            getCollections:()=>[], getDraft:()=>fixture.draft, getMetadata:()=>fixture.draft,
            changeProject:async patch=>{fixture.draft={...fixture.draft,...patch};return true;},
            getContentTypes:()=>[{id:'video-prompt',label:'视频提示词'},{id:'code',label:'代码案例'}],getSuggestedType:()=> 'video-prompt',
            save:async()=>{fixture.saves++;fixture.saved={batch:structuredClone(fixture.batch),draft:structuredClone(fixture.draft)};
              fixture.batch=null;return {ok:true,results:[{entryId:'saved',status:'saved',title:'Saved fixture'}]};},cancelSave:async()=>{}});
          await fixture.view.restore();
        }''')
        page.locator('#open-capture-assistant').click()
        expect(page.locator('.capture-assistant-welcome')).to_be_visible()
        page.locator('#capture-assistant-input').fill('保存这个案例')
        page.evaluate('''() => {
          const form=document.querySelector('.capture-assistant-composer');
          for(let n=0;n<12;n++)form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
          setTimeout(()=>window.dispatchEvent(new Event('focus')),25);
          fixture.disabledImmediately=document.querySelector('#capture-assistant-send').disabled;
        }''')
        expect(page.locator('#capture-assistant-send')).to_be_enabled(timeout=20000)
        assert page.evaluate('fixture.disabledImmediately'), 'Send must disable in the same click, before any asynchronous page/storage reads'
        assert page.evaluate('fixture.starts') == 1, 'Rapid clicks must start only one task'
        assert page.evaluate('fixture.earlyReads || 0') == 0, 'Focus events must not inspect a task before START has acknowledged it'
        expect(page.locator('.capture-assistant-user')).to_have_count(1)
        expect(page.locator('.capture-assistant-assistant')).to_have_count(1)
        summary = page.locator('.capture-assistant-assistant summary')
        box = summary.bounding_box()
        page.mouse.click(box['x'] + 3, box['y'] + box['height']/2, delay=140)
        expect(summary.locator('..')).to_have_attribute('open', '')
        page.keyboard.press('Escape')
        # The ordinary tools and conversation are reachable via the existing toggle.
        page.locator('#open-capture-assistant').click()
        expect(page.locator('#capture-assistant-panel')).to_be_hidden()
        page.locator('#open-capture-assistant').click()
        expect(page.locator('.capture-assistant-user')).to_have_count(1)
        page.evaluate('''async()=>{
          fixture.batch={id:'manual',sourceUrl:location.href,tabId:1,status:'preview',captureMode:'list',saveMode:'single',
            candidates:['post','comment'].map(id=>({id,title:id,canonicalUrl:location.href,contentText:'Exact original '+id,media:[]})),
            selections:['post','comment'].map(candidateId=>({candidateId,includeText:true,selectedMediaIds:[]}))};
          fixture.view.refresh();
        }''')
        expect(page.locator('#capture-assistant-content-type')).to_be_visible()
        page.locator('#capture-assistant-content-type').select_option('code')
        expect(page.locator('#capture-assistant-save-mode')).to_be_visible()
        page.locator('#capture-assistant-save-mode').select_option('combined')
        summary.click()
        for width in [390, 900]:
            page.set_viewport_size({'width':width,'height':844})
            page.locator('.capture-assistant-preview').scroll_into_view_if_needed()
            page.screenshot(path=str(out/f'preview-{width}.png'))
        page.locator('#capture-assistant-save').click()
        expect(page.locator('.capture-assistant-result')).to_contain_text('已保存')
        assert page.evaluate('fixture.saved.draft.contentTypeId') == 'code'
        assert page.evaluate('fixture.saved.batch.saveMode') == 'combined'
        assert page.evaluate('fixture.saves') == 1
        page.evaluate('''()=>{
          chrome.tabs.query=async()=>[{id:42,url:'https://example.test/current',title:'Current target'}];
          chrome.tabs.get=async()=>({id:42,url:'https://example.test/current',title:'Current target'});
        }''')
        for scenario in ['automatic','human']:
            page.evaluate('''scenario=>{
              fixture.scenario=scenario;fixture.batch=null;fixture.editVersion=0;
              fixture.template={status:'preview',captureMode:'single',saveMode:'single',candidates:[{id:'post',title:'Original',canonicalUrl:location.href,contentText:'Full original',media:[]}],selections:[{candidateId:'post',includeText:true,selectedMediaIds:[]}]};
              fixture.view.refresh();
            }''',scenario)
            page.locator('#capture-assistant-input').fill('采集这个页面')
            page.locator('#capture-assistant-send').click()
            expect(page.locator('#capture-assistant-send')).to_be_enabled(timeout=20000)
            assert page.evaluate('fixture.batch.id') == ('assistant-result' if scenario=='automatic' else 'automatic-base'), f'{scenario}: only a completed automatic scan may be adopted; newer human edits must remain intact'
        for locale,theme in [('en','dark'),('en','light'),('zh-CN','dark')]:
            page.evaluate("async prefs=>chrome.storage.local.set({uiPreferences:prefs})",{'locale':locale,'theme':theme,'motion':'reduced'})
            page.reload()
            for width in [320,390,900]:
                page.set_viewport_size({'width':width,'height':844})
                for opened in [False,True]:
                    if opened:page.locator('#open-capture-assistant').click()
                    button=page.locator('#open-capture-assistant')
                    expect(button).to_be_visible()
                    geometry=button.evaluate("""node=>{const box=node.getBoundingClientRect(),header=node.closest('header').getBoundingClientRect();const text=node.lastChild;const range=document.createRange();range.selectNodeContents(text);const label=range.getBoundingClientRect();return {label:[label.left,label.right],box:[box.left,box.right],header:[header.left,header.right],brand:node.closest('header').querySelector('.brand').getBoundingClientRect().right}}""")
                    assert geometry['label'][0]>=geometry['box'][0] and geometry['label'][1]<=geometry['box'][1], geometry
                    assert geometry['box'][1]<=geometry['header'][1] and geometry['brand']<=geometry['box'][0],geometry
                    expect(page.locator('#open-library')).to_be_in_viewport()
                    page.screenshot(path=str(out/f'header-{locale}-{theme}-{width}-{opened}.png'))
                page.locator('#open-capture-assistant').click()
        print('PASS: immediate send gate, one task/message, marker click, mode continuity, visible type and save mode')

if __name__ == '__main__':
    main()
