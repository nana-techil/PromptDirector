"""Large diagnostic history must not be read/transferred to open a chat.
Uses production background/storage/UI in a disposable profile; no paid model.
"""
import json
import time
from pathlib import Path
from playwright.sync_api import expect
from e2e_support import extension_session


def main():
    with extension_session('pd-chat-loading-', viewport={'width': 390, 'height': 844}) as run:
        page = run.open_page('collector.html')
        run.seed_storage(page, {'entries': []})
        # Existing-install shape: canonical full records, no derived display cache.
        size = page.evaluate('''async()=>{
          const {createComposerSession}=await import('./composer.js');
          const source='original code and complete source\\n'.repeat(60000);
          const sessions=Array.from({length:8},(_,i)=>createComposerSession({id:`history-${i}`,title:`Capture ${i}`,
            messages:[{role:'user',content:`Save effect ${i}`},{role:'assistant',content:'Saved the requested effect.'}],
            assistantState:{userCreated:true,turns:[{requestId:`turn-${i}`,diagnostic:{source}}]},
            toolContext:[{callId:`source-${i}`,name:'read_capture',args:{part:'source'},data:{source}}]}));
          await chrome.storage.local.set({composerSessions:sessions,captureAssistantDialog:{schema:'shared-chat',activeId:'history-0',pages:{}}});
          return JSON.stringify(sessions).length;
        }''')
        baseline = page.evaluate('''async()=>{const start=performance.now();const result=await chrome.runtime.sendMessage({type:'GET_ASSISTANT_CHATS',activeId:'history-0',includeDiagnostics:true});return {ms:performance.now()-start,bytes:JSON.stringify(result).length}}''')
        cold = page.evaluate('''async()=>{const start=performance.now();const result=await chrome.runtime.sendMessage({type:'GET_ASSISTANT_CHATS',activeId:'history-0'});return {ms:performance.now()-start,bytes:JSON.stringify(result).length,turns:result.chats.some(x=>x.turns)}}''')
        assert not cold['turns']
        assert cold['bytes'] < baseline['bytes'] / 100
        worker = run.context.service_workers[0]
        worker.evaluate('''()=>{globalThis.heavyChatReads=0;globalThis.heavyChatStacks=[];const original=chrome.storage.local.get.bind(chrome.storage.local);
          chrome.storage.local.get=(keys,...rest)=>{if(keys===null||keys==='composerSessions'||Array.isArray(keys)&&keys.includes('composerSessions')){heavyChatReads++;heavyChatStacks.push({keys,stack:new Error().stack})}return original(keys,...rest)};
        }''')
        warm = page.evaluate('''async()=>{const start=performance.now();await chrome.runtime.sendMessage({type:'GET_ASSISTANT_CHATS',activeId:'history-0'});return performance.now()-start}''')
        assert worker.evaluate('heavyChatReads') == 0, 'ordinary chat reads must not fetch full history'
        start = time.perf_counter()
        page.reload()
        page.locator('#open-capture-assistant').click()
        expect(page.locator('#capture-assistant-input')).to_be_enabled(timeout=20000)
        expect(page.locator('.capture-assistant-user')).to_have_text('Save effect 0')
        opened_ms = (time.perf_counter() - start) * 1000
        assert worker.evaluate('heavyChatReads') == 0, str(worker.evaluate('heavyChatStacks'))
        # Save/switch/refresh keep old full diagnostics, without shipping them back on each keypress.
        page.locator('#capture-assistant-input').fill('new draft')
        page.wait_for_function('''async()=>{const stored=await chrome.storage.local.get('composerSessions');return stored.composerSessions.find(s=>s.id==='history-0').currentInstruction==='new draft'}''')
        intact = page.evaluate('''async()=>{const r=await chrome.runtime.sendMessage({type:'GET_ASSISTANT_CHATS',activeId:'history-0',includeDiagnostics:true});return r.chats.find(x=>x.id==='history-0').turns[0].diagnostic.source.length}''')
        assert intact == len('original code and complete source\n') * 60000
        out=Path('/tmp/pd-chat-loading');out.mkdir(exist_ok=True)
        page.screenshot(path=str(out/'chat-390.png'))
        page.set_viewport_size({'width':900,'height':844})
        page.screenshot(path=str(out/'chat-900.png'))
        result={'canonicalBytes':size,'fullHistoryRead':baseline,'firstProjectionBuild':cold,'warmReadMs':warm,'openReloadMs':opened_ms,'originalCharactersRetained':intact}
        (out/'measurements.json').write_text(json.dumps(result,indent=2))
        print(json.dumps(result))
        linked = page.evaluate('''async()=>{
          const {getLibraryStorage}=await import('./library-storage.js');const storage=getLibraryStorage();
          await storage.update('composerSessions', stored=>({composerSessions:stored.composerSessions.map(s=>s.id==='history-0'?{...s,promptVersions:[{id:'prompt-one',title:'Saved creative prompt',text:'Full generated prompt'}]}:s),activeCreativeResult:{sessionId:'history-0',promptVersionId:'prompt-one'}}));
          return (await chrome.runtime.sendMessage({type:'GET_CAPTURE_WORKSPACE'})).activeCreativePrompt;
        }''')
        assert linked['sessionId']=='history-0' and linked['promptVersionId']=='prompt-one'
        assert linked['title']=='Saved creative prompt'
        assert not run.page_errors, run.page_errors


if __name__ == '__main__':
    main()
