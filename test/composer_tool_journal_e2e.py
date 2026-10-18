"""Durable tool facts are incremental while normal session/backup reads remain complete."""
import json
from e2e_support import extension_session


def main():
    with extension_session('pd-tool-journal-') as run:
        page = run.open_page('collector.html')
        run.seed_storage(page, {'entries': []})
        result = page.evaluate('''async()=>{
          const storage=(await import('./library-storage.js')).getLibraryStorage();
          const {createComposerSession}=await import('./composer.js');
          const {createComposerToolProgress}=await import('./composer-tool-progress.js');
          const source='Frozen exact original\\n'.repeat(10000);
          await storage.set({composerSessions:[createComposerSession({id:'journal',title:'Journal',currentInstruction:'Unsent original',
            messages:[{id:'human',role:'user',content:'Save the chosen original'}]})]});
          let fullHistoryWrites=0;
          chrome.storage.onChanged.addListener(changes=>{if(changes.composerSessions?.newValue.some(session=>session.toolContext?.length)) fullHistoryWrites++;});
          const runtime=createComposerToolProgress({storage,sessionId:'journal',userMessageId:'human'});
          for(let n=0;n<50;n++) await runtime.recordToolResult({callId:'read-'+n,name:'read_capture',args:{part:'source'},data:{content:source+n}});
          await runtime.saveContinuation({protocol:'chat_completions',body:{model:'fixture',messages:[{role:'user',content:source}]}});
          const backup=await chrome.runtime.sendMessage({type:'GET_FOLDER_BACKUP_STATE'});
          return {count:backup.composerSessions[0].toolContext.length,
            exact:backup.composerSessions[0].toolContext.every((record,n)=>record.data.content===source+n),
            draft:backup.composerSessions[0].currentInstruction,fullHistoryWrites};
        }''')
        assert result == {'count': 50, 'exact': True, 'draft': 'Unsent original', 'fullHistoryWrites': 0}, result
        run.restart_browser()
        page = run.open_page('collector.html')
        recovered = page.evaluate('''async()=>{
          const storage=(await import('./library-storage.js')).getLibraryStorage();
          const {createComposerToolProgress}=await import('./composer-tool-progress.js');
          const runtime=createComposerToolProgress({storage,sessionId:'journal',userMessageId:'human'});
          const records=await runtime.loadContext();
          const continuation=await runtime.loadContinuation({protocol:'chat_completions',model:'fixture'});
          return {count:records.length,exact:records.at(-1).data.content==='Frozen exact original\\n'.repeat(10000)+'49',
            continuation:continuation.body.messages[0].content==='Frozen exact original\\n'.repeat(10000)};
        }''')
        assert recovered == {'count': 50, 'exact': True, 'continuation': True}, recovered
        print(json.dumps({'incrementalToolWrites': result, 'browserRestart': recovered, 'paidApiCalls': 0}))


if __name__ == '__main__':
    main()
