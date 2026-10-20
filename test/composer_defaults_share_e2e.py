"""Localized defaults and share save/cancel against disposable extension storage."""
import base64
import io
import json
import os
import re
import zipfile
from pathlib import Path

from playwright.sync_api import expect
from e2e_support import extension_session, base_entry


def main():
    with extension_session('pd-defaults-share-') as session:
        setup = session.open_page('collector.html')
        entry = base_entry('share-case', 'Original case', '完整原文与提示词', 'content:prompt:image')
        entry['customLabels'] = ['人工标签']
        session.seed_storage(setup, {
            'entries': [entry], 'dataSafetyOnboardingSeen': True,
            'organizerState': {'collections': [{'id': 'share-project', 'name': 'Test project', 'entryIds': [entry['id']]}]},
            'uiPreferences': {'locale': 'en', 'theme': 'dark', 'motion': 'reduced'}
        })
        page = session.open_page('library.html', wait_until='networkidle')
        page.locator('#open-settings').click()
        page.locator('[data-settings-tab="rules"]').click()
        page.locator('[data-analysis-kind="composer"]').click()
        agent = page.locator('#composer-agent-instruction')
        method = page.locator('#composer-task-method')
        expect(agent).to_have_value(re.compile(r'^You are the PromptDirector plugin assistant'))
        for task in ['compose.image', 'compose.video', 'analyze_materials', 'chat']:
            page.locator('#composer-task-key').select_option(task)
            assert not re.search(r'[\u3400-\u9fff]', method.input_value())
            page.locator('.composer-method-default > summary').click()
            assert not re.search(r'[\u3400-\u9fff]', page.locator('#composer-method-default-text').inner_text())
            page.locator('.composer-method-default > summary').click()
        page.locator('#composer-task-key').select_option('compose.video')
        page.locator('#save-composer-agent').click()
        page.locator('#composer-settings-form button[type=submit]').click()
        state = page.evaluate("async()=> (await chrome.runtime.sendMessage({type:'GET_STATE'})).composerSettings")
        assert not state['agentInstruction']['customized'] and not state['taskMethods']['compose.video']['customized']
        snapshot = page.evaluate("""async settings => {
          const {createInstructionSnapshot}=await import('./composer.js');
          return createInstructionSnapshot(settings,'compose','video','en');
        }""", state)
        assert snapshot['agentInstruction'].startswith('You are the PromptDirector plugin assistant')
        assert 'video prompt ready for generation' in snapshot['taskMethod']
        artifact_dir = os.environ.get('PROMPTDIRECTOR_E2E_ARTIFACT_DIR')
        for width, height, theme in [(1440, 960, 'dark'), (390, 844, 'light')]:
            page.set_viewport_size({'width': width, 'height': height})
            if theme == 'light':
                page.locator('[data-settings-tab="general"]').click()
                with page.expect_navigation(wait_until='networkidle'):
                    page.locator('#ui-theme').select_option('light')
                page.locator('#open-settings').click()
                page.locator('[data-settings-tab="rules"]').click()
                page.locator('[data-analysis-kind="composer"]').click()
            agent.scroll_into_view_if_needed()
            assert page.locator('#settings-rules-panel').evaluate('(e)=>e.scrollWidth<=e.clientWidth+1')
            if artifact_dir:
                Path(artifact_dir).mkdir(parents=True, exist_ok=True)
                page.screenshot(path=str(Path(artifact_dir) / f'english-rules-{width}.png'))
                method.scroll_into_view_if_needed()
                page.screenshot(path=str(Path(artifact_dir) / f'english-method-{width}.png'))
        agent.fill('用户自定义系统指令，不得翻译覆盖')
        page.locator('#save-composer-agent').click()
        expect(page.locator('#composer-agent-save-state')).to_have_text('Saved')
        page.locator('#composer-task-key').select_option('compose.video')
        method.fill('用户自定义视频方法，不得翻译覆盖')
        page.locator('#composer-settings-form button[type=submit]').click()
        expect(page.locator('#composer-task-save-state')).to_have_text('Saved')
        page.reload(wait_until='networkidle')
        page.locator('#open-settings').click()
        page.locator('[data-settings-tab="rules"]').click()
        page.locator('[data-analysis-kind="composer"]').click()
        page.locator('#composer-task-key').select_option('compose.video')
        expect(agent).to_have_value('用户自定义系统指令，不得翻译覆盖')
        expect(method).to_have_value('用户自定义视频方法，不得翻译覆盖')
        page.locator('#settings-close').click()
        page.set_viewport_size({'width': 1440, 'height': 960})
        worker = session.context.service_workers[0]
        worker.evaluate("""() => {
          globalThis.shareDownloads=[];
          globalThis.cancelShareDownload=true;
          chrome.downloads.download=async options=>{
            const record={saveAs:options.saveAs,filename:options.filename};
            shareDownloads.push(record);
            if(cancelShareDownload){cancelShareDownload=false;throw Error('User canceled');}
            const bytes=new Uint8Array(await (await fetch(options.url)).arrayBuffer());
            let binary='';for(const byte of bytes)binary+=String.fromCharCode(byte);
            record.archive=btoa(binary);
            return shareDownloads.length;
          };
          chrome.downloads.search=async()=>[{state:'complete',bytesReceived:1}];
        }""")
        # Enter through the same visible share actions users take.
        page.locator('#select-cases').click()
        page.locator('#selection-select-filtered').click()
        page.locator('#selection-more-menu > summary').click()
        page.locator('#share-export').click()
        page.locator('#share-dialog-export').click()
        expect(page.locator('#share-dialog-export')).to_be_enabled()
        expect(page.locator('#share-dialog')).to_be_visible()
        assert len(worker.evaluate('shareDownloads')) == 1
        page.locator('#share-dialog-export').click()
        expect(page.locator('#share-dialog')).not_to_be_visible()
        project = page.evaluate("async()=>chrome.runtime.sendMessage({type:'EXPORT_PROJECT',collectionId:'share-project'})")
        assert project['ok'], project
        downloads = worker.evaluate('shareDownloads')
        assert len(downloads) == 3 and all(item['saveAs'] for item in downloads), downloads
        for item in downloads[1:]:
            assert item['filename'].endswith('.zip') and 'Share' in item['filename'], item['filename']
            with zipfile.ZipFile(io.BytesIO(base64.b64decode(item['archive']))) as archive:
                library = json.loads(archive.read('library.json'))
                exported = library['entries'][0]
                assert exported['id'] == entry['id'] and exported['text'] == entry['text']
                assert exported['customLabels'] == ['人工标签']
        stored = page.evaluate("async()=> (await chrome.runtime.sendMessage({type:'GET_STATE'})).entries")
        assert len(stored) == 1 and stored[0]['text'] == entry['text']
        print('English defaults, custom edit readback, share cancel/retry, both ZIP paths and original data passed.')


if __name__ == '__main__':
    main()
