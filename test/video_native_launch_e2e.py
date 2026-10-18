"""Chrome must launch the actually installed video host, without a shell wrapper in the test.

The installer must run first. This offline test uses a disposable profile and
only requests component readiness; it never downloads media or writes a real library.
"""
import json
import shutil
import sys
import tempfile
from pathlib import Path
from e2e_support import EXTENSION_DIR, extension_session


def main():
    with tempfile.TemporaryDirectory(prefix='pd-video-native-launch-') as temporary:
        extension = Path(temporary) / 'extension'
        shutil.copytree(EXTENSION_DIR, extension)
        manifest = json.loads((extension / 'manifest.json').read_text())
        manifest['optional_permissions'].remove('nativeMessaging')
        manifest['permissions'].append('nativeMessaging')
        (extension / 'manifest.json').write_text(json.dumps(manifest))
        with extension_session('pd-installed-native-', extension_dir=extension) as run:
            if sys.platform == 'darwin':
                # Chromium resolves user native hosts relative to user-data-dir.
                # Expose the installed registration to this disposable profile;
                # retain its exact launcher path so Chrome starts the real host.
                installed = Path.home() / 'Library/Application Support/Google/Chrome/NativeMessagingHosts/com.promptdirector.video.json'
                registration = json.loads(installed.read_text())
                assert Path(registration['path']).is_file(), registration
                assert f'chrome-extension://{run.extension_id}/' in registration['allowed_origins'], registration
                native_directory = run.profile_dir / 'NativeMessagingHosts'
                native_directory.mkdir(exist_ok=True)
                shutil.copyfile(installed, native_directory / installed.name)
            page = run.open_page('collector.html')
            assert page.evaluate("() => chrome.permissions.contains({permissions:['nativeMessaging']})")
            result = page.evaluate("async()=>{const {nativeVideoStatus}=await import('./native-video.js');return nativeVideoStatus(chrome);}")
            assert result['available'] and not result.get('updateRequired'), result
            assert result.get('versions'), result
            assert not run.page_errors, run.page_errors
            print(json.dumps({'chromeStartedInstalledHost': True, 'nativeVideoStatus': result}))


if __name__ == '__main__':
    main()
