"""Reload settings after a manual installation; native availability and macOS are fixtures.

The settings UI, background message route and durable setup state are real.
No system install, real-library write or media download is performed.
"""
import json
import os
import shutil
import tempfile
from pathlib import Path
from playwright.sync_api import expect
from e2e_support import EXTENSION_DIR, extension_session, wait_for_async_condition


def main():
    evidence = Path(os.environ.get('VIDEO_REFRESH_EVIDENCE', tempfile.mkdtemp(prefix='video-refresh-')))
    evidence.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='pd-video-refresh-extension-') as temporary:
        extension = Path(temporary) / 'extension'
        shutil.copytree(EXTENSION_DIR, extension)
        manifest = json.loads((extension / 'manifest.json').read_text())
        manifest['optional_permissions'].remove('nativeMessaging')
        manifest['permissions'].append('nativeMessaging')
        (extension / 'manifest.json').write_text(json.dumps(manifest))
        background = extension / 'background.js'
        source = background.read_text()
        needle = 'inspect: nativeVideoStatus, platform:'
        assert source.count(needle) == 1
        source = source.replace(needle, """inspect: async () => {
          const state=await chrome.storage.local.get(['fixtureNativeStatus','fixtureInspections']);
          await chrome.storage.local.set({fixtureInspections:(state.fixtureInspections||0)+1});
          if (!state.fixtureNativeStatus) throw Error('Host unavailable');
          return state.fixtureNativeStatus;
        }, platform:""")
        source = source.replace('platform: () => chrome.runtime.getPlatformInfo(),', "platform: async () => ({os:'mac'}),")
        source = source.replace('resume: () => captureSaveTasks.resumeVideo(),', """resume: async () => {
          const s=await chrome.storage.local.get('fixtureResumes');
          await chrome.storage.local.set({fixtureResumes:(s.fixtureResumes||0)+1});
          return captureSaveTasks.resumeVideo();
        },""")
        background.write_text(source)
        with extension_session('pd-video-refresh-', extension_dir=extension) as run:
            page = run.open_page('collector.html')
            run.seed_storage(page, {'entries': [], 'dataSafetyOnboardingSeen': True,
                'uiPreferences': {'theme': 'dark', 'locale': 'zh-CN'},
                'videoComponentSetup': {'phase': 'failed', 'message': '暂时无法下载安装包，请稍后重试'}})
            page.goto(f'chrome-extension://{run.extension_id}/library.html')
            page.locator('#open-settings').click()
            expect(page.locator('#settings-dialog')).to_be_visible()
            expect(page.locator('#video-component-status')).to_have_text('暂时无法下载安装包，请稍后重试')
            expect(page.locator('#connect-video-component')).to_have_text('重试')
            for width in [1280, 540]:
                page.set_viewport_size({'width': width, 'height': 900})
                page.locator('#video-component-status').scroll_into_view_if_needed()
                page.screenshot(path=str(evidence / f'failed-{width}.png'), animations='disabled')
            page.evaluate("() => chrome.storage.local.set({fixtureNativeStatus:{available:true,versions:{component:'0.1.0'}},fixtureInspections:0})")
            # No Retry or installer button is used: a normal page reload must
            # replace the stale failure with the newly detected host status.
            page.reload()
            page.locator('#open-settings').click()
            expect(page.locator('#settings-dialog')).to_be_visible()
            expect(page.locator('#video-component-status')).to_have_text('视频组件已就绪')
            expect(page.locator('#connect-video-component')).to_be_hidden()
            result = page.evaluate("() => chrome.storage.local.get(['videoComponentSetup','fixtureInspections'])")
            assert result['videoComponentSetup']['phase'] == 'ready', result
            assert not result['videoComponentSetup'].get('message'), result
            assert result['fixtureInspections'] == 1, result
            assert not page.evaluate("() => chrome.alarms.get('video-component-setup')")
            for width in [1280, 540]:
                page.set_viewport_size({'width': width, 'height': 900})
                page.locator('#video-component-status').scroll_into_view_if_needed()
                page.screenshot(path=str(evidence / f'ready-{width}.png'), animations='disabled')
            page.evaluate("() => chrome.storage.local.remove('fixtureNativeStatus')")
            page.reload()
            page.locator('#open-settings').click()
            expect(page.locator('#connect-video-component')).to_be_visible()
            expect(page.locator('#video-component-status')).not_to_have_text('视频组件已就绪')
            assert page.evaluate("async()=>(await chrome.runtime.sendMessage({type:'GET_STATE'})).entries.length") == 0
            agent = page.locator('#settings-dialog [data-video-component-action=agent]')
            page.bring_to_front()
            page.evaluate("""() => {
              window.restoreCopy=navigator.clipboard.writeText.bind(navigator.clipboard);
              navigator.clipboard.writeText=async()=>{throw Error('Clipboard blocked')};
            }""")
            await_copy_state = page.evaluate("() => chrome.storage.local.get('videoComponentSetup')")
            agent.click()
            expect(page.locator('#video-component-status')).to_have_text('无法复制安装指令，请重试')
            assert page.evaluate("() => chrome.storage.local.get('videoComponentSetup')") == await_copy_state
            assert not page.evaluate("() => chrome.alarms.get('video-component-setup')")
            expect(page.locator('#connect-video-component')).to_be_enabled()
            page.evaluate("() => {navigator.clipboard.writeText=window.restoreCopy}")
            agent.click()
            expect(page.locator('#video-component-status')).to_have_text('已复制，粘贴给本机 Agent，安装后自动继续')
            copied = page.evaluate("() => navigator.clipboard.readText()")
            assert 'INSTALL-AGENT.md' in copied and 'Chrome' in copied and 'Python' in copied, copied
            setup = page.evaluate("async()=>(await chrome.storage.local.get('videoComponentSetup')).videoComponentSetup")
            assert setup['phase'] == 'installing' and not setup.get('downloadId'), setup
            assert page.evaluate("() => chrome.downloads.search({})") == [], 'Agent path downloaded an unnecessary installer'
            for locale, theme in [('zh-CN', 'dark'), ('en', 'light')]:
                if locale == 'en':
                    with page.expect_navigation(wait_until='domcontentloaded'):
                        page.evaluate("preferences=>{void chrome.runtime.sendMessage({type:'UPDATE_UI_PREFERENCES',preferences})}", {'locale':locale,'theme':theme})
                else:
                    page.reload()
                page.locator('#open-settings').click()
                expect(page.locator('#settings-dialog')).to_be_visible()
                expect(agent).to_have_text('Install with Agent' if locale == 'en' else '让 Agent 安装')
                for width in [1280, 390]:
                    page.set_viewport_size({'width':width,'height':900})
                    page.locator('#settings-dialog .video-component-setup').scroll_into_view_if_needed()
                    page.screenshot(path=str(evidence / f'agent-{locale}-{width}.png'), animations='disabled')
            # The same copied request follows the current interface language.
            page.bring_to_front(); agent.click()
            expect(page.locator('#video-component-status')).to_contain_text('Copied.')
            assert page.evaluate("() => navigator.clipboard.readText()").startswith('Install the PromptDirector')
            page.evaluate("() => chrome.storage.local.set({fixtureNativeStatus:{available:true},fixtureResumes:0})")
            wait_for_async_condition(page, "async()=>{const s=await chrome.storage.local.get(['videoComponentSetup','fixtureResumes']);return s.videoComponentSetup?.phase==='ready'&&s.fixtureResumes===1}")
            expect(agent).to_be_hidden(); expect(page.locator('#connect-video-component')).to_be_hidden()
            assert not page.evaluate("() => chrome.alarms.get('video-component-setup')")
            print(json.dumps({'refreshClearsFailedState': True, 'probeCount': result['fixtureInspections'],
                'removedHostDetected': True, 'agentClipboardAndReadiness': True, 'copyFailurePreservesState': True, 'realInstallations': 0, 'evidence': str(evidence)}))


if __name__ == '__main__':
    main()
