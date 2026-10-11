"""Unified assistant: no webpage, real library tools, shared chat and stale-write protection.
Only the model decisions are fixtures. All user-library writes are isolated.
"""
import json, os, tempfile
from pathlib import Path
from playwright.sync_api import expect
from e2e_support import EXTENSION_DIR, extension_session, ai_configuration_fixture

def main():
    out=Path(os.environ.get('PD_E2E_ARTIFACT_DIR','/tmp/pd-plugin-assistant'));out.mkdir(parents=True,exist_ok=True)
    with extension_session('pd-plugin-assistant-',viewport={'width':390,'height':844}) as run:
        panel=run.open_page('collector.html')
        run.seed_storage(panel,{'entries':[{'id':'gym-case','title':'Gym source','text':'Exact original source','url':'https://example.test/gym','createdAt':'2026-10-11T00:00:00Z','mediaAssets':[]}],
            **ai_configuration_fixture(providers={'deepseek':{'apiKey':'isolated-fixture','consent':True,'models':{'creativePlanning':'deepseek-flash'}}},assignments={'creativePlanning':{'providerId':'deepseek','model':'deepseek-flash'}})})
        worker=run.context.service_workers[0]
        model_fixture = r'''()=>{
          const original=fetch;globalThis.assistantRequests=[];
          globalThis.fetch=async(url,init)=>{
            if(!String(url).includes('api.deepseek.com'))return original(url,init);
            const body=JSON.parse(init.body);assistantRequests.push(body);
            const canOpen=body.tools.some(t=>t.function.name==='open_workspace');
            const results=body.messages.filter(m=>m.role==='tool').map(m=>({name:body.messages.flatMap(m=>m.tool_calls||[]).find(c=>c.id===m.tool_call_id)?.function.name,data:JSON.parse(m.content)}));
            let delta,finish;const tool=(name,args)=>{delta={tool_calls:[{index:0,id:crypto.randomUUID(),type:'function',function:{name,arguments:JSON.stringify(args)}}]};finish='tool_calls';};
            if(!results.some(r=>r.name==='declare_task')) {
              const ctx=body.messages.map(m=>{try{return JSON.parse(m.content).runtimeContext;}catch{return null;}}).find(Boolean);
              tool('declare_task',{mode:'act',goal:'打开库、查找健身并修改指定案例标题',userMessageIds:[ctx.currentUserId],steps:[
                ...(canOpen?[{operation:'open_workspace'}]:[]),{operation:'search_cases'},{operation:'read_case_details',targetId:'gym-case'},{operation:'edit_case',targetId:'gym-case'}]});
            }
            else if(canOpen&&!results.some(r=>r.name==='open_workspace'))tool('open_workspace',{surface:'library'});
            else if(!results.some(r=>r.name==='search_cases'))tool('search_cases',{query:'健身',alternatives:['gym']});
            else if(!results.some(r=>r.name==='read_case_details'))tool('read_case_details',{caseId:'gym-case',parts:['overview','document','organization']});
            else if(!results.some(r=>r.name==='edit_case'))tool('edit_case',{requestId:crypto.randomUUID(),caseId:'gym-case',expectedRevision:results.find(r=>r.name==='read_case_details').data.revision,patch:{title:'Gym renamed'}});
            else {delta={content:'已打开案例库、找到并改好标题。'};finish='stop';}
            return new Response('data: '+JSON.stringify({choices:[{delta,finish_reason:finish}]})+'\n\ndata: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}});
          };
        }'''
        worker.evaluate(model_fixture)
        panel.reload();panel.locator('#open-capture-assistant').click()
        expect(panel.locator('.capture-assistant-welcome')).to_contain_text('想让我帮你做什么')
        panel.screenshot(path=str(out/'assistant-empty-zh-dark-390.png'))
        panel.locator('#capture-assistant-input').fill('打开案例库，查找健身案例并把标题改为 Gym renamed')
        panel.locator('#capture-assistant-send').click()
        try: expect(panel.locator('.capture-assistant-assistant')).to_contain_text('改好标题',timeout=45000)
        except Exception:
            panel.screenshot(path=str(out/'failure.png'))
            (out/'failure.json').write_text(json.dumps({'status':panel.locator('#capture-assistant-status').text_content(),'errors':run.page_errors,'requests':worker.evaluate('assistantRequests.map(r=>({tools:r.tools?.map(t=>t.function.name),messages:r.messages.slice(-3)}))'),'stored':panel.evaluate("async()=>(await (await import('./library-storage.js')).getLibraryStorage().get('captureAssistantDialog'))")},ensure_ascii=False))
            raise
        expect(panel.locator('#capture-assistant-send')).to_be_enabled()
        state=panel.evaluate("async()=>(await chrome.runtime.sendMessage({type:'GET_STATE'}))")
        assert state['entries'][0]['title']=='Gym renamed' and state['entries'][0]['text']=='Exact original source'
        stored=panel.evaluate("async()=>(await (await import('./library-storage.js')).getLibraryStorage().get(['composerSessions','captureAssistantDialog']))")
        chat=stored['composerSessions'][0];chat_id=chat['id'];assert len(chat['toolContext'])>=4,[(s['id'],len(s.get('toolContext',[])),[c.get('name') for c in s.get('toolContext',[])]) for s in stored['composerSessions']]
        assert stored['captureAssistantDialog']['schema']=='shared-chat' and 'conversations' not in stored['captureAssistantDialog']
        studio=run.open_page('composer.html?session='+chat_id)
        expect(studio.locator('#composer-timeline')).to_contain_text('改好标题',timeout=30000)
        # Studio uses the same native decision gate and host dispatcher, not a second task gate.
        studio.evaluate(model_fixture)
        studio.locator('#composer-instruction').fill('在同一对话里查找这个案例并把标题改为 Gym renamed')
        studio.locator('#composer-action').click()
        try: expect(studio.locator('.composer-message.chat')).to_have_count(2,timeout=15000)
        except Exception:
            studio.screenshot(path=str(out/'studio-native-failure.png'))
            (out/'studio-native-failure.json').write_text(json.dumps({'text':studio.locator('body').inner_text(),'requests':studio.evaluate('assistantRequests'),'session':studio.evaluate("async id=>(await chrome.runtime.sendMessage({type:'GET_COMPOSER_SESSION',sessionId:id})).session",chat_id),'errors':run.page_errors},ensure_ascii=False))
            raise
        expect(studio.locator('.composer-message.chat').last).to_contain_text('改好标题',timeout=45000)
        assert studio.evaluate('assistantRequests.length')==5
        # A studio write is the very same conversation, with a guarded revision.
        chat=panel.evaluate("async id=>(await chrome.runtime.sendMessage({type:'GET_COMPOSER_SESSION',sessionId:id})).session",chat_id)
        stale=chat
        changed=panel.evaluate("async session=>chrome.runtime.sendMessage({type:'UPSERT_COMPOSER_SESSION',session:{...session,messages:[...session.messages,{role:'assistant',type:'chat',content:'创作台中的同一段对话'}]}})",chat)
        assert changed['ok'],changed
        rejected=panel.evaluate("async session=>chrome.runtime.sendMessage({type:'UPSERT_COMPOSER_SESSION',session})",stale)
        assert not rejected['ok'] and rejected['code']=='chat_conflict',rejected
        expect(panel.locator('.capture-assistant-assistant').last).to_contain_text('同一段对话',timeout=30000)
        expect(studio.locator('#composer-timeline')).to_contain_text('同一段对话',timeout=30000)
        panel.screenshot(path=str(out/'assistant-shared-zh-dark-390.png'))
        studio.close()
        # Six meaningful chats remain in the studio; sidebar shows only five.
        for index in range(6):
            panel.locator('#capture-assistant-new').click()
            panel.locator('#capture-assistant-input').fill('Draft '+str(index))
            for _ in range(200):
                recent=panel.evaluate("async()=> (await chrome.runtime.sendMessage({type:'GET_ASSISTANT_CHATS'})).chats")
                if any(chat['draft']=='Draft '+str(index) for chat in recent):break
                panel.wait_for_timeout(50)
            assert any(chat['draft']=='Draft '+str(index) for chat in recent),recent
        all_chats=panel.evaluate("async()=>(await (await import('./library-storage.js')).getLibraryStorage().get('composerSessions')).composerSessions")
        assert len(all_chats)==7 and any(chat['id']==chat_id for chat in all_chats),[(s['id'],s['currentInstruction']) for s in all_chats]
        expect(panel.locator('#capture-assistant-chats option')).to_have_count(6)
        count=worker.evaluate('assistantRequests.length')
        panel.reload();panel.locator('#open-capture-assistant').click()
        expect(panel.locator('#capture-assistant-input')).to_have_value('Draft 5')
        assert worker.evaluate('assistantRequests.length')==count
        # Existing studio management deletes only the chosen conversation;
        # a stale sidebar snapshot must not resurrect it or remove saved cases.
        latest=panel.evaluate("async()=> (await chrome.runtime.sendMessage({type:'GET_ASSISTANT_CHATS'})).chats[0]")
        studio=run.open_page('composer.html?session='+latest['id'])
        studio.locator('#composer-nav-open').click()
        row=studio.locator('.composer-session-item[data-session-id="'+latest['id']+'"]')
        studio.locator('#composer-new').hover()
        expect(row.locator('.composer-session-delete')).to_have_css('opacity','0')
        row.hover()
        expect(row.locator('.composer-session-delete')).to_have_css('opacity','1')
        expect(row.locator('.composer-session-delete')).to_have_css('border-top-width','0px')
        row.locator('.ui-content-row').focus();studio.keyboard.press('Tab')
        expect(row.locator('.composer-session-delete')).to_be_focused()
        studio.locator('#composer-new').hover()
        expect(row.locator('.composer-session-delete')).to_have_css('opacity','1')
        row.locator('.composer-session-delete').click()
        studio.locator('dialog[open]').get_by_role('button',name='删除',exact=True).click()
        for _ in range(200):
            remaining=panel.evaluate("async()=> (await (await import('./library-storage.js')).getLibraryStorage().get('composerSessions')).composerSessions")
            if not any(session['id']==latest['id'] for session in remaining):break
            panel.wait_for_timeout(50)
        assert len(remaining)==6 and not any(session['id']==latest['id'] for session in remaining)
        resurrection=panel.evaluate("async chat=>chrome.runtime.sendMessage({type:'UPSERT_ASSISTANT_CHAT',chat})",latest)
        assert not resurrection['ok'] and resurrection['code']=='chat_deleted',resurrection
        assert panel.evaluate("async()=> (await chrome.runtime.sendMessage({type:'GET_STATE'})).entries[0].text")=='Exact original source'
        expect(panel.locator('#capture-assistant-input')).not_to_have_value('Draft 5',timeout=30000)
        studio.close()
        for locale,theme in [('zh-CN','dark'),('en','light')]:
            panel.evaluate("async prefs=>chrome.storage.local.set({uiPreferences:prefs})",{'locale':locale,'theme':theme,'motion':'reduced'})
            panel.reload();panel.locator('#open-capture-assistant').click()
            for width in [390,900]:
                panel.set_viewport_size({'width':width,'height':844})
                expect(panel.locator('#capture-assistant-send')).to_be_in_viewport()
                panel.screenshot(path=str(out/f'assistant-{locale}-{theme}-{width}.png'))
            studio=run.open_page('composer.html?session='+chat_id)
            studio.locator('#composer-nav-open').click()
            expect(studio.locator('.composer-session-delete')).to_have_count(6)
            expect(studio.locator('.composer-session-menu')).to_have_count(0)
            expect(studio.locator('.composer-session-delete').first).to_be_in_viewport()
            studio.locator('#composer-new').hover()
            expect(studio.locator('.composer-session-delete').first).to_have_css('opacity','0')
            studio.screenshot(path=str(out/f'studio-chats-{locale}-{theme}-390.png'))
            studio.locator('.composer-session-item').first.hover()
            studio.screenshot(path=str(out/f'studio-chats-hover-{locale}-{theme}-390.png'))
            studio.set_viewport_size({'width':1280,'height':844})
            studio.locator('#composer-new').hover()
            studio.screenshot(path=str(out/f'studio-chats-{locale}-{theme}-1280.png'))
            studio.locator('.composer-session-item').first.hover()
            studio.screenshot(path=str(out/f'studio-chats-hover-{locale}-{theme}-1280.png'))
            studio.close()
        result={'noWebpageChatAndActualOpenSearchEdit':True,'exactSourcePreserved':True,'sameStudioConversationAndToolContext':True,'studioNativeIntentAndActualHostTools':True,'studioLiveUpdates':True,'staleWriteRejected':True,'allSevenChatsRetained':True,'sidebarFiveRecent':True,'reloadDraftPreservedWithoutModelRequest':True,'studioDeleteDoesNotResurrectOrDeleteCases':True,'deleteHiddenUntilRowHoverOrKeyboardFocus':True,'borderlessDelete':True,'paidRequests':0,'pageErrors':run.page_errors}
        (out/'results.json').write_text(json.dumps(result,ensure_ascii=False,indent=2));print(json.dumps(result))
if __name__=='__main__':main()
