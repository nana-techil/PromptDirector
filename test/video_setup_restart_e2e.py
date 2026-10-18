"""Explicit installation survives an actual worker stop and its one-shot alarm.

Native inspection is a local fixture; Chrome storage, alarms, worker termination,
background restoration and terminal cleanup use the extension's real wiring.
"""
import json
import tempfile
from pathlib import Path
from e2e_support import EXTENSION_DIR, extension_session, wait_for_async_condition


def main():
    with tempfile.TemporaryDirectory(prefix='pd-video-wakeup-extension-') as temp:
        extension = Path(temp)
        for file in EXTENSION_DIR.iterdir():
            if file.name != 'background.js':
                (extension / file.name).symlink_to(file, target_is_directory=file.is_dir())
        source = (EXTENSION_DIR / 'background.js').read_text()
        source = source.replace('inspect: nativeVideoStatus, platform:', """inspect: async () => {
          const state=await chrome.storage.local.get(['fixtureNativeReady','fixtureInspections']);
          await chrome.storage.local.set({fixtureInspections:(state.fixtureInspections||0)+1});
          return {available:state.fixtureNativeReady===true};
        }, platform:""")
        source = source.replace('resume: () => captureSaveTasks.resumeVideo(),', """resume: async () => {
          const state=await chrome.storage.local.get('fixtureResumes');
          await chrome.storage.local.set({fixtureResumes:(state.fixtureResumes||0)+1});
          return captureSaveTasks.resumeVideo();
        },""")
        (extension / 'background.js').write_text(source + '\nglobalThis.setupFixtureCheck=()=>videoComponentSetup.check();\n')
        with extension_session('pd-video-wakeup-', extension_dir=extension) as run:
            page = run.open_page('collector.html')
            worker = run.context.service_workers[0]
            page.evaluate("""async () => {
              const {getLibraryStorage}=await import('./library-storage.js');
              await getLibraryStorage().set({videoComponentSetup:{phase:'installing',downloadId:7,startedAt:Date.now(),checkAttempts:5}});
            }""")
            assert worker.evaluate('()=>setupFixtureCheck()')['phase'] == 'installing'
            alarm = page.evaluate("() => chrome.alarms.get('video-component-setup')")
            assert alarm and not alarm.get('periodInMinutes'), alarm
            session = run.context.new_cdp_session(page)
            versions = []
            session.on('ServiceWorker.workerVersionUpdated', lambda event: versions.extend(event['versions']))
            session.send('ServiceWorker.enable')
            page.wait_for_timeout(100)
            active = next(item for item in reversed(versions) if item.get('scriptURL') == worker.url and item['runningStatus'] == 'running')
            page.evaluate("() => chrome.storage.local.set({fixtureNativeReady:true,fixtureInspections:0})")
            session.send('ServiceWorker.stopWorker', {'versionId':active['versionId']})
            # Bring forward this unpacked extension's existing one-shot alarm;
            # no setup GET or direct check is issued after the memory loss.
            page.evaluate("() => chrome.alarms.create('video-component-setup',{when:Date.now()+1000})")
            wait_for_async_condition(page, "async()=>{const s=await chrome.storage.local.get(['videoComponentSetup','fixtureResumes','fixtureInspections']);return s.videoComponentSetup?.phase==='ready'&&s.fixtureResumes===1&&s.fixtureInspections===1}", timeout=20000)
            result = page.evaluate("async()=>({...(await chrome.storage.local.get(['fixtureResumes','fixtureInspections','videoComponentSetup'])),alarm:await chrome.alarms.get('video-component-setup')})")
            assert result['fixtureResumes'] == 1 and result['fixtureInspections'] == 1, result
            assert not result.get('alarm'), result
            session.detach()
            print(json.dumps({'actualWorkerStopped':True,'alarmWokeInstallation':True,'resumedOnce':True,'terminalAlarmCleared':True,'realInstallations':0,'paidApiCalls':0}))


if __name__ == '__main__':
    main()
