"""Chrome must launch the actually installed video host, without a shell wrapper in the test.

The installer must run first. This offline test uses a disposable profile and
only requests component readiness; it never downloads media or writes a real library.
"""
import json
import shutil
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
            page = run.open_page('collector.html')
            result = page.evaluate("async()=>{const {nativeVideoStatus}=await import('./native-video.js');return nativeVideoStatus(chrome);}")
            assert result['available'] and not result.get('updateRequired'), result
            assert result.get('versions'), result
            assert not run.page_errors, run.page_errors
            print(json.dumps({'chromeStartedInstalledHost': True, 'nativeVideoStatus': result}))


if __name__ == '__main__':
    main()
