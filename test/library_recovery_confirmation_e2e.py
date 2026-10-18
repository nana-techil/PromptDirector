"""P0: whole-library recovery must disclose later content and reject stale confirmation."""
import json
import tempfile
from pathlib import Path
from playwright.sync_api import expect
from e2e_support import base_entry, extension_session


def main():
    with extension_session('pd-recovery-confirm-', viewport={'width':1440,'height':1000}) as run:
        setup=run.open_page('collector.html')
        shared=base_entry('shared','原案例','旧原词','content:prompt:image')
        old=base_entry('old','恢复点独有案例','保留旧资料','content:prompt:image')
        later=base_entry('later','后来新增案例','不能静默消失','content:prompt:image')
        run.seed_storage(setup,{'schemaVersion':28,'entries':[shared,old]})
        setup.evaluate('''async later=>{
          const storage=(await import('./library-storage.js')).getLibraryStorage();
          const {createLibraryReplacementRecoveryPoint}=await import('./library-recovery-point.js');
          const {createComposerSession}=await import('./composer.js');
          await storage.set({composerSessions:[createComposerSession({id:'previous-chat',title:'Previous chat',currentInstruction:'Old unsent'})]});
          const saved=await chrome.runtime.sendMessage({type:'GET_FOLDER_BACKUP_STATE'});
          const shared={...saved.entries.find(e=>e.id==='shared'),text:'后续编辑必须说明'};
          await storage.set({composerSessions:[createComposerSession({id:'later-chat',title:'Later chat',currentInstruction:'New unsent'})],entries:[shared,{...later,schemaVersion:28}],libraryReplacementRecoveryPoint:createLibraryReplacementRecoveryPoint(saved)});
        }''',later)
        page=run.open_page('library.html')
        expect(page.locator('body')).to_have_attribute('data-library-state','ready')
        page.locator('#open-settings').click()
        # The duplicate settings ZIP/undo entry was retired; import lives in the unified picker.
        expect(page.locator('#settings-dialog .share-package-import')).to_have_count(0)
        expect(page.locator('#settings-dialog #restore-library-replacement-point')).to_have_count(0)
        expect(page.locator('#media-file')).to_have_count(1)

        def preview():
            page.locator('#restore-folder-backup').click()
            page.locator('#restore-library-replacement-point').click()
            dialog=page.locator('#promptdirector-app-dialog')
            expect(dialog.locator('button[type=submit]')).to_be_enabled()
            return dialog

        # The check is visible immediately and can be closed without applying anything.
        page.evaluate("""()=>{const send=chrome.runtime.sendMessage.bind(chrome.runtime);
          window.__originalSend=send;
          chrome.runtime.sendMessage=message=>message.type==='PREVIEW_LIBRARY_UNDO'
            ? new Promise(resolve=>{window.__releaseUndoPreview=()=>send(message).then(resolve);}) : send(message);
        }""")
        page.locator('#restore-folder-backup').click()
        page.locator('#restore-library-replacement-point').click()
        loading=page.locator('#promptdirector-app-dialog')
        expect(loading.locator('progress')).to_be_visible()
        expect(loading.locator('button[type=submit]')).to_be_disabled()
        loading.screenshot(path=str(Path(tempfile.gettempdir())/'pd-recovery-checking.png'))
        page.keyboard.press('Escape')
        page.evaluate("async()=>{await window.__releaseUndoPreview();chrome.runtime.sendMessage=window.__originalSend;}")
        expect(page.locator('#promptdirector-app-dialog')).to_have_count(0)

        dialog=preview()
        expect(dialog).to_contain_text('将移出 1 个对话')
        expect(dialog).to_contain_text('将恢复 1 个对话')
        expect(dialog).to_contain_text('未发送草稿：1 → 1')
        expect(dialog).to_contain_text('将从当前库移出 1 个案例')
        expect(dialog).to_contain_text('将覆盖 1 个案例')
        expect(dialog).to_contain_text('将恢复 1 个案例')
        expect(dialog).to_contain_text('不会合并后来新增或编辑的内容')
        for width in [1440,390]:
            page.set_viewport_size({'width':width,'height':1000})
            assert dialog.evaluate('(e)=>e.scrollWidth<=e.clientWidth+1')
            dialog.screenshot(path=str(Path(tempfile.gettempdir())/f'pd-recovery-confirm-{width}.png'))
        dialog.locator('summary').first.click()
        expect(dialog).to_contain_text('后来新增案例')
        page.keyboard.press('Escape')
        before=setup.evaluate("()=>chrome.runtime.sendMessage({type:'GET_STATE'})")
        assert {e['id'] for e in before['entries']}=={'shared','later'}
        # Changing the library while the user reads the dialog must invalidate the displayed scope.
        dialog=preview()
        setup.evaluate('''async()=>{
          const storage=(await import('./library-storage.js')).getLibraryStorage();
          const s=await storage.get('entries');
          await storage.set({entries:s.entries.map(e=>e.id==='later'?{...e,text:'确认弹窗打开后的新编辑'}:e)});
        }''')
        dialog.locator('button[type=submit]').click()
        expect(page.locator('#data-safety-feedback')).to_contain_text('确认期间资料已变化')
        page.screenshot(path=str(Path(tempfile.gettempdir())/'pd-recovery-stale.png'))
        after=setup.evaluate("()=>chrome.runtime.sendMessage({type:'GET_STATE'})")
        assert {e['id'] for e in after['entries']}=={'shared','later'}
        assert next(e for e in after['entries'] if e['id']=='later')['text']=='确认弹窗打开后的新编辑'
        # Fresh confirmation applies once. Response replay must not toggle the library back.
        page.evaluate('''()=>{const send=chrome.runtime.sendMessage.bind(chrome.runtime);chrome.runtime.sendMessage=async message=>{
          const response=await send(message);if(message.type==='RESTORE_LIBRARY_REPLACEMENT_POINT')window.__restoreProof={message,response};return response;
        };}''')
        dialog=preview()
        dialog.locator('button[type=submit]').click()
        expect(page.locator('#data-safety-feedback')).to_contain_text('已回退')
        proof=page.evaluate('''async()=>{
          const replay=await chrome.runtime.sendMessage(window.__restoreProof.message);
          const storage=(await import('./library-storage.js')).getLibraryStorage();
          const saved=await storage.get(['entries','libraryReplacementRecoveryPoint']);
          const original=window.__restoreProof.response;
          const noConfirm=await chrome.runtime.sendMessage({type:'RESTORE_LIBRARY_REPLACEMENT_POINT',expectedPointId:saved.libraryReplacementRecoveryPoint.id,operationId:crypto.randomUUID()});
          return {saved,replay,noConfirm,original};
        }''')
        assert proof['original']['ok'] and proof['replay']==proof['original']
        assert {e['id'] for e in proof['saved']['entries']}=={'shared','old'}
        point=proof['saved']['libraryReplacementRecoveryPoint']['state']
        assert next(e for e in point['entries'] if e['id']=='later')['text']=='确认弹窗打开后的新编辑'
        assert not proof['noConfirm']['ok']
        # Light/English proof includes the same impact, without Chinese system copy.
        page.close()
        setup.evaluate("()=>chrome.runtime.sendMessage({type:'UPDATE_UI_PREFERENCES',preferences:{locale:'en',theme:'light'}})")
        page=run.open_page('library.html')
        expect(page.locator('body')).to_have_attribute('data-library-state','ready')
        page.locator('#open-settings').click()
        dialog=preview()
        expect(dialog).to_contain_text('Later additions and edits will not be merged')
        for width in [1440,390]:
            page.set_viewport_size({'width':width,'height':1000})
            assert dialog.evaluate('(e)=>e.scrollWidth<=e.clientWidth+1')
            dialog.screenshot(path=str(Path(tempfile.gettempdir())/f'pd-recovery-confirm-en-{width}.png'))
        page.keyboard.press('Escape')
        # The default restore action still opens the picker from an explicit click.
        page.evaluate("()=>{window.showDirectoryPicker=()=>{window.__pickerOpened=true;return Promise.reject(new DOMException('cancel','AbortError'));};}")
        page.locator('#restore-folder-backup').click()
        page.locator('#promptdirector-app-dialog button[type=submit]').click()
        expect(page.locator('#promptdirector-app-dialog')).to_have_count(0)
        assert page.evaluate('()=>window.__pickerOpened')
        assert not run.page_errors,run.page_errors
        print(json.dumps({'contextualEntry':True,'actualImpact':True,'cancelNoWrite':True,'staleConfirmationBlocked':True,'replayIdempotent':True,'currentStateRecoverable':True,'missingConfirmationBlocked':True,'pickerGesture':True,'wideNarrowEnglishLight':True}))


if __name__=='__main__': main()
